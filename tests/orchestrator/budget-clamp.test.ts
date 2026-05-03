/**
 * Unit tests for `clampRoutingToWallClock` + `formatTimeoutMessage`.
 *
 * Pure-function level — no orchestrator wiring. The integration test
 * `budget-clamp-at-dispatch.test.ts` proves the clamp is actually
 * applied at the `worker:dispatch` emit site.
 */
import { describe, expect, test } from 'bun:test';
import {
  clampRoutingToWallClock,
  formatTimeoutMessage,
  WALL_CLOCK_FLOOR_MS,
  WALL_CLOCK_SAFETY_MS,
} from '../../src/orchestrator/budget-clamp.ts';
import type { RoutingDecision } from '../../src/orchestrator/types.ts';

function makeRouting(latencyBudgetMs: number): RoutingDecision {
  return { level: 2, model: 'mock/m', budgetTokens: 10_000, latencyBudgetMs };
}

describe('clampRoutingToWallClock', () => {
  test('returns input unchanged when latencyBudgetMs already fits remaining wall-clock', () => {
    const routing = makeRouting(5_000);
    const out = clampRoutingToWallClock({
      routing,
      startTime: 1_000,
      maxDurationMs: 30_000,
      now: () => 2_000, // elapsed=1000, remaining=29000, usable=28750
    });
    expect(out).toBe(routing); // identity preserved
    expect(out.latencyBudgetMs).toBe(5_000);
  });

  test('clamps latencyBudgetMs to remaining-safety when worker budget overruns', () => {
    // Reproduces architect-r1: 60s budget, 44.3s elapsed at dispatch,
    // routing.latencyBudgetMs=59_739ms. Should clamp to ~15_428ms.
    const out = clampRoutingToWallClock({
      routing: makeRouting(59_739),
      startTime: 1_777_802_481_152,
      maxDurationMs: 60_000,
      now: () => 1_777_802_525_474, // architect-r1's actual dispatch ts
    });
    // remaining = 60000 - 44322 = 15678; usable = 15678 - 250 = 15428
    expect(out.latencyBudgetMs).toBe(15_428);
  });

  test('honors floor when remaining budget would clamp below it', () => {
    const routing = makeRouting(60_000);
    const out = clampRoutingToWallClock({
      routing,
      startTime: 1_000,
      maxDurationMs: 5_000,
      now: () => 5_900, // elapsed=4900, remaining=100, usable=-150
    });
    expect(out.latencyBudgetMs).toBe(WALL_CLOCK_FLOOR_MS); // not zero, not negative
    expect(out).not.toBe(routing); // shallow clone
  });

  test('returns shallow clone — does NOT mutate the input routing', () => {
    const routing = makeRouting(60_000);
    const out = clampRoutingToWallClock({
      routing,
      startTime: 0,
      maxDurationMs: 1_000,
      now: () => 100,
    });
    expect(out).not.toBe(routing);
    expect(routing.latencyBudgetMs).toBe(60_000); // input untouched
  });

  test('safety/floor overrides expose the same defaults the constants advertise', () => {
    // Sanity that the exported constants are wired through.
    const routing = makeRouting(2_000);
    const fitting = clampRoutingToWallClock({
      routing,
      startTime: 0,
      maxDurationMs: 3_000,
      now: () => 0, // elapsed=0, remaining=3000, usable=3000-WALL_CLOCK_SAFETY_MS
    });
    // 2000 ≤ 3000-250=2750 → no clamp
    expect(fitting.latencyBudgetMs).toBe(2_000);

    const clamped = clampRoutingToWallClock({
      routing: makeRouting(3_000),
      startTime: 0,
      maxDurationMs: 3_000,
      now: () => 0,
    });
    // 3000 > 2750 → clamp to max(1000, 2750) = 2750
    expect(clamped.latencyBudgetMs).toBe(3_000 - WALL_CLOCK_SAFETY_MS);
  });
});

describe('formatTimeoutMessage', () => {
  test('honest copy when overshoot occurred — names overage explicitly', () => {
    // Mirrors architect-r1: elapsed=104s, budget=60s, level=2.
    const msg = formatTimeoutMessage({ elapsedMs: 104_089, budgetMs: 60_000, routingLevel: 2 });
    expect(msg).toBe(
      'Task timed out after 104s — exceeded budget 60s by 44s at routing level L2.' +
        ' Try narrowing the request, or raise --max-duration if the task legitimately needs more time.',
    );
  });

  test('legacy "(budget: Ys)" copy when no overshoot — within-budget timeout', () => {
    const msg = formatTimeoutMessage({ elapsedMs: 5_900, budgetMs: 6_000, routingLevel: 1 });
    expect(msg).toBe(
      'Task timed out after 6s (budget: 6s) at routing level L1.' +
        ' Try narrowing the request, or raise --max-duration if the task legitimately needs more time.',
    );
  });

  test('appends diagnostics line when supplied', () => {
    const msg = formatTimeoutMessage({
      elapsedMs: 104_089,
      budgetMs: 60_000,
      routingLevel: 2,
      diagnostics: 'stage: plan:ready; last phase: plan (12s); plan 0/4',
    });
    expect(msg).toContain(' Last activity — stage: plan:ready; last phase: plan (12s); plan 0/4.');
  });
});
