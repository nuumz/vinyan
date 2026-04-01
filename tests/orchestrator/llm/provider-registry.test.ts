import { describe, expect, test } from 'bun:test';
import { createMockProvider } from '../../../src/orchestrator/llm/mock-provider.ts';
import { LLMProviderRegistry } from '../../../src/orchestrator/llm/provider-registry.ts';

describe('LLMProviderRegistry', () => {
  test('registers and retrieves providers', () => {
    const registry = new LLMProviderRegistry();
    const fast = createMockProvider({ id: 'mock/fast', tier: 'fast' });
    const balanced = createMockProvider({ id: 'mock/balanced', tier: 'balanced' });
    registry.register(fast);
    registry.register(balanced);
    expect(registry.listProviders()).toHaveLength(2);
    expect(registry.get('mock/fast')).toBe(fast);
  });

  test('selectByTier returns matching provider', () => {
    const registry = new LLMProviderRegistry();
    registry.register(createMockProvider({ id: 'mock/fast', tier: 'fast' }));
    registry.register(createMockProvider({ id: 'mock/powerful', tier: 'powerful' }));
    expect(registry.selectByTier('fast')!.id).toBe('mock/fast');
    expect(registry.selectByTier('powerful')!.id).toBe('mock/powerful');
    expect(registry.selectByTier('balanced')).toBeUndefined();
  });

  test('selectForRoutingLevel maps L0→null, L1→fast, L2→balanced, L3→powerful', () => {
    const registry = new LLMProviderRegistry();
    registry.register(createMockProvider({ id: 'fast', tier: 'fast' }));
    registry.register(createMockProvider({ id: 'balanced', tier: 'balanced' }));
    registry.register(createMockProvider({ id: 'powerful', tier: 'powerful' }));
    expect(registry.selectForRoutingLevel(0)).toBeUndefined(); // L0: no LLM
    expect(registry.selectForRoutingLevel(1)!.id).toBe('fast');
    expect(registry.selectForRoutingLevel(2)!.id).toBe('balanced');
    expect(registry.selectForRoutingLevel(3)!.id).toBe('powerful');
  });

  test('supports ≥3 providers (§17.5 criterion 1)', () => {
    const registry = new LLMProviderRegistry();
    registry.register(createMockProvider({ id: 'claude', tier: 'powerful' }));
    registry.register(createMockProvider({ id: 'gpt4', tier: 'balanced' }));
    registry.register(createMockProvider({ id: 'ollama', tier: 'fast' }));
    expect(registry.listProviders().length).toBeGreaterThanOrEqual(3);
  });
});
