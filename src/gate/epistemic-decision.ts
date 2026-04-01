/**
 * Epistemic Gate Decision — replaces binary allow/block with 4-state epistemic decision.
 * A3: Deterministic Governance — all thresholds are deterministic rule-based.
 * Design: docs/research/ehd-implementation-design.md §2.4, §3.1, §3.2
 */

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
 *   NaN | all-abstained           → 'block'
 *   >= HIGH_CONFIDENCE (0.85)    → 'allow'
 *   >= ADEQUATE_CONFIDENCE (0.60) → 'allow-with-caveats'
 *   >= LOW_CONFIDENCE (0.40)     → 'uncertain'
 *   <  LOW_CONFIDENCE (0.40)     → 'block'
 */
export function deriveEpistemicDecision(
  aggregateConfidence: number,
  hasAllOraclesAbstained: boolean,
  thresholds?: ConfidenceThresholds,
): EpistemicGateDecision {
  const t = thresholds ?? DEFAULT_THRESHOLDS;

  if (Number.isNaN(aggregateConfidence) || hasAllOraclesAbstained) {
    return 'block';
  }
  if (aggregateConfidence >= t.HIGH_CONFIDENCE) {
    return 'allow';
  }
  if (aggregateConfidence >= t.ADEQUATE_CONFIDENCE) {
    return 'allow-with-caveats';
  }
  if (aggregateConfidence >= t.LOW_CONFIDENCE) {
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
 */
export function generateResolutionHints(
  abstentionReasons: string[],
  aggregateConfidence: number,
): UncertaintyResolutionHint[] {
  const hints: UncertaintyResolutionHint[] = [];

  if (abstentionReasons.includes('no_test_files')) {
    hints.push('add-tests');
  }
  if (abstentionReasons.includes('no_linter_configured')) {
    hints.push('add-linter');
  }
  if (aggregateConfidence < DEFAULT_THRESHOLDS.UNCERTAIN) {
    hints.push('human-review');
  } else if (aggregateConfidence < DEFAULT_THRESHOLDS.ADEQUATE_CONFIDENCE) {
    hints.push('escalate-routing');
    hints.push('run-deeper-analysis');
  }

  return hints;
}
