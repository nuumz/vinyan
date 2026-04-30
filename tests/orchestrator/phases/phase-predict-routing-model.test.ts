/**
 * Tests for `resolveExecutableProviderId`. Pure function — covers the
 * resolution contract that fixes the `routing.model = 'claude-haiku'`
 * telemetry lie when the actual provider is OpenRouter (or any other
 * registered engine whose id does not match the LEVEL_CONFIG tier label).
 *
 * The contract:
 *   1. routing.workerId wins when it resolves to a registered engine
 *   2. routing.model wins next when it does
 *   3. Otherwise fall back to `selectForRoutingLevel(level)`
 *   4. If the resolved candidate's id equals the current `routing.model`,
 *      return the same routing reference (no spurious mutation)
 *   5. If the registry returns nothing, leave routing unchanged so error
 *      paths still emit the human-readable tier-label hint
 */
import { describe, expect, test } from 'bun:test';
import { createMockProvider } from '../../../src/orchestrator/llm/mock-provider.ts';
import { LLMProviderRegistry } from '../../../src/orchestrator/llm/provider-registry.ts';
import { resolveExecutableProviderId } from '../../../src/orchestrator/phases/phase-predict.ts';
import type { RoutingDecision } from '../../../src/orchestrator/types.ts';

function baseRouting(overrides: Partial<RoutingDecision> = {}): RoutingDecision {
  return {
    level: 1,
    model: 'claude-haiku',
    budgetTokens: 10_000,
    latencyBudgetMs: 5_000,
    ...overrides,
  };
}

describe('resolveExecutableProviderId', () => {
  test('replaces tier-label "claude-haiku" with the real registered fast-tier provider id', () => {
    const registry = new LLMProviderRegistry();
    registry.register(createMockProvider({ id: 'openrouter/fast/google/gemma', tier: 'fast' }));
    registry.register(createMockProvider({ id: 'openrouter/balanced/google/bigger', tier: 'balanced' }));

    const refined = resolveExecutableProviderId(baseRouting(), registry);

    expect(refined.model).toBe('openrouter/fast/google/gemma');
    // Other fields preserved
    expect(refined.level).toBe(1);
    expect(refined.budgetTokens).toBe(10_000);
  });

  test('honors routing.workerId when it resolves to a registered engine', () => {
    const registry = new LLMProviderRegistry();
    registry.register(createMockProvider({ id: 'mock/alpha', tier: 'fast' }));
    registry.register(createMockProvider({ id: 'mock/beta', tier: 'fast' }));

    const refined = resolveExecutableProviderId(
      baseRouting({ workerId: 'mock/beta', model: 'claude-haiku' }),
      registry,
    );

    expect(refined.model).toBe('mock/beta');
  });

  test('honors a real routing.model id even when registry has multiple fast-tier engines', () => {
    const registry = new LLMProviderRegistry();
    registry.register(createMockProvider({ id: 'mock/alpha', tier: 'fast' }));
    registry.register(createMockProvider({ id: 'mock/beta', tier: 'fast' }));

    // Engine selector pinned 'mock/beta' — the registry has alpha first, but
    // the resolver must trust an explicit routing.model that matches a real id.
    const refined = resolveExecutableProviderId(
      baseRouting({ model: 'mock/beta' }),
      registry,
    );

    expect(refined.model).toBe('mock/beta');
  });

  test('returns the same reference when resolved id already matches routing.model', () => {
    const registry = new LLMProviderRegistry();
    registry.register(createMockProvider({ id: 'openrouter/fast/google/gemma', tier: 'fast' }));

    const input = baseRouting({ model: 'openrouter/fast/google/gemma' });
    const refined = resolveExecutableProviderId(input, registry);

    expect(refined).toBe(input);
  });

  test('leaves routing unchanged when the registry has no candidate for the tier (L0)', () => {
    const registry = new LLMProviderRegistry();
    // No L0 engine in the registry — selectForRoutingLevel(0) returns undefined.
    const input = baseRouting({ level: 0, model: null });
    const refined = resolveExecutableProviderId(input, registry);

    expect(refined).toBe(input);
    expect(refined.model).toBeNull();
  });

  test('leaves routing unchanged when registry has no providers at all', () => {
    const registry = new LLMProviderRegistry();
    const input = baseRouting();
    const refined = resolveExecutableProviderId(input, registry);

    expect(refined).toBe(input);
    expect(refined.model).toBe('claude-haiku');
  });

  test('returns routing unchanged when registry is undefined (no LLM registry wired)', () => {
    const input = baseRouting();
    const refined = resolveExecutableProviderId(input, undefined);
    expect(refined).toBe(input);
  });

  test('uses tier fallback when routing.model does not match any registered id', () => {
    const registry = new LLMProviderRegistry();
    registry.register(createMockProvider({ id: 'openrouter/balanced/big-model', tier: 'balanced' }));

    // L2 → 'balanced' tier; routing.model is the cosmetic label.
    const refined = resolveExecutableProviderId(
      baseRouting({ level: 2, model: 'claude-sonnet', budgetTokens: 50_000 }),
      registry,
    );

    expect(refined.model).toBe('openrouter/balanced/big-model');
    expect(refined.level).toBe(2);
  });
});
