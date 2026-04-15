import { describe, expect, test } from 'bun:test';
import type { OrchestratorDeps } from '../../../src/orchestrator/core-loop.ts';
import type {
  GoalEvaluator,
  GoalSatisfaction,
} from '../../../src/orchestrator/goal-satisfaction/goal-evaluator.ts';
import { executeWithGoalLoop } from '../../../src/orchestrator/goal-satisfaction/outer-loop.ts';
import type { ExecutionTrace, TaskInput, TaskResult } from '../../../src/orchestrator/types.ts';
import { WorkingMemory } from '../../../src/orchestrator/working-memory.ts';

function makeInput(): TaskInput {
  return {
    id: 'task-outer',
    source: 'cli',
    goal: 'Do a thing',
    taskType: 'code',
    budget: { maxTokens: 1000, maxDurationMs: 5000, maxRetries: 1 },
  };
}

function makeTrace(): ExecutionTrace {
  return {
    id: 'trace',
    taskId: 'task-outer',
    timestamp: 0,
    routingLevel: 0,
    approach: 'mock',
    oracleVerdicts: {},
    modelUsed: 'mock',
    tokensConsumed: 0,
    durationMs: 0,
    outcome: 'success',
    affectedFiles: [],
  };
}

function makeResult(overrides?: Partial<TaskResult>): TaskResult {
  return {
    id: 'task-outer',
    status: 'completed',
    mutations: [],
    trace: makeTrace(),
    ...overrides,
  };
}

function makeEvaluator(scores: number[]): GoalEvaluator {
  let call = 0;
  return {
    evaluate: async (): Promise<GoalSatisfaction> => {
      const score = scores[call] ?? scores[scores.length - 1] ?? 0;
      call++;
      return {
        score: score ?? 0,
        basis: 'deterministic',
        blockers: [],
        passedChecks: ['mutation-expectation'],
        failedChecks: score && score < 1 ? ['file-scope'] : [],
      };
    },
  };
}

function baseDeps(overrides?: Partial<OrchestratorDeps>): OrchestratorDeps {
  return {
    // Stubs — outer loop only touches goalEvaluator + budgetEnforcer + bus.
    perception: {} as never,
    riskRouter: {} as never,
    selfModel: {} as never,
    decomposer: {} as never,
    workerPool: {} as never,
    oracleGate: {} as never,
    traceCollector: { record: async () => {} } as never,
    ...overrides,
  };
}

describe('executeWithGoalLoop', () => {
  test('goal met on first attempt → one call, returns quickly', async () => {
    let calls = 0;
    const deps = baseDeps({ goalEvaluator: makeEvaluator([1.0]) });
    const attempt = async (_: TaskInput, __: WorkingMemory): Promise<TaskResult> => {
      calls++;
      return makeResult();
    };
    const result = await executeWithGoalLoop(makeInput(), deps, attempt, {
      maxOuterIterations: 3,
      goalSatisfactionThreshold: 0.75,
    });
    expect(calls).toBe(1);
    expect(result.status).toBe('completed');
  });

  test('goal not met, no replan → 1 call, returns escalated', async () => {
    let calls = 0;
    const deps = baseDeps({ goalEvaluator: makeEvaluator([0.3]) });
    const attempt = async (_: TaskInput, __: WorkingMemory): Promise<TaskResult> => {
      calls++;
      return makeResult();
    };
    const result = await executeWithGoalLoop(makeInput(), deps, attempt, {
      maxOuterIterations: 3,
      goalSatisfactionThreshold: 0.75,
    });
    expect(calls).toBe(1);
    expect(result.status).toBe('escalated');
    expect(result.escalationReason).toContain('replan not available');
  });

  test('budget exhausted before first iteration → returns escalated with budget reason', async () => {
    const budgetEnforcer = {
      canProceed: () => ({ allowed: false, statuses: [] }),
      checkBudget: () => [],
    } as unknown as NonNullable<OrchestratorDeps['budgetEnforcer']>;
    let calls = 0;
    const deps = baseDeps({
      goalEvaluator: makeEvaluator([1.0]),
      budgetEnforcer,
    });
    const attempt = async (): Promise<TaskResult> => {
      calls++;
      return makeResult();
    };
    const result = await executeWithGoalLoop(makeInput(), deps, attempt, {
      maxOuterIterations: 3,
      goalSatisfactionThreshold: 0.75,
    });
    expect(calls).toBe(0);
    expect(result.status).toBe('escalated');
    expect(result.escalationReason).toContain('budget exhausted');
  });

  test('status !== completed → returns immediately without evaluation', async () => {
    let evalCalls = 0;
    const evaluator: GoalEvaluator = {
      evaluate: async () => {
        evalCalls++;
        return {
          score: 1,
          basis: 'deterministic',
          blockers: [],
          passedChecks: [],
          failedChecks: [],
        };
      },
    };
    const deps = baseDeps({ goalEvaluator: evaluator });
    const attempt = async (): Promise<TaskResult> => makeResult({ status: 'failed' });
    const result = await executeWithGoalLoop(makeInput(), deps, attempt, {
      maxOuterIterations: 3,
      goalSatisfactionThreshold: 0.75,
    });
    expect(result.status).toBe('failed');
    expect(evalCalls).toBe(0);
  });

  test('no goalEvaluator → single-pass fallback returns attempt result', async () => {
    let calls = 0;
    const deps = baseDeps();
    const attempt = async (): Promise<TaskResult> => {
      calls++;
      return makeResult();
    };
    const result = await executeWithGoalLoop(makeInput(), deps, attempt, {
      maxOuterIterations: 3,
      goalSatisfactionThreshold: 0.75,
    });
    expect(calls).toBe(1);
    expect(result.status).toBe('completed');
  });
});
