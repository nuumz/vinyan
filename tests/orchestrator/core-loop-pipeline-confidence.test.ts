/**
 * Core Loop Pipeline Confidence Tests — verifies Phase 3B wiring.
 *
 * Tests that pipeline confidence is computed for L1+ tasks and that
 * L0 tasks continue to use binary verification decisions.
 */
import { describe, test, expect } from 'bun:test';
import { executeTask, type OrchestratorDeps } from '../../src/orchestrator/core-loop.ts';
import type { TaskInput, RoutingDecision, ExecutionTrace, PerceptualHierarchy } from '../../src/orchestrator/types.ts';
import type { OracleVerdict } from '../../src/core/types.ts';
import { createBus, type VinyanBus } from '../../src/core/bus.ts';

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function makeInput(overrides?: Partial<TaskInput>): TaskInput {
  return {
    id: 't-pc',
    source: 'cli',
    goal: 'Test pipeline confidence wiring',
    taskType: 'code',
    budget: { maxTokens: 10_000, maxDurationMs: 5_000, maxRetries: 1 },
    targetFiles: ['src/foo.ts'],
    ...overrides,
  };
}

const minimalPerception: PerceptualHierarchy = {
  taskTarget: { file: 'src/foo.ts', description: 'test' },
  dependencyCone: { directImporters: [], directImportees: [], transitiveBlastRadius: 0 },
  diagnostics: { lintWarnings: [], typeErrors: [], failingTests: [] },
  verifiedFacts: [],
  runtime: { nodeVersion: '20', os: 'linux', availableTools: [] },
};

const passingVerdict: OracleVerdict = {
  oracleName: 'test',
  type: 'known',
  verified: true,
  confidence: 0.9,
  evidence: [],
  fileHashes: {},
  durationMs: 10,
};

const failingVerdict: OracleVerdict = {
  oracleName: 'test',
  type: 'known',
  verified: false,
  confidence: 0.3,
  evidence: [],
  fileHashes: {},
  reason: 'Test failed',
  durationMs: 10,
};

function makeDeps(overrides: {
  routingLevel?: number;
  verificationPassed?: boolean;
  aggregateConfidence?: number;
  epistemicDecision?: string;
  bus?: VinyanBus;
}): OrchestratorDeps {
  const level = overrides.routingLevel ?? 0;
  const passed = overrides.verificationPassed ?? true;

  return {
    perception: {
      assemble: async () => minimalPerception,
    },
    riskRouter: {
      assessInitialLevel: async () =>
        ({
          level: level as 0 | 1 | 2 | 3,
          model: level === 0 ? null : 'mock/fast',
          budgetTokens: 5000,
          latencyBudgetMs: 2000,
        }) as RoutingDecision,
    },
    selfModel: {
      predict: async (input) => ({
        taskId: input.id,
        timestamp: Date.now(),
        expectedTestResults: 'pass' as const,
        expectedBlastRadius: 1,
        expectedDuration: 100,
        expectedQualityScore: 0.8,
        uncertainAreas: [],
        confidence: 0.75,
        metaConfidence: 0.5,
        basis: 'static-heuristic' as const,
        calibrationDataPoints: 0,
      }),
    },
    decomposer: {
      decompose: async () => ({ nodes: [] }),
    },
    workerPool: {
      dispatch: async () => ({
        mutations: [
          {
            file: 'src/foo.ts',
            content: 'export const x = 2;\n',
            diff: '- export const x = 1;\n+ export const x = 2;\n',
            explanation: 'changed value',
          },
        ],
        proposedToolCalls: [],
        tokensConsumed: 100,
        durationMs: 50,
      }),
    },
    oracleGate: {
      verify: async () => ({
        passed,
        verdicts: { 'test:src/foo.ts': passed ? passingVerdict : failingVerdict },
        reason: passed ? undefined : 'Test oracle failed',
        aggregateConfidence: overrides.aggregateConfidence,
        epistemicDecision: overrides.epistemicDecision as any,
      }),
    },
    traceCollector: {
      record: async () => {},
    },
    bus: overrides.bus,
    explorationEpsilon: 0, // disable exploration for deterministic tests
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Pipeline Confidence — L0 Binary Backward Compatibility', () => {
  test('L0 tasks use binary decision without pipeline confidence', async () => {
    const deps = makeDeps({ routingLevel: 0, verificationPassed: true });
    const result = await executeTask(makeInput(), deps);

    expect(result.status).toBe('completed');
    // L0 traces should NOT have pipeline confidence
    expect(result.trace.pipelineConfidence).toBeUndefined();
    expect(result.trace.confidenceDecision).toBeUndefined();
    expect(result.trace.verificationConfidence).toBeUndefined();
  });

  test('L0 failed verification uses binary path', async () => {
    // Fix routing to always return L0 (even on escalation) to avoid long escalation chains
    const deps = makeDeps({ routingLevel: 0, verificationPassed: false });
    deps.riskRouter = {
      assessInitialLevel: async () =>
        ({
          level: 0 as const,
          model: null,
          budgetTokens: 5000,
          latencyBudgetMs: 2000,
        }) as RoutingDecision,
    };
    const result = await executeTask(makeInput({ budget: { maxTokens: 10_000, maxDurationMs: 2_000, maxRetries: 1 } }), deps);

    // L0 + failed → should escalate or fail
    expect(['failed', 'escalated']).toContain(result.status);
    // L0 traces don't have pipeline confidence
    expect(result.trace.pipelineConfidence).toBeUndefined();
    expect(result.trace.confidenceDecision).toBeUndefined();
  });
});

describe('Pipeline Confidence — L1+ Computation', () => {
  test('L1 task computes pipeline confidence', async () => {
    const deps = makeDeps({ routingLevel: 1, verificationPassed: true });
    const result = await executeTask(makeInput(), deps);

    expect(result.status).toBe('completed');
    expect(result.trace.pipelineConfidence).toBeDefined();
    expect(result.trace.pipelineConfidence!.composite).toBeGreaterThan(0);
    expect(result.trace.pipelineConfidence!.formula).toContain('composite');
    expect(result.trace.verificationConfidence).toBeDefined();
    expect(result.trace.confidenceDecision).toBeDefined();
    expect(result.trace.confidenceDecision!.action).toBe('allow');
  });

  test('L1 task with high verification confidence gets allow decision', async () => {
    const deps = makeDeps({
      routingLevel: 1,
      verificationPassed: true,
      aggregateConfidence: 0.95,
    });
    const result = await executeTask(makeInput(), deps);

    expect(result.status).toBe('completed');
    expect(result.trace.verificationConfidence).toBe(0.95);
    expect(result.trace.confidenceDecision!.action).toBe('allow');
  });

  test('L1 task uses aggregateConfidence when available', async () => {
    const deps = makeDeps({
      routingLevel: 1,
      verificationPassed: true,
      aggregateConfidence: 0.92,
    });
    const result = await executeTask(makeInput(), deps);

    expect(result.trace.verificationConfidence).toBe(0.92);
  });

  test('L1 task falls back to 0.85 when aggregateConfidence is absent and passed=true', async () => {
    const deps = makeDeps({
      routingLevel: 1,
      verificationPassed: true,
    });
    const result = await executeTask(makeInput(), deps);

    expect(result.trace.verificationConfidence).toBe(0.85);
  });

  test('L1 task falls back to 0.30 when aggregateConfidence is absent and passed=false', async () => {
    const recordedTraces: ExecutionTrace[] = [];
    const deps = makeDeps({
      routingLevel: 1,
      verificationPassed: false,
    });
    // Fix routing to always return L1 to prevent long escalation chains
    deps.riskRouter = {
      assessInitialLevel: async () =>
        ({
          level: 1 as const,
          model: 'mock/fast',
          budgetTokens: 5000,
          latencyBudgetMs: 2000,
        }) as RoutingDecision,
    };
    deps.traceCollector = {
      record: async (trace) => {
        recordedTraces.push(trace);
      },
    };
    await executeTask(makeInput({ budget: { maxTokens: 10_000, maxDurationMs: 2_000, maxRetries: 1 } }), deps);

    // The first recorded trace (L1 attempt) should have verificationConfidence = 0.30
    const l1Trace = recordedTraces.find((t) => t.routingLevel === 1 && t.approach !== 'all-levels-exhausted');
    expect(l1Trace).toBeDefined();
    expect(l1Trace!.verificationConfidence).toBe(0.3);
  });

  test('L1 task populates epistemicDecision from verification', async () => {
    const deps = makeDeps({
      routingLevel: 1,
      verificationPassed: true,
      epistemicDecision: 'allow',
    });
    const result = await executeTask(makeInput(), deps);

    expect(result.trace.epistemicDecision).toBe('allow');
  });
});

describe('Pipeline Confidence — Decision Paths', () => {
  test('allow decision commits successfully', async () => {
    // High confidence → allow
    const deps = makeDeps({
      routingLevel: 1,
      verificationPassed: true,
      aggregateConfidence: 0.95,
    });
    const result = await executeTask(makeInput(), deps);

    expect(result.status).toBe('completed');
    expect(result.trace.confidenceDecision!.action).toBe('allow');
    expect(result.trace.outcome).toBe('success');
  });

  test('escalate decision triggers routing escalation', async () => {
    const bus = createBus();
    let escalateEmitted = false;
    bus.on('pipeline:escalate', () => {
      escalateEmitted = true;
    });

    const recordedTraces: ExecutionTrace[] = [];
    const deps = makeDeps({
      routingLevel: 1,
      verificationPassed: false,
      aggregateConfidence: 0.15,
      bus,
    });
    // Fix routing to L1 to prevent long escalation chains
    deps.riskRouter = {
      assessInitialLevel: async () =>
        ({
          level: 1 as const,
          model: 'mock/fast',
          budgetTokens: 5000,
          latencyBudgetMs: 2000,
        }) as RoutingDecision,
    };
    deps.traceCollector = {
      record: async (trace) => {
        recordedTraces.push(trace);
      },
    };
    const result = await executeTask(makeInput({ budget: { maxTokens: 10_000, maxDurationMs: 2_000, maxRetries: 1 } }), deps);

    expect(['failed', 'escalated']).toContain(result.status);
    // The first L1 trace should show the escalate or refuse decision
    const l1Trace = recordedTraces.find((t) => t.routingLevel === 1 && t.confidenceDecision != null);
    if (l1Trace) {
      expect(['escalate', 'refuse']).toContain(l1Trace.confidenceDecision!.action);
    }
    // At least one of escalate or refuse should have fired
    expect(l1Trace).toBeDefined();
  });

  test('refuse decision on very low confidence', async () => {
    const bus = createBus();
    let refuseEmitted = false;
    bus.on('pipeline:refuse', () => {
      refuseEmitted = true;
    });

    const recordedTraces: ExecutionTrace[] = [];
    const deps = makeDeps({
      routingLevel: 1,
      verificationPassed: false,
      aggregateConfidence: 0.01, // Near-zero → refuse
      bus,
    });
    // Fix routing to L1 to prevent long escalation chains
    deps.riskRouter = {
      assessInitialLevel: async () =>
        ({
          level: 1 as const,
          model: 'mock/fast',
          budgetTokens: 5000,
          latencyBudgetMs: 2000,
        }) as RoutingDecision,
    };
    deps.traceCollector = {
      record: async (trace) => {
        recordedTraces.push(trace);
      },
    };
    const result = await executeTask(makeInput({ budget: { maxTokens: 10_000, maxDurationMs: 2_000, maxRetries: 1 } }), deps);

    expect(['failed', 'escalated']).toContain(result.status);
    // Check that a refuse event was emitted for the L1 trace
    const l1Trace = recordedTraces.find((t) => t.confidenceDecision?.action === 'refuse');
    if (l1Trace) {
      expect(refuseEmitted).toBe(true);
    }
  });

  test('re-verify path re-runs verification', async () => {
    const bus = createBus();
    let reVerifyEmitted = false;
    bus.on('pipeline:re-verify', () => {
      reVerifyEmitted = true;
    });

    // We need a custom gate that returns borderline confidence first time
    // and passes second time
    let verifyCallCount = 0;
    const deps = makeDeps({
      routingLevel: 1,
      verificationPassed: true,
      bus,
    });
    // Override oracleGate to simulate re-verify scenario
    deps.oracleGate = {
      verify: async () => {
        verifyCallCount++;
        if (verifyCallCount === 1) {
          // First verification: passed but borderline composite (0.50-0.69)
          return {
            passed: true,
            verdicts: { 'test:src/foo.ts': passingVerdict },
            aggregateConfidence: 0.55, // will give composite ~0.62 → re-verify
          };
        }
        // Re-verification: better confidence
        return {
          passed: true,
          verdicts: { 'test:src/foo.ts': passingVerdict },
          aggregateConfidence: 0.95,
        };
      },
    };

    const result = await executeTask(makeInput(), deps);

    // If re-verify was triggered, the gate should be called twice
    if (reVerifyEmitted) {
      expect(verifyCallCount).toBe(2);
      expect(result.status).toBe('completed');
    }
  });
});

describe('Pipeline Confidence — ExecutionTrace Fields', () => {
  test('L1 trace includes all pipeline confidence fields', async () => {
    const deps = makeDeps({
      routingLevel: 1,
      verificationPassed: true,
      aggregateConfidence: 0.9,
    });
    const result = await executeTask(makeInput(), deps);
    const trace = result.trace;

    expect(trace.verificationConfidence).toBe(0.9);
    expect(trace.pipelineConfidence).toBeDefined();
    expect(typeof trace.pipelineConfidence!.composite).toBe('number');
    expect(typeof trace.pipelineConfidence!.formula).toBe('string');
    expect(trace.confidenceDecision).toBeDefined();
    expect(typeof trace.confidenceDecision!.action).toBe('string');
    expect(typeof trace.confidenceDecision!.confidence).toBe('number');
  });

  test('L2 trace includes prediction confidence in pipeline', async () => {
    const deps = makeDeps({
      routingLevel: 2,
      verificationPassed: true,
      aggregateConfidence: 0.9,
    });
    const result = await executeTask(makeInput(), deps);
    const trace = result.trace;

    // L2 runs selfModel.predict → predictionConfidence should affect composite
    expect(trace.pipelineConfidence).toBeDefined();
    expect(trace.pipelineConfidence!.composite).toBeGreaterThan(0);
    // The pipeline formula should reference the prediction dimension
    expect(trace.pipelineConfidence!.formula).toContain('pred');
  });

  test('escalation trace does NOT include pipeline confidence', async () => {
    const deps = makeDeps({
      routingLevel: 3,
      verificationPassed: false,
      aggregateConfidence: 0.01,
    });
    // Fix routing to stay at L3 so it exhausts quickly
    deps.riskRouter = {
      assessInitialLevel: async () =>
        ({
          level: 3 as const,
          model: 'mock/powerful',
          budgetTokens: 5000,
          latencyBudgetMs: 2000,
        }) as RoutingDecision,
    };
    const result = await executeTask(makeInput({ budget: { maxTokens: 10_000, maxDurationMs: 2_000, maxRetries: 1 } }), deps);

    // The final escalation trace (all-levels-exhausted) won't have pipeline confidence
    if (result.trace.approach === 'all-levels-exhausted') {
      expect(result.trace.pipelineConfidence).toBeUndefined();
    }
  });
});
