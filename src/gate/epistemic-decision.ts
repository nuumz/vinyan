/**
 * Epistemic Gate Decision — replaces binary allow/block with 4-state epistemic decision.
 * A3: Deterministic Governance — all thresholds are deterministic rule-based.
 * Design: docs/research/ehd-implementation-design.md §2.4, §3.1, §3.2
 */
import { type FusionInput, type SubjectiveOpinion, fromScalar, fuseAll, projectedProbability } from '../core/subjective-opinion.ts';

export type EpistemicGateDecision =
  | 'allow' // High confidence pass (>= HIGH_CONFIDENCE)
  | 'allow-with-caveats' // Pass but low confidence — proceed, flag for monitoring
  | 'uncertain' // Mixed signals — escalate verification (NOT a failure)
  | 'block'; // Clear failure — reject

export interface ConfidenceThresholds {
  HIGH_CONFIDENCE: number; // 0.85
  ADEQUATE_CONFIDENCE: number; // 0.60
  LOW_CONFIDENCE: number; // 0.40
  UNCERTAIN: number; // 0.25
}

export const DEFAULT_THRESHOLDS: ConfidenceThresholds = {
  HIGH_CONFIDENCE: 0.85,
  ADEQUATE_CONFIDENCE: 0.60,
  LOW_CONFIDENCE: 0.40,
  UNCERTAIN: 0.25,
};

/** Short-form threshold alias for convenience. */
export const THRESHOLDS = {
  HIGH: DEFAULT_THRESHOLDS.HIGH_CONFIDENCE,
  ADEQUATE: DEFAULT_THRESHOLDS.ADEQUATE_CONFIDENCE,
  LOW: DEFAULT_THRESHOLDS.LOW_CONFIDENCE,
  UNCERTAIN: DEFAULT_THRESHOLDS.UNCERTAIN,
} as const;

/** Tier weights for confidence aggregation (A5: tiered trust). */
export const TIER_WEIGHTS: Record<string, number> = {
  deterministic: 1.0,
  heuristic: 0.6,
  probabilistic: 0.3,
};

/**
 * Compute aggregate confidence using weighted harmonic mean of oracle confidences.
 * Weighted harmonic mean: (sum of wi) / (sum of wi/ci)
 *
 * - Zero-confidence verdicts pull the aggregate toward 0
 * - Returns NaN if no verdicts have weight (empty input)
 */
export function computeAggregateConfidence(
  verdicts: Record<string, import('../core/types.ts').OracleVerdict>,
  tiers: Record<string, string>,
): number {
  const entries = Object.entries(verdicts);
  if (entries.length === 0) return NaN;

  let weightSum = 0;
  let reciprocalSum = 0;

  for (const [name, verdict] of entries) {
    const tier = tiers[name] ?? 'heuristic';
    const w = TIER_WEIGHTS[tier] ?? 0.6;
    weightSum += w;
    if (verdict.confidence === 0) return 0;
    reciprocalSum += w / verdict.confidence;
  }

  if (weightSum === 0 || reciprocalSum === 0) return NaN;
  return weightSum / reciprocalSum;
}

export interface SLAggregateResult {
  /** projectedProbability of fused opinion, or NaN if no inputs. */
  confidence: number;
  /** Fused SubjectiveOpinion, or null if no inputs. */
  fusedOpinion: SubjectiveOpinion | null;
}

/**
 * Phase 4.9: Compute SL aggregate from N oracle fusion inputs.
 * Uses fuseAll() (Jaccard-based operator selection) then projectedProbability().
 * Returns NaN confidence and null fusedOpinion for empty input (caller falls back to harmonic mean).
 */
export function computeSLAggregate(inputs: FusionInput[]): SLAggregateResult {
  if (inputs.length === 0) return { confidence: NaN, fusedOpinion: null };
  const fused = fuseAll(inputs);
  return { confidence: projectedProbability(fused), fusedOpinion: fused };
}

// Re-export for consumers that import from this module
export type { FusionInput, SubjectiveOpinion };
export { fromScalar, projectedProbability };

export type UncertaintyResolutionHint =
  | 'add-tests' // Test oracle abstained
  | 'add-linter' // Lint oracle abstained
  | 'run-deeper-analysis' // Low confidence from existing oracles
  | 'human-review' // Very low confidence
  | 'escalate-routing'; // Uncertain — try higher routing level

/**
 * Derive EpistemicGateDecision from aggregate confidence.
 * @param aggregateConfidence - Aggregate confidence score [0,1] or NaN if unverified
 * @param hasAllOraclesAbstained - True if ALL oracles abstained (zero verdicts)
 * @param thresholds - Optional custom thresholds (defaults to DEFAULT_THRESHOLDS)
 *
 * Decision mapping (A3: deterministic rule-based):
 *   all-abstained                → 'uncertain' (A2: "I don't know" is a valid state)
 *   NaN (no verdicts)           → 'block'
 *   >= HIGH_CONFIDENCE (0.85)    → 'allow'
 *   >= ADEQUATE_CONFIDENCE (0.60) → 'allow-with-caveats'
 *   >= UNCERTAIN (0.25)         → 'uncertain'
 *   <  UNCERTAIN (0.25)         → 'block'
 */
export function deriveEpistemicDecision(
  aggregateConfidence: number,
  hasAllOraclesAbstained: boolean,
  thresholds?: ConfidenceThresholds,
): EpistemicGateDecision {
  const t = thresholds ?? DEFAULT_THRESHOLDS;

  // A2: All oracles abstained → "I don't know" (epistemic uncertainty, not failure)
  if (hasAllOraclesAbstained) {
    return 'uncertain';
  }
  if (Number.isNaN(aggregateConfidence)) {
    return 'block';
  }
  if (aggregateConfidence >= t.HIGH_CONFIDENCE) {
    return 'allow';
  }
  if (aggregateConfidence >= t.ADEQUATE_CONFIDENCE) {
    return 'allow-with-caveats';
  }
  if (aggregateConfidence >= t.UNCERTAIN) {
    return 'uncertain';
  }
  return 'block';
}

/**
 * Map EpistemicGateDecision → classic binary decision (backward compat).
 * allow + allow-with-caveats → 'allow'
 * uncertain + block → 'block'
 * Note: 'uncertain' maps to 'block' to be safe — caller should re-verify before committing.
 */
export function toClassicDecision(decision: EpistemicGateDecision): 'allow' | 'block' {
  return decision === 'allow' || decision === 'allow-with-caveats' ? 'allow' : 'block';
}

/**
 * Generate resolution hints based on oracle abstention state and aggregate confidence.
 * Used to surface actionable guidance alongside 'uncertain' or 'allow-with-caveats' decisions.
 *
 * Returns descriptive strings (not enum values) for direct display in caveats.
 */
export function generateResolutionHints(
  abstentionReasons: string[],
  aggregateConfidence: number,
): string[] {
  const hints: string[] = [];

  // NaN confidence — no oracle provided data at all
  if (Number.isNaN(aggregateConfidence)) {
    hints.push('No oracle provided confidence data — unable to assess quality');
    return hints;
  }

  // Confidence-based hints
  if (aggregateConfidence < DEFAULT_THRESHOLDS.UNCERTAIN) {
    hints.push(`Aggregate confidence is very low (${(aggregateConfidence * 100).toFixed(1)}%) — consider human review`);
  } else if (aggregateConfidence < DEFAULT_THRESHOLDS.ADEQUATE_CONFIDENCE) {
    hints.push(
      `Aggregate confidence (${(aggregateConfidence * 100).toFixed(1)}%) is below adequate threshold (${(DEFAULT_THRESHOLDS.ADEQUATE_CONFIDENCE * 100).toFixed(0)}%) — consider escalating verification`,
    );
  }

  // Abstention-based hints
  for (const reason of abstentionReasons) {
    if (reason && reason.trim().length > 0) {
      hints.push(`Oracle abstained: ${reason}`);
    }
  }

  return hints;
}
