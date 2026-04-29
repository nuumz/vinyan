/**
 * Tests for retry helpers — covers both the wall-clock `retryWithBackoff`
 * (used by non-streaming `provider.generate`) and the three-timeout
 * `retryStreamWithBackoff` (used by `provider.generateStream`).
 *
 * Real timers with small intervals; no fake-timer machinery so the order in
 * which AbortSignal events propagate matches production.
 */
import { describe, expect, test } from 'bun:test';
import {
  DEFAULT_RETRYABLE_STATUSES,
  retryStreamWithBackoff,
  retryWithBackoff,
} from '@vinyan/orchestrator/llm/retry.ts';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const baseConfig = {
  maxRetries: 0,
  baseDelayMs: 1,
  retryableStatuses: DEFAULT_RETRYABLE_STATUSES,
};

const baseStreamConfig = {
  ...baseConfig,
  connectTimeoutMs: 10_000,
  idleTimeoutMs: 10_000,
  wallClockMs: 10_000,
};

// ── retryWithBackoff ──────────────────────────────────────────────────

describe('retryWithBackoff', () => {
  test('returns result on success', async () => {
    const result = await retryWithBackoff(async () => 42, { ...baseConfig, timeoutMs: 1_000 });
    expect(result).toBe(42);
  });

  test('wall-clock timeout aborts the attempt', async () => {
    await expect(
      retryWithBackoff(
        async (signal) => {
          await new Promise((_, reject) => {
            signal.addEventListener('abort', () => reject(new Error('aborted')));
          });
          return 'never';
        },
        { ...baseConfig, timeoutMs: 30 },
      ),
    ).rejects.toThrow(/timeout after 30ms/);
  });

  test('retries on retryable status code', async () => {
    let attempts = 0;
    const result = await retryWithBackoff(
      async () => {
        attempts++;
        if (attempts < 2) {
          const err = new Error('rate limited') as Error & { status: number };
          err.status = 429;
          throw err;
        }
        return 'ok';
      },
      { ...baseConfig, maxRetries: 2, timeoutMs: 1_000 },
    );
    expect(result).toBe('ok');
    expect(attempts).toBe(2);
  });

  test('onAttempt fires before each backoff sleep with attempt + delay + reason', async () => {
    const events: Array<{ attempt: number; delayMs: number; reason: string; status?: number }> = [];
    let attempts = 0;
    const result = await retryWithBackoff(
      async () => {
        attempts++;
        if (attempts < 3) {
          const err = new Error('rate limited') as Error & { status: number };
          err.status = 429;
          throw err;
        }
        return 'ok';
      },
      {
        ...baseConfig,
        maxRetries: 3,
        timeoutMs: 1_000,
        onAttempt: (info) => events.push(info),
      },
    );
    expect(result).toBe('ok');
    expect(attempts).toBe(3);
    // Two failed attempts → two onAttempt calls before the final success.
    expect(events).toHaveLength(2);
    expect(events[0]?.attempt).toBe(0);
    expect(events[1]?.attempt).toBe(1);
    expect(events[0]?.delayMs).toBeGreaterThan(0);
    expect(events[0]?.reason).toMatch(/rate limited/);
    expect(events[0]?.status).toBe(429);
  });

  test('onAttempt is NOT called for non-retryable failures (terminal throw)', async () => {
    const events: unknown[] = [];
    await expect(
      retryWithBackoff(
        async () => {
          const err = new Error('bad request') as Error & { status: number };
          err.status = 400;
          throw err;
        },
        {
          ...baseConfig,
          maxRetries: 3,
          timeoutMs: 1_000,
          onAttempt: (info) => events.push(info),
        },
      ),
    ).rejects.toThrow(/bad request/);
    expect(events).toHaveLength(0);
  });

  test('onAttempt errors are swallowed (buggy hook does not break retry)', async () => {
    let attempts = 0;
    const result = await retryWithBackoff(
      async () => {
        attempts++;
        if (attempts < 2) {
          const err = new Error('throttle') as Error & { status: number };
          err.status = 429;
          throw err;
        }
        return 'ok';
      },
      {
        ...baseConfig,
        maxRetries: 2,
        timeoutMs: 1_000,
        onAttempt: () => {
          throw new Error('hook is broken');
        },
      },
    );
    expect(result).toBe('ok');
    expect(attempts).toBe(2);
  });

  test('does not retry on non-retryable status', async () => {
    let attempts = 0;
    await expect(
      retryWithBackoff(
        async () => {
          attempts++;
          const err = new Error('bad request') as Error & { status: number };
          err.status = 400;
          throw err;
        },
        { ...baseConfig, maxRetries: 3, timeoutMs: 1_000 },
      ),
    ).rejects.toThrow('bad request');
    expect(attempts).toBe(1);
  });
});

// ── retryStreamWithBackoff ────────────────────────────────────────────

describe('retryStreamWithBackoff', () => {
  test('returns result on success without firing any timeout', async () => {
    const result = await retryStreamWithBackoff(async (_signal, hooks) => {
      hooks.firstByte();
      hooks.activity();
      return 'ok';
    }, baseStreamConfig);
    expect(result).toBe('ok');
  });

  test('connect timeout fires when firstByte() is never called', async () => {
    await expect(
      retryStreamWithBackoff(
        async (signal) => {
          await new Promise((_, reject) => {
            signal.addEventListener('abort', () => reject(new Error('aborted')));
          });
          return 'never';
        },
        { ...baseStreamConfig, connectTimeoutMs: 30 },
      ),
    ).rejects.toThrow(/connect timeout after 30ms/);
  });

  test('idle timeout fires after firstByte if no activity', async () => {
    await expect(
      retryStreamWithBackoff(
        async (signal, hooks) => {
          hooks.firstByte();
          await new Promise((_, reject) => {
            signal.addEventListener('abort', () => reject(new Error('aborted')));
          });
          return 'never';
        },
        { ...baseStreamConfig, connectTimeoutMs: 1_000, idleTimeoutMs: 30 },
      ),
    ).rejects.toThrow(/idle timeout.*after 30ms/);
  });

  test('activity() resets the idle timer (long stream survives)', async () => {
    // Idle window is 50ms. Caller emits activity every 20ms for 200ms total,
    // then completes. Without reset semantics this would fire at 50ms.
    const result = await retryStreamWithBackoff(
      async (_signal, hooks) => {
        hooks.firstByte();
        for (let i = 0; i < 10; i++) {
          await sleep(20);
          hooks.activity();
        }
        return 'completed';
      },
      { ...baseStreamConfig, connectTimeoutMs: 1_000, idleTimeoutMs: 50, wallClockMs: 5_000 },
    );
    expect(result).toBe('completed');
  });

  test('wall-clock timeout fires even with continuous activity', async () => {
    await expect(
      retryStreamWithBackoff(
        async (signal, hooks) => {
          hooks.firstByte();
          // Keep heartbeating well below idle window so only wall-clock can fire.
          while (!signal.aborted) {
            await sleep(5);
            hooks.activity();
          }
          throw new Error('aborted');
        },
        { ...baseStreamConfig, connectTimeoutMs: 1_000, idleTimeoutMs: 1_000, wallClockMs: 80 },
      ),
    ).rejects.toThrow(/wall-clock timeout after 80ms/);
  });

  test('activity() implicitly promotes to firstByte (single-signal callers)', async () => {
    // Caller never calls firstByte() — only activity(). Connect timer should
    // be cancelled by the first activity() call.
    const result = await retryStreamWithBackoff(
      async (_signal, hooks) => {
        for (let i = 0; i < 5; i++) {
          await sleep(15);
          hooks.activity();
        }
        return 'ok';
      },
      { ...baseStreamConfig, connectTimeoutMs: 30, idleTimeoutMs: 50, wallClockMs: 5_000 },
    );
    expect(result).toBe('ok');
  });

  test('retries on idle timeout', async () => {
    let attempts = 0;
    const result = await retryStreamWithBackoff(
      async (signal, hooks) => {
        attempts++;
        hooks.firstByte();
        if (attempts < 2) {
          // Block until idle fires.
          await new Promise((_, reject) => {
            signal.addEventListener('abort', () => reject(new Error('aborted')));
          });
        }
        return 'ok';
      },
      { ...baseStreamConfig, maxRetries: 2, connectTimeoutMs: 1_000, idleTimeoutMs: 30 },
    );
    expect(result).toBe('ok');
    expect(attempts).toBe(2);
  });

  test('external signal cancel propagates without timeout wrap', async () => {
    const ext = new AbortController();
    setTimeout(() => ext.abort(new Error('user cancelled')), 20);
    await expect(
      retryStreamWithBackoff(
        async (signal) => {
          await new Promise((_, reject) => {
            signal.addEventListener('abort', () => reject(new Error('aborted')));
          });
          return 'never';
        },
        { ...baseStreamConfig, externalSignal: ext.signal },
      ),
    ).rejects.toThrow('aborted');
  });

  test('does not retry on non-retryable status', async () => {
    let attempts = 0;
    await expect(
      retryStreamWithBackoff(
        async (_signal, hooks) => {
          attempts++;
          hooks.firstByte();
          const err = new Error('bad request') as Error & { status: number };
          err.status = 400;
          throw err;
        },
        { ...baseStreamConfig, maxRetries: 3 },
      ),
    ).rejects.toThrow('bad request');
    expect(attempts).toBe(1);
  });

  test('parseRetryAfter is honoured between attempts', async () => {
    const starts: number[] = [];
    let attempts = 0;
    await retryStreamWithBackoff(
      async (_signal, hooks) => {
        starts.push(Date.now());
        attempts++;
        hooks.firstByte();
        if (attempts < 2) {
          const err = new Error('rate limited') as Error & { status: number; ra: number };
          err.status = 429;
          err.ra = 50; // ms
          throw err;
        }
        return 'ok';
      },
      {
        ...baseStreamConfig,
        maxRetries: 2,
        baseDelayMs: 10_000, // huge — would dominate if parseRetryAfter were ignored
        parseRetryAfter: (e) => (e as { ra?: number }).ra,
      },
    );
    expect(attempts).toBe(2);
    const gap = starts[1]! - starts[0]!;
    expect(gap).toBeGreaterThanOrEqual(40);
    expect(gap).toBeLessThan(500);
  });

  test('onAttempt fires for stream retry with delay + reason', async () => {
    const events: Array<{ attempt: number; delayMs: number; reason: string }> = [];
    let attempts = 0;
    const result = await retryStreamWithBackoff(
      async (_signal, hooks) => {
        attempts++;
        hooks.firstByte();
        if (attempts < 2) {
          const err = new Error('throttle') as Error & { status: number };
          err.status = 429;
          throw err;
        }
        return 'ok';
      },
      {
        ...baseStreamConfig,
        maxRetries: 2,
        onAttempt: (info) => events.push(info),
      },
    );
    expect(result).toBe('ok');
    expect(events).toHaveLength(1);
    expect(events[0]?.attempt).toBe(0);
    expect(events[0]?.delayMs).toBeGreaterThan(0);
    expect(events[0]?.reason).toMatch(/throttle/);
  });
});
