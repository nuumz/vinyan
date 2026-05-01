/**
 * ProviderHealthStore — cooldown bookkeeping, exponential backoff cap,
 * auth-error escalation, decay-on-success.
 */
import { describe, expect, test } from 'bun:test';
import {
  computeCooldownMs,
  HEALTH_AUTH_COOLDOWN_MS,
  HEALTH_DEFAULT_BASE_COOLDOWN_MS,
  HEALTH_MAX_COOLDOWN_MS,
  ProviderHealthStore,
} from '../../../src/orchestrator/llm/provider-health.ts';

const PROVIDER = { id: 'openrouter/fast/google/gemma-4-26b-a4b-it:free', tier: 'fast' as const };

describe('ProviderHealthStore', () => {
  test('opens cooldown until now + retryAfterMs after quota_exhausted', () => {
    let now = 1_000;
    const store = new ProviderHealthStore({ now: () => now });
    store.recordFailure(
      PROVIDER,
      {
        kind: 'quota_exhausted',
        providerId: PROVIDER.id,
        message: 'Quota exceeded',
        retryAfterMs: 35_000,
        isRetryable: true,
        isFallbackRecommended: true,
        isGlobalCooldownRecommended: true,
      },
      { taskId: 'task-A' },
    );
    expect(store.isAvailable(PROVIDER, now)).toBe(false);
    const cool = store.getCooldown(PROVIDER, now);
    expect(cool?.cooldownUntil).toBe(36_000);
    expect(cool?.sourceTaskId).toBe('task-A');
    expect(cool?.failureCount).toBe(1);

    now = 36_001;
    expect(store.isAvailable(PROVIDER, now)).toBe(true);
  });

  test('repeated 429 without retryAfter uses exponential backoff with cap', () => {
    expect(computeCooldownMs(quotaErr(undefined), 1)).toBe(HEALTH_DEFAULT_BASE_COOLDOWN_MS);
    expect(computeCooldownMs(quotaErr(undefined), 2)).toBe(HEALTH_DEFAULT_BASE_COOLDOWN_MS * 2);
    // Past the cap.
    expect(computeCooldownMs(quotaErr(undefined), 100)).toBe(HEALTH_MAX_COOLDOWN_MS);
  });

  test('auth_error opens long cooldown', () => {
    let now = 0;
    const store = new ProviderHealthStore({ now: () => now });
    store.recordFailure(PROVIDER, authErr(), { taskId: 't' });
    const cool = store.getCooldown(PROVIDER, now);
    expect(cool?.cooldownUntil).toBe(HEALTH_AUTH_COOLDOWN_MS);
  });

  test('recordSuccess decays failure count and clears expired buckets', () => {
    let now = 1_000;
    const store = new ProviderHealthStore({ now: () => now });
    // Two failures.
    store.recordFailure(PROVIDER, quotaErr(2_000), {});
    now = 5_000;
    store.recordFailure(PROVIDER, quotaErr(undefined), {});

    const before = store.listHealth();
    expect(before).toHaveLength(1);
    expect(before[0]!.failureCount).toBe(2);

    // Cooldown expires; failureCount decays floor(2*0.5)=1, then floor(1*0.5)=0.
    now = 30_000;
    store.recordSuccess(PROVIDER);
    expect(store.listHealth()[0]!.failureCount).toBe(1);
    store.recordSuccess(PROVIDER);
    expect(store.listHealth()).toHaveLength(0);
    expect(store.isAvailable(PROVIDER, now)).toBe(true);
  });

  test('different quota metrics on same provider get independent buckets', () => {
    let now = 0;
    const store = new ProviderHealthStore({ now: () => now });
    store.recordFailure(
      PROVIDER,
      { ...quotaErr(10_000), quotaMetric: 'A', quotaId: 'A' },
      {},
    );
    store.recordFailure(
      PROVIDER,
      { ...quotaErr(20_000), quotaMetric: 'B', quotaId: 'B' },
      {},
    );
    expect(store.listHealth()).toHaveLength(2);
    // Metric A expires first; provider stays unavailable while B holds.
    now = 11_000;
    expect(store.isAvailable(PROVIDER, now)).toBe(false);
    now = 21_000;
    expect(store.isAvailable(PROVIDER, now)).toBe(true);
  });

  test('per-model isAvailable: 429 on one model does NOT block sibling models', () => {
    const now = 0;
    const store = new ProviderHealthStore({ now: () => now });
    // Sonnet hits 429.
    store.recordFailure(
      PROVIDER,
      { ...quotaErr(60_000), model: 'claude-3-5-sonnet' },
      {},
    );
    // Provider-wide check: blocked.
    expect(store.isAvailable(PROVIDER, now)).toBe(false);
    // Per-model on the rate-limited model: blocked.
    expect(store.isAvailable(PROVIDER, 'claude-3-5-sonnet', now)).toBe(false);
    // Per-model on a sibling model: NOT blocked. This is the fix.
    expect(store.isAvailable(PROVIDER, 'claude-3-5-haiku', now)).toBe(true);
    expect(store.isAvailable(PROVIDER, 'claude-3-opus', now)).toBe(true);
  });

  test('per-model isAvailable: provider-wide cooldown still blocks all models', () => {
    const now = 0;
    const store = new ProviderHealthStore({ now: () => now });
    // Auth error has no `model` field — treat as provider-wide.
    store.recordFailure(PROVIDER, authErr(), {});
    // Sibling models all blocked because the cooldown record has no model tag.
    expect(store.isAvailable(PROVIDER, 'claude-3-5-haiku', now)).toBe(false);
    expect(store.isAvailable(PROVIDER, 'claude-3-opus', now)).toBe(false);
  });

  test('R3 — indexed isAvailable handles 100 buckets correctly', () => {
    const now = 0;
    const store = new ProviderHealthStore({ now: () => now });
    for (let i = 0; i < 100; i++) {
      store.recordFailure(
        { id: `prov-${i % 10}`, tier: 'fast' as const },
        { ...quotaErr(60_000), model: `model-${i}`, quotaMetric: `m${i}`, quotaId: `q${i}` },
        {},
      );
    }
    expect(store.listHealth().length).toBe(100);
    expect(store.isAvailable({ id: 'prov-3' }, now)).toBe(false);
    expect(store.isAvailable({ id: 'prov-NOT_REGISTERED' }, now)).toBe(true);
    expect(store.isAvailable({ id: 'prov-3' }, 999_999_999)).toBe(true);
  });

  test('emits cooldown_started → recovered envelopes', () => {
    let now = 0;
    const store = new ProviderHealthStore({ now: () => now });
    const events: string[] = [];
    store.onChange((env) => events.push(env.type));
    store.recordFailure(PROVIDER, quotaErr(1_000), { taskId: 't' });
    now = 2_000;
    store.recordSuccess(PROVIDER);
    expect(events).toEqual(['cooldown_started', 'recovered']);
  });
});

function quotaErr(retryAfterMs: number | undefined) {
  return {
    kind: 'quota_exhausted' as const,
    providerId: PROVIDER.id,
    message: 'Quota exceeded',
    ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
    isRetryable: true,
    isFallbackRecommended: true,
    isGlobalCooldownRecommended: true,
  };
}

function authErr() {
  return {
    kind: 'auth_error' as const,
    providerId: PROVIDER.id,
    message: 'Invalid API key',
    isRetryable: false,
    isFallbackRecommended: true,
    isGlobalCooldownRecommended: true,
  };
}
