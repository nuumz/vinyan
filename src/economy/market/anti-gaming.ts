/**
 * Anti-Gaming — deterministic detection + penalty mechanisms.
 *
 * Detects: underbidding, overbidding, collusion, free-riding.
 * All mechanisms are counter-based with fixed thresholds (A3).
 *
 * Source of truth: Economy OS plan §E3
 */
import type { AuctionResult, Settlement } from './schemas.ts';

export interface AntiGamingAlert {
  type: 'underbid' | 'overclaim' | 'collusion' | 'free_ride';
  bidderId?: string;
  auctionId?: string;
  detail: string;
  severity: 'warning' | 'penalty';
}

/** Collusion: bid spread < 5% across consecutive auctions. */
const COLLUSION_SPREAD_THRESHOLD = 0.05;
const COLLUSION_CONSECUTIVE_THRESHOLD = 5;
/**
 * Phase-3: collusion requires distinct *actors*. Auctions where every bid
 * shares the same persona id are providers running an identical persona/skill
 * loadout — bid spread is naturally tight, not colluding. We require at least
 * this many distinct personas in an auction before counting it toward the
 * collusion window (risk H7 mitigation).
 */
const COLLUSION_MIN_DISTINCT_PERSONAS = 2;

export interface CollusionWindowEntry {
  /** (max - min) / median of bid token estimates. */
  bidSpread: number;
  /**
   * Number of distinct `personaId` values among bidders in this auction.
   * `undefined` for legacy auctions that pre-date persona dispatch — those
   * pass the precondition (treated as if from distinct actors).
   */
  distinctPersonaCount?: number;
}

/**
 * Detect collusion from auction history.
 * Collusion signature: all bids cluster within 5% spread for N consecutive
 * auctions, AND those auctions had at least `COLLUSION_MIN_DISTINCT_PERSONAS`
 * distinct personas. Auctions with one persona (multiple providers running
 * the same persona) are skipped — tight spreads there are expected.
 */
export function detectCollusion(recentAuctions: readonly CollusionWindowEntry[]): AntiGamingAlert | null {
  // Phase-3: filter to auctions that meet the actor-distinctness precondition.
  const eligible = recentAuctions.filter(
    (a) => a.distinctPersonaCount === undefined || a.distinctPersonaCount >= COLLUSION_MIN_DISTINCT_PERSONAS,
  );
  if (eligible.length < COLLUSION_CONSECUTIVE_THRESHOLD) return null;

  const recent = eligible.slice(-COLLUSION_CONSECUTIVE_THRESHOLD);
  const allTight = recent.every((a) => a.bidSpread < COLLUSION_SPREAD_THRESHOLD);

  if (allTight) {
    return {
      type: 'collusion',
      detail: `Bid spread < ${COLLUSION_SPREAD_THRESHOLD * 100}% for ${COLLUSION_CONSECUTIVE_THRESHOLD} consecutive auctions across ≥${COLLUSION_MIN_DISTINCT_PERSONAS} distinct personas`,
      severity: 'penalty',
    };
  }
  return null;
}

/**
 * Compute bid spread for an auction (max - min) / median.
 */
export function computeBidSpread(bids: Array<{ estimatedTokens: number }>): number {
  if (bids.length < 2) return 1.0; // no spread possible
  const values = bids.map((b) => b.estimatedTokens).sort((a, b) => a - b);
  const min = values[0]!;
  const max = values[values.length - 1]!;
  const median = values[Math.floor(values.length / 2)]!;
  if (median === 0) return 1.0;
  return (max - min) / median;
}

/**
 * Detect free-riding: task consumed < 20% of expected tokens AND failed.
 */
export function detectFreeRide(
  actualTokens: number,
  expectedTokensForType: number,
  taskFailed: boolean,
): AntiGamingAlert | null {
  if (!taskFailed) return null;
  if (expectedTokensForType <= 0) return null;

  const effortRatio = actualTokens / expectedTokensForType;
  if (effortRatio < 0.2) {
    return {
      type: 'free_ride',
      detail: `Effort ratio ${(effortRatio * 100).toFixed(0)}% with failure outcome`,
      severity: 'warning',
    };
  }
  return null;
}

/**
 * Aggregate alerts from a settlement.
 */
export function checkSettlement(
  settlement: Settlement,
  expectedTokensForType: number,
  taskFailed: boolean,
): AntiGamingAlert[] {
  const alerts: AntiGamingAlert[] = [];

  // Underbid detection is already in settlement.penalty_type
  if (settlement.penalty_type === 'underbid') {
    alerts.push({
      type: 'underbid',
      bidderId: settlement.engineId,
      detail: `Actual cost ${settlement.actual_usd.toFixed(4)} vs bid ${settlement.bid_usd.toFixed(4)}`,
      severity: 'warning',
    });
  }

  // Free-ride detection
  const freeRide = detectFreeRide(
    settlement.actual_usd > 0 ? settlement.actual_usd : 1,
    expectedTokensForType,
    taskFailed,
  );
  if (freeRide) {
    freeRide.bidderId = settlement.engineId;
    alerts.push(freeRide);
  }

  return alerts;
}
