/**
 * Health-aware registry selection — exercises the policy:
 *   - skip cooled-down providers in the same tier
 *   - fall back to adjacent tier ONLY when health-aware selection asked for it
 *   - return undefined / null when every candidate is cooled
 *
 * Together with provider-registry.test.ts (legacy contract) this is the full
 * surface the governance wrapper relies on.
 */
import { describe, expect, test } from 'bun:test';
import { createMockProvider } from '../../../src/orchestrator/llm/mock-provider.ts';
import {
  classifyProviderError,
  type NormalizedLLMProviderError,
} from '../../../src/orchestrator/llm/provider-errors.ts';
import { ProviderHealthStore } from '../../../src/orchestrator/llm/provider-health.ts';
import { LLMProviderRegistry } from '../../../src/orchestrator/llm/provider-registry.ts';

function quota(opts: { retryAfterMs?: number; providerId: string }): NormalizedLLMProviderError {
  return classifyProviderError({
    kind: 'http',
    providerId: opts.providerId,
    status: 429,
    bodyText: opts.retryAfterMs ? `Please retry in ${opts.retryAfterMs / 1000}s` : 'rate limited',
    retryAfterHeader: null,
  });
}

describe('LLMProviderRegistry — health-aware selection', () => {
  test('selectByTier skips cooled-down provider, picks the next healthy one in tier', () => {
    let now = 0;
    const health = new ProviderHealthStore({ now: () => now });
    const registry = new LLMProviderRegistry();
    registry.setHealthStore(health);
    const cooled = createMockProvider({ id: 'or/fast/gemma', tier: 'fast' });
    const healthy = createMockProvider({ id: 'or/fast/llama', tier: 'fast' });
    registry.register(cooled);
    registry.register(healthy);

    health.recordFailure(cooled, quota({ retryAfterMs: 30_000, providerId: cooled.id }), {});
    expect(registry.selectByTier('fast')!.id).toBe(healthy.id);

    // Cooldown expires → original is selected again (first-match order).
    now = 31_000;
    health.recordSuccess(cooled);
    expect(registry.selectByTier('fast')!.id).toBe(cooled.id);
  });

  test('selectByTierDetailed reports skipped provider + fallback when health-aware', () => {
    const health = new ProviderHealthStore({ now: () => 0 });
    const registry = new LLMProviderRegistry();
    registry.setHealthStore(health);
    const fast = createMockProvider({ id: 'or/fast/gemma', tier: 'fast' });
    const balanced = createMockProvider({ id: 'or/balanced/gemma', tier: 'balanced' });
    registry.register(fast);
    registry.register(balanced);
    health.recordFailure(fast, quota({ retryAfterMs: 30_000, providerId: fast.id }), {});

    const detail = registry.selectByTierDetailed('fast', { allowAdjacentTier: true });
    expect(detail.provider?.id).toBe(balanced.id);
    expect(detail.fellBackTier).toBe(true);
    expect(detail.skipped?.id).toBe(fast.id);
    expect(detail.skippedCooldownUntil).toBeGreaterThan(0);
  });

  test('returns null when every candidate (and adjacent tiers) are cooled', () => {
    const health = new ProviderHealthStore({ now: () => 0 });
    const registry = new LLMProviderRegistry();
    registry.setHealthStore(health);
    const fast = createMockProvider({ id: 'or/fast/gemma', tier: 'fast' });
    const balanced = createMockProvider({ id: 'or/balanced/gemma', tier: 'balanced' });
    registry.register(fast);
    registry.register(balanced);
    health.recordFailure(fast, quota({ retryAfterMs: 30_000, providerId: fast.id }), {});
    health.recordFailure(balanced, quota({ retryAfterMs: 30_000, providerId: balanced.id }), {});

    const detail = registry.selectByTierDetailed('fast', { allowAdjacentTier: true });
    expect(detail.provider).toBeNull();
    // Even without adjacent fallback, the bare API returns undefined.
    expect(registry.selectByTier('fast')).toBeUndefined();
  });

  test('selectById skips cooled provider unless allowUnavailable is set', () => {
    const health = new ProviderHealthStore({ now: () => 0 });
    const registry = new LLMProviderRegistry();
    registry.setHealthStore(health);
    const provider = createMockProvider({ id: 'or/fast/gemma', tier: 'fast' });
    registry.register(provider);
    health.recordFailure(provider, quota({ retryAfterMs: 30_000, providerId: provider.id }), {});

    expect(registry.selectById(provider.id)).toBeUndefined();
    expect(registry.selectById(provider.id, { allowUnavailable: true })?.id).toBe(provider.id);
  });

  test('legacy callers without health store keep first-match behavior', () => {
    const registry = new LLMProviderRegistry();
    const fast = createMockProvider({ id: 'or/fast/gemma', tier: 'fast' });
    registry.register(fast);
    // No health store → balanced returns undefined just like before.
    expect(registry.selectByTier('balanced')).toBeUndefined();
    expect(registry.selectByTier('fast')!.id).toBe(fast.id);
  });
});
