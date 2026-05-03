/**
 * Reproducer for the worker-budget bypass that produced incident
 * `b80c5c0d-...-delegate-p-architect-r1`: the wall-clock cap on
 * `routing.latencyBudgetMs` is computed at routing-loop entry but
 * `worker:dispatch` fires N seconds later (after perceive / plan /
 * approval-gate / etc.), so the worker subprocess receives a budget
 * roughly equal to the original task budget rather than the budget that
 * actually remains. Worker overshoots, returns a "subprocess timeout",
 * and the next routing-loop iteration emits `task:timeout` long past
 * the budget that was supposed to be enforced.
 *
 * The fix lives at the SINGLE site closest to dispatch — the cap moves
 * from `core-loop.ts` (loop-top) to `phase-generate.ts` (immediately
 * before `bus.emit('worker:dispatch', …)`).
 *
 * This test drives `executeGeneratePhase` with a synthetic
 * `PhaseContext.startTime` set in the past so we can deterministically
 * assert what the dispatch site emits — no real wall-clock waiting, no
 * race-prone tolerance windows.
 */
import { describe, expect, test } from 'bun:test';
import type { VinyanBus, VinyanBusEvents } from '../../src/core/bus.ts';
import type { OrchestratorDeps } from '../../src/orchestrator/core-loop.ts';
import { executeGeneratePhase } from '../../src/orchestrator/phases/phase-generate.ts';
import type { PhaseContext } from '../../src/orchestrator/phases/types.ts';
import type {
  PerceptualHierarchy,
  RoutingDecision,
  SemanticTaskUnderstanding,
  TaskInput,
  WorkerOutput,
} from '../../src/orchestrator/types.ts';
import { WorkingMemory } from '../../src/orchestrator/working-memory.ts';

interface RecordedEmit {
  type: keyof VinyanBusEvents;
  payload: unknown;
}

function makeBus(events: RecordedEmit[]): VinyanBus {
  // Minimal in-test bus: only `emit` is exercised by phase-generate. Other
  // members are unreachable from this code path so they remain unbound.
  return {
    emit: (type: keyof VinyanBusEvents, payload: unknown) => {
      events.push({ type, payload });
    },
  } as unknown as VinyanBus;
}

/**
 * Long-running fake worker — ignores `routing.latencyBudgetMs` entirely.
 * Returns synchronously with a benign success result so the test only
 * exercises the dispatch-time clamp, not any post-dispatch retry logic.
 *
 * The test asserts BEFORE the worker output is consumed that the
 * `worker:dispatch` event payload was clamped — the worker's return
 * value is just there to let `executeGeneratePhase` reach a normal exit.
 */
function makeWorkerPool(seenLatencyBudgets: number[]) {
  return {
    dispatch: async (
      _input: TaskInput,
      _perception: PerceptualHierarchy,
      _memory: unknown,
      _plan: unknown,
      routing: RoutingDecision,
    ): Promise<WorkerOutput> => {
      seenLatencyBudgets.push(routing.latencyBudgetMs);
      return {
        mutations: [],
        proposedToolCalls: [],
        tokensConsumed: 1,
        durationMs: 1,
        proposedContent: 'ok',
      } as unknown as WorkerOutput;
    },
    // Force the L2 path to degrade to single-shot dispatch — keeps the test
    // free of agent-loop subprocess infrastructure while still exercising
    // the same `worker:dispatch` emit at `phase-generate.ts:117`.
    getAgentLoopDeps: () => undefined,
  };
}

function makeUnderstanding(): SemanticTaskUnderstanding {
  return {
    // Minimal shape that satisfies the field reads in phase-generate's
    // post-dispatch checks (lines 426-432). The mutation-domain branch
    // skips tool filtering, which is what we want for an empty toolCalls
    // result.
    taskDomain: 'code-mutation',
    taskIntent: 'execute',
    toolRequirement: 'no-tools',
    resolvedEntities: [],
    understandingDepth: 0,
    verifiedClaims: [],
    understandingFingerprint: 'test-fingerprint',
    intent: 'fix',
    affectedEntities: [],
    constraints: [],
    successCriteria: [],
  } as unknown as SemanticTaskUnderstanding;
}

function makePerception(): PerceptualHierarchy {
  return {
    taskTarget: { file: 'src/foo.ts', description: 'test' },
    dependencyCone: { directImporters: [], directImportees: [], transitiveBlastRadius: 0 },
    diagnostics: { lintWarnings: [], typeErrors: [], failingTests: [] },
    verifiedFacts: [],
  } as unknown as PerceptualHierarchy;
}

function makeInput(maxDurationMs: number): TaskInput {
  return {
    id: 'test-clamp-task',
    source: 'cli',
    goal: 'reproducer for budget bypass',
    taskType: 'code',
    budget: { maxTokens: 10_000, maxDurationMs, maxRetries: 1 },
  };
}

function makeRouting(latencyBudgetMs: number): RoutingDecision {
  return {
    level: 2,
    model: 'mock/m',
    budgetTokens: 10_000,
    latencyBudgetMs,
  };
}

interface BuildCtxArgs {
  events: RecordedEmit[];
  startTime: number;
  maxDurationMs: number;
  workerPool: ReturnType<typeof makeWorkerPool>;
}

function buildCtx(args: BuildCtxArgs): PhaseContext {
  const bus = makeBus(args.events);
  const deps = {
    bus,
    workerPool: args.workerPool,
    traceCollector: { record: async () => {} },
  } as unknown as OrchestratorDeps;

  return {
    input: makeInput(args.maxDurationMs),
    deps,
    startTime: args.startTime,
    workingMemory: new WorkingMemory(),
    explorationFlag: false,
  };
}

describe('phase-generate worker:dispatch — wall-clock budget clamp at dispatch site', () => {
  test('reproducer: when routing.latencyBudgetMs overshoots remaining wall-clock, dispatch event is clamped', async () => {
    // architect-r1 conditions: 60s sub-task budget, 44.3s elapsed by the
    // time worker:dispatch fires. The pre-fix code path emits whatever
    // routing.latencyBudgetMs the routing-loop top set (~59_750ms) into
    // worker:dispatch verbatim. Post-fix: clamped to ~15_428ms.
    const events: RecordedEmit[] = [];
    const seen: number[] = [];
    const workerPool = makeWorkerPool(seen);
    const ctx = buildCtx({
      events,
      // 44_322ms before "now" — matches architect-r1's elapsed at dispatch.
      startTime: Date.now() - 44_322,
      maxDurationMs: 60_000,
      workerPool,
    });

    await executeGeneratePhase(ctx, {
      routing: makeRouting(59_739), // worker:dispatch payload value from the incident
      perception: makePerception(),
      understanding: makeUnderstanding(),
      plan: undefined,
      totalTokensConsumed: 0,
      budgetCapMultiplier: 6,
      retry: 0,
    });

    const dispatch = events.find((e) => e.type === 'worker:dispatch');
    expect(dispatch).toBeDefined();
    const payload = dispatch!.payload as { taskId: string; routing: RoutingDecision };
    // Allow ~50ms slack for executeGeneratePhase's own setup latency.
    // Pre-fix: payload.routing.latencyBudgetMs === 59_739 → fails.
    // Post-fix: clamped to ~15_428 (60_000 - 44_322 - 250) → passes.
    expect(payload.routing.latencyBudgetMs).toBeLessThanOrEqual(15_500);
    // And the worker actually invoked through workerPool.dispatch sees the
    // SAME clamped value — no separate copy of routing leaked through.
    expect(seen[0]).toBeLessThanOrEqual(15_500);
    expect(payload.routing.latencyBudgetMs).toBe(seen[0]!);
  });

  test('happy path: when routing.latencyBudgetMs already fits remaining budget, dispatch is unchanged', async () => {
    const events: RecordedEmit[] = [];
    const seen: number[] = [];
    const workerPool = makeWorkerPool(seen);
    const ctx = buildCtx({
      events,
      startTime: Date.now(), // elapsed ~ 0
      maxDurationMs: 60_000,
      workerPool,
    });

    await executeGeneratePhase(ctx, {
      routing: makeRouting(5_000), // well under 60s budget
      perception: makePerception(),
      understanding: makeUnderstanding(),
      plan: undefined,
      totalTokensConsumed: 0,
      budgetCapMultiplier: 6,
      retry: 0,
    });

    const dispatch = events.find((e) => e.type === 'worker:dispatch');
    const payload = dispatch!.payload as { routing: RoutingDecision };
    expect(payload.routing.latencyBudgetMs).toBe(5_000);
  });
});
