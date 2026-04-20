/**
 * Shared ConfidenceTier vocabulary — the one enum every subsystem must use
 * when describing the epistemic strength of a claim, memory, oracle, skill,
 * or peer report.
 *
 * Vocabulary frozen here matches:
 *   - src/config/schema.ts `OracleConfigSchema.tier`
 *   - src/a2a/types.ts     `AgentCardSchema.tier`
 * so that any new subsystem (memory, skills, trajectory export, routing
 * explainer, ACP adapter) stays interchangeable with existing stores.
 *
 * Axiom anchor: A5 Tiered Trust. Ranking outputs, resolving conflicts, and
 * deciding promotion/demotion across the system all consume this ordering.
 *
 * `'unknown'` is intentionally NOT a tier — it is an orthogonal state
 * represented by HypothesisTuple/OracleVerdict `type: 'unknown'` (A2).
 */

export const CONFIDENCE_TIERS = [
  'deterministic',
  'heuristic',
  'probabilistic',
  'speculative',
] as const;

export type ConfidenceTier = (typeof CONFIDENCE_TIERS)[number];

const TIER_RANK: Record<ConfidenceTier, number> = {
  deterministic: 3,
  heuristic: 2,
  probabilistic: 1,
  speculative: 0,
};

export function rankOf(tier: ConfidenceTier): number {
  return TIER_RANK[tier];
}

export function isStrongerThan(a: ConfidenceTier, b: ConfidenceTier): boolean {
  return TIER_RANK[a] > TIER_RANK[b];
}

export function weakerOf(a: ConfidenceTier, b: ConfidenceTier): ConfidenceTier {
  return TIER_RANK[a] <= TIER_RANK[b] ? a : b;
}

/**
 * Retrieval/ranker weight per tier. Callers combine this with similarity,
 * recency, and prediction-error penalties. Tuned once here so ranker behavior
 * is consistent across memory, skill selection, and oracle aggregation.
 */
export const TIER_WEIGHT: Record<ConfidenceTier, number> = {
  deterministic: 1.0,
  heuristic: 0.7,
  probabilistic: 0.4,
  speculative: 0.15,
};

/**
 * Confidence clamp per tier — a probabilistic claim cannot report confidence
 * above `0.85`, etc. Used by ACP adapter and A2A intake to prevent external
 * callers from inflating trust. Values picked to match existing clamps in
 * `src/a2a/transport.ts` behavior.
 */
export const TIER_CONFIDENCE_CEILING: Record<ConfidenceTier, number> = {
  deterministic: 1.0,
  heuristic: 0.95,
  probabilistic: 0.85,
  speculative: 0.6,
};

export function clampConfidenceToTier(confidence: number, tier: ConfidenceTier): number {
  const ceiling = TIER_CONFIDENCE_CEILING[tier];
  if (confidence < 0) return 0;
  if (confidence > ceiling) return ceiling;
  return confidence;
}

export function isConfidenceTier(value: unknown): value is ConfidenceTier {
  return typeof value === 'string' && (CONFIDENCE_TIERS as readonly string[]).includes(value);
}
