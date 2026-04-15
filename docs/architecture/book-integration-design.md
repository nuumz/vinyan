# Multi-Agent Orchestration Book — Integration Design (Phase A)

> **Document boundary:** this is the **as-built design document** for the
> nine action items catalogued in
> [`book-integration-overview.md`](./book-integration-overview.md).
> It exists so a reviewer can validate every change against axioms A1 / A3 / A6
> in one pass, and so a future maintainer can trace a bus event or a filename
> back to the design intent that put it there.
>
> The overview is the *why*. This doc is the *what* and *how*. Implementation
> lives in code — see cross-references below.

**Date:** 2026-04-14
**Status:** as-built — all Wave 1/2/3 items shipped on
`claude/implement-book-integration-tWQQg`.
**Companion:** [`../design/book-integration-implementation-plan.md`](../design/book-integration-implementation-plan.md) (Phase B)

---

## 1. Axiom checklist — read this before any review

Every change documented below was reviewed against the three filter questions
from the overview §2. If you find a place where any answer could be "no", it's
a bug — open an issue.

| # | Question | Check it by reading |
|---|----------|---------------------|
| Q1 | Generator and verifier remain **separate processes** | `src/orchestrator/worker/agent-loop.ts` (subprocess spawn), `src/orchestrator/critic/debate-mode.ts` (3 distinct `LLMProvider.generate` calls) |
| Q2 | Governance path is **rule-based, zero LLM** | `src/orchestrator/task-decomposer-presets.ts` (keyword match), `src/orchestrator/concurrent-dispatcher.ts::computeConflictPlan` (union-find), `src/sleep-cycle/sleep-cycle.ts` sentinel block (counter comparison), `src/orchestrator/critic/debate-mode.ts::shouldDebate` (risk threshold) |
| Q3 | Workers **propose-then-dispose** via contract | `src/orchestrator/worker/session-overlay.ts`, `src/guardrails/silent-agent.ts` (observation only, no new authority) |

---

## 2. Wave 1 — Quick Wins

### 2.1 W1.1 — Silent-Agent Detector (worker heartbeat)

**Code:**
- `src/guardrails/silent-agent.ts` — `SilentAgentDetector` class (stateless watchdog)
- `src/orchestrator/worker/agent-loop.ts` — wiring + interval tick
- `src/orchestrator/factory.ts` — default config (15 s warn / 45 s stall)
- `src/core/bus.ts` — new `guardrail:silent_agent` event
- `src/tui/event-renderer.ts` — category/icon/summary for the new event
- `src/tui/views/peek.ts` — surfaces the event in per-agent stream (Wave 3.1)

**Design notes:**
1. **State machine**: `healthy → silent → stalled`. `silent` is a recoverable
   warning (operator hint). `stalled` recommends a forcible kill but does
   NOT perform one — keeping governance out of the guardrail layer satisfies
   A3. The core loop owns the kill decision.
2. **Ticker**: `setInterval` with period = `warnAfterMs/3` inside
   `runAgentLoop`. The detector is pure (no side effects) and the bus emit
   happens in the interval callback. Interval is `unref()`-ed so an idle
   watchdog never keeps the orchestrator alive on its own.
3. **Why guardrails, not a subsystem**: the watchdog is defensive observation
   that sits next to prompt-injection and bypass detection — same role (detect
   anomalies without trusting the worker) and same callsite (agent loop). No
   new top-level concept needed.
4. **A1**: the detector observes the subprocess boundary but never reads the
   worker's reasoning. A6: no new authority — detector cannot mutate or kill.

**Tests:** `tests/guardrails/silent-agent.test.ts` — state machine,
idempotent tick, heartbeat reset, multi-task tracking, constructor invariant.

### 2.2 W1.2 — Research-Swarm Preset

**Code:**
- `src/orchestrator/task-decomposer-presets.ts` — `matchDecomposerPreset`,
  `buildResearchSwarmDAG`, `RESEARCH_SWARM_REPORT_CONTRACT`
- `src/orchestrator/task-decomposer.ts` — integration (preset check runs
  before the LLM path)

**Design notes:**
1. **Match rule**: reasoning task AND goal prefix (first 80 chars) contains
   a research verb AND goal does NOT contain a mutation verb. Deliberately
   narrow — a missed preset falls through to the LLM decomposer at zero cost,
   a false-positive preset fans out Opus calls on a simple bug fix.
2. **Shape**: N parallel explorers (default 3, hard-capped at 5) → 1 aggregator.
   Each node is read-only and is assigned the `none-readonly` oracle marker
   so the DAG validator's verification-specified check (C5) passes without
   requiring structural oracles on read-only nodes.
3. **DAG validator invariant**: the validator's `noScopeOverlap` check (C2)
   would fail if every explorer claimed the same file set. Solution: explorers
   carry `targetFiles: []` and only the aggregator carries the blast radius.
   Explorers still receive the parent's `targetFiles` via their spawned
   `TaskInput` — the DAG node's `targetFiles` is a planning-only concept.
4. **Report contract**: injected as a task constraint string —
   `REPORT_CONTRACT: ...`. The understanding pipeline treats constraints as
   first-class grounding, so explorers and the aggregator all see the same
   schema requirement without the caller having to plumb it through the
   prompt.

**Tests:** `tests/orchestrator/task-decomposer-presets.test.ts` — match
triggers, rejection for mutation verbs, DAG validator integration, fanout
cap behavior.

### 2.3 W1.3 — Three-Tier Mental Model (docs only)

**Code:**
- `docs/architecture/vinyan-os-architecture.md` — new §3.1 "Three-Tier mental
  model — Operator vocabulary"

**Design notes:** the taxonomy is a vocabulary, not a subsystem. Vinyan
already runs three classes of agent (Worker / Swarm / Fleet) along the
governance-trust axis. The doc gives them names and pairs each tier with the
file where it lives. Pairs with Appendix B (Tier ↔ Transport) from W3.3.

**Tests:** none — pure documentation.

---

## 3. Wave 2 — Critic Hardening

### 3.1 W2.1 — Architecture Debate Mode

**Code:**
- `src/orchestrator/critic/debate-mode.ts` — `ArchitectureDebateCritic`,
  `DebateRouterCritic`, `shouldDebate`, `parseDebateOverride`
- `src/orchestrator/factory.ts` — wires the router to swap baseline/debate
  based on `shouldDebate()`
- `src/orchestrator/core-loop.ts` — annotates `task.riskScore` before the
  critic call so the router has a risk signal to read

**Design notes:**
1. **Three seats, three calls**: advocate, counter, architect. Each call is
   a separate `LLMProvider.generate()` invocation with a distinct system
   prompt and distinct user prompt context. Shared context is built once and
   fanned out. A1 is enforced at the subprocess/process level through the
   `LLMProvider` abstraction — the same provider with three separate calls
   is still A1-compliant because each call has its own conversation context.
2. **Architect rule**: deterministic. Any `unresolved_attacks` entry in the
   architect's verdict blocks approval, regardless of the architect's own
   `approved` flag. This is A3: the critic can't rubber-stamp itself.
3. **Confidence computation**: `strengths / (strengths + blockers)`. A5
   compliant — no LLM self-report enters the confidence score. Parse
   failures fail-closed with confidence 0.3.
4. **Router trigger**: `shouldDebate({ riskScore, manualOverride, threshold })`.
   Priority: manual override > risk threshold. Default threshold 0.7 per
   overview §8 Q1. Manual override via `DEBATE:force` / `DEBATE:skip`
   constraint on the task.
5. **riskScore threading**: core-loop annotates `task.riskScore` via an
   ad-hoc cast immediately before `criticEngine.review()`. The cast is
   documented as a known short-term seam that should go away when the
   `CriticEngine` interface is extended with a context object. The router
   reads it back with a matching cast and defaults to baseline when it's
   undefined — so older test fixtures that don't set it remain correct.

**Tests:** `tests/orchestrator/critic/debate-mode.test.ts` — shouldDebate
rules, parseDebateOverride, 3-seat happy path, blocking-attack rejection,
parse-failure fail-close, provider-throw fail-close, router selection
(baseline / forced / risk-triggered).

### 3.2 W2.2 — Merge-Conflict Pre-Computation

**Code:**
- `src/orchestrator/concurrent-dispatcher.ts` — `computeConflictPlan()`
  (pure function, union-find) + refactored `dispatch()` (group-based)

**Design notes:**
1. **Shape**: `ConflictPlan { groups, fileFree, adjacency }`. Two tasks
   share a group if there's *any path* of shared-file conflicts between
   them (transitive), because A → B and B → C means A and C can't run in
   parallel even if they don't directly share files — B would deadlock them.
2. **Algorithm**: build per-file buckets → bidirectional adjacency list →
   union-find collapse. O(n·f²) where `f` is average files-per-task, which
   is trivial for realistic batch sizes.
3. **Execution**: every group runs as a serial chain, different groups run
   in parallel bounded by the `TaskQueue`'s `maxConcurrent`. File-free
   tasks join the parallel pool directly.
4. **Observability**: plan emits one `dag:executed` event at dispatch time
   so dashboards can snapshot the schedule before any work runs — this
   replaces the earlier lazy-retry model where the coordination structure
   was only visible after the fact.
5. **Why kill the lazy retry**: the old model re-acquired locks in rounds,
   which worked but obscured the real coordination graph behind repeated
   lock attempts. With the plan, operators can inspect the full schedule
   by calling `computeConflictPlan(tasks)` directly — no dispatch needed.

**Tests:** `tests/orchestrator/conflict-plan.test.ts` — empty input,
single file-free, disjoint tasks, direct sharing, transitive chains,
disjoint islands, adjacency correctness, file-free exclusion from groups.
Existing `tests/orchestrator/concurrent-dispatcher.test.ts` all pass
unchanged (the behavioural contract is preserved).

### 3.3 W2.3 — Termination Sentinel in Sleep Cycle

**Code:**
- `src/sleep-cycle/sleep-cycle.ts` — `consecutiveNoopCycles` counter,
  `lastObservedTraceCount` snapshot, early-return block in `run()`

**Design notes:**
1. **Trigger rule**: `run()` short-circuits with
   `skippedBy: 'sentinel-dormant'` when
   `consecutiveNoopCycles ≥ sentinelMaxNoopCycles` (default 5) AND
   `traceCount === lastObservedTraceCount`. Both conditions — the
   trace-count delta is a coarse-but-reliable "new evidence available"
   signal that matters more than wall-clock time.
2. **Productivity definition**: a cycle is productive iff it emits a new
   pattern, generates or promotes or retires a rule, creates a skill, or
   finds a cost pattern. Retirement is included because pruning a
   chronically-ineffective rule materially changes the rule-store state
   and routing behavior downstream. Decay moves alone don't count —
   decay is internal housekeeping.
3. **Wake-up**: any trace-count change resets the dormant check, so the
   sentinel wakes as soon as new evidence arrives without needing manual
   intervention.
4. **Bus event**: when the sentinel fires, an `observability:alert`
   event with severity `warning` is emitted so dashboards can report
   "sleep cycle dormant" distinctly from "data gate not satisfied".
5. **Pre-existing bug found**: the `cycleId = cycle-${Date.now()}` shape
   collides when two runs happen in the same millisecond (surfaced by the
   test for this sentinel). Fixed with a 4-char random suffix — this
   change is scoped under the same commit because the test can't exist
   without it.

**Tests:** `tests/sleep-cycle/termination-sentinel.test.ts` — first-run
not-skipped, dormant after N no-ops, wake on trace count delta,
data-gate vs sentinel-dormant distinction.

---

## 4. Wave 3 — Visibility & UX

### 4.1 W3.1 — `vinyan tui peek <task-id>` Command

**Code:**
- `src/tui/views/peek.ts` — `startPeek`, `PeekHandle`, event whitelist,
  glob matcher, `summarizeForPeek`
- `src/tui/commands.ts` — `startPeekStream` helper and `peek` subcommand
  added to `processTUICommand`

**Design notes:**
1. **Filter contract**: exact task id or glob-prefix pattern. Glob supports
   `*` only. Prefix matching is enough for delegation chains because child
   task ids follow `<parent>-child-<ts>` conventions.
2. **Whitelist over deep scan**: `TASK_EVENTS` is a literal list of bus
   events that carry a `taskId`. Adding a new task-bearing event requires
   editing this list — caught during code review instead of silently
   missed. Documented inline.
3. **Zero governance impact**: peek is a pure bus consumer. No new events
   are produced, no state is mutated. The rendering sink is injectable so
   tests can capture lines directly instead of stubbing `console.log`.

**Tests:** `tests/tui/peek.test.ts` — exact match, glob prefix (delegation
chain), silent-agent event surfacing, stop() unsubscribes.

### 4.2 W3.2 — Worktree Isolation (DEFERRED BY DESIGN)

**Status:** explicitly deferred. The overview §8 Q3 flagged this as
contingent on a design decision, and the decision here is **no**:

1. Vinyan already runs workers inside a Docker sandbox (`src/worker/sandbox.ts`).
   The marginal blast-radius reduction from adding a worktree layer is small
   compared to the maintenance cost of another isolation mechanism.
2. The overview's rationale for worktree was to enable N parallel workers on
   the same repo without filesystem interference. Vinyan's `SessionOverlay`
   already solves this at the file-mutation staging layer — each worker
   writes to its own overlay directory and the orchestrator commits via
   content-addressed snapshots.
3. Adding worktree as a parallel isolation layer would require wiring a new
   cleanup hook in `WorkerLifecycle` for orphan-worktree GC plus a bootstrap
   path that sets up the worktree before `runAgentLoop` spawns the subprocess.
   Both are straightforward but non-trivial — and neither delivers value
   until a user complains about Docker-based isolation.

**When to revisit:** if an operator reports a file-write collision that
escaped the session overlay + Docker combination, or if a task needs to
run `git` commands that would fight with the orchestrator's own git state.

### 4.3 W3.3 — Tier ↔ Transport Mapping

**Code:**
- `docs/architecture/vinyan-os-architecture.md` — new Appendix B

**Design notes:** pure documentation. Pairs with §3.1 so operators can
answer "which tier?" and "which transport?" from the same page.

**Tests:** none — pure documentation.

---

## 5. Review checklist (for the actual PR)

Copy this into the PR description.

- [ ] `bun run tsc --noEmit` passes
- [ ] `bun test tests/guardrails` passes
- [ ] `bun test tests/orchestrator/task-decomposer-presets.test.ts` passes
- [ ] `bun test tests/orchestrator/critic/debate-mode.test.ts` passes
- [ ] `bun test tests/orchestrator/conflict-plan.test.ts` passes
- [ ] `bun test tests/orchestrator/concurrent-dispatcher.test.ts` passes (no regressions)
- [ ] `bun test tests/sleep-cycle/termination-sentinel.test.ts` passes
- [ ] `bun test tests/tui/peek.test.ts` passes
- [ ] **A1 check**: debate-mode's three seats use three distinct `LLMProvider.generate` calls with distinct system prompts (visual inspection of `debate-mode.ts`)
- [ ] **A3 check**: no new LLM call appears in any scheduler / selector / sentinel path (grep for `.generate(` outside of `critic/`, `llm/`, `thinking/`)
- [ ] **A6 check**: no new path lets a worker mutate the workspace outside its contract scope (silent-agent is observation-only; peek is read-only on the bus; debate-mode never touches the overlay)

---

## 6. What was NOT changed

For completeness, the following pieces were left alone so reviewers don't
hunt for diffs that don't exist:

- Core verification pipeline (`oracle/`, `gate/`) — book integration is
  orthogonal to the oracle stack.
- A2A protocol (`a2a/`) — no wire-format changes.
- Economy / market scheduler — unchanged.
- Phase 7 self-improvement loop — unchanged.
- ECP protocol — no new message types. The new bus events are in-process
  only; they never cross a transport boundary.

---

## 7. Known short-term seams

These are deliberate design debt, not bugs. Log them here so future
maintainers don't think they're accidents.

1. **`task.riskScore` ad-hoc cast** (`core-loop.ts` and `debate-mode.ts`).
   The `CriticEngine.review` signature should be extended to take an
   optional `context` object carrying routing information. Done right,
   this removes both casts.
2. **`input.constraints` mutation in the research-swarm preset**. The
   preset appends the report contract directly to the caller's
   `TaskInput.constraints` array. Passing a cloned TaskInput downstream
   would be cleaner; the mutation is safe today because the only consumer
   that sees it is the orchestration pipeline that owns the task.
3. **Peek event whitelist drift**. Adding a new bus event that carries a
   `taskId` requires editing `TASK_EVENTS` in `src/tui/views/peek.ts`. A
   type-level registry tagged at the bus event declaration would close
   this gap.

---

## 8. Wave 4 — Full-book Gap Closure (deep-read pass, 2026-04-15)

> **Motivation:** the first overview was written before the complete book
> read. A second pass covering Ch01–15 + App A–D surfaced three implementable
> gaps and one larger deferred item. See overview §10 for the delta log and
> §11 for the complete chapter map.

### 8.1 W4.1 — Canary-first Batch Dispatch

**Source:** Ch12 §"error() bug" + Ch14 Failure 3. The book's Elysia migration
case study shows one agent batch-migrating 19 files to a broken pattern
before a single handler was tested end-to-end; the fix was "test one file
fully before batch-migrating others." Chapter 14 elevates this to a
failure-mode pattern.

**Code:**
- `src/orchestrator/concurrent-dispatcher.ts` — new `DispatchOptions` type,
  extended `dispatch(tasks, options?)` signature, canary selection rule

**Design notes:**

1. **Opt-in per call.** The option is `dispatch(tasks, { canaryFirst: true })`.
   Not a default because:
   - homogeneous-batch detection is heuristic (we can't reliably tell when
     N tasks are "from the same mutation pattern"), and
   - canary adds latency to the first task — operators should choose when
     the safety is worth the wait.

2. **Canary selection rule** (pure, deterministic — A3-safe):
   ```
   canary = first task in submission order whose execution is either
            file-free OR in a singleton conflict group
   ```
   Rationale: the canary must be able to run WITHOUT holding any lock
   that blocks the rest of the batch. Picking a task from a multi-member
   conflict group would serialize the whole chain behind the canary.

3. **Abort semantics.** A canary "passes" iff `result.status === 'completed'`.
   Any other status (`uncertain`, `input-required`, `unknown`) fails the
   canary. On failure:
   - Return the canary's actual result
   - For every remaining task, synthesize a `TaskResult` with
     `status: 'canary-aborted'` and a `cancelReason` string pointing at
     the canary task id.
   - Emit `dag:executed` with `parallel: false` and a new flag
     `canaryAborted: true` so dashboards can distinguish "real failure"
     from "cancelled by canary".

4. **Test surface:** canary pass → full batch runs; canary fail → remaining
   tasks get synthetic aborted results; canary is picked deterministically;
   opt-in (default dispatch behavior unchanged).

**Axiom compliance:**
- A3: the canary-selection rule is a pure function on the `TaskInput[]`
  array. No LLM. No side effects.
- A6: canary-aborted tasks never enter the agent loop; no worker runs
  without its normal contract gate.

### 8.2 W4.2 — Role Hint → Engine Tier

**Source:** Appendix C Cost Analysis + Ch07 Implementation Team. The book's
explicit recommendation: "Haiku unless you need Opus" for reads, Sonnet for
implementation, Opus for debate/trade-off. Vinyan's engine selector today
picks purely by routing level and trust — it has no way for a caller to
signal "this is a read, prefer the cheapest tier."

**Code:**
- `src/orchestrator/engine-selector.ts` — extend `EngineSelector.select()`
  with an optional `roleHint?: RoleHint` parameter and a tier-preference
  override

**Design notes:**

1. **Role taxonomy** (four values, matching book roles):
   ```ts
   export type RoleHint =
     | 'read'       // ⇒ prefer 'fast' tier  (Haiku for reads/research)
     | 'implement'  // ⇒ prefer 'balanced'   (Sonnet for codegen)
     | 'debate'     // ⇒ prefer 'powerful'   (Opus for debates)
     | 'verify';    // ⇒ prefer 'balanced' then 'tool-uses'
   ```

2. **Preference, not constraint.** If the preferred tier isn't in the
   registry, fall through to the existing Wilson-LB trust selection.
   The hint never prevents selection, it only biases it. This keeps
   the existing tier-trust ladder intact and preserves A5 semantics.

3. **Where it gets set.** Callers in the orchestrator and the critic
   already know the role they need (decomposer is 'read', critic is
   'debate', worker is 'implement'). The factory wires the hint for the
   debate seats via its existing role-to-provider mapping. No broad
   refactor of existing call sites — the hint is additive and optional.

4. **Test surface:** roleHint picks the preferred tier when available;
   falls through to default when not; existing selection behavior is
   unchanged when no hint is passed.

**Axiom compliance:**
- A3: tier selection is a rule-based lookup. No LLM.
- A5: `roleHint` biases the default model but the existing trust-threshold
  and capability filters still run — a role-hinted provider that fails the
  trust check is rejected just as before.

### 8.3 W4.3 — WorkerLifecycle Cleanup Hook Registry

**Source:** Ch14 Failure 4 (orphan worktrees). Even though Vinyan rejected
full worktree adoption (W3.2), the **pattern** — "every ephemeral
isolation mechanism needs a cleanup stage on retire" — is worth
generalizing. Adding the hook registry now keeps the seam open for any
future isolation layer (worktree, tmp-dir sandbox, scratch DB) and closes
the Ch14 failure mode as "seam exists, wire what you need".

**Code:**
- `src/orchestrator/fleet/worker-lifecycle.ts` — new `onCleanup(hook)` +
  internal `runCleanupHooks(workerId, reason)` method called on demote and
  retire transitions

**Design notes:**

1. **Hook signature:**
   ```ts
   export type WorkerCleanupHook = (
     workerId: string,
     reason: 'demoted' | 'retired',
   ) => Promise<void> | void;
   ```
   Hooks are best-effort; exceptions are caught and logged but never
   block the lifecycle transition.

2. **Trigger points.** Hooks fire on:
   - every transition into `demoted` status (not on re-enrollment back to
     probation, because re-enrolled workers need to keep their state)
   - every transition into `retired` status

3. **Why best-effort.** Cleanup is a hygiene task, not a correctness
   requirement — a leaked worktree or tmp file degrades disk usage but
   never corrupts state. Failing the lifecycle transition on a cleanup
   exception would be strictly worse.

4. **Test surface:** hook registration returns an unsubscribe function;
   hooks fire on demotion; hooks fire on retirement; exceptions in a
   hook don't block the transition.

**Axiom compliance:**
- A6: hooks are called during existing state transitions that are already
  governed by `WorkerStore` + `WorkerLifecycle` — no new authority is
  introduced.

### 8.4 W4.4 — Implementation Team Preset (DEFERRED to Wave 5)

**Source:** Ch07 + Ch12. The book's mutation-side companion to Research
Swarm: 3 named roles (safety / tester / verifier) with worktree isolation
and lead-only merges.

**Why deferred:** Vinyan's architecture already gives us the mechanical
substrate (DAG executor, file locks, session overlay, orchestrator-owned
commit). What's missing is:

1. A **deterministic disjoint-seam heuristic** that partitions a
   multi-file mutation goal into N non-overlapping file groups. Options:
   - split by top-level directory (crude but deterministic)
   - split by git-history co-change clusters (needs trace analysis)
   - split by perception's `dependencyCone` components (probably best,
     but requires careful graph partitioning)

2. **Role assignment per partition** that plays with W4.2's role hint.
   The first partition gets 'implement' role; a verification partition
   gets 'verify'; an audit partition gets 'read'.

3. **An integration node** that waits for all partitions and runs a
   joint verification step. This is similar to the research-swarm's
   aggregator but writes to the commit store instead of producing a
   report.

Each of those is a non-trivial design question on its own. Shipping
W4.1–3 now gets the most obvious book-to-Vinyan gains on the table; W4.4
stays in Phase B's Wave 5 backlog with these unresolved questions called
out so the next person to pick it up doesn't have to reread the book.

---

## 9. Complete Chapter-to-Vinyan Map (as-built matrix)

> Every chapter in the book mapped to the Vinyan file or design decision
> that closes it. Cross-reference for the overview §11.

| Ch | Book concept | Vinyan artifact | Status |
|----|-------------|-----------------|--------|
| 1 | Context compaction / single-agent ceiling | subprocess per agent + `AgentBudgetTracker` + `TranscriptCompactor` | Aligned by design |
| 2 | Three tiers decision tree (< 5 min / 5–30 min / > 30 min) | §3.1 of `vinyan-os-architecture.md` (W1.3) + Appendix B (W3.3) | **W1.3 ✅** |
| 3 | Three-transport message bus (SendMessage / `maw hey` / inbox) | `src/core/bus.ts` (in-process) + `src/a2a/*-transport.ts` (4 transports) + ECP | Aligned, richer |
| 4 | TaskCreate/TaskList/TaskUpdate/TaskGet + `blockedBy` + `owner` | `plan_update` (per-session, Phase 7c-2) + DAG edges for `blockedBy` | Rejected — Vinyan's orchestrator-owned dispatch makes cross-agent claim unnecessary |
| 5 | Research Swarm (3–5 Haiku, read-only, report contract) | `task-decomposer-presets.ts::buildResearchSwarmDAG` | **W1.2 ✅** |
| 6 | Architecture Debate (3-seat advocate/counter/architect, Opus) | `critic/debate-mode.ts::ArchitectureDebateCritic` + `DebateRouterCritic` | **W2.1 ✅** |
| 7 | Implementation Team (3 roles, worktree, lead-only merge) | partially — mechanical substrate (DAG + lock + overlay) exists; preset deferred | **W4.4 (Wave 5)** |
| 8 | Federation Agent (tmux + `claude -p` + WireGuard) | `src/a2a/` full stack + `InstanceCoordinator` + `PeerHealthMonitor` + trust attestation | Aligned, richer |
| 9 | Cron Loop (prompt-is-whole, state-on-disk, sentinel) | `src/sleep-cycle/sleep-cycle.ts` + W2.3 termination sentinel + `TraceStore`/`PatternStore` | **W2.3 ✅** |
| 10 | Plugin Architecture (SDK façade, typed schemas) | `src/mcp/`, `src/orchestrator/mcp/` + Zod schemas across ECP/A2A | Aligned |
| 11 | WASM plugin runtime (16 MB / 5 s / capability bridge) | Docker sandbox (`src/orchestrator/worker/sandbox.ts`) | Rejected — Docker is richer |
| 12 | Framework migration playbook (schema → DI → swap) | No specific preset; `Canary-first batch` is the generalizable safety rule | **W4.1** |
| 13 | What the Human Sees (peek/overview/watch/inbox/feed) | `vinyan tui peek` (W3.1) + `watch` + `interactive` + event renderer (W1.1 silent event) | **W3.1 ✅** (+ overview-live Wave 5) |
| 14 | Five failure modes (silent / merge / error() / orphan / cross-repo) | F1 = W1.1, F2 = W2.2, F3 = **W4.1**, F4 = **W4.3**, F5 = n/a | Waves 1/2/4 |
| 15 | Tier 4 (`maw wake --issue --team`) | A2A + InstanceCoordinator + DelegationRouter deliver every Tier 4 property | Rejected — already covered |
| A | Command reference (maw * CLI) | `vinyan tui {interactive,watch,peek,replay,overview}` subset | Aligned |
| B | Spawn pattern cheatsheet | DAG executor + ConcurrentDispatcher + decomposer presets | Aligned |
| C | Cost analysis (3–7× token multiplier, Haiku/Sonnet/Opus guidance) | `CostLedger` + `CostPredictor` + **W4.2 role hint** | **W4.2** |
| D | Plugin catalog (41 lines median, 17 plugins) | MCP tool map in `factory.ts` | Aligned |

---

## 10. Review checklist — Wave 4 addendum

Add these alongside the Wave 1–3 checklist in §5:

- [ ] `bun test tests/orchestrator/conflict-plan.test.ts` still passes (existing)
- [ ] `bun test tests/orchestrator/canary-dispatch.test.ts` passes (new)
- [ ] `bun test tests/orchestrator/engine-selector.test.ts` passes (existing + new role-hint cases)
- [ ] `bun test tests/orchestrator/worker-lifecycle.test.ts` passes (existing + new cleanup-hook cases)
- [ ] **A3 check (Wave 4)**: canary selection is a pure function of the
      TaskInput[] — no bus emits, no async calls, no LLM. Grep the
      function body for `.generate(`, `.emit(`, `await` and assert
      matches are only in the dispatcher loop, not the selection rule.
- [ ] **A5 check (Wave 4)**: role hint is preference-only; the existing
      Wilson-LB trust filter and capability filter still run to
      completion when a hint is passed.
- [ ] **A6 check (Wave 4)**: cleanup hooks run AFTER the state
      transition completes; a failing hook must not roll back the
      lifecycle transition.
