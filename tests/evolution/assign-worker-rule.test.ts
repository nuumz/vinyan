import { describe, expect, test } from 'bun:test';
import { backtestWorkerAssignment } from '../../src/evolution/backtester.ts';
import { generateRule, generateRules } from '../../src/evolution/rule-generator.ts';
import type { ExecutionTrace, ExtractedPattern } from '../../src/orchestrator/types.ts';

function makeWorkerPattern(overrides?: Partial<ExtractedPattern>): ExtractedPattern {
  return {
    id: 'wp-test-001',
    type: 'worker-performance',
    description: 'Worker "w1" outperforms "w2" by 20% on refactor::.ts::small',
    frequency: 30,
    confidence: 0.7,
    taskTypeSignature: 'refactor::.ts::small',
    approach: 'w1',
    comparedApproach: 'w2',
    qualityDelta: 0.2,
    sourceTraceIds: ['t1', 't2', 't3'],
    createdAt: Date.now(),
    decayWeight: 1.0,
    workerId: 'w1',
    comparedWorkerId: 'w2',
    ...overrides,
  };
}

function makeTrace(
  id: string,
  workerId: string,
  opts: {
    outcome?: 'success' | 'failure';
    quality?: number;
    taskTypeSig?: string;
    timestamp?: number;
    routingLevel?: number;
    affectedFiles?: string[];
  },
): ExecutionTrace {
  return {
    id,
    taskId: `task-${id}`,
    timestamp: opts.timestamp ?? Date.now(),
    routingLevel: opts.routingLevel ?? 1,
    approach: 'default',
    model_used: `model-${workerId}`,
    tokensConsumed: 1000,
    tokens_consumed: 1000,
    durationMs: 5000,
    outcome: opts.outcome ?? 'success',
    oracleVerdicts: {},
    affected_files: opts.affectedFiles ?? ['src/foo.ts'],
    worker_id: workerId,
    qualityScore: opts.quality != null ? { composite: opts.quality } : undefined,
    task_type_signature: opts.taskTypeSig ?? 'refactor::.ts::small',
  } as ExecutionTrace;
}

describe('generateRule for worker-performance patterns', () => {
  test('generates assign-worker rule from worker-performance pattern', () => {
    const pattern = makeWorkerPattern();
    const rule = generateRule(pattern);

    expect(rule).not.toBeNull();
    expect(rule!.action).toBe('assign-worker');
    expect(rule!.id).toContain('rule-assign-');
    expect(rule!.parameters.workerId).toBe('w1');
    expect(rule!.parameters.comparedWorkerId).toBe('w2');
    expect(rule!.parameters.qualityDelta).toBe(0.2);
    expect(rule!.status).toBe('probation');
  });

  test('returns null if workerId is missing', () => {
    const pattern = makeWorkerPattern({ workerId: undefined });
    const rule = generateRule(pattern);
    expect(rule).toBeNull();
  });

  test('does not extract filePattern from fingerprint-format signature', () => {
    const pattern = makeWorkerPattern({ taskTypeSignature: 'refactor::.ts::small' });
    const rule = generateRule(pattern);
    // Worker assignment rules don't use filePattern — signatures are fingerprint keys
    expect(rule!.condition.filePattern).toBeUndefined();
  });

  test('stores taskTypeSignature in parameters for matching', () => {
    const pattern = makeWorkerPattern({ taskTypeSignature: 'refactor::.ts::small' });
    const rule = generateRule(pattern);
    expect(rule!.parameters.taskTypeSignature).toBe('refactor::.ts::small');
  });

  test('includes oracleName in condition when present', () => {
    const pattern = makeWorkerPattern({ oracleName: 'ast' });
    const rule = generateRule(pattern);
    expect(rule!.condition.oracleName).toBe('ast');
    expect(rule!.specificity).toBeGreaterThanOrEqual(1);
  });

  test('generateRules handles mixed pattern types including worker-performance', () => {
    const patterns: ExtractedPattern[] = [
      makeWorkerPattern(),
      {
        id: 'ap-test-002',
        type: 'anti-pattern',
        description: 'test anti-pattern',
        frequency: 10,
        confidence: 0.8,
        taskTypeSignature: 'fix::.ts::small',
        approach: 'direct',
        sourceTraceIds: ['t4'],
        createdAt: Date.now(),
        decayWeight: 1.0,
      },
    ];

    const rules = generateRules(patterns);
    expect(rules).toHaveLength(2);
    expect(rules.some((r) => r.action === 'assign-worker')).toBe(true);
    expect(rules.some((r) => r.action === 'escalate')).toBe(true);
  });
});

describe('backtestWorkerAssignment', () => {
  test('returns fail for insufficient traces', () => {
    const rule = generateRule(makeWorkerPattern())!;
    const result = backtestWorkerAssignment(rule, []);
    expect(result.pass).toBe(false);
  });

  test('returns fail for non-assign-worker rule', () => {
    const pattern: ExtractedPattern = {
      id: 'ap-001',
      type: 'anti-pattern',
      description: 'test',
      frequency: 10,
      confidence: 0.8,
      taskTypeSignature: 'refactor::.ts::small',
      approach: 'x',
      sourceTraceIds: [],
      createdAt: Date.now(),
      decayWeight: 1.0,
    };
    const rule = generateRule(pattern)!;
    const result = backtestWorkerAssignment(rule, [makeTrace('t1', 'w1', {})]);
    expect(result.pass).toBe(false);
  });

  test('passes when assigned worker has better quality', () => {
    const rule = generateRule(makeWorkerPattern())!;

    const traces: ExecutionTrace[] = [];
    const baseTime = Date.now() - 100000;

    // 8 training traces (80%) + 2 validation traces (20%) — need 10 minimum
    for (let i = 0; i < 6; i++) {
      traces.push(
        makeTrace(`w1-train-${i}`, 'w1', {
          quality: 0.9,
          timestamp: baseTime + i * 1000,
          affectedFiles: ['src/foo.ts'],
        }),
      );
    }
    for (let i = 0; i < 4; i++) {
      traces.push(
        makeTrace(`w2-train-${i}`, 'w2', {
          quality: 0.5,
          timestamp: baseTime + i * 1000,
          affectedFiles: ['src/foo.ts'],
        }),
      );
    }
    // Validation: w1 still better
    for (let i = 0; i < 3; i++) {
      traces.push(
        makeTrace(`w1-val-${i}`, 'w1', {
          quality: 0.85,
          timestamp: baseTime + 50000 + i * 1000,
          affectedFiles: ['src/foo.ts'],
        }),
      );
    }
    for (let i = 0; i < 2; i++) {
      traces.push(
        makeTrace(`w2-val-${i}`, 'w2', {
          quality: 0.4,
          timestamp: baseTime + 50000 + i * 1000,
          affectedFiles: ['src/foo.ts'],
        }),
      );
    }

    const result = backtestWorkerAssignment(rule, traces);
    expect(result.pass).toBe(true);
    expect(result.effectiveness).toBeGreaterThan(0);
  });

  test('fails when assigned worker has worse quality', () => {
    const rule = generateRule(makeWorkerPattern())!;

    const traces: ExecutionTrace[] = [];
    const baseTime = Date.now() - 100000;

    // Training
    for (let i = 0; i < 6; i++) {
      traces.push(
        makeTrace(`w1-${i}`, 'w1', { quality: 0.3, timestamp: baseTime + i * 1000, affectedFiles: ['src/foo.ts'] }),
      );
    }
    for (let i = 0; i < 4; i++) {
      traces.push(
        makeTrace(`w2-${i}`, 'w2', { quality: 0.9, timestamp: baseTime + i * 1000, affectedFiles: ['src/foo.ts'] }),
      );
    }
    // Validation: w1 still worse
    for (let i = 0; i < 3; i++) {
      traces.push(
        makeTrace(`w1-v-${i}`, 'w1', {
          quality: 0.3,
          timestamp: baseTime + 50000 + i * 1000,
          affectedFiles: ['src/foo.ts'],
        }),
      );
    }
    for (let i = 0; i < 2; i++) {
      traces.push(
        makeTrace(`w2-v-${i}`, 'w2', {
          quality: 0.9,
          timestamp: baseTime + 50000 + i * 1000,
          affectedFiles: ['src/foo.ts'],
        }),
      );
    }

    const result = backtestWorkerAssignment(rule, traces);
    expect(result.pass).toBe(false);
  });
});
