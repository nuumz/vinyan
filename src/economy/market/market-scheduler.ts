/**
 * Market Scheduler — auction orchestration + phase management.
 *
 * Orchestrates: bid solicitation → Vickrey auction → settlement → accuracy tracking.
 * Falls back to direct selection when auction conditions unmet.
 *
 * A3 compliant: all decisions are rule-based.
 *
 * Source of truth: Economy OS plan §E3
 */
import type { VinyanBus } from '../../core/bus.ts';
import type { MarketConfig } from '../economy-config.ts';
import { computeBidSpread, detectCollusion } from './anti-gaming.ts';
import { type BidderContext, runAuction } from './auction-engine.ts';
import { BidAccuracyTracker } from './bid-accuracy-tracker.ts';
import { createInitialPhaseState, evaluateMarketPhase, type MarketPhaseStats } from './market-phase.ts';
import type { AuctionResult, EngineBid, MarketPhaseState } from './schemas.ts';
import { type ActualOutcome, isAccurateBid, settleBid } from './settlement-engine.ts';

export class MarketScheduler {
  private config: MarketConfig;
  private accuracyTracker: BidAccuracyTracker;
  private phaseState: MarketPhaseState;
  private bus: VinyanBus | undefined;
  private auctionHistory: Array<{ bidSpread: number }> = [];

  constructor(config: MarketConfig, bus?: VinyanBus) {
    this.config = config;
    this.accuracyTracker = new BidAccuracyTracker();
    this.phaseState = createInitialPhaseState();
    this.bus = bus;
  }

  /** Check if market is active (Phase B+). */
  isActive(): boolean {
    return this.config.enabled && this.phaseState.currentPhase !== 'A';
  }

  /** Get current market phase. */
  getPhase(): MarketPhaseState {
    return { ...this.phaseState };
  }

  /** Get accuracy tracker for external queries. */
  getAccuracyTracker(): BidAccuracyTracker {
    return this.accuracyTracker;
  }

  /**
   * Run an auction for a task. Returns null if auction not applicable
   * (falls back to direct selection).
   */
  allocate(
    taskId: string,
    bids: EngineBid[],
    contexts: Map<string, BidderContext>,
    taskBudgetTokens: number,
  ): AuctionResult | null {
    if (!this.isActive()) return null;
    if (bids.length < this.config.min_bidders) {
      this.bus?.emit('market:fallback_to_selector', { taskId, reason: `Only ${bids.length} bidder(s)` });
      return null;
    }

    // Filter expired bids
    const now = Date.now();
    const validBids = bids.filter((b) => !b.expiresAt || b.expiresAt > now);
    if (validBids.length < this.config.min_bidders) return null;

    const auctionId = `auc-${taskId}-${now}`;
    this.bus?.emit('market:auction_started', { auctionId, taskId, eligibleBidders: validBids.length });

    // Inject accuracy data into contexts
    for (const [bidderId, ctx] of contexts) {
      ctx.bidAccuracy = this.accuracyTracker.getAccuracy(bidderId);
    }

    const result = runAuction(auctionId, taskId, validBids, contexts, taskBudgetTokens, this.phaseState.currentPhase);
    if (!result) return null;

    // Track bid spread for collusion detection
    const spread = computeBidSpread(
      validBids.map((b) => ({ estimatedTokens: b.estimatedTokensInput + b.estimatedTokensOutput })),
    );
    this.auctionHistory.push({ bidSpread: spread });
    if (this.auctionHistory.length > 100) this.auctionHistory.shift();

    // Check for collusion
    const collusionAlert = detectCollusion(this.auctionHistory);
    if (collusionAlert) {
      this.bus?.emit('market:collusion_suspected', {
        auctionId,
        bidSpread: spread,
        consecutiveCount: this.auctionHistory.length,
      });
    }

    this.phaseState.auctionCount++;
    this.bus?.emit('market:auction_completed', {
      auctionId,
      taskId,
      winnerId: result.winnerId,
      score: result.winnerScore,
      bidderCount: result.bidderCount,
    });

    return result;
  }

  /**
   * Record settlement after task completion.
   */
  settle(bid: EngineBid, actual: ActualOutcome): void {
    const settlement = settleBid(bid, actual);
    this.accuracyTracker.recordSettlement(settlement);

    const accurate = isAccurateBid(settlement);
    this.bus?.emit('market:settlement_recorded', {
      settlementId: settlement.settlementId,
      bidAccuracy: settlement.composite_accuracy,
      penaltyType: settlement.penalty_type,
    });

    // Feed back to trust store via bus
    const payload = { provider: bid.bidderId, capability: undefined, taskId: settlement.settlementId };
    if (accurate) {
      this.bus?.emit('market:settlement_accurate', payload);
    } else {
      this.bus?.emit('market:settlement_inaccurate', payload);
    }
  }

  /**
   * Check if market should auto-activate (A → B transition).
   * Called from engine-selector before auction attempt.
   */
  checkAutoActivation(costRecordCount: number, engineCount: number): boolean {
    if (this.phaseState.currentPhase !== 'A') return false;
    const minRecords = this.config.min_cost_records ?? 200;
    const minBidders = this.config.min_bidders ?? 2;
    if (costRecordCount >= minRecords && engineCount >= minBidders) {
      const oldPhase = this.phaseState.currentPhase;
      this.phaseState.currentPhase = 'B';
      this.phaseState.activatedAt = Date.now();
      this.bus?.emit('market:auto_activated', {
        costRecordCount,
        engineCount,
        fromPhase: oldPhase,
        toPhase: 'B',
      });
      this.bus?.emit('market:phase_transition', {
        from: oldPhase,
        to: 'B',
        reason: `Auto-activated: ${costRecordCount} cost records, ${engineCount} engines`,
      });
      return true;
    }
    return false;
  }

  /**
   * Evaluate phase transition (called periodically, e.g., during Sleep Cycle).
   */
  evaluatePhase(stats: MarketPhaseStats): void {
    const transition = evaluateMarketPhase(this.phaseState, stats);
    if (transition.newPhase !== this.phaseState.currentPhase) {
      this.bus?.emit('market:phase_transition', {
        from: this.phaseState.currentPhase,
        to: transition.newPhase,
        reason: transition.reason,
      });
      this.phaseState.currentPhase = transition.newPhase;
      this.phaseState.activatedAt = Date.now();
    }
    this.phaseState.lastEvaluatedAt = Date.now();
  }
}
