/**
 * R5 — ApprovalGate ↔ ApprovalLedgerStore integration.
 *
 * Verifies:
 *   - pending row created before bus emit
 *   - ledger_pending event fires
 *   - resolve updates ledger before promise settles
 *   - timeout updates ledger
 *   - clear() during shutdown rejects ledger rows
 *   - getOrphanedPending surfaces rows not tracked by current process
 *   - supersedeForRetry transitions parent's pending rows
 *   - legacy callers (no ledger) still work byte-identically
 */
import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { ApprovalLedgerStore } from '../../src/db/approval-ledger-store.ts';
import { migration001 } from '../../src/db/migrations/001_initial_schema.ts';
import { MigrationRunner } from '../../src/db/migrations/migration-runner.ts';
import { ApprovalGate } from '../../src/orchestrator/approval-gate.ts';
import { EventBus, type VinyanBusEvents } from '../../src/core/bus.ts';

function freshDb(): Database {
  const db = new Database(':memory:');
  new MigrationRunner().migrate(db, [migration001]);
  return db;
}

let db: Database;
let bus: EventBus<VinyanBusEvents>;
let ledger: ApprovalLedgerStore;

beforeEach(() => {
  db = freshDb();
  bus = new EventBus<VinyanBusEvents>();
  ledger = new ApprovalLedgerStore(db);
});

afterEach(() => {
  db.close();
});

describe('ApprovalGate + ledger — happy path', () => {
  test('createPending row exists before bus emit (ledger-first ordering)', async () => {
    const gate = new ApprovalGate(bus, { ledger, timeoutMs: 60_000 });
    let pendingRowAtEmit = 0;
    bus.on('task:approval_required', () => {
      // At the moment the legacy bus event fires, the durable row must
      // already exist on disk.
      pendingRowAtEmit = ledger.listPending().length;
    });
    const promise = gate.requestApproval('t-1', 0.7, 'high risk');
    expect(pendingRowAtEmit).toBe(1);
    expect(ledger.findOpenByTask('t-1')).not.toBeNull();
    gate.resolve('t-1', 'approved', 'alice');
    await expect(promise).resolves.toBe('approved');
  });

  test('resolve updates ledger to approved with resolvedBy=alice', async () => {
    const gate = new ApprovalGate(bus, { ledger, timeoutMs: 60_000 });
    const promise = gate.requestApproval('t-2', 0.5, 'reason');
    gate.resolve('t-2', 'approved', 'alice');
    await promise;
    const rows = ledger.findByTask('t-2');
    expect(rows.length).toBe(1);
    expect(rows[0]?.status).toBe('approved');
    expect(rows[0]?.resolvedBy).toBe('alice');
    expect(rows[0]?.source).toBe('human');
  });

  test('emits approval:ledger_pending and approval:ledger_resolved', async () => {
    const gate = new ApprovalGate(bus, { ledger, timeoutMs: 60_000 });
    const pendingEvts: VinyanBusEvents['approval:ledger_pending'][] = [];
    const resolvedEvts: VinyanBusEvents['approval:ledger_resolved'][] = [];
    bus.on('approval:ledger_pending', (p) => pendingEvts.push(p));
    bus.on('approval:ledger_resolved', (p) => resolvedEvts.push(p));

    const promise = gate.requestApproval('t-3', 0.6, 'r', { profile: 'default', sessionId: 's-1' });
    gate.resolve('t-3', 'rejected', 'bob');
    await promise;

    expect(pendingEvts.length).toBe(1);
    expect(pendingEvts[0]?.taskId).toBe('t-3');
    expect(pendingEvts[0]?.profile).toBe('default');
    expect(pendingEvts[0]?.sessionId).toBe('s-1');

    expect(resolvedEvts.length).toBe(1);
    expect(resolvedEvts[0]?.status).toBe('rejected');
    expect(resolvedEvts[0]?.resolvedBy).toBe('bob');
  });
});

describe('ApprovalGate + ledger — timeout path', () => {
  test('timeout updates ledger to timed_out', async () => {
    const gate = new ApprovalGate(bus, { ledger, timeoutMs: 5 });
    const result = await gate.requestApproval('t-4', 0.5, 'r');
    expect(result).toBe('rejected');
    const rows = ledger.findByTask('t-4');
    expect(rows[0]?.status).toBe('timed_out');
    expect(rows[0]?.source).toBe('timeout');
  });
});

describe('ApprovalGate + ledger — shutdown', () => {
  test('clear() rejects all pending ledger rows', () => {
    const gate = new ApprovalGate(bus, { ledger, timeoutMs: 60_000 });
    void gate.requestApproval('a', 0.5, 'r');
    void gate.requestApproval('b', 0.5, 'r');
    expect(ledger.listPending().length).toBe(2);
    gate.clear();
    expect(ledger.listPending().length).toBe(0);
    const aRow = ledger.findByTask('a')[0]!;
    expect(aRow.status).toBe('shutdown_rejected');
    expect(aRow.source).toBe('shutdown');
  });
});

describe('ApprovalGate + ledger — restart durability', () => {
  test('orphaned pending rows visible via getOrphanedPending', () => {
    // Simulate previous process: write a pending row directly via a
    // first ApprovalGate instance and forcibly drop the in-memory map
    // (i.e., process restart).
    const prev = new ApprovalGate(bus, { ledger, timeoutMs: 60_000 });
    void prev.requestApproval('zombie', 0.5, 'r');
    expect(ledger.listPending().length).toBe(1);

    // New process: no in-memory entry but the ledger row remains.
    const fresh = new ApprovalGate(new EventBus<VinyanBusEvents>(), { ledger, timeoutMs: 60_000 });
    expect(fresh.getPending().length).toBe(0); // in-memory empty
    const orphans = fresh.getOrphanedPending();
    expect(orphans?.length).toBe(1);
    expect(orphans?.[0]?.taskId).toBe('zombie');
  });
});

describe('ApprovalGate + ledger — supersede for retry', () => {
  test('parent pending → superseded with retry attribution', () => {
    const gate = new ApprovalGate(bus, { ledger, timeoutMs: 60_000 });
    void gate.requestApproval('parent-task', 0.5, 'r');
    const supersededEvts: VinyanBusEvents['approval:ledger_superseded'][] = [];
    bus.on('approval:ledger_superseded', (p) => supersededEvts.push(p));

    const count = gate.supersedeForRetry('parent-task', 'child-task');
    expect(count).toBe(1);
    expect(supersededEvts.length).toBe(1);
    expect(supersededEvts[0]?.parentTaskId).toBe('parent-task');
    expect(supersededEvts[0]?.childTaskId).toBe('child-task');

    const rows = ledger.findByTask('parent-task');
    expect(rows[0]?.status).toBe('superseded');
    expect(rows[0]?.resolvedBy).toBe('retry:child-task');
  });
});

describe('ApprovalGate + ledger — idempotency on duplicate slot', () => {
  test('duplicate request creates one ledger row and emits each lifecycle event once', async () => {
    const gate = new ApprovalGate(bus, { ledger, timeoutMs: 60_000 });
    const requiredEvents: VinyanBusEvents['task:approval_required'][] = [];
    const ledgerPendingEvents: VinyanBusEvents['approval:ledger_pending'][] = [];
    const dupEvents: VinyanBusEvents['approval:duplicate_request_ignored'][] = [];
    bus.on('task:approval_required', (p) => requiredEvents.push(p));
    bus.on('approval:ledger_pending', (p) => ledgerPendingEvents.push(p));
    bus.on('approval:duplicate_request_ignored', (p) => dupEvents.push(p));

    const p1 = gate.requestApproval('t-dup', 0.7, 'first');
    const p2 = gate.requestApproval('t-dup', 0.99, 'second');

    expect(requiredEvents.length).toBe(1);
    expect(ledgerPendingEvents.length).toBe(1);
    expect(ledger.findByTask('t-dup').length).toBe(1);
    expect(ledger.listPending().length).toBe(1);
    expect(dupEvents.length).toBe(1);
    expect(dupEvents[0]?.ledgerDuplicate).toBe(false);

    gate.resolve('t-dup', 'approved', 'alice');
    const [d1, d2] = await Promise.all([p1, p2]);
    expect(d1).toBe('approved');
    expect(d2).toBe('approved');

    // One row, one resolved transition.
    const rows = ledger.findByTask('t-dup');
    expect(rows.length).toBe(1);
    expect(rows[0]?.status).toBe('approved');
  });

  test('orphan ledger row from prior process: duplicate_request rejected with diagnostic, no new live gate', async () => {
    // Simulate a previous process leaving a pending ledger row by
    // creating one directly via the store.
    const orphan = ledger.createPending({
      taskId: 't-orphan',
      approvalKey: 'default',
      riskScore: 0.5,
      reason: 'orphan',
    });
    expect(orphan.ok).toBe(true);

    // Fresh gate — empty in-memory map, sees ledger duplicate_pending.
    const gate = new ApprovalGate(bus, { ledger, timeoutMs: 60_000 });
    const requiredEvents: VinyanBusEvents['task:approval_required'][] = [];
    const dupEvents: VinyanBusEvents['approval:duplicate_request_ignored'][] = [];
    bus.on('task:approval_required', (p) => requiredEvents.push(p));
    bus.on('approval:duplicate_request_ignored', (p) => dupEvents.push(p));

    const decision = await gate.requestApproval('t-orphan', 0.5, 'new-process');
    expect(decision).toBe('rejected');
    // No second user-facing approval card created.
    expect(requiredEvents.length).toBe(0);
    // Diagnostic fired with the ledger-duplicate flag.
    expect(dupEvents.length).toBe(1);
    expect(dupEvents[0]?.ledgerDuplicate).toBe(true);
    // The orphan row is still on disk and discoverable for operator
    // action — we did not silently overwrite or co-opt it.
    expect(ledger.listPending().length).toBe(1);
    const orphans = gate.getOrphanedPending();
    expect(orphans?.length).toBe(1);
    expect(orphans?.[0]?.taskId).toBe('t-orphan');
  });
});

describe('ApprovalGate — legacy (no ledger) backwards-compat', () => {
  test('legacy 2-arg constructor still works', async () => {
    const gate = new ApprovalGate(bus, 60_000);
    const events: VinyanBusEvents['task:approval_required'][] = [];
    bus.on('task:approval_required', (p) => events.push(p));
    const promise = gate.requestApproval('legacy', 0.5, 'r');
    expect(events.length).toBe(1);
    gate.resolve('legacy', 'approved');
    await expect(promise).resolves.toBe('approved');
    // No ledger means orphan probe returns null.
    expect(gate.getOrphanedPending()).toBeNull();
  });
});
