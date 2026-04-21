/**
 * Tests for GatewayRateLimiter — per-user token bucket.
 */

import { describe, expect, test } from 'bun:test';
import { GatewayRateLimiter } from '../../../src/gateway/security/rate-limiter.ts';

function makeClock(initial = 0): { now: () => number; advance: (ms: number) => void } {
  let t = initial;
  return {
    now: () => t,
    advance: (ms) => {
      t += ms;
    },
  };
}

describe('GatewayRateLimiter', () => {
  test('unpaired: caps at the 3-per-minute default (4th call denied within 1s)', () => {
    const clock = makeClock();
    const rl = new GatewayRateLimiter(undefined, clock.now);
    expect(rl.check('u1', 'unknown')).toBe(true);
    expect(rl.check('u1', 'unknown')).toBe(true);
    expect(rl.check('u1', 'unknown')).toBe(true);
    expect(rl.check('u1', 'unknown')).toBe(false);
  });

  test('pairing tier uses the same unpaired bucket as unknown', () => {
    const clock = makeClock();
    const rl = new GatewayRateLimiter(undefined, clock.now);
    expect(rl.check('u1', 'pairing')).toBe(true);
    expect(rl.check('u1', 'pairing')).toBe(true);
    expect(rl.check('u1', 'pairing')).toBe(true);
    expect(rl.check('u1', 'pairing')).toBe(false);
  });

  test('paired: 20-per-minute default allows 20 then denies the 21st', () => {
    const clock = makeClock();
    const rl = new GatewayRateLimiter(undefined, clock.now);
    for (let i = 0; i < 20; i++) {
      expect(rl.check('u1', 'paired')).toBe(true);
    }
    expect(rl.check('u1', 'paired')).toBe(false);
  });

  test('admin is unlimited', () => {
    const clock = makeClock();
    const rl = new GatewayRateLimiter(
      { pairedBucket: { capacity: 1, refillPerSec: 0 }, unpairedBucket: { capacity: 1, refillPerSec: 0 } },
      clock.now,
    );
    for (let i = 0; i < 1000; i++) {
      expect(rl.check('admin-user', 'admin')).toBe(true);
    }
  });

  test('refills after clock advance', () => {
    const clock = makeClock();
    const rl = new GatewayRateLimiter(
      { unpairedBucket: { capacity: 1, refillPerSec: 1 }, pairedBucket: { capacity: 1, refillPerSec: 1 } },
      clock.now,
    );
    expect(rl.check('u1', 'unknown')).toBe(true);
    expect(rl.check('u1', 'unknown')).toBe(false);
    clock.advance(1000);
    expect(rl.check('u1', 'unknown')).toBe(true);
  });

  test('buckets are per-user: one user exhausting does not starve another', () => {
    const clock = makeClock();
    const rl = new GatewayRateLimiter(undefined, clock.now);
    for (let i = 0; i < 3; i++) rl.check('heavy', 'unknown');
    expect(rl.check('heavy', 'unknown')).toBe(false);
    expect(rl.check('fresh', 'unknown')).toBe(true);
  });
});
