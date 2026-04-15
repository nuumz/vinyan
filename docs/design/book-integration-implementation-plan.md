# Multi-Agent Orchestration Book — Implementation Plan (Phase B)

> **Document boundary:** this is the **as-built implementation plan** for the
> nine action items from
> [`../architecture/book-integration-overview.md`](../architecture/book-integration-overview.md).
> The companion design document is
> [`../architecture/book-integration-design.md`](../architecture/book-integration-design.md).
>
> This plan is written after the work landed, so it's a *retrospective*
> implementation plan: what files changed, what tests were added, what the
> exit criteria were, and what remained out of scope. Future work that
> revises any of these items should reference this doc for the starting
> state.

**Date:** 2026-04-14
**Status:** as-built — all waves complete on
`claude/implement-book-integration-tWQQg`.

---

## 0. Snapshot

| Wave | Items | New files | Modified files | New tests |
|------|-------|-----------|----------------|-----------|
| **W1** Quick Wins | 3 | `silent-agent.ts`, `task-decomposer-presets.ts` | `agent-loop.ts`, `guardrails/index.ts`, `bus.ts`, `task-decomposer.ts`, `factory.ts`, `vinyan-os-architecture.md` | `silent-agent.test.ts`, `task-decomposer-presets.test.ts` |
| **W2** Critic Hardening | 3 | `critic/debate-mode.ts` | `concurrent-dispatcher.ts`, `sleep-cycle.ts`, `factory.ts`, `core-loop.ts` | `critic/debate-mode.test.ts`, `conflict-plan.test.ts`, `termination-sentinel.test.ts` |
| **W3** Visibility / UX | 3 (1 deferred) | `tui/views/peek.ts` | `tui/commands.ts`, `tui/event-renderer.ts`, `vinyan-os-architecture.md` (Appendix B) | `tui/peek.test.ts` |

**Totals:** 4 new source files, 10 modified source files, 2 modified docs,
6 new test files, +2,500 LOC added.

---

## 1. Wave 1 — Quick Wins

### W1.1 — Worker heartbeat + Silent-Agent detector

**Exit criteria:**
- `SilentAgentDetector` state machine transitions correctly under fake clock (unit)
- `runAgentLoop` arms and tears down the watchdog (code inspection)
- `guardrail:silent_agent` bus event fires at warn + stall thresholds (unit)
- Factory wires a sensible default (15 s / 45 s)
- TUI `watch` view renders the event (code inspection)

**Changed files:**
| File | Change |
|------|--------|
| `src/guardrails/silent-agent.ts` | **NEW** — detector class, 180 LOC |
| `src/guardrails/index.ts` | export surface |
| `src/core/bus.ts` | `guardrail:silent_agent` event declaration |
| `src/orchestrator/worker/agent-loop.ts` | register/heartbeat/tick/unregister wiring, `silentAgentConfig` dep |
| `src/orchestrator/factory.ts` | default config, surface on `OrchestratorConfig` |
| `src/tui/event-renderer.ts` | style + summary + attach |

**Test files:** `tests/guardrails/silent-agent.test.ts` (10 cases).

### W1.2 — Research Swarm preset

**Exit criteria:**
- Preset matches research/investigate/audit/... reasoning tasks only
- Preset rejects goals containing mutation verbs
- Built DAG passes `validateDAG()` with trivial coverage (empty blast radius)
- Fanout defaults to 3, caps at 5

**Changed files:**
| File | Change |
|------|--------|
| `src/orchestrator/task-decomposer-presets.ts` | **NEW** — match + DAG builder, 200 LOC |
| `src/orchestrator/task-decomposer.ts` | short-circuit call before the LLM path |

**Test files:** `tests/orchestrator/task-decomposer-presets.test.ts` (11 cases).

### W1.3 — Three-Tier mental model (docs)

**Exit criteria:** reviewer can read §3.1 and say in one sentence "Worker =
one subprocess, Swarm = coordinated group, Fleet = population across
instances" without looking at code.

**Changed files:**
| File | Change |
|------|--------|
| `docs/architecture/vinyan-os-architecture.md` | new §3.1 (35 lines) |

**Test files:** none (pure docs).

---

## 2. Wave 2 — Critic Hardening

### W2.1 — Architecture Debate Mode

**Exit criteria:**
- 3 distinct `LLMProvider.generate` calls per review (A1 check)
- Architect JSON parse failure → fail-closed (A2)
- Any unresolved blocking attack → approved=false regardless of architect's own flag (A3)
- `shouldDebate()` triggers on risk threshold or manual override, never on LLM self-report
- Factory auto-wires `DebateRouterCritic` when providers are available
- `core-loop.ts` annotates `task.riskScore` so the router has signal

**Changed files:**
| File | Change |
|------|--------|
| `src/orchestrator/critic/debate-mode.ts` | **NEW** — 3-seat critic + router + trigger rule, 390 LOC |
| `src/orchestrator/factory.ts` | wire DebateRouterCritic on top of baseline critic |
| `src/orchestrator/core-loop.ts` | annotate `task.riskScore` before `criticEngine.review()` (ad-hoc cast, see seam #1 in design doc) |

**Test files:** `tests/orchestrator/critic/debate-mode.test.ts` (13 cases).

### W2.2 — Merge-conflict pre-computation

**Exit criteria:**
- `computeConflictPlan` is a pure function that can be called outside the dispatcher
- Transitive conflicts collapse into one serial group (union-find)
- File-free tasks run fully in parallel without touching the lock
- Existing `tests/orchestrator/concurrent-dispatcher.test.ts` still passes

**Changed files:**
| File | Change |
|------|--------|
| `src/orchestrator/concurrent-dispatcher.ts` | `computeConflictPlan` + new `ConflictPlan` / `ConflictGroup` exports + refactored `dispatch()` |

**Test files:** `tests/orchestrator/conflict-plan.test.ts` (8 cases).

### W2.3 — Termination sentinel in sleep-cycle

**Exit criteria:**
- `run()` returns `{ skippedBy: 'sentinel-dormant' }` after N no-op cycles with stable trace count
- Trace-count delta wakes the sentinel
- Retirement of ineffective rules counts as productivity
- Bus emits `observability:alert` with `detector: 'sleep-cycle-termination-sentinel'`
- Pre-existing `cycleId` collision fixed as part of the change

**Changed files:**
| File | Change |
|------|--------|
| `src/sleep-cycle/sleep-cycle.ts` | sentinel state + check + reset logic + cycleId random suffix |

**Test files:** `tests/sleep-cycle/termination-sentinel.test.ts` (4 cases).

---

## 3. Wave 3 — Visibility & UX

### W3.1 — `vinyan tui peek <task-id>`

**Exit criteria:**
- Exact task id filter works
- Glob prefix pattern works (delegation chains)
- `guardrail:silent_agent` events (from W1.1) surface through peek
- `stop()` unsubscribes cleanly
- Sink is injectable for tests

**Changed files:**
| File | Change |
|------|--------|
| `src/tui/views/peek.ts` | **NEW** — `startPeek`, glob matcher, event whitelist, summaries |
| `src/tui/commands.ts` | `startPeekStream` helper + `peek` subcommand |

**Test files:** `tests/tui/peek.test.ts` (4 cases).

### W3.2 — Worktree isolation (DEFERRED)

**Decision:** not implemented. See Phase A §4.2 for the full rationale.
Summary: Docker sandbox + session overlay already cover the use case;
adding worktree as a third isolation layer does not pay for its
maintenance cost until a real user reports a collision that escapes the
existing two layers.

**Revisit trigger:** any reported file-write collision from a concurrent
batch that survived both the session overlay and Docker isolation.

### W3.3 — Tier ↔ Transport mapping appendix

**Changed files:**
| File | Change |
|------|--------|
| `docs/architecture/vinyan-os-architecture.md` | new Appendix B (45 lines) |

**Test files:** none.

---

## 4. Rollout strategy

All Wave 1 / Wave 3 items are transparent: they either add observability
(W1.1, W3.1), short-circuit an existing LLM path (W1.2), or document
state (W1.3, W3.3). None of them change the outcome of any existing
task, so they can ship without a feature flag.

Wave 2 has one behavior-changing item:

**W2.1 Architecture Debate Mode** triples the critic LLM cost when it
fires. The trigger rule (`riskScore ≥ 0.7` by default) is the
feature-flag: operators who don't want debate can set the threshold to
`1.1` in factory config, which makes it unreachable. Forced override via
`DEBATE:force` in task constraints is opt-in per task.

Cost guard for W2.1: the existing agent budget cap applies, so a runaway
debate cannot exceed the task's token budget. Beyond that, per-day /
per-task budget guards from the Economy OS are left as a follow-up —
not blocking.

**W2.2** and **W2.3** are behavior-preserving refactors with additional
guards. No flag.

**W4.1 Canary-first batch** is opt-in per `dispatch()` call — default
behavior unchanged. Operators or core-loop callers that want the safety
pass `{ canaryFirst: true }` explicitly.

**W4.2 Role hint → engine tier** is additive — the new `roleHint`
argument is optional and existing call sites don't need to pass it.
When absent, selection falls through to the pre-W4.2 tier-trust ladder.

**W4.3 Cleanup hook registry** is additive — no hooks ship wired to
anything by default; the registry just exists so future isolation
layers can plug in without touching `WorkerLifecycle`.

---

## 5. Wave 4 — Full-book Gap Closure

> **Context:** added after a complete Ch01–15 + App A–D deep-read.
> See overview §10 for the delta log.

### W4.1 — Canary-first batch dispatch

**Exit criteria:**
- `dispatch([t1, t2, t3], { canaryFirst: true })` runs t1 alone first,
  waits for verdict, then runs t2+t3 in parallel if t1 completes
- `dispatch(tasks, { canaryFirst: true })` with a failing canary returns
  the canary's actual result plus synthetic `canary-aborted` results
  for every remaining task
- Default dispatch behavior (no options) is byte-for-byte unchanged
- Canary selection is deterministic (first file-free or first singleton
  group in submission order)
- Existing `tests/orchestrator/concurrent-dispatcher.test.ts` still passes

**Changed files:**
| File | Change |
|------|--------|
| `src/orchestrator/concurrent-dispatcher.ts` | `DispatchOptions` + canary selection + abort semantics |
| `src/orchestrator/types.ts` | extend `TaskResult` status union with `'canary-aborted'` |

**Test files:** `tests/orchestrator/canary-dispatch.test.ts` (5 cases).

### W4.2 — Role hint → engine tier

**Exit criteria:**
- `EngineSelector.select(level, taskType, caps, roleHint)` accepts optional
  `roleHint` and biases the default model toward the preferred tier when
  available
- Missing preferred tier falls through to existing selection — not an error
- Existing callers (no roleHint) see unchanged behavior
- Factory passes `'debate'` hint for the debate critic seats

**Changed files:**
| File | Change |
|------|--------|
| `src/orchestrator/engine-selector.ts` | `RoleHint` type + `select()` param + preference logic |

**Test files:** `tests/orchestrator/engine-selector.test.ts` (new cases
alongside existing).

### W4.3 — WorkerLifecycle cleanup hook registry

**Exit criteria:**
- `onCleanup(hook)` registers a hook and returns an unsubscribe function
- Hooks fire on demote and retire transitions, not on re-enrollment
- A thrown hook does not block the transition (fail-safe hygiene)
- Zero hooks by default — registry is a seam, not a concrete wiring

**Changed files:**
| File | Change |
|------|--------|
| `src/orchestrator/fleet/worker-lifecycle.ts` | `cleanupHooks` array + `onCleanup()` + `runCleanupHooks()` + calls in demote/retire paths |

**Test files:** `tests/orchestrator/worker-lifecycle.test.ts` (new cases).

### W4.4 — Implementation Team preset (DEFERRED to Wave 5)

Phase A §8.4 captures the three unresolved sub-questions
(disjoint-seam heuristic, role assignment, integration node). Until
one of those is answered with a concrete rule, W4.4 stays as
documentation rather than code.

---

## 6. Wave 5 Backlog — unresolved book items

> These items either need more design work, come from chapters that
> specifically called out "unsolved" problems, or require primitives
> Vinyan doesn't have today.
>
> **Status update (2026-04-15, phase 2):** 5 of 9 items shipped + 1 more
> partial (debate cost cap gets per-task implementation; per-day still
> future). **2 of 3 Phase A §7 seams closed** (seam #1 in phase 1,
> seam #2 in phase 2). The remaining 3 backlog items + 1 seam are
> blocked on larger design questions.

1. **W4.4 Implementation Team preset** — Ch07 + Ch12. **Still deferred.**
   Needs a deterministic disjoint-seam heuristic (directory-based?
   dependency-cone-cluster-based?), role-to-subagent mapping, and an
   integration node design that plays with the existing DAG executor.
   Per analysis in the Wave 5 partial commit: the book's faithful pattern
   requires worktree isolation (which Vinyan rejected per W3.2), and the
   simpler "disjoint partition by directory" version is already covered
   by `ConcurrentDispatcher + DagExecutor`.
2. **`ScheduleWakeup` primitive** — Ch09. **Still deferred.** Requires
   session persistence / resumption work that doesn't currently exist
   in Vinyan's turn-based agent-loop model. Would be a net-new
   subsystem.
3. **Fleet-live overview view** — Ch13. **Still deferred.** Needs
   orchestrator state threaded into the CLI `showOverview` path —
   achievable but non-trivial because `showOverview` currently runs
   without an orchestrator instance.
4. **Research Swarm Wave-2 follow-up** — Ch05. **Still deferred.**
   Gap identification requires an LLM call in the coordination path,
   which conflicts with A3 (deterministic governance). A rule-based
   alternative would require a gap-detection heuristic we don't have.
5. **CriticEngine context object** — ✅ **SHIPPED as W5.1** in the
   Wave 5 partial commit. `CriticEngine.review()` now accepts an
   optional `context?: CriticContext` argument carrying `riskScore`
   and `routingLevel`. `core-loop.ts` passes the context instead of
   mutating the task; `DebateRouterCritic` reads `context.riskScore`
   directly. Both `as unknown as { riskScore? }` casts removed.
6. **Bus event typed registry** — **Still deferred.** Touches every
   `VinyanBusEvents` declaration and risks breaking a large surface
   of consumers for a refactor, not a feature.
7. **Debate cost cap at Economy OS layer** — ✅ **FULLY SHIPPED**
   across phase 2 (W5.7a per-task) and phase 3 (W5.7b per-day).
   `DebateBudgetGuard` now enforces **both** caps: per-task-id counter
   (default `maxPerTask: 1`) and a rolling per-day counter
   (`maxPerDay`, default undefined = unbounded). Denied debates emit
   `critic:debate_denied` with a reason string that distinguishes
   per-task from per-day denial. The `whyDenied()` helper is exposed
   on the guard for callers that want to discriminate without
   duplicating the rule. Day counter resets at midnight UTC via
   `pruneStaleFires`. Note: this is a guard-local implementation,
   not a CostLedger-based daily USD cap — operators that want
   USD-denominated limits should subscribe to `critic:debate_fired`
   from the Economy OS layer and wire the cap there.
8. **Sentinel config on `SleepCycleRunner` constructor** — ✅ **SHIPPED
   as W5.4** in the Wave 5 partial commit. `SleepCycleRunner`
   constructor now accepts an optional `sentinelMaxNoopCycles`
   parameter (default 5), letting tests exercise shorter windows.
9. **`TerminationSentinel` reusable class** — **Still deferred.** YAGNI
   until a second subsystem needs the same "dormant after N no-ops"
   pattern.

---

## 7. Wave 5 partial — file tables

### W5.1 — CriticEngine context object

| File | Change |
|------|--------|
| `src/orchestrator/critic/critic-engine.ts` | `CriticContext` type + extended `review()` signature |
| `src/orchestrator/critic/llm-critic-impl.ts` | Accept-and-ignore `context` (baseline doesn't need it) |
| `src/orchestrator/critic/debate-mode.ts` | `ArchitectureDebateCritic.review()` extended; `DebateRouterCritic.review()` reads `context.riskScore` (cast removed) |
| `src/orchestrator/core-loop.ts` | Pass `{ riskScore, routingLevel }` explicitly; mutation removed |
| `src/core/bus.ts` | `critic:debate_fired` event declaration |
| `src/orchestrator/factory.ts` | Thread `bus` to `DebateRouterCritic` constructor |

Tests: `tests/orchestrator/critic/debate-mode.test.ts` — updated risk-triggered test to use `CriticContext`; 4 new `critic:debate_fired` observability cases.

### W5.4 — Sentinel constructor option

| File | Change |
|------|--------|
| `src/sleep-cycle/sleep-cycle.ts` | `sentinelMaxNoopCycles` as optional constructor parameter |

Tests: `tests/sleep-cycle/termination-sentinel.test.ts` — 2 new cases (custom value trips faster; default is preserved).

## 7a. Wave 5 phase 2 — file tables

### W5.7a — Per-task Debate Budget Guard

| File | Change |
|------|--------|
| `src/orchestrator/critic/debate-budget-guard.ts` | **NEW** — `DebateBudgetGuard` class with `shouldAllow` / `recordFired` / `recordDenied` / `clearTask` |
| `src/orchestrator/critic/debate-mode.ts` | `DebateRouterCritic` accepts `budgetGuard` in options; consults `shouldAllow` before firing; records fire + denied paths |
| `src/core/bus.ts` | New `critic:debate_denied` event (payload: taskId, reason, maxPerTask, count) |
| `src/orchestrator/factory.ts` | Wires a default `DebateBudgetGuard({ maxPerTask: 1 })` into the debate critic; `OrchestratorConfig.debateMaxPerTask` overrides |

Tests:
- `tests/orchestrator/critic/debate-budget-guard.test.ts` — **NEW** (9 cases covering core semantics + bus observability)
- `tests/orchestrator/critic/debate-mode.test.ts` — 5 new integration cases (guard consult, denied event, baseline-path untouched, maxPerTask=0, task-id isolation)

### W5.2 — TaskDAG.preamble + centralized merge (seam #2 closure)

| File | Change |
|------|--------|
| `src/orchestrator/types.ts` | `TaskDAG.preamble?: string[]` field |
| `src/orchestrator/task-decomposer-presets.ts` | `buildResearchSwarmDAG` emits `preamble: [RESEARCH_SWARM_REPORT_CONTRACT]` on the DAG |
| `src/orchestrator/task-decomposer.ts` | Preset path NO LONGER mutates `input.constraints` (seam #2) |
| `src/orchestrator/phases/types.ts` | `PlanResult.enhancedInput?: TaskInput` field |
| `src/orchestrator/phases/phase-plan.ts` | Builds `enhancedInput` as a shallow clone with merged constraints when `plan.preamble?.length > 0` |
| `src/orchestrator/core-loop.ts` | `const ctx` → `let ctx`; swaps `ctx.input` to `enhancedInput` after plan phase so subsequent phases see the merged constraints. The caller's original input is never mutated. |
| `src/orchestrator/worker/agent-loop.ts` | Before sending the init turn, merges `plan.preamble` into `understanding.constraints` locally so the worker's prompt assembler renders the Constraints block with the report contract included. |

Tests:
- `tests/orchestrator/phases/phase-plan.test.ts` — **NEW** (4 cases: preamble → enhancedInput; no preamble → no enhancedInput; empty preamble → no enhancedInput; append order preserved)
- `tests/orchestrator/task-decomposer.test.ts` — 1 new case: caller input is NOT mutated after preset fires
- `tests/orchestrator/task-decomposer-presets.test.ts` — 1 new case: DAG carries preamble with the report contract

**Why this matters more than the previous cleanup:**
The previous research-swarm preset mutated `input.constraints` inside the decomposer. The mutation was (a) surprising to callers, (b) failed the "no caller mutation" convention, AND (c) did NOT actually reach the worker's prompt because `understanding.constraints` was pre-computed in `prepareExecution()` BEFORE the decomposer ran. So the old mutation was a decorative no-op with respect to the worker.

Wave 5.2 fixes **both** the mutation AND the decorative no-op:
1. The decomposer no longer mutates — caller's input is clean
2. The preamble is threaded onto the DAG (`plan.preamble`)
3. Phase-plan materializes an `enhancedInput` that subsequent phases see via ctx swap
4. Agent-loop merges `plan.preamble` into the init turn's `understanding.constraints` just before sending to the worker, so the worker's prompt assembler actually renders the report contract

This is the first time the research-swarm preset's REPORT_CONTRACT genuinely reaches the LLM's system prompt.

## 7b. Wave 5 phase 3 — file tables

### W5.7b — Per-day `DebateBudgetGuard` cap

| File | Change |
|------|--------|
| `src/orchestrator/critic/debate-budget-guard.ts` | Extended with `maxPerDay`, injectable `now`, rolling `fires` timestamp array, `pruneStaleFires`, `whyDenied(taskId)` helper, `getDayCount()` test helper |
| `src/orchestrator/critic/debate-mode.ts` | `DebateRouterCritic` uses `guard.whyDenied()` to build a precise deny reason string (`per-task debate cap reached` vs `per-day debate cap reached`) |
| `src/orchestrator/factory.ts` | `OrchestratorConfig.debateMaxPerDay` plumbed into `DebateBudgetGuard` options |

Tests:
- `tests/orchestrator/critic/debate-budget-guard.test.ts` — 8 new cases: `maxPerDay` undefined behavior, cap caps total fires across tasks, `maxPerDay=0` denies always, day rollover via injected clock, `getDayCount` prunes stale, `whyDenied` discriminator (per-task vs per-day vs null), negative clamp.
- `tests/orchestrator/critic/debate-mode.test.ts` — 2 new router integration cases: denies once per-day cap saturates; `critic:debate_denied` reason string discriminates per-task vs per-day.

### W5.11 — `vinyan tui costs` command

| File | Change |
|------|--------|
| `src/tui/views/costs.ts` | **NEW** — `showCosts(config)` reads the workspace `.vinyan/vinyan.db` read-only, hydrates a `CostLedger`, prints hour/day/month aggregates + top 5 engines by all-time USD spend. Graceful fallback when DB or table is missing. |
| `src/tui/commands.ts` | New `costs` subcommand in `processTUICommand` + help text |

Tests:
- `tests/tui/costs.test.ts` — **NEW** 4 cases: empty ledger → "no data" notice; multi-engine render shows counts + totals; top-engines list is sorted by USD descending; missing DB prints friendly "no ledger" notice.

**Design notes for W5.11:**

- **No orchestrator instantiation.** The view opens the DB directly in
  read-only mode and constructs a transient `CostLedger` from the
  warm cache. This is several seconds faster than going through
  `createOrchestratorAsync` for a one-shot status view.
- **Graceful degradation.** If the DB file doesn't exist (fresh
  workspace), the view prints a friendly notice and exits 0. If the
  DB exists but the `cost_ledger` table is missing (older migration),
  `CostLedger.warmCache` swallows the exception and the view renders
  the "no data recorded yet" path.
- **Injectable `ledger` option.** The view accepts an optional
  pre-built `CostLedger` for tests and future integration with a
  live orchestrator handle. Prod CLI path uses the DB-open variant.

---

## 8. Legacy follow-ups (pre-Wave-4 → all promoted to Wave 5)

These predate the Wave 4 deep-read. Each was promoted to the Wave 5
backlog in §6 and the status below reflects the *current* state, not
the pre-Wave-4 state.

| Legacy # | Item | Wave 5 backlog # | Status |
|---|---|---|---|
| 1 | CriticEngine interface extension — replace `task.riskScore` cast with a context object | #5 | ✅ **Shipped** in phase 1 (W5.1) |
| 2 | Bus event typed registry — generate peek's `TASK_EVENTS` from the bus declarations | #6 | ⏸ Deferred (wide refactor; no second consumer) |
| 3 | Debate cost cap | #7 | ✅ **Shipped** — per-task (W5.7a phase 2) + per-day (W5.7b phase 3) |
| 4 | Sentinel config constructor option — expose `sentinelMaxNoopCycles` | #8 | ✅ **Shipped** in phase 1 (W5.4) |
| 5 | TerminationSentinel reusable class extraction | #9 | ⏸ Deferred (YAGNI — no second consumer) |

> **Tally (post-merge 2026-04-15):** 3 of 5 legacy items shipped; 2
> remain on the deferred-with-documented-rationale list. Phase A §7
> "known short-term seams" — **all 3 closed** (seam #3 "peek event
> whitelist drift" closed via a static regression test at
> `tests/tui/peek-whitelist-coverage.test.ts` that scans bus.ts for
> task-bearing events and asserts each is either in peek's
> `TASK_EVENTS` or in a documented `KNOWN_EXCLUSIONS` set, forcing an
> explicit decision at CI time).
