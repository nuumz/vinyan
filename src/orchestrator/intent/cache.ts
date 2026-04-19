/**
 * Generic LRU-with-TTL cache used by the intent resolver to skip
 * re-classifying identical goals within a short window.
 *
 * Extracted from `src/orchestrator/intent-resolver.ts` as part of Commit D
 * (intent-resolver slim — see /root/.claude/plans/cached-zooming-platypus.md).
 *
 * Design:
 *   - Map-backed, insertion-ordered so `drop oldest` iterates naturally
 *   - TTL enforcement on read (entries past `expiresAt` are treated as miss
 *     without eager deletion)
 *   - Lazy pruning: eviction of expired entries runs only when cache size
 *     crosses a threshold, keeping the common (small-cache) path
 *     zero-overhead
 *   - Hard cap via `maxSize` — when the live entry count still exceeds this
 *     after expired entries are pruned, drop the oldest until back under
 *
 * This mirrors the exact behaviour of the prior inline `intentCache` +
 * `pruneIntentCache` logic; callers get a clean API without changing
 * semantics.
 */

export interface LRUTTLCacheOptions {
  /** Entry lifetime in milliseconds. */
  ttlMs: number;
  /** Pruning kicks in only when `size >= pruneThreshold`. */
  pruneThreshold: number;
  /** Hard cap — after pruning expired, drop oldest until back under this. */
  maxSize: number;
}

export class LRUTTLCache<T> {
  private readonly store = new Map<string, { value: T; expiresAt: number }>();

  constructor(private readonly opts: LRUTTLCacheOptions) {}

  /** Current entry count (including expired-but-unpruned). */
  get size(): number {
    return this.store.size;
  }

  /** Test-only: reset. */
  clear(): void {
    this.store.clear();
  }

  /**
   * Fetch a live entry or `undefined`. Expired entries are treated as miss
   * but NOT deleted here — pruning is batched in `prune()` for efficiency.
   */
  get(key: string, now: number = Date.now()): T | undefined {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= now) return undefined;
    return entry.value;
  }

  /** Insert / overwrite an entry. Does NOT prune — caller invokes `prune()` separately. */
  set(key: string, value: T, now: number = Date.now()): void {
    this.store.set(key, { value, expiresAt: now + this.opts.ttlMs });
  }

  /**
   * Evict expired entries, then enforce the hard size cap by dropping the
   * oldest (insertion-ordered) entries. Cheap no-op when under the
   * pruneThreshold.
   */
  prune(now: number = Date.now()): void {
    if (this.store.size < this.opts.pruneThreshold) return;

    for (const [key, entry] of this.store) {
      if (entry.expiresAt <= now) this.store.delete(key);
    }

    if (this.store.size > this.opts.maxSize) {
      const overflow = this.store.size - this.opts.maxSize;
      let dropped = 0;
      for (const key of this.store.keys()) {
        if (dropped >= overflow) break;
        this.store.delete(key);
        dropped++;
      }
    }
  }
}
