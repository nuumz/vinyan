/**
 * RoomStore — full CRUD roundtrip tests.
 *
 * Uses in-memory SQLite with migration 016 applied. Exercises every prepared
 * statement: insertSession, insertParticipant, insertLedgerEntry,
 * insertBlackboardEntry, updateSessionStatus, updateParticipant, and the
 * query methods (findSessionByParentTask, findLedgerByRoom, etc.).
 */
import { Database } from 'bun:sqlite';
import { describe, expect, it } from 'bun:test';
import { migration016 } from '../../src/db/migrations/016_add_room_tables.ts';
import { RoomStore } from '../../src/db/room-store.ts';
import type { LedgerEntry } from '../../src/orchestrator/room/types.ts';

function freshStore(): RoomStore {
  const db = new Database(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  migration016.up(db);
  return new RoomStore(db);
}

function makeLedgerEntry(seq: number, overrides: Partial<LedgerEntry> = {}): LedgerEntry {
  return {
    seq,
    timestamp: 1000 + seq,
    author: 'room-1::drafter-0',
    authorRole: 'drafter-0',
    type: 'propose',
    contentHash: `${'a'.repeat(63)}${seq}`,
    prevHash: seq === 0 ? '0'.repeat(64) : `${'a'.repeat(63)}${seq - 1}`,
    payload: { files: [`src/${seq}.ts`] },
    ...overrides,
  };
}

describe('RoomStore — session lifecycle', () => {
  it('insertSession + findSessionById roundtrip', () => {
    const store = freshStore();
    store.insertSession('room-1', 'task-1', '{"goal":"test"}', 'opening', 1000);
    const row = store.findSessionById('room-1');
    expect(row).not.toBeNull();
    expect(row!.parent_task_id).toBe('task-1');
    expect(row!.status).toBe('opening');
    expect(row!.rounds_used).toBe(0);
    expect(row!.tokens_consumed).toBe(0);
  });

  it('findSessionByParentTask returns the most recent session', () => {
    const store = freshStore();
    store.insertSession('room-old', 'task-1', '{}', 'converged', 500);
    store.insertSession('room-new', 'task-1', '{}', 'active', 1000);
    const row = store.findSessionByParentTask('task-1');
    expect(row!.id).toBe('room-new');
  });

  it('updateSessionStatus persists status + rounds + tokens + closedAt', () => {
    const store = freshStore();
    store.insertSession('room-1', 'task-1', '{}', 'active', 1000);
    store.updateSessionStatus('room-1', 'converged', 2, 5000, 2000);
    const row = store.findSessionById('room-1');
    expect(row!.status).toBe('converged');
    expect(row!.rounds_used).toBe(2);
    expect(row!.tokens_consumed).toBe(5000);
    expect(row!.closed_at).toBe(2000);
  });

  it('updateSessionTokens persists token/round progress without changing status', () => {
    const store = freshStore();
    store.insertSession('room-1', 'task-1', '{}', 'active', 1000);
    store.updateSessionTokens('room-1', 3000, 1);
    const row = store.findSessionById('room-1');
    expect(row!.tokens_consumed).toBe(3000);
    expect(row!.rounds_used).toBe(1);
    expect(row!.status).toBe('active');
  });
});

describe('RoomStore — participants', () => {
  it('insertParticipant + findParticipantsByRoom roundtrip', () => {
    const store = freshStore();
    store.insertSession('room-1', 'task-1', '{}', 'active', 1000);
    store.insertParticipant('room-1::drafter-0', 'room-1', 'drafter-0', 'w1', 'm1', 'admitted', 1000);
    store.insertParticipant('room-1::critic', 'room-1', 'critic', 'w2', 'm2', 'admitted', 1001);
    const rows = store.findParticipantsByRoom('room-1');
    expect(rows).toHaveLength(2);
    expect(rows[0]!.role_name).toBe('drafter-0');
    expect(rows[1]!.role_name).toBe('critic');
  });

  it('updateParticipant persists turns/tokens/status', () => {
    const store = freshStore();
    store.insertSession('room-1', 'task-1', '{}', 'active', 1000);
    store.insertParticipant('room-1::drafter-0', 'room-1', 'drafter-0', 'w1', 'm1', 'admitted', 1000);
    store.updateParticipant('room-1::drafter-0', 2, 1500, 'yielded');
    const rows = store.findParticipantsByRoom('room-1');
    expect(rows[0]!.turns_used).toBe(2);
    expect(rows[0]!.tokens_used).toBe(1500);
    expect(rows[0]!.status).toBe('yielded');
  });
});

describe('RoomStore — ledger', () => {
  it('insertLedgerEntry + findLedgerByRoom roundtrip preserves ordering', () => {
    const store = freshStore();
    store.insertSession('room-1', 'task-1', '{}', 'active', 1000);
    store.insertLedgerEntry('room-1', makeLedgerEntry(0));
    store.insertLedgerEntry(
      'room-1',
      makeLedgerEntry(1, { author: 'room-1::critic', authorRole: 'critic', type: 'affirm' }),
    );
    store.insertLedgerEntry(
      'room-1',
      makeLedgerEntry(2, { author: 'room-1::integrator', authorRole: 'integrator', type: 'claim' }),
    );
    const rows = store.findLedgerByRoom('room-1');
    expect(rows).toHaveLength(3);
    expect(rows[0]!.seq).toBe(0);
    expect(rows[1]!.entry_type).toBe('affirm');
    expect(rows[2]!.entry_type).toBe('claim');
  });

  it('payload is preserved through JSON serialization', () => {
    const store = freshStore();
    store.insertSession('room-1', 'task-1', '{}', 'active', 1000);
    const entry = makeLedgerEntry(0, { payload: { files: ['a.ts', 'b.ts'], mutationCount: 2 } });
    store.insertLedgerEntry('room-1', entry);
    const rows = store.findLedgerByRoom('room-1');
    const parsed = JSON.parse(rows[0]!.payload_json);
    expect(parsed.files).toEqual(['a.ts', 'b.ts']);
    expect(parsed.mutationCount).toBe(2);
  });
});

describe('RoomStore — blackboard', () => {
  it('insertBlackboardEntry + findBlackboardByRoom preserves versioning', () => {
    const store = freshStore();
    store.insertSession('room-1', 'task-1', '{}', 'active', 1000);
    store.insertBlackboardEntry('room-1', 'draft/0/mutations', 0, '[]', 'drafter-0', 1000);
    store.insertBlackboardEntry('room-1', 'draft/0/mutations', 1, '[{"file":"a.ts"}]', 'drafter-0', 1100);
    store.insertBlackboardEntry('room-1', 'critique/concerns', 0, '["type error"]', 'critic', 1200);
    const rows = store.findBlackboardByRoom('room-1');
    expect(rows).toHaveLength(3);
    expect(rows.filter((r) => r.key === 'draft/0/mutations')).toHaveLength(2);
  });

  it('INSERT OR REPLACE updates existing (room_id, key, version) entry', () => {
    const store = freshStore();
    store.insertSession('room-1', 'task-1', '{}', 'active', 1000);
    store.insertBlackboardEntry('room-1', 'critique/concerns', 0, '["v1"]', 'critic', 1000);
    store.insertBlackboardEntry('room-1', 'critique/concerns', 0, '["v1-updated"]', 'critic', 1100);
    const rows = store.findBlackboardByRoom('room-1');
    const row = rows.find((r) => r.key === 'critique/concerns' && r.version === 0);
    expect(JSON.parse(row!.value_json)).toEqual(['v1-updated']);
  });
});
