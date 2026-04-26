/**
 * Tests for MarketScheduler.registerTickHook — w1-contracts §9.A3.
 *
 * Covers only the tick-hook surface added in the W3 follow-up; the legacy
 * auction/settlement behaviors are exercised elsewhere (auction-engine,
 * settlement-engine, market-phase specs). Additive by design.
 */
import { describe, expect, test } from 'bun:test';
import { type MarketConfig, MarketConfigSchema } from '../../../src/economy/economy-config.ts';
import { MarketScheduler } from '../../../src/economy/market/market-scheduler.ts';

function baseConfig(): MarketConfig {
  return MarketConfigSchema.parse({ enabled: true });
}

describe('MarketScheduler — registerTickHook', () => {
  test('hook is invoked once per tick() call', () => {
    const scheduler = new MarketScheduler(baseConfig());
    let calls = 0;
    scheduler.registerTickHook(() => {
      calls++;
    });

    scheduler.tick();
    scheduler.tick();
    scheduler.tick();

    expect(calls).toBe(3);
  });

  test('unsubscribe removes the hook', () => {
    const scheduler = new MarketScheduler(baseConfig());
    let calls = 0;
    const unsubscribe = scheduler.registerTickHook(() => {
      calls++;
    });

    scheduler.tick();
    expect(calls).toBe(1);

    unsubscribe();
    scheduler.tick();
    scheduler.tick();
    expect(calls).toBe(1);
  });

  test('hook that throws does not break subsequent hooks', () => {
    const scheduler = new MarketScheduler(baseConfig());
    let laterCalls = 0;
    scheduler.registerTickHook(() => {
      throw new Error('hook-one-broken');
    });
    scheduler.registerTickHook(() => {
      laterCalls++;
    });

    expect(() => scheduler.tick()).not.toThrow();
    expect(laterCalls).toBe(1);
  });

  test('async hook rejection does not escape tick', () => {
    const scheduler = new MarketScheduler(baseConfig());
    scheduler.registerTickHook(async () => {
      throw new Error('async-boom');
    });
    // tick() is synchronous in spirit — it may schedule async work but must
    // not throw synchronously even when a hook returns a rejected promise.
    expect(() => scheduler.tick()).not.toThrow();
  });

  test('multiple hooks all run in registration order', () => {
    const scheduler = new MarketScheduler(baseConfig());
    const order: number[] = [];
    scheduler.registerTickHook(() => {
      order.push(1);
    });
    scheduler.registerTickHook(() => {
      order.push(2);
    });
    scheduler.registerTickHook(() => {
      order.push(3);
    });

    scheduler.tick();
    expect(order).toEqual([1, 2, 3]);
  });
});
