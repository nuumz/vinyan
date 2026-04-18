import { describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';

import { createBus } from '../../../src/core/bus.ts';
import { buildEcosystem } from '../../../src/orchestrator/ecosystem/index.ts';
import { migration031 } from '../../../src/db/migrations/031_add_agent_runtime.ts';
import { migration032 } from '../../../src/db/migrations/032_add_commitments.ts';
import { migration033 } from '../../../src/db/migrations/033_add_teams.ts';
import { migration034 } from '../../../src/db/migrations/034_add_volunteer.ts';
import type { TaskFacts } from '../../../src/orchestrator/ecosystem/commitment-bridge.ts';
import type { ReasoningEngine } from '../../../src/orchestrator/types.ts';

function makeDb(): Database {
  const db = new Database(':memory:');
  // Run the four ecosystem migrations in order
  migration031.up(db);
  migration032.up(db);
  migration033.up(db);
  migration034.up(db);
  return db;
}

function makeTrace(taskId: string, outcome: 'success' | 'failure' | 'escalated' = 'success') {
  return {
    id: `trace-${taskId}`,
    taskId,
    timestamp: 2_000_000,
    routingLevel: 1,
    approach: 'test',
    oracleVerdicts: { ast: outcome === 'success' },
    modelUsed: 'test',
    tokensConsumed: 10,
    durationMs: 10,
    outcome,
    affectedFiles: [],
  } as unknown as import('../../../src/orchestrator/types.ts').ExecutionTrace;
}

function makeEngine(id: string, caps: string[]): Pick<ReasoningEngine, 'id' | 'capabilities'> {
  return { id, capabilities: caps };
}

describe('EcosystemCoordinator — integration smoke', () => {
  it('covers a full bid → work → deliver cycle end-to-end', () => {
    const db = makeDb();
    const bus = createBus();

    const tasks = new Map<string, TaskFacts>();
    tasks.set('t-1', {
      goal: 'refactor auth module',
      targetFiles: ['src/auth.ts'],
      deadlineAt: 9_999_999_999,
    });

    const engines: Array<ReturnType<typeof makeEngine>> = [
      makeEngine('eng-a', ['code-generation', 'tool-use']),
      makeEngine('eng-b', ['reasoning', 'text-generation']),
    ];

    const { coordinator, runtime, commitments } = buildEcosystem({
      db,
      bus,
      departments: [
        { id: 'code', anchorCapabilities: ['code-generation', 'tool-use'], minMatchCount: 2 },
        { id: 'research', anchorCapabilities: ['reasoning'], minMatchCount: 1 },
      ],
      taskResolver: (id) => tasks.get(id) ?? null,
      engineRoster: () => engines,
    });

    coordinator.start();

    // Department index should know where each engine belongs
    expect(coordinator.departmentIndex.getEnginesInDepartment('code')).toContain('eng-a');
    expect(coordinator.departmentIndex.getEnginesInDepartment('research')).toContain('eng-b');

    // Bring eng-a online through the runtime FSM
    runtime.register('eng-a');
    runtime.awaken('eng-a');
    runtime.markReady('eng-a');

    // Simulate an auction win — this opens a commitment automatically via the bridge
    bus.emit('market:auction_completed', {
      auctionId: 't-1',
      winnerId: 'eng-a',
      score: 0.85,
      bidderCount: 2,
    });

    // Bid accepted → engine flips to working + open commitment exists
    runtime.markWorking('eng-a', 't-1');
    expect(commitments.openByEngine('eng-a')).toHaveLength(1);
    expect(runtime.get('eng-a')!.state).toBe('working');

    // Reconcile while working — no violations
    const mid = coordinator.reconcile();
    expect(mid.violations).toHaveLength(0);

    // Finish the task — success trace resolves the commitment; runtime flips back
    bus.emit('trace:record', { trace: makeTrace('t-1', 'success') });
    runtime.markTaskComplete('eng-a', 't-1');

    expect(commitments.openByEngine('eng-a')).toHaveLength(0);
    expect(runtime.get('eng-a')!.state).toBe('standby');

    // Final reconcile — clean slate, no violations
    const end = coordinator.reconcile();
    expect(end.violations).toHaveLength(0);

    coordinator.stop();
  });

  it('reconcile() surfaces an I-E1 violation when Working engine has no commitment', () => {
    const db = makeDb();
    const bus = createBus();

    const { coordinator, runtime } = buildEcosystem({
      db,
      bus,
      taskResolver: () => null,
      engineRoster: () => [],
    });
    coordinator.start();

    // Put an engine in Working without any commitment
    runtime.register('rogue');
    runtime.awaken('rogue');
    runtime.markReady('rogue');
    runtime.markWorking('rogue', 'phantom-task');

    const report = coordinator.reconcile();
    const e1 = report.violations.filter((v) => v.id === 'I-E1');
    expect(e1).toHaveLength(1);
    expect(e1[0]!.subject).toBe('rogue');

    coordinator.stop();
  });

  it('reconcile() surfaces an I-E2 violation when Standby engine holds an open commitment', () => {
    const db = makeDb();
    const bus = createBus();

    const tasks = new Map<string, TaskFacts>();
    tasks.set('t-orphan', { goal: 'g', targetFiles: [], deadlineAt: 9_999_999_999 });

    const { coordinator, runtime, commitments } = buildEcosystem({
      db,
      bus,
      taskResolver: (id) => tasks.get(id) ?? null,
      engineRoster: () => [],
    });
    coordinator.start();

    // Engine is Standby but we open a commitment for it directly (skipping
    // the normal Standby → Working transition)
    runtime.register('lazy');
    runtime.awaken('lazy');
    runtime.markReady('lazy');
    commitments.open({
      engineId: 'lazy',
      taskId: 't-orphan',
      goal: 'g',
      deadlineAt: 9_999_999_999,
    });

    const report = coordinator.reconcile();
    const e2 = report.violations.filter((v) => v.id === 'I-E2');
    expect(e2).toHaveLength(1);

    coordinator.stop();
  });

  it('attemptVolunteerFallback picks the highest-scored standby engine', () => {
    const db = makeDb();
    const bus = createBus();

    const { coordinator, runtime, commitments, volunteers } = buildEcosystem({
      db,
      bus,
      taskResolver: () => null,
      engineRoster: () => [],
    });
    coordinator.start();

    // Three standby engines with different scoring contexts
    for (const id of ['weak', 'strong', 'busy']) {
      runtime.register(id);
      runtime.awaken(id);
      runtime.markReady(id);
    }

    const ctx: Record<string, { capability: number; trust: number; currentLoad: number }> = {
      weak: { capability: 0.2, trust: 0.3, currentLoad: 0 },
      strong: { capability: 0.9, trust: 0.9, currentLoad: 0 },
      busy: { capability: 0.9, trust: 0.9, currentLoad: 5 },
    };

    const result = coordinator.attemptVolunteerFallback({
      taskId: 't-fallback',
      goal: 'handle this',
      targetFiles: [],
      deadlineAt: 9_999_999_999,
      contextProvider: (id) => ctx[id] ?? { capability: 0.1, trust: 0.1, currentLoad: 0 },
    });

    expect(result).not.toBeNull();
    expect(result!.engineId).toBe('strong');
    // Commitment exists for the winner
    const open = commitments.openByEngine('strong');
    expect(open).toHaveLength(1);
    expect(open[0]!.commitmentId).toBe(result!.commitmentId);

    // All offers persisted; loser offers declined
    const offers = volunteers.offersForTask('t-fallback');
    expect(offers).toHaveLength(3);
    const winner = offers.find((o) => o.engineId === 'strong')!;
    expect(winner.acceptedAt).not.toBeNull();
    expect(winner.commitmentId).toBe(result!.commitmentId);

    coordinator.stop();
  });

  it('attemptVolunteerFallback returns null when no standby engines exist', () => {
    const db = makeDb();
    const bus = createBus();
    const { coordinator } = buildEcosystem({
      db,
      bus,
      taskResolver: () => null,
      engineRoster: () => [],
    });
    coordinator.start();

    const result = coordinator.attemptVolunteerFallback({
      taskId: 't-empty',
      goal: 'g',
      deadlineAt: 9_999_999_999,
      contextProvider: () => ({ capability: 1, trust: 1, currentLoad: 0 }),
    });
    expect(result).toBeNull();

    coordinator.stop();
  });

  it('attemptVolunteerFallback narrows to department when members exist', () => {
    const db = makeDb();
    const bus = createBus();

    const engines = [
      { id: 'coder', capabilities: ['code-generation', 'tool-use'] },
      { id: 'researcher', capabilities: ['reasoning', 'text-generation'] },
    ];

    const { coordinator, runtime } = buildEcosystem({
      db,
      bus,
      departments: [
        { id: 'code', anchorCapabilities: ['code-generation'], minMatchCount: 1 },
        { id: 'research', anchorCapabilities: ['reasoning'], minMatchCount: 1 },
      ],
      taskResolver: () => null,
      engineRoster: () => engines,
    });
    coordinator.start();

    for (const eng of engines) {
      runtime.register(eng.id);
      runtime.awaken(eng.id);
      runtime.markReady(eng.id);
    }

    const result = coordinator.attemptVolunteerFallback({
      taskId: 't-scoped',
      goal: 'write code',
      deadlineAt: 9_999_999_999,
      departmentId: 'code',
      contextProvider: () => ({ capability: 0.5, trust: 0.5, currentLoad: 0 }),
    });

    expect(result).not.toBeNull();
    expect(result!.engineId).toBe('coder');

    coordinator.stop();
  });

  it('crash recovery fires on start()', () => {
    const db = makeDb();
    const bus = createBus();

    // Pre-seed an engine stuck in working (simulates crash mid-task)
    const { runtime: preRuntime } = buildEcosystem({
      db,
      bus: createBus(),
      taskResolver: () => null,
      engineRoster: () => [],
    });
    preRuntime.register('survivor');
    preRuntime.awaken('survivor');
    preRuntime.markReady('survivor');
    preRuntime.markWorking('survivor', 't-crash');
    // Don't call stop — simulate crash

    // Second coordinator on the same DB runs crash-recovery on start
    const { coordinator, runtime } = buildEcosystem({
      db,
      bus,
      taskResolver: () => null,
      engineRoster: () => [],
    });
    coordinator.start();

    expect(runtime.get('survivor')!.state).toBe('standby');
    expect(runtime.get('survivor')!.activeTaskCount).toBe(0);

    coordinator.stop();
  });
});
