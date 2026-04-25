---
type: design
status: built-opt-in (Phase A shipped 2026-04-18: O1-O5 ✅ implemented, gated behind `ecosystem.enabled: true` — see §10 activation recipe; cross-instance modes still 📋 Designed)
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

## 1. Current Foundation (what already exists)

| Capability | Where | Status |
|---|---|---|
| Role-based collab (drafter/critic/integrator) | `src/orchestrator/room/` | ✅ R0-R2 shipped |
| Fleet career FSM (`probation/active/demoted/retired`) | `src/orchestrator/fleet/worker-lifecycle.ts` | ✅ Active |
| Sealed-bid Vickrey auction + trust weighting | `src/economy/market/auction-engine.ts` | 🔧 Built (needs `economy.enabled`) |
| Bid accuracy + anti-gaming + settlement | `src/economy/market/{bid-accuracy-tracker,anti-gaming,settlement-engine}.ts` | 🔧 Built |
| Peer discovery / gossip / negotiation / commitment | `src/a2a/{peer-discovery,gossip,negotiation,commitment}.ts` | 🔧 Built |
| Cross-instance room | `src/a2a/room.ts` | 📋 Designed |
| Engine registry + trust-weighted selector | `src/orchestrator/engine-selector.ts` | ✅ Active |

**Observation:** The pieces are mostly there. The missing layer is a **coherent FSM across them**: nothing today says "this agent is currently working on task X and cannot take another."

---

## 2. The Three Missing Axes

What the user asked for decomposes into three orthogonal concerns the code does not yet unify:

### 2.1 Runtime Activity State (Dormant / Awakening / Standby / Working)
Current `worker-lifecycle` tracks **career trust** (probation→active→demoted→retired). That is slow-moving (days/weeks). What's missing is **fast-moving runtime state** (seconds/minutes):

```
┌─────────┐ boot ┌──────────┐ bid-won ┌──────────┐ done ┌──────────┐
│ Dormant ├─────▶│ Standby  ├────────▶│ Working  ├─────▶│ Standby  │
└─────────┘      └──────────┘         └──────────┘      └──────────┘
     ▲                ▲                    │                 │
     │ idle-timeout   │ awaken-signal      │ fail            │ idle > T
     └────────────────┤                    ▼                 │
                      │              ┌──────────┐            │
                      │              │Awakening │◀───────────┘
                      │              │ (warming)│
                      │              └──────────┘
                      └──────────────────────┘
```

- **Dormant:** process terminated or deeply inactive; no subscription, no memory cost. Re-entry needs `Awakening`.
- **Awakening:** warming up (loading context, registering with bus, fetching peer state). Cannot bid yet.
- **Standby:** ready to bid; subscribed to `TaskAnnounced` events; lean memory footprint.
- **Working:** owns ≥1 task commitment; bids *rejected* by market unless spare capacity.

These are **orthogonal to career state.** An `active` worker can be `Standby` OR `Working`. A `probation` worker can still transition through all four.

### 2.2 Organizational Structure (Departments / Teams / Squads)
Today the Fleet is flat — `EngineSelector` picks from one global pool. What humans call "org structure" maps to:

- **Department** = capability cluster (e.g. `code-mutation`, `research`, `verification`). Rooms and auctions can be scoped.
- **Team** = durable roster of agents that share state across tasks (blackboard persists between rooms).
- **Squad** = ad-hoc, task-scoped team dissolved on task completion (this is what Room already is).

Adding Department + Team gives us **routing locality** (announce a task to the right department first; fall back to global), which matters for cost and latency.

### 2.3 Commitment / Accountability (responsibility consciousness)
The accountability gap today: a worker that wins a bid and then fails has its trust downgraded, but there is no explicit **commitment object** that the orchestrator holds, no **deliverable contract**, and no **volunteering protocol** for a second agent to offer help without being asked.

---

## 3. Proposed Additions

### 3.1 New Module: `src/orchestrator/ecosystem/`

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

### 3.2 Data Model Sketch

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
  resolved: null | { at: string; kind: 'delivered' | 'failed' | 'transferred'; evidence: string };
}
```

### 3.3 Volunteer Protocol (the "cooperative consciousness" piece)

Not an LLM loop. A deterministic rule:

1. `TaskAnnounced` fires. Auction opens for N ms.
2. Standby agents in the task's department may submit `VolunteerOffer` (free) OR `EngineBid` (priced).
3. If auction closes with no winning bid but `VolunteerOffer`s exist, the **coordinator** (A3, rule-based) selects by `(capability × trust × current_load⁻¹)` and assigns.
4. Volunteering counts toward a `helpfulness` metric on the `EngineProfile` — affects **promotion gates**, NOT bid scoring (to prevent gaming the auction).

This preserves A3 (no LLM in selection) and A7 (volunteering is tracked → prediction-error signal).

### 3.4 Commitment → Deliverable → Settlement Cycle

```
Bid accepted ──▶ Commitment created ──▶ runtime=Working
      │                                      │
      │                                      ▼
      │                              agent executes
      │                                      │
      ▼                                      ▼
Market tracks bid accuracy        OracleGate verifies deliverable
      │                                      │
      │◀────── settlement ────────── Commitment resolved
      │                                      │
      ▼                                      ▼
 Trust update                        runtime ─▶ Standby
```

Everything except "agent executes" is deterministic and A3-compliant. The existing `SettlementEngine` already closes the financial loop; we're adding the **runtime-state loop** alongside it.

---

## 4. Phasing

Five phases. Each is independently shippable and testable. No phase commits before its axioms table is green.

### Phase O1 — Runtime State FSM (1 PR)
**Deliverable:** `runtime-state.ts` + `AgentRuntimeStore` (SQLite table `agent_runtime`) + transition events on the bus.
**Wired into:** `worker-pool.ts` (transitions on dispatch/return), `phase-generate.ts` (reads state when selecting engines).
**Axioms:** A3 (FSM is pure), A6 (transitions authorized by coordinator only).
**Tests:** state transitions, concurrent dispatch safety, crash recovery (runtime=Working at startup → auto-demote to Standby with "crashed" evidence).

### Phase O2 — Commitment Ledger (1 PR)
**Deliverable:** `commitment-ledger.ts` + `CommitmentStore` (SQLite). Create on bid-accept, resolve on oracle verdict.
**Wired into:** `auction-engine.ts` (create), `phase-verify.ts` (resolve).
**Axioms:** A4 (deliverableHash), A7 (resolution event feeds `PredictionError`).
**Tests:** ledger matches settlement, orphan commitments detected by reconciler, replay is deterministic.

### Phase O3 — Department & Team (1 PR, bigger)
**Deliverable:** `department.ts`, `team.ts`, capability-to-department index. Task announcement first goes to department; falls back to global after `departmentTimeoutMs`.
**Wired into:** `engine-selector.ts` (adds `departmentFilter`), `market-scheduler.ts` (department-scoped auctions), `room-dispatcher.ts` (team-scoped rooms can reuse blackboard).
**Axioms:** A3 (routing rules are declarative), A5 (local-department evidence weighs more).
**Tests:** unknown department falls back, team blackboard survives room close, cross-department task triggers global auction.

### Phase O4 — Volunteer Protocol (1 PR)
**Deliverable:** `volunteer-protocol.ts`, `VolunteerOffer` schema, coordinator rule for auction-fallback.
**Wired into:** `market-phase.ts` (new phase: `volunteering` after `bidding` if no winner), `engine-selector.ts` (helpfulness weighted into promotion, NOT bidding).
**Axioms:** A1 (volunteer offers are proposals, coordinator disposes), A3 (selection rule is pure).
**Tests:** auction-empty → volunteer wins, auction-winner-present → volunteers ignored, helpfulness affects promotion only.

### Phase O5 — EcosystemCoordinator (1 PR)
**Deliverable:** `ecosystem-coordinator.ts` — the thin integrator that subscribes to all the bus events and maintains the cross-system invariants (runtime=Working ⇔ open commitment exists; department membership consistent with capabilities).
**Wired into:** `factory.ts`.
**Axioms:** A3 (pure invariant checks), A6 (can demote workers that violate invariants).
**Tests:** invariant violations caught, reconciler self-heals from partial-write crash, `vinyan run` smoke test end-to-end.

---

## 5. Explicit Non-Goals

- **No agent personalities / roleplay.** Role = FSM state, not character.
- **No LLM in governance.** Coordinator decisions stay rule-based (A3).
- **No re-architecture of Room / Market / A2A.** We are integrating, not replacing.
- **No distributed consensus in O1-O5.** Cross-instance ecosystem is a later phase after A2A R3 ships. Single-instance first.
- **No "sleep cycle pattern mining" overlap.** `src/sleep-cycle/` is Phase 2 (learning rules); `RuntimeState.dormant` here is *just* process-dormancy. Names are kept distinct on purpose.

---

## 6. Locked Decisions

1. **Runtime states:** `dormant | awakening | standby | working`.
   - `dormant` chosen over `sleep` to avoid collision with `src/sleep-cycle/` (pattern mining) and `src/orchestrator/agent-budget`'s "sleeping" terminology.
   - Verb form matches agent behavior: an agent is dormant (not scheduled), awakening (warming up), on standby (ready), or working (committed).

2. **Departments: capability-derived with seed anchors.**
   - Seed the system with ~5 departments defined by *anchor capabilities* in `vinyan.json` (e.g. `code-mutation`, `research`, `verification`, `planning`, `conversation`).
   - An agent joins a department when its capability vector ≥ threshold on that anchor. No hard membership — an agent can belong to multiple.
   - Advantage over hard-coded roster: new agents auto-route; advantage over pure derivation: routing is stable and debuggable.

3. **Team blackboard persistence: SQLite-backed, restart-safe.**
   - `team_blackboard` table keyed by `(teamId, blackboardKey)` with retention policy (default: drop entries older than 30 days or after explicit `team.reset()`).
   - Survives process restart so long-running teams pick up where they left off.

4. **Volunteer gaming counter:** helpfulness metric counts only volunteers that reach a `delivered` commitment resolution (not `failed` or `transferred`). Indiscriminate volunteering thus does not pay off.

---

## 7. Out-of-Scope (tracked separately)

- Cross-instance ecosystem (federation of ecosystems) → depends on A2A R3.
- UI/TUI for observing the ecosystem → `src/tui/` enhancement, not part of this plan.
- Self-directed org-restructure (agents proposing their own departments) → violates A3 spirit; revisit only after evolution-engine maturity.

---

## 8. Activation Status (as of 2026-04-19)

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

### Known limitations (still on the runway)

- **Reconcile is detect-only.** `EcosystemCoordinator.reconcile()` reaps
  expired commitments and emits `ecosystem:invariant_violation` for I-E1
  / I-E2 / I-E3, but does not auto-repair runtime state vs. ledger
  inconsistencies — operators are expected to act on the events. The
  earlier "self-heals from partial-write crash" wording in §5 only refers
  to the boot-time `recoverFromCrash()` sweep (Working → Standby).
- **Team blackboard is filesystem-backed.** `TeamBlackboardFs` writes
  under `<workspace>/.vinyan/teams/`; SQLite is an in-process mirror,
  not the source of truth. Migration 040 dropped the `team_blackboard`
  table.
- **WorkerPool capacity exhaustion is non-fatal.** `acquireRuntimeSlot`
  logs and continues when `markWorking` would exceed capacity. The
  selector-side filter is the active gate; making dispatch-time capacity
  failure fatal needs a reselection / retry policy and is deferred.
- **Volunteer fallback is deterministic standby selection.** The
  current implementation picks among standby agents in the department
  via `(capability × trust × current_load⁻¹)`. Agent-originated
  voluntary bids are not yet supported; "volunteer" is the orchestrator
  invoking the fallback path.
- **Federation-compatible API surface, not federation-ready runtime.**
  See §9 — the public surface accepts the shape needed by remote peers,
  but cross-instance commitment / runtime semantics depend on A2A R3.

### Remaining gap

- **Cross-instance federation** — blocked on A2A R3 (cross-instance rooms +
  consensus). See §9 for the federation-readiness audit.

---

## 9. Federation-Readiness Audit

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

## 10. Activation recipe

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
