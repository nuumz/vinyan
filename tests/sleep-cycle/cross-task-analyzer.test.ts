import { describe, expect, test } from 'bun:test';
import type { ExecutionTrace } from '../../src/orchestrator/types.ts';
import { correlationToPattern, findFailureCorrelations } from '../../src/sleep-cycle/cross-task-analyzer.ts';

function makeTrace(overrides?: Partial<ExecutionTrace>): ExecutionTrace {
  return {
    id: `t-${Math.random().toString(36).slice(2)}`,
    taskId: 'task-1',
    timestamp: Date.now(),
    routingLevel: 1,
    approach: 'default',
    oracleVerdicts: { type: true },
    model_used: 'gpt-4o',
    tokens_consumed: 100,
    durationMs: 500,
    outcome: 'success',
    affected_files: ['a.ts'],
    ...overrides,
  };
}

describe('PH3.5: Cross-Task Analyzer', () => {
  test('detects model-correlated failures', () => {
    const traces: ExecutionTrace[] = [];
    // 10 failures with model "gpt-4o-mini" at level 1
    for (let i = 0; i < 10; i++) {
      traces.push(
        makeTrace({
          id: `fail-${i}`,
          model_used: 'gpt-4o-mini',
          routingLevel: 1,
          outcome: 'failure',
          task_type_signature: `type-${i % 3}`,
        }),
      );
    }
    // 10 successes with model "gpt-4o" at level 1
    for (let i = 0; i < 10; i++) {
      traces.push(
        makeTrace({
          id: `succ-${i}`,
          model_used: 'gpt-4o',
          routingLevel: 1,
          outcome: 'success',
          task_type_signature: `type-${i % 3}`,
        }),
      );
    }

    const results = findFailureCorrelations(traces, 5, 0.5);
    expect(results.length).toBeGreaterThanOrEqual(1);
    // Should find model=gpt-4o-mini correlated with failure
    const modelCorr = results.find((r) => r.combo.model === 'gpt-4o-mini');
    expect(modelCorr).toBeDefined();
    expect(modelCorr!.failRate).toBe(1.0);
  });

  test('detects routing-level-correlated failures', () => {
    const traces: ExecutionTrace[] = [];
    // 8 failures at level 1
    for (let i = 0; i < 8; i++) {
      traces.push(
        makeTrace({
          id: `fail-l1-${i}`,
          routingLevel: 1,
          outcome: 'failure',
          model_used: 'gpt-4o',
          affected_files: ['a.ts'],
        }),
      );
    }
    // 8 successes at level 2
    for (let i = 0; i < 8; i++) {
      traces.push(
        makeTrace({
          id: `succ-l2-${i}`,
          routingLevel: 2,
          outcome: 'success',
          model_used: 'gpt-4o',
          affected_files: ['a.ts'],
        }),
      );
    }

    const results = findFailureCorrelations(traces, 5, 0.5);
    const levelCorr = results.find((r) => r.combo.routingLevel === 1);
    expect(levelCorr).toBeDefined();
  });

  test('no correlation below minimum sample size', () => {
    const traces: ExecutionTrace[] = [];
    // Only 3 failures — below minSampleSize=5
    for (let i = 0; i < 3; i++) {
      traces.push(
        makeTrace({
          id: `fail-${i}`,
          model_used: 'bad-model',
          routingLevel: 1,
          outcome: 'failure',
        }),
      );
    }
    for (let i = 0; i < 10; i++) {
      traces.push(
        makeTrace({
          id: `succ-${i}`,
          model_used: 'good-model',
          routingLevel: 1,
          outcome: 'success',
        }),
      );
    }

    const results = findFailureCorrelations(traces, 5, 0.5);
    // Should not find the bad-model correlation (only 3 traces)
    const modelCorr = results.find((r) => r.combo.model === 'bad-model');
    expect(modelCorr).toBeUndefined();
  });

  test('no correlation when fail rate is low', () => {
    const traces: ExecutionTrace[] = [];
    // 5 traces, 2 failures — 40% fail rate, below meaningful threshold
    for (let i = 0; i < 2; i++) {
      traces.push(makeTrace({ id: `fail-${i}`, model_used: 'm1', routingLevel: 1, outcome: 'failure' }));
    }
    for (let i = 0; i < 3; i++) {
      traces.push(makeTrace({ id: `succ-${i}`, model_used: 'm1', routingLevel: 1, outcome: 'success' }));
    }

    const results = findFailureCorrelations(traces, 5, 0.5);
    expect(results).toHaveLength(0);
  });

  test('capped at maxResults', () => {
    const traces: ExecutionTrace[] = [];
    // Create many distinct failing groups
    for (let g = 0; g < 15; g++) {
      for (let i = 0; i < 6; i++) {
        traces.push(
          makeTrace({
            id: `fail-g${g}-${i}`,
            model_used: `model-${g}`,
            routingLevel: 1,
            outcome: 'failure',
          }),
        );
      }
    }

    const results = findFailureCorrelations(traces, 5, 0.3, 10);
    expect(results.length).toBeLessThanOrEqual(10);
  });

  test('correlationToPattern converts result correctly', () => {
    const corr = {
      combo: { model: 'gpt-4o-mini', routingLevel: 1 as const },
      failRate: 0.9,
      sampleSize: 20,
      wilsonLB: 0.7,
      sourceTraceIds: ['t-1', 't-2'],
    };

    const pattern = correlationToPattern(corr, 'parent-1');
    expect(pattern.type).toBe('anti-pattern');
    expect(pattern.taskTypeSignature).toContain('cross::');
    expect(pattern.modelPattern).toBe('gpt-4o-mini');
    expect(pattern.routingLevel).toBe(1);
    expect(pattern.derivedFrom).toBe('parent-1');
    expect(pattern.confidence).toBe(0.7);
  });

  test('oracle verdict pattern detected', () => {
    const traces: ExecutionTrace[] = [];
    // Traces failing type-checker oracle at level 1
    for (let i = 0; i < 8; i++) {
      traces.push(
        makeTrace({
          id: `fail-${i}`,
          routingLevel: 1,
          outcome: 'failure',
          oracleVerdicts: { type: false, lint: true },
          model_used: 'gpt-4o',
        }),
      );
    }
    // Successes at level 1 (different oracle pattern)
    for (let i = 0; i < 8; i++) {
      traces.push(
        makeTrace({
          id: `succ-${i}`,
          routingLevel: 1,
          outcome: 'success',
          oracleVerdicts: { type: true, lint: true },
          model_used: 'gpt-4o',
        }),
      );
    }

    const results = findFailureCorrelations(traces, 5, 0.5);
    const oracleCorr = results.find((r) => r.combo.oracleVerdictPattern === 'type');
    expect(oracleCorr).toBeDefined();
  });
});
