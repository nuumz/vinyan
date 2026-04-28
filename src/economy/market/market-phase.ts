/**
 * Market Phase — data-gated phase evaluation + transition logic.
 *
 * Phase A: No auction (trust-weighted selection)
 * Phase B: Local-only Vickrey (≥2 active engines, ≥50 tasks each, ≥500 traces)
 * Phase C: Local + remote (Phase B for 100+ auctions + trusted A2A peer)
 * Phase D: Full market with all anti-gaming
 *
 * A3 compliant: deterministic evaluation, no LLM.
 *
 * Source of truth: Economy OS plan §E3
 */
import type { MarketPhase, MarketPhaseState } from './schemas.ts';

export interface MarketPhaseStats {
  activeEngines: number;
  minTasksPerEngine: number;
  totalTraces: number;
  auctionCount: number;
  trustedRemotePeers: number;
  minRemotePeerTasks: number;
  distinctEnginesWithBids: number;
  minSettledBidsPerEngine: number;
  /**
   * Global single-winner concentration over the recent auction window. Pre-
   * Phase-3 the regression rule fired when this exceeded 0.9, but in a
   * persona-aware roster the *expected* outcome is that one persona wins
   * its task family (Developer for code, Author for prose). Use
   * `dominantWinRateByFamily` for the corrected check.
   */
  dominantWinRate: number;
  /**
   * Phase-3 — per-task-family single-winner concentration. Keys are
   * task-type-signature families (e.g. `'code-mutation'`, `'creative-writing'`),
   * values are the win rate of the dominant bidder in that family. Empty
   * map → caller has no family stats yet (legacy / cold-start) → fall back
   * to the global `dominantWinRate` rule.
   */
  dominantWinRateByFamily?: Record<string, number>;
  /**
   * Phase-3 — auction count per task family. Used to gate the regression
   * rule on per-family sample size, so a family with only 5 auctions can
   * still be 90% dominant by chance without triggering regression.
   */
  auctionsByFamily?: Record<string, number>;
}

/**
 * Phase-3 — minimum auctions per family before the stratified rule treats
 * dominance as meaningful. Below this, family is too small to draw conclusions.
 */
export const FAMILY_DOMINANCE_MIN_AUCTIONS = 20;
/**
 * Phase-3 — share of total auctions a single family can take before the
 * stratified rule degenerates back to global behaviour. If 95% of all auctions
 * are one family, "global dominance" is just "family dominance" by another
 * name — no useful stratification, so we still let the dominance rule fire.
 */
export const FAMILY_SPREAD_MAX_SHARE = 0.9;

export interface PhaseTransition {
  newPhase: MarketPhase;
  reason: string;
}

/**
 * Evaluate market phase based on current stats.
 * Pure function: same inputs → same output (A3).
 *
 * Phase-3 stratifies the regression rule by task-type-family so a Developer
 * persona that *correctly* wins 95% of code-mutation tasks is no longer
 * mistaken for market degeneracy. Regression now requires either:
 *
 *   (a) global dominance > 0.9 AND no per-family stats available
 *       (legacy path — preserves pre-Phase-3 behaviour for old callers), OR
 *   (b) global dominance > 0.9 AND a single family takes ≥ 90% of auctions
 *       (one family is the entire workload — stratification adds no signal)
 *
 * When per-family stats are available AND auctions are spread across
 * families, we *do not* regress on a single family being dominant; that's
 * the right answer for that family. Risk H6 mitigation.
 */
export function evaluateMarketPhase(current: MarketPhaseState, stats: MarketPhaseStats): PhaseTransition {
  // Check deactivation conditions (regress)
  if (current.currentPhase !== 'A') {
    // Market degeneracy: >90% single winner over 50 auctions, but Phase-3
    // gates this on family spread so per-family dominance doesn't false-positive.
    if (stats.auctionCount >= 50 && stats.dominantWinRate > 0.9) {
      const familyAuctions = stats.auctionsByFamily;
      const hasFamilySpread = familyAuctions && Object.keys(familyAuctions).length > 1;
      const totalFamilyAuctions = familyAuctions != null ? Object.values(familyAuctions).reduce((a, b) => a + b, 0) : 0;
      const maxFamilyShare =
        familyAuctions != null && totalFamilyAuctions > 0
          ? Math.max(...Object.values(familyAuctions)) / totalFamilyAuctions
          : 1.0;

      // Regress only when:
      //   - we have no family data (legacy path), OR
      //   - one family monopolises the workload (no useful stratification)
      const stratificationApplies = hasFamilySpread && maxFamilyShare < FAMILY_SPREAD_MAX_SHARE;
      if (!stratificationApplies) {
        return {
          newPhase: 'A',
          reason: `Market degeneracy: dominant engine wins ${(stats.dominantWinRate * 100).toFixed(0)}% of auctions`,
        };
      }
    }
  }

  if (current.currentPhase === 'D') {
    if (stats.distinctEnginesWithBids < 3 || stats.minSettledBidsPerEngine < 50) {
      return { newPhase: 'C', reason: 'Insufficient engine diversity for Phase D' };
    }
  }

  if (current.currentPhase === 'C') {
    if (stats.trustedRemotePeers < 1) {
      return { newPhase: 'B', reason: 'No trusted remote peers for Phase C' };
    }
  }

  if (current.currentPhase === 'B') {
    if (stats.activeEngines < 2 || stats.minTasksPerEngine < 50) {
      return { newPhase: 'A', reason: 'Insufficient engines/tasks for Phase B' };
    }
  }

  // Check activation conditions (advance)
  if (current.currentPhase === 'A') {
    if (stats.activeEngines >= 2 && stats.minTasksPerEngine >= 50 && stats.totalTraces >= 500) {
      return { newPhase: 'B', reason: 'Sufficient data for local auction' };
    }
  }

  if (current.currentPhase === 'B') {
    if (stats.auctionCount >= 100 && stats.trustedRemotePeers >= 1 && stats.minRemotePeerTasks >= 100) {
      return { newPhase: 'C', reason: 'Remote peers available for federated auction' };
    }
  }

  if (current.currentPhase === 'C') {
    if (stats.auctionCount >= 200 && stats.distinctEnginesWithBids >= 3 && stats.minSettledBidsPerEngine >= 50) {
      return { newPhase: 'D', reason: 'Sufficient bid data for full market' };
    }
  }

  return { newPhase: current.currentPhase, reason: 'No transition' };
}

/** Create initial phase state. */
export function createInitialPhaseState(): MarketPhaseState {
  return {
    currentPhase: 'A',
    activatedAt: Date.now(),
    auctionCount: 0,
    lastEvaluatedAt: Date.now(),
  };
}
