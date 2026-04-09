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
import { LEVEL_CONFIG } from '../gate/risk-router.ts';
import type { MarketScheduler } from '../economy/market/market-scheduler.ts';
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
}

export interface EngineSelector {
  select(routingLevel: RoutingLevel, taskType: string, requiredCapabilities?: string[]): EngineSelection;
}

export class DefaultEngineSelector implements EngineSelector {
  private trustStore: ProviderTrustStore;
  private bus?: VinyanBus;
  private marketScheduler?: MarketScheduler;

  constructor(config: EngineSelectorConfig) {
    this.trustStore = config.trustStore;
    this.bus = config.bus;
    this.marketScheduler = config.marketScheduler;
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

    // 3. If MarketScheduler is active, attempt auction-based selection
    if (this.marketScheduler?.isActive() && qualified.length >= 2) {
      // Market integration: auction among qualified providers
      // For now, emit event and fall through to Wilson LB — full auction wiring
      // requires bid solicitation from providers (future K2.4 work)
      this.bus?.emit('market:fallback_to_selector', {
        taskId: taskType,
        reason: 'Auction bid solicitation not yet wired',
      });
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
}
