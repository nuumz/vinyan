/**
 * Tests for K1.1 Contradiction Escalation in core-loop.
 *
 * Verifies that oracle contradictions (some pass, some fail) trigger
 * auto-escalation to the next routing level (A1 compliance).
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createBus, type VinyanBus } from '../../src/core/bus.ts';
import type { OracleVerdict } from '../../src/core/types.ts';
import { executeTask, type OrchestratorDeps } from '../../src/orchestrator/core-loop.ts';
import type { ExecutionTrace, PerceptualHierarchy, RoutingDecision, TaskInput } from '../../src/orchestrator/types.ts';

function makeInput(overrides: Partial<TaskInput> = {}): TaskInput {
  return {
    id: 't-contradiction',
    source: 'cli',
    goal: 'Verify contradiction escalation',
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

function makeVerdict(oracleName: string, verified: boolean): OracleVerdict {
  return {
    oracleName,
    type: 'known',
    verified,
    confidence: verified ? 0.9 : 0.2,
    evidence: [],
    fileHashes: {},
    reason: verified ? undefined : `${oracleName} failed`,
    durationMs: 10,
  };
}

function makeDeps(args: {
  routingLevel: RoutingDecision['level'];
  verdicts: Record<string, OracleVerdict>;
  recordedTraces?: ExecutionTrace[];
}): OrchestratorDeps {
  return {
    perception: { assemble: async () => minimalPerception },
    riskRouter: {
      assessInitialLevel: async () => ({
        level: args.routingLevel,
        model: args.routingLevel === 0 ? null : 'mock/fast',
        budgetTokens: 5000,
        latencyBudgetMs: 2000,
      }),
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
    decomposer: { decompose: async () => ({ nodes: [] }) },
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
        passed: Object.values(args.verdicts).every((verdict) => verdict.verified),
        verdicts: args.verdicts,
        reason: 'mixed oracle verdicts',
        aggregateConfidence: 0.2,
      }),
    },
    traceCollector: {
      record: async (trace) => {
        args.recordedTraces?.push(trace);
      },
    },
    explorationEpsilon: 0,
  };
}

describe('Contradiction Escalation Events', () => {
  let bus: VinyanBus;
  const events: Array<{ event: string; data: unknown }> = [];

  beforeEach(() => {
    bus = createBus();
    events.length = 0;

    bus.on('verification:contradiction_escalated', (data) => {
      events.push({ event: 'contradiction_escalated', data });
    });
    bus.on('verification:contradiction_unresolved', (data) => {
      events.push({ event: 'contradiction_unresolved', data });
    });
    bus.on('task:escalate', (data) => {
      events.push({ event: 'task:escalate', data });
    });
    bus.on('oracle:contradiction', (data) => {
      events.push({ event: 'oracle:contradiction', data });
    });
  });

  test('contradiction_escalated event carries fromLevel and toLevel', () => {
    bus.emit('verification:contradiction_escalated', {
      taskId: 'test-1',
      fromLevel: 1,
      toLevel: 2,
      passed: ['ast'],
      failed: ['type'],
    });

    expect(events).toHaveLength(1);
    const data = events[0]!.data as { fromLevel: number; toLevel: number; passed: string[]; failed: string[] };
    expect(data.fromLevel).toBe(1);
    expect(data.toLevel).toBe(2);
    expect(data.passed).toEqual(['ast']);
    expect(data.failed).toEqual(['type']);
  });

  test('contradiction_unresolved event (L3, nowhere to escalate)', () => {
    bus.emit('verification:contradiction_unresolved', {
      taskId: 'test-2',
      passed: ['ast', 'dep'],
      failed: ['type'],
    });

    expect(events).toHaveLength(1);
    const data = events[0]!.data as { passed: string[]; failed: string[] };
    expect(data.passed).toContain('ast');
    expect(data.failed).toContain('type');
  });

  test('oracle:contradiction fires for mixed verdicts', () => {
    bus.emit('oracle:contradiction', {
      taskId: 'test-3',
      passed: ['ast'],
      failed: ['type', 'test'],
    });

    expect(events).toHaveLength(1);
    expect(events[0]!.event).toBe('oracle:contradiction');
  });

  test('L3 unresolved contradiction trace carries replayable oracle-pair provenance', async () => {
    const recordedTraces: ExecutionTrace[] = [];
    const result = await executeTask(
      makeInput(),
      makeDeps({
        routingLevel: 3,
        verdicts: {
          ast: makeVerdict('ast', true),
          type: makeVerdict('type', false),
        },
        recordedTraces,
      }),
    );

    const contradictionTrace = recordedTraces.find((trace) => trace.approach === 'contradiction-unresolved');
    expect(result.status).toBe('failed');
    expect(contradictionTrace?.governanceProvenance).toMatchObject({
      attributedTo: 'verificationPolicy',
      wasGeneratedBy: 'executeVerifyPhase',
    });
    expect(contradictionTrace?.governanceProvenance?.decisionId).toContain('contradiction-unresolved');
    expect(contradictionTrace?.governanceProvenance?.wasDerivedFrom).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: 'oracle-contradiction-pair',
          summary: expect.stringContaining('passed=ast; failed=type'),
        }),
      ]),
    );
  });

  test('L0-pinned oracle rejection records constraint source in provenance', async () => {
    const result = await executeTask(
      makeInput({ constraints: ['MIN_ROUTING_LEVEL:0'] }),
      makeDeps({
        routingLevel: 0,
        verdicts: {
          type: makeVerdict('type', false),
        },
      }),
    );

    expect(result.status).toBe('escalated');
    expect(result.trace.approach).toBe('oracle-rejection-l0');
    expect(result.trace.governanceProvenance).toMatchObject({
      attributedTo: 'verificationPolicy',
      wasGeneratedBy: 'executeVerifyPhase',
    });
    expect(result.trace.governanceProvenance?.decisionId).toContain('oracle-rejection-l0-pinned');
    expect(result.trace.governanceProvenance?.reason).toContain('MIN_ROUTING_LEVEL:0 prevents automatic escalation');
    expect(result.trace.governanceProvenance?.wasDerivedFrom).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: 'input.constraints', summary: 'MIN_ROUTING_LEVEL:0 set by caller' }),
        expect.objectContaining({ source: 'oracle-contradiction-pair', summary: expect.stringContaining('failed=type') }),
      ]),
    );
  });
});
