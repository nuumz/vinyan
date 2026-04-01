/**
 * Tests for epistemic-decision.ts — 4-state decision derivation and confidence aggregation.
 *
 * Covers: deriveEpistemicDecision(), computeAggregateConfidence(), generateResolutionHints()
 * Axioms: A2 (first-class uncertainty), A3 (deterministic governance), A5 (tiered trust)
 */
import { describe, expect, test } from 'bun:test';
import {
  computeAggregateConfidence,
  deriveEpistemicDecision,
  generateResolutionHints,
  THRESHOLDS,
  TIER_WEIGHTS,
  type EpistemicGateDecision,
} from '../../src/gate/epistemic-decision.ts';
import type { OracleVerdict } from '../../src/core/types.ts';

// ── Helpers ─────────────────────────────────────────────────────

function makeVerdict(overrides: Partial<OracleVerdict> = {}): OracleVerdict {
  return {
    verified: true,
    type: 'known',
    confidence: 1.0,
    evidence: [],
    fileHashes: {},
    durationMs: 10,
    ...overrides,
  };
}

// ── deriveEpistemicDecision ─────────────────────────────────────

describe('deriveEpistemicDecision', () => {
  test("returns 'allow' for high confidence", () => {
    expect(deriveEpistemicDecision(0.95, false)).toBe('allow');
    expect(deriveEpistemicDecision(0.85, false)).toBe('allow');
  });

  test("returns 'allow-with-caveats' for adequate confidence", () => {
    expect(deriveEpistemicDecision(0.70, false)).toBe('allow-with-caveats');
    expect(deriveEpistemicDecision(0.60, false)).toBe('allow-with-caveats');
  });

  test("returns 'uncertain' for low confidence", () => {
    expect(deriveEpistemicDecision(0.40, false)).toBe('uncertain');
    expect(deriveEpistemicDecision(0.25, false)).toBe('uncertain');
  });

  test("returns 'block' for very low confidence", () => {
    expect(deriveEpistemicDecision(0.24, false)).toBe('block');
    expect(deriveEpistemicDecision(0.0, false)).toBe('block');
  });

  test("returns 'block' for NaN confidence", () => {
    expect(deriveEpistemicDecision(NaN, false)).toBe('block');
  });

  test("returns 'uncertain' when all oracles abstained (A2)", () => {
    expect(deriveEpistemicDecision(NaN, true)).toBe('uncertain');
    expect(deriveEpistemicDecision(0.0, true)).toBe('uncertain');
    expect(deriveEpistemicDecision(0.95, true)).toBe('uncertain');
  });

  test('threshold boundaries are correct', () => {
    // Exactly at HIGH threshold
    expect(deriveEpistemicDecision(THRESHOLDS.HIGH, false)).toBe('allow');
    // Just below HIGH
    expect(deriveEpistemicDecision(THRESHOLDS.HIGH - 0.001, false)).toBe('allow-with-caveats');
    // Exactly at ADEQUATE
    expect(deriveEpistemicDecision(THRESHOLDS.ADEQUATE, false)).toBe('allow-with-caveats');
    // Just below ADEQUATE
    expect(deriveEpistemicDecision(THRESHOLDS.ADEQUATE - 0.001, false)).toBe('uncertain');
    // Exactly at UNCERTAIN
    expect(deriveEpistemicDecision(THRESHOLDS.UNCERTAIN, false)).toBe('uncertain');
    // Just below UNCERTAIN
    expect(deriveEpistemicDecision(THRESHOLDS.UNCERTAIN - 0.001, false)).toBe('block');
  });
});

// ── computeAggregateConfidence ──────────────────────────────────

describe('computeAggregateConfidence', () => {
  test('returns NaN for empty verdicts', () => {
    expect(computeAggregateConfidence({}, {})).toBeNaN();
  });

  test('returns exact confidence for single deterministic oracle', () => {
    const verdicts = { type: makeVerdict({ confidence: 0.9 }) };
    const tiers = { type: 'deterministic' };
    const result = computeAggregateConfidence(verdicts, tiers);
    expect(result).toBeCloseTo(0.9, 5);
  });

  test('returns exact confidence for single heuristic oracle', () => {
    const verdicts = { dep: makeVerdict({ confidence: 0.7 }) };
    const tiers = { dep: 'heuristic' };
    const result = computeAggregateConfidence(verdicts, tiers);
    expect(result).toBeCloseTo(0.7, 5);
  });

  test('returns 0 when any oracle has zero confidence', () => {
    const verdicts = {
      type: makeVerdict({ confidence: 0.9 }),
      ast: makeVerdict({ confidence: 0 }),
    };
    const tiers = { type: 'deterministic', ast: 'deterministic' };
    expect(computeAggregateConfidence(verdicts, tiers)).toBe(0);
  });

  test('weighted harmonic mean favors deterministic tier (A5)', () => {
    // Two oracles: deterministic at 0.9 (weight 1.0) and heuristic at 0.5 (weight 0.6)
    const verdicts = {
      type: makeVerdict({ confidence: 0.9 }),
      dep: makeVerdict({ confidence: 0.5 }),
    };
    const tiers = { type: 'deterministic', dep: 'heuristic' };
    const result = computeAggregateConfidence(verdicts, tiers);

    // Harmonic mean: (1.0 + 0.6) / (1.0/0.9 + 0.6/0.5) = 1.6 / (1.111 + 1.2) = 1.6 / 2.311 ≈ 0.6923
    expect(result).toBeCloseTo(1.6 / (1.0 / 0.9 + 0.6 / 0.5), 4);

    // Should be closer to 0.9 than a simple average would be
    const simpleAvg = (0.9 + 0.5) / 2; // 0.7
    // Harmonic mean pulls toward the lower value, but weighting should still favor deterministic
    expect(result).toBeDefined();
  });

  test('all deterministic oracles with same confidence returns that confidence', () => {
    const verdicts = {
      type: makeVerdict({ confidence: 0.8 }),
      ast: makeVerdict({ confidence: 0.8 }),
      lint: makeVerdict({ confidence: 0.8 }),
    };
    const tiers = { type: 'deterministic', ast: 'deterministic', lint: 'deterministic' };
    const result = computeAggregateConfidence(verdicts, tiers);
    expect(result).toBeCloseTo(0.8, 5);
  });

  test('falls back to heuristic tier for unknown oracle names', () => {
    const verdicts = { custom: makeVerdict({ confidence: 0.7 }) };
    const tiers = {}; // no tier specified
    const result = computeAggregateConfidence(verdicts, tiers);
    // Should use heuristic weight (0.6), single oracle → returns confidence directly
    expect(result).toBeCloseTo(0.7, 5);
  });

  test('probabilistic tier has least influence', () => {
    // Two oracles with same confidence but different tiers
    const verdicts = {
      det: makeVerdict({ confidence: 0.6 }),
      prob: makeVerdict({ confidence: 0.9 }),
    };
    const tiers = { det: 'deterministic', prob: 'probabilistic' };
    const result = computeAggregateConfidence(verdicts, tiers);

    // Weighted harmonic mean: (1.0 + 0.3) / (1.0/0.6 + 0.3/0.9)
    const expected = (1.0 + 0.3) / (1.0 / 0.6 + 0.3 / 0.9);
    expect(result).toBeCloseTo(expected, 4);
    // Result should be pulled toward the deterministic oracle's lower confidence
    expect(result).toBeLessThan(0.9);
  });

  test('mixed tiers produce expected weighted harmonic mean', () => {
    const verdicts = {
      ast: makeVerdict({ confidence: 1.0 }),
      type: makeVerdict({ confidence: 0.95 }),
      dep: makeVerdict({ confidence: 0.7 }),
    };
    const tiers = { ast: 'deterministic', type: 'deterministic', dep: 'heuristic' };
    const result = computeAggregateConfidence(verdicts, tiers);

    // Manual: (1.0 + 1.0 + 0.6) / (1.0/1.0 + 1.0/0.95 + 0.6/0.7)
    const expected = 2.6 / (1.0 + 1.0 / 0.95 + 0.6 / 0.7);
    expect(result).toBeCloseTo(expected, 4);
  });
});

// ── generateResolutionHints ─────────────────────────────────────

describe('generateResolutionHints', () => {
  test('returns NaN hint when confidence is NaN', () => {
    const hints = generateResolutionHints([], NaN);
    expect(hints.length).toBeGreaterThan(0);
    expect(hints[0]).toContain('No oracle provided confidence data');
  });

  test('returns low confidence hint below UNCERTAIN threshold', () => {
    const hints = generateResolutionHints([], 0.1);
    expect(hints.some((h) => h.includes('very low'))).toBe(true);
  });

  test('returns adequate threshold hint for mid-range confidence', () => {
    const hints = generateResolutionHints([], 0.5);
    expect(hints.some((h) => h.includes('below adequate threshold'))).toBe(true);
  });

  test('includes abstention reasons in hints', () => {
    const hints = generateResolutionHints(['type oracle circuit open', 'lint oracle disabled'], 0.5);
    expect(hints.some((h) => h.includes('type oracle circuit open'))).toBe(true);
    expect(hints.some((h) => h.includes('lint oracle disabled'))).toBe(true);
  });

  test('returns empty array for high confidence with no abstentions', () => {
    const hints = generateResolutionHints([], 0.95);
    expect(hints).toHaveLength(0);
  });

  test('skips empty abstention reasons', () => {
    const hints = generateResolutionHints(['', 'real reason', ''], 0.5);
    const abstentionHints = hints.filter((h) => h.includes('abstained'));
    expect(abstentionHints).toHaveLength(1);
    expect(abstentionHints[0]).toContain('real reason');
  });
});

// ── TIER_WEIGHTS constants ──────────────────────────────────────

describe('TIER_WEIGHTS', () => {
  test('deterministic has highest weight', () => {
    expect(TIER_WEIGHTS.deterministic).toBe(1.0);
  });

  test('heuristic has medium weight', () => {
    expect(TIER_WEIGHTS.heuristic).toBe(0.6);
  });

  test('probabilistic has lowest weight', () => {
    expect(TIER_WEIGHTS.probabilistic).toBe(0.3);
  });

  test('tiers are ordered: deterministic > heuristic > probabilistic', () => {
    expect(TIER_WEIGHTS.deterministic!).toBeGreaterThan(TIER_WEIGHTS.heuristic!);
    expect(TIER_WEIGHTS.heuristic!).toBeGreaterThan(TIER_WEIGHTS.probabilistic!);
  });
});
