/**
 * Classifier contract tests — every parser branch the OpenRouter / Google
 * RESOURCE_EXHAUSTED incident relies on, plus the message-fallback regex
 * for providers that don't expose structured retry info.
 */
import { describe, expect, test } from 'bun:test';
import {
  classifyProviderError,
  isLLMProviderError,
  LLMProviderError,
  parseRetryAfterHeader,
  parseRetryDelayString,
  parseRetryFromText,
  quotaKey,
} from '../../../src/orchestrator/llm/provider-errors.ts';

const OPENROUTER_429_BODY = JSON.stringify({
  error: {
    message: 'Rate limit exceeded for free tier',
    code: 429,
    metadata: {
      provider_name: 'Google AI Studio',
      model: 'google/gemma-4-26b-a4b-it:free',
      raw: JSON.stringify({
        error: {
          code: 429,
          status: 'RESOURCE_EXHAUSTED',
          message: 'Quota exceeded for input tokens',
          details: [
            {
              '@type': 'type.googleapis.com/google.rpc.QuotaFailure',
              violations: [
                {
                  quotaMetric: 'generativelanguage.googleapis.com/generate_content_paid_tier_input_token_count',
                  quotaId: 'GenerateContentPaidTierInputTokensPerModelPerMinute',
                  quotaDimensions: { location: 'global', model: 'gemma-4-26b-a4b-it' },
                },
              ],
            },
            {
              '@type': 'type.googleapis.com/google.rpc.RetryInfo',
              retryDelay: '35.174346048s',
            },
          ],
        },
      }),
    },
  },
});

describe('classifyProviderError', () => {
  test('parses OpenRouter 429 metadata.raw + Google RetryInfo into normalized quota_exhausted', () => {
    const normalized = classifyProviderError({
      kind: 'http',
      providerId: 'openrouter/fast/google/gemma-4-26b-a4b-it:free',
      tier: 'fast',
      providerName: 'OpenRouter',
      model: 'google/gemma-4-26b-a4b-it:free',
      status: 429,
      bodyText: OPENROUTER_429_BODY,
      retryAfterHeader: null,
    });
    expect(normalized.kind).toBe('quota_exhausted');
    expect(normalized.status).toBe(429);
    // 35.174346048s + safety margin ⇒ at least 35_000ms, capped under 5min.
    expect(normalized.retryAfterMs).toBeGreaterThanOrEqual(35_174);
    expect(normalized.retryAfterMs).toBeLessThanOrEqual(36_000);
    expect(normalized.quotaMetric).toBe(
      'generativelanguage.googleapis.com/generate_content_paid_tier_input_token_count',
    );
    expect(normalized.quotaId).toBe('GenerateContentPaidTierInputTokensPerModelPerMinute');
    expect(normalized.quotaDimensions).toEqual({ location: 'global', model: 'gemma-4-26b-a4b-it' });
    expect(normalized.isRetryable).toBe(true);
    expect(normalized.isFallbackRecommended).toBe(true);
    expect(normalized.isGlobalCooldownRecommended).toBe(true);
  });

  test('falls back to Retry-After header when body is opaque', () => {
    const normalized = classifyProviderError({
      kind: 'http',
      providerId: 'mock/balanced',
      status: 429,
      bodyText: 'opaque text',
      retryAfterHeader: '12',
    });
    expect(normalized.kind).toBe('rate_limited');
    expect(normalized.retryAfterMs).toBeGreaterThanOrEqual(12_000);
    expect(normalized.retryAfterMs).toBeLessThanOrEqual(12_500 + 500); // + safety margin
  });

  test('parses message-fallback "Please retry in 35.174s"', () => {
    const ms = parseRetryFromText('Please retry in 35.174s');
    expect(ms).toBe(35174);
  });

  test('parses Google duration "35s" / "0.500s"', () => {
    expect(parseRetryDelayString('35s')).toBe(35_000);
    expect(parseRetryDelayString('0.500s')).toBe(500);
    expect(parseRetryDelayString('not a duration')).toBeUndefined();
  });

  test('parseRetryAfterHeader supports delta-seconds and HTTP-date', () => {
    expect(parseRetryAfterHeader('5')).toBe(5_000);
    expect(parseRetryAfterHeader(null)).toBeUndefined();
    expect(parseRetryAfterHeader('')).toBeUndefined();
    const future = new Date(Date.now() + 7_000).toUTCString();
    const ms = parseRetryAfterHeader(future);
    // Allow some clock skew but it should be in the right ballpark.
    expect(ms).toBeGreaterThan(0);
    expect(ms!).toBeLessThan(15_000);
  });

  test('classifies 401/403 as auth_error (non-retryable, fallback recommended)', () => {
    const normalized = classifyProviderError({
      kind: 'http',
      providerId: 'mock/p',
      status: 401,
      bodyText: '{"error":{"message":"Invalid API key"}}',
    });
    expect(normalized.kind).toBe('auth_error');
    expect(normalized.isRetryable).toBe(false);
    expect(normalized.isFallbackRecommended).toBe(true);
    expect(normalized.isGlobalCooldownRecommended).toBe(true);
  });

  test('classifies 5xx as transient_provider_error', () => {
    const normalized = classifyProviderError({
      kind: 'http',
      providerId: 'mock/p',
      status: 503,
      bodyText: 'service unavailable',
    });
    expect(normalized.kind).toBe('transient_provider_error');
    expect(normalized.isRetryable).toBe(true);
    expect(normalized.isFallbackRecommended).toBe(false);
  });

  test('classifies 413 / context_length_exceeded as context_too_large', () => {
    const normalized = classifyProviderError({
      kind: 'http',
      providerId: 'mock/p',
      status: 413,
      bodyText: 'context_length_exceeded',
    });
    expect(normalized.kind).toBe('context_too_large');
    expect(normalized.isRetryable).toBe(false);
  });

  test('classifies thrown network errors', () => {
    const normalized = classifyProviderError({
      kind: 'thrown',
      providerId: 'mock/p',
      error: new Error('fetch failed: ECONNRESET'),
    });
    expect(normalized.kind).toBe('network_error');
    expect(normalized.isRetryable).toBe(true);
  });

  test('idempotent on already-classified LLMProviderError', () => {
    const original = classifyProviderError({
      kind: 'http',
      providerId: 'mock/p',
      status: 429,
      bodyText: OPENROUTER_429_BODY,
    });
    const wrapped = new LLMProviderError(original);
    const reclassified = classifyProviderError({
      kind: 'thrown',
      providerId: 'mock/p',
      error: wrapped,
    });
    expect(reclassified).toBe(original);
    expect(isLLMProviderError(wrapped)).toBe(true);
  });
});

describe('quotaKey', () => {
  test('includes provider/model/quotaMetric/quotaId/dimensions in stable order', () => {
    const k1 = quotaKey({
      providerId: 'openrouter/fast/google/gemma-4-26b-a4b-it:free',
      model: 'google/gemma-4-26b-a4b-it:free',
      quotaMetric: 'metric.A',
      quotaId: 'idA',
      quotaDimensions: { location: 'global', model: 'gemma' },
    });
    const k2 = quotaKey({
      providerId: 'openrouter/fast/google/gemma-4-26b-a4b-it:free',
      model: 'google/gemma-4-26b-a4b-it:free',
      quotaMetric: 'metric.A',
      quotaId: 'idA',
      // Same dimensions, different insertion order — keys must match.
      quotaDimensions: { model: 'gemma', location: 'global' },
    });
    expect(k1).toBe(k2);
  });

  test('different quota metrics produce different keys for the same provider', () => {
    const k1 = quotaKey({
      providerId: 'p',
      model: 'm',
      quotaMetric: 'metric.A',
      quotaId: 'A',
    });
    const k2 = quotaKey({
      providerId: 'p',
      model: 'm',
      quotaMetric: 'metric.B',
      quotaId: 'B',
    });
    expect(k1).not.toBe(k2);
  });
});
