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
  dominantWinRate: number;
}

export interface PhaseTransition {
  newPhase: MarketPhase;
  reason: string;
}

/**
 * Evaluate market phase based on current stats.
 * Pure function: same inputs → same output (A3).
 */
export function evaluateMarketPhase(current: MarketPhaseState, stats: MarketPhaseStats): PhaseTransition {
  // Check deactivation conditions (regress)
  if (current.currentPhase !== 'A') {
    // Market degeneracy: >90% single winner over 50 auctions
    if (stats.auctionCount >= 50 && stats.dominantWinRate > 0.9) {
      return {
        newPhase: 'A',
        reason: `Market degeneracy: dominant engine wins ${(stats.dominantWinRate * 100).toFixed(0)}% of auctions`,
      };
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
