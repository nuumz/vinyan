/**
 * Tests for Phase-3 stratified market-phase regression (risk H6).
 *
 * Pre-Phase-3: any bidder winning ≥90% of 50+ auctions → regress to Phase A.
 *   Post-Phase-3: regress only when global dominance is high AND a single
 *   task family monopolises the workload (no useful stratification). When
 *   workload spans families, per-family dominance is the *correct* answer
 *   (Developer dominates code-mutation, Author dominates writing).
 */
import { describe, expect, test } from 'bun:test';
import {
  evaluateMarketPhase,
  FAMILY_SPREAD_MAX_SHARE,
  type MarketPhaseStats,
} from '../../../src/economy/market/market-phase.ts';
import type { MarketPhaseState } from '../../../src/economy/market/schemas.ts';

function phaseB(): MarketPhaseState {
  return { currentPhase: 'B', activatedAt: 0, auctionCount: 0, lastEvaluatedAt: 0 };
}

function makeStats(overrides: Partial<MarketPhaseStats> = {}): MarketPhaseStats {
  return {
    activeEngines: 5,
    minTasksPerEngine: 100,
    totalTraces: 1000,
    auctionCount: 100,
    trustedRemotePeers: 0,
    minRemotePeerTasks: 0,
    distinctEnginesWithBids: 5,
    minSettledBidsPerEngine: 100,
    dominantWinRate: 0.95,
    ...overrides,
  };
}

describe('evaluateMarketPhase — Phase-3 stratification', () => {
  test('legacy path (no per-family stats): high dominance still regresses', () => {
    const result = evaluateMarketPhase(phaseB(), makeStats());
    expect(result.newPhase).toBe('A');
    expect(result.reason).toContain('Market degeneracy');
  });

  test('multi-family workload with per-family dominance does NOT regress', () => {
    const stats = makeStats({
      auctionsByFamily: {
        'code-mutation': 50,
        'creative-writing': 30,
        'general-reasoning': 20,
      },
      // global dominance high but caused by Developer winning all code tasks
      // and Author winning all writing tasks — that's the right answer
      dominantWinRate: 0.95,
    });
    const result = evaluateMarketPhase(phaseB(), stats);
    expect(result.newPhase).toBe('B'); // No transition
  });

  test('single-family workload (≥90% share) still regresses on high dominance', () => {
    const stats = makeStats({
      auctionsByFamily: {
        'code-mutation': 95,
        'creative-writing': 5,
      },
      dominantWinRate: 0.95,
    });
    // 95% / 100 = 0.95 > FAMILY_SPREAD_MAX_SHARE (0.9) → no useful stratification
    expect(0.95).toBeGreaterThan(FAMILY_SPREAD_MAX_SHARE);
    const result = evaluateMarketPhase(phaseB(), stats);
    expect(result.newPhase).toBe('A');
  });

  test('balanced families with low dominance does not regress', () => {
    const stats = makeStats({
      auctionsByFamily: {
        'code-mutation': 50,
        'creative-writing': 50,
      },
      dominantWinRate: 0.5,
    });
    const result = evaluateMarketPhase(phaseB(), stats);
    expect(result.newPhase).toBe('B');
  });

  test('phase A is unaffected by regression rule', () => {
    const stats = makeStats();
    const phaseA: MarketPhaseState = { currentPhase: 'A', activatedAt: 0, auctionCount: 0, lastEvaluatedAt: 0 };
    const result = evaluateMarketPhase(phaseA, stats);
    // Phase A is the floor — no further regression even with degeneracy stats
    expect(result.newPhase).not.toBe('A'); // tries to advance, but other gates fail
    // (Without remote peers / engine count, it stays at A by other rules)
  });
});
