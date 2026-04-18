import { beforeEach, describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { CommitmentStore } from '../../../src/db/commitment-store.ts';
import { migration032 } from '../../../src/db/migrations/032_add_commitments.ts';
import {
  CommitmentLedger,
  type CommitmentLedgerConfig,
} from '../../../src/orchestrator/ecosystem/commitment-ledger.ts';
import {
  CommitmentBridge,
  type TaskFacts,
} from '../../../src/orchestrator/ecosystem/commitment-bridge.ts';
import { createBus, type VinyanBus } from '../../../src/core/bus.ts';
import { computeGoalHash } from '../../../src/core/content-hash.ts';
import type { ExecutionTrace } from '../../../src/orchestrator/types.ts';

function makeDb(): Database {
  const db = new Database(':memory:');
  migration032.up(db);
  return db;
}

function makeLedger(overrides: Partial<CommitmentLedgerConfig> = {}) {
  const db = makeDb();
  const store = new CommitmentStore(db);
  const bus = overrides.bus ?? createBus();
  let counter = 0;
  const ledger = new CommitmentLedger({
    store,
    bus,
    now: overrides.now ?? (() => 1_000_000),
    idFactory: overrides.idFactory ?? (() => `c-${++counter}`),
  });
  return { db, store, bus, ledger };
}

function makeTrace(overrides: Partial<ExecutionTrace> = {}): ExecutionTrace {
  return {
    id: 'trace-1',
    taskId: 't-1',
    timestamp: 2_000_000,
    routingLevel: 1,
    approach: 'test',
    oracleVerdicts: { ast: true, type: true },
    modelUsed: 'test-model',
    tokensConsumed: 100,
    durationMs: 250,
    outcome: 'success',
    affectedFiles: [],
    ...overrides,
  } as ExecutionTrace;
}

describe('computeGoalHash', () => {
  it('produces stable hashes for the same inputs', () => {
    const a = computeGoalHash('fix bug', ['src/a.ts', 'src/b.ts']);
    const b = computeGoalHash('fix bug', ['src/a.ts', 'src/b.ts']);
    expect(a).toBe(b);
  });

  it('is order-independent for target files', () => {
    const a = computeGoalHash('fix', ['src/a.ts', 'src/b.ts']);
    const b = computeGoalHash('fix', ['src/b.ts', 'src/a.ts']);
    expect(a).toBe(b);
  });

  it('changes when the goal is reworded', () => {
    const a = computeGoalHash('fix bug in auth', ['src/a.ts']);
    const b = computeGoalHash('repair bug in auth', ['src/a.ts']);
    expect(a).not.toBe(b);
  });

  it('trims surrounding whitespace', () => {
    const a = computeGoalHash('   fix  ', ['src/a.ts']);
    const b = computeGoalHash('fix', ['src/a.ts']);
    expect(a).toBe(b);
  });
});

describe('CommitmentLedger.open', () => {
  it('creates a row and emits commitment:created', () => {
    const { ledger, bus } = makeLedger();
    const seen: unknown[] = [];
    bus.on('commitment:created', (p) => seen.push(p));

    const c = ledger.open({
      engineId: 'eng-1',
      taskId: 't-1',
      goal: 'fix bug',
      targetFiles: ['src/a.ts'],
      deadlineAt: 5_000_000,
    });

    expect(c.commitmentId).toBe('c-1');
    expect(c.engineId).toBe('eng-1');
    expect(c.taskId).toBe('t-1');
    expect(c.deliverableHash).toBe(computeGoalHash('fix bug', ['src/a.ts']));
    expect(c.deadlineAt).toBe(5_000_000);
    expect(c.acceptedAt).toBe(1_000_000);
    expect(c.resolvedAt).toBeNull();
    expect(seen).toHaveLength(1);
  });
});

describe('CommitmentLedger.resolve', () => {
  let bus: VinyanBus;
  let ledger: CommitmentLedger;
  let seen: unknown[];

  beforeEach(() => {
    const h = makeLedger();
    bus = h.bus;
    ledger = h.ledger;
    seen = [];
    bus.on('commitment:resolved', (p) => seen.push(p));
  });

  it('resolves an open commitment and emits commitment:resolved', () => {
    const c = ledger.open({
      engineId: 'eng-1',
      taskId: 't-1',
      goal: 'g',
      deadlineAt: 5_000_000,
    });
    const ok = ledger.resolve({
      commitmentId: c.commitmentId,
      kind: 'delivered',
      evidence: 'all oracles passed',
    });
    expect(ok).toBe(true);
    expect(seen).toHaveLength(1);
  });

  it('returns false for double-resolve', () => {
    const c = ledger.open({
      engineId: 'eng-1',
      taskId: 't-1',
      goal: 'g',
      deadlineAt: 5_000_000,
    });
    ledger.resolve({ commitmentId: c.commitmentId, kind: 'delivered', evidence: 'ok' });
    const second = ledger.resolve({
      commitmentId: c.commitmentId,
      kind: 'failed',
      evidence: 'too late',
    });
    expect(second).toBe(false);
    expect(seen).toHaveLength(1); // only first resolve emitted
  });

  it('returns false for unknown commitmentId', () => {
    expect(
      ledger.resolve({ commitmentId: 'ghost', kind: 'delivered', evidence: 'x' }),
    ).toBe(false);
  });

  it('latencyMs in the event reflects acceptedAt → resolvedAt', () => {
    let clock = 1_000_000;
    const { ledger: clocked, bus: clockedBus } = makeLedger({
      now: () => clock,
    });
    const eventSeen: Array<{ latencyMs: number }> = [];
    clockedBus.on('commitment:resolved', (p) => eventSeen.push(p));

    const c = clocked.open({
      engineId: 'e',
      taskId: 't',
      goal: 'g',
      deadlineAt: 999_999_999,
    });
    clock = 1_500_000;
    clocked.resolve({ commitmentId: c.commitmentId, kind: 'delivered', evidence: 'ok' });

    expect(eventSeen[0]!.latencyMs).toBe(500_000);
  });
});

describe('CommitmentLedger queries', () => {
  it('openByEngine returns only unresolved commitments for that engine', () => {
    const { ledger } = makeLedger();
    const c1 = ledger.open({ engineId: 'e1', taskId: 't1', goal: 'a', deadlineAt: 5e6 });
    ledger.open({ engineId: 'e1', taskId: 't2', goal: 'b', deadlineAt: 5e6 });
    ledger.open({ engineId: 'e2', taskId: 't3', goal: 'c', deadlineAt: 5e6 });
    ledger.resolve({ commitmentId: c1.commitmentId, kind: 'delivered', evidence: 'ok' });

    const openE1 = ledger.openByEngine('e1');
    const openE2 = ledger.openByEngine('e2');
    expect(openE1.map((c) => c.taskId)).toEqual(['t2']);
    expect(openE2.map((c) => c.taskId)).toEqual(['t3']);
  });

  it('expired returns commitments past deadline', () => {
    const { ledger } = makeLedger();
    ledger.open({ engineId: 'e', taskId: 't1', goal: 'a', deadlineAt: 100 });
    ledger.open({ engineId: 'e', taskId: 't2', goal: 'b', deadlineAt: 99_999_999 });

    const expired = ledger.expired(500_000);
    expect(expired.map((c) => c.taskId)).toEqual(['t1']);
  });

  it('reapExpired fails expired commitments with deadline-exceeded evidence', () => {
    const { ledger, bus } = makeLedger();
    const seen: unknown[] = [];
    bus.on('commitment:resolved', (p) => seen.push(p));
    ledger.open({ engineId: 'e', taskId: 't1', goal: 'a', deadlineAt: 100 });
    ledger.open({ engineId: 'e', taskId: 't2', goal: 'b', deadlineAt: 99_999_999 });

    const count = ledger.reapExpired(500_000);
    expect(count).toBe(1);
    expect(seen).toHaveLength(1);
  });
});

describe('CommitmentBridge', () => {
  it('opens a commitment on market:auction_completed using task facts', () => {
    const { ledger, bus } = makeLedger();
    const facts: TaskFacts = {
      goal: 'refactor auth',
      targetFiles: ['src/auth.ts'],
      deadlineAt: 5_000_000,
    };
    const bridge = new CommitmentBridge({
      ledger,
      bus,
      taskResolver: (id) => (id === 't-1' ? facts : null),
    });
    bridge.start();

    bus.emit('market:auction_completed', {
      auctionId: 't-1',
      winnerId: 'eng-winner',
      score: 0.8,
      bidderCount: 3,
    });

    const open = ledger.openByEngine('eng-winner');
    expect(open).toHaveLength(1);
    expect(open[0]!.taskId).toBe('t-1');
    expect(open[0]!.deliverableHash).toBe(
      computeGoalHash('refactor auth', ['src/auth.ts']),
    );
    bridge.stop();
  });

  it('resolves commitments on trace:record with outcome=success → delivered', () => {
    const { ledger, bus } = makeLedger();
    const bridge = new CommitmentBridge({
      ledger,
      bus,
      taskResolver: () => ({ goal: 'g', targetFiles: [], deadlineAt: 9e9 }),
    });
    bridge.start();

    bus.emit('market:auction_completed', {
      auctionId: 't-1',
      winnerId: 'eng-1',
      score: 0.5,
      bidderCount: 2,
    });
    expect(ledger.openByTask('t-1')).toHaveLength(1);

    bus.emit('trace:record', { trace: makeTrace({ taskId: 't-1', outcome: 'success' }) });

    expect(ledger.openByTask('t-1')).toHaveLength(0);
    bridge.stop();
  });

  it('maps outcome=failure → failed and outcome=escalated → transferred', () => {
    const { ledger, bus } = makeLedger();
    const resolvedEvents: Array<{ kind: string; taskId: string }> = [];
    bus.on('commitment:resolved', (p) => resolvedEvents.push(p));
    const bridge = new CommitmentBridge({
      ledger,
      bus,
      taskResolver: () => ({ goal: 'g', targetFiles: [], deadlineAt: 9e9 }),
    });
    bridge.start();

    for (const t of ['t-fail', 't-esc']) {
      bus.emit('market:auction_completed', {
        auctionId: t,
        winnerId: 'eng-1',
        score: 0.5,
        bidderCount: 1,
      });
    }

    bus.emit('trace:record', { trace: makeTrace({ taskId: 't-fail', outcome: 'failure', failureReason: 'tests red' }) });
    bus.emit('trace:record', { trace: makeTrace({ taskId: 't-esc', outcome: 'escalated' }) });

    const byTask = Object.fromEntries(resolvedEvents.map((e) => [e.taskId, e.kind]));
    expect(byTask['t-fail']).toBe('failed');
    expect(byTask['t-esc']).toBe('transferred');
    bridge.stop();
  });

  it('is idempotent — stop() detaches listeners', () => {
    const { ledger, bus } = makeLedger();
    const bridge = new CommitmentBridge({
      ledger,
      bus,
      taskResolver: () => ({ goal: 'g', targetFiles: [], deadlineAt: 9e9 }),
    });
    bridge.start();
    bridge.stop();

    bus.emit('market:auction_completed', {
      auctionId: 't-1',
      winnerId: 'eng-1',
      score: 0.5,
      bidderCount: 1,
    });
    expect(ledger.openByTask('t-1')).toHaveLength(0);
  });

  it('ignores trace:record for tasks with no open commitment', () => {
    const { ledger, bus } = makeLedger();
    const bridge = new CommitmentBridge({
      ledger,
      bus,
      taskResolver: () => null,
    });
    bridge.start();

    // Should not throw or emit anything
    bus.emit('trace:record', { trace: makeTrace({ taskId: 'unknown', outcome: 'success' }) });
    expect(ledger.openByTask('unknown')).toHaveLength(0);
    bridge.stop();
  });
});
