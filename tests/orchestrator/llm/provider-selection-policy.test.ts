import { describe, expect, test } from 'bun:test';
import {
  decidePolicyAction,
  POLICY_BUDGET_FLOOR_MS,
  POLICY_WAIT_THRESHOLD_MS,
} from '../../../src/orchestrator/llm/provider-selection-policy.ts';
import type { NormalizedLLMProviderError } from '../../../src/orchestrator/llm/provider-errors.ts';

function quota(retryAfterMs?: number): NormalizedLLMProviderError {
  return {
    kind: 'quota_exhausted',
    providerId: 'p',
    message: 'q',
    ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
    isRetryable: true,
    isFallbackRecommended: true,
    isGlobalCooldownRecommended: true,
  };
}

describe('decidePolicyAction', () => {
  test('first failure with short retry-after and budget → wait once', () => {
    const decision = decidePolicyAction(quota(2_000), {
      remainingBudgetMs: 60_000,
      hasFallback: false,
      attemptIndex: 0,
    });
    expect(decision.action).toBe('wait');
    if (decision.action === 'wait') expect(decision.waitMs).toBe(2_000);
  });

  test('first failure with long retry-after and a fallback → fallback', () => {
    const decision = decidePolicyAction(quota(20_000), {
      remainingBudgetMs: 60_000,
      hasFallback: true,
      attemptIndex: 0,
    });
    expect(decision.action).toBe('fallback');
  });

  test('second attempt on same provider → fallback (never tight-loop)', () => {
    const decision = decidePolicyAction(quota(2_000), {
      remainingBudgetMs: 60_000,
      hasFallback: true,
      attemptIndex: 1,
    });
    expect(decision.action).toBe('fallback');
  });

  test('no fallback + budget too small → fail', () => {
    const decision = decidePolicyAction(quota(20_000), {
      remainingBudgetMs: 1_000,
      hasFallback: false,
      attemptIndex: 0,
    });
    expect(decision.action).toBe('fail');
  });

  test('non-retryable error always fails or falls back', () => {
    const auth: NormalizedLLMProviderError = {
      kind: 'auth_error',
      providerId: 'p',
      message: 'auth',
      isRetryable: false,
      isFallbackRecommended: true,
      isGlobalCooldownRecommended: true,
    };
    expect(
      decidePolicyAction(auth, { remainingBudgetMs: 60_000, hasFallback: true, attemptIndex: 0 }).action,
    ).toBe('fallback');
    expect(
      decidePolicyAction(auth, { remainingBudgetMs: 60_000, hasFallback: false, attemptIndex: 0 }).action,
    ).toBe('fail');
  });

  test('retry-after just under threshold + budget too tight → fail', () => {
    const err = quota(POLICY_WAIT_THRESHOLD_MS - 1);
    const decision = decidePolicyAction(err, {
      remainingBudgetMs: POLICY_BUDGET_FLOOR_MS, // budget == floor; wait would push us under.
      hasFallback: false,
      attemptIndex: 0,
    });
    expect(decision.action).toBe('fail');
  });
});
