/**
 * Tests for FamilyStatsTracker — Phase-8 producer for per-family auction stats.
 *
 * Covers:
 *   - empty window → zero stats
 *   - single auction → 100% global dominance, 100% family dominance
 *   - global vs per-family rates diverge correctly
 *   - window rolls over at windowSize boundary
 *   - default UNKNOWN_FAMILY when caller omits family
 *   - reset clears state
 */
import { describe, expect, test } from 'bun:test';
import {
  DEFAULT_WINDOW_SIZE,
  FamilyStatsTracker,
  UNKNOWN_FAMILY,
} from '../../../src/economy/market/family-stats-tracker.ts';

describe('FamilyStatsTracker', () => {
  test('empty window → zero stats', () => {
    const t = new FamilyStatsTracker();
    const stats = t.getStats();
    expect(stats.auctionCount).toBe(0);
    expect(stats.dominantWinRate).toBe(0);
    expect(stats.auctionsByFamily).toEqual({});
    expect(stats.dominantWinRateByFamily).toEqual({});
  });

  test('single auction → 100% global + family dominance', () => {
    const t = new FamilyStatsTracker();
    t.addAuction('provider-a', 'code');
    const stats = t.getStats();
    expect(stats.auctionCount).toBe(1);
    expect(stats.dominantWinRate).toBe(1);
    expect(stats.auctionsByFamily).toEqual({ code: 1 });
    expect(stats.dominantWinRateByFamily).toEqual({ code: 1 });
  });

  test('balanced global, per-family dominant — H6 expected scenario', () => {
    // Developer wins ALL code tasks, Author wins ALL writing tasks.
    // Global dominant rate is 50% (each provider wins half), but
    // per-family dominance is 100% — exactly the H6 case the regression
    // rule must NOT mistake for market degeneracy.
    const t = new FamilyStatsTracker();
    for (let i = 0; i < 5; i++) t.addAuction('developer', 'code');
    for (let i = 0; i < 5; i++) t.addAuction('author', 'writing');
    const stats = t.getStats();
    expect(stats.auctionCount).toBe(10);
    expect(stats.dominantWinRate).toBe(0.5);
    expect(stats.auctionsByFamily).toEqual({ code: 5, writing: 5 });
    expect(stats.dominantWinRateByFamily).toEqual({ code: 1, writing: 1 });
  });

  test('window rolls over at windowSize boundary', () => {
    const t = new FamilyStatsTracker(3);
    t.addAuction('a', 'f');
    t.addAuction('b', 'f');
    t.addAuction('c', 'f');
    t.addAuction('d', 'f'); // pushes 'a' out
    const stats = t.getStats();
    expect(stats.auctionCount).toBe(3);
    // a evicted: window is [b, c, d] → 33% each, so dominantWinRate is 1/3
    expect(stats.dominantWinRate).toBeCloseTo(1 / 3, 3);
  });

  test('UNKNOWN_FAMILY fills when caller omits family', () => {
    const t = new FamilyStatsTracker();
    t.addAuction('provider-a');
    t.addAuction('provider-a');
    const stats = t.getStats();
    expect(stats.auctionsByFamily[UNKNOWN_FAMILY]).toBe(2);
    expect(stats.dominantWinRateByFamily[UNKNOWN_FAMILY]).toBe(1);
  });

  test('reset clears window', () => {
    const t = new FamilyStatsTracker();
    t.addAuction('a', 'f');
    t.addAuction('b', 'f');
    t.reset();
    expect(t.getStats().auctionCount).toBe(0);
  });

  test('default window size is the regression-rule trigger threshold', () => {
    // H6 regression rule fires at `auctionCount >= 50` — the default window
    // should match so a freshly-filled window IS the trigger, not a stale
    // post-fact view.
    expect(DEFAULT_WINDOW_SIZE).toBe(50);
  });

  test('mixed within-family + cross-family pattern', () => {
    // dev wins 4 code, author wins 1 code, author wins 5 writing
    // global: dev=4, author=6 → dominant 60%
    // code:   dev=4 (out of 5) → 80%
    // writing:author=5 (out of 5) → 100%
    const t = new FamilyStatsTracker();
    for (let i = 0; i < 4; i++) t.addAuction('developer', 'code');
    t.addAuction('author', 'code');
    for (let i = 0; i < 5; i++) t.addAuction('author', 'writing');
    const stats = t.getStats();
    expect(stats.dominantWinRate).toBe(0.6);
    expect(stats.dominantWinRateByFamily.code).toBe(0.8);
    expect(stats.dominantWinRateByFamily.writing).toBe(1);
  });

  test('throws on invalid window size', () => {
    expect(() => new FamilyStatsTracker(0)).toThrow(/positive/);
    expect(() => new FamilyStatsTracker(-5)).toThrow(/positive/);
    expect(() => new FamilyStatsTracker(Number.NaN)).toThrow(/positive/);
  });
});
