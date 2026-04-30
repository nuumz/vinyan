/**
 * LLM Provider Registry — register and select providers by tier.
 *
 * Health-aware: when a `ProviderHealthStore` is configured, selection skips
 * providers in cooldown so a 429-exhausted Gemma free-tier never gets picked
 * again until its retryAfter window expires. Selection without a health store
 * preserves the legacy first-match behavior so tests and standalone callers
 * are unaffected.
 *
 * Adjacent-tier fallback rules (deterministic, A3):
 *   fast      → balanced → powerful
 *   balanced  → fast (cheaper before pricier) → powerful
 *   powerful  → balanced (no fast — accuracy regression too large)
 *   tool-uses → fast (only if explicitly allowed by caller)
 *
 * Source of truth: spec/tdd.md §17.1
 */
import type { LLMProvider, RoutingLevel } from '../types.ts';
import { engineIdFromWorker } from './engine-worker-binding.ts';
import type { ProviderHealthStore } from './provider-health.ts';

const LEVEL_TO_TIER: Record<RoutingLevel, LLMProvider['tier'] | null> = {
  0: null, // L0: no LLM (cached/scripted)
  1: 'fast',
  2: 'balanced',
  3: 'powerful',
  // Note: 'tool-uses' tier is not mapped to a routing level — it's selected explicitly
  // by components that need structured output / function calling (intent resolver, remediation)
};

const TIER_FALLBACK: Record<LLMProvider['tier'], LLMProvider['tier'][]> = {
  fast: ['balanced', 'powerful'],
  balanced: ['fast', 'powerful'],
  powerful: ['balanced'],
  'tool-uses': [],
};

export interface SelectionOptions {
  /**
   * Allow returning a provider even if it is in cooldown. Use for explicit
   * pinning where the caller has already accepted the wait — e.g. when the
   * health-aware governance wrapper has decided to honor a short
   * `retryAfterMs`. Selection-time events are still emitted so the dashboard
   * can show the override.
   */
  allowUnavailable?: boolean;
  /**
   * Try adjacent tiers when nothing is available in the requested tier.
   * Default: true. Set false for callers that need a specific tier (e.g.
   * tool-uses) and have a non-LLM fallback path.
   */
  allowAdjacentTier?: boolean;
  /** taskId for any selection-time observability events. */
  taskId?: string;
}

export interface SelectionResult {
  /** The chosen provider. `null` when no candidate matched the constraints. */
  provider: LLMProvider | null;
  /** True when the chosen provider is on a tier other than what was requested. */
  fellBackTier: boolean;
  /** Provider that was preferred but skipped because of cooldown. */
  skipped?: LLMProvider;
  /** Cooldown end-time for the skipped provider (epoch ms). */
  skippedCooldownUntil?: number;
}

export class LLMProviderRegistry {
  private providers = new Map<string, LLMProvider>();
  private healthStore?: ProviderHealthStore;

  /**
   * Wire a health store. Selection becomes cooldown-aware. Calling without
   * arguments unwires it (test helper). Idempotent.
   */
  setHealthStore(store: ProviderHealthStore | undefined): void {
    this.healthStore = store;
  }

  getHealthStore(): ProviderHealthStore | undefined {
    return this.healthStore;
  }

  register(provider: LLMProvider): void {
    this.providers.set(provider.id, provider);
  }

  /**
   * Tier-based selection. Backwards compatible — without a health store this
   * returns the first registered provider for the tier exactly like before.
   * With a health store, skips cooled-down providers and (by default) tries
   * adjacent tiers when the requested tier is exhausted.
   */
  selectByTier(tier: LLMProvider['tier'], options: SelectionOptions = {}): LLMProvider | undefined {
    return this.selectByTierDetailed(tier, options).provider ?? undefined;
  }

  /**
   * Detailed tier selection — exposes whether a fallback fired and which
   * provider was skipped, so the governance wrapper can emit
   * `llm:provider_fallback_selected` / `llm:provider_cooldown_skipped`
   * with accurate payloads.
   *
   * Adjacent-tier fallback ONLY fires when the requested tier has at least
   * one registered provider that is currently cooled-down. Tier with zero
   * registrations stays `undefined` so legacy callers that special-case "no
   * balanced configured → tool-uses fallback" preserve their behavior.
   */
  selectByTierDetailed(tier: LLMProvider['tier'], options: SelectionOptions = {}): SelectionResult {
    const allowAdjacent = options.allowAdjacentTier ?? false;
    const direct = this.firstHealthy(tier, options.allowUnavailable ?? false);
    if (direct) {
      return { provider: direct, fellBackTier: false };
    }

    // Capture the first cooled-down candidate for diagnostics. If the tier
    // had zero registered providers we DO NOT fall back — that path is
    // load-bearing for legacy callers (`selectByTier('balanced') ?? ...`).
    let skipped: LLMProvider | undefined;
    let skippedCooldownUntil: number | undefined;
    if (this.healthStore && !options.allowUnavailable) {
      const sample = this.firstOfTier(tier);
      if (sample) {
        const cool = this.healthStore.getCooldown({ id: sample.id });
        skipped = sample;
        if (cool) skippedCooldownUntil = cool.cooldownUntil;
      }
    }

    if (!allowAdjacent || !skipped) {
      return {
        provider: null,
        fellBackTier: false,
        ...(skipped ? { skipped } : {}),
        ...(skippedCooldownUntil !== undefined ? { skippedCooldownUntil } : {}),
      };
    }

    for (const t of TIER_FALLBACK[tier]) {
      const candidate = this.firstHealthy(t, options.allowUnavailable ?? false);
      if (candidate) {
        return {
          provider: candidate,
          fellBackTier: true,
          ...(skipped ? { skipped } : {}),
          ...(skippedCooldownUntil !== undefined ? { skippedCooldownUntil } : {}),
        };
      }
    }

    return {
      provider: null,
      fellBackTier: false,
      ...(skipped ? { skipped } : {}),
      ...(skippedCooldownUntil !== undefined ? { skippedCooldownUntil } : {}),
    };
  }

  selectForRoutingLevel(level: RoutingLevel, options: SelectionOptions = {}): LLMProvider | undefined {
    const tier = LEVEL_TO_TIER[level];
    if (!tier) return undefined; // L0 — no LLM
    return this.selectByTier(tier, options);
  }

  /**
   * Select a provider by worker ID.
   * Resolution order:
   *   1. Exact match on provider.id
   *   2. Strip "worker-" prefix and match (autoRegisterWorkers uses "worker-{provider.id}")
   *   3. Prefix match on modelId
   *
   * Health-aware: skips cooled-down candidates by default. Pass
   * `{ allowUnavailable: true }` to pin a specific id even when cooled down.
   */
  selectById(workerId: string, options: SelectionOptions = {}): LLMProvider | undefined {
    const candidate = this.resolveById(workerId);
    if (!candidate) return undefined;
    if (options.allowUnavailable) return candidate;
    if (this.isHealthy(candidate)) return candidate;
    return undefined;
  }

  /** Available providers for a tier — filtered by health when configured. */
  listAvailableByTier(tier: LLMProvider['tier']): LLMProvider[] {
    const out: LLMProvider[] = [];
    for (const provider of this.providers.values()) {
      if (provider.tier === tier && this.isHealthy(provider)) out.push(provider);
    }
    return out;
  }

  listProviders(): LLMProvider[] {
    return Array.from(this.providers.values());
  }

  get(id: string): LLMProvider | undefined {
    return this.providers.get(id);
  }

  // ── Internal ────────────────────────────────────────────────────────

  private resolveById(workerId: string): LLMProvider | undefined {
    const exact = this.providers.get(workerId);
    if (exact) return exact;
    const stripped = engineIdFromWorker(workerId);
    const byStripped = this.providers.get(stripped);
    if (byStripped) return byStripped;
    for (const provider of this.providers.values()) {
      if (stripped.startsWith(provider.id) || provider.id.startsWith(stripped)) {
        return provider;
      }
    }
    return undefined;
  }

  private firstOfTier(tier: LLMProvider['tier']): LLMProvider | undefined {
    for (const provider of this.providers.values()) {
      if (provider.tier === tier) return provider;
    }
    return undefined;
  }

  private firstHealthy(tier: LLMProvider['tier'], allowUnavailable: boolean): LLMProvider | undefined {
    for (const provider of this.providers.values()) {
      if (provider.tier !== tier) continue;
      if (allowUnavailable || this.isHealthy(provider)) return provider;
    }
    return undefined;
  }

  private isHealthy(provider: LLMProvider): boolean {
    if (!this.healthStore) return true;
    return this.healthStore.isAvailable({ id: provider.id });
  }
}
