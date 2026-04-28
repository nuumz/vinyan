/**
 * capability-trust tests — verify the unified scoring formula and the
 * Phase-1 ordering invariants.
 *
 * The core invariant: empirical evidence with sufficient sample size beats
 * curated builtin assertions, but neither beats out a deterministic skill.
 * Cold-start `'evolved'` claims (n<10) collapse onto the neutral floor so
 * a single-trial success cannot overturn the builtin baseline.
 */
import { describe, expect, test } from 'bun:test';
import {
  EVIDENCE_WEIGHT,
  effectiveTrust,
  WILSON_COLD_START,
  WILSON_FLOOR_MIN_TRIALS,
  wilsonLBFloor,
} from '../../src/orchestrator/capability-trust.ts';
import type { CapabilityClaim } from '../../src/orchestrator/types.ts';

function makeClaim(overrides?: Partial<CapabilityClaim>): CapabilityClaim {
  return {
    id: 'fixture',
    evidence: 'builtin',
    confidence: 0.8,
    ...overrides,
  };
}

describe('wilsonLBFloor', () => {
  test('returns cold-start neutral when outcomes are absent', () => {
    expect(wilsonLBFloor(null)).toBe(WILSON_COLD_START);
    expect(wilsonLBFloor(undefined)).toBe(WILSON_COLD_START);
  });

  test('returns cold-start neutral when sample size is below floor', () => {
    for (let n = 0; n < WILSON_FLOOR_MIN_TRIALS; n++) {
      expect(wilsonLBFloor({ successes: n, total: n })).toBe(WILSON_COLD_START);
    }
  });

  test('returns real Wilson LB when sample size meets the floor', () => {
    // 10 successes out of 10 — Wilson LB at 95% CI is around 0.72, well above
    // the cold-start floor of 0.5.
    const lb = wilsonLBFloor({ successes: 10, total: 10 });
    expect(lb).toBeGreaterThan(WILSON_COLD_START);
    expect(lb).toBeLessThanOrEqual(1);
  });

  test('returns lower values for failure-heavy histories', () => {
    const success = wilsonLBFloor({ successes: 50, total: 50 });
    const mixed = wilsonLBFloor({ successes: 25, total: 50 });
    const failure = wilsonLBFloor({ successes: 5, total: 50 });
    expect(success).toBeGreaterThan(mixed);
    expect(mixed).toBeGreaterThan(failure);
  });
});

describe('EVIDENCE_WEIGHT', () => {
  test('orders provenance from empirical to inferred', () => {
    expect(EVIDENCE_WEIGHT.evolved).toBeGreaterThan(EVIDENCE_WEIGHT.builtin);
    expect(EVIDENCE_WEIGHT.builtin).toBeGreaterThan(EVIDENCE_WEIGHT.synthesized);
    expect(EVIDENCE_WEIGHT.synthesized).toBeGreaterThan(EVIDENCE_WEIGHT.inferred);
  });
});

describe('effectiveTrust', () => {
  test('mature evolved claim outranks curated builtin claim', () => {
    const mature: CapabilityClaim = makeClaim({ evidence: 'evolved', confidence: 0.7 });
    const builtin: CapabilityClaim = makeClaim({ evidence: 'builtin', confidence: 0.95 });
    const matureScore = effectiveTrust(mature, { successes: 20, total: 20 }, 'heuristic');
    const builtinScore = effectiveTrust(builtin, null, 'heuristic');
    expect(matureScore).toBeGreaterThan(builtinScore);
  });

  test('sparse evolved claim does not outrank curated builtin claim', () => {
    const sparse: CapabilityClaim = makeClaim({ evidence: 'evolved', confidence: 0.95 });
    const builtin: CapabilityClaim = makeClaim({ evidence: 'builtin', confidence: 0.95 });
    const sparseScore = effectiveTrust(sparse, { successes: 3, total: 3 }, 'heuristic');
    const builtinScore = effectiveTrust(builtin, null, 'heuristic');
    // Sparse evolved (n<floor) collapses to cold-start ≤ curated builtin baseline.
    expect(sparseScore).toBeLessThanOrEqual(builtinScore);
  });

  test('deterministic-tier skill beats heuristic-tier skill at same evidence and outcomes', () => {
    const claim: CapabilityClaim = makeClaim({ evidence: 'evolved', confidence: 0.9 });
    const outcomes = { successes: 30, total: 30 };
    const deterministic = effectiveTrust(claim, outcomes, 'deterministic');
    const heuristic = effectiveTrust(claim, outcomes, 'heuristic');
    expect(deterministic).toBeGreaterThan(heuristic);
  });

  test('inferred claim ranks at the bottom of the ladder', () => {
    const inferred: CapabilityClaim = makeClaim({ evidence: 'inferred', confidence: 0.4 });
    const synthesized: CapabilityClaim = makeClaim({ evidence: 'synthesized', confidence: 0.5 });
    const builtin: CapabilityClaim = makeClaim({ evidence: 'builtin', confidence: 0.8 });
    const inferredScore = effectiveTrust(inferred, null, 'speculative');
    const synthesizedScore = effectiveTrust(synthesized, null, 'speculative');
    const builtinScore = effectiveTrust(builtin, null, 'speculative');
    expect(inferredScore).toBeLessThanOrEqual(synthesizedScore);
    expect(synthesizedScore).toBeLessThanOrEqual(builtinScore);
  });

  test('defaults to speculative tier when none is supplied', () => {
    const claim = makeClaim({ evidence: 'builtin', confidence: 0.9 });
    const explicit = effectiveTrust(claim, null, 'speculative');
    const implicit = effectiveTrust(claim, null);
    expect(implicit).toBe(explicit);
  });

  test('static confidence carries through when outcomes are absent', () => {
    // A high-confidence builtin claim should outrank a low-confidence builtin
    // claim of the same evidence/tier, since static confidence is the only
    // signal in the cold-start path.
    const high = makeClaim({ evidence: 'builtin', confidence: 0.9 });
    const low = makeClaim({ evidence: 'builtin', confidence: 0.5 });
    expect(effectiveTrust(high, null, 'heuristic')).toBeGreaterThanOrEqual(effectiveTrust(low, null, 'heuristic'));
  });

  test('returns a value in [0, 1] for any well-formed claim', () => {
    for (const evidence of ['evolved', 'builtin', 'synthesized', 'inferred'] as const) {
      for (const tier of ['deterministic', 'heuristic', 'pragmatic', 'probabilistic', 'speculative'] as const) {
        const claim = makeClaim({ evidence, confidence: 0.7 });
        const score = effectiveTrust(claim, { successes: 50, total: 50 }, tier);
        expect(score).toBeGreaterThanOrEqual(0);
        expect(score).toBeLessThanOrEqual(1);
      }
    }
  });
});
