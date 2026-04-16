import { describe, expect, test } from 'bun:test';
import { DefaultReplanEngine, computePlanSignature, type ReplanContext, type ReplanEngineDeps } from '../../../src/orchestrator/replan/replan-engine.ts';
import { buildFailurePatternLibrary } from '../../../src/orchestrator/replan/failure-pattern-library.ts';
import type { ClassifiedFailure } from '../../../src/orchestrator/failure-classifier.ts';
import type { TaskDAG, TaskInput, TaskResult, WorkingMemoryState } from '../../../src/orchestrator/types.ts';

function makeDeps(overrides?: Partial<ReplanEngineDeps>): ReplanEngineDeps {
  return {
    decomposer: {
      decompose: async () => ({ nodes: [] }),
      replan: async () => ({ nodes: [{ id: 'llm-plan', description: 'LLM generated', targetFiles: ['x.ts'], dependencies: [], assignedOracles: ['type'] }] }),
    },
    perception: {
      assemble: async () => ({
        dependencyCone: { directImportees: [], transitiveBlastRadius: 1 },
      }),
    } as any,
    failurePatternLibrary: buildFailurePatternLibrary(),
    ...overrides,
  };
}

function makeContext(overrides?: Partial<ReplanContext>): ReplanContext {
  return {
    previousInput: {
      id: 'task-1',
      goal: 'fix bug',
      domain: 'code-mutation',
      source: 'cli',
      taskType: 'code-edit',
      budget: { maxTokens: 8000, maxRetries: 2, maxDurationMs: 60000 },
      targetFiles: ['src/foo.ts'],
    } as unknown as TaskInput,
    previousPlan: {
      nodes: [
        { id: 'n1', description: 'edit source', targetFiles: ['src/foo.ts', 'src/bar.ts'], dependencies: [], assignedOracles: ['type', 'lint'] },
      ],
    },
    previousResult: {
      id: 'task-1',
      status: 'completed',
      mutations: [{ file: 'src/foo.ts', diff: '', oracleVerdicts: {} }],
      trace: { id: 'trace-1', taskId: 'task-1', timestamp: 0, routingLevel: 1, approach: 'direct edit', oracleVerdicts: {}, modelUsed: 'test', tokensConsumed: 0, durationMs: 0, outcome: 'failure', affectedFiles: [] },
    } as TaskResult,
    failedApproaches: [
      {
        approach: 'direct edit src/foo.ts',
        oracleVerdict: 'type check failed',
        timestamp: Date.now(),
        classifiedFailures: [
          { category: 'type_error', file: 'src/foo.ts', line: 42, message: "TS2339: Property 'bar' does not exist", severity: 'error' },
        ] as ClassifiedFailure[],
      },
    ] as WorkingMemoryState['failedApproaches'],
    goalSatisfaction: { score: 0.3, basis: 'deterministic', blockers: [], passedChecks: [], failedChecks: ['type-check'] },
    iteration: 1,
    priorPlanSignatures: [],
    tokensSpentOnReplanning: 0,
    remainingTaskBudgetTokens: 6000,
    ...overrides,
  };
}

describe('Deterministic DAG Transform in ReplanEngine', () => {
  test('type_error + previousPlan → deterministic transform returned, zero tokens', async () => {
    const engine = new DefaultReplanEngine(makeDeps(), {
      enabled: true, maxReplans: 3, tokenSpendCapFraction: 0.2, trigramSimilarityMax: 0.85,
    });

    const outcome = await engine.generateAlternative(makeContext());
    expect(outcome).not.toBeNull();
    expect(outcome!.tokensUsed).toBe(0); // No LLM
    expect(outcome!.plan.nodes.length).toBe(2); // Isolated + remaining
    expect(outcome!.plan.nodes.some((n) => n.id === 'n1-type-iso')).toBe(true);
    expect(outcome!.input.goal).toContain('Deterministic recovery: isolate-file-node');
  });

  test('deterministic transform produces duplicate signature → falls through to LLM', async () => {
    const ctx = makeContext();
    // Pre-compute the deterministic signature and add it as prior
    const library = buildFailurePatternLibrary();
    const strategy = library.get('type_error')!;
    const transformed = strategy.dagTransform(ctx.previousPlan!, ctx.failedApproaches[0]!.classifiedFailures as ClassifiedFailure[])!;
    const sig = computePlanSignature(transformed);

    const ctxWithPrior = makeContext({ priorPlanSignatures: [sig] });
    const engine = new DefaultReplanEngine(makeDeps(), {
      enabled: true, maxReplans: 3, tokenSpendCapFraction: 0.2, trigramSimilarityMax: 0.85,
    });

    const outcome = await engine.generateAlternative(ctxWithPrior);
    // Falls through to LLM — should get the LLM-generated plan
    expect(outcome).not.toBeNull();
    expect(outcome!.tokensUsed).toBeGreaterThan(0); // LLM path
    expect(outcome!.plan.nodes[0]!.id).toBe('llm-plan');
  });

  test('no previousPlan → falls through to LLM', async () => {
    const engine = new DefaultReplanEngine(makeDeps(), {
      enabled: true, maxReplans: 3, tokenSpendCapFraction: 0.2, trigramSimilarityMax: 0.85,
    });

    const outcome = await engine.generateAlternative(makeContext({ previousPlan: undefined }));
    expect(outcome).not.toBeNull();
    expect(outcome!.tokensUsed).toBeGreaterThan(0); // LLM path
  });

  test('no classified failures → falls through to LLM', async () => {
    const engine = new DefaultReplanEngine(makeDeps(), {
      enabled: true, maxReplans: 3, tokenSpendCapFraction: 0.2, trigramSimilarityMax: 0.85,
    });

    const ctx = makeContext({
      failedApproaches: [{ approach: 'edit', oracleVerdict: 'failed', timestamp: Date.now() }],
    });
    const outcome = await engine.generateAlternative(ctx);
    expect(outcome).not.toBeNull();
    expect(outcome!.tokensUsed).toBeGreaterThan(0); // LLM path
  });

  test('category not in library → falls through to LLM', async () => {
    const engine = new DefaultReplanEngine(makeDeps(), {
      enabled: true, maxReplans: 3, tokenSpendCapFraction: 0.2, trigramSimilarityMax: 0.85,
    });

    const ctx = makeContext({
      failedApproaches: [{
        approach: 'edit',
        oracleVerdict: 'unknown',
        timestamp: Date.now(),
        classifiedFailures: [{ category: 'unknown', message: 'mystery', severity: 'error' }] as ClassifiedFailure[],
      }],
    });
    const outcome = await engine.generateAlternative(ctx);
    expect(outcome).not.toBeNull();
    expect(outcome!.tokensUsed).toBeGreaterThan(0); // LLM path
  });

  test('no failurePatternLibrary in deps → falls through to LLM', async () => {
    const engine = new DefaultReplanEngine(
      makeDeps({ failurePatternLibrary: undefined }),
      { enabled: true, maxReplans: 3, tokenSpendCapFraction: 0.2, trigramSimilarityMax: 0.85 },
    );

    const outcome = await engine.generateAlternative(makeContext());
    expect(outcome).not.toBeNull();
    expect(outcome!.tokensUsed).toBeGreaterThan(0); // LLM path
  });

  test('max-replans gate still fires before deterministic transform', async () => {
    const engine = new DefaultReplanEngine(makeDeps(), {
      enabled: true, maxReplans: 1, tokenSpendCapFraction: 0.2, trigramSimilarityMax: 0.85,
    });

    // iteration=1 >= maxReplans=1 → rejected
    const outcome = await engine.generateAlternative(makeContext({ iteration: 1 }));
    expect(outcome).toBeNull();
  });

  test('classifiedFailures are passed to FailureContext in LLM path', async () => {
    // When deterministic transform is not available, the LLM path should
    // still get classified failures in the FailureContext. We verify this
    // by checking the rewritten goal doesn't contain "Deterministic recovery"
    // but the decomposer.replan is called (which receives the failure context).
    let replanCalled = false;
    const engine = new DefaultReplanEngine(
      makeDeps({
        failurePatternLibrary: undefined,
        decomposer: {
          decompose: async () => ({ nodes: [] }),
          replan: async (_input, _perc, _mem, failure) => {
            replanCalled = true;
            expect(failure.classifiedFailures).toBeDefined();
            expect(failure.classifiedFailures!.length).toBe(1);
            expect(failure.classifiedFailures![0]!.category).toBe('type_error');
            return { nodes: [{ id: 'llm-plan', description: 'LLM', targetFiles: ['x.ts'], dependencies: [], assignedOracles: [] }] };
          },
        },
      }),
      { enabled: true, maxReplans: 3, tokenSpendCapFraction: 0.2, trigramSimilarityMax: 0.85 },
    );

    await engine.generateAlternative(makeContext());
    expect(replanCalled).toBe(true);
  });
});
