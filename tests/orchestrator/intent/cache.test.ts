/**
 * LRUTTLCache — unit tests for the cache extracted from intent-resolver.ts
 * (plan commit D1).
 *
 * These tests pin the behaviour that the prior inline `intentCache` +
 * `pruneIntentCache` logic delivered, so future refactors can rely on the
 * extracted module instead of re-deriving semantics from the original site.
 */
import { describe, expect, it } from 'bun:test';
import { LRUTTLCache } from '../../../src/orchestrator/intent/cache.ts';

describe('LRUTTLCache', () => {
  const opts = { ttlMs: 1000, pruneThreshold: 4, maxSize: 6 };

  it('round-trips a single entry within its TTL', () => {
    const cache = new LRUTTLCache<string>(opts);
    const t0 = 1_000_000;
    cache.set('a', 'hello', t0);
    expect(cache.get('a', t0 + 500)).toBe('hello');
    expect(cache.size).toBe(1);
  });

  it('treats expired entries as miss without eagerly deleting them', () => {
    const cache = new LRUTTLCache<string>(opts);
    const t0 = 1_000_000;
    cache.set('a', 'hello', t0);
    expect(cache.get('a', t0 + opts.ttlMs + 1)).toBeUndefined();
    // Still present until prune runs
    expect(cache.size).toBe(1);
  });

  it('returns undefined on miss', () => {
    const cache = new LRUTTLCache<string>(opts);
    expect(cache.get('missing')).toBeUndefined();
  });

  it('overwrites an existing key and resets expiry', () => {
    const cache = new LRUTTLCache<string>(opts);
    const t0 = 1_000_000;
    cache.set('a', 'first', t0);
    cache.set('a', 'second', t0 + 100);
    // Second write's expiry = t0 + 100 + ttlMs(1000) = t0 + 1100
    expect(cache.get('a', t0 + 500)).toBe('second');
    expect(cache.get('a', t0 + 1099)).toBe('second');
    expect(cache.get('a', t0 + 1100)).toBeUndefined(); // expiresAt <= now ⇒ miss
  });

  it('prune is a no-op below the threshold', () => {
    const cache = new LRUTTLCache<string>(opts);
    const t0 = 1_000_000;
    // Insert 3 entries (threshold=4). One expired.
    cache.set('a', 'A', t0);
    cache.set('b', 'B', t0);
    cache.set('c', 'C', t0);
    cache.prune(t0 + opts.ttlMs + 1);
    // Still 3 — prune skipped because size < threshold
    expect(cache.size).toBe(3);
  });

  it('prune evicts expired entries once at threshold', () => {
    const cache = new LRUTTLCache<string>(opts);
    const t0 = 1_000_000;
    for (let i = 0; i < 4; i++) cache.set(`k${i}`, `v${i}`, t0);
    expect(cache.size).toBe(4);
    cache.prune(t0 + opts.ttlMs + 1);
    expect(cache.size).toBe(0);
  });

  it('prune enforces maxSize by dropping oldest when all live', () => {
    const cache = new LRUTTLCache<string>(opts);
    const t0 = 1_000_000;
    // Insert 8 entries (threshold=4, maxSize=6) — all live
    for (let i = 0; i < 8; i++) cache.set(`k${i}`, `v${i}`, t0 + i);
    // prune at t0 (all still live)
    cache.prune(t0);
    expect(cache.size).toBe(6);
    // Oldest (k0, k1) dropped
    expect(cache.get('k0', t0)).toBeUndefined();
    expect(cache.get('k1', t0)).toBeUndefined();
    expect(cache.get('k7', t0)).toBe('v7');
  });

  it('prune prefers expired over maxSize drops', () => {
    const cache = new LRUTTLCache<string>(opts);
    const t0 = 1_000_000;
    // 4 expired + 3 live = 7 total (above threshold=4)
    for (let i = 0; i < 4; i++) cache.set(`old${i}`, `o${i}`, t0);
    for (let i = 0; i < 3; i++) cache.set(`new${i}`, `n${i}`, t0 + opts.ttlMs + 1);
    cache.prune(t0 + opts.ttlMs + 500);
    // Expired 4 dropped → 3 live, below maxSize → no further drops
    expect(cache.size).toBe(3);
    expect(cache.get('old0', t0 + opts.ttlMs + 500)).toBeUndefined();
    expect(cache.get('new0', t0 + opts.ttlMs + 500)).toBe('n0');
  });

  it('clear resets the cache entirely', () => {
    const cache = new LRUTTLCache<string>(opts);
    const t0 = 1_000_000;
    cache.set('a', 'A', t0);
    cache.set('b', 'B', t0);
    cache.clear();
    expect(cache.size).toBe(0);
    expect(cache.get('a', t0)).toBeUndefined();
  });

  it('works with generic value types (e.g. objects)', () => {
    type Result = { strategy: string; score: number };
    const cache = new LRUTTLCache<Result>(opts);
    const t0 = 1_000_000;
    cache.set('key', { strategy: 'direct', score: 0.9 }, t0);
    expect(cache.get('key', t0)).toEqual({ strategy: 'direct', score: 0.9 });
  });
});
