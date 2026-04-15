/**
 * Wave 4: agent-loop goal-check hook tests.
 *
 * Exercises runWave4GoalCheck end-to-end: disabled gate → pass-through;
 * enabled gate with passing score → accept; enabled gate with low score
 * → flip to uncertain with blocker messages.
 */
import { describe, expect, test } from 'bun:test';
import { runWave4GoalCheck } from '../../../src/orchestrator/worker/agent-loop.ts';
import type { AgentLoopDeps } from '../../../src/orchestrator/worker/agent-loop.ts';
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
  test('disabled config → pass-through (no flip, no evaluator call)', async () => {
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
    expect(result.flipToUncertain).toBe(false);
    expect(result.uncertainties).toEqual([]);
    expect(called).toBe(false);
  });

  test('missing evaluator → pass-through', async () => {
    const deps = makeDeps({
      goalTerminationConfig: {
        enabled: true,
        maxContinuations: 2,
        continuationBudgetFraction: 0.25,
        goalSatisfactionThreshold: 0.75,
      },
    });

    const result = await runWave4GoalCheck(makeInput(), [], undefined, undefined, deps);
    expect(result.flipToUncertain).toBe(false);
  });

  test('passing score → accept (no flip)', async () => {
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
    expect(result.flipToUncertain).toBe(false);
    expect(result.decision).toBe('accept');
    expect(result.score).toBe(0.9);
  });

  test('low score → flip to uncertain with blocker messages', async () => {
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
    expect(result.flipToUncertain).toBe(true);
    expect(result.uncertainties.length).toBeGreaterThan(0);
    expect(result.uncertainties[0]).toContain('goal-check');
    expect(result.uncertainties[0]).toContain('0.30');
    expect(result.uncertainties.some((u) => u.includes('acceptance-criteria'))).toBe(true);
  });

  test('evaluator throws → fail-open (no flip)', async () => {
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
    expect(result.flipToUncertain).toBe(false);
    expect(result.uncertainties).toEqual([]);
  });
});
