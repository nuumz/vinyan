import { describe, expect, test } from 'bun:test';
import type { OracleVerdict } from '../../src/core/types.ts';
import { executeTask, type OrchestratorDeps } from '../../src/orchestrator/core-loop.ts';
import type {
  EvolutionaryRule,
  ExecutionTrace,
  PerceptualHierarchy,
  RoutingDecision,
  RoutingLevel,
  SelfModelPrediction,
  TaskDAG,
  TaskInput,
  WorkingMemoryState,
} from '../../src/orchestrator/types.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const defaultInput: TaskInput = {
  id: 'task-1',
  source: 'cli',
  goal: 'test rule action types',
  targetFiles: ['src/foo.ts'],
  budget: { maxTokens: 5000, maxDurationMs: 10000, maxRetries: 1 },
};

const defaultPerception: PerceptualHierarchy = {
  taskTarget: { file: 'src/foo.ts', description: 'test' },
  dependencyCone: { directImporters: [], directImportees: [], transitiveBlastRadius: 0 },
  diagnostics: { lintWarnings: [], typeErrors: [], failingTests: [] },
  verifiedFacts: [],
  runtime: { nodeVersion: '', os: '', availableTools: [] },
};

function makeRule(action: EvolutionaryRule['action'], parameters: Record<string, unknown>): EvolutionaryRule {
  return {
    id: `rule-${action}`,
    source: 'sleep-cycle',
    condition: { filePattern: 'src/foo.ts' },
    action,
    parameters,
    status: 'active',
    createdAt: Date.now(),
    effectiveness: 0.8,
    specificity: 1,
  };
}

/** Capture the routing decision seen by workerPool.dispatch */
function buildDeps(rules: EvolutionaryRule[]): {
  deps: OrchestratorDeps;
  capturedRouting: () => RoutingDecision | undefined;
} {
  let captured: RoutingDecision | undefined;

  const deps: OrchestratorDeps = {
    perception: {
      assemble: async () => defaultPerception,
    },
    riskRouter: {
      assessInitialLevel: async () => ({
        level: 1 as RoutingLevel,
        model: 'default-model',
        budgetTokens: 5000,
        latencyBudgetMs: 10000,
      }),
    },
    selfModel: {
      predict: async () =>
        ({
          taskId: 'task-1',
          timestamp: Date.now(),
          expectedTestResults: 'pass',
          expectedBlastRadius: 1,
          expectedDuration: 1000,
          expectedQualityScore: 0.8,
          uncertainAreas: [],
          confidence: 0.5,
          metaConfidence: 0.3,
          basis: 'static-heuristic',
          calibrationDataPoints: 0,
        }) satisfies SelfModelPrediction,
    },
    decomposer: {
      decompose: async () => ({ nodes: [], edges: [] }) as unknown as TaskDAG,
    },
    workerPool: {
      dispatch: async (_input, _perc, _mem, _plan, routing) => {
        captured = routing;
        return {
          mutations: [{ file: 'src/foo.ts', content: 'ok', diff: '+ok', explanation: 'test' }],
          proposedToolCalls: [],
          tokensConsumed: 100,
          durationMs: 50,
        };
      },
    },
    oracleGate: {
      verify: async () => ({
        passed: true,
        verdicts: {
          ast: {
            verified: true,
            confidence: 1,
            evidence: [],
            type: 'known',
            fileHashes: {},
            durationMs: 0,
          } as OracleVerdict,
        },
      }),
    },
    traceCollector: {
      record: async () => {},
    },
    ruleStore: {
      findMatching: () => rules,
      findActive: () => rules,
      findByStatus: () => [],
      insert: () => {},
      activate: () => {},
      retire: () => {},
      updateEffectiveness: () => {},
    } as any,
  };

  return { deps, capturedRouting: () => captured };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Evolution Rule Action Types (P3.0 Gap 4)', () => {
  test('escalate: increases routing level', async () => {
    const rules = [makeRule('escalate', { toLevel: 2 })];
    const { deps, capturedRouting } = buildDeps(rules);

    await executeTask(defaultInput, deps);

    expect(capturedRouting()!.level).toBe(2);
  });

  test('require-oracle: adds mandatory oracle to routing', async () => {
    const rules = [makeRule('require-oracle', { oracleName: 'test' })];
    const { deps, capturedRouting } = buildDeps(rules);

    await executeTask(defaultInput, deps);

    expect(capturedRouting()!.mandatoryOracles).toContain('test');
  });

  test('prefer-model: overrides model selection', async () => {
    const rules = [makeRule('prefer-model', { preferredModel: 'claude-opus' })];
    const { deps, capturedRouting } = buildDeps(rules);

    await executeTask(defaultInput, deps);

    expect(capturedRouting()!.model).toBe('claude-opus');
  });

  test('adjust-threshold: sets risk threshold override', async () => {
    const rules = [makeRule('adjust-threshold', { riskThreshold: 0.3 })];
    const { deps, capturedRouting } = buildDeps(rules);

    await executeTask(defaultInput, deps);

    expect(capturedRouting()!.riskThresholdOverride).toBe(0.3);
  });

  test('multiple rule types applied simultaneously', async () => {
    const rules = [
      makeRule('require-oracle', { oracleName: 'type' }),
      makeRule('prefer-model', { preferredModel: 'claude-sonnet' }),
      makeRule('adjust-threshold', { riskThreshold: 0.5 }),
    ];
    const { deps, capturedRouting } = buildDeps(rules);

    await executeTask(defaultInput, deps);

    const r = capturedRouting()!;
    expect(r.mandatoryOracles).toContain('type');
    expect(r.model).toBe('claude-sonnet');
    expect(r.riskThresholdOverride).toBe(0.5);
  });

  test('invalid parameter types are ignored gracefully', async () => {
    const rules = [
      makeRule('require-oracle', { oracleName: 42 }), // should be string
      makeRule('prefer-model', { preferredModel: null }), // should be string
      makeRule('adjust-threshold', { riskThreshold: 'high' }), // should be number
    ];
    const { deps, capturedRouting } = buildDeps(rules);

    await executeTask(defaultInput, deps);

    const r = capturedRouting()!;
    expect(r.mandatoryOracles).toBeUndefined();
    expect(r.model).toBe('default-model'); // unchanged from initial
    expect(r.riskThresholdOverride).toBeUndefined();
  });
});
