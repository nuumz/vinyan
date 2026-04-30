/**
 * Governance wrapper — failure path normalises errors into LLMProviderError,
 * records cooldown into the health store, and emits the UI-visible bus
 * events. Success path decays cooldown and emits provider_recovered.
 *
 * Tests use scripted mock providers + a fake clock; no real network.
 */
import { describe, expect, test } from 'bun:test';
import { createBus, type VinyanBus, type VinyanBusEvents } from '../../../src/core/bus.ts';
import { createMockProvider } from '../../../src/orchestrator/llm/mock-provider.ts';
import { LLMProviderError } from '../../../src/orchestrator/llm/provider-errors.ts';
import {
  applyGovernanceToRegistry,
  selectGoverned,
  wrapProviderWithGovernance,
} from '../../../src/orchestrator/llm/provider-governance.ts';
import { ProviderHealthStore } from '../../../src/orchestrator/llm/provider-health.ts';
import { LLMProviderRegistry } from '../../../src/orchestrator/llm/provider-registry.ts';
import type { LLMProvider, LLMRequest, LLMResponse } from '../../../src/orchestrator/types.ts';

const REQUEST: LLMRequest = {
  systemPrompt: 'sys',
  userPrompt: 'user',
  maxTokens: 100,
};

function captureBus(): { bus: VinyanBus; events: Array<{ name: keyof VinyanBusEvents; payload: unknown }> } {
  const bus = createBus({ maxListeners: 100 });
  const events: Array<{ name: keyof VinyanBusEvents; payload: unknown }> = [];
  // Tap into every governance event by listing the names directly — keeps
  // the test honest about which payloads we expect to see.
  const targets: Array<keyof VinyanBusEvents> = [
    'llm:provider_quota_exhausted',
    'llm:provider_cooldown_started',
    'llm:provider_cooldown_skipped',
    'llm:provider_fallback_selected',
    'llm:provider_unavailable',
    'llm:provider_recovered',
    'llm:provider_health_changed',
  ];
  for (const t of targets) {
    bus.on(t, (payload: unknown) => events.push({ name: t, payload }));
  }
  return { bus, events };
}

/** Build a provider that throws a 429 OpenRouter body the first call, then succeeds. */
function flakingProvider(id = 'or/fast/gemma'): LLMProvider {
  let call = 0;
  return {
    id,
    tier: 'fast',
    async generate(_req: LLMRequest): Promise<LLMResponse> {
      call += 1;
      if (call === 1) {
        const body = JSON.stringify({
          error: {
            message: 'rate limited',
            metadata: {
              provider_name: 'Google AI Studio',
              model: 'google/gemma-4-26b-a4b-it:free',
              raw: JSON.stringify({
                error: {
                  status: 'RESOURCE_EXHAUSTED',
                  details: [
                    {
                      '@type': 'type.googleapis.com/google.rpc.RetryInfo',
                      retryDelay: '0.500s',
                    },
                  ],
                },
              }),
            },
          },
        });
        const err = new Error(`OpenRouter API error 429: ${body}`);
        (err as { status?: number }).status = 429;
        (err as { body?: string }).body = body;
        throw err;
      }
      return {
        content: 'ok',
        toolCalls: [],
        tokensUsed: { input: 1, output: 1 },
        model: 'mock',
        stopReason: 'end_turn',
      };
    },
  };
}

describe('wrapProviderWithGovernance', () => {
  test('classifies thrown 429 → records cooldown → emits cooldown_started + quota_exhausted', async () => {
    const { bus, events } = captureBus();
    const health = new ProviderHealthStore({ bus });
    const provider = wrapProviderWithGovernance(flakingProvider(), { healthStore: health, bus });

    let caught: unknown;
    try {
      await provider.generate({ ...REQUEST, trace: { traceId: 'task-Q' } });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(LLMProviderError);
    expect((caught as LLMProviderError).normalized.kind).toBe('quota_exhausted');
    expect((caught as LLMProviderError).normalized.retryAfterMs).toBeGreaterThanOrEqual(500);

    expect(health.isAvailable({ id: 'or/fast/gemma' })).toBe(false);

    const names = events.map((e) => e.name);
    expect(names).toContain('llm:provider_quota_exhausted');
    expect(names).toContain('llm:provider_cooldown_started');
    expect(names).toContain('llm:provider_health_changed');
    const quotaPayload = events.find((e) => e.name === 'llm:provider_quota_exhausted')!.payload as
      VinyanBusEvents['llm:provider_quota_exhausted'];
    expect(quotaPayload.taskId).toBe('task-Q');
    expect(quotaPayload.errorKind).toBe('quota_exhausted');
  });

  test('successful call after recovery emits provider_recovered', async () => {
    const { bus, events } = captureBus();
    const health = new ProviderHealthStore({ bus });
    const provider = wrapProviderWithGovernance(flakingProvider(), { healthStore: health, bus });

    // First call fails — opens cooldown of 500ms (Google retryDelay 0.5s + safety margin).
    await provider.generate(REQUEST).catch(() => {});
    // Wait the cooldown window so isAvailable becomes true again before the
    // success call that should fire `provider_recovered`. recordSuccess only
    // emits when the bucket was actually still cooling at success time
    // (`wasCooled`), so we sleep slightly LESS than the cooldown.
    // Cooldown ≈ 500ms + 500ms safety = 1000ms. Sleep 200ms then succeed.
    await new Promise((r) => setTimeout(r, 200));
    const res = await provider.generate(REQUEST);
    expect(res.content).toBe('ok');

    const names = events.map((e) => e.name);
    expect(names).toContain('llm:provider_recovered');
  });

  test('idempotent — re-wrapping returns the same wrapper', () => {
    const health = new ProviderHealthStore();
    const provider = createMockProvider({ id: 'or/fast/gemma', tier: 'fast' });
    const w1 = wrapProviderWithGovernance(provider, { healthStore: health });
    const w2 = wrapProviderWithGovernance(w1, { healthStore: health });
    expect(w2).toBe(w1);
  });
});

describe('selectGoverned', () => {
  test('emits fallback_selected when preferred tier is cooled', () => {
    const { bus, events } = captureBus();
    const health = new ProviderHealthStore({ bus });
    const registry = new LLMProviderRegistry();
    registry.register(createMockProvider({ id: 'or/fast/gemma', tier: 'fast' }));
    registry.register(createMockProvider({ id: 'or/balanced/llama', tier: 'balanced' }));
    applyGovernanceToRegistry(registry, { healthStore: health, bus });
    health.recordFailure(
      { id: 'or/fast/gemma', tier: 'fast' },
      {
        kind: 'quota_exhausted',
        providerId: 'or/fast/gemma',
        message: 'Q',
        retryAfterMs: 30_000,
        isRetryable: true,
        isFallbackRecommended: true,
        isGlobalCooldownRecommended: true,
      },
      {},
    );

    const picked = selectGoverned({ registry, tier: 'fast', taskId: 'task-X', bus });
    expect(picked?.tier).toBe('balanced');
    const names = events.map((e) => e.name);
    expect(names).toContain('llm:provider_fallback_selected');
    expect(names).toContain('llm:provider_cooldown_skipped');
  });

  test('emits provider_unavailable when nothing is healthy', () => {
    const { bus, events } = captureBus();
    const health = new ProviderHealthStore({ bus });
    const registry = new LLMProviderRegistry();
    registry.register(createMockProvider({ id: 'or/fast/gemma', tier: 'fast' }));
    applyGovernanceToRegistry(registry, { healthStore: health, bus });
    health.recordFailure(
      { id: 'or/fast/gemma', tier: 'fast' },
      {
        kind: 'quota_exhausted',
        providerId: 'or/fast/gemma',
        message: 'Q',
        retryAfterMs: 30_000,
        isRetryable: true,
        isFallbackRecommended: true,
        isGlobalCooldownRecommended: true,
      },
      {},
    );

    const picked = selectGoverned({ registry, tier: 'fast', taskId: 'task-X', bus });
    expect(picked).toBeNull();
    expect(events.some((e) => e.name === 'llm:provider_unavailable')).toBe(true);
  });
});
