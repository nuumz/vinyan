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
import { FamilyStatsTracker } from './family-stats-tracker.ts';
import { createInitialPhaseState, evaluateMarketPhase, type MarketPhaseStats } from './market-phase.ts';
import type { AuctionResult, EngineBid, MarketPhaseState } from './schemas.ts';
import { type ActualOutcome, isAccurateBid, settleBid } from './settlement-engine.ts';

/**
 * Log a tick-hook failure without crashing the loop (A6). Uses `console.warn`
 * intentionally — MarketScheduler has no injected logger today, and adding
 * one purely for this path would balloon the contract. The bus does not
 * carry a `market:tick_hook_failed` event in the current EventMap.
 */
function logTickHookFailure(err: unknown): void {
  // eslint-disable-next-line no-console
  console.warn('[market-scheduler] tick hook threw', {
    err: err instanceof Error ? err.message : String(err),
  });
}

export class MarketScheduler {
  private config: MarketConfig;
  private accuracyTracker: BidAccuracyTracker;
  private phaseState: MarketPhaseState;
  private bus: VinyanBus | undefined;
  private auctionHistory: Array<{ bidSpread: number; distinctPersonaCount?: number }> = [];
  /**
   * Phase-8: per-task-family auction stats. Records every winning bid with its
   * task-type-family so `evaluateMarketPhase` can apply the H6 stratified
   * regression rule with real data instead of hardcoded zeros.
   */
  private familyStats: import('./family-stats-tracker.ts').FamilyStatsTracker;
  /**
   * Tick hooks registered via {@link registerTickHook}. Invoked on every
   * {@link tick} call after the scheduler's own work completes. See
   * `docs/spec/w1-contracts.md` §9.A3.
   */
  private tickHooks: Array<() => void | Promise<void>> = [];

  constructor(config: MarketConfig, bus?: VinyanBus) {
    this.config = config;
    this.accuracyTracker = new BidAccuracyTracker();
    this.phaseState = createInitialPhaseState();
    this.bus = bus;
    this.familyStats = new FamilyStatsTracker();
  }

  /**
   * Register a callback fired on every {@link tick}. Hooks run AFTER the
   * scheduler's own tick work; exceptions are logged but do not break the
   * loop (A6 — hooks cannot DoS the market).
   *
   * Returns an unsubscribe function that removes the hook when called.
   * Contract: w1-contracts §9.A3.
   */
  registerTickHook(fn: () => void | Promise<void>): () => void {
    this.tickHooks.push(fn);
    return () => {
      const idx = this.tickHooks.indexOf(fn);
      if (idx >= 0) this.tickHooks.splice(idx, 1);
    };
  }

  /**
   * Drive a single tick. The scheduler itself currently has no internal
   * per-tick work (phase transitions are evaluated via
   * {@link evaluatePhase}); the hook invocation loop exists so external
   * consumers (e.g. `ScheduleRunner`) can piggyback on the scheduler's
   * clock rather than spinning a parallel timer. A3-aligned single clock.
   *
   * A failing hook is logged via the bus and isolated — subsequent hooks
   * still run. A misbehaving hook cannot crash the loop (A6).
   */
  tick(): void {
    // Snapshot to defend against hooks mutating the array mid-iteration
    // (e.g., a hook that unsubscribes itself).
    const hooks = [...this.tickHooks];
    for (const hook of hooks) {
      try {
        const r = hook();
        if (r instanceof Promise) {
          r.catch((err) => {
            logTickHookFailure(err);
          });
        }
      } catch (err) {
        logTickHookFailure(err);
      }
    }
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
   *
   * Phase-3: optional `requiredCapabilities` is forwarded to `runAuction` so
   * the scorer's `skillMatch` factor attenuates bids by capability coverage.
   */
  allocate(
    taskId: string,
    bids: EngineBid[],
    contexts: Map<string, BidderContext>,
    taskBudgetTokens: number,
    requiredCapabilities?: ReadonlyArray<{ id: string; weight: number }>,
    /**
     * Phase-8: task-type-family for per-family auction stats (H6
     * stratified regression). Optional — callers without taskType info
     * use the default `UNKNOWN_FAMILY` bucket so global dominance still
     * tracks correctly.
     */
    taskTypeFamily?: string,
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

    const result = runAuction(
      auctionId,
      taskId,
      validBids,
      contexts,
      taskBudgetTokens,
      this.phaseState.currentPhase,
      requiredCapabilities,
    );
    if (!result) return null;

    // Phase-8: record the winner in the family-stats window so subsequent
    // `evaluatePhase` calls can apply the H6 stratified regression rule
    // with real data. Family defaults to UNKNOWN_FAMILY when caller omits it.
    this.familyStats.addAuction(result.winnerId, taskTypeFamily);

    // Track bid spread for collusion detection. Phase-3: also count distinct
    // personas so the detector can skip auctions where all bidders are running
    // the same persona/skill loadout (tight spread is expected, not collusion
    // — risk H7).
    const spread = computeBidSpread(
      validBids.map((b) => ({ estimatedTokens: b.estimatedTokensInput + b.estimatedTokensOutput })),
    );
    const personaIds = validBids
      .map((b) => b.personaId)
      .filter((id): id is string => typeof id === 'string' && id.length > 0);
    const distinctPersonaCount = personaIds.length > 0 ? new Set(personaIds).size : undefined;
    this.auctionHistory.push({ bidSpread: spread, distinctPersonaCount });
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
   * Phase-8: snapshot the per-task-family auction stats so callers (sleep
   * cycle) can compose a real `MarketPhaseStats` instead of passing
   * hardcoded zeros for `dominantWinRate` / `auctionsByFamily`.
   */
  getFamilyStats(): import('./family-stats-tracker.ts').FamilyStats {
    return this.familyStats.getStats();
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
