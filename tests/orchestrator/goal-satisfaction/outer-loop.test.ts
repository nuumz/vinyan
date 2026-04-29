import { describe, expect, test } from 'bun:test';
import type { OrchestratorDeps } from '../../../src/orchestrator/core-loop.ts';
import type {
  GoalEvaluator,
  GoalSatisfaction,
} from '../../../src/orchestrator/goal-satisfaction/goal-evaluator.ts';
import { executeWithGoalLoop } from '../../../src/orchestrator/goal-satisfaction/outer-loop.ts';
import type { ExecutionTrace, TaskInput, TaskResult } from '../../../src/orchestrator/types.ts';
import type { WorkingMemory } from '../../../src/orchestrator/working-memory.ts';

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
      const safeScore = score ?? 0;
      const failedChecks = score && score < 1 ? ['file-scope'] : [];
      return {
        score: safeScore,
        basis: 'deterministic',
        blockers: [],
        passedChecks: ['mutation-expectation'],
        failedChecks,
        accountabilityGrade: failedChecks.length === 0 ? 'A' : safeScore < 0.5 ? 'C' : 'B',
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
    expect(result.trace.governanceProvenance).toMatchObject({
      attributedTo: 'goalLoop',
      wasGeneratedBy: 'executeWithGoalLoop',
      reason: 'goal-loop budget exhausted',
    });
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

  // ── Wave 2 gap fix tests ────────────────────────────────────────────

  test('initial approach recorded as failed approach before first replan (gap fix)', async () => {
    // Capture the ReplanContext passed to the engine so we can assert
    // failedApproaches is populated with the first attempt's approach.
    const seen: Array<{ failedApproaches: unknown[] }> = [];
    const replanEngine = {
      async generateAlternative(ctx: { failedApproaches: unknown[] }) {
        seen.push({ failedApproaches: [...ctx.failedApproaches] });
        return null; // stop after first replan call for test simplicity
      },
    } as unknown as NonNullable<OrchestratorDeps['replanEngine']>;
    const replanConfig = {
      enabled: true,
      maxReplans: 2,
      tokenSpendCapFraction: 0.2,
      trigramSimilarityMax: 0.85,
    };
    const deps = baseDeps({
      goalEvaluator: makeEvaluator([0.3]),
      replanEngine,
      replanConfig,
    });
    const attempt = async (_: TaskInput, __: WorkingMemory): Promise<TaskResult> => {
      return makeResult({
        mutations: [
          { file: 'src/foo.ts', diff: '+x', oracleVerdicts: {} },
          { file: 'src/bar.ts', diff: '+y', oracleVerdicts: {} },
        ],
        trace: { ...makeTrace(), approach: 'direct-edit' },
      });
    };

    await executeWithGoalLoop(makeInput(), deps, attempt, {
      maxOuterIterations: 3,
      goalSatisfactionThreshold: 0.75,
    });

    // The engine saw a non-empty failedApproaches list populated by the
    // outer loop's synthesis step (Wave 2 gap fix).
    expect(seen).toHaveLength(1);
    expect(seen[0]!.failedApproaches.length).toBeGreaterThan(0);
    const approachText = (seen[0]!.failedApproaches[0] as { approach: string }).approach;
    expect(approachText).toContain('edit src/foo.ts');
    expect(approachText).toContain('edit src/bar.ts');
    expect(approachText).toContain('direct-edit');
  });

  test('replan-exhausted escalation when engine returns null (gap fix)', async () => {
    const replanEngine = {
      async generateAlternative() {
        return null;
      },
    } as unknown as NonNullable<OrchestratorDeps['replanEngine']>;
    const deps = baseDeps({
      goalEvaluator: makeEvaluator([0.3]),
      replanEngine,
      replanConfig: { enabled: true, maxReplans: 2, tokenSpendCapFraction: 0.2, trigramSimilarityMax: 0.85 },
    });
    const attempt = async (): Promise<TaskResult> => makeResult();
    const result = await executeWithGoalLoop(makeInput(), deps, attempt, {
      maxOuterIterations: 3,
      goalSatisfactionThreshold: 0.75,
    });
    expect(result.status).toBe('escalated');
    expect(result.escalationReason).toContain('replan exhausted');
  });

  test('accountability gate: grade=C blocks satisfied even if score >= threshold', async () => {
    // Score passes the 0.75 threshold but the evaluator marks the result as
    // Grade C (critical flaw). The outer loop must escalate, not return.
    let attempts = 0;
    let blockEvent: Record<string, unknown> | undefined;
    const events: Array<{ name: string; payload: unknown }> = [];
    const bus = {
      emit: (name: string, payload: unknown) => {
        events.push({ name, payload });
        if (name === 'goal-loop:accountability-block') {
          blockEvent = payload as Record<string, unknown>;
        }
      },
    } as unknown as NonNullable<OrchestratorDeps['bus']>;
    const evaluator: GoalEvaluator = {
      evaluate: async () => ({
        score: 0.9,
        basis: 'deterministic',
        blockers: [
          { category: 'oracle-contradiction', detail: 'ast/type disagree', resolvable: true },
        ],
        passedChecks: ['mutation-expectation', 'target-symbol'],
        failedChecks: ['oracle-consistency'],
        accountabilityGrade: 'C',
      }),
    };
    const deps = baseDeps({
      goalEvaluator: evaluator,
      bus,
      // No replan engine → fallback escalation path is exercised.
    });
    const attempt = async (): Promise<TaskResult> => {
      attempts++;
      return makeResult();
    };

    const result = await executeWithGoalLoop(makeInput(), deps, attempt, {
      maxOuterIterations: 3,
      goalSatisfactionThreshold: 0.75,
    });

    expect(attempts).toBe(1);
    expect(result.status).toBe('escalated');
    expect(blockEvent).toBeDefined();
    expect((blockEvent as { score: number }).score).toBe(0.9);
  });

  test('emits goal-loop:prediction-error when satisfaction.predictionError is present (slice 4 Gap B)', async () => {
    const events: Array<{ name: string; payload: unknown }> = [];
    const bus = {
      emit: (name: string, payload: unknown) => events.push({ name, payload }),
    } as unknown as NonNullable<OrchestratorDeps['bus']>;
    const evaluator: GoalEvaluator = {
      evaluate: async () => ({
        score: 0.95,
        basis: 'deterministic',
        blockers: [],
        passedChecks: ['mutation-expectation', 'target-symbol'],
        failedChecks: [],
        accountabilityGrade: 'A',
        predictionError: {
          selfGrade: 'C',
          deterministicGrade: 'A',
          magnitude: 'severe',
          direction: 'underconfident',
        },
      }),
    };
    const deps = baseDeps({ goalEvaluator: evaluator, bus });
    const attempt = async (): Promise<TaskResult> => makeResult();

    await executeWithGoalLoop(makeInput(), deps, attempt, {
      maxOuterIterations: 1,
      goalSatisfactionThreshold: 0.75,
    });

    const predEvent = events.find((e) => e.name === 'goal-loop:prediction-error');
    expect(predEvent).toBeDefined();
    expect(predEvent?.payload).toMatchObject({
      selfGrade: 'C',
      deterministicGrade: 'A',
      magnitude: 'severe',
      direction: 'underconfident',
    });
  });

  test('does NOT emit goal-loop:prediction-error when worker did not self-grade', async () => {
    const events: Array<{ name: string; payload: unknown }> = [];
    const bus = {
      emit: (name: string, payload: unknown) => events.push({ name, payload }),
    } as unknown as NonNullable<OrchestratorDeps['bus']>;
    const evaluator: GoalEvaluator = {
      evaluate: async () => ({
        score: 0.95,
        basis: 'deterministic',
        blockers: [],
        passedChecks: ['mutation-expectation'],
        failedChecks: [],
        accountabilityGrade: 'A',
        // predictionError intentionally absent
      }),
    };
    const deps = baseDeps({ goalEvaluator: evaluator, bus });
    const attempt = async (): Promise<TaskResult> => makeResult();

    await executeWithGoalLoop(makeInput(), deps, attempt, {
      maxOuterIterations: 1,
      goalSatisfactionThreshold: 0.75,
    });

    expect(events.find((e) => e.name === 'goal-loop:prediction-error')).toBeUndefined();
  });

  test('persists predictionError into WorkingMemory for next-iteration carry-over (slice 4 follow-up)', async () => {
    const evaluator: GoalEvaluator = {
      evaluate: async () => ({
        score: 0.95,
        basis: 'deterministic',
        blockers: [],
        passedChecks: ['mutation-expectation'],
        failedChecks: [],
        accountabilityGrade: 'A',
        predictionError: {
          selfGrade: 'A',
          deterministicGrade: 'C',
          magnitude: 'severe',
          direction: 'overconfident',
        },
      }),
    };
    const deps = baseDeps({ goalEvaluator: evaluator });
    let capturedWm: WorkingMemory | undefined;
    const attempt = async (_: TaskInput, wm: WorkingMemory): Promise<TaskResult> => {
      capturedWm = wm;
      return makeResult();
    };

    await executeWithGoalLoop(makeInput(), deps, attempt, {
      maxOuterIterations: 1,
      goalSatisfactionThreshold: 0.75,
    });

    expect(capturedWm?.getLastPredictionError()).toEqual({
      selfGrade: 'A',
      deterministicGrade: 'C',
      magnitude: 'severe',
      direction: 'overconfident',
    });
  });
});
