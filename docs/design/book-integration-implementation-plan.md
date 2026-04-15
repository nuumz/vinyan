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

---

## 5. Known follow-ups

These are not part of the book-integration scope but are worth tracking.

1. **CriticEngine interface extension** — replace the `task.riskScore`
   ad-hoc cast with a proper context object. Also makes debate-mode
   testable without `as unknown as` gymnastics.
2. **Bus event typed registry** — make peek's `TASK_EVENTS` whitelist
   generate itself from bus event declarations that include a `taskId`.
3. **Debate cost cap** — per-day budget guard for architecture debates
   at the Economy OS layer. Overview §8 Q2.
4. **Sentinel config on `SleepCycleRunner` constructor** — currently the
   max-noop-cycles threshold is a class constant. Making it a
   constructor option would let tests exercise shorter windows directly
   instead of running five full cycles.
5. **TerminationSentinel extraction** — once a second subsystem needs
   the same "dormant after N no-ops" pattern, extract the counter +
   reset logic into a reusable `TerminationSentinel` class.
