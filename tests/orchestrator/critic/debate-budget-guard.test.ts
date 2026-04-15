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
