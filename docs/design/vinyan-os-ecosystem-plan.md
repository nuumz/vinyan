---
type: design
status: built-opt-in (Phase A shipped 2026-04-18: O1-O5 ✅ implemented, gated behind `ecosystem.enabled: true` — see §9 activation recipe; cross-instance modes still 📋 Designed)
single-source-of-truth-for: Vinyan OS agent ecosystem (runtime states, org structure, volunteer protocol, full-cycle bidding)
related:
  - ./agent-conversation.md            # Room (R0-R2 shipped)
  - ./phase6-implementation-plan.md    # Agentic Worker Protocol
  - ./implementation-plan.md           # Economy OS (E1-E4)
  - ../../src/orchestrator/fleet/worker-lifecycle.ts
  - ../../src/economy/market/auction-engine.ts
  - ../../src/a2a/
  - ../../src/orchestrator/room/
---

# Vinyan OS — Agent Ecosystem Plan

> **Framing.** Vinyan is an orchestrator, not a chat bot. This plan does NOT turn agents into personalities. It adds the *mechanical substrate* that lets agents **sign up for work, own it, collaborate, and stand down** — behaviors we describe using human-org vocabulary because the FSMs mirror those patterns, not because agents have feelings.
>
> "จิตสำนึก" in this doc = **verifiable accountability state** (committed to a task, owe a deliverable, track record attached). A3 stays intact: every governance decision is rule-based.

---

## 1. Foundation & Gap

What already ships, what's missing, and where the new modules go. The pieces
are mostly there — what's missing is a coherent FSM tying them together so the
system can say "this agent is currently working on task X and cannot take
another." Three orthogonal axes are added: runtime activity state (sec/min
FSM), organizational locality (departments, teams), and explicit accountability
(commitments + fallback selector).

| Capability | Current state | Gap | Proposed module |
|---|---|---|---|
| Role-based collab (drafter / critic / integrator) | ✅ shipped (`src/orchestrator/room/`) | — | — |
| Career FSM (probation / active / demoted / retired) | ✅ shipped (`src/orchestrator/fleet/worker-lifecycle.ts`) | — | — |
| Sealed-bid Vickrey auction + trust weighting | 🔧 built, needs `economy.enabled` (`src/economy/market/auction-engine.ts`) | — | — |
| Bid accuracy / anti-gaming / settlement | 🔧 built (`src/economy/market/`) | — | — |
| Peer discovery / gossip / negotiation / commitment | 🔧 built (`src/a2a/`) | — | — |
| Cross-instance room | 📋 designed (`src/a2a/room.ts`) | depends on A2A R3 | — |
| Engine registry + trust-weighted selector | ✅ shipped (`src/orchestrator/engine-selector.ts`) | — | — |
| **Runtime activity state** (sec/min FSM) | missing | orthogonal to career FSM; no notion of "currently working" | `runtime-state.ts` |
| **Org structure (Department / Team / Squad)** | missing | fleet is flat, no routing locality | `department.ts` / `team.ts` |
| **Commitment / accountability** | missing | no commit object, no deliverable contract, no volunteer fallback | `commitment-ledger.ts` + `volunteer-protocol.ts` |

> **Squad note.** Squads are ad-hoc, task-scoped teams dissolved on completion
> — this is what `Room` already is. No new module needed.

---

## 2. Proposed Additions

### 2.1 New Module: `src/orchestrator/ecosystem/`

```
src/orchestrator/ecosystem/
  runtime-state.ts        # Awaken/Standby/Sleep/Working FSM (orthogonal to career state)
  commitment-ledger.ts    # Durable record of "agent X owes deliverable Y by deadline Z"
  department.ts           # Capability cluster + routing
  team.ts                 # Durable roster with shared blackboard
  volunteer-protocol.ts   # "I can help with this" offers; deterministic acceptance rules
  ecosystem-coordinator.ts # Wires all the above into core-loop + market + room
```

Rationale for a new folder (vs. extending `fleet/`): career FSM and runtime FSM have different transition velocities, different persistence needs, and different authorities. Keeping them separate avoids the classic "one god-state-machine" smell.

### 2.2 Data Model Sketch

```ts
// runtime-state.ts
export type RuntimeState = 'dormant' | 'awakening' | 'standby' | 'working';

export interface AgentRuntimeSnapshot {
  engineId: string;
  runtime: RuntimeState;
  careerState: EngineProfileStatus;   // orthogonal, from worker-lifecycle
  committedTaskIds: readonly string[]; // non-empty ⇒ working
  capacityRemaining: number;           // 0 ⇒ cannot bid
  departmentId: string | null;
  teamId: string | null;
  lastHeartbeatAt: string;
}

// commitment-ledger.ts
export interface Commitment {
  commitmentId: string;
  engineId: string;
  taskId: string;
  deliverableHash: string;   // A4: content-addressed goal
  deadline: string;
  acceptedAt: string;
  // Resolution:
  resolved: null | { at: string; kind: 'delivered' | 'failed' | 'transferred'; evidence: string }; // SHA-256 of trace artifact / Fact bundle (A4); opaque pre-O8
}
```

> **Future O8 — A4 strengthening:** today `evidence` is opaque text. Phase O8
> will require it to be a content-hash referencing a stored trace or `Fact`
> bundle in WorldGraph, closing the A4 loop on deliverables (not just goals).

### 2.3 Fallback Selector (formerly "Volunteer Protocol")

> **Naming honesty.** This was originally framed as a "volunteer protocol" where
> agents push `VolunteerOffer`s. The shipped implementation is an
> **orchestrator-driven fallback selector** — agents do not originate offers.
> The label `volunteer` survives in code (`VolunteerRegistry`,
> `attemptVolunteerFallback`, `helpfulnessCount`) for continuity, but the
> mental model is "coordinator picks a standby agent when the market is
> empty," not "agents raise their hand." Agent-originated offers are tracked
> as a future extension; see §7 known limitations.

Not an LLM loop. A deterministic rule:

1. `TaskAnnounced` fires. Auction opens for N ms.
2. Auction closes. If a winning bid exists → standard path.
3. If no winning bid, the **coordinator** (A3, rule-based) scans Standby
   agents in the task's department and selects by
   `(capability × trust × current_load⁻¹)`.
4. The selected agent's `helpfulness` counter increments **only on
   `delivered` commitment resolution** — affects promotion gates, NOT bid
   scoring (prevents gaming the auction).

This preserves A3 (no LLM in selection) and A7 (delivered-vs-assigned feeds prediction error).

### 2.4 Commitment → Deliverable → Settlement Cycle

Sequence and resolution kinds (`delivered` / `failed` / `transferred`) are wired in [`src/orchestrator/ecosystem/commitment-bridge.ts`](../../src/orchestrator/ecosystem/commitment-bridge.ts). Everything except "agent executes" is deterministic and A3-compliant. The existing `SettlementEngine` already closes the financial loop; the new code adds the **runtime-state loop** alongside it.

### 2.5 Prediction-Error Hookup (A7)

Today commitment open/close emits trust deltas only. To close the A7 loop,
the open event should carry `predicted: { deadlineAt, qualityScore,
costEstimate }` derived from the winning bid; on close, the coordinator
emits `prediction:error` with the deltas. Tracked as Open Phase O9 — schema
additive, no breaking change to existing consumers.

---

## 3. Phasing

Five phases. Each is independently shippable and testable. No phase commits before its axioms table is green.

### Phase O1 — Runtime State FSM (1 PR)
**Deliverable:** `runtime-state.ts` + `AgentRuntimeStore` (SQLite table `agent_runtime`) + transition events on the bus.
**Wired into:** `worker-pool.ts` (transitions on dispatch/return), `phase-generate.ts` (reads state when selecting engines).
**Axioms:** A3 (FSM is pure), A6 (transitions authorized by coordinator only).
**Tests:** state transitions, concurrent dispatch safety, crash recovery (runtime=Working at startup → auto-demote to Standby AND resolve any open commitment with `resolutionKind='crashed'` (no dangling rows)).
**Wiring evidence:** `src/orchestrator/ecosystem/builder.ts:67` (instantiated by `buildEcosystem`, called from `src/orchestrator/factory.ts:710` when `ecosystem.enabled`).

### Phase O2 — Commitment Ledger (1 PR)
**Deliverable:** `commitment-ledger.ts` + `CommitmentStore` (SQLite). Create on bid-accept, resolve on oracle verdict.
**Wired into:** `auction-engine.ts` (create), `phase-verify.ts` (resolve).
**Axioms:** A4 (deliverableHash), A7 (resolution event feeds `PredictionError`).
**Tests:** ledger matches settlement, orphan commitments detected by reconciler, replay is deterministic.
**Wiring evidence:** `src/orchestrator/ecosystem/builder.ts:73` (called from `src/orchestrator/factory.ts:710` when `ecosystem.enabled`).

### Phase O3 — Department & Team (1 PR, bigger)
**Deliverable:** `department.ts`, `team.ts`, capability-to-department index. Task announcement first goes to department; falls back to global after `departmentTimeoutMs`.
**Wired into:** `engine-selector.ts` (adds `departmentFilter`), `market-scheduler.ts` (department-scoped auctions), `room-dispatcher.ts` (team-scoped rooms can reuse blackboard).
**Axioms:** A3 (routing rules are declarative), A5 (local-department evidence weighs more).
**Tests:** unknown department falls back, team blackboard survives room close, cross-department task triggers global auction.
**Wiring evidence:** `src/orchestrator/ecosystem/builder.ts:103` (called from `src/orchestrator/factory.ts:710` when `ecosystem.enabled`).

### Phase O4 — Fallback Selector (volunteer code path) (1 PR)
**Deliverable:** `volunteer-protocol.ts`, `VolunteerOffer` schema, coordinator rule for auction-fallback. Code keeps the `volunteer*` identifiers; semantics are coordinator-driven fallback (see §2.3).
**Wired into:** `market-phase.ts` (new phase: `volunteering` after `bidding` if no winner), `engine-selector.ts` (helpfulness weighted into promotion, NOT bidding).
**Axioms:** A1 (volunteer offers are proposals, coordinator disposes), A3 (selection rule is pure).
**Tests:** auction-empty → volunteer wins, auction-winner-present → volunteers ignored, helpfulness affects promotion only.
**Wiring evidence:** `src/orchestrator/ecosystem/builder.ts:96` (called from `src/orchestrator/factory.ts:710` when `ecosystem.enabled`).

### Phase O5 — EcosystemCoordinator (1 PR)
**Deliverable:** `ecosystem-coordinator.ts` — the thin integrator that subscribes to all the bus events and maintains the cross-system invariants (runtime=Working ⇔ open commitment exists; department membership consistent with capabilities).
**Wired into:** `factory.ts`.
**Axioms:** A3 (pure invariant checks), A6 (can demote workers that violate invariants).
**Tests:** invariant violations detected and emitted as `ecosystem:invariant_violation`; boot-time `recoverFromCrash()` flips orphan `Working` rows to `Standby`; `vinyan run` smoke test end-to-end.
**Wiring evidence:** `src/orchestrator/ecosystem/builder.ts:105` (called from `src/orchestrator/factory.ts:710` when `ecosystem.enabled`).
Boot recovery is responsible for both runtime FSM repair and commitment-ledger closure; `reconcile()` does NOT do this.

> **Recovery scope (locked).** Self-heal happens at **boot only** via
> `recoverFromCrash()`. The runtime `reconcile()` sweep is **detect-only** —
> it reaps expired commitments and emits violation events, but does NOT
> auto-repair runtime/ledger drift. Operators (or a future O7 phase) own
> the repair policy.

---

## 4. Explicit Non-Goals

- **No agent personalities / roleplay.** Role = FSM state, not character.
- **No LLM in governance.** Coordinator decisions stay rule-based (A3).
- **No re-architecture of Room / Market / A2A.** We are integrating, not replacing.
- **No distributed consensus in O1-O5.** Cross-instance ecosystem is a later phase after A2A R3 ships. Single-instance first.
- **No "sleep cycle pattern mining" overlap.** `src/sleep-cycle/` is Phase 2 (learning rules); `RuntimeState.dormant` here is *just* process-dormancy. Names are kept distinct on purpose.

---

## 5. Locked Decisions

### 5.1 Original locked decisions

1. **Runtime states:** `dormant | awakening | standby | working`.
   - `dormant` chosen over `sleep` to avoid collision with `src/sleep-cycle/` (pattern mining) and `src/orchestrator/agent-budget`'s "sleeping" terminology.
   - Verb form matches agent behavior: an agent is dormant (not scheduled), awakening (warming up), on standby (ready), or working (committed).

2. **Departments: capability-derived with seed anchors.**
   - Seed the system with ~5 departments defined by *anchor capabilities* in `vinyan.json` (e.g. `code-mutation`, `research`, `verification`, `planning`, `conversation`).
   - An agent joins a department when its capability vector ≥ threshold on that anchor. No hard membership — an agent can belong to multiple.
   - Advantage over hard-coded roster: new agents auto-route; advantage over pure derivation: routing is stable and debuggable.

3. **Team blackboard persistence: filesystem-backed, restart-safe.**
   - Source of truth: `<workspace>/.vinyan/teams/<teamId>/` via
     `TeamBlackboardFs`. Migration 040 dropped the earlier `team_blackboard`
     SQLite table; SQLite is no longer involved.
   - Retention: drop entries older than 30 days or after explicit `team.reset()`.
   - Survives process restart so long-running teams pick up where they left off.
   - Rationale for FS over SQLite: blackboard values are large and
     write-heavy; FS avoids row contention and lets `chokidar`-style
     watchers observe changes without polling the DB.

4. **Volunteer gaming counter:** helpfulness metric counts only volunteers that reach a `delivered` commitment resolution (not `failed` or `transferred`). Indiscriminate volunteering thus does not pay off.

### 5.2 Department membership policy

- **Exit policy:** when an engine's capability vector drops below threshold
  for a department, membership is removed on the next `engine:registered`
  event (capability vectors are immutable per registration). No mid-life
  recompute.
- **`departmentTimeoutMs`:** Not yet implemented (Phase O3 follow-up). The
  Phase O3 deliverable still references this fallback timeout, but no
  config key has shipped — see §7 known limitations.
- **Multi-department routing:** `getEnginesInDepartment` returns the union;
  ranking is deferred to `EngineSelector` Wilson-LB.

---

## 6. Out-of-Scope (tracked separately)

- Cross-instance ecosystem (federation of ecosystems) → depends on A2A R3.
- UI/TUI for observing the ecosystem → `src/tui/` enhancement, not part of this plan.
- Self-directed org-restructure (agents proposing their own departments) → violates A3 spirit; revisit only after evolution-engine maturity.

---

## 7. Activation Status (as of 2026-04-19)

All phases O1–O5 implemented AND wired into the default `vinyan run` path,
gated by `ecosystem.enabled: true` in `vinyan.json`. When the flag is off
the system runs in legacy mode (no runtime FSM tracking, no commitment
ledger, no department index). With it on:

| Integration point | Wiring | Source |
|---|---|---|
| Ecosystem bundle construction | `buildEcosystem` called from `factory.ts` when `ecosystem.enabled` | factory.ts |
| Worker dispatch engine resolution | `WorkerPoolImpl` resolves engine by `routing.workerId → routing.model → selectForRoutingLevel(level)` so the EngineSelector pick is honored | worker-pool.ts |
| Engine selector runtime gate | `DefaultEngineSelector` drops dormant/awakening providers AND `working` providers at capacity | engine-selector.ts |
| Department-scoped engine selection | `DefaultEngineSelector` narrows pool when `options.departmentId` is set | engine-selector.ts |
| Commitment bridge | `CommitmentBridge.start()` subscribes to `market:auction_completed` + `trace:record`. `taskResolver` is wired to `TaskFactsRegistry` (registered/unregistered by `executeTask`) | ecosystem-coordinator.ts + task-facts-registry.ts |
| Helpfulness tiebreaker in promotion | `WorkerGates` uses `helpfulnessCount` for Wilson-LB ties | worker-gates.ts |
| Volunteer fallback on auction empty | `DefaultEngineSelector` calls `volunteerFallback` when market + wilson-LB miss | engine-selector.ts + factory.ts |
| Crash recovery | `coordinator.start()` calls `recoverFromCrash()` on every boot | ecosystem-coordinator.ts |
| Reconcile invariants (I-E1/I-E2/I-E3) | `coordinator.reconcile()` — manual call, schedule via config `reconcile_interval_ms` (TODO: scheduler wire) | ecosystem-coordinator.ts |

### Known limitations (still on the runway)

- **Reconcile is detect-only.** `EcosystemCoordinator.reconcile()` reaps
  expired commitments and emits `ecosystem:invariant_violation` for I-E1
  / I-E2 / I-E3, but does not auto-repair runtime state vs. ledger
  inconsistencies — operators are expected to act on the events. The
  earlier "self-heals from partial-write crash" wording in §3 (Phase O5) only refers
  to the boot-time `recoverFromCrash()` sweep (Working → Standby).
- **Volunteer fallback is deterministic standby selection.** The
  current implementation picks among standby agents in the department
  via `(capability × trust × current_load⁻¹)`. Agent-originated
  voluntary bids are not yet supported; "volunteer" is the orchestrator
  invoking the fallback path.
- **Boot recovery currently flips runtime only; commitment closure on
  crash is open.** `recoverFromCrash()` (`src/orchestrator/ecosystem/runtime-state.ts:201`)
  resets `working`/`awakening` rows to `standby` but does not call into
  `CommitmentLedger` to resolve open commitments with `kind='failed'`.
  Tracked under Phase O5 follow-up.
- **`departmentTimeoutMs` not implemented.** Phase O3 deliverable
  references this fallback timeout but no config key has shipped — task
  announcement currently goes straight to the global selector when the
  department has no eligible engines.
- **WorkerPool capacity exhaustion handling is open** — see §10 (Open
  Phase O7).
- **Federation-compatible API surface, not federation-ready runtime.**
  See §8 — the public surface accepts the shape needed by remote peers,
  but cross-instance commitment / runtime semantics depend on A2A R3.

See Appendix A for chronological shipped work.

### Remaining gap

- **Cross-instance federation** — blocked on A2A R3 (cross-instance rooms +
  consensus). See §8 for the federation-readiness audit.

---

## 8. Federation-Readiness Audit

Cross-instance ecosystem (federation of ecosystems) is out of scope for O1-O5
because it depends on the A2A R3 transport layer (cross-instance rooms +
partition-tolerant consensus), which is design-only. The audit below confirms
the existing ecosystem API surface can accommodate a `peerId` dimension without
breaking changes — no refactor lock-in today.

| Primitive | Federation-impact | Extension path |
|---|---|---|
| `RuntimeStateManager` | `listByState()` returns local only | Add `listRemoteByState(peerId)` method; existing string `agentId` can encode `peer:agentId` if needed. No breaking change. |
| `CommitmentLedger` | `engineId` is a string | Same encoding strategy; commitments opened by remote peers carry `peer:engineId`. Storage schema unchanged. |
| `DepartmentIndex` | Local-only engines | Add optional `source: 'local' \| peerId` to membership. `getEnginesInDepartment` can union local + remote without API change by mixing ids. |
| `VolunteerRegistry` | Offers are local-declared | Add `declareRemoteOffer(offerId, peerId, ...)` — the storage schema already has `engine_id` which can encode remote ids. |
| `EcosystemCoordinator.attemptVolunteerFallback` | Queries local standby only | Add an async `remoteOfferProbe?` callback; when present, the coordinator awaits A2A peer offers before scoring. Non-breaking (optional). |
| `HelpfulnessTracker` | Counts local deliveries | Remote deliveries fire `commitment:resolved` via `remote-bus.ts` if A2A relays it. Tracker already listens to bus; no change. |
| `TeamManager` | Team roster is local engine ids | Members can be `peer:engineId`. No schema change. |
| `CommitmentBridge` | Subscribes to local `market:auction_completed` | A2A can relay the event through `remote-bus.ts`; bridge code unchanged. |

**Verdict:** ecosystem is federation-ready. When A2A R3 ships, the
federation layer is additive — new code paths for remote offers /
remote state, no refactor of what's already shipped.

**Explicit non-goals (still):**
- Cross-instance consensus on shared commitment (requires A2A R3's
  partition-tolerant consensus algorithm).
- Remote runtime FSM view (needs peer-healthy gossip — A2A already has
  `peer-health.ts` but it doesn't feed the ecosystem today).
- Federation economy — `src/economy/federation-cost-relay.ts` exists but
  doesn't close the accountability loop with remote commitments yet.

---

## 9. Activation recipe

Minimum `vinyan.json` to turn on the full ecosystem:

```json
{
  "ecosystem": {
    "enabled": true,
    "departments": [
      {
        "id": "code",
        "anchor_capabilities": ["code-generation", "tool-use"],
        "min_match_count": 2
      },
      {
        "id": "research",
        "anchor_capabilities": ["reasoning", "text-generation"],
        "min_match_count": 1
      }
    ],
    "reconcile_interval_ms": 300000,
    "runtime_gate_selection": true
  }
}
```

With this set:
- Every engine registration auto-creates a runtime-FSM row and a
  department-index entry
- Worker dispatch transitions Standby → Working → Standby
- Commitments open/close automatically via market+trace bus events
- Invariants audited every 5 minutes; violations surface on the bus
- Volunteer fallback kicks in when market + Wilson-LB both fail
- Helpfulness sideband feeds promotion (never bid scoring)
- Rooms can opt into team-persisted state via `contract.teamId` +
  `teamSharedKeys`

---

## 10. Open Phase O7 — Capacity Exhaustion Policy

- **Problem:** race between selector gate and dispatch slot acquisition can
  let two tasks bind to the same engine past `capacityMax`.
  `acquireRuntimeSlot` (`src/orchestrator/worker/worker-pool.ts:407`)
  currently logs and continues.
- **Required policy:** dispatch-time capacity check must be fatal — reject
  the assignment, emit `ecosystem:capacity_exceeded`, and trigger reselection
  through `EngineSelector.select()` with the saturated engine excluded.
- **Out of scope:** cross-instance capacity coordination (depends on A2A R3).

---

## Appendix A — Implementation Changelog

### Shipped follow-ups (2026-04-19)

1. ✅ **Reconcile scheduler** — `EcosystemCoordinator` now runs chained
   `setTimeout` at `reconcile_interval_ms` cadence. Violations emitted as
   `ecosystem:invariant_violation`; every sweep emits
   `ecosystem:reconcile_tick`. Errors caught; scheduler continues.
   Test-injectable timer for deterministic driving.
2. ✅ **Engine auto-refresh on register** — `ReasoningEngineRegistry.setBus()`
   wires `engine:registered` / `engine:deregistered` events. The coordinator
   subscribes and upserts department membership + auto-registers into the
   runtime FSM (awaken → standby) the moment a new engine joins at
   runtime. Deregister flips runtime to dormant so the selector drops it.
3. ✅ **Room ↔ Team blackboard bridge** — `RoomContract` gains optional
   `teamId` + `teamSharedKeys`. Dispatcher imports team state at open via
   `RoomBlackboard.systemSeed()` (Supervisor-privileged — does NOT violate
   A6 role-scoping). Writes back to `TeamManager` **only** on
   `status=converged`; partial / failed / awaiting-user closes leave team
   state untouched. Only keys modified during the room are exported (version
   diff vs. baseline).
4. ✅ **Volunteer no-winner cleanup** — `attemptVolunteerFallback` now
   declines offers when `selectVolunteer` returns no winner (previously left
   rows in an indeterminate state).

### Shipped follow-ups (2026-04-26 — accountability loop)

5. ✅ **Task identity contract** — `EngineSelector.select()` now takes the
   real `TaskInput.id` (not `goal.slice(0, 50)`). The cost-prediction key
   moved into `SelectOptions.taskType`. Auction allocation, volunteer
   fallback, and `engine:selected` events all key off the real task id, so
   the commitment opened on `market:auction_completed` is the same id seen
   on `trace:record` end-to-end.
6. ✅ **Production task-facts resolver** — `TaskFactsRegistry`
   (`src/orchestrator/ecosystem/task-facts-registry.ts`) is instantiated
   by `factory.ts` and registered into `OrchestratorDeps`. `executeTask()`
   registers `goal` / `targetFiles` / `deadlineAt` at task entry and
   unregisters in its `finally` block; the bridge's `taskResolver` reads
   from it. The previous `taskResolver: () => null` placeholder is gone.
7. ✅ **WorkerPool honors `routing.model`** — engine resolution and the
   runtime slot id now use `routing.workerId ?? routing.model ??
   selectForRoutingLevel(level)`. The trust-weighted pick from
   `EngineSelector` is no longer silently discarded when the fleet
   profile is absent.
8. ✅ **Capacity-aware runtime gate** — `DefaultEngineSelector` filters out
   `working` providers whose `activeTaskCount >= capacityMax`, in addition
   to dormant/awakening. Wilson-LB ranking now runs over the filtered
   pool when any runtime/department filter is active so the selection
   stays consistent with the gate.
