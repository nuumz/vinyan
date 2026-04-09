/**
 * Settlement Engine — ex-post bid vs actual comparison.
 *
 * Uses log-ratio accuracy metric (symmetric: over/underestimate penalized equally).
 * Settlement feeds back into trust via ProviderTrustStore.
 *
 * A3 compliant: deterministic accuracy computation.
 *
 * Source of truth: Economy OS plan §E3
 */
import type { EngineBid, Settlement } from './schemas.ts';

export interface ActualOutcome {
  tokensConsumed: number;
  durationMs: number;
  computedUsd: number;
  success: boolean;
}

/** Accurate bid threshold for trust feedback. */
const ACCURACY_THRESHOLD = 0.6;

/**
 * Compute bid accuracy using log-ratio (symmetric).
 * Perfect accuracy = 1.0, worst = 0.0.
 */
export function logRatioAccuracy(estimated: number, actual: number): number {
  if (estimated <= 0 || actual <= 0) return 0;
  return Math.max(0, 1 - Math.min(1, Math.abs(Math.log(actual / estimated))));
}

/**
 * Settle a bid: compare bid estimates vs actual outcomes.
 */
export function settleBid(bid: EngineBid, actual: ActualOutcome): Settlement {
  const bidTokens = bid.estimatedTokensInput + bid.estimatedTokensOutput;
  const costAccuracy = logRatioAccuracy(bidTokens, actual.tokensConsumed);
  const durationAccuracy = logRatioAccuracy(bid.estimatedDurationMs, actual.durationMs);
  const composite = costAccuracy * 0.7 + durationAccuracy * 0.3;

  // Detect underbidding: actual >> estimated
  let penaltyType: string | null = null;
  if (bidTokens > 0 && actual.tokensConsumed / bidTokens > 1.5) {
    penaltyType = 'underbid';
  }

  return {
    settlementId: `stl-${bid.bidId}`,
    bidId: bid.bidId,
    engineId: bid.bidderId,
    taskId: bid.auctionId.replace('auc-', 'task-'),
    bid_usd: bid.estimatedUsd ?? 0,
    actual_usd: actual.computedUsd,
    bid_duration_ms: bid.estimatedDurationMs,
    actual_duration_ms: actual.durationMs,
    cost_accuracy: costAccuracy,
    duration_accuracy: durationAccuracy,
    composite_accuracy: composite,
    penalty_type: penaltyType,
    timestamp: Date.now(),
  };
}

/**
 * Determine if this settlement should count as a trust "success".
 */
export function isAccurateBid(settlement: Settlement): boolean {
  return settlement.composite_accuracy >= ACCURACY_THRESHOLD;
}
