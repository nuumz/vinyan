/**
 * Book-integration Wave 1.1: Silent-Agent detector tests.
 */
import { describe, expect, test } from 'bun:test';
import { SilentAgentDetector } from '../../src/guardrails/silent-agent.ts';

function makeDetector(nowRef: { t: number }) {
  return new SilentAgentDetector({
    warnAfterMs: 1000,
    stallAfterMs: 3000,
    now: () => nowRef.t,
  });
}

describe('SilentAgentDetector — state machine', () => {
  test('newly registered task starts healthy', () => {
    const clock = { t: 0 };
    const d = makeDetector(clock);
    d.register('task-1');
    expect(d.getState('task-1')).toBe('healthy');
  });

  test('no transition while inside warn window', () => {
    const clock = { t: 0 };
    const d = makeDetector(clock);
    d.register('task-1');
    clock.t = 999; // just under warnAfterMs
    const transitions = d.tick();
    expect(transitions).toHaveLength(0);
    expect(d.getState('task-1')).toBe('healthy');
  });

  test('transitions to silent at warnAfterMs', () => {
    const clock = { t: 0 };
    const d = makeDetector(clock);
    d.register('task-1');
    clock.t = 1000;
    const transitions = d.tick();
    expect(transitions).toHaveLength(1);
    expect(transitions[0]!.from).toBe('healthy');
    expect(transitions[0]!.to).toBe('silent');
    expect(d.getState('task-1')).toBe('silent');
  });

  test('transitions to stalled at stallAfterMs', () => {
    const clock = { t: 0 };
    const d = makeDetector(clock);
    d.register('task-1');
    clock.t = 1500; // enter silent
    d.tick();
    clock.t = 3500; // enter stalled
    const transitions = d.tick();
    expect(transitions).toHaveLength(1);
    expect(transitions[0]!.from).toBe('silent');
    expect(transitions[0]!.to).toBe('stalled');
    expect(d.getState('task-1')).toBe('stalled');
  });

  test('heartbeat resets the clock and returns to healthy', () => {
    const clock = { t: 0 };
    const d = makeDetector(clock);
    d.register('task-1');
    clock.t = 2000; // silent
    d.tick();
    expect(d.getState('task-1')).toBe('silent');

    d.heartbeat('task-1', 'tool_calls');
    expect(d.getState('task-1')).toBe('healthy');
    // After a tick the state must remain healthy because the lastTurnAt
    // was reset to `clock.t` (==2000).
    const transitions = d.tick();
    expect(transitions).toHaveLength(0);
    expect(d.getState('task-1')).toBe('healthy');
  });

  test('tick is idempotent: same clock produces no extra transitions', () => {
    const clock = { t: 0 };
    const d = makeDetector(clock);
    d.register('task-1');
    clock.t = 1500;
    const first = d.tick();
    const second = d.tick();
    expect(first).toHaveLength(1);
    expect(second).toHaveLength(0);
  });

  test('unregister removes the task entirely', () => {
    const clock = { t: 0 };
    const d = makeDetector(clock);
    d.register('task-1');
    d.unregister('task-1');
    expect(d.getState('task-1')).toBeUndefined();
    clock.t = 5000;
    expect(d.tick()).toHaveLength(0);
  });

  test('tracks multiple tasks independently', () => {
    const clock = { t: 0 };
    const d = makeDetector(clock);
    d.register('task-a');
    clock.t = 500;
    d.register('task-b');
    clock.t = 1200; // task-a is silent, task-b still healthy (700ms gap)
    const transitions = d.tick();
    const byTask = new Map(transitions.map((t) => [t.taskId, t]));
    expect(byTask.get('task-a')?.to).toBe('silent');
    expect(byTask.get('task-b')).toBeUndefined();
  });

  test('constructor rejects stallAfterMs <= warnAfterMs', () => {
    expect(() => new SilentAgentDetector({ warnAfterMs: 1000, stallAfterMs: 1000 })).toThrow();
    expect(() => new SilentAgentDetector({ warnAfterMs: 2000, stallAfterMs: 1000 })).toThrow();
  });

  test('snapshot reflects current records', () => {
    const clock = { t: 0 };
    const d = makeDetector(clock);
    d.register('task-1', 'worker-xyz');
    const snap = d.snapshot();
    expect(snap).toHaveLength(1);
    expect(snap[0]!.workerId).toBe('worker-xyz');
    expect(snap[0]!.state).toBe('healthy');
  });
});
