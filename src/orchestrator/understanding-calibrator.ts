/**
 * Understanding Calibrator — A7 learning signal from understanding accuracy.
 *
 * Post-task: compare predicted understanding (entities, intent, mutation category)
 * with actual outcome (affected files, oracle verdicts).
 *
 * Enriched signatures: when an intent category accumulates ≥10 observations,
 * split it from the base signature to enable per-intent learning in SelfModel.
 *
 * Source of truth: docs/design/semantic-task-understanding-system-design.md §5.5, §6.3
 */

import type { ExecutionTrace, SemanticTaskUnderstanding } from './types.ts';

// ── Calibration ─────────────────────────────────────────────────────────

export interface UnderstandingCalibration {
  /** Predicted intent at task start. */
  predictedIntent?: string;
  /** Actual behavior observed (from trace outcome). */
  actualBehavior: string;
  /** Fraction of resolved paths that were actually affected (0-1). */
  entityAccuracy: number;
  /** Did the task actually match the predicted mutation category? */
  categoryMatch: boolean;
}

/**
 * Compare predicted understanding with actual task outcome.
 * Returns calibration metrics for A7 learning.
 */
export function calibrateUnderstanding(
  understanding: SemanticTaskUnderstanding,
  trace: ExecutionTrace,
): UnderstandingCalibration {
  // Entity accuracy: fraction of resolved paths that were actually affected
  const resolvedPaths = understanding.resolvedEntities.flatMap((e) => e.resolvedPaths);
  const actualFiles = trace.affectedFiles;
  const overlap = resolvedPaths.filter((p) => actualFiles.includes(p));
  const entityAccuracy = resolvedPaths.length > 0 ? overlap.length / resolvedPaths.length : 1.0;

  // Category match: did mutations happen if we predicted mutation?
  const hadMutations = trace.affectedFiles.length > 0;
  const categoryMatch = understanding.expectsMutation === hadMutations;

  return {
    predictedIntent: understanding.semanticIntent?.primaryAction,
    actualBehavior: trace.outcome,
    entityAccuracy,
    categoryMatch,
  };
}

// ── Enriched Signatures ─────────────────────────────────────────────────

/** Minimum observations before splitting a signature by intent (§6.3). */
export const ENRICHMENT_THRESHOLD = 10;

/**
 * Compute enriched task type signature with optional intent suffix.
 *
 * Only enriches when:
 * 1. Intent was computed (Layer 2 ran)
 * 2. The enriched signature has ≥ ENRICHMENT_THRESHOLD observations
 *
 * This prevents signature explosion: new intent categories start in the base
 * group and only split off when they have enough data for reliable learning.
 */
export function computeEnrichedSignature(
  baseSignature: string,
  understanding: SemanticTaskUnderstanding,
  getObservationCount: (sig: string) => number,
): string {
  const intent = understanding.semanticIntent?.primaryAction;
  if (!intent) return baseSignature;

  const enrichedSig = `${baseSignature}::${intent}`;
  if (getObservationCount(enrichedSig) >= ENRICHMENT_THRESHOLD) {
    return enrichedSig;
  }
  return baseSignature;
}
