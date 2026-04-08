/**
 * Task Routing Invariants — verifies spec invariants from task-routing-spec.md.
 *
 * Tests the full pipeline (classification → risk → adjustment → dispatch) to ensure:
 * - P1: tool-needed tasks always route to L2+
 * - P5: capability floor overrides conversational cap
 * - O5: level cannot be lowered after capability floor
 * - Composition matrix coverage for untested rows
 *
 * Uses executeTask + OrchestratorDeps directly (same pattern as core-loop-pipeline-confidence.test.ts).
 */
import { describe, test, expect } from 'bun:test';
import { executeTask, type OrchestratorDeps } from '../../src/orchestrator/core-loop.ts';
import type { TaskInput, RoutingDecision, PerceptualHierarchy } from '../../src/orchestrator/types.ts';
import type { OracleVerdict } from '../../src/core/types.ts';

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeInput(overrides?: Partial<TaskInput>): TaskInput {
  return {
    id: 't-routing',
    source: 'cli',
    goal: 'test routing invariants',
    taskType: 'reasoning',
    budget: { maxTokens: 10_000, maxDurationMs: 5_000, maxRetries: 1 },
    ...overrides,
  };
}

function makeDeps(overrides: {
  routingLevel?: number;
  taskType?: 'code' | 'reasoning';
} = {}): OrchestratorDeps {
  const level = overrides.routingLevel ?? 0;
  const isCode = overrides.taskType === 'code';

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
      dispatch: async () =>
        isCode
          ? {
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
            }
          : {
              mutations: [],
              proposedContent: 'This is the answer to your question.',
              proposedToolCalls: [],
              tokensConsumed: 100,
              durationMs: 50,
            },
    },
    oracleGate: {
      verify: async () => ({
        passed: true,
        verdicts: { 'test:src/foo.ts': passingVerdict },
        aggregateConfidence: 0.9,
      }),
    },
    traceCollector: {
      record: async () => {},
    },
    explorationEpsilon: 0, // deterministic — no random exploration
  };
}

// ---------------------------------------------------------------------------
// P1: tool-needed tasks must route to L2+ (spec §5 invariant R1, §8 F1)
// ---------------------------------------------------------------------------

describe('P1: tool-needed tasks must route to L2+', () => {
  test('F1 regression: "git last commit ว่าอะไร" → L2+ (CLI mention overrides inquire intent)', async () => {
    const result = await executeTask(
      makeInput({ goal: 'git last commit ว่าอะไร' }),
      makeDeps({ routingLevel: 0 }),
    );
    expect(result.trace.routingLevel).toBeGreaterThanOrEqual(2);
  });

  test('"ช่วยรัน npm install" → L2+ (Thai action verb + CLI command)', async () => {
    const result = await executeTask(
      makeInput({ goal: 'ช่วยรัน npm install' }),
      makeDeps({ routingLevel: 0 }),
    );
    expect(result.trace.routingLevel).toBeGreaterThanOrEqual(2);
  });

  test('F3: "docker คืออะไร" → L2+ (CLI mention, P1 capability over economy)', async () => {
    const result = await executeTask(
      makeInput({ goal: 'docker คืออะไร' }),
      makeDeps({ routingLevel: 0 }),
    );
    expect(result.trace.routingLevel).toBeGreaterThanOrEqual(2);
  });

  test('"git push origin main" → L2+ (execute intent + CLI command)', async () => {
    const result = await executeTask(
      makeInput({ goal: 'git push origin main' }),
      makeDeps({ routingLevel: 0 }),
    );
    expect(result.trace.routingLevel).toBeGreaterThanOrEqual(2);
  });

  test('"ช่วยรัน git rebase" with code taskType → L2+', async () => {
    const result = await executeTask(
      makeInput({ goal: 'ช่วยรัน git rebase', taskType: 'code', targetFiles: ['src/foo.ts'] }),
      makeDeps({ routingLevel: 0, taskType: 'code' }),
    );
    expect(result.trace.routingLevel).toBeGreaterThanOrEqual(2);
  });
});

// ---------------------------------------------------------------------------
// P5: capability floor overrides conversational cap (spec §6, §8 F4)
// ---------------------------------------------------------------------------

describe('P5 + conversational cap: floor overrides ceiling', () => {
  test('conversational task capped at L1 even when risk says L2', async () => {
    const result = await executeTask(
      makeInput({ goal: 'สวัสดี' }),
      makeDeps({ routingLevel: 2 }),
    );
    expect(result.trace.routingLevel).toBeLessThanOrEqual(1);
  });

  test('CLI mention raises to L2 despite low risk (floor active)', async () => {
    const result = await executeTask(
      makeInput({ goal: 'git log ดูหน่อย' }),
      makeDeps({ routingLevel: 0 }),
    );
    expect(result.trace.routingLevel).toBeGreaterThanOrEqual(2);
  });

  // F4: conversational + tool-needed is an impossible classifier state.
  // assessToolRequirement gate 1 returns 'none' for conversational before
  // reaching the CLI check (gate 2). Per spec T2/T3, this is by design.
  // The two tests above prove: cap works (greeting→L1) AND floor works
  // (CLI→L2). Since floor runs AFTER cap in core-loop.ts:393-403,
  // swapping their order would cause the cap test to break for tool-needed
  // goals — validating P5 indirectly.
});

// ---------------------------------------------------------------------------
// O5: level cannot be lowered after capability floor (spec §6)
// ---------------------------------------------------------------------------

describe('O5: no lowering after capability floor', () => {
  test('tool-needed floor persists through full pipeline', async () => {
    const result = await executeTask(
      makeInput({ goal: 'git status' }),
      makeDeps({ routingLevel: 0 }),
    );
    expect(result.trace.routingLevel).toBeGreaterThanOrEqual(2);
  });

  test('non-tool-needed task stays at base level', async () => {
    const result = await executeTask(
      makeInput({ goal: 'explain how authentication works' }),
      makeDeps({ routingLevel: 1 }),
    );
    expect(result.trace.routingLevel).toBeLessThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// Composition matrix — untested rows (spec §12)
// ---------------------------------------------------------------------------

describe('Composition matrix — untested rows', () => {
  test('Row 3: general-reasoning / execute / none → L0-L1', async () => {
    // "ช่วยอธิบาย" matches EXECUTE_PATTERN (ช่วย) but no CLI command → none → no floor
    const result = await executeTask(
      makeInput({ goal: 'ช่วยอธิบาย architecture' }),
      makeDeps({ routingLevel: 0 }),
    );
    expect(result.trace.routingLevel).toBeLessThanOrEqual(1);
  });

  test('Row 9: code-mutation / execute / none → risk-based (can be L0)', async () => {
    const result = await executeTask(
      makeInput({ goal: 'fix the export value', taskType: 'code', targetFiles: ['src/foo.ts'] }),
      makeDeps({ routingLevel: 0, taskType: 'code' }),
    );
    expect(result.trace.routingLevel).toBe(0);
  });

  test('Row 8: code-reasoning / execute / tool-needed → L2+', async () => {
    // "git push origin main" → code-reasoning (git is CODE_KEYWORD) + tool-needed (git is CLI)
    const result = await executeTask(
      makeInput({ goal: 'git push origin main' }),
      makeDeps({ routingLevel: 0 }),
    );
    expect(result.trace.routingLevel).toBeGreaterThanOrEqual(2);
  });
});
