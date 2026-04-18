/**
 * Wave 4: agent-loop goal-check hook tests.
 *
 * Exercises runWave4GoalCheck end-to-end: disabled gate → pass-through;
 * enabled gate with passing score → accept; enabled gate with low score
 * → flip to uncertain with blocker messages.
 */
import { describe, expect, test } from 'bun:test';
import { runWave4GoalCheck } from '../../../src/orchestrator/agent/agent-loop.ts';
import type { AgentLoopDeps } from '../../../src/orchestrator/agent/agent-loop.ts';
import type { GoalEvaluator, GoalSatisfaction } from '../../../src/orchestrator/goal-satisfaction/goal-evaluator.ts';
import type { TaskInput, TaskUnderstanding } from '../../../src/orchestrator/types.ts';

function makeInput(): TaskInput {
  return {
    id: 'task-w4',
    source: 'cli',
    goal: 'add tests for auth module',
    taskType: 'code',
    targetFiles: ['src/auth/login.ts'],
    budget: { maxTokens: 10_000, maxDurationMs: 60_000, maxRetries: 3 },
  };
}

function makeUnderstanding(): TaskUnderstanding {
  return {
    rawGoal: 'add tests for auth module',
    actionVerb: 'add',
    actionCategory: 'mutation',
    frameworkContext: [],
    constraints: [],
    acceptanceCriteria: [],
    expectsMutation: true,
  } as TaskUnderstanding;
}

function makeEvaluator(score: number, failedChecks: string[] = [], blockers: GoalSatisfaction['blockers'] = []): GoalEvaluator {
  return {
    async evaluate() {
      return {
        score,
        basis: 'deterministic',
        blockers,
        passedChecks: [],
        failedChecks,
      };
    },
  };
}

function makeDeps(overrides: Partial<AgentLoopDeps> = {}): AgentLoopDeps {
  return {
    workspace: '/tmp',
    contextWindow: 128_000,
    agentWorkerEntryPath: '/tmp/entry.ts',
    toolExecutor: { execute: async () => ({ status: 'success' }) as unknown as never },
    compressPerception: (p) => p,
    ...overrides,
  };
}

describe('runWave4GoalCheck', () => {
  test('disabled config → returns null, evaluator not called', async () => {
    let called = false;
    const deps = makeDeps({
      goalEvaluator: {
        async evaluate() {
          called = true;
          return { score: 0.3, basis: 'deterministic', blockers: [], passedChecks: [], failedChecks: [] };
        },
      },
      goalTerminationConfig: {
        enabled: false,
        maxContinuations: 2,
        continuationBudgetFraction: 0.25,
        goalSatisfactionThreshold: 0.75,
      },
    });

    const result = await runWave4GoalCheck(makeInput(), [], undefined, undefined, deps);
    expect(result).toBeNull();
    expect(called).toBe(false);
  });

  test('missing evaluator → returns null', async () => {
    const deps = makeDeps({
      goalTerminationConfig: {
        enabled: true,
        maxContinuations: 2,
        continuationBudgetFraction: 0.25,
        goalSatisfactionThreshold: 0.75,
      },
    });

    const result = await runWave4GoalCheck(makeInput(), [], undefined, undefined, deps);
    expect(result).toBeNull();
  });

  test('passing score → returns accept decision', async () => {
    const deps = makeDeps({
      goalEvaluator: makeEvaluator(0.9),
      goalTerminationConfig: {
        enabled: true,
        maxContinuations: 2,
        continuationBudgetFraction: 0.25,
        goalSatisfactionThreshold: 0.75,
      },
    });

    const result = await runWave4GoalCheck(
      makeInput(),
      [{ file: 'src/auth/login.ts', diff: '+test' }],
      'test content',
      makeUnderstanding(),
      deps,
    );
    expect(result).not.toBeNull();
    expect(result!.decision).toBe('accept');
    expect(result!.score).toBe(0.9);
  });

  test('low score → returns reject decision (observability only, no control flow change)', async () => {
    const deps = makeDeps({
      goalEvaluator: makeEvaluator(0.3, ['acceptance:tests'], [
        { category: 'acceptance-criteria', detail: 'no test file created', resolvable: true },
      ]),
      goalTerminationConfig: {
        enabled: true,
        maxContinuations: 2,
        continuationBudgetFraction: 0.25,
        goalSatisfactionThreshold: 0.75,
      },
    });

    const result = await runWave4GoalCheck(
      makeInput(),
      [{ file: 'src/auth/login.ts', diff: '+partial' }],
      undefined,
      makeUnderstanding(),
      deps,
    );
    expect(result).not.toBeNull();
    expect(result!.decision).toBe('reject'); // maxContinuations-exhausted collapses continue → reject
    expect(result!.score).toBe(0.3);
    expect(result!.reason).toContain('max continuations');
  });

  test('evaluator throws → fail-open returns null', async () => {
    const deps = makeDeps({
      goalEvaluator: {
        async evaluate() {
          throw new Error('evaluator boom');
        },
      },
      goalTerminationConfig: {
        enabled: true,
        maxContinuations: 2,
        continuationBudgetFraction: 0.25,
        goalSatisfactionThreshold: 0.75,
      },
    });

    const result = await runWave4GoalCheck(makeInput(), [], undefined, undefined, deps);
    expect(result).toBeNull();
  });

  test('emits agent-loop:goal-check bus event on every run', async () => {
    const events: Array<{ score: number; decision: string }> = [];
    const bus = {
      emit: (name: string, payload: unknown) => {
        if (name === 'agent-loop:goal-check') {
          events.push(payload as { score: number; decision: string });
        }
      },
      on: () => () => {},
      off: () => {},
    } as unknown as AgentLoopDeps['bus'];

    const deps = makeDeps({
      bus,
      goalEvaluator: makeEvaluator(0.9),
      goalTerminationConfig: {
        enabled: true,
        maxContinuations: 2,
        continuationBudgetFraction: 0.25,
        goalSatisfactionThreshold: 0.75,
      },
    });

    await runWave4GoalCheck(makeInput(), [], undefined, undefined, deps);
    expect(events).toHaveLength(1);
    expect(events[0]!.decision).toBe('accept');
    expect(events[0]!.score).toBe(0.9);
  });
});
