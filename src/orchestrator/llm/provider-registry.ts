/**
 * LLM Provider Registry — register and select providers by tier.
 * Source of truth: vinyan-tdd.md §17.1
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

  listProviders(): LLMProvider[] {
    return Array.from(this.providers.values());
  }

  get(id: string): LLMProvider | undefined {
    return this.providers.get(id);
  }
}
