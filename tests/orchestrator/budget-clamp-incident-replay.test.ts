/**
 * Incident replay — `b80c5c0d-3f0e-4f29-9d94-3a88b6b4f052` (architect-r1
 * sub-agent timed out 44s past its 60s budget; the chat UI then surfaced
 * the sub-agent failure as the parent's "Failed" banner).
 *
 * Drives the dispatch-time clamp helper with the actual recorded ts
 * values from the operator's `.vinyan/vinyan.db` (captured into
 * `tests/fixtures/incidents/b80c5c0d-architect-r1-timeline.ts`) and
 * proves three things:
 *
 *   1. The pre-fix dispatch payload (`latencyBudgetMs=59_739` at sub-task
 *      elapsed=44_322ms) was the bypass — the worker subprocess got
 *      essentially the full task budget at the moment when only 15s
 *      remained.
 *
 *   2. The dispatch-site clamp (`clampRoutingToWallClock` invoked from
 *      `phase-generate.ts` after the fix) would have produced
 *      `latencyBudgetMs=15_428` — capping the worker so its subprocess
 *      timeout would fire at sub-task elapsed ≈ 59_750ms (within the
 *      60_000ms budget).
 *
 *   3. With the architect-r1 sub-task timing out cleanly inside its
 *      budget, the parent task still has ≥ 56s of wall-clock left when
 *      the sub-agent batch settles — far more than the 10.8s the
 *      coordinator step actually consumed. So the coordinator step
 *      dispatches and `task:complete` lands as it did in production —
 *      but without leaving a misleading sub-agent timeout artifact in
 *      the merged event tree.
 */
import { describe, expect, test } from 'bun:test';
import { clampRoutingToWallClock, WALL_CLOCK_SAFETY_MS } from '../../src/orchestrator/budget-clamp.ts';
import type { RoutingDecision } from '../../src/orchestrator/types.ts';
import { architectR1Timeline, parentTaskTimeline } from '../fixtures/incidents/b80c5c0d-architect-r1-timeline.ts';

function makeRouting(latencyBudgetMs: number): RoutingDecision {
  return { level: 2, model: 'openrouter/balanced/google/gemma-4-31b-it:free', budgetTokens: 50_000, latencyBudgetMs };
}

describe('Incident replay — b80c5c0d architect-r1 budget bypass', () => {
  test('the recorded dispatch was the bypass (pre-fix latencyBudgetMs nearly equals the full sub-task budget)', () => {
    const subTaskElapsedAtDispatch = architectR1Timeline.dispatchAt - architectR1Timeline.startedAt;
    expect(subTaskElapsedAtDispatch).toBe(44_322);

    // Recorded dispatch payload: `latencyBudgetMs=59_739`. That is ~99.6%
    // of the full 60_000ms sub-task budget — i.e. the worker was given
    // the entire budget at the moment when only ~15s of wall-clock
    // actually remained. Pin this so a regression that re-introduces the
    // bypass surfaces here.
    expect(architectR1Timeline.dispatchedLatencyBudgetMs).toBeGreaterThanOrEqual(architectR1Timeline.budgetMs - 500);

    const subTaskElapsedAtTimeout = architectR1Timeline.timeoutEmittedAt - architectR1Timeline.startedAt;
    expect(subTaskElapsedAtTimeout).toBe(architectR1Timeline.timeoutElapsedMs);
    // The actual overshoot: timeout fired ~44s past budget.
    expect(subTaskElapsedAtTimeout - architectR1Timeline.budgetMs).toBeGreaterThanOrEqual(40_000);
  });

  test('post-fix dispatch-site clamp produces a worker budget that fits remaining wall-clock', () => {
    // Replay the dispatch moment: now() = recorded dispatch ts.
    const clamped = clampRoutingToWallClock({
      routing: makeRouting(architectR1Timeline.dispatchedLatencyBudgetMs),
      startTime: architectR1Timeline.startedAt,
      maxDurationMs: architectR1Timeline.budgetMs,
      now: () => architectR1Timeline.dispatchAt,
    });

    // remaining = 60000 - 44322 = 15678; usable = 15678 - 250 = 15428
    expect(clamped.latencyBudgetMs).toBe(15_428);

    // Hypothetical worker timeout = dispatch_ts + clamped_budget. With
    // the clamp, the subprocess returns within the sub-task's 60s budget
    // instead of 44s past it.
    const hypotheticalSubTaskTimeoutAt = architectR1Timeline.dispatchAt + clamped.latencyBudgetMs;
    const hypotheticalSubTaskElapsed = hypotheticalSubTaskTimeoutAt - architectR1Timeline.startedAt;
    expect(hypotheticalSubTaskElapsed).toBeLessThanOrEqual(architectR1Timeline.budgetMs);
    // And it leaves at least the safety margin to the budget boundary —
    // i.e. the watchdog would not have to retroactively report overage.
    expect(architectR1Timeline.budgetMs - hypotheticalSubTaskElapsed).toBeGreaterThanOrEqual(WALL_CLOCK_SAFETY_MS);
  });

  test('parent task retains enough wall-clock for the coordinator step after the architect sub-agent settles', () => {
    // Hypothetical end-of-sub-agent time once the clamp is in place.
    const clamped = clampRoutingToWallClock({
      routing: makeRouting(architectR1Timeline.dispatchedLatencyBudgetMs),
      startTime: architectR1Timeline.startedAt,
      maxDurationMs: architectR1Timeline.budgetMs,
      now: () => architectR1Timeline.dispatchAt,
    });
    const subAgentSettlesAt = architectR1Timeline.dispatchAt + clamped.latencyBudgetMs;

    // Parent's elapsed at that moment.
    const parentElapsedAtSubAgentSettle = subAgentSettlesAt - parentTaskTimeline.startedAt;
    const parentRemainingAtSubAgentSettle = parentTaskTimeline.budgetMs - parentElapsedAtSubAgentSettle;

    // Parent must have at least 30s left — comfortably above the 10.8s
    // the coordinator actually consumed in production
    // (`coordinatorCompletedAt - coordinatorStartedAt`).
    expect(parentRemainingAtSubAgentSettle).toBeGreaterThanOrEqual(30_000);

    const coordinatorActualDurationMs =
      parentTaskTimeline.coordinatorCompletedAt - parentTaskTimeline.coordinatorStartedAt;
    expect(coordinatorActualDurationMs).toBeLessThan(parentRemainingAtSubAgentSettle);
  });
});
