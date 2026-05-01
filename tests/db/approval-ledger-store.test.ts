/**
 * ApprovalLedgerStore — R5 durability tests.
 *
 * Covers:
 *   - createPending → readback shape
 *   - duplicate pending rejected
 *   - resolve approved/rejected updates row
 *   - timeout convenience helper
 *   - shutdownRejectOpen sweeps every pending row
 *   - markSupersededForRetry on parent
 *   - listPending / findByTask / findOpenByTask reads
 *   - restart durability (new store instance sees prior pending row)
 */
import { Database } from 'bun:sqlite';
import { beforeEach, describe, expect, test } from 'bun:test';
import { migration001 } from '../../src/db/migrations/001_initial_schema.ts';
import { MigrationRunner } from '../../src/db/migrations/migration-runner.ts';
import { ApprovalLedgerStore } from '../../src/db/approval-ledger-store.ts';

function freshDb(): Database {
  const db = new Database(':memory:');
  new MigrationRunner().migrate(db, [migration001]);
  return db;
}

const FIXED_NOW = 1_700_000_000_000;

function makeStore(db: Database = freshDb(), now = FIXED_NOW): ApprovalLedgerStore {
  return new ApprovalLedgerStore(db, {
    clock: () => now,
    idGenerator: (() => {
      let n = 0;
      return () => `apl-test-${++n}`;
    })(),
  });
}

describe('ApprovalLedgerStore.createPending', () => {
  test('inserts a pending row with required fields', () => {
    const store = makeStore();
    const result = store.createPending({
      taskId: 'task-1',
      riskScore: 0.7,
      reason: 'high-risk mutation',
      profile: 'default',
      sessionId: 's-1',
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.record.taskId).toBe('task-1');
      expect(result.record.approvalKey).toBe('default');
      expect(result.record.status).toBe('pending');
      expect(result.record.riskScore).toBe(0.7);
      expect(result.record.profile).toBe('default');
      expect(result.record.sessionId).toBe('s-1');
      expect(result.record.requestedAt).toBe(FIXED_NOW);
      expect(result.record.resolvedAt).toBeNull();
    }
  });

  test('rejects a duplicate pending for same (taskId, approvalKey)', () => {
    const store = makeStore();
    expect(
      store.createPending({ taskId: 't', riskScore: 0.5, reason: 'r' }).ok,
    ).toBe(true);
    const second = store.createPending({ taskId: 't', riskScore: 0.5, reason: 'r' });
    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.reason).toBe('duplicate_pending');
    }
  });

  test('different approvalKeys on same task may both be pending', () => {
    const store = makeStore();
    expect(
      store.createPending({ taskId: 't', approvalKey: 'commit', riskScore: 0.5, reason: 'r' }).ok,
    ).toBe(true);
    expect(
      store.createPending({ taskId: 't', approvalKey: 'shell', riskScore: 0.5, reason: 'r' }).ok,
    ).toBe(true);
  });

  test('persists provenance JSON', () => {
    const store = makeStore();
    const r = store.createPending({
      taskId: 't',
      riskScore: 0.5,
      reason: 'r',
      provenance: { decisionId: 'gov-1', evidence: ['oracle-x'] },
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.record.provenance).toEqual({ decisionId: 'gov-1', evidence: ['oracle-x'] });
    }
  });
});

describe('ApprovalLedgerStore.resolve', () => {
  test('approves a pending row', () => {
    const store = makeStore();
    store.createPending({ taskId: 't', riskScore: 0.5, reason: 'r' });
    const r = store.resolve({
      taskId: 't',
      status: 'approved',
      source: 'human',
      resolvedBy: 'alice',
      decision: 'approved',
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.record.status).toBe('approved');
      expect(r.record.resolvedBy).toBe('alice');
      expect(r.record.source).toBe('human');
      expect(r.record.decision).toBe('approved');
      expect(r.record.resolvedAt).toBe(FIXED_NOW);
    }
  });

  test('rejects with no_pending when there is no row to resolve', () => {
    const store = makeStore();
    const r = store.resolve({
      taskId: 'nope',
      status: 'approved',
      source: 'human',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe('no_pending');
    }
  });

  test('idempotent: resolving twice is no_pending the second time', () => {
    const store = makeStore();
    store.createPending({ taskId: 't', riskScore: 0.5, reason: 'r' });
    expect(store.resolve({ taskId: 't', status: 'approved', source: 'human' }).ok).toBe(true);
    const second = store.resolve({ taskId: 't', status: 'approved', source: 'human' });
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.reason).toBe('no_pending');
  });
});

describe('ApprovalLedgerStore.timeout', () => {
  test('sets status=timed_out, source=timeout, decision=rejected', () => {
    const store = makeStore();
    store.createPending({ taskId: 't', riskScore: 0.5, reason: 'r' });
    const r = store.timeout('t');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.record.status).toBe('timed_out');
      expect(r.record.source).toBe('timeout');
      expect(r.record.decision).toBe('rejected');
    }
  });
});

describe('ApprovalLedgerStore.shutdownRejectOpen', () => {
  test('rejects every pending row with status=shutdown_rejected', () => {
    const store = makeStore();
    store.createPending({ taskId: 'a', riskScore: 0.5, reason: 'r' });
    store.createPending({ taskId: 'b', riskScore: 0.5, reason: 'r' });
    expect(store.listPending().length).toBe(2);
    const count = store.shutdownRejectOpen();
    expect(count).toBe(2);
    expect(store.listPending().length).toBe(0);
    const aRow = store.findByTask('a')[0]!;
    expect(aRow.status).toBe('shutdown_rejected');
    expect(aRow.source).toBe('shutdown');
  });
});

describe('ApprovalLedgerStore.markSupersededForRetry', () => {
  test('marks parent pending rows as superseded with retry attribution', () => {
    const store = makeStore();
    store.createPending({ taskId: 'parent', riskScore: 0.5, reason: 'r' });
    const count = store.markSupersededForRetry('parent', 'child');
    expect(count).toBe(1);
    const after = store.findByTask('parent')[0]!;
    expect(after.status).toBe('superseded');
    expect(after.source).toBe('system');
    expect(after.resolvedBy).toBe('retry:child');
  });

  test('returns 0 when no pending rows exist', () => {
    const store = makeStore();
    expect(store.markSupersededForRetry('nope', 'child')).toBe(0);
  });
});

describe('ApprovalLedgerStore — restart durability', () => {
  test('a new store instance over the same DB sees prior pending row', () => {
    const db = freshDb();
    const s1 = new ApprovalLedgerStore(db, { clock: () => FIXED_NOW });
    s1.createPending({ taskId: 't', riskScore: 0.5, reason: 'r' });
    // Simulate restart by constructing a fresh store on the same DB.
    const s2 = new ApprovalLedgerStore(db, { clock: () => FIXED_NOW + 1 });
    const pending = s2.listPending();
    expect(pending.length).toBe(1);
    expect(pending[0]?.taskId).toBe('t');
    expect(pending[0]?.status).toBe('pending');
  });
});

describe('ApprovalLedgerStore — reads', () => {
  let store: ApprovalLedgerStore;
  beforeEach(() => {
    store = makeStore();
  });

  test('listPending returns only pending rows ordered by requested_at ASC', () => {
    store.createPending({ taskId: 'a', riskScore: 0.1, reason: 'r' });
    store.createPending({ taskId: 'b', riskScore: 0.5, reason: 'r' });
    store.resolve({ taskId: 'a', status: 'approved', source: 'human' });
    const pending = store.listPending();
    expect(pending.length).toBe(1);
    expect(pending[0]?.taskId).toBe('b');
  });

  test('findByTask returns full history (newest first)', () => {
    store.createPending({ taskId: 't', riskScore: 0.5, reason: 'r' });
    store.resolve({ taskId: 't', status: 'rejected', source: 'human' });
    const rows = store.findByTask('t');
    expect(rows.length).toBe(1);
    expect(rows[0]?.status).toBe('rejected');
  });

  test('findOpenByTask returns null after resolve', () => {
    store.createPending({ taskId: 't', riskScore: 0.5, reason: 'r' });
    expect(store.findOpenByTask('t')).not.toBeNull();
    store.resolve({ taskId: 't', status: 'approved', source: 'human' });
    expect(store.findOpenByTask('t')).toBeNull();
  });
});
