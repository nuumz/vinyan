/**
 * Tests for K2 Priority Router — Wilson LB provider selection.
 */
import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { ProviderTrustStore } from '../../src/db/provider-trust-store.ts';
import { selectProvider } from '../../src/orchestrator/priority-router.ts';

function makeTrustStore(): ProviderTrustStore {
  const db = new Database(':memory:');
  return new ProviderTrustStore(db);
}

describe('selectProvider', () => {
  test('cold start returns default provider', () => {
    const store = makeTrustStore();
    const result = selectProvider(store, 'claude-sonnet');
    expect(result.provider).toBe('claude-sonnet');
    expect(result.basis).toBe('cold_start');
    expect(result.trustScore).toBe(0.5);
  });

  test('selects provider with highest Wilson LB', () => {
    const store = makeTrustStore();
    // Provider A: 8/10 success
    for (let i = 0; i < 8; i++) store.recordOutcome('provider-a', true);
    for (let i = 0; i < 2; i++) store.recordOutcome('provider-a', false);
    // Provider B: 3/10 success
    for (let i = 0; i < 3; i++) store.recordOutcome('provider-b', true);
    for (let i = 0; i < 7; i++) store.recordOutcome('provider-b', false);

    const result = selectProvider(store, 'provider-b');
    expect(result.provider).toBe('provider-a');
    expect(result.basis).toBe('wilson_lb');
    expect(result.trustScore).toBeGreaterThan(0);
  });

  test('new provider with 1 success ranks low', () => {
    const store = makeTrustStore();
    store.recordOutcome('veteran', true);
    for (let i = 0; i < 19; i++) store.recordOutcome('veteran', true);
    store.recordOutcome('newbie', true);

    const result = selectProvider(store, 'newbie');
    // Veteran (20/20) should have higher Wilson LB than newbie (1/1)
    expect(result.provider).toBe('veteran');
  });

  test('capability filter uses capability-specific trust data', () => {
    const store = makeTrustStore();
    // Provider A: great at code-gen (9/10), bad at review (1/10)
    for (let i = 0; i < 9; i++) store.recordOutcome('provider-a', true, 'code-gen');
    store.recordOutcome('provider-a', false, 'code-gen');
    store.recordOutcome('provider-a', true, 'review');
    for (let i = 0; i < 9; i++) store.recordOutcome('provider-a', false, 'review');

    // Provider B: great at review (9/10), bad at code-gen (1/10)
    store.recordOutcome('provider-b', true, 'code-gen');
    for (let i = 0; i < 9; i++) store.recordOutcome('provider-b', false, 'code-gen');
    for (let i = 0; i < 9; i++) store.recordOutcome('provider-b', true, 'review');
    store.recordOutcome('provider-b', false, 'review');

    // Without capability → aggregate, provider-a and provider-b are equal (10 each, same ratio)
    // With capability → specialized selection
    const codeGenResult = selectProvider(store, 'provider-b', 'code-gen');
    expect(codeGenResult.provider).toBe('provider-a');

    const reviewResult = selectProvider(store, 'provider-a', 'review');
    expect(reviewResult.provider).toBe('provider-b');
  });

  test('capability filter falls back when no capability data', () => {
    const store = makeTrustStore();
    const result = selectProvider(store, 'default', 'nonexistent');
    expect(result.provider).toBe('default');
    expect(result.basis).toBe('cold_start');
  });
});

describe('ProviderTrustStore', () => {
  test('recordOutcome updates in-memory cache', () => {
    const store = makeTrustStore();
    store.recordOutcome('test-provider', true);
    store.recordOutcome('test-provider', false);

    const record = store.getProvider('test-provider');
    expect(record).not.toBeNull();
    expect(record!.successes).toBe(1);
    expect(record!.failures).toBe(1);
  });

  test('getAllProviders returns all tracked providers', () => {
    const store = makeTrustStore();
    store.recordOutcome('a', true);
    store.recordOutcome('b', false);

    const all = store.getAllProviders();
    expect(all).toHaveLength(2);
    const names = all.map((p) => p.provider).sort();
    expect(names).toEqual(['a', 'b']);
  });

  test('getProvider returns null for unknown', () => {
    const store = makeTrustStore();
    expect(store.getProvider('nonexistent')).toBeNull();
  });
});
