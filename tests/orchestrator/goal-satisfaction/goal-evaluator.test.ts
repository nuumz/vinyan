import { describe, expect, test } from 'bun:test';
import type { OracleVerdict } from '../../../src/core/types.ts';
import { DefaultGoalEvaluator } from '../../../src/orchestrator/goal-satisfaction/goal-evaluator.ts';
import type { ExecutionTrace, TaskInput, TaskResult, TaskUnderstanding } from '../../../src/orchestrator/types.ts';
import { WorkingMemory } from '../../../src/orchestrator/working-memory.ts';

function makeTrace(): ExecutionTrace {
  return {
    id: 'trace-1',
    taskId: 'task-1',
    timestamp: 0,
    routingLevel: 0,
    approach: 'test',
    oracleVerdicts: {},
    modelUsed: 'mock',
    tokensConsumed: 0,
    durationMs: 0,
    outcome: 'success',
    affectedFiles: [],
  };
}

function makeInput(overrides?: Partial<TaskInput>): TaskInput {
  return {
    id: 'task-1',
    source: 'cli',
    goal: 'Add foo export',
    taskType: 'code',
    budget: { maxTokens: 1000, maxDurationMs: 5000, maxRetries: 1 },
    ...overrides,
  };
}

function makeResult(overrides?: Partial<TaskResult>): TaskResult {
  return {
    id: 'task-1',
    status: 'completed',
    mutations: [],
    trace: makeTrace(),
    ...overrides,
  };
}

function makeUnderstanding(overrides?: Partial<TaskUnderstanding>): TaskUnderstanding {
  return {
    rawGoal: 'Add foo export',
    actionVerb: 'add',
    actionCategory: 'mutation',
    frameworkContext: [],
    constraints: [],
    acceptanceCriteria: [],
    expectsMutation: true,
    ...overrides,
  };
}

function makeVerdict(verified: boolean, oracleName = 'ast'): OracleVerdict {
  return {
    verified,
    type: 'known',
    confidence: 0.9,
    evidence: [],
    fileHashes: {},
    oracleName,
    durationMs: 1,
  };
}

describe('DefaultGoalEvaluator', () => {
  test('all deterministic checks pass → high score, basis=deterministic', async () => {
    const evaluator = new DefaultGoalEvaluator();
    const wm = new WorkingMemory({ taskId: 'task-1' });
    const input = makeInput({ acceptanceCriteria: ['export foo function'] });
    const result = makeResult({
      mutations: [
        {
          file: 'src/foo.ts',
          diff: 'export function foo() {}',
          oracleVerdicts: { ast: makeVerdict(true) },
        },
      ],
      answer: 'export function foo() { return 42; }',
    });

    const satisfaction = await evaluator.evaluate({
      input,
      result,
      oracleVerdicts: [makeVerdict(true, 'ast'), makeVerdict(true, 'type')],
      workingMemory: wm,
      understanding: makeUnderstanding(),
    });

    expect(satisfaction.basis).toBe('deterministic');
    expect(satisfaction.score).toBeGreaterThanOrEqual(0.75);
    expect(satisfaction.failedChecks.length).toBe(0);
    expect(satisfaction.passedChecks.length).toBeGreaterThan(0);
    expect(satisfaction.passedChecks.some((c) => c.startsWith('acceptance:'))).toBe(true);
  });

  test('partial pass → score between 0 and 1 with classified checks', async () => {
    const evaluator = new DefaultGoalEvaluator();
    const wm = new WorkingMemory({ taskId: 'task-1' });
    const input = makeInput({
      acceptanceCriteria: ['database migration with safety rollback'],
    });
    const result = makeResult({
      mutations: [
        {
          file: 'src/unrelated.ts',
          diff: 'const x = 1;',
          oracleVerdicts: { ast: makeVerdict(true) },
        },
      ],
      answer: 'const x = 1;',
    });

    const satisfaction = await evaluator.evaluate({
      input,
      result,
      oracleVerdicts: [makeVerdict(true, 'ast')],
      workingMemory: wm,
      understanding: makeUnderstanding(),
    });

    expect(satisfaction.score).toBeGreaterThan(0);
    expect(satisfaction.score).toBeLessThan(1);
    expect(satisfaction.failedChecks.length).toBeGreaterThan(0);
    expect(satisfaction.passedChecks.length).toBeGreaterThan(0);
    expect(satisfaction.blockers.some((b) => b.category === 'acceptance-criteria')).toBe(true);
  });

  test('missing acceptanceCriteria → neutral (not penalized)', async () => {
    const evaluator = new DefaultGoalEvaluator();
    const wm = new WorkingMemory({ taskId: 'task-1' });
    const input = makeInput(); // no acceptanceCriteria
    const result = makeResult({
      mutations: [
        {
          file: 'src/foo.ts',
          diff: 'export function foo() {}',
          oracleVerdicts: { ast: makeVerdict(true) },
        },
      ],
      answer: 'export function foo() {}',
    });

    const satisfaction = await evaluator.evaluate({
      input,
      result,
      oracleVerdicts: [makeVerdict(true)],
      workingMemory: wm,
      understanding: makeUnderstanding(),
    });

    expect(satisfaction.score).toBeGreaterThanOrEqual(0.75);
    expect(satisfaction.passedChecks.some((c) => c.startsWith('acceptance:'))).toBe(false);
    expect(satisfaction.failedChecks.some((c) => c.startsWith('acceptance:'))).toBe(false);
  });

  test('oracle contradiction → low score with blockers populated', async () => {
    const evaluator = new DefaultGoalEvaluator();
    const wm = new WorkingMemory({ taskId: 'task-1' });
    const input = makeInput({ acceptanceCriteria: ['non-matching acceptance'] });
    const result = makeResult({
      mutations: [
        {
          file: 'src/foo.ts',
          diff: 'broken',
          oracleVerdicts: { ast: makeVerdict(true), type: makeVerdict(false) },
        },
      ],
      answer: 'broken',
    });

    const satisfaction = await evaluator.evaluate({
      input,
      result,
      oracleVerdicts: [makeVerdict(true, 'ast'), makeVerdict(false, 'type')],
      workingMemory: wm,
      understanding: makeUnderstanding(),
    });

    expect(satisfaction.score).toBeLessThan(0.75);
    expect(satisfaction.failedChecks).toContain('oracle-consistency');
    expect(satisfaction.blockers.some((b) => b.category === 'oracle-contradiction')).toBe(true);
  });

  test('no understanding → still aggregates acceptance + oracle checks', async () => {
    const evaluator = new DefaultGoalEvaluator();
    const wm = new WorkingMemory({ taskId: 'task-1' });
    const input = makeInput({ acceptanceCriteria: ['foo'] });
    const result = makeResult({ answer: 'foo bar baz' });
    const satisfaction = await evaluator.evaluate({
      input,
      result,
      oracleVerdicts: [makeVerdict(true)],
      workingMemory: wm,
    });
    expect(satisfaction.score).toBeGreaterThan(0);
    expect(satisfaction.basis).toBe('deterministic');
  });
});
