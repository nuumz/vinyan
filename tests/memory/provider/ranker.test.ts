/**
 * Tiered Retrieval Ranker — behavior tests.
 *
 * Covers the formula in Decision 22 + docstring contract:
 *
 *   - tier dominance at equal similarity + recency
 *   - recency decay
 *   - prediction-error penalty reduces score monotonically
 *   - weight overrides shift ordering
 *   - bm25 normalization is monotonic + bounded
 *   - composite stays within a sanity bound
 */
import { describe, expect, it } from 'bun:test';
import { TIER_WEIGHT } from '../../../src/core/confidence-tier.ts';
import {
  computeScore,
  DEFAULT_WEIGHTS,
  normalizeBm25,
  recencyScore,
} from '../../../src/memory/provider/ranker.ts';

const NOW = 1_700_000_000_000;
const HALF_LIFE = 14 * 24 * 60 * 60 * 1000;

function baseInput(overrides: Partial<Parameters<typeof computeScore>[0]> = {}): Parameters<typeof computeScore>[0] {
  return {
    fts5Rank: -5,
    tier: 'heuristic',
    createdAt: NOW - 1_000,
    now: NOW,
    halfLifeMs: HALF_LIFE,
    recentErrors: 0,
    ...overrides,
  };
}

// ── bm25 ────────────────────────────────────────────────────────────────

describe('normalizeBm25', () => {
  it('returns values in [0, 1], strictly less than 1 for finite inputs within safe range', () => {
    for (const v of [-10, -1, 0, 1, 10, 50]) {
      const n = normalizeBm25(v);
      expect(n).toBeGreaterThan(0);
      expect(n).toBeLessThan(1);
    }
    // Very negative inputs can saturate to 1 under floating point; contract
    // is "bounded in [0, 1]" — saturation is acceptable.
    const saturated = normalizeBm25(-1_000);
    expect(saturated).toBeGreaterThanOrEqual(0);
    expect(saturated).toBeLessThanOrEqual(1);
  });

  it('is monotonically decreasing in bm25 score (more-negative → larger)', () => {
    const strong = normalizeBm25(-10);
    const mid = normalizeBm25(-2);
    const weak = normalizeBm25(0);
    expect(strong).toBeGreaterThan(mid);
    expect(mid).toBeGreaterThan(weak);
  });

  it('returns 0 for non-finite inputs (safe fallback)', () => {
    expect(normalizeBm25(Number.NaN)).toBe(0);
    expect(normalizeBm25(Number.POSITIVE_INFINITY)).toBe(0);
    expect(normalizeBm25(Number.NEGATIVE_INFINITY)).toBe(0);
  });
});

// ── recency ─────────────────────────────────────────────────────────────

describe('recencyScore', () => {
  it('is 1 at now', () => {
    expect(recencyScore(NOW, NOW, HALF_LIFE)).toBeCloseTo(1, 10);
  });

  it('halves at half-life', () => {
    expect(recencyScore(NOW - HALF_LIFE, NOW, HALF_LIFE)).toBeCloseTo(0.5, 5);
  });

  it('clamps future timestamps to 1', () => {
    expect(recencyScore(NOW + 1_000_000, NOW, HALF_LIFE)).toBe(1);
  });

  it('degenerate halfLifeMs <= 0 returns 1', () => {
    expect(recencyScore(NOW - 1_000_000, NOW, 0)).toBe(1);
  });
});

// ── composite ───────────────────────────────────────────────────────────

describe('computeScore — tier dominance', () => {
  it('deterministic outranks probabilistic at equal similarity', () => {
    const a = computeScore(baseInput({ tier: 'deterministic' }));
    const b = computeScore(baseInput({ tier: 'probabilistic' }));
    expect(a.composite).toBeGreaterThan(b.composite);
    expect(a.tierWeight).toBe(TIER_WEIGHT.deterministic);
    expect(b.tierWeight).toBe(TIER_WEIGHT.probabilistic);
  });

  it('heuristic outranks speculative at equal similarity', () => {
    const a = computeScore(baseInput({ tier: 'heuristic' }));
    const b = computeScore(baseInput({ tier: 'speculative' }));
    expect(a.composite).toBeGreaterThan(b.composite);
  });
});

describe('computeScore — recency', () => {
  it('recent memory outranks old at equal tier + similarity', () => {
    const recent = computeScore(baseInput({ createdAt: NOW - 60_000 }));
    const old = computeScore(baseInput({ createdAt: NOW - 90 * 24 * 60 * 60 * 1000 }));
    expect(recent.composite).toBeGreaterThan(old.composite);
    expect(recent.recency).toBeGreaterThan(old.recency);
  });
});

describe('computeScore — prediction-error penalty', () => {
  it('memory with recent errors loses to equal clean memory', () => {
    const clean = computeScore(baseInput({ recentErrors: 0 }));
    const dirty = computeScore(baseInput({ recentErrors: 4 }));
    expect(clean.composite).toBeGreaterThan(dirty.composite);
    expect(dirty.predErrorPenalty).toBeGreaterThan(0);
  });

  it('penalty caps at 1 when recentErrors ≥ 5', () => {
    const b1 = computeScore(baseInput({ recentErrors: 5 }));
    const b2 = computeScore(baseInput({ recentErrors: 50 }));
    expect(b1.predErrorPenalty).toBe(1);
    expect(b2.predErrorPenalty).toBe(1);
    expect(b1.composite).toBeCloseTo(b2.composite, 10);
  });
});

describe('computeScore — weight override', () => {
  it('raising similarity weight flips an ordering previously driven by tier', () => {
    // Memory A: weak match, deterministic tier.
    // Memory B: strong match, speculative tier.
    const aInput = baseInput({ fts5Rank: -1, tier: 'deterministic', recentErrors: 0 });
    const bInput = baseInput({ fts5Rank: -20, tier: 'speculative', recentErrors: 0 });

    const defaults = {
      a: computeScore(aInput).composite,
      b: computeScore(bInput).composite,
    };

    const simHeavy = {
      a: computeScore(aInput, { similarity: 0.9, tier: 0.05 }).composite,
      b: computeScore(bInput, { similarity: 0.9, tier: 0.05 }).composite,
    };

    // Under default weights the deterministic (even with weak match) wins —
    // tier weight is strong enough to dominate.
    expect(defaults.a).toBeGreaterThan(defaults.b);
    // Under similarity-heavy weights the strong-match speculative wins.
    expect(simHeavy.b).toBeGreaterThan(simHeavy.a);
  });
});

describe('computeScore — sanity bounds', () => {
  it('composite stays in [-1, 2] across a grid of extreme inputs', () => {
    const tiers = ['deterministic', 'heuristic', 'probabilistic', 'speculative'] as const;
    const bms = [-50, -5, 0, 5, 50];
    const errs = [0, 5, 50];
    for (const t of tiers) {
      for (const r of bms) {
        for (const e of errs) {
          const s = computeScore(baseInput({ tier: t, fts5Rank: r, recentErrors: e })).composite;
          expect(s).toBeGreaterThanOrEqual(-1);
          expect(s).toBeLessThanOrEqual(2);
        }
      }
    }
  });

  it('default weights match DEFAULT_WEIGHTS constants', () => {
    expect(DEFAULT_WEIGHTS.similarity).toBe(0.45);
    expect(DEFAULT_WEIGHTS.tier).toBe(0.35);
    expect(DEFAULT_WEIGHTS.recency).toBe(0.15);
    expect(DEFAULT_WEIGHTS.predError).toBe(0.15);
  });
});
