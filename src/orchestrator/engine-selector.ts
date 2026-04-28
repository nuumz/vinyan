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
  /**
   * Cost / classification key used by `CostPredictor` and the bid pipeline.
   * Independent from the `taskId` argument — `taskId` identifies *which*
   * task is being scheduled, while `taskType` identifies *what kind* of
   * work it is for cost prediction. Defaults to the literal `taskId` when
   * absent so legacy callers retain prior behavior, but production callers
   * (phase-predict) should pass the real `TaskInput.taskType`.
   */
  taskType?: string;
  /**
   * Phase-3 — persona-aware bidding. When the dispatcher has resolved a
   * persona for this task, it forwards the persona's loaded skills and
   * declared capabilities here so each generated bid carries the same
   * persona identity. The auction's `skillMatch` factor consumes
   * `declaredCapabilityIds`; the per-skill outcome attribution path keys on
   * `personaId` × `loadedSkillIds` × taskSignature. Optional — legacy callers
   * (no persona resolved) leave this undefined and bids stay provider-only.
   */
  personaContext?: PersonaBidContext;
}

/**
 * Persona dispatch context passed into the auction. Built by the agent
 * registry's `getDerivedCapabilities` consumer in the core-loop / dispatch
 * path. Phase 3 uses every field; Phase 4 layers per-skill outcome attribution
 * on top.
 */
export interface PersonaBidContext {
  personaId: string;
  loadedSkillIds: string[];
  declaredCapabilityIds: string[];
  /** sha256 hex of sorted `loadedSkillIds`. Caller computes; selector forwards. */
  skillFingerprint?: string;
  /** Tokens consumed by the persona's skill-card prompt overhead. */
  skillTokenOverhead?: number;
  /** Required capabilities for this task — drives `skillMatch` in scoreBid. */
  requiredCapabilities?: ReadonlyArray<{ id: string; weight: number }>;
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
  /**
   * Select an engine for a task.
   *
   * @param routingLevel — risk tier (drives trust threshold + default model).
   * @param taskId — the real `TaskInput.id`. Used as the auction id, in
   *   `engine:selected` events, in volunteer-fallback hooks, and as the
   *   commitment-bridge key. Do NOT pass goal prefixes or task types here.
   * @param requiredCapabilities — optional capability filter.
   * @param roleHint — optional book-tier hint (read/implement/debate/verify).
   * @param options — narrows pool by department; `options.taskType` is the
   *   cost-prediction key (`'code'` / `'reasoning'`).
   */
  select(
    routingLevel: RoutingLevel,
    taskId: string,
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
    taskId: string,
    requiredCapabilities?: string[],
    roleHint?: RoleHint,
    options?: SelectOptions,
  ): EngineSelection {
    const defaultModel = LEVEL_CONFIG[routingLevel].model;
    const minTrust = TRUST_THRESHOLDS[routingLevel];
    // Cost-prediction / auction-scoring key. Falls back to taskId when the
    // caller hasn't supplied a separate cost key (preserves test ergonomics).
    const costKey = options?.taskType ?? taskId;

    // 1. Get all providers, optionally filtered by capability
    const capability = requiredCapabilities?.[0];
    let providers = capability
      ? this.trustStore.getProvidersByCapability(capability)
      : this.trustStore.getAllProviders();

    // 1a. Ecosystem O1 + O4 — drop providers whose runtime state is
    //     dormant/awakening, AND drop `working` providers that are at or
    //     above their capacity (cannot accept more work right now).
    //     Unknown providers pass through (the manager only knows engines it
    //     has registered; cold-start / test paths shouldn't be blocked).
    if (this.runtimeStateManager) {
      const mgr = this.runtimeStateManager;
      providers = providers.filter((p) => {
        const snap = mgr.get(p.provider);
        if (!snap) return true;
        if (snap.state === 'standby') return true;
        if (snap.state === 'working') return snap.activeTaskCount < snap.capacityMax;
        return false; // dormant / awakening
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
          taskId,
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
      const auctionResult = this.attemptAuction(
        taskId,
        costKey,
        routingLevel,
        qualified,
        defaultModel ?? 'unknown',
        options?.personaContext,
      );
      if (auctionResult) {
        this.bus?.emit('engine:selected', {
          taskId,
          provider: auctionResult.provider,
          trustScore: auctionResult.trustScore,
          reason: auctionResult.selectionReason,
        });
        return auctionResult;
      }
    }

    // 4. Rank by Wilson LB trust score.
    //
    // When the runtime/department filter actually narrowed the pool, we
    // must rank within the filtered `qualified` set — delegating to
    // `selectProvider` would consult the unfiltered trust store and could
    // re-introduce a provider that is dormant or at capacity. We compute
    // the same Wilson-LB ranking inline so behavior matches `priority-router`
    // for the unfiltered case.
    const filterApplied = this.runtimeStateManager !== undefined || options?.departmentId !== undefined;
    let selection: { provider: string; trustScore: number; basis: 'wilson_lb' | 'cold_start' };
    if (filterApplied) {
      let bestProvider = defaultModel ?? 'unknown';
      let bestScore = -1;
      for (const p of qualified) {
        const total = p.successes + p.failures;
        if (total === 0) continue;
        const score = wilsonLowerBound(p.successes, total, 1.96);
        if (score > bestScore) {
          bestScore = score;
          bestProvider = p.provider;
        }
      }
      selection =
        bestScore < 0
          ? { provider: defaultModel ?? 'unknown', trustScore: 0.5, basis: 'cold_start' }
          : { provider: bestProvider, trustScore: bestScore, basis: 'wilson_lb' };
    } else {
      selection = selectProvider(this.trustStore, defaultModel, capability);
    }

    // 5. Check if selected provider meets minimum trust for this level
    if (selection.trustScore < minTrust && selection.basis === 'wilson_lb') {
      // 5a. Ecosystem O4 — market + wilson-LB both failed. Try the volunteer
      //     fallback before giving up to the default cold-start model.
      if (this.volunteerFallback) {
        const winner = this.volunteerFallback({
          taskId,
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
            taskId,
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
      taskId,
      provider: result.provider,
      trustScore: result.trustScore,
      reason: result.selectionReason,
    });

    return result;
  }

  /**
   * Build bids from qualified providers and run a Vickrey auction.
   * Returns null if auction fails (falls back to Wilson LB).
   *
   * Phase-3: when `personaContext` is supplied, every generated bid is
   * stamped with the persona id, loaded skills, and declared capabilities
   * so the auction's `skillMatch` factor can attenuate scores by required-
   * capability coverage. `requiredCapabilities` is forwarded to the scheduler.
   */
  private attemptAuction(
    taskId: string,
    costKey: string,
    routingLevel: RoutingLevel,
    qualified: Array<{ provider: string; successes: number; failures: number }>,
    defaultModel: string,
    personaContext?: PersonaBidContext,
  ): EngineSelection | null {
    if (!this.marketScheduler) return null;

    const now = Date.now();
    const budgetTokens = LEVEL_CONFIG[routingLevel]?.budgetTokens ?? 10_000;

    // Generate bids from cost predictor or cold-start. Cost prediction is
    // keyed by `costKey` (taskType) so similar tasks share history; the
    // auction itself is keyed by the real `taskId` so commitment lookup,
    // tracing, and reconcile work end-to-end.
    const bids: EngineBid[] = [];
    const contexts = new Map<string, BidderContext>();

    for (const p of qualified) {
      const prediction = this.costPredictor?.predict(costKey, routingLevel);
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
        // Phase-3 persona attribution. Same persona/skill loadout is shared
        // across every provider bidding for this task — the auction picks
        // *which provider* runs the persona, not which persona to run.
        personaId: personaContext?.personaId,
        loadedSkillIds: personaContext?.loadedSkillIds,
        declaredCapabilityIds: personaContext?.declaredCapabilityIds,
        skillFingerprint: personaContext?.skillFingerprint,
        skillTokenOverhead: personaContext?.skillTokenOverhead,
      });

      contexts.set(p.provider, {
        successes: p.successes,
        failures: p.failures,
        capabilityScore: trustScore,
        bidAccuracy: null, // filled by MarketScheduler
      });
    }

    const result = this.marketScheduler.allocate(
      taskId,
      bids,
      contexts,
      budgetTokens,
      personaContext?.requiredCapabilities,
    );
    if (!result) {
      this.bus?.emit('market:fallback_to_selector', {
        taskId,
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
