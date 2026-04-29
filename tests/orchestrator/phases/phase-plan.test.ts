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

// ── Round 5: stage event observability ──────────────────────────
import { createBus, type VinyanBus, type VinyanBusEvents } from '../../../src/core/bus.ts';

function makeContextWithBus(input: TaskInput, dag: TaskDAG, bus: VinyanBus): PhaseContext {
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
      bus,
    } as unknown as PhaseContext['deps'],
  };
}

type StageEvent = VinyanBusEvents['task:stage_update'];

describe('executePlanPhase — task:stage_update telemetry', () => {
  test('emits decomposing entered → exited and ready exited for a normal multi-step plan', async () => {
    const bus = createBus();
    const events: StageEvent[] = [];
    bus.on('task:stage_update', (e) => events.push(e));

    const input = makeInput();
    const dag: TaskDAG = {
      nodes: [
        { id: 'n1', description: 'explore', targetFiles: [], dependencies: [], assignedOracles: ['none-readonly'] },
        { id: 'n2', description: 'verify', targetFiles: [], dependencies: ['n1'], assignedOracles: ['type'] },
      ],
    };
    const ctx = makeContextWithBus(input, dag, bus);

    const outcome = await executePlanPhase(ctx, makeRouting(), makePerception(), makeUnderstanding(), undefined);
    expect(outcome.action).toBe('continue');

    // Every emitted event must reference this task and the `plan` phase.
    for (const e of events) {
      expect(e.taskId).toBe(input.id);
      expect(e.phase).toBe('plan');
    }
    const stageStatuses = events.map((e) => `${e.stage}:${e.status}`);
    expect(stageStatuses).toContain('decomposing:entered');
    expect(stageStatuses).toContain('decomposing:exited');
    expect(stageStatuses).toContain('ready:exited');
    // `decomposing:exited` must carry a progress snapshot reflecting the DAG.
    const exited = events.find((e) => e.stage === 'decomposing' && e.status === 'exited');
    expect(exited?.progress).toEqual({ done: 0, total: 2 });
    // No fallback / approval-gate stage when the plan is plain.
    expect(stageStatuses).not.toContain('fallback:progress');
    expect(stageStatuses).not.toContain('approval-gate:entered');
  });

  test('emits fallback:progress when the decomposer returns isFallback', async () => {
    const bus = createBus();
    const events: StageEvent[] = [];
    bus.on('task:stage_update', (e) => events.push(e));

    const input = makeInput();
    const dag: TaskDAG = {
      nodes: [
        { id: 'n1', description: 'fallback echo', targetFiles: [], dependencies: [], assignedOracles: [] },
      ],
      isFallback: true,
    } as TaskDAG;
    const ctx = makeContextWithBus(input, dag, bus);

    const outcome = await executePlanPhase(ctx, makeRouting(), makePerception(), makeUnderstanding(), undefined);
    expect(outcome.action).toBe('continue');

    const fallback = events.find((e) => e.stage === 'fallback');
    expect(fallback).toBeDefined();
    expect(fallback?.status).toBe('progress');
    expect(fallback?.reason).toBe('decomposer-fallback');
  });

  test('skips stage events at routing levels below 2', async () => {
    const bus = createBus();
    const events: StageEvent[] = [];
    bus.on('task:stage_update', (e) => events.push(e));

    const input = makeInput();
    const dag: TaskDAG = {
      nodes: [
        { id: 'n1', description: 'do it', targetFiles: [], dependencies: [], assignedOracles: ['type'] },
      ],
    };
    const ctx = makeContextWithBus(input, dag, bus);
    const routingL1 = { ...makeRouting(), level: 1 } as RoutingDecision;

    const outcome = await executePlanPhase(ctx, routingL1, makePerception(), makeUnderstanding(), undefined);
    expect(outcome.action).toBe('continue');
    // L0/L1 paths skip the plan phase entirely \u2014 no stage events fire.
    expect(events.filter((e) => e.stage === 'decomposing' || e.stage === 'ready')).toEqual([]);
  });
});

// ── Round 6 §3: bounded planning self-repair ─────────────────────
function makeInputWithBudget(maxDurationMs: number): TaskInput {
  return {
    id: 'task-plan-repair-test',
    source: 'cli',
    goal: 'investigate auth module',
    taskType: 'reasoning',
    targetFiles: [],
    budget: { maxTokens: 10_000, maxRetries: 1, maxDurationMs },
  } as TaskInput;
}

function makeContextWithSequence(
  input: TaskInput,
  sequence: TaskDAG[],
  bus: VinyanBus,
  options?: { startTime?: number },
): { ctx: PhaseContext; callCount: () => number } {
  const wm = makeWorkingMemory();
  let calls = 0;
  return {
    callCount: () => calls,
    ctx: {
      input,
      startTime: options?.startTime ?? Date.now(),
      workingMemory: wm as unknown as PhaseContext['workingMemory'],
      explorationFlag: false,
      deps: {
        decomposer: {
          decompose: async () => {
            const idx = Math.min(calls, sequence.length - 1);
            calls += 1;
            return sequence[idx];
          },
        },
        bus,
      } as unknown as PhaseContext['deps'],
    },
  };
}

describe('executePlanPhase — bounded planning self-repair', () => {
  test('happy path — no repair when first decompose returns a valid plan', async () => {
    const bus = createBus();
    const events: StageEvent[] = [];
    bus.on('task:stage_update', (e) => events.push(e));

    const validDag: TaskDAG = {
      nodes: [
        { id: 'n1', description: 'explore', targetFiles: [], dependencies: [], assignedOracles: ['none-readonly'] },
        { id: 'n2', description: 'verify', targetFiles: [], dependencies: ['n1'], assignedOracles: ['type'] },
      ],
    };
    const { ctx, callCount } = makeContextWithSequence(makeInputWithBudget(60_000), [validDag], bus);

    const outcome = await executePlanPhase(ctx, makeRouting(), makePerception(), makeUnderstanding(), undefined);
    expect(outcome.action).toBe('continue');
    expect(callCount()).toBe(1);
    expect(events.filter((e) => e.stage === 'repair')).toEqual([]);
  });

  test('repair recovers a transient fallback on the second attempt', async () => {
    const bus = createBus();
    const events: StageEvent[] = [];
    const fallbackEvents: Array<{ taskId: string }> = [];
    bus.on('task:stage_update', (e) => events.push(e));
    bus.on('decomposer:fallback', (e) => fallbackEvents.push(e));

    const fallbackDag: TaskDAG = {
      nodes: [{ id: 'fb', description: 'echo', targetFiles: [], dependencies: [], assignedOracles: [] }],
      isFallback: true,
    };
    const validDag: TaskDAG = {
      nodes: [
        { id: 'n1', description: 'explore', targetFiles: [], dependencies: [], assignedOracles: ['none-readonly'] },
        { id: 'n2', description: 'verify', targetFiles: [], dependencies: ['n1'], assignedOracles: ['type'] },
      ],
    };
    const { ctx, callCount } = makeContextWithSequence(
      makeInputWithBudget(60_000),
      [fallbackDag, validDag],
      bus,
    );

    const outcome = await executePlanPhase(ctx, makeRouting(), makePerception(), makeUnderstanding(), undefined);
    expect(outcome.action).toBe('continue');
    if (outcome.action !== 'continue') return;
    expect(callCount()).toBe(2);

    const repairEvents = events.filter((e) => e.stage === 'repair');
    expect(repairEvents).toHaveLength(2);
    expect(repairEvents[0]).toMatchObject({ status: 'entered', attempt: 1, reason: 'decomposer-fallback' });
    expect(repairEvents[1]).toMatchObject({ status: 'exited', attempt: 1, reason: 'succeeded' });

    // Final plan is the recovered, valid one.
    expect(outcome.value.plan?.isFallback).toBeFalsy();
    expect(outcome.value.plan?.nodes.length).toBe(2);
    // No `decomposer:fallback` should fire when repair succeeds.
    expect(fallbackEvents).toEqual([]);
    // No fallback:progress stage either.
    expect(events.filter((e) => e.stage === 'fallback')).toEqual([]);
  });

  test('repair exhausted — both calls return fallback', async () => {
    const bus = createBus();
    const events: StageEvent[] = [];
    const fallbackEvents: Array<{ taskId: string }> = [];
    bus.on('task:stage_update', (e) => events.push(e));
    bus.on('decomposer:fallback', (e) => fallbackEvents.push(e));

    const fallbackDag: TaskDAG = {
      nodes: [{ id: 'fb', description: 'echo', targetFiles: [], dependencies: [], assignedOracles: [] }],
      isFallback: true,
    };
    const { ctx, callCount } = makeContextWithSequence(
      makeInputWithBudget(60_000),
      [fallbackDag, fallbackDag],
      bus,
    );

    const outcome = await executePlanPhase(ctx, makeRouting(), makePerception(), makeUnderstanding(), undefined);
    expect(outcome.action).toBe('continue');
    if (outcome.action !== 'continue') return;
    expect(callCount()).toBe(2);

    const repairEvents = events.filter((e) => e.stage === 'repair');
    expect(repairEvents).toHaveLength(2);
    expect(repairEvents[0]).toMatchObject({ status: 'entered', attempt: 1, reason: 'decomposer-fallback' });
    expect(repairEvents[1]).toMatchObject({ status: 'exited', attempt: 1, reason: 'exhausted' });

    // Final plan is still fallback → existing fallback signals fire.
    expect(outcome.value.plan?.isFallback).toBe(true);
    expect(fallbackEvents).toHaveLength(1);
    const fallbackStage = events.find((e) => e.stage === 'fallback');
    expect(fallbackStage).toMatchObject({ status: 'progress', reason: 'decomposer-fallback' });
  });

  test('budget guard skips repair when remaining wall-clock is below headroom', async () => {
    const bus = createBus();
    const events: StageEvent[] = [];
    bus.on('task:stage_update', (e) => events.push(e));

    const fallbackDag: TaskDAG = {
      nodes: [{ id: 'fb', description: 'echo', targetFiles: [], dependencies: [], assignedOracles: [] }],
      isFallback: true,
    };
    // Remaining = 60_000 - 55_000 = 5_000 ms < 15_000 ms headroom → skip.
    const budgetMs = 60_000;
    const { ctx, callCount } = makeContextWithSequence(
      makeInputWithBudget(budgetMs),
      [fallbackDag],
      bus,
      { startTime: Date.now() - (budgetMs - 5_000) },
    );

    const outcome = await executePlanPhase(ctx, makeRouting(), makePerception(), makeUnderstanding(), undefined);
    expect(outcome.action).toBe('continue');
    if (outcome.action !== 'continue') return;

    expect(callCount()).toBe(1);
    const repairEvents = events.filter((e) => e.stage === 'repair');
    expect(repairEvents).toHaveLength(1);
    expect(repairEvents[0]?.status).toBe('exited');
    expect(repairEvents[0]?.reason).toMatch(/^budget-headroom:/);
    // No `repair:entered` should fire when guard skips.
    expect(repairEvents.find((e) => e.status === 'entered')).toBeUndefined();
    // The fallback plan is returned as-is.
    expect(outcome.value.plan?.isFallback).toBe(true);
  });
});
