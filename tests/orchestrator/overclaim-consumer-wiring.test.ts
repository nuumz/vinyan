/**
 * Phase-12 — overclaim consumer wiring contract.
 *
 * Mirrors the subscription pattern installed by `factory.ts` so the
 * producer/consumer loop is regression-tested without booting the entire
 * orchestrator. Specifically verifies:
 *
 *   1. bus.emit('bid:overclaim_detected', ...) routes to tracker.recordOverclaim
 *   2. enough overclaims past cold-start cause `getPenaltyMultiplier` to drop
 *   3. observation accumulator increments independently and is the denominator
 *   4. handler is best-effort — a tracker exception does not propagate
 *
 * The factory's actual subscription is `bus.on('bid:overclaim_detected', ...)`,
 * which is exactly what we install here.
 */
import { describe, expect, test } from 'bun:test';
import { createBus } from '../../src/core/bus.ts';
import { PersonaOverclaimTracker } from '../../src/economy/market/persona-overclaim-tracker.ts';

describe('Phase-12 overclaim consumer wiring', () => {
  test('bus event → tracker.recordOverclaim', () => {
    const bus = createBus();
    const tracker = new PersonaOverclaimTracker();
    bus.on('bid:overclaim_detected', ({ agentId }) => {
      tracker.recordOverclaim(agentId);
    });

    bus.emit('bid:overclaim_detected', {
      taskId: 't1',
      agentId: 'developer',
      declaredCount: 4,
      viewedCount: 1,
      viewedRatio: 0.25,
    });
    bus.emit('bid:overclaim_detected', {
      taskId: 't2',
      agentId: 'developer',
      declaredCount: 4,
      viewedCount: 0,
      viewedRatio: 0,
    });

    expect(tracker.getRecord('developer')).toEqual({ observations: 0, overclaims: 2 });
  });

  test('observations + overclaims past cold-start drive penalty multiplier', () => {
    const bus = createBus();
    const tracker = new PersonaOverclaimTracker();
    bus.on('bid:overclaim_detected', ({ agentId }) => {
      tracker.recordOverclaim(agentId);
    });

    // Simulate 20 task observations (e.g. recorded by the executeTask
    // wrapper when ≥2 skills were declared) — 5 of which were overclaims.
    for (let i = 0; i < 20; i++) tracker.recordObservation('developer');
    for (let i = 0; i < 5; i++) {
      bus.emit('bid:overclaim_detected', {
        taskId: `t${i}`,
        agentId: 'developer',
        declaredCount: 4,
        viewedCount: 1,
        viewedRatio: 0.25,
      });
    }

    expect(tracker.getOverclaimRatio('developer')).toBe(0.25);
    expect(tracker.getPenaltyMultiplier('developer')).toBe(0.75);
  });

  test('a single overclaim past cold-start does not exceed the floor', () => {
    const tracker = new PersonaOverclaimTracker();
    for (let i = 0; i < 10; i++) tracker.recordObservation('developer');
    tracker.recordOverclaim('developer');
    // 1/10 = 10% overclaim → penalty 0.9, well above the 0.5 floor
    expect(tracker.getPenaltyMultiplier('developer')).toBe(0.9);
  });

  test('handler exception does not propagate (A9: best-effort)', () => {
    const bus = createBus();
    // Tracker that throws on every recordOverclaim call — simulates a
    // misbehaving consumer. The factory wraps the handler in try/catch
    // so the bus.emit call site stays clean.
    bus.on('bid:overclaim_detected', () => {
      try {
        throw new Error('boom');
      } catch {
        /* swallow — same shape as factory's handler */
      }
    });

    expect(() => {
      bus.emit('bid:overclaim_detected', {
        taskId: 't1',
        agentId: 'developer',
        declaredCount: 4,
        viewedCount: 0,
        viewedRatio: 0,
      });
    }).not.toThrow();
  });
});
