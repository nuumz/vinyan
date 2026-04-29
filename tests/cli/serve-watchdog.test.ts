import { describe, expect, test } from 'bun:test';
import { nextParentWatchdogIntervalMs } from '../../src/cli/serve.ts';

describe('serve parent watchdog backoff', () => {
  test('keeps tight polling during early uptime', () => {
    expect(nextParentWatchdogIntervalMs(1_000, 0)).toBe(1_000);
    expect(nextParentWatchdogIntervalMs(8_000, 59_999)).toBe(1_000);
  });

  test('backs off after the early zombie-detection window and caps the interval', () => {
    expect(nextParentWatchdogIntervalMs(1_000, 60_000)).toBe(2_000);
    expect(nextParentWatchdogIntervalMs(16_000, 120_000)).toBe(30_000);
    expect(nextParentWatchdogIntervalMs(30_000, 180_000)).toBe(30_000);
  });
});
