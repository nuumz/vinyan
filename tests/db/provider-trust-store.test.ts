/**
 * Tests for K2.1 Provider Trust Store — per-capability trust tracking.
 */
import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { ProviderTrustStore } from '../../src/db/provider-trust-store.ts';

function makeTrustStore(): ProviderTrustStore {
  const db = new Database(':memory:');
  return new ProviderTrustStore(db);
}

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

  test('recordOutcome with capability tracks per-capability', () => {
    const store = makeTrustStore();
    store.recordOutcome('claude', true, 'code-gen');
    store.recordOutcome('claude', false, 'code-gen');
    store.recordOutcome('claude', true, 'review');

    const codeGen = store.getProviderCapability('claude', 'code-gen');
    expect(codeGen).not.toBeNull();
    expect(codeGen!.successes).toBe(1);
    expect(codeGen!.failures).toBe(1);

    const review = store.getProviderCapability('claude', 'review');
    expect(review).not.toBeNull();
    expect(review!.successes).toBe(1);
    expect(review!.failures).toBe(0);
  });

  test('getProvider aggregates across capabilities', () => {
    const store = makeTrustStore();
    store.recordOutcome('claude', true, 'code-gen');
    store.recordOutcome('claude', true, 'review');
    store.recordOutcome('claude', false, 'test');

    const agg = store.getProvider('claude');
    expect(agg).not.toBeNull();
    expect(agg!.successes).toBe(2);
    expect(agg!.failures).toBe(1);
    expect(agg!.capability).toBe('*');
  });

  test('getProvidersByCapability returns matching records', () => {
    const store = makeTrustStore();
    store.recordOutcome('claude', true, 'code-gen');
    store.recordOutcome('gpt', true, 'code-gen');
    store.recordOutcome('gpt', true, 'review');

    const codeGenProviders = store.getProvidersByCapability('code-gen');
    expect(codeGenProviders).toHaveLength(2);
    const names = codeGenProviders.map((p) => p.provider).sort();
    expect(names).toEqual(['claude', 'gpt']);
  });

  test('getProvidersByCapability includes wildcard records', () => {
    const store = makeTrustStore();
    store.recordOutcome('claude', true); // default capability = '*'
    store.recordOutcome('gpt', true, 'code-gen');

    const codeGenProviders = store.getProvidersByCapability('*');
    const names = codeGenProviders.map((p) => p.provider);
    expect(names).toContain('claude');
  });

  test('getProviderCapability returns null for unknown pair', () => {
    const store = makeTrustStore();
    store.recordOutcome('claude', true, 'code-gen');
    expect(store.getProviderCapability('claude', 'unknown')).toBeNull();
  });

  test('evidence_hash is stored and retrievable', () => {
    const store = makeTrustStore();
    store.recordOutcome('claude', true, 'code-gen', 'sha256:abc123');

    const record = store.getProviderCapability('claude', 'code-gen');
    expect(record).not.toBeNull();
    expect(record!.evidenceHash).toBe('sha256:abc123');
  });

  test('backward compatible: default capability is *', () => {
    const store = makeTrustStore();
    store.recordOutcome('claude', true);

    const record = store.getProviderCapability('claude', '*');
    expect(record).not.toBeNull();
    expect(record!.successes).toBe(1);
  });

  test('warm cache restores from SQLite', () => {
    const db = new Database(':memory:');
    const store1 = new ProviderTrustStore(db);
    store1.recordOutcome('claude', true, 'code-gen');
    store1.recordOutcome('claude', false, 'review');

    // Create a new store from the same DB — should warm from SQLite
    const store2 = new ProviderTrustStore(db);
    const codeGen = store2.getProviderCapability('claude', 'code-gen');
    expect(codeGen).not.toBeNull();
    expect(codeGen!.successes).toBe(1);

    const review = store2.getProviderCapability('claude', 'review');
    expect(review).not.toBeNull();
    expect(review!.failures).toBe(1);
  });
});
