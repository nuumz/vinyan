import { describe, test, expect } from 'bun:test';
import { translatePolicyToProvider } from '../../src/orchestrator/llm/thinking-policy-translator.ts';
import type { ThinkingPolicy } from '../../src/orchestrator/thinking-policy.ts';

function makePolicy(overrides: Partial<ThinkingPolicy>): ThinkingPolicy {
  return {
    policyBasis: 'default',
    thinking: { type: 'disabled' },
    profileId: 'A',
    ...overrides,
  };
}

describe('translatePolicyToProvider', () => {
  test('disabled thinking → pass-through', () => {
    const result = translatePolicyToProvider(makePolicy({ thinking: { type: 'disabled' } }));
    expect(result.thinkingConfig.type).toBe('disabled');
    expect(result.thinkingBudget).toBeUndefined();
  });

  test('adaptive + ceiling → converts to explicit budget', () => {
    const result = translatePolicyToProvider(makePolicy({
      thinking: { type: 'adaptive', effort: 'high' },
      thinkingCeiling: 10_000,
    }));
    expect(result.thinkingConfig.type).toBe('enabled');
    if (result.thinkingConfig.type === 'enabled') {
      expect(result.thinkingConfig.budgetTokens).toBe(10_000);
    }
    expect(result.thinkingBudget).toBe(10_000);
  });

  test('adaptive + no ceiling → pass-through adaptive', () => {
    const result = translatePolicyToProvider(makePolicy({
      thinking: { type: 'adaptive', effort: 'medium' },
    }));
    expect(result.thinkingConfig.type).toBe('adaptive');
    expect(result.thinkingBudget).toBeUndefined();
  });

  test('adaptive + ceiling=0 → pass-through (no clamping needed)', () => {
    const result = translatePolicyToProvider(makePolicy({
      thinking: { type: 'adaptive', effort: 'low' },
      thinkingCeiling: 0,
    }));
    // ceiling=0 is falsy, so no conversion to explicit budget
    expect(result.thinkingConfig.type).toBe('adaptive');
  });

  test('enabled + ceiling clamps budget', () => {
    const result = translatePolicyToProvider(makePolicy({
      thinking: { type: 'enabled', budgetTokens: 50_000 },
      thinkingCeiling: 10_000,
    }));
    expect(result.thinkingConfig.type).toBe('enabled');
    if (result.thinkingConfig.type === 'enabled') {
      expect(result.thinkingConfig.budgetTokens).toBe(10_000);
    }
    expect(result.thinkingBudget).toBe(10_000);
  });

  test('enabled + ceiling larger than budget → keeps original budget', () => {
    const result = translatePolicyToProvider(makePolicy({
      thinking: { type: 'enabled', budgetTokens: 5_000 },
      thinkingCeiling: 50_000,
    }));
    if (result.thinkingConfig.type === 'enabled') {
      expect(result.thinkingConfig.budgetTokens).toBe(5_000);
    }
    expect(result.thinkingBudget).toBe(5_000);
  });

  test('enabled + undefined ceiling → pass-through', () => {
    const result = translatePolicyToProvider(makePolicy({
      thinking: { type: 'enabled', budgetTokens: 20_000 },
    }));
    if (result.thinkingConfig.type === 'enabled') {
      expect(result.thinkingConfig.budgetTokens).toBe(20_000);
    }
  });
});
