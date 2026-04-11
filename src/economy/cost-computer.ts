/**
 * Cost Computer — pure function: raw token counts + rate card → USD.
 *
 * A3 compliant: deterministic, no side effects, no LLM.
 *
 * Source of truth: Economy OS plan §E1.2
 */
import type { RateCard } from './rate-card.ts';

export interface TokenCounts {
  input: number;
  output: number;
  cacheRead?: number;
  cacheCreation?: number;
}

export interface CostResult {
  computed_usd: number;
  /** 'billing' when rate card matched, 'estimated' when fallback. */
  cost_tier: 'billing' | 'estimated';
  breakdown: {
    input_usd: number;
    output_usd: number;
    cache_read_usd: number;
    cache_create_usd: number;
  };
}

/**
 * Compute USD cost from token counts and a rate card.
 * Returns cost_tier: 'billing' when card is provided, 'estimated' when null.
 */
export function computeCost(tokens: TokenCounts, card: RateCard | null): CostResult {
  if (!card) {
    return {
      computed_usd: 0,
      cost_tier: 'estimated',
      breakdown: { input_usd: 0, output_usd: 0, cache_read_usd: 0, cache_create_usd: 0 },
    };
  }

  const inputUsd = (tokens.input * card.input_per_mtok) / 1_000_000;
  const outputUsd = (tokens.output * card.output_per_mtok) / 1_000_000;
  const cacheReadUsd = ((tokens.cacheRead ?? 0) * card.cache_read_per_mtok) / 1_000_000;
  const cacheCreateUsd = ((tokens.cacheCreation ?? 0) * card.cache_create_per_mtok) / 1_000_000;

  return {
    computed_usd: inputUsd + outputUsd + cacheReadUsd + cacheCreateUsd,
    cost_tier: 'billing',
    breakdown: {
      input_usd: inputUsd,
      output_usd: outputUsd,
      cache_read_usd: cacheReadUsd,
      cache_create_usd: cacheCreateUsd,
    },
  };
}
