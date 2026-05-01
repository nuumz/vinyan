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
  test('a 300ms backoff with 100ms heartbeat cadence triggers multiple onAttempt calls', async () => {
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
        baseDelayMs: 300,
        timeoutMs: 10_000,
        retryableStatuses: new Set([429]),
        heartbeatIntervalMs: 100,
        onAttempt: ({ delayMs }) => {
          calls.push(delayMs);
        },
      },
    );
    expect(result).toBe('ok');
    // Pre-sleep call + ≥1 mid-sleep heartbeat (300ms / 100ms ≈ 2 ticks before residual).
    expect(calls.length).toBeGreaterThanOrEqual(2);
  });
});
