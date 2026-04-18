/**
 * Rate Limiter — token-bucket per API key.
 *
 * Source of truth: spec/tdd.md §22.6
 */

export interface RateLimitConfig {
  defaultBucketSize: number;
  defaultRefillRate: number; // tokens per second
  endpointOverrides: Record<string, { bucketSize: number; refillRate: number }>;
}

interface Bucket {
  tokens: number;
  lastRefill: number;
}

const DEFAULT_CONFIG: RateLimitConfig = {
  defaultBucketSize: 100,
  defaultRefillRate: 10,
  endpointOverrides: {
    task_submit: { bucketSize: 20, refillRate: 2 },
    task_query: { bucketSize: 100, refillRate: 20 },
    session_mgmt: { bucketSize: 50, refillRate: 5 },
  },
};

export class RateLimiter {
  private buckets = new Map<string, Bucket>();
  private config: RateLimitConfig;

  constructor(config?: Partial<RateLimitConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Check if a request is allowed. Consumes a token if allowed.
   *
   * @param key — identifier (API key or IP)
   * @param category — endpoint category for per-category limits
   * @returns { allowed, retryAfterSeconds }
   */
  check(key: string, category?: string): { allowed: boolean; retryAfterSeconds: number } {
    const bucketKey = `${key}:${category ?? 'default'}`;
    const { bucketSize, refillRate } = this.getLimits(category);

    let bucket = this.buckets.get(bucketKey);
    const now = Date.now();

    if (!bucket) {
      bucket = { tokens: bucketSize, lastRefill: now };
      this.buckets.set(bucketKey, bucket);
    }

    // Refill tokens based on elapsed time
    const elapsed = (now - bucket.lastRefill) / 1000;
    bucket.tokens = Math.min(bucketSize, bucket.tokens + elapsed * refillRate);
    bucket.lastRefill = now;

    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      return { allowed: true, retryAfterSeconds: 0 };
    }

    // Calculate time until next token
    const retryAfterSeconds = Math.ceil((1 - bucket.tokens) / refillRate);
    return { allowed: false, retryAfterSeconds };
  }

  private getLimits(category?: string): { bucketSize: number; refillRate: number } {
    if (category && this.config.endpointOverrides[category]) {
      return this.config.endpointOverrides[category];
    }
    return {
      bucketSize: this.config.defaultBucketSize,
      refillRate: this.config.defaultRefillRate,
    };
  }

  /** Reset all buckets (for testing). */
  reset(): void {
    this.buckets.clear();
  }

  /**
   * Evict buckets whose `lastRefill` is older than `maxIdleMs`. A bucket
   * that has been idle longer than its full refill window is indistinguishable
   * from a freshly-created one (both start at `bucketSize` tokens), so
   * dropping it is safe and prevents unbounded growth across long uptimes.
   */
  prune(maxIdleMs: number): number {
    const cutoff = Date.now() - maxIdleMs;
    let removed = 0;
    for (const [k, b] of this.buckets) {
      if (b.lastRefill < cutoff) {
        this.buckets.delete(k);
        removed++;
      }
    }
    return removed;
  }

  /** Number of tracked buckets — for tests / observability. */
  size(): number {
    return this.buckets.size;
  }
}

/** Classify an endpoint path to a rate-limit category. */
export function classifyEndpoint(method: string, path: string): string | undefined {
  if (method === 'POST' && (path === '/api/v1/tasks' || path === '/api/v1/tasks/async')) {
    return 'task_submit';
  }
  if (method === 'GET' && path.startsWith('/api/v1/tasks/')) {
    return 'task_query';
  }
  if (path.startsWith('/api/v1/sessions')) {
    return 'session_mgmt';
  }
  // Health and metrics are not rate-limited
  if (path === '/api/v1/health' || path === '/api/v1/metrics') {
    return undefined;
  }
  return 'default';
}
