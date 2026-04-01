import { describe, expect, test } from 'bun:test';
import { backtestRule } from '../../src/evolution/backtester.ts';
import type { EvolutionaryRule, ExecutionTrace } from '../../src/orchestrator/types.ts';

function makeRule(overrides?: Partial<EvolutionaryRule>): EvolutionaryRule {
  return {
    id: 'rule-1',
    source: 'sleep-cycle',
    condition: { filePattern: '*.ts' },
    action: 'escalate',
    parameters: { toLevel: 2 },
    status: 'probation',
    createdAt: Date.now(),
    effectiveness: 0,
    specificity: 1,
    ...overrides,
  };
}

function makeTrace(i: number, overrides?: Partial<ExecutionTrace>): ExecutionTrace {
  return {
    id: `t-${i}`,
    taskId: `task-${i}`,
    timestamp: 1000 + i * 100, // deterministic ordering
    routingLevel: 1,
    approach: 'default',
    oracleVerdicts: { type: true },
    modelUsed: 'mock',
    tokensConsumed: 100,
    durationMs: 500,
    outcome: 'success',
    affectedFiles: ['src/foo.ts'],
    ...overrides,
  };
}

describe('backtestRule', () => {
  test('passes when rule prevents ≥50% failures with 0 false positives', () => {
    // 80% training, 20% validation
    // 10 traces: 8 training + 2 validation
    const traces: ExecutionTrace[] = [];
    // Training: 6 successes + 2 failures
    for (let i = 0; i < 6; i++) traces.push(makeTrace(i, { outcome: 'success' }));
    for (let i = 6; i < 8; i++) traces.push(makeTrace(i, { outcome: 'failure' }));
    // Validation: 2 failures (rule should prevent both)
    for (let i = 8; i < 10; i++) traces.push(makeTrace(i, { outcome: 'failure' }));

    const result = backtestRule(makeRule(), traces);
    expect(result.pass).toBe(true);
    expect(result.effectiveness).toBe(1.0); // 2/2 prevented
    expect(result.prevented).toBe(2);
    expect(result.falsePositives).toBe(0);
  });

  test('fails when rule would block successes (false positives)', () => {
    const traces: ExecutionTrace[] = [];
    // Training
    for (let i = 0; i < 8; i++) traces.push(makeTrace(i, { outcome: 'success' }));
    // Validation: 1 failure + 1 success (rule matches both)
    traces.push(makeTrace(8, { outcome: 'failure' }));
    traces.push(makeTrace(9, { outcome: 'success' }));

    const result = backtestRule(makeRule(), traces);
    expect(result.falsePositives).toBe(1);
    expect(result.pass).toBe(false);
  });

  test('fails with insufficient data (< 5 traces)', () => {
    const traces = [makeTrace(0), makeTrace(1)];
    const result = backtestRule(makeRule(), traces);
    expect(result.pass).toBe(false);
    expect(result.trainingSize).toBe(0);
  });

  test('temporal split preserves ordering (anti-lookahead)', () => {
    const traces: ExecutionTrace[] = [];
    for (let i = 0; i < 10; i++) {
      traces.push(makeTrace(i, { outcome: i >= 8 ? 'failure' : 'success' }));
    }

    const result = backtestRule(makeRule(), traces);
    // Training = first 8 (indices 0-7), Validation = last 2 (indices 8-9)
    expect(result.trainingSize).toBe(8);
    expect(result.validationSize).toBe(2);
  });

  test('effectiveness is 0 when no failures in validation set', () => {
    const traces: ExecutionTrace[] = [];
    for (let i = 0; i < 10; i++) {
      traces.push(makeTrace(i, { outcome: 'success' }));
    }

    const result = backtestRule(makeRule(), traces);
    expect(result.effectiveness).toBe(0);
    expect(result.totalFailures).toBe(0);
  });
});
