/**
 * Wave 5: failure cluster detector + reactive rule synthesizer tests.
 */
import { describe, expect, test } from 'bun:test';
import {
  DEFAULT_FAILURE_CLUSTER_CONFIG,
  FailureClusterDetector,
} from '../../../src/orchestrator/goal-satisfaction/failure-cluster-detector.ts';
import {
  reactiveRuleToEvolutionary,
  synthesizeReactiveRule,
  traceToReactiveSummary,
  type ReactiveTraceSummary,
} from '../../../src/sleep-cycle/reactive-cycle.ts';
import type { ExecutionTrace } from '../../../src/orchestrator/types.ts';

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

// ── W5a helpers (wiring) ──────────────────────────────────────────────

describe('traceToReactiveSummary', () => {
  const baseTrace: ExecutionTrace = {
    id: 'tr-1',
    taskId: 't1',
    timestamp: Date.now(),
    routingLevel: 1,
    approach: 'direct-edit',
    oracleVerdicts: {},
    modelUsed: 'fake',
    tokensConsumed: 0,
    durationMs: 0,
    outcome: 'success',
    affectedFiles: ['src/foo.ts'],
    taskTypeSignature: 'fix::ts::small',
  };

  test('success trace → null', () => {
    expect(traceToReactiveSummary({ ...baseTrace, outcome: 'success' })).toBeNull();
  });

  test('failure trace → summary with failed oracles', () => {
    const trace = {
      ...baseTrace,
      outcome: 'failure' as const,
      oracleVerdicts: { type: true, test: false, lint: false },
    };
    const summary = traceToReactiveSummary(trace);
    expect(summary).not.toBeNull();
    expect(summary!.taskId).toBe('t1');
    expect(summary!.taskSignature).toBe('fix::ts::small');
    expect(summary!.failureOracles.sort()).toEqual(['lint', 'test']);
    expect(summary!.affectedFiles).toEqual(['src/foo.ts']);
  });

  test('missing taskTypeSignature falls back to "unknown"', () => {
    const trace = { ...baseTrace, outcome: 'failure' as const, taskTypeSignature: undefined };
    const summary = traceToReactiveSummary(trace);
    expect(summary!.taskSignature).toBe('unknown');
  });

  test('escalated outcome → null (only "failure" triggers)', () => {
    expect(traceToReactiveSummary({ ...baseTrace, outcome: 'escalated' })).toBeNull();
  });
});

describe('reactiveRuleToEvolutionary', () => {
  test('maps dominant-oracle proposed rule to EvolutionaryRule', () => {
    const proposed = {
      condition: { oracleName: 'test', taskTypeSignature: 'fix::ts::small' as const },
      action: 'escalate' as const,
      parameters: { toLevel: 2 },
      status: 'probation' as const,
      sourceTraceIds: ['t1', 't2', 't3'],
      rationale: '3/3 failures on oracle "test"',
    };
    const evo = reactiveRuleToEvolutionary(proposed);

    expect(evo.source).toBe('sleep-cycle');
    expect(evo.status).toBe('probation');
    expect(evo.action).toBe('escalate');
    expect(evo.condition.oracleName).toBe('test');
    expect(evo.condition.filePattern).toBeUndefined();
    expect(evo.specificity).toBe(1);
    expect(evo.effectiveness).toBe(0);
    expect(evo.parameters.toLevel).toBe(2);
    // taskTypeSignature folded into parameters (EvolutionaryRule.condition has no slot for it)
    expect(evo.parameters.taskTypeSignature).toBe('fix::ts::small');
    expect(evo.parameters.sourceTraceIds).toEqual(['t1', 't2', 't3']);
    expect(evo.id).toMatch(/^reactive-\d+-[a-z0-9]+$/);
  });

  test('maps file-pattern proposed rule to EvolutionaryRule', () => {
    const proposed = {
      condition: { filePattern: 'src/auth/*', taskTypeSignature: 'fix::ts::small' as const },
      action: 'require-oracle' as const,
      parameters: { oracleName: 'test' },
      status: 'probation' as const,
      sourceTraceIds: ['t1', 't2'],
      rationale: 'Failure cluster on src/auth/*',
    };
    const evo = reactiveRuleToEvolutionary(proposed);

    expect(evo.condition.filePattern).toBe('src/auth/*');
    expect(evo.condition.oracleName).toBeUndefined();
    expect(evo.action).toBe('require-oracle');
    expect(evo.specificity).toBe(1);
  });
});
