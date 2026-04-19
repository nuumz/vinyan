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
import { wilsonLowerBound } from '../sleep-cycle/wilson.ts';
import type { DepartmentIndex } from './ecosystem/department.ts';
import type { RuntimeStateManager } from './ecosystem/runtime-state.ts';
import { selectProvider } from './priority-router.ts';
import type { RoutingLevel } from './types.ts';

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

/**
 * Book-integration Wave 4.2: role hint taxonomy (App C Cost Analysis + Ch07).
 *
 * The book's explicit cost guidance maps each role to a preferred model
 * tier. Vinyan's engine selector previously picked purely by routing
 * level + trust; this hint lets callers express "I'm going to use this
 * engine for a read — prefer the cheap tier" as a deterministic
 * preference (not a constraint).
 *
 *   'read'      ⇒ prefer 'fast'      (Haiku for research / exploration)
 *   'implement' ⇒ prefer 'balanced'  (Sonnet for codegen)
 *   'debate'    ⇒ prefer 'powerful'  (Opus for debates / trade-off)
 *   'verify'    ⇒ prefer 'balanced' then 'tool-uses'
 *
 * When the preferred tier is not available the selector falls back to
 * the existing Wilson-LB / trust-threshold path — the hint is
 * *preference*, never *constraint*. This preserves A5 tiered-trust
 * semantics and A3 determinism.
 */
export type RoleHint = 'read' | 'implement' | 'debate' | 'verify';

const ROLE_PREFERRED_TIERS: Record<RoleHint, ReadonlyArray<'fast' | 'balanced' | 'powerful' | 'tool-uses'>> = {
  read: ['fast'],
  implement: ['balanced'],
  debate: ['powerful'],
  verify: ['balanced', 'tool-uses'],
};

export interface EngineSelectorConfig {
  trustStore: ProviderTrustStore;
  bus?: VinyanBus;
  marketScheduler?: MarketScheduler;
  costPredictor?: CostPredictor;
  /**
   * Wave 4.2: optional callback returning the tier of a given provider
   * id ('fast' | 'balanced' | 'powerful' | 'tool-uses'). When present
   * AND a `roleHint` is passed to `select()`, the selector biases its
   * pick toward the role's preferred tier. When absent or when no
   * qualified provider matches the preferred tier, selection falls
   * through to the existing Wilson-LB / trust-threshold path.
   *
   * Factory wires this from the LLMProviderRegistry's tier metadata.
   */
  getProviderTier?: (providerId: string) => 'fast' | 'balanced' | 'powerful' | 'tool-uses' | undefined;
  /**
   * Ecosystem O1: when provided, the selector excludes providers whose
   * runtime state is dormant/awakening. Working engines pass through
   * (capacity is checked downstream at dispatch). No-op for providers the
   * manager doesn't know about — backward compatible.
   */
  runtimeStateManager?: RuntimeStateManager;
  /**
   * Ecosystem O3: when provided AND the caller passes a `departmentId`,
   * the candidate pool is narrowed to that department's members first.
   * Falls back to the full pool when the department has no members.
   */
  departmentIndex?: DepartmentIndex;
  /**
   * Ecosystem O4: fallback callback invoked when the market and wilson-LB
   * paths both fail to produce a trusted pick. Usually wired to
   * `EcosystemCoordinator.attemptVolunteerFallback`.
   */
  volunteerFallback?: VolunteerFallback;
}

export interface SelectOptions {
  /** Narrow candidates to this department when the index has members. */
  departmentId?: string;
}

/**
 * Ecosystem O4 hook — invoked when the market + wilson-LB paths can't
 * produce a trusted pick. Returns the engineId chosen by the volunteer
 * protocol, or null when no eligible engine volunteered. Supplied by the
 * factory when the ecosystem is enabled.
 */
export type VolunteerFallback = (params: {
  taskId: string;
  routingLevel: RoutingLevel;
  departmentId?: string;
}) => string | null;

export interface EngineSelector {
  select(
    routingLevel: RoutingLevel,
    taskType: string,
    requiredCapabilities?: string[],
    roleHint?: RoleHint,
    options?: SelectOptions,
  ): EngineSelection;
}

export class DefaultEngineSelector implements EngineSelector {
  private trustStore: ProviderTrustStore;
  private bus?: VinyanBus;
  private marketScheduler?: MarketScheduler;
  private costPredictor?: CostPredictor;
  private getProviderTier?: (providerId: string) => 'fast' | 'balanced' | 'powerful' | 'tool-uses' | undefined;
  private runtimeStateManager?: RuntimeStateManager;
  private departmentIndex?: DepartmentIndex;
  private volunteerFallback?: VolunteerFallback;

  constructor(config: EngineSelectorConfig) {
    this.trustStore = config.trustStore;
    this.bus = config.bus;
    this.marketScheduler = config.marketScheduler;
    this.costPredictor = config.costPredictor;
    this.getProviderTier = config.getProviderTier;
    this.runtimeStateManager = config.runtimeStateManager;
    this.departmentIndex = config.departmentIndex;
    this.volunteerFallback = config.volunteerFallback;
  }

  select(
    routingLevel: RoutingLevel,
    taskType: string,
    requiredCapabilities?: string[],
    roleHint?: RoleHint,
    options?: SelectOptions,
  ): EngineSelection {
    const defaultModel = LEVEL_CONFIG[routingLevel].model;
    const minTrust = TRUST_THRESHOLDS[routingLevel];

    // 1. Get all providers, optionally filtered by capability
    const capability = requiredCapabilities?.[0];
    let providers = capability
      ? this.trustStore.getProvidersByCapability(capability)
      : this.trustStore.getAllProviders();

    // 1a. Ecosystem O1 — drop providers whose runtime state is dormant/awakening.
    //     Unknown providers pass through (the manager only knows engines it
    //     has registered; cold-start / test paths shouldn't be blocked).
    if (this.runtimeStateManager) {
      const mgr = this.runtimeStateManager;
      providers = providers.filter((p) => {
        const snap = mgr.get(p.provider);
        if (!snap) return true;
        return snap.state === 'standby' || snap.state === 'working';
      });
    }

    // 1b. Ecosystem O3 — when the caller asks for a department and the
    //     department has members, intersect. Fall back to the full pool
    //     when intersection is empty so we never hard-block.
    if (options?.departmentId && this.departmentIndex) {
      const members = new Set(this.departmentIndex.getEnginesInDepartment(options.departmentId));
      if (members.size > 0) {
        const scoped = providers.filter((p) => members.has(p.provider));
        if (scoped.length > 0) providers = scoped;
      }
    }

    // 2. Filter by minimum trust threshold
    const qualified = providers.filter((p) => {
      const total = p.successes + p.failures;
      if (total === 0) return true; // cold-start providers pass (benefit of the doubt)
      const score = wilsonLowerBound(p.successes, total, 1.96);
      return score >= minTrust;
    });

    // 2b. Wave 4.2: role-hint bias. If the caller asked for a specific
    // role AND we have a tier-lookup callback AND at least one qualified
    // provider matches the role's preferred tier, pick the best such
    // provider by Wilson LB and return early. Otherwise fall through to
    // the existing auction / priority-router path so the hint never
    // prevents selection.
    if (roleHint && this.getProviderTier && qualified.length > 0) {
      const preferred = ROLE_PREFERRED_TIERS[roleHint];
      for (const tier of preferred) {
        const matchingProviders = qualified.filter((p) => this.getProviderTier!(p.provider) === tier);
        if (matchingProviders.length === 0) continue;
        // Pick the best-scoring provider within the preferred tier.
        const scored = matchingProviders.map((p) => {
          const total = p.successes + p.failures;
          const score = total > 0 ? wilsonLowerBound(p.successes, total, 1.96) : 0.5;
          return { provider: p.provider, score };
        });
        scored.sort((a, b) => b.score - a.score);
        const winner = scored[0]!;
        const result: EngineSelection = {
          provider: winner.provider,
          trustScore: winner.score,
          selectionReason: `role-hint:${roleHint}→${tier}`,
        };
        this.bus?.emit('engine:selected', {
          taskId: taskType,
          provider: result.provider,
          trustScore: result.trustScore,
          reason: result.selectionReason,
        });
        return result;
      }
      // None of the preferred tiers had a qualified provider — fall
      // through to the existing selection path below. The hint is
      // preference-only; it must not prevent selection.
    }

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
      // 5a. Ecosystem O4 — market + wilson-LB both failed. Try the volunteer
      //     fallback before giving up to the default cold-start model.
      if (this.volunteerFallback) {
        const winner = this.volunteerFallback({
          taskId: taskType,
          routingLevel,
          ...(options?.departmentId ? { departmentId: options.departmentId } : {}),
        });
        if (winner) {
          const result: EngineSelection = {
            provider: winner,
            trustScore: 0.5,
            selectionReason: 'volunteer-fallback',
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
      selectionReason: selection.basis === 'cold_start' ? 'cold-start-default' : `wilson-lb:${capability ?? '*'}`,
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
