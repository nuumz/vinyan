/**
 * Gateway rate limiter — per-user token bucket.
 *
 * Protects the gateway from runaway or malicious inbound volume. Paired
 * with dispatcher-level pairing gating so unpaired senders cannot burn
 * through the paired-tier budget.
 *
 * A3 (deterministic governance): the limiter is a pure function of
 * (platformUserId, trustTier, clock) — same inputs, same verdict. No LLM,
 * no randomness.
 *
 * Defaults:
 *   - unpaired: 3 messages / minute (accounts still in `unknown` or
 *     `pairing` trust tier).
 *   - paired:   20 messages / minute.
 *   - admin:    unlimited.
 */

export interface RateLimitBucketConfig {
  readonly capacity: number;
  readonly refillPerSec: number;
}

export interface RateLimitConfig {
  readonly pairedBucket: RateLimitBucketConfig;
  readonly unpairedBucket: RateLimitBucketConfig;
}

const DEFAULT_CONFIG: RateLimitConfig = {
  pairedBucket: { capacity: 20, refillPerSec: 20 / 60 },
  unpairedBucket: { capacity: 3, refillPerSec: 3 / 60 },
};

type TrustTier = 'unknown' | 'pairing' | 'paired' | 'admin';

interface BucketState {
  tokens: number;
  lastRefillMs: number;
}

export class GatewayRateLimiter {
  private readonly config: RateLimitConfig;
  private readonly clock: () => number;
  private readonly buckets = new Map<string, BucketState>();

  constructor(config?: Partial<RateLimitConfig>, clock?: () => number) {
    this.config = {
      pairedBucket: config?.pairedBucket ?? DEFAULT_CONFIG.pairedBucket,
      unpairedBucket: config?.unpairedBucket ?? DEFAULT_CONFIG.unpairedBucket,
    };
    this.clock = clock ?? Date.now;
  }

  /**
   * Returns `true` if the caller is allowed to send a message, `false`
   * if the bucket is empty. Stateful per (platformUserId, trust-tier class).
   */
  check(platformUserId: string, trustTier: TrustTier): boolean {
    // Admin bypasses the limiter — typed-only tier, assignment is out of scope
    // here, but we honor it so downstream overrides work without patching.
    if (trustTier === 'admin') return true;

    const bucketKind: 'paired' | 'unpaired' = trustTier === 'paired' ? 'paired' : 'unpaired';
    const bucketCfg =
      bucketKind === 'paired' ? this.config.pairedBucket : this.config.unpairedBucket;
    const key = `${bucketKind}:${platformUserId}`;

    const now = this.clock();
    const state = this.buckets.get(key);

    if (!state) {
      // First message from this user — start full, consume one.
      this.buckets.set(key, { tokens: bucketCfg.capacity - 1, lastRefillMs: now });
      return true;
    }

    // Refill based on elapsed wall-clock time.
    const elapsedSec = Math.max(0, (now - state.lastRefillMs) / 1000);
    const refilled = Math.min(
      bucketCfg.capacity,
      state.tokens + elapsedSec * bucketCfg.refillPerSec,
    );
    state.lastRefillMs = now;

    if (refilled < 1) {
      state.tokens = refilled;
      return false;
    }

    state.tokens = refilled - 1;
    return true;
  }

  /** Test hook — reset the bucket for a specific user. */
  reset(platformUserId: string): void {
    for (const kind of ['paired', 'unpaired'] as const) {
      this.buckets.delete(`${kind}:${platformUserId}`);
    }
  }

  /** Test hook — wipe all buckets. */
  resetAll(): void {
    this.buckets.clear();
  }
}
