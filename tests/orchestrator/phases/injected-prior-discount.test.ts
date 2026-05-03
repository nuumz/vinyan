/**
 * A5 verifier-side discount — pure helper + integration tests.
 *
 * Layer 1 — pure helpers (`lookupInjectedPriorMultiplier` +
 *   `applyInjectedPriorDiscount`) over a fake `InjectDependencyRegistry`
 *   and an in-memory `TaskEventStore`. No bus, no orchestrator.
 *
 * Layer 2 — bus-driven integration: emit a real cot-inject decision
 *   audit:entry through `createInjectDependencyRegistry`, then assert
 *   `lookupInjectedPriorMultiplier` returns the discounted multiplier.
 *
 * Behavior tests only: every assertion follows a function call and
 * checks a returned value or a side-effect on a captured handle.
 */
import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { ALL_MIGRATIONS, MigrationRunner } from '../../../src/db/migrations/index.ts';
import { createBus } from '../../../src/core/bus.ts';
import { TaskEventStore } from '../../../src/db/task-event-store.ts';
import {
  ParameterLedger,
  ParameterStore,
} from '../../../src/orchestrator/adaptive-params/index.ts';
import {
  applyInjectedPriorDiscount,
  COT_INJECT_RULE_ID,
  DEFAULT_INJECT_DISCOUNT,
  lookupInjectedPriorMultiplier,
} from '../../../src/orchestrator/phases/injected-prior-discount.ts';
import {
  createInjectDependencyRegistry,
  type InjectDependencyRegistry,
} from '../../../src/orchestrator/phases/inject-dependency-registry.ts';

let db: Database;
let store: TaskEventStore;

beforeEach(() => {
  db = new Database(':memory:');
  new MigrationRunner().migrate(db, ALL_MIGRATIONS);
  store = new TaskEventStore(db);
});

afterEach(() => {
  db.close();
});

// ── Helpers ──────────────────────────────────────────────────────────

function appendAudit(taskId: string, payload: Record<string, unknown>): void {
  store.append({ taskId, eventType: 'audit:entry', payload, ts: payload.ts as number });
}

function injectDecisionPayload(over: {
  decisionId: string;
  subTaskId: string;
  injectCount: number;
  thoughtIds?: string[];
  ts?: number;
}): Record<string, unknown> {
  return {
    id: over.decisionId,
    taskId: 'parent',
    ts: over.ts ?? 1000,
    schemaVersion: 1,
    policyVersion: 'audit-v1',
    actor: { type: 'orchestrator' },
    redactionPolicyHash: 'a'.repeat(64),
    workflowId: 'parent',
    subTaskId: over.subTaskId,
    kind: 'decision',
    decisionType: 'route',
    verdict: `cot-inject:${over.injectCount}`,
    rationale: 'test inject',
    ruleId: COT_INJECT_RULE_ID,
    tier: 'deterministic',
    evidenceRefs: (over.thoughtIds ?? []).map((id) => ({ type: 'event', eventId: id })),
  };
}

// ── Layer 1 — pure ────────────────────────────────────────────────────

describe('lookupInjectedPriorMultiplier — durable-log fallback path', () => {
  test('returns multiplier 1.0 when no parentTaskId is provided', () => {
    const result = lookupInjectedPriorMultiplier({
      taskId: 'sub-1',
      taskEventStore: store,
    });
    expect(result.multiplier).toBe(1);
    expect(result.injectFound).toBe(false);
    expect(result.injectCount).toBe(0);
  });

  test('returns multiplier 1.0 when no taskEventStore is provided', () => {
    const result = lookupInjectedPriorMultiplier({
      taskId: 'sub-1',
      parentTaskId: 'parent',
    });
    expect(result.multiplier).toBe(1);
    expect(result.injectFound).toBe(false);
  });

  test('returns multiplier 1.0 when the durable log carries no inject row for the target sub-task', () => {
    appendAudit('parent', injectDecisionPayload({ decisionId: 'd1', subTaskId: 'OTHER-sub', injectCount: 3 }));
    const result = lookupInjectedPriorMultiplier({
      taskId: 'sub-1',
      parentTaskId: 'parent',
      taskEventStore: store,
    });
    expect(result.multiplier).toBe(1);
    expect(result.injectFound).toBe(false);
  });

  test('returns the default multiplier 0.85 when the durable log carries a matching inject row', () => {
    appendAudit('parent', injectDecisionPayload({ decisionId: 'd1', subTaskId: 'sub-1', injectCount: 3 }));
    const result = lookupInjectedPriorMultiplier({
      taskId: 'sub-1',
      parentTaskId: 'parent',
      taskEventStore: store,
    });
    expect(result.multiplier).toBe(DEFAULT_INJECT_DISCOUNT);
    expect(result.injectFound).toBe(true);
    expect(result.injectCount).toBe(1);
  });

  test('skips cot-skip:* rows — no discount when the inject was gated out', () => {
    appendAudit('parent', {
      ...injectDecisionPayload({ decisionId: 'd1', subTaskId: 'sub-1', injectCount: 3 }),
      verdict: 'cot-skip:no-thoughts',
    });
    const result = lookupInjectedPriorMultiplier({
      taskId: 'sub-1',
      parentTaskId: 'parent',
      taskEventStore: store,
    });
    expect(result.multiplier).toBe(1);
    expect(result.injectFound).toBe(false);
  });

  test('honors a tuned multiplier from ParameterStore', () => {
    appendAudit('parent', injectDecisionPayload({ decisionId: 'd1', subTaskId: 'sub-1', injectCount: 1 }));
    const ledger = new ParameterLedger(db);
    const ps = new ParameterStore({ ledger });
    ps.set('verify.injected_prior_discount', 0.5, 'tighter A5', 'test');
    const result = lookupInjectedPriorMultiplier({
      taskId: 'sub-1',
      parentTaskId: 'parent',
      taskEventStore: store,
      parameterStore: ps,
    });
    expect(result.multiplier).toBe(0.5);
    expect(result.injectFound).toBe(true);
  });

  test('A9 — durable-log read failure returns multiplier 1.0 (does not throw)', () => {
    const exploding = {
      listForTask: () => {
        throw new Error('boom');
      },
    } as unknown as TaskEventStore;
    const result = lookupInjectedPriorMultiplier({
      taskId: 'sub-1',
      parentTaskId: 'parent',
      taskEventStore: exploding,
    });
    expect(result.multiplier).toBe(1);
    expect(result.injectFound).toBe(false);
  });
});

describe('applyInjectedPriorDiscount', () => {
  test('returns confidence unchanged when no inject was found', () => {
    expect(applyInjectedPriorDiscount(0.92, { multiplier: 1, injectFound: false, injectCount: 0, depth: 0 })).toBe(0.92);
  });

  test('returns multiplied confidence at depth=1 (single inject layer)', () => {
    const out = applyInjectedPriorDiscount(0.92, { multiplier: 0.85, injectFound: true, injectCount: 1, depth: 1 });
    expect(out).toBeCloseTo(0.92 * 0.85, 6);
  });

  test('compounds the multiplier at depth>1 (multiplier^depth)', () => {
    const out = applyInjectedPriorDiscount(0.9, { multiplier: 0.85, injectFound: true, injectCount: 1, depth: 3 });
    expect(out).toBeCloseTo(0.9 * 0.85 * 0.85 * 0.85, 6);
  });

  test('depth=0 with injectFound=true is a no-op (defensive — shouldnʼt happen)', () => {
    expect(applyInjectedPriorDiscount(0.92, { multiplier: 0.85, injectFound: true, injectCount: 1, depth: 0 })).toBe(0.92);
  });

  test('preserves undefined input as undefined', () => {
    expect(applyInjectedPriorDiscount(undefined, { multiplier: 0.85, injectFound: true, injectCount: 1, depth: 1 })).toBeUndefined();
  });

  test('passes through non-finite confidence (sanitization is callerʼs job)', () => {
    expect(applyInjectedPriorDiscount(Number.NaN, { multiplier: 0.85, injectFound: true, injectCount: 1, depth: 1 })).toBeNaN();
  });
});

// ── Layer 2 — registry + lookup integration ────────────────────────

describe('lookupInjectedPriorMultiplier — registry path (race-free)', () => {
  let registry: InjectDependencyRegistry;
  let bus: ReturnType<typeof createBus>;

  beforeEach(() => {
    bus = createBus();
    registry = createInjectDependencyRegistry(bus);
  });

  afterEach(() => {
    registry.detach();
  });

  test('registry is empty before any audit:entry is emitted', () => {
    expect(registry.lookup('sub-1')).toEqual([]);
  });

  test('emitting a cot-inject decision row populates the registry by subTaskId', () => {
    bus.emit('audit:entry', injectDecisionPayload({
      decisionId: 'd1',
      subTaskId: 'sub-1',
      injectCount: 2,
      thoughtIds: ['t-100', 't-200'],
    }) as never);
    const entries = registry.lookup('sub-1');
    expect(entries).toHaveLength(1);
    expect(entries[0]!.injectCount).toBe(2);
    expect(entries[0]!.sourceThoughtIds).toEqual(['t-100', 't-200']);
    expect(entries[0]!.decisionEntryId).toBe('d1');
  });

  test('lookupInjectedPriorMultiplier reads the registry first; durable log is not consulted when registry has the entry', () => {
    bus.emit('audit:entry', injectDecisionPayload({
      decisionId: 'd1',
      subTaskId: 'sub-1',
      injectCount: 1,
    }) as never);
    // Sabotage the durable store; if the registry is consulted first
    // the lookup must return the registry's verdict and never call
    // listForTask.
    const exploding = {
      listForTask: () => {
        throw new Error('should not be called');
      },
    } as unknown as TaskEventStore;
    const result = lookupInjectedPriorMultiplier({
      taskId: 'sub-1',
      parentTaskId: 'parent',
      injectDependencyRegistry: registry,
      taskEventStore: exploding,
    });
    expect(result.multiplier).toBe(DEFAULT_INJECT_DISCOUNT);
    expect(result.injectFound).toBe(true);
    expect(result.injectCount).toBe(1);
  });

  test('cot-skip rows are NOT indexed (registry skips them, like the durable-log path)', () => {
    bus.emit('audit:entry', {
      ...injectDecisionPayload({ decisionId: 'd1', subTaskId: 'sub-1', injectCount: 0 }),
      verdict: 'cot-skip:mutation-detected',
    } as never);
    expect(registry.lookup('sub-1')).toEqual([]);
  });

  test('rows with non-collab-cot ruleIds are ignored (registry only listens for COT_INJECT_RULE_ID)', () => {
    bus.emit('audit:entry', {
      ...injectDecisionPayload({ decisionId: 'd1', subTaskId: 'sub-1', injectCount: 1 }),
      ruleId: 'some-other-rule',
    } as never);
    expect(registry.lookup('sub-1')).toEqual([]);
  });
});

// ── Layer 3.5 — depth-aware chain walking ─────────────────────────────

describe('InjectDependencyRegistry.computeDepth — A5 chain depth', () => {
  let registry: InjectDependencyRegistry;
  let bus: ReturnType<typeof createBus>;

  beforeEach(() => {
    bus = createBus();
    registry = createInjectDependencyRegistry(bus);
  });

  afterEach(() => {
    registry.detach();
  });

  function emitThought(opts: { id: string; taskId: string }): void {
    bus.emit('audit:entry', {
      id: opts.id,
      taskId: opts.taskId,
      ts: 100,
      schemaVersion: 1,
      policyVersion: 'audit-v1',
      actor: { type: 'worker' },
      redactionPolicyHash: 'a'.repeat(64),
      kind: 'thought',
      content: 'reasoning',
      trigger: 'pre-tool',
    } as never);
  }

  test('depth=0 when no inject targets the task', () => {
    expect(registry.computeDepth('parent-delegate-step-r0')).toBe(0);
  });

  test('depth=1 for a single-link chain (round 0 → round 1)', () => {
    emitThought({ id: 't0', taskId: 'parent-delegate-step-r0' });
    bus.emit('audit:entry', injectDecisionPayload({
      decisionId: 'd1',
      subTaskId: 'parent-delegate-step-r1',
      injectCount: 1,
      thoughtIds: ['t0'],
    }) as never);
    expect(registry.computeDepth('parent-delegate-step-r1')).toBe(1);
  });

  test('depth=2 for round 2 ← round 1 ← round 0 (compounding)', () => {
    emitThought({ id: 't0', taskId: 'parent-delegate-step-r0' });
    bus.emit('audit:entry', injectDecisionPayload({
      decisionId: 'd1',
      subTaskId: 'parent-delegate-step-r1',
      injectCount: 1,
      thoughtIds: ['t0'],
    }) as never);
    emitThought({ id: 't1', taskId: 'parent-delegate-step-r1' });
    bus.emit('audit:entry', injectDecisionPayload({
      decisionId: 'd2',
      subTaskId: 'parent-delegate-step-r2',
      injectCount: 1,
      thoughtIds: ['t1'],
    }) as never);
    expect(registry.computeDepth('parent-delegate-step-r2')).toBe(2);
  });

  test('chain stops at unknown sourceTaskId (defensive — older replays)', () => {
    // Inject row references a thought id we never saw (e.g., emitted
    // before the registry attached). sourceTaskId resolves to undefined,
    // walking stops at this entry → depth = 1 from the immediate target.
    bus.emit('audit:entry', injectDecisionPayload({
      decisionId: 'd1',
      subTaskId: 'sub-1',
      injectCount: 1,
      thoughtIds: ['unknown-thought-id'],
    }) as never);
    expect(registry.computeDepth('sub-1')).toBe(1);
  });

  test('cycle is bounded — visited guard prevents runaway recursion', () => {
    // Construct a cycle: A's inject points to thoughts on B; B's inject
    // points to thoughts on A. Pathological but not impossible.
    emitThought({ id: 't-a', taskId: 'A' });
    emitThought({ id: 't-b', taskId: 'B' });
    bus.emit('audit:entry', injectDecisionPayload({
      decisionId: 'd-A',
      subTaskId: 'A',
      injectCount: 1,
      thoughtIds: ['t-b'],
    }) as never);
    bus.emit('audit:entry', injectDecisionPayload({
      decisionId: 'd-B',
      subTaskId: 'B',
      injectCount: 1,
      thoughtIds: ['t-a'],
    }) as never);
    // Should terminate without throwing; depth ≤ MAX_INJECT_CHAIN_DEPTH.
    const depthA = registry.computeDepth('A');
    expect(Number.isFinite(depthA)).toBe(true);
    expect(depthA).toBeLessThanOrEqual(5);
    expect(depthA).toBeGreaterThanOrEqual(1);
  });

  test('lookupInjectedPriorMultiplier returns depth from registry path', () => {
    emitThought({ id: 't0', taskId: 'parent-delegate-step-r0' });
    bus.emit('audit:entry', injectDecisionPayload({
      decisionId: 'd1',
      subTaskId: 'parent-delegate-step-r1',
      injectCount: 1,
      thoughtIds: ['t0'],
    }) as never);
    emitThought({ id: 't1', taskId: 'parent-delegate-step-r1' });
    bus.emit('audit:entry', injectDecisionPayload({
      decisionId: 'd2',
      subTaskId: 'parent-delegate-step-r2',
      injectCount: 1,
      thoughtIds: ['t1'],
    }) as never);
    const result = lookupInjectedPriorMultiplier({
      taskId: 'parent-delegate-step-r2',
      injectDependencyRegistry: registry,
    });
    expect(result.depth).toBe(2);
    expect(result.injectFound).toBe(true);
  });

  test('end-to-end: applyInjectedPriorDiscount compounds across chain depth', () => {
    emitThought({ id: 't0', taskId: 'r0' });
    bus.emit('audit:entry', injectDecisionPayload({
      decisionId: 'd1', subTaskId: 'r1', injectCount: 1, thoughtIds: ['t0'],
    }) as never);
    emitThought({ id: 't1', taskId: 'r1' });
    bus.emit('audit:entry', injectDecisionPayload({
      decisionId: 'd2', subTaskId: 'r2', injectCount: 1, thoughtIds: ['t1'],
    }) as never);
    const r1Result = lookupInjectedPriorMultiplier({
      taskId: 'r1', injectDependencyRegistry: registry,
    });
    const r2Result = lookupInjectedPriorMultiplier({
      taskId: 'r2', injectDependencyRegistry: registry,
    });
    const c0 = 0.9;
    const r1Confidence = applyInjectedPriorDiscount(c0, r1Result);
    const r2Confidence = applyInjectedPriorDiscount(c0, r2Result);
    expect(r1Confidence).toBeCloseTo(c0 * DEFAULT_INJECT_DISCOUNT, 6);
    expect(r2Confidence).toBeCloseTo(c0 * DEFAULT_INJECT_DISCOUNT * DEFAULT_INJECT_DISCOUNT, 6);
    // Strict A5: deeper chain → strictly more discounted.
    expect(r2Confidence!).toBeLessThan(r1Confidence!);
  });
});

// ── Layer 4 — cross-restart: durable-log fallback when registry is detached ──

describe('lookupInjectedPriorMultiplier — cross-restart durable-log path', () => {
  test('after registry detach + recorder flush, the durable taskEventStore lookup still finds the inject decision', async () => {
    const { attachTaskEventRecorder } = await import(
      '../../../src/orchestrator/observability/task-event-recorder.ts'
    );
    const bus = createBus();
    const recorder = attachTaskEventRecorder(bus, store, { flushIntervalMs: 50 });
    const registry = createInjectDependencyRegistry(bus);

    // Emit thought first (provenance), then the inject decision targeting sub-1.
    // Note: the recorder's manifest enforces that recordable events declare
    // taskId on the payload, so we wrap audit:entry with taskId at the top.
    bus.emit('audit:entry', {
      id: 'thought-1',
      taskId: 'parent-delegate-step-r0',
      ts: 900,
      schemaVersion: 1,
      policyVersion: 'audit-v1',
      actor: { type: 'worker' },
      redactionPolicyHash: 'a'.repeat(64),
      kind: 'thought',
      content: 'reasoning',
      trigger: 'pre-tool',
    } as never);
    bus.emit('audit:entry', injectDecisionPayload({
      decisionId: 'd-cross-restart',
      subTaskId: 'parent-delegate-step-r1',
      injectCount: 1,
      thoughtIds: ['thought-1'],
      ts: 1000,
    }) as never);

    // Flush recorder to disk synchronously (simulate "shutdown"
    // where buffer drains before close).
    recorder.flush();

    // Detach the in-memory registry — simulates orchestrator restart.
    registry.detach();
    recorder.detach();

    // Cross-restart: a fresh consumer (no registry) hits the durable
    // log via taskEventStore. The query path must find the inject row
    // by parent taskId and apply the discount.
    const result = lookupInjectedPriorMultiplier({
      taskId: 'parent-delegate-step-r1',
      parentTaskId: 'parent', // wrapper.taskId on the inject row
      taskEventStore: store,
    });
    expect(result.injectFound).toBe(true);
    expect(result.injectCount).toBe(1);
    expect(result.multiplier).toBe(DEFAULT_INJECT_DISCOUNT);
  });
});

// ── Layer 3 — phase-verify end-to-end discount on emitted verdict ──

describe('phase-verify — A5 discount applied to emitted verdict audit row', () => {
  test('verdict.confidence is multiplied by the inject discount when an inject decision targets this sub-task', async () => {
    const { executeTask } = await import('../../../src/orchestrator/core-loop.ts');
    const bus = createBus();
    const registry = createInjectDependencyRegistry(bus);

    // Pre-emit a cot-inject decision row that targets the sub-task we
    // are about to executeTask. Registry sees it synchronously.
    bus.emit('audit:entry', injectDecisionPayload({
      decisionId: 'd-inject',
      subTaskId: 't-discounted',
      injectCount: 1,
    }) as never);

    // Capture the verdict audit row emitted by phase-verify.
    const verdictEntries: Array<{ kind: string; confidence?: number; oracleId?: string }> = [];
    bus.on('audit:entry', (entry: unknown) => {
      const e = entry as {
        kind?: string;
        confidence?: number;
        oracleId?: string;
        ruleId?: string;
      };
      if (e.kind === 'verdict') {
        verdictEntries.push({
          kind: e.kind,
          ...(typeof e.confidence === 'number' ? { confidence: e.confidence } : {}),
          ...(e.oracleId ? { oracleId: e.oracleId } : {}),
        });
      }
    });

    const oracleConfidence = 0.9;
    const deps = {
      bus,
      injectDependencyRegistry: registry,
      perception: {
        assemble: async () => ({
          taskTarget: { file: 'src/foo.ts', description: 'x' },
          dependencyCone: { directImporters: [], directImportees: [], transitiveBlastRadius: 0 },
          diagnostics: { lintWarnings: [], typeErrors: [], failingTests: [] },
          verifiedFacts: [],
          runtime: { nodeVersion: '20', os: 'linux', availableTools: [] },
        }),
      },
      riskRouter: {
        assessInitialLevel: async () => ({
          level: 1,
          model: 'mock/fast',
          budgetTokens: 5000,
          latencyBudgetMs: 2000,
        }),
      },
      selfModel: {
        predict: async (input: { id: string }) => ({
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
            { file: 'src/foo.ts', content: 'x', diff: 'x', explanation: 'x' },
          ],
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
              oracleName: 'ast',
              type: 'known' as const,
              verified: true,
              confidence: oracleConfidence,
              evidence: [],
              fileHashes: {},
              durationMs: 10,
            },
          },
          reason: 'ok',
          aggregateConfidence: oracleConfidence,
        }),
      },
      traceCollector: {
        record: async () => {},
      },
      explorationEpsilon: 0,
    } as unknown as Parameters<typeof executeTask>[1];

    await executeTask(
      {
        id: 't-discounted',
        source: 'cli',
        goal: 'verify A5 discount',
        taskType: 'code',
        budget: { maxTokens: 10_000, maxDurationMs: 5_000, maxRetries: 1 },
        targetFiles: ['src/foo.ts'],
        parentTaskId: 'parent',
      },
      deps,
    );

    // Should have emitted at least one verdict audit row for the ast oracle.
    const astVerdicts = verdictEntries.filter((v) => v.oracleId === 'ast');
    expect(astVerdicts.length).toBeGreaterThan(0);
    // Confidence should be multiplied — strictly less than the raw 0.9.
    expect(astVerdicts[0]!.confidence).toBeDefined();
    expect(astVerdicts[0]!.confidence!).toBeLessThan(oracleConfidence);
    expect(astVerdicts[0]!.confidence!).toBeCloseTo(oracleConfidence * DEFAULT_INJECT_DISCOUNT, 5);

    registry.detach();
  });

  test('verdict.confidence is unchanged when no inject decision targets this task', async () => {
    const { executeTask } = await import('../../../src/orchestrator/core-loop.ts');
    const bus = createBus();
    const registry = createInjectDependencyRegistry(bus);

    // Note: no inject decision emitted → registry stays empty.

    const verdictEntries: Array<{ kind: string; confidence?: number; oracleId?: string }> = [];
    bus.on('audit:entry', (entry: unknown) => {
      const e = entry as { kind?: string; confidence?: number; oracleId?: string };
      if (e.kind === 'verdict') {
        verdictEntries.push({
          kind: e.kind,
          ...(typeof e.confidence === 'number' ? { confidence: e.confidence } : {}),
          ...(e.oracleId ? { oracleId: e.oracleId } : {}),
        });
      }
    });

    const oracleConfidence = 0.9;
    const deps = {
      bus,
      injectDependencyRegistry: registry,
      perception: {
        assemble: async () => ({
          taskTarget: { file: 'src/foo.ts', description: 'x' },
          dependencyCone: { directImporters: [], directImportees: [], transitiveBlastRadius: 0 },
          diagnostics: { lintWarnings: [], typeErrors: [], failingTests: [] },
          verifiedFacts: [],
          runtime: { nodeVersion: '20', os: 'linux', availableTools: [] },
        }),
      },
      riskRouter: {
        assessInitialLevel: async () => ({
          level: 1,
          model: 'mock/fast',
          budgetTokens: 5000,
          latencyBudgetMs: 2000,
        }),
      },
      selfModel: {
        predict: async (input: { id: string }) => ({
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
          mutations: [{ file: 'src/foo.ts', content: 'x', diff: 'x', explanation: 'x' }],
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
              oracleName: 'ast',
              type: 'known' as const,
              verified: true,
              confidence: oracleConfidence,
              evidence: [],
              fileHashes: {},
              durationMs: 10,
            },
          },
          reason: 'ok',
          aggregateConfidence: oracleConfidence,
        }),
      },
      traceCollector: {
        record: async () => {},
      },
      explorationEpsilon: 0,
    } as unknown as Parameters<typeof executeTask>[1];

    await executeTask(
      {
        id: 't-undiscounted',
        source: 'cli',
        goal: 'verify A5 baseline (no inject)',
        taskType: 'code',
        budget: { maxTokens: 10_000, maxDurationMs: 5_000, maxRetries: 1 },
        targetFiles: ['src/foo.ts'],
      },
      deps,
    );

    const astVerdicts = verdictEntries.filter((v) => v.oracleId === 'ast');
    expect(astVerdicts.length).toBeGreaterThan(0);
    expect(astVerdicts[0]!.confidence).toBe(oracleConfidence);

    registry.detach();
  });
});
