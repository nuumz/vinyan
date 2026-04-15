/**
 * Book-integration Wave 5.2: phase-plan TaskDAG.preamble → enhancedInput merge.
 *
 * Unit-tests the narrow contract: when the decomposer returns a DAG
 * with a non-empty `preamble`, phase-plan must return a
 * `PlanResult.enhancedInput` whose `constraints` include the original
 * input's constraints plus the preamble, and the caller's original
 * input must remain untouched.
 */
import { describe, expect, test } from 'bun:test';
import { executePlanPhase } from '../../../src/orchestrator/phases/phase-plan.ts';
import type { PhaseContext } from '../../../src/orchestrator/phases/types.ts';
import type {
  PerceptualHierarchy,
  RoutingDecision,
  SemanticTaskUnderstanding,
  TaskDAG,
  TaskInput,
  WorkingMemoryState,
} from '../../../src/orchestrator/types.ts';

function makeInput(constraints?: string[]): TaskInput {
  return {
    id: 'task-plan-test',
    source: 'cli',
    goal: 'investigate auth module',
    taskType: 'reasoning',
    targetFiles: [],
    ...(constraints ? { constraints } : {}),
    budget: { maxTokens: 10_000, maxRetries: 1, maxDurationMs: 5_000 },
  } as TaskInput;
}

function makePerception(): PerceptualHierarchy {
  return {
    taskTarget: { file: 'src/auth.ts', description: 'investigate' },
    dependencyCone: { directImporters: [], directImportees: [], transitiveBlastRadius: 0 },
    diagnostics: { lintWarnings: [], typeErrors: [], failingTests: [] },
    verifiedFacts: [],
    runtime: { nodeVersion: 'v20', os: 'darwin', availableTools: [] },
  };
}

function makeWorkingMemory(): { getSnapshot: () => WorkingMemoryState } {
  return {
    getSnapshot: () => ({
      failedApproaches: [],
      activeHypotheses: [],
      unresolvedUncertainties: [],
      scopedFacts: [],
    }),
  };
}

function makeRouting(): RoutingDecision {
  return {
    level: 2,
    model: 'sonnet',
    budgetTokens: 50000,
    latencyBudgetMs: 30000,
  } as unknown as RoutingDecision;
}

function makeUnderstanding(): SemanticTaskUnderstanding {
  return {
    rawGoal: 'investigate auth module',
    actionVerb: 'investigate',
    actionCategory: 'investigation',
    frameworkContext: [],
    constraints: [],
    acceptanceCriteria: [],
    expectsMutation: false,
    resolvedEntities: [],
    taskTypeSignature: 'investigation::auth.ts',
    understandingDepth: 0,
  } as unknown as SemanticTaskUnderstanding;
}

function makeContext(input: TaskInput, dag: TaskDAG): PhaseContext {
  const wm = makeWorkingMemory();
  return {
    input,
    startTime: Date.now(),
    workingMemory: wm as unknown as PhaseContext['workingMemory'],
    explorationFlag: false,
    deps: {
      decomposer: {
        decompose: async () => dag,
      },
    } as unknown as PhaseContext['deps'],
  };
}

describe('executePlanPhase — Wave 5.2 preamble → enhancedInput', () => {
  test('decomposer returns DAG with preamble → phase-plan emits enhancedInput', async () => {
    const original = makeInput(['USER:be thorough']);
    const dag: TaskDAG = {
      nodes: [
        {
          id: 'n1',
          description: 'explore',
          targetFiles: [],
          dependencies: [],
          assignedOracles: ['none-readonly'],
        },
      ],
      preamble: ['REPORT_CONTRACT: return findings / sources / open questions'],
    };
    const ctx = makeContext(original, dag);

    const outcome = await executePlanPhase(ctx, makeRouting(), makePerception(), makeUnderstanding(), undefined);
    expect(outcome.action).toBe('continue');
    if (outcome.action !== 'continue') return;
    expect(outcome.value.plan).toBeDefined();
    expect(outcome.value.enhancedInput).toBeDefined();
    const enhanced = outcome.value.enhancedInput!;
    expect(enhanced.constraints).toEqual([
      'USER:be thorough',
      'REPORT_CONTRACT: return findings / sources / open questions',
    ]);
    // The caller's original input is NOT mutated (seam #2 closure)
    expect(original.constraints).toEqual(['USER:be thorough']);
    // The enhanced clone is a different object
    expect(enhanced).not.toBe(original);
  });

  test('DAG without preamble → no enhancedInput', async () => {
    const original = makeInput(['USER:be thorough']);
    const dag: TaskDAG = {
      nodes: [
        {
          id: 'n1',
          description: 'do it',
          targetFiles: [],
          dependencies: [],
          assignedOracles: ['type'],
        },
      ],
    };
    const ctx = makeContext(original, dag);

    const outcome = await executePlanPhase(ctx, makeRouting(), makePerception(), makeUnderstanding(), undefined);
    expect(outcome.action).toBe('continue');
    if (outcome.action !== 'continue') return;
    expect(outcome.value.enhancedInput).toBeUndefined();
  });

  test('empty preamble array → no enhancedInput', async () => {
    const original = makeInput();
    const dag: TaskDAG = {
      nodes: [
        {
          id: 'n1',
          description: 'do it',
          targetFiles: [],
          dependencies: [],
          assignedOracles: ['type'],
        },
      ],
      preamble: [],
    };
    const ctx = makeContext(original, dag);

    const outcome = await executePlanPhase(ctx, makeRouting(), makePerception(), makeUnderstanding(), undefined);
    expect(outcome.action).toBe('continue');
    if (outcome.action !== 'continue') return;
    expect(outcome.value.enhancedInput).toBeUndefined();
  });

  test('preamble merges with existing input constraints (append order preserved)', async () => {
    const original = makeInput(['USER:first', 'USER:second']);
    const dag: TaskDAG = {
      nodes: [
        {
          id: 'n1',
          description: 'explore',
          targetFiles: [],
          dependencies: [],
          assignedOracles: ['none-readonly'],
        },
      ],
      preamble: ['PREAMBLE:a', 'PREAMBLE:b'],
    };
    const ctx = makeContext(original, dag);

    const outcome = await executePlanPhase(ctx, makeRouting(), makePerception(), makeUnderstanding(), undefined);
    if (outcome.action !== 'continue') throw new Error('expected continue');
    expect(outcome.value.enhancedInput?.constraints).toEqual(['USER:first', 'USER:second', 'PREAMBLE:a', 'PREAMBLE:b']);
  });

  // ── Deep-audit #1: retry-path preamble dedupe ────────────────────
  test('Deep-audit #1: preamble is NOT double-appended when input already contains it', async () => {
    // Simulate the retry case: the input already carries the preamble
    // from a previous iteration. The decomposer still emits preamble on
    // this iteration. phase-plan must not duplicate it.
    const preambleItem = 'REPORT_CONTRACT: return findings / sources / open questions';
    const alreadyEnhanced = makeInput(['USER:be thorough', preambleItem]);
    const dag: TaskDAG = {
      nodes: [
        {
          id: 'n1',
          description: 'explore',
          targetFiles: [],
          dependencies: [],
          assignedOracles: ['none-readonly'],
        },
      ],
      preamble: [preambleItem],
    };
    const ctx = makeContext(alreadyEnhanced, dag);

    const outcome = await executePlanPhase(ctx, makeRouting(), makePerception(), makeUnderstanding(), undefined);
    if (outcome.action !== 'continue') throw new Error('expected continue');
    // enhancedInput should NOT be emitted — the preamble is already
    // fully present and a ctx swap would be a pointless allocation.
    expect(outcome.value.enhancedInput).toBeUndefined();
  });

  test('Deep-audit #1: partial overlap — only the missing preamble entries are appended', async () => {
    // Input has some but not all of the preamble items. Expected:
    // the missing ones are appended in order; the already-present
    // one is not duplicated.
    const alreadyEnhanced = makeInput(['USER:first', 'PREAMBLE:a']);
    const dag: TaskDAG = {
      nodes: [
        {
          id: 'n1',
          description: 'explore',
          targetFiles: [],
          dependencies: [],
          assignedOracles: ['none-readonly'],
        },
      ],
      preamble: ['PREAMBLE:a', 'PREAMBLE:b', 'PREAMBLE:c'],
    };
    const ctx = makeContext(alreadyEnhanced, dag);

    const outcome = await executePlanPhase(ctx, makeRouting(), makePerception(), makeUnderstanding(), undefined);
    if (outcome.action !== 'continue') throw new Error('expected continue');
    expect(outcome.value.enhancedInput?.constraints).toEqual([
      'USER:first',
      'PREAMBLE:a',
      'PREAMBLE:b',
      'PREAMBLE:c',
    ]);
  });
});
