/**
 * Book-integration Wave 5.7a: DebateBudgetGuard tests.
 */
import { describe, expect, test } from 'bun:test';
import { createBus } from '../../../src/core/bus.ts';
import { DebateBudgetGuard } from '../../../src/orchestrator/critic/debate-budget-guard.ts';

describe('DebateBudgetGuard — core semantics', () => {
  test('default maxPerTask=1 allows exactly one debate per task id', () => {
    const guard = new DebateBudgetGuard();
    expect(guard.shouldAllow('task-a')).toBe(true);
    guard.recordFired('task-a');
    expect(guard.shouldAllow('task-a')).toBe(false);
  });

  test('custom maxPerTask controls the cap', () => {
    const guard = new DebateBudgetGuard({ maxPerTask: 3 });
    expect(guard.shouldAllow('task-a')).toBe(true);
    guard.recordFired('task-a');
    expect(guard.shouldAllow('task-a')).toBe(true);
    guard.recordFired('task-a');
    expect(guard.shouldAllow('task-a')).toBe(true);
    guard.recordFired('task-a');
    expect(guard.shouldAllow('task-a')).toBe(false);
  });

  test('maxPerTask=0 denies every debate', () => {
    const guard = new DebateBudgetGuard({ maxPerTask: 0 });
    expect(guard.shouldAllow('task-a')).toBe(false);
    expect(guard.shouldAllow('task-b')).toBe(false);
  });

  test('negative maxPerTask clamps to 0', () => {
    const guard = new DebateBudgetGuard({ maxPerTask: -5 });
    expect(guard.shouldAllow('any')).toBe(false);
  });

  test('counters are isolated per task id', () => {
    const guard = new DebateBudgetGuard({ maxPerTask: 1 });
    guard.recordFired('task-a');
    expect(guard.shouldAllow('task-a')).toBe(false);
    expect(guard.shouldAllow('task-b')).toBe(true);
    expect(guard.shouldAllow('task-c')).toBe(true);
  });

  test('clearTask releases the counter', () => {
    const guard = new DebateBudgetGuard({ maxPerTask: 1 });
    guard.recordFired('task-a');
    expect(guard.shouldAllow('task-a')).toBe(false);
    guard.clearTask('task-a');
    expect(guard.shouldAllow('task-a')).toBe(true);
    expect(guard.getCount('task-a')).toBe(0);
  });

  test('getCount reflects current counter value', () => {
    const guard = new DebateBudgetGuard({ maxPerTask: 5 });
    expect(guard.getCount('task-a')).toBe(0);
    guard.recordFired('task-a');
    guard.recordFired('task-a');
    expect(guard.getCount('task-a')).toBe(2);
  });

  test('snapshot returns a defensive copy', () => {
    const guard = new DebateBudgetGuard();
    guard.recordFired('task-a');
    const snap = guard.snapshot();
    expect(snap.get('task-a')).toBe(1);

    // Mutating the snapshot must not affect the guard
    (snap as Map<string, number>).set('task-a', 999);
    expect(guard.getCount('task-a')).toBe(1);
  });
});

describe('DebateBudgetGuard — bus observability', () => {
  test('recordDenied emits critic:debate_denied with the right payload', () => {
    const bus = createBus();
    const events: Array<{
      taskId: string;
      reason: string;
      maxPerTask: number;
      count: number;
    }> = [];
    bus.on('critic:debate_denied', (e) => events.push(e));

    const guard = new DebateBudgetGuard({ maxPerTask: 2, bus });
    guard.recordFired('task-a');
    guard.recordFired('task-a');
    // Cap is now reached; simulate the router's deny path
    guard.recordDenied('task-a', 'per-task debate cap reached');

    expect(events).toHaveLength(1);
    expect(events[0]!.taskId).toBe('task-a');
    expect(events[0]!.reason).toBe('per-task debate cap reached');
    expect(events[0]!.maxPerTask).toBe(2);
    expect(events[0]!.count).toBe(2);
  });

  test('recordDenied is silent when no bus is configured', () => {
    const guard = new DebateBudgetGuard({ maxPerTask: 0 });
    // Just verifying no throw
    expect(() => guard.recordDenied('task-a', 'capped')).not.toThrow();
  });
});

// ── Wave 5.7b: per-day cap ────────────────────────────────────────

describe('DebateBudgetGuard — Wave 5.7b per-day cap', () => {
  // Day 1: 2026-04-15 00:00:00 UTC = 1776470400000
  // Day 2: 2026-04-16 00:00:00 UTC = 1776556800000
  const Day1Noon = Date.UTC(2026, 3, 15, 12, 0, 0);
  const Day2Noon = Date.UTC(2026, 3, 16, 12, 0, 0);

  test('maxPerDay undefined → no per-day cap enforced', () => {
    const clock = { t: Day1Noon };
    const guard = new DebateBudgetGuard({
      maxPerTask: 100,
      now: () => clock.t,
    });
    for (let i = 0; i < 50; i++) {
      expect(guard.shouldAllow(`task-${i}`)).toBe(true);
      guard.recordFired(`task-${i}`);
    }
    expect(guard.getDayCount()).toBe(50);
  });

  test('maxPerDay caps total fires across tasks', () => {
    const clock = { t: Day1Noon };
    const guard = new DebateBudgetGuard({
      maxPerTask: 100,
      maxPerDay: 3,
      now: () => clock.t,
    });

    expect(guard.shouldAllow('t1')).toBe(true);
    guard.recordFired('t1');
    expect(guard.shouldAllow('t2')).toBe(true);
    guard.recordFired('t2');
    expect(guard.shouldAllow('t3')).toBe(true);
    guard.recordFired('t3');

    // Day cap reached — even brand-new task is denied
    expect(guard.shouldAllow('t4')).toBe(false);
    expect(guard.whyDenied('t4')).toBe('max-per-day');
  });

  test('maxPerDay=0 denies every debate regardless of per-task state', () => {
    const clock = { t: Day1Noon };
    const guard = new DebateBudgetGuard({
      maxPerTask: 100,
      maxPerDay: 0,
      now: () => clock.t,
    });
    expect(guard.shouldAllow('t1')).toBe(false);
    expect(guard.whyDenied('t1')).toBe('max-per-day');
  });

  test('day rollover resets the per-day counter', () => {
    const clock = { t: Day1Noon };
    const guard = new DebateBudgetGuard({
      maxPerTask: 100,
      maxPerDay: 2,
      now: () => clock.t,
    });

    guard.recordFired('t1');
    guard.recordFired('t2');
    expect(guard.shouldAllow('t3')).toBe(false); // day cap reached

    // Roll clock to next day at noon
    clock.t = Day2Noon;
    expect(guard.shouldAllow('t3')).toBe(true); // day counter reset
    expect(guard.getDayCount()).toBe(0);
  });

  test('getDayCount prunes stale entries', () => {
    const clock = { t: Day1Noon };
    const guard = new DebateBudgetGuard({
      maxPerTask: 100,
      maxPerDay: 10,
      now: () => clock.t,
    });
    guard.recordFired('t1');
    guard.recordFired('t2');
    expect(guard.getDayCount()).toBe(2);

    clock.t = Day2Noon;
    expect(guard.getDayCount()).toBe(0);
  });

  test('whyDenied reports per-task when per-task cap reached first', () => {
    const clock = { t: Day1Noon };
    const guard = new DebateBudgetGuard({
      maxPerTask: 1,
      maxPerDay: 100,
      now: () => clock.t,
    });
    guard.recordFired('t1');
    expect(guard.whyDenied('t1')).toBe('max-per-task');
  });

  test('whyDenied reports per-day when day cap reached while task cap has room', () => {
    const clock = { t: Day1Noon };
    const guard = new DebateBudgetGuard({
      maxPerTask: 100,
      maxPerDay: 2,
      now: () => clock.t,
    });
    guard.recordFired('existing-1');
    guard.recordFired('existing-2');
    // New task has room per-task, but day cap is saturated
    expect(guard.whyDenied('new-task')).toBe('max-per-day');
  });

  test('whyDenied returns null when both caps have room', () => {
    const clock = { t: Day1Noon };
    const guard = new DebateBudgetGuard({
      maxPerTask: 5,
      maxPerDay: 10,
      now: () => clock.t,
    });
    expect(guard.whyDenied('t1')).toBeNull();
  });

  test('negative maxPerDay clamps to 0', () => {
    const clock = { t: Day1Noon };
    const guard = new DebateBudgetGuard({ maxPerDay: -7, now: () => clock.t });
    expect(guard.shouldAllow('t1')).toBe(false);
    expect(guard.whyDenied('t1')).toBe('max-per-day');
  });
});
