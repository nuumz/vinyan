/**
 * Engine Selector — K2.2 trust-weighted engine selection.
 *
 * Orchestrates provider selection for task dispatch:
 * 1. Filter by capability match
 * 2. Filter by minimum trust threshold for routing level
 * 3. If MarketScheduler active → delegate to auction
 * 4. Else → rank by Wilson LB (selectProvider)
 * 5. Fallback: LEVEL_CONFIG default model
 *
 * A3 compliant: all decisions are rule-based, zero LLM in governance path.
 * A5 compliant: trust tiers — deterministic > heuristic > probabilistic.
 */
import type { VinyanBus } from '../core/bus.ts';
import type { ProviderTrustStore } from '../db/provider-trust-store.ts';
import type { CostPredictor } from '../economy/cost-predictor.ts';
import type { BidderContext } from '../economy/market/auction-engine.ts';
import type { MarketScheduler } from '../economy/market/market-scheduler.ts';
import type { EngineBid } from '../economy/market/schemas.ts';
import { LEVEL_CONFIG } from '../gate/risk-router.ts';
import type { RoutingLevel } from './types.ts';
import { selectProvider } from './priority-router.ts';
import { wilsonLowerBound } from '../sleep-cycle/wilson.ts';

export interface EngineSelection {
  provider: string;
  trustScore: number;
  selectionReason: string;
}

/** Minimum trust thresholds per routing level — higher levels demand more trust. */
const TRUST_THRESHOLDS: Record<RoutingLevel, number> = {
  0: 0,
  1: 0.3,
  2: 0.5,
  3: 0.7,
};

export interface EngineSelectorConfig {
  trustStore: ProviderTrustStore;
  bus?: VinyanBus;
  marketScheduler?: MarketScheduler;
  costPredictor?: CostPredictor;
}

export interface EngineSelector {
  select(routingLevel: RoutingLevel, taskType: string, requiredCapabilities?: string[]): EngineSelection;
}

export class DefaultEngineSelector implements EngineSelector {
  private trustStore: ProviderTrustStore;
  private bus?: VinyanBus;
  private marketScheduler?: MarketScheduler;
  private costPredictor?: CostPredictor;

  constructor(config: EngineSelectorConfig) {
    this.trustStore = config.trustStore;
    this.bus = config.bus;
    this.marketScheduler = config.marketScheduler;
    this.costPredictor = config.costPredictor;
  }

  select(routingLevel: RoutingLevel, taskType: string, requiredCapabilities?: string[]): EngineSelection {
    const defaultModel = LEVEL_CONFIG[routingLevel].model;
    const minTrust = TRUST_THRESHOLDS[routingLevel];

    // 1. Get all providers, optionally filtered by capability
    const capability = requiredCapabilities?.[0];
    const providers = capability
      ? this.trustStore.getProvidersByCapability(capability)
      : this.trustStore.getAllProviders();

    // 2. Filter by minimum trust threshold
    const qualified = providers.filter((p) => {
      const total = p.successes + p.failures;
      if (total === 0) return true; // cold-start providers pass (benefit of the doubt)
      const score = wilsonLowerBound(p.successes, total, 1.96);
      return score >= minTrust;
    });

    // 3. Auto-activate market if sufficient data
    if (this.marketScheduler && !this.marketScheduler.isActive() && qualified.length >= 2) {
      const providerCount = providers.length;
      // Use total records across all providers as proxy for cost record count
      const totalRecords = providers.reduce((sum, p) => sum + p.successes + p.failures, 0);
      this.marketScheduler.checkAutoActivation(totalRecords, providerCount);
    }

    // 4. If MarketScheduler is active, attempt auction-based selection
    if (this.marketScheduler?.isActive() && qualified.length >= 2) {
      const auctionResult = this.attemptAuction(taskType, routingLevel, qualified, defaultModel ?? 'unknown');
      if (auctionResult) {
        this.bus?.emit('engine:selected', {
          taskId: taskType,
          provider: auctionResult.provider,
          trustScore: auctionResult.trustScore,
          reason: auctionResult.selectionReason,
        });
        return auctionResult;
      }
    }

    // 4. Rank by Wilson LB trust score
    const selection = selectProvider(this.trustStore, defaultModel, capability);

    // 5. Check if selected provider meets minimum trust for this level
    if (selection.trustScore < minTrust && selection.basis === 'wilson_lb') {
      // Selected provider doesn't meet threshold — use default
      return {
        provider: defaultModel ?? 'unknown',
        trustScore: 0.5,
        selectionReason: `trust-below-threshold:${selection.trustScore.toFixed(2)}<${minTrust}`,
      };
    }

    const result: EngineSelection = {
      provider: selection.provider,
      trustScore: selection.trustScore,
      selectionReason: selection.basis === 'cold_start'
        ? 'cold-start-default'
        : `wilson-lb:${capability ?? '*'}`,
    };

    this.bus?.emit('engine:selected', {
      taskId: taskType,
      provider: result.provider,
      trustScore: result.trustScore,
      reason: result.selectionReason,
    });

    return result;
  }

  /**
   * Build bids from qualified providers and run a Vickrey auction.
   * Returns null if auction fails (falls back to Wilson LB).
   */
  private attemptAuction(
    taskType: string,
    routingLevel: RoutingLevel,
    qualified: Array<{ provider: string; successes: number; failures: number }>,
    defaultModel: string,
  ): EngineSelection | null {
    if (!this.marketScheduler) return null;

    const now = Date.now();
    const budgetTokens = LEVEL_CONFIG[routingLevel]?.budgetTokens ?? 10_000;

    // Generate bids from cost predictor or cold-start
    const bids: EngineBid[] = [];
    const contexts = new Map<string, BidderContext>();

    for (const p of qualified) {
      const prediction = this.costPredictor?.predict(taskType, routingLevel);
      const total = p.successes + p.failures;
      const trustScore = total > 0 ? wilsonLowerBound(p.successes, total, 1.96) : 0.5;

      bids.push({
        bidId: `bid-${p.provider}-${now}`,
        auctionId: '', // filled by MarketScheduler
        bidderId: p.provider,
        bidderType: 'local',
        estimatedTokensInput: prediction ? Math.round(prediction.predicted_usd * 500_000) : budgetTokens / 2,
        estimatedTokensOutput: prediction ? Math.round(prediction.predicted_usd * 250_000) : budgetTokens / 2,
        estimatedDurationMs: 5000,
        estimatedUsd: prediction?.predicted_usd,
        declaredConfidence: trustScore,
        acceptsTokenBudget: budgetTokens,
        acceptsTimeLimitMs: LEVEL_CONFIG[routingLevel]?.latencyBudgetMs ?? 10_000,
        submittedAt: now,
      });

      contexts.set(p.provider, {
        successes: p.successes,
        failures: p.failures,
        capabilityScore: trustScore,
        bidAccuracy: null, // filled by MarketScheduler
      });
    }

    const result = this.marketScheduler.allocate(`task-${taskType}`, bids, contexts, budgetTokens);
    if (!result) {
      this.bus?.emit('market:fallback_to_selector', {
        taskId: taskType,
        reason: 'Auction returned no winner',
      });
      return null;
    }

    // Find trust score for winner
    const winner = qualified.find((p) => p.provider === result.winnerId);
    const winnerTotal = winner ? winner.successes + winner.failures : 0;
    const winnerTrust = winnerTotal > 0 ? wilsonLowerBound(winner!.successes, winnerTotal, 1.96) : 0.5;

    return {
      provider: result.winnerId,
      trustScore: winnerTrust,
      selectionReason: `auction:score=${result.winnerScore.toFixed(3)}`,
    };
  }
}
