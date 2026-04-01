/**
 * LLM Provider Registry — register and select providers by tier.
 * Source of truth: spec/tdd.md §17.1
 */
import type { LLMProvider, RoutingLevel } from "../types.ts";

const LEVEL_TO_TIER: Record<RoutingLevel, LLMProvider["tier"] | null> = {
  0: null,       // L0: no LLM (cached/scripted)
  1: "fast",
  2: "balanced",
  3: "powerful",
};

export class LLMProviderRegistry {
  private providers = new Map<string, LLMProvider>();

  register(provider: LLMProvider): void {
    this.providers.set(provider.id, provider);
  }

  selectByTier(tier: LLMProvider["tier"]): LLMProvider | undefined {
    for (const provider of this.providers.values()) {
      if (provider.tier === tier) return provider;
    }
    return undefined;
  }

  selectForRoutingLevel(level: RoutingLevel): LLMProvider | undefined {
    const tier = LEVEL_TO_TIER[level];
    if (!tier) return undefined; // L0 — no LLM
    return this.selectByTier(tier);
  }

  /**
   * Select a provider by worker ID.
   * Resolution order:
   *   1. Exact match on provider.id
   *   2. Strip "worker-" prefix and match (autoRegisterWorkers uses "worker-{provider.id}")
   *   3. Prefix match on modelId
   */
  selectById(workerId: string): LLMProvider | undefined {
    // Exact match first
    const exact = this.providers.get(workerId);
    if (exact) return exact;

    // Strip "worker-" prefix — autoRegisterWorkers creates IDs as "worker-{provider.id}"
    const stripped = workerId.startsWith("worker-") ? workerId.slice(7) : workerId;
    const byStripped = this.providers.get(stripped);
    if (byStripped) return byStripped;

    // Prefix match: stripped workerId starts with provider.id or vice versa
    for (const provider of this.providers.values()) {
      if (stripped.startsWith(provider.id) || provider.id.startsWith(stripped)) {
        return provider;
      }
    }
    return undefined;
  }

  listProviders(): LLMProvider[] {
    return Array.from(this.providers.values());
  }

  get(id: string): LLMProvider | undefined {
    return this.providers.get(id);
  }
}
