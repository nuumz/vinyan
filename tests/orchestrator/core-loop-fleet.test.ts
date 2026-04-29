/**
 * Core Loop Fleet Governance Tests — Gap #3 (I10 probation) and Gap #4 (uncertain).
 */
import { describe, expect, test } from 'bun:test';
import { createBus } from '../../src/core/bus.ts';
import type { OracleVerdict } from '../../src/core/types.ts';
import { executeTask, type OrchestratorDeps } from '../../src/orchestrator/core-loop.ts';
import type { EngineSelectionResult, TaskInput } from '../../src/orchestrator/types.ts';

const defaultInput: TaskInput = {
  id: 'task-fleet-1',
  source: 'cli',
  goal: 'refactor utility function',
  taskType: 'code',
  targetFiles: ['src/foo.ts'],
  budget: { maxTokens: 5000, maxDurationMs: 30000, maxRetries: 1 },
};

function buildBaseDeps(overrides?: Partial<OrchestratorDeps>): OrchestratorDeps {
  return {
    perception: {
      assemble: async () => ({
        taskTarget: { file: 'src/foo.ts', description: 'test' },
        dependencyCone: { directImporters: [], directImportees: [], transitiveBlastRadius: 1 },
        diagnostics: { lintWarnings: [], typeErrors: [], failingTests: [] },
        verifiedFacts: [],
        runtime: { nodeVersion: 'v18', os: 'darwin', availableTools: [] },
      }),
    },
    riskRouter: {
      assessInitialLevel: async () => ({
        level: 1 as const,
        model: 'mock/model',
        budgetTokens: 5000,
        latencyBudgetMs: 10000,
      }),
    },
    selfModel: {
      predict: async () => ({
        taskId: 'task-fleet-1',
        timestamp: Date.now(),
        expectedTestResults: 'pass' as const,
        expectedBlastRadius: 1,
        expectedDuration: 1000,
        expectedQualityScore: 0.8,
        uncertainAreas: [],
        confidence: 0.5,
        metaConfidence: 0.3,
        basis: 'static-heuristic' as const,
        calibrationDataPoints: 0,
      }),
    },
    decomposer: {
      decompose: async () => ({ nodes: [] }),
    },
    workerPool: {
      dispatch: async () => ({
        mutations: [{ file: 'src/foo.ts', content: 'ok', diff: '+ok', explanation: 'test' }],
        proposedToolCalls: [],
        tokensConsumed: 100,
        durationMs: 50,
      }),
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
    traceCollector: { record: async () => {} },
    bus: createBus(),
    explorationEpsilon: 0,
    ...overrides,
  };
}

describe('Gap #3: I10 Probation No-Commit', () => {
  test('probation worker result has no mutations and includes probation note', async () => {
    const shadowEnqueued: string[] = [];
    const deps = buildBaseDeps({
      workerStore: {
        findById: (id: string) => ({
          id,
          config: { modelId: 'mock', temperature: 0.7 },
          status: 'probation' as const,
          createdAt: Date.now(),
          demotionCount: 0,
        }),
      } as any,
      shadowRunner: {
        enqueue: (taskId: string) => {
          shadowEnqueued.push(taskId);
          return {
            id: 'sj-1',
            taskId,
            status: 'pending' as const,
            enqueuedAt: Date.now(),
            retryCount: 0,
            maxRetries: 1,
          };
        },
      } as any,
      riskRouter: {
        assessInitialLevel: async () => ({
          level: 1 as const,
          model: 'mock/model',
          budgetTokens: 5000,
          latencyBudgetMs: 10000,
          workerId: 'worker-probation',
        }),
      },
    });

    const result = await executeTask(defaultInput, deps);

    expect(result.status).toBe('completed');
    // Probation worker: mutations should be empty (not committed)
    expect(result.mutations).toHaveLength(0);
    expect(result.notes).toBeDefined();
    expect(result.notes!.some((n) => n.includes('probation'))).toBe(true);
    // Shadow should be enqueued for evaluation
    expect(shadowEnqueued).toContain('task-fleet-1');
  });

  test('active worker result has mutations (normal commit)', async () => {
    const deps = buildBaseDeps({
      workerStore: {
        findById: (id: string) => ({
          id,
          config: { modelId: 'mock', temperature: 0.7 },
          status: 'active' as const,
          createdAt: Date.now(),
          demotionCount: 0,
        }),
      } as any,
      riskRouter: {
        assessInitialLevel: async () => ({
          level: 1 as const,
          model: 'mock/model',
          budgetTokens: 5000,
          latencyBudgetMs: 10000,
          workerId: 'worker-active',
        }),
      },
    });

    const result = await executeTask(defaultInput, deps);

    expect(result.status).toBe('completed');
    expect(result.mutations.length).toBeGreaterThan(0);
    expect(result.notes).toBeUndefined();
  });
});

describe('Gap #4: Uncertain Abstention', () => {
  test('uncertain worker selection short-circuits dispatch', async () => {
    let dispatchCalled = false;
    const deps = buildBaseDeps({
      workerSelector: {
        selectWorker: () => ({
          selectedWorkerId: '',
          reason: 'uncertain' as const,
          score: 0,
          alternatives: [],
          explorationTriggered: false,
          dataGateMet: true,
          maxCapability: 0.15,
          isUncertain: true,
        }),
      } as any,
      workerPool: {
        dispatch: async () => {
          dispatchCalled = true;
          return { mutations: [], proposedToolCalls: [], tokensConsumed: 0, durationMs: 0 };
        },
      },
      riskRouter: {
        assessInitialLevel: async () => ({
          level: 1 as const,
          model: 'mock/model',
          budgetTokens: 5000,
          latencyBudgetMs: 10000,
          // No workerId — let workerSelector decide
        }),
      },
    });

    const result = await executeTask(defaultInput, deps);

    expect(result.status).toBe('uncertain');
    expect(result.mutations).toHaveLength(0);
    expect(result.notes).toBeDefined();
    expect(result.notes!.some((n) => n.includes('A2'))).toBe(true);
    // Worker dispatch should NOT have been called
    expect(dispatchCalled).toBe(false);
  });
});

describe('Gap #2: workerSelectionAudit on all trace paths', () => {
  test('escalation trace includes workerSelectionAudit', async () => {
    const traces: any[] = [];
    let _selectionCallCount = 0;
    const mockSelection: EngineSelectionResult = {
      selectedWorkerId: 'w1',
      reason: 'capability-score',
      score: 0.8,
      alternatives: [],
      explorationTriggered: false,
      dataGateMet: true,
    };
    const deps = buildBaseDeps({
      workerSelector: {
        selectWorker: () => {
          _selectionCallCount++;
          return mockSelection;
        },
      } as any,
      traceCollector: {
        record: async (t: any) => {
          traces.push(t);
        },
      },
      // Verification always fails → escalation after exhausting retries + levels
      oracleGate: {
        verify: async () => ({
          passed: false,
          verdicts: {},
          reason: 'forced-fail',
        }),
      },
      riskRouter: {
        assessInitialLevel: async () => ({
          level: 3 as const, // start at max level — will exhaust immediately
          model: 'mock/model',
          budgetTokens: 5000,
          latencyBudgetMs: 10000,
        }),
      },
    });

    const result = await executeTask(defaultInput, deps);
    expect(result.status).toBe('escalated');

    // The escalation trace should include workerSelectionAudit from the last selection
    const escalationTrace = traces.find((t) => t.outcome === 'escalated');
    expect(escalationTrace).toBeDefined();
    expect(escalationTrace.workerSelectionAudit).toEqual(mockSelection);
  });
});

// A8 broader provenance (2026-04-28): escalationPath must accumulate across
// re-routes (L0 → L1 → L2 → L3), not just contain the final level. Without
// this, the trace's governance envelope can't answer "how did we get here?".
describe('A8 escalationPath accumulation across re-routes', () => {
  test('all-levels-exhausted trace records cumulative escalation path', async () => {
    const traces: any[] = [];
    let assessCallCount = 0;
    const deps = buildBaseDeps({
      traceCollector: { record: async (t: any) => { traces.push(t); } },
      // Force every iteration to fail verification → outer loop escalates each time
      oracleGate: {
        verify: async () => ({ passed: false, verdicts: {}, reason: 'forced-fail' }),
      },
      // Each call returns the level requested via MIN_ROUTING_LEVEL constraint
      // and stamps a minimal governance envelope so core-loop has something to
      // chain into.
      riskRouter: {
        assessInitialLevel: async (input: TaskInput) => {
          assessCallCount++;
          const minConstraint = (input.constraints ?? []).find((c) => c.startsWith('MIN_ROUTING_LEVEL:'));
          const level = minConstraint ? Number(minConstraint.split(':')[1]) : 0;
          return {
            level: level as 0 | 1 | 2 | 3,
            model: 'mock/model',
            budgetTokens: 5000,
            latencyBudgetMs: 10000,
            governanceProvenance: {
              decisionId: `risk-router:${input.id}:L${level}`,
              policyVersion: 'risk-router:v1',
              attributedTo: 'riskRouter',
              wasGeneratedBy: 'mock',
              wasDerivedFrom: [],
              decidedAt: Date.now(),
              reason: `routed to L${level}`,
            },
          };
        },
      },
    });

    const result = await executeTask({ ...defaultInput, id: 'task-escalation-path' }, deps);
    expect(result.status).toBe('escalated');

    // assessInitialLevel called: once initial + once per escalation step
    expect(assessCallCount).toBeGreaterThan(1);

    const escalated = traces.find((t) => t.outcome === 'escalated');
    expect(escalated).toBeDefined();
    expect(escalated.governanceProvenance).toBeDefined();
    const path = escalated.governanceProvenance.escalationPath;
    expect(path).toBeDefined();
    expect(Array.isArray(path)).toBe(true);
    // Must accumulate at least 2 levels (started at L0, escalated at least once
    // before all-levels-exhausted). Strictly increasing.
    expect(path.length).toBeGreaterThanOrEqual(2);
    for (let i = 1; i < path.length; i++) {
      expect(path[i]).toBeGreaterThan(path[i - 1]);
    }
    // Last element matches the final routing level.
    expect(path[path.length - 1]).toBe(escalated.routingLevel);
    // Reason should mention the escalation transition.
    expect(escalated.governanceProvenance.reason).toMatch(/escalated from L\d/);
  });
});
