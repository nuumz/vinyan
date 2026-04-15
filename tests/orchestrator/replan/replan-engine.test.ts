/**
 * Wave 2: Replan Engine unit tests.
 *
 * All 4 stopping gates + success path + signature/trigram unit tests.
 * Stubs decomposer and perception with in-memory fakes (no real LLM).
 */
import { describe, expect, test } from 'bun:test';
import type { PerceptionAssembler, TaskDecomposer } from '../../../src/orchestrator/core-loop.ts';
import type { GoalSatisfaction } from '../../../src/orchestrator/goal-satisfaction/goal-evaluator.ts';
import {
  computePlanSignature,
  DefaultReplanEngine,
  type ReplanContext,
  type ReplanEngineConfig,
  trigramSimilarity,
} from '../../../src/orchestrator/replan/replan-engine.ts';
import type { PerceptualHierarchy, TaskDAG, TaskInput, TaskResult, WorkingMemoryState } from '../../../src/orchestrator/types.ts';

const CFG: ReplanEngineConfig = {
  enabled: true,
  maxReplans: 2,
  tokenSpendCapFraction: 0.2,
  trigramSimilarityMax: 0.85,
};

function mockInput(): TaskInput {
  return {
    id: 'task-1',
    source: 'cli',
    goal: 'fix the thing',
    taskType: 'code',
    targetFiles: ['src/foo.ts'],
    budget: { maxTokens: 10_000, maxDurationMs: 60_000, maxRetries: 3 },
  };
}

function mockResult(): TaskResult {
  return {
    id: 'task-1',
    status: 'completed',
    mutations: [],
    trace: {
      id: 'trace-1',
      taskId: 'task-1',
      timestamp: Date.now(),
      routingLevel: 1,
      approach: 'direct-edit',
      oracleVerdicts: {},
      modelUsed: 'fake',
      tokensConsumed: 0,
      durationMs: 0,
      outcome: 'success',
      affectedFiles: [],
    },
  };
}

function mockSatisfaction(): GoalSatisfaction {
  return {
    score: 0.4,
    basis: 'deterministic',
    blockers: [{ category: 'acceptance-criteria', detail: 'missing tests', resolvable: true }],
    passedChecks: ['mutation-expectation'],
    failedChecks: ['acceptance:add tests'],
  };
}

function mockPerception(): PerceptualHierarchy {
  return {
    dependencyCone: {
      directImporters: [],
      directImportees: [],
      transitiveBlastRadius: 1,
    },
    verifiedFacts: [],
    diagnostics: [],
  } as unknown as PerceptualHierarchy;
}

function fakeDag(nodes: Array<{ id: string; description: string; targetFiles: string[] }>): TaskDAG {
  return {
    nodes: nodes.map((n) => ({
      id: n.id,
      description: n.description,
      targetFiles: n.targetFiles,
      dependencies: [],
      assignedOracles: ['type'],
    })),
  };
}

function makeDecomposer(replan: TaskDecomposer['replan']): TaskDecomposer {
  return {
    async decompose() {
      throw new Error('decompose should not be called in replan tests');
    },
    replan,
  };
}

function makePerceptionFake(): PerceptionAssembler {
  return {
    async assemble() {
      return mockPerception();
    },
  };
}

function makeContext(overrides: Partial<ReplanContext> = {}): ReplanContext {
  return {
    previousInput: mockInput(),
    previousResult: mockResult(),
    failedApproaches: [],
    goalSatisfaction: mockSatisfaction(),
    iteration: 1,
    priorPlanSignatures: [],
    tokensSpentOnReplanning: 0,
    remainingTaskBudgetTokens: 10_000,
    ...overrides,
  };
}

describe('DefaultReplanEngine', () => {
  test('iteration >= maxReplans → null (max-replans gate)', async () => {
    const engine = new DefaultReplanEngine(
      { decomposer: makeDecomposer(async () => fakeDag([{ id: 'n1', description: 'x', targetFiles: ['a.ts'] }])), perception: makePerceptionFake() },
      CFG,
    );
    const result = await engine.generateAlternative(makeContext({ iteration: 2 }));
    expect(result).toBeNull();
  });

  test('token spend cap exceeded → null (budget-cap gate)', async () => {
    const engine = new DefaultReplanEngine(
      { decomposer: makeDecomposer(async () => fakeDag([{ id: 'n1', description: 'x', targetFiles: ['a.ts'] }])), perception: makePerceptionFake() },
      CFG,
    );
    // 25% > 20%
    const result = await engine.generateAlternative(
      makeContext({ tokensSpentOnReplanning: 2500, remainingTaskBudgetTokens: 10_000 }),
    );
    expect(result).toBeNull();
  });

  test('decomposer without replan method → null', async () => {
    const decomposer: TaskDecomposer = {
      async decompose() {
        return fakeDag([{ id: 'n1', description: 'x', targetFiles: ['a.ts'] }]);
      },
      // replan intentionally omitted
    };
    const engine = new DefaultReplanEngine({ decomposer, perception: makePerceptionFake() }, CFG);
    const result = await engine.generateAlternative(makeContext());
    expect(result).toBeNull();
  });

  test('decomposer throws → null (decomposer-failed gate)', async () => {
    const engine = new DefaultReplanEngine(
      {
        decomposer: makeDecomposer(async () => {
          throw new Error('boom');
        }),
        perception: makePerceptionFake(),
      },
      CFG,
    );
    const result = await engine.generateAlternative(makeContext());
    expect(result).toBeNull();
  });

  test('decomposer returns fallback DAG → null', async () => {
    const engine = new DefaultReplanEngine(
      {
        decomposer: makeDecomposer(async () => ({
          ...fakeDag([{ id: 'n1', description: 'x', targetFiles: ['a.ts'] }]),
          isFallback: true,
        })),
        perception: makePerceptionFake(),
      },
      CFG,
    );
    const result = await engine.generateAlternative(makeContext());
    expect(result).toBeNull();
  });

  test('duplicate plan signature → null', async () => {
    const dup = fakeDag([{ id: 'n1', description: 'different text', targetFiles: ['src/foo.ts'] }]);
    const dupSig = computePlanSignature(dup);
    const engine = new DefaultReplanEngine(
      { decomposer: makeDecomposer(async () => dup), perception: makePerceptionFake() },
      CFG,
    );
    const result = await engine.generateAlternative(makeContext({ priorPlanSignatures: [dupSig] }));
    expect(result).toBeNull();
  });

  test('high trigram similarity vs prior failed approach → null', async () => {
    const novelDag = fakeDag([{ id: 'n1', description: 'refactor the module structure', targetFiles: ['src/novel.ts'] }]);
    const engine = new DefaultReplanEngine(
      { decomposer: makeDecomposer(async () => novelDag), perception: makePerceptionFake() },
      CFG,
    );
    const failedApproaches: WorkingMemoryState['failedApproaches'] = [
      {
        approach: 'refactor the module structure',
        oracleVerdict: 'type error',
        timestamp: Date.now(),
      },
    ];
    const result = await engine.generateAlternative(makeContext({ failedApproaches }));
    expect(result).toBeNull();
  });

  test('valid novel replan → returns outcome with signature', async () => {
    const novelDag = fakeDag([
      { id: 'n1', description: 'write pytest test suite first', targetFiles: ['tests/foo.test.ts'] },
      { id: 'n2', description: 'then make production code satisfy those tests', targetFiles: ['src/foo.ts'] },
    ]);
    const engine = new DefaultReplanEngine(
      { decomposer: makeDecomposer(async () => novelDag), perception: makePerceptionFake() },
      CFG,
    );
    const failedApproaches: WorkingMemoryState['failedApproaches'] = [
      {
        approach: 'direct edit inline',
        oracleVerdict: 'type error',
        timestamp: Date.now(),
      },
    ];
    const result = await engine.generateAlternative(makeContext({ failedApproaches }));
    expect(result).not.toBeNull();
    expect(result!.planSignature).toMatch(/^[0-9a-f]{64}$/);
    expect(result!.plan.nodes).toHaveLength(2);
    expect(result!.input.id).toBe('task-1');
  });

  test('successful replan returns non-zero tokensUsed estimate (gap fix)', async () => {
    const engine = new DefaultReplanEngine(
      {
        decomposer: makeDecomposer(async () => fakeDag([{ id: 'n1', description: 'novel approach', targetFiles: ['a.ts'] }])),
        perception: makePerceptionFake(),
      },
      CFG,
    );
    const result = await engine.generateAlternative(makeContext());
    expect(result).not.toBeNull();
    expect(result!.tokensUsed).toBeGreaterThan(0);
    // Cap check: tokensUsed should bound the budget cap gate on next iteration.
  });

  test('successful replan rewrites goal with REPLAN directive (gap fix)', async () => {
    const engine = new DefaultReplanEngine(
      {
        decomposer: makeDecomposer(async () =>
          fakeDag([
            { id: 'n1', description: 'test-first refactor', targetFiles: ['tests/foo.test.ts'] },
            { id: 'n2', description: 'impl after test', targetFiles: ['src/foo.ts'] },
          ]),
        ),
        perception: makePerceptionFake(),
      },
      CFG,
    );
    const originalGoal = 'fix the thing';
    const ctx = makeContext({ iteration: 1, previousInput: { ...mockInput(), goal: originalGoal } });
    const result = await engine.generateAlternative(ctx);

    expect(result).not.toBeNull();
    expect(result!.input.goal).not.toBe(originalGoal);
    expect(result!.input.goal).toContain(originalGoal);
    expect(result!.input.goal).toContain('REPLAN attempt 2');
    expect(result!.input.goal).toContain('STRUCTURALLY DIFFERENT');
    expect(result!.input.goal).toContain('test-first refactor');
    expect(result!.input.goal).toContain('impl after test');
    // TaskInput is spread so id + budget + targetFiles are preserved
    expect(result!.input.id).toBe(ctx.previousInput.id);
    expect(result!.input.budget).toEqual(ctx.previousInput.budget);
  });

  test('budget-cap gate actually fires after tokens accumulate (gap fix)', async () => {
    // With tokensSpentOnReplanning + ESTIMATED_REPLAN_TOKENS > 20% budget.
    const engine = new DefaultReplanEngine(
      {
        decomposer: makeDecomposer(async () => fakeDag([{ id: 'n1', description: 'x', targetFiles: ['a.ts'] }])),
        perception: makePerceptionFake(),
      },
      CFG,
    );
    // First call: 0 spent / 10000 remaining = 0% — passes gate
    const first = await engine.generateAlternative(makeContext({ remainingTaskBudgetTokens: 10_000 }));
    expect(first).not.toBeNull();
    // Second call: simulate prior replan's 2000 tokens already spent vs 5000 remaining = 40% > 20% cap
    const second = await engine.generateAlternative(
      makeContext({ tokensSpentOnReplanning: first!.tokensUsed, remainingTaskBudgetTokens: 5_000 }),
    );
    expect(second).toBeNull();
  });
});

describe('computePlanSignature', () => {
  test('order-independent across nodes', () => {
    const a = fakeDag([
      { id: 'n2', description: 'a', targetFiles: ['b.ts', 'a.ts'] },
      { id: 'n1', description: 'b', targetFiles: ['c.ts'] },
    ]);
    const b = fakeDag([
      { id: 'n1', description: 'different-text', targetFiles: ['c.ts'] },
      { id: 'n2', description: 'also-different', targetFiles: ['a.ts', 'b.ts'] },
    ]);
    expect(computePlanSignature(a)).toBe(computePlanSignature(b));
  });

  test('structure-sensitive', () => {
    const a = fakeDag([{ id: 'n1', description: 'x', targetFiles: ['a.ts'] }]);
    const b = fakeDag([{ id: 'n1', description: 'x', targetFiles: ['b.ts'] }]);
    expect(computePlanSignature(a)).not.toBe(computePlanSignature(b));
  });
});

describe('trigramSimilarity', () => {
  test('identical strings → 1.0', () => {
    expect(trigramSimilarity('hello world', 'hello world')).toBeCloseTo(1, 5);
  });

  test('fully disjoint → 0', () => {
    expect(trigramSimilarity('abcdefghij', 'zyxwvutsrq')).toBe(0);
  });

  test('partial overlap → between 0 and 1', () => {
    const sim = trigramSimilarity('the quick brown fox', 'the slow brown dog');
    expect(sim).toBeGreaterThan(0);
    expect(sim).toBeLessThan(1);
  });

  test('empty strings → 1', () => {
    expect(trigramSimilarity('', '')).toBe(1);
  });
});
