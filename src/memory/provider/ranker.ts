/**
 * Tiered Retrieval Ranker — score composition for the DefaultMemoryProvider.
 *
 * Decision 22 (`docs/architecture/decisions.md`) anchors the formula:
 *
 *   score = similarity · tierWeight(evidenceTier) · recency(createdAt)
 *           − predErrorPenalty(memoryId)
 *
 * The implementation here uses a **weighted sum** (not a multiplicative
 * product) so each component contributes independently and callers can
 * introspect the breakdown for the observable-routing explainer. The ranker
 * surface is deliberately pure — the provider does the I/O, this file just
 * combines numbers.
 *
 * Axioms:
 *   A5 — tier weights monotonic across ConfidenceTier (imported from the
 *        shared vocabulary; never redeclared here).
 *   A7 — `predErrorPenalty` consumes `prediction_outcomes` accounting; the
 *        provider passes the count in, the ranker maps it to [0, 1].
 */
import { type ConfidenceTier, TIER_WEIGHT } from '../../core/confidence-tier.ts';

// ── Weights ────────────────────────────────────────────────────────────

export interface RankerWeights {
  similarity: number;
  tier: number;
  recency: number;
  predError: number;
}

/**
 * Default weights. Chosen so similarity is the primary driver, tier is a
 * strong but not dominant secondary signal, recency is a light thumb on
 * the scale, and the predError penalty is capped in magnitude so a single
 * noisy outcome does not obliterate an otherwise-good memory.
 */
export const DEFAULT_WEIGHTS: RankerWeights = {
  similarity: 0.45,
  tier: 0.35,
  recency: 0.15,
  predError: 0.15,
};

// ── Inputs / Outputs ───────────────────────────────────────────────────

export interface RankerInputs {
  /** Raw bm25() output from SQLite FTS5 (negative; lower = better). */
  readonly fts5Rank: number;
  readonly tier: ConfidenceTier;
  readonly createdAt: number;
  readonly now: number;
  /** Half-life for the exponential recency decay. Default 14 days. */
  readonly halfLifeMs: number;
  /**
   * Count of recent prediction_outcomes rows where this memory's id appears
   * in the turn's evidence_chain and the prediction was wrong. Caller
   * bounds/buckets this; the ranker maps it into [0, 1] via `min(1, n/5)`.
   */
  readonly recentErrors: number;
}

export interface RankerScoreBreakdown {
  readonly similarity: number;
  readonly tierWeight: number;
  readonly recency: number;
  readonly predErrorPenalty: number;
  readonly composite: number;
}

// ── bm25 normalization ─────────────────────────────────────────────────

/**
 * Map SQLite FTS5 bm25() output to a similarity in [0, 1].
 *
 * bm25() returns a **negative** score where lower (more negative) means a
 * closer match. Two idiomatic normalizations exist:
 *
 *   (a) `1 / (1 + exp(bm25))`  — smooth logistic; strong responses near 0
 *   (b) `1 / (1 + |bm25|)`     — rational decay; heavier tail
 *
 * We pick **(a)** — logistic. Reasons:
 *   1. Bounded strictly in (0, 1); no extreme-value compression problems.
 *   2. Differentiable (nice for any future gradient-based reranker).
 *   3. Empirically in our FTS5 queries bm25 tends to sit in the [-10, -1]
 *      range; logistic keeps that window well-spread, whereas |x|-rational
 *      squashes it heavily toward 0.25–0.5.
 *
 * Tests lock the behavior: more-negative input → larger output, bounded.
 */
export function normalizeBm25(bm25Score: number): number {
  // Guard against NaN / ±Infinity: treat as zero similarity. FTS5 never
  // returns NaN in practice, but an unbound column (eg. joined row with no
  // MATCH) might leak through and we want a stable contract.
  if (!Number.isFinite(bm25Score)) return 0;
  // 1 / (1 + exp(bm25)). For bm25 very negative, exp→0, sim→1.
  // For bm25 large positive, exp→∞, sim→0.
  return 1 / (1 + Math.exp(bm25Score));
}

// ── Recency ────────────────────────────────────────────────────────────

/**
 * Exponential half-life decay. `createdAt` older than `halfLifeMs` halves
 * per half-life. Future timestamps clamp to recency = 1.
 */
export function recencyScore(createdAt: number, now: number, halfLifeMs: number): number {
  if (halfLifeMs <= 0) return 1;
  const ageMs = Math.max(0, now - createdAt);
  // exp(-ln(2) * age / halfLife) = 0.5^(age/halfLife)
  return Math.exp(-Math.LN2 * (ageMs / halfLifeMs));
}

// ── Composite ──────────────────────────────────────────────────────────

/**
 * Combine the four signals into a composite score. Returns the full
 * breakdown so callers can populate `MemoryHit.components` verbatim.
 *
 *   composite = w.sim·sim + w.tier·tier + w.rec·rec − w.predError·penalty
 *
 * With DEFAULT_WEIGHTS the achievable range is approximately
 * `[-0.15, 0.95]`; tests assert a looser `[-1, 2]` sanity bound to allow
 * weight overrides.
 */
export function computeScore(inputs: RankerInputs, weightOverride?: Partial<RankerWeights>): RankerScoreBreakdown {
  const w: RankerWeights = { ...DEFAULT_WEIGHTS, ...(weightOverride ?? {}) };

  const similarity = normalizeBm25(inputs.fts5Rank);
  const tierWeight = TIER_WEIGHT[inputs.tier];
  const recency = recencyScore(inputs.createdAt, inputs.now, inputs.halfLifeMs);
  const predErrorPenalty = Math.min(1, Math.max(0, inputs.recentErrors) / 5);

  const composite =
    w.similarity * similarity + w.tier * tierWeight + w.recency * recency - w.predError * predErrorPenalty;

  return {
    similarity,
    tierWeight,
    recency,
    predErrorPenalty,
    composite,
  };
}
