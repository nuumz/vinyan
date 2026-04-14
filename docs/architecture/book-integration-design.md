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
