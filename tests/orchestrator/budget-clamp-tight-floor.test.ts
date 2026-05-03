/**
 * Regression: tight-budget floor protection.
 *
 * The wall-clock clamp must never produce a worker `latencyBudgetMs`
 * below `WALL_CLOCK_FLOOR_MS` (1000ms). A near-exhausted budget should
 * either (a) be intercepted by the upstream refuse-to-start check in
 * `core-loop.ts` (when remaining ≤ WALL_CLOCK_SAFETY_MS), or (b) reach
 * the dispatch site with at least the floor budget so the worker has
 * enough wall-clock to receive a single streaming token before its own
 * timeout fires.
 *
 * Existing tests use budgets as small as 5_000ms; this test pins the
 * boundary so a future change to the safety/floor constants doesn't
 * silently regress them.
 */
import { describe, expect, test } from 'bun:test';
import { clampRoutingToWallClock, WALL_CLOCK_FLOOR_MS } from '../../src/orchestrator/budget-clamp.ts';
import type { RoutingDecision } from '../../src/orchestrator/types.ts';

function makeRouting(latencyBudgetMs: number): RoutingDecision {
  return { level: 2, model: 'mock/m', budgetTokens: 10_000, latencyBudgetMs };
}

describe('clampRoutingToWallClock — tight-budget floor', () => {
  test('5_000ms budget at start-of-attempt yields ≥ floor for the worker', () => {
    // Mirrors `tests/orchestrator/core-loop-budget-degrade.test.ts` which
    // executes tasks at maxDurationMs=5_000. Without the floor those tests
    // would dispatch a worker with ~4_750ms budget; with the floor they
    // still get the full usable amount.
    const out = clampRoutingToWallClock({
      routing: makeRouting(60_000),
      startTime: 1_000,
      maxDurationMs: 5_000,
      now: () => 1_000,
    });
    // remaining=5000, usable=4750 → clamp to max(1000, 4750)=4750
    expect(out.latencyBudgetMs).toBe(4_750);
    expect(out.latencyBudgetMs).toBeGreaterThanOrEqual(WALL_CLOCK_FLOOR_MS);
  });

  test('budget near-exhausted (3_900ms elapsed of 5_000ms) still gets the floor', () => {
    // When the per-attempt usable amount drops below the floor, the floor
    // wins — ensures the worker isn't handed a sub-second deadline that
    // would mis-report as a subprocess timeout.
    const out = clampRoutingToWallClock({
      routing: makeRouting(60_000),
      startTime: 0,
      maxDurationMs: 5_000,
      now: () => 4_900, // remaining=100, usable=-150
    });
    expect(out.latencyBudgetMs).toBe(WALL_CLOCK_FLOOR_MS);
  });

  test('mid-budget (1_000ms remaining of 5_000ms) clamps to remaining-safety, not floor', () => {
    // 5000-4000=1000 remaining, 1000-250=750 usable < floor → floor wins.
    const out = clampRoutingToWallClock({
      routing: makeRouting(60_000),
      startTime: 0,
      maxDurationMs: 5_000,
      now: () => 4_000,
    });
    // usable=750 < 1000=floor → 1000.
    expect(out.latencyBudgetMs).toBe(WALL_CLOCK_FLOOR_MS);
  });

  test('1_500ms remaining of 5_000ms yields 1_250ms (above floor)', () => {
    const out = clampRoutingToWallClock({
      routing: makeRouting(60_000),
      startTime: 0,
      maxDurationMs: 5_000,
      now: () => 3_500,
    });
    // usable=1250 > 1000 → 1250
    expect(out.latencyBudgetMs).toBe(1_250);
  });
});
