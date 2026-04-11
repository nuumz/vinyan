/**
 * Priority Router — K2 provider selection using Wilson lower-bound trust scores.
 *
 * Selects the best provider for a task based on historical success rates.
 * Uses Wilson LB (conservative estimate) so new providers with few observations
 * start low and must prove themselves — consistent with A5 (Tiered Trust).
 *
 * When no trust data exists (cold start), falls back to the default provider
 * from the routing decision.
 */
import { wilsonLowerBound } from '../sleep-cycle/wilson.ts';
import type { ProviderTrustStore } from '../db/provider-trust-store.ts';

export interface ProviderSelection {
  provider: string;
  trustScore: number;
  basis: 'wilson_lb' | 'cold_start';
}

/**
 * Select the highest-trust provider from known providers.
 * Falls back to defaultProvider when no trust data exists.
 *
 * When capability is provided, uses capability-specific trust records.
 * Falls back to aggregate trust when no capability-specific data exists.
 */
export function selectProvider(
  trustStore: ProviderTrustStore,
  defaultProvider: string | null,
  capability?: string,
): ProviderSelection {
  // When capability provided, try capability-specific records first
  const providers = capability
    ? trustStore.getProvidersByCapability(capability)
    : trustStore.getAllProviders();

  // Cold start: no data → use default
  if (providers.length === 0 || !defaultProvider) {
    return {
      provider: defaultProvider ?? 'unknown',
      trustScore: 0.5,
      basis: 'cold_start',
    };
  }

  // Wilson LB trust score per provider (z=1.96 for 95% CI)
  let bestProvider = defaultProvider;
  let bestScore = -1;

  for (const p of providers) {
    const total = p.successes + p.failures;
    if (total === 0) continue;
    const score = wilsonLowerBound(p.successes, total, 1.96);
    if (score > bestScore) {
      bestScore = score;
      bestProvider = p.provider;
    }
  }

  // If no provider has data, fall back
  if (bestScore < 0) {
    return { provider: defaultProvider, trustScore: 0.5, basis: 'cold_start' };
  }

  return { provider: bestProvider, trustScore: bestScore, basis: 'wilson_lb' };
}
