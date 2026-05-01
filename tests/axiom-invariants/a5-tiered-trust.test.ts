/**
 * A5 — Tiered Trust invariant.
 *
 * Confidence is clamped to per-tier ceilings; tier rank determines
 * conflict resolution; promotion is rule-based (never silent upward).
 */
import { describe, expect, test } from 'bun:test';
import {
  clampConfidenceToTier,
  CONFIDENCE_TIERS,
  isStrongerThan,
  rankOf,
  TIER_CONFIDENCE_CEILING,
  TIER_WEIGHT,
  weakerOf,
} from '../../src/core/confidence-tier.ts';

describe('A5 — Tiered Trust', () => {
  test('clamping caps confidence at the tier ceiling', () => {
    expect(clampConfidenceToTier(0.99, 'speculative')).toBe(0.6);
    expect(clampConfidenceToTier(0.99, 'probabilistic')).toBe(0.85);
    expect(clampConfidenceToTier(0.99, 'pragmatic')).toBe(0.7);
    expect(clampConfidenceToTier(0.99, 'heuristic')).toBe(0.95);
    expect(clampConfidenceToTier(0.99, 'deterministic')).toBe(0.99);
  });

  test('clamping never raises confidence (only ever lowers or leaves)', () => {
    for (const tier of CONFIDENCE_TIERS) {
      const clamped = clampConfidenceToTier(0.5, tier);
      expect(clamped).toBeLessThanOrEqual(0.5 + 1e-9);
    }
  });

  test('clamping rejects negatives', () => {
    expect(clampConfidenceToTier(-0.5, 'heuristic')).toBe(0);
  });

  test('rank ordering: deterministic > heuristic > pragmatic > probabilistic > speculative', () => {
    expect(rankOf('deterministic')).toBeGreaterThan(rankOf('heuristic'));
    expect(rankOf('heuristic')).toBeGreaterThan(rankOf('pragmatic'));
    expect(rankOf('pragmatic')).toBeGreaterThan(rankOf('probabilistic'));
    expect(rankOf('probabilistic')).toBeGreaterThan(rankOf('speculative'));
  });

  test('isStrongerThan agrees with rank order', () => {
    expect(isStrongerThan('deterministic', 'heuristic')).toBe(true);
    expect(isStrongerThan('speculative', 'deterministic')).toBe(false);
  });

  test('weakerOf returns the lower-rank tier', () => {
    expect(weakerOf('deterministic', 'heuristic')).toBe('heuristic');
    expect(weakerOf('speculative', 'probabilistic')).toBe('speculative');
  });

  test('TIER_WEIGHT and TIER_CONFIDENCE_CEILING cover every tier', () => {
    for (const tier of CONFIDENCE_TIERS) {
      expect(TIER_WEIGHT[tier]).toBeGreaterThan(0);
      expect(TIER_CONFIDENCE_CEILING[tier]).toBeGreaterThan(0);
    }
  });
});
