/**
 * R2 — retry sleep emits heartbeat ticks during long backoffs so the
 * delegate watchdog does not flag the pause as a hang.
 *
 * Verifies:
 *   - sleepWithHeartbeat invokes onTick at the requested cadence
 *   - total sleep duration is honored (not extended by the heartbeat)
 *   - short sleeps shorter than one interval emit zero ticks
 *   - retryWithBackoff fires onAttempt before AND during long sleeps
 */
import { describe, expect, test } from 'bun:test';
import { retryWithBackoff, sleepWithHeartbeat } from '../../../src/orchestrator/llm/retry.ts';

describe('R2 sleepWithHeartbeat', () => {
  test('emits one tick per interval before the final residual sleep', async () => {
    let ticks = 0;
    const start = Date.now();
    await sleepWithHeartbeat(120, 50, () => {
      ticks++;
    });
    const elapsed = Date.now() - start;
    // Two full intervals (50ms each) → 2 ticks; remaining 20ms is residual.
    expect(ticks).toBe(2);
    // Honor total: 120ms ± setTimeout jitter.
    expect(elapsed).toBeGreaterThanOrEqual(110);
    expect(elapsed).toBeLessThan(250);
  });

  test('zero ticks when sleep is shorter than the interval', async () => {
    let ticks = 0;
    await sleepWithHeartbeat(20, 50, () => {
      ticks++;
    });
    expect(ticks).toBe(0);
  });
});

describe('R2 retryWithBackoff — onAttempt fires before AND during long backoff', () => {
  test('a 200ms backoff with 50ms heartbeat cadence triggers ≥3 onAttempt calls', async () => {
    const calls: number[] = [];
    let attempt = 0;
    const result = await retryWithBackoff(
      async () => {
        attempt++;
        if (attempt === 1) {
          // Force a retryable error.
          const err = new Error('429 rate limit');
          (err as { status?: number }).status = 429;
          throw err;
        }
        return 'ok';
      },
      {
        maxRetries: 1,
        baseDelayMs: 200,
        timeoutMs: 10_000,
        retryableStatuses: new Set([429]),
        heartbeatIntervalMs: 50,
        onAttempt: ({ delayMs }) => {
          calls.push(delayMs);
        },
      },
    );
    expect(result).toBe('ok');
    // 1 pre-sleep call + ≥3 mid-sleep heartbeats (200ms / 50ms ≈ 3-4).
    expect(calls.length).toBeGreaterThanOrEqual(3);
  });
});
