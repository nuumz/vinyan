/**
 * Wave 5: failure cluster detector + reactive rule synthesizer tests.
 */
import { describe, expect, test } from 'bun:test';
import {
  DEFAULT_FAILURE_CLUSTER_CONFIG,
  FailureClusterDetector,
} from '../../../src/orchestrator/goal-satisfaction/failure-cluster-detector.ts';
import {
  synthesizeReactiveRule,
  type ReactiveTraceSummary,
} from '../../../src/sleep-cycle/reactive-cycle.ts';

describe('FailureClusterDetector', () => {
  test('disabled by default → observe returns null', () => {
    const detector = new FailureClusterDetector(DEFAULT_FAILURE_CLUSTER_CONFIG);
    const result = detector.observe({
      taskSignature: 'fix::ts::small',
      outcome: 'failure',
      timestamp: Date.now(),
      taskId: 't1',
    });
    expect(result).toBeNull();
  });

  test('single failure does not form a cluster', () => {
    const detector = new FailureClusterDetector({ ...DEFAULT_FAILURE_CLUSTER_CONFIG, enabled: true });
    const result = detector.observe({
      taskSignature: 'fix::ts::small',
      outcome: 'failure',
      timestamp: Date.now(),
      taskId: 't1',
    });
    expect(result).toBeNull();
  });

  test('two failures in window → cluster detected', () => {
    const detector = new FailureClusterDetector({ ...DEFAULT_FAILURE_CLUSTER_CONFIG, enabled: true });
    const now = Date.now();
    detector.observe({ taskSignature: 'fix::ts::small', outcome: 'failure', timestamp: now - 1000, taskId: 't1' });
    const cluster = detector.observe({
      taskSignature: 'fix::ts::small',
      outcome: 'failure',
      timestamp: now,
      taskId: 't2',
    });
    expect(cluster).not.toBeNull();
    expect(cluster!.failureCount).toBe(2);
    expect(cluster!.taskIds).toEqual(['t1', 't2']);
  });

  test('failures outside window → no cluster', () => {
    const detector = new FailureClusterDetector({ ...DEFAULT_FAILURE_CLUSTER_CONFIG, enabled: true, windowMs: 1000 });
    const now = Date.now();
    detector.observe({
      taskSignature: 'fix::ts::small',
      outcome: 'failure',
      timestamp: now - 5000, // outside 1s window
      taskId: 't1',
    });
    const result = detector.observe({
      taskSignature: 'fix::ts::small',
      outcome: 'failure',
      timestamp: now,
      taskId: 't2',
    });
    expect(result).toBeNull();
  });

  test('different signatures do not merge', () => {
    const detector = new FailureClusterDetector({ ...DEFAULT_FAILURE_CLUSTER_CONFIG, enabled: true });
    detector.observe({ taskSignature: 'fix::ts::small', outcome: 'failure', timestamp: Date.now(), taskId: 't1' });
    const result = detector.observe({
      taskSignature: 'add::py::large',
      outcome: 'failure',
      timestamp: Date.now(),
      taskId: 't2',
    });
    expect(result).toBeNull();
  });

  test('intervening success clears reported flag (retriggers on next cluster)', () => {
    const detector = new FailureClusterDetector({ ...DEFAULT_FAILURE_CLUSTER_CONFIG, enabled: true });
    const now = Date.now();
    detector.observe({ taskSignature: 'fix::ts::small', outcome: 'failure', timestamp: now - 3000, taskId: 't1' });
    const first = detector.observe({
      taskSignature: 'fix::ts::small',
      outcome: 'failure',
      timestamp: now - 2000,
      taskId: 't2',
    });
    expect(first).not.toBeNull();

    // Success clears
    detector.observe({ taskSignature: 'fix::ts::small', outcome: 'success', timestamp: now - 1500, taskId: 't3' });

    // New failure streak
    detector.observe({ taskSignature: 'fix::ts::small', outcome: 'failure', timestamp: now - 1000, taskId: 't4' });
    const second = detector.observe({
      taskSignature: 'fix::ts::small',
      outcome: 'failure',
      timestamp: now,
      taskId: 't5',
    });
    expect(second).not.toBeNull();
  });
});

describe('synthesizeReactiveRule', () => {
  const cluster = {
    taskSignature: 'fix::ts::small',
    failureCount: 3,
    taskIds: ['t1', 't2', 't3'],
    windowStart: Date.now() - 3000,
    windowEnd: Date.now(),
  };

  test('single-trace input → null', () => {
    const traces: ReactiveTraceSummary[] = [
      { taskId: 't1', taskSignature: 'fix::ts::small', failureOracles: ['test'], affectedFiles: [] },
    ];
    expect(synthesizeReactiveRule(cluster, traces)).toBeNull();
  });

  test('dominant oracle (>=80%) → escalate rule', () => {
    const traces: ReactiveTraceSummary[] = [
      { taskId: 't1', taskSignature: 'fix::ts::small', failureOracles: ['test'], affectedFiles: [] },
      { taskId: 't2', taskSignature: 'fix::ts::small', failureOracles: ['test'], affectedFiles: [] },
      { taskId: 't3', taskSignature: 'fix::ts::small', failureOracles: ['test'], affectedFiles: [] },
    ];
    const rule = synthesizeReactiveRule(cluster, traces);
    expect(rule).not.toBeNull();
    expect(rule!.action).toBe('escalate');
    expect(rule!.status).toBe('probation');
    expect(rule!.condition.oracleName).toBe('test');
    expect(rule!.sourceTraceIds).toEqual(['t1', 't2', 't3']);
  });

  test('common file prefix → require-oracle rule', () => {
    const traces: ReactiveTraceSummary[] = [
      {
        taskId: 't1',
        taskSignature: 'fix::ts::small',
        failureOracles: ['type'],
        affectedFiles: ['src/auth/login.ts'],
      },
      {
        taskId: 't2',
        taskSignature: 'fix::ts::small',
        failureOracles: ['dep'],
        affectedFiles: ['src/auth/logout.ts'],
      },
    ];
    const rule = synthesizeReactiveRule(cluster, traces);
    expect(rule).not.toBeNull();
    expect(rule!.action).toBe('require-oracle');
    expect(rule!.condition.filePattern).toBe('src/auth/*');
    expect(rule!.status).toBe('probation');
  });

  test('no dominant oracle, no common prefix → null', () => {
    const traces: ReactiveTraceSummary[] = [
      { taskId: 't1', taskSignature: 'fix::ts::small', failureOracles: ['type'], affectedFiles: ['a/x.ts'] },
      { taskId: 't2', taskSignature: 'fix::ts::small', failureOracles: ['dep'], affectedFiles: ['b/y.ts'] },
    ];
    const rule = synthesizeReactiveRule(cluster, traces);
    expect(rule).toBeNull();
  });
});
