import { describe, expect, test } from 'bun:test';
import type { OracleVerdict } from '../../../src/core/types.ts';
import {
  computePredictionError,
  DefaultGoalEvaluator,
} from '../../../src/orchestrator/goal-satisfaction/goal-evaluator.ts';
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

describe('DefaultGoalEvaluator › accountability grade', () => {
  test('grade A — all checks pass, zero blockers', async () => {
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

    expect(satisfaction.failedChecks.length).toBe(0);
    expect(satisfaction.blockers.length).toBe(0);
    expect(satisfaction.accountabilityGrade).toBe('A');
  });

  test('grade B — score acceptable but acceptance gap (resolvable)', async () => {
    const evaluator = new DefaultGoalEvaluator();
    const wm = new WorkingMemory({ taskId: 'task-1' });
    const input = makeInput({
      acceptanceCriteria: ['totally unrelated criterion words zebra'],
    });
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

    // Acceptance miss is resolvable; alignment + oracle pass → B.
    expect(satisfaction.accountabilityGrade).toBe('B');
    expect(satisfaction.blockers.every((b) => b.resolvable === true)).toBe(true);
  });

  test('grade C — oracle contradiction forces critical grade even with passes', async () => {
    const evaluator = new DefaultGoalEvaluator();
    const wm = new WorkingMemory({ taskId: 'task-1' });
    const input = makeInput({ acceptanceCriteria: ['foo'] });
    const result = makeResult({
      mutations: [
        {
          file: 'src/foo.ts',
          diff: 'foo bar',
          oracleVerdicts: { ast: makeVerdict(true), type: makeVerdict(false) },
        },
      ],
      answer: 'foo bar baz',
    });

    const satisfaction = await evaluator.evaluate({
      input,
      result,
      oracleVerdicts: [makeVerdict(true, 'ast'), makeVerdict(false, 'type')],
      workingMemory: wm,
      understanding: makeUnderstanding(),
    });

    expect(satisfaction.accountabilityGrade).toBe('C');
    expect(satisfaction.blockers.some((b) => b.category === 'oracle-contradiction')).toBe(true);
  });

  test('grade C — unresolvable mutation-expectation blocker', async () => {
    const evaluator = new DefaultGoalEvaluator();
    const wm = new WorkingMemory({ taskId: 'task-1' });
    // Task expects mutation, but result has zero mutations and empty answer.
    const input = makeInput({ acceptanceCriteria: ['add foo'] });
    const result = makeResult({ mutations: [], answer: '' });

    const satisfaction = await evaluator.evaluate({
      input,
      result,
      oracleVerdicts: [],
      workingMemory: wm,
      understanding: makeUnderstanding({ expectsMutation: true }),
    });

    expect(satisfaction.accountabilityGrade).toBe('C');
    expect(
      satisfaction.blockers.some(
        (b) => b.category === 'mutation-expectation' && b.resolvable === false,
      ),
    ).toBe(true);
  });
});

describe('computePredictionError (slice 4 Gap B)', () => {
  test('aligned grades → magnitude=aligned, direction=aligned', () => {
    expect(computePredictionError('A', 'A')).toEqual({
      selfGrade: 'A',
      deterministicGrade: 'A',
      magnitude: 'aligned',
      direction: 'aligned',
    });
    expect(computePredictionError('B', 'B').magnitude).toBe('aligned');
    expect(computePredictionError('C', 'C').magnitude).toBe('aligned');
  });

  test('one-step gap → minor', () => {
    expect(computePredictionError('A', 'B').magnitude).toBe('minor');
    expect(computePredictionError('B', 'C').magnitude).toBe('minor');
    expect(computePredictionError('B', 'A').magnitude).toBe('minor');
  });

  test('two-step gap → severe (the dangerous case)', () => {
    expect(computePredictionError('A', 'C').magnitude).toBe('severe');
    expect(computePredictionError('C', 'A').magnitude).toBe('severe');
  });

  test('direction=overconfident when self-grade is better than deterministic', () => {
    expect(computePredictionError('A', 'C').direction).toBe('overconfident');
    expect(computePredictionError('A', 'B').direction).toBe('overconfident');
    expect(computePredictionError('B', 'C').direction).toBe('overconfident');
  });

  test('direction=underconfident when self-grade is worse than deterministic', () => {
    expect(computePredictionError('C', 'A').direction).toBe('underconfident');
    expect(computePredictionError('B', 'A').direction).toBe('underconfident');
    expect(computePredictionError('C', 'B').direction).toBe('underconfident');
  });
});

describe('DefaultGoalEvaluator › prediction error wiring', () => {
  test('records predictionError when result.workerSelfAssessment is present', async () => {
    const evaluator = new DefaultGoalEvaluator();
    const wm = new WorkingMemory({ taskId: 'task-1' });
    const input = makeInput();
    // Severe overconfidence: agent claims A on a result that has an oracle
    // contradiction, which forces deterministic grade C.
    const result = makeResult({
      mutations: [
        { file: 'src/foo.ts', diff: '+ export const foo = 1;', oracleVerdicts: {} },
      ],
      workerSelfAssessment: { grade: 'A', gaps: [] },
    });

    const satisfaction = await evaluator.evaluate({
      input,
      result,
      oracleVerdicts: [makeVerdict(true, 'ast'), makeVerdict(false, 'type')],
      workingMemory: wm,
      understanding: makeUnderstanding(),
    });

    expect(satisfaction.accountabilityGrade).toBe('C');
    expect(satisfaction.predictionError).toBeDefined();
    expect(satisfaction.predictionError).toMatchObject({
      selfGrade: 'A',
      deterministicGrade: 'C',
      magnitude: 'severe',
      direction: 'overconfident',
    });
  });

  test('omits predictionError when worker did not self-grade', async () => {
    const evaluator = new DefaultGoalEvaluator();
    const wm = new WorkingMemory({ taskId: 'task-1' });
    const input = makeInput();
    const result = makeResult({
      mutations: [
        { file: 'src/foo.ts', diff: '+ export const foo = 1;', oracleVerdicts: {} },
      ],
      // workerSelfAssessment intentionally absent
    });

    const satisfaction = await evaluator.evaluate({
      input,
      result,
      oracleVerdicts: [makeVerdict(true, 'ast')],
      workingMemory: wm,
      understanding: makeUnderstanding(),
    });

    expect(satisfaction.predictionError).toBeUndefined();
  });

  test('aligned grades produce predictionError with magnitude=aligned', async () => {
    const evaluator = new DefaultGoalEvaluator();
    const wm = new WorkingMemory({ taskId: 'task-1' });
    const input = makeInput({ acceptanceCriteria: ['add foo'] });
    const result = makeResult({
      mutations: [
        { file: 'src/foo.ts', diff: '+ export const foo = 1;', oracleVerdicts: {} },
      ],
      answer: 'add foo done',
      workerSelfAssessment: { grade: 'A' },
    });

    const satisfaction = await evaluator.evaluate({
      input,
      result,
      oracleVerdicts: [makeVerdict(true, 'ast')],
      workingMemory: wm,
      understanding: makeUnderstanding({ expectsMutation: true, acceptanceCriteria: ['add foo'] }),
    });

    // Should be an A — and prediction error aligned.
    expect(satisfaction.accountabilityGrade).toBe('A');
    expect(satisfaction.predictionError).toMatchObject({
      selfGrade: 'A',
      deterministicGrade: 'A',
      magnitude: 'aligned',
      direction: 'aligned',
    });
  });
});
