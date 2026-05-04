import { describe, expect, test } from 'bun:test';
import { CounterfactualTracker } from '../../../src/orchestrator/thinking/counterfactual-tracker.ts';

describe('CounterfactualTracker', () => {
  test('default cap of 3 retries — first three consume(), fourth reports exhausted', () => {
    const tracker = new CounterfactualTracker();
    expect(tracker.consume('t1').state).toBe('allow');
    expect(tracker.consume('t1').state).toBe('allow');
    expect(tracker.consume('t1').state).toBe('allow');
    const fourth = tracker.consume('t1');
    expect(fourth.state).toBe('exhausted');
    if (fourth.state === 'exhausted') expect(fourth.consumed).toBe(3);
  });

  test('per-task budgets are independent — exhausting t1 does not affect t2', () => {
    const tracker = new CounterfactualTracker({ maxRetriesPerTask: 2 });
    tracker.consume('t1');
    tracker.consume('t1');
    expect(tracker.consume('t1').state).toBe('exhausted');
    const t2First = tracker.consume('t2');
    expect(t2First.state).toBe('allow');
    if (t2First.state === 'allow') expect(t2First.remaining).toBe(1);
  });

  test('remaining() does not consume a slot', () => {
    const tracker = new CounterfactualTracker({ maxRetriesPerTask: 2 });
    expect(tracker.remaining('t1')).toBe(2);
    expect(tracker.remaining('t1')).toBe(2);
    expect(tracker.consume('t1').state).toBe('allow');
    expect(tracker.remaining('t1')).toBe(1);
  });

  test('clearTask releases per-task state', () => {
    const tracker = new CounterfactualTracker({ maxRetriesPerTask: 1 });
    tracker.consume('t1');
    expect(tracker.consume('t1').state).toBe('exhausted');
    tracker.clearTask('t1');
    expect(tracker.consume('t1').state).toBe('allow');
  });

  test('snapshot exposes per-task counters and the configured max', () => {
    const tracker = new CounterfactualTracker({ maxRetriesPerTask: 5 });
    tracker.consume('a');
    tracker.consume('a');
    tracker.consume('b');
    const snap = tracker.snapshot();
    expect(snap.max).toBe(5);
    expect(snap.perTask).toEqual({ a: 2, b: 1 });
  });

  test('exhausted on first call when max is 0 — degenerate config still safe', () => {
    const tracker = new CounterfactualTracker({ maxRetriesPerTask: 0 });
    expect(tracker.consume('t1').state).toBe('exhausted');
  });
});
