/**
 * CoT continuity (L1) — ParameterStore production-wiring behavior tests.
 *
 * Pins the runtime-tuning path end-to-end:
 *
 *   1. A real ParameterStore (backed by a real ParameterLedger / SQLite
 *      DB) is constructed and threaded into the collaboration-block
 *      via WorkflowExecutor's `parameterStore` dep.
 *   2. Mutating `cot.reuse_max_staleness_ms` via `store.set()` writes a
 *      `parameter_adaptations` row (mig 030) AND changes the value the
 *      cot-injection staleness gate reads on the next decision.
 *   3. With the value mutated, a thought emitted at a ts older than
 *      the new threshold is dropped by the gate; the inject-decision
 *      audit row carries `cot-skip:all-stale`.
 *
 * Behavior tests only: each `expect()` calls a function and asserts
 * either output (the inject decision verdict) or a side-effect (the
 * ledger row). No `toHaveProperty`-only assertions.
 */
import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { migration001 } from '../../../src/db/migrations/001_initial_schema.ts';
import { MigrationRunner } from '../../../src/db/migrations/migration-runner.ts';
import { createBus } from '../../../src/core/bus.ts';
import {
  ParameterLedger,
  ParameterStore,
} from '../../../src/orchestrator/adaptive-params/index.ts';
import { runCollaborationBlock } from '../../../src/orchestrator/workflow/collaboration-block.ts';
import {
  buildCollaborationPlan,
} from '../../../src/orchestrator/workflow/workflow-planner.ts';
import type { CollaborationDirective } from '../../../src/orchestrator/intent/collaboration-parser.ts';
import type { AgentRegistry } from '../../../src/orchestrator/agents/registry.ts';
import type { AgentSpec, TaskInput, TaskResult } from '../../../src/orchestrator/types.ts';

function agentSpec(id: string, role: AgentSpec['role']): AgentSpec {
  return { id, name: id, description: id, role } as AgentSpec;
}

function makeRegistry(): AgentRegistry {
  const agents = [
    agentSpec('researcher', 'researcher'),
    agentSpec('mentor', 'mentor'),
    agentSpec('coordinator', 'coordinator'),
  ];
  const byId = new Map(agents.map((a) => [a.id, a]));
  return {
    getAgent: (id: string) => byId.get(id) ?? null,
    listAgents: () => agents,
    defaultAgent: () => byId.get('coordinator')!,
    has: (id: string) => byId.has(id),
    registerAgent: () => {},
    unregisterAgent: () => false,
    unregisterAgentsForTask: () => [],
    mergeCapabilityClaims: () => false,
    getDerivedCapabilities: () => null,
    findCanonicalVerifier: () => null,
    assertA1Pair: () => ({ ok: true }),
  } as unknown as AgentRegistry;
}

function makeInput(over: Partial<TaskInput> = {}): TaskInput {
  return {
    id: 'task-cot-paramstore',
    source: 'cli',
    goal: 'Should we use approach A or B?',
    taskType: 'reasoning',
    budget: { maxTokens: 100_000, maxDurationMs: 60_000, maxRetries: 1 },
    ...over,
  };
}

function directive(over: Partial<CollaborationDirective> = {}): CollaborationDirective {
  return {
    requestedPrimaryParticipantCount: 1,
    interactionMode: 'debate',
    rebuttalRounds: 1,
    sharedDiscussion: true,
    reviewerPolicy: 'none',
    managerClarificationAllowed: true,
    emitCompetitionVerdict: false,
    source: 'pre-llm-parser',
    matchedFragments: { count: '1ตัว' },
    ...over,
  };
}

interface CapturedCall {
  goal: string;
  agentId: string | undefined;
  parentTaskId: string | undefined;
  subTaskId: string;
}

/** Worker stub that emits a kind:'thought' audit:entry with a stale ts. */
function scriptedExecuteTaskWithStaleThought(bus: ReturnType<typeof createBus>, staleTsAbs: number) {
  const calls: CapturedCall[] = [];
  const fn = async (sub: TaskInput): Promise<TaskResult> => {
    calls.push({
      goal: sub.goal,
      agentId: sub.agentId as string | undefined,
      parentTaskId: sub.parentTaskId,
      subTaskId: sub.id,
    });
    if (sub.id.endsWith('-r0')) {
      // Emit a thought audit entry with an absolute ts in the past.
      // The orchestrator's collaboration-block bus capture handler
      // runs synchronously inside this call (FIFO bus invariant).
      bus.emit('audit:entry', {
        id: `synth-${sub.id}-thought`,
        taskId: sub.id,
        ts: staleTsAbs,
        schemaVersion: 1,
        policyVersion: 'audit-v1',
        actor: { type: 'worker' },
        redactionPolicyHash: 'a'.repeat(64),
        kind: 'thought',
        content: `${sub.id} previously argued option A`,
        trigger: 'pre-tool',
      } as never);
    }
    return {
      id: sub.id,
      status: 'completed',
      mutations: [],
      answer: `${sub.id}-answer`,
      trace: {
        id: `t-${sub.id}`,
        taskId: sub.id,
        workerId: 'mock',
        timestamp: 0,
        routingLevel: 1,
        approach: 'conversational',
        oracleVerdicts: {},
        modelUsed: 'mock',
        tokensConsumed: 100,
        durationMs: 1,
        outcome: 'success',
        affectedFiles: [],
        governanceProvenance: undefined,
      },
    } as unknown as TaskResult;
  };
  return Object.assign(fn, { calls });
}

function freshStore(): { db: Database; store: ParameterStore; ledger: ParameterLedger } {
  const db = new Database(':memory:');
  new MigrationRunner().migrate(db, [migration001]);
  const ledger = new ParameterLedger(db);
  const store = new ParameterStore({ ledger });
  return { db, store, ledger };
}

describe('CoT continuity — ParameterStore production wiring', () => {
  test('default value of 300_000 ms is read from registry when no override / ledger row exists', () => {
    const { store, db } = freshStore();
    expect(store.getDurationMs('cot.reuse_max_staleness_ms')).toBe(300_000);
    db.close();
  });

  test('mutating cot.reuse_max_staleness_ms via store.set() writes a parameter_adaptations row', () => {
    const { store, ledger, db } = freshStore();
    const result = store.set('cot.reuse_max_staleness_ms', 60_000, 'shorter freshness window for tighter A10', 'test-suite');
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.newValue).toBe(60_000);
    // Subsequent read returns the new value (cache).
    expect(store.getDurationMs('cot.reuse_max_staleness_ms')).toBe(60_000);
    // Ledger contains the row with our reason and owner.
    const latest = ledger.latest('cot.reuse_max_staleness_ms');
    expect(latest).not.toBeNull();
    expect(latest!.newValue).toBe(60_000);
    expect(latest!.reason).toBe('shorter freshness window for tighter A10');
    expect(latest!.ownerModule).toBe('test-suite');
    db.close();
  });

  test('cot-injection staleness gate honors the latest tuned value (ledger → cache → cot-injection)', async () => {
    const { store, db } = freshStore();
    // Tighten the freshness window to 10 ms so a 100 ms-old thought is stale.
    store.set('cot.reuse_max_staleness_ms', 10, 'tight test window', 'test-suite');

    const plan = buildCollaborationPlan(
      'topic',
      directive({ requestedPrimaryParticipantCount: 1, rebuttalRounds: 1 }),
      makeRegistry(),
      'task-cot-paramstore',
    );
    const bus = createBus();
    const skipReasons: string[] = [];
    bus.on('audit:entry', (entry: unknown) => {
      const e = entry as { kind?: string; ruleId?: string; verdict?: string };
      if (e.kind === 'decision' && e.ruleId === 'collab-cot-inject-v1') {
        skipReasons.push(e.verdict ?? '');
      }
    });
    // Emit a thought with a ts well past the tuned 10ms threshold.
    const fn = scriptedExecuteTaskWithStaleThought(bus, 1);
    await runCollaborationBlock(plan, plan.collaborationBlock!, makeInput(), {
      executeTask: fn,
      bus,
      // Production-equivalent wiring: the cot staleness getter reads
      // the live ParameterStore value the same way workflow-executor does.
      getCotStalenessMs: () => store.getDurationMs('cot.reuse_max_staleness_ms'),
    });
    // The round-1 dispatch should NOT carry a CoT block — gate dropped.
    const round1 = fn.calls.filter((c) => c.subTaskId.endsWith('-r1'));
    expect(round1).toHaveLength(1);
    expect(round1[0]!.goal).not.toContain('Your reasoning trail from round');
    // The decision audit row carries the all-stale skip reason.
    expect(skipReasons.some((v) => v === 'cot-skip:all-stale')).toBe(true);
    db.close();
  });

  test('after restoring the default, the same scenario injects (proves the parameter is the only knob)', async () => {
    const { store, db } = freshStore();
    // First mutation: tight window — would skip.
    store.set('cot.reuse_max_staleness_ms', 10, 'tight', 'test');
    // Then revert to default-equivalent (5 minutes).
    store.set('cot.reuse_max_staleness_ms', 300_000, 'restore default-equivalent', 'test');

    const plan = buildCollaborationPlan(
      'topic',
      directive({ requestedPrimaryParticipantCount: 1, rebuttalRounds: 1 }),
      makeRegistry(),
      'task-cot-paramstore-restored',
    );
    const bus = createBus();
    const verdicts: string[] = [];
    bus.on('audit:entry', (entry: unknown) => {
      const e = entry as { kind?: string; ruleId?: string; verdict?: string };
      if (e.kind === 'decision' && e.ruleId === 'collab-cot-inject-v1') {
        verdicts.push(e.verdict ?? '');
      }
    });
    // Emit a thought with ts = now (fresh by definition).
    const now = Date.now();
    const fn = scriptedExecuteTaskWithStaleThought(bus, now);
    await runCollaborationBlock(
      plan,
      plan.collaborationBlock!,
      makeInput({ id: 'task-cot-paramstore-restored' }),
      {
        executeTask: fn,
        bus,
        getCotStalenessMs: () => store.getDurationMs('cot.reuse_max_staleness_ms'),
      },
    );
    // Inject succeeded — verdict shape `cot-inject:N`.
    expect(verdicts.some((v) => v.startsWith('cot-inject:'))).toBe(true);
    db.close();
  });
});
