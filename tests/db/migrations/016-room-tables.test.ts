/**
 * Migration 016 — DDL smoke test.
 *
 * In-memory SQLite applies the migration and verifies each of the 4 room
 * tables exists and accepts a minimal INSERT / SELECT roundtrip. The tables
 * remain unused by R1 production code; this test just locks the schema.
 */
import { Database } from 'bun:sqlite';
import { describe, expect, it } from 'bun:test';
import { migration016 } from '../../../src/db/migrations/016_add_room_tables.ts';

function freshDb(): Database {
  const db = new Database(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  migration016.up(db);
  return db;
}

describe('migration016 — Agent Conversation Room tables', () => {
  it('declares the correct version + description', () => {
    expect(migration016.version).toBe(16);
    expect(migration016.description).toContain('Room');
  });

  it('creates all 4 tables', () => {
    const db = freshDb();
    const tables = db
      .query("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'room_%' ORDER BY name")
      .all() as Array<{ name: string }>;
    const names = tables.map((t) => t.name);
    expect(names).toContain('room_sessions');
    expect(names).toContain('room_participants');
    expect(names).toContain('room_ledger');
    expect(names).toContain('room_blackboard');
  });

  it('room_sessions accepts INSERT with a valid status', () => {
    const db = freshDb();
    db.run(
      `INSERT INTO room_sessions (id, parent_task_id, contract_json, status, rounds_used, tokens_consumed, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ['room-1', 'task-1', '{}', 'active', 0, 0, Date.now()],
    );
    const row = db.query('SELECT * FROM room_sessions WHERE id = ?').get('room-1') as { status: string } | null;
    expect(row?.status).toBe('active');
  });

  it('room_sessions rejects an invalid status via CHECK constraint', () => {
    const db = freshDb();
    let err: unknown;
    try {
      db.run(
        `INSERT INTO room_sessions (id, parent_task_id, contract_json, status, rounds_used, tokens_consumed, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        ['room-2', 'task-2', '{}', 'bogus-status', 0, 0, Date.now()],
      );
    } catch (e) {
      err = e;
    }
    expect(err).toBeDefined();
  });

  it('room_ledger has composite (room_id, seq) primary key', () => {
    const db = freshDb();
    db.run(
      `INSERT INTO room_sessions (id, parent_task_id, contract_json, status, rounds_used, tokens_consumed, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ['room-3', 'task-3', '{}', 'active', 0, 0, 1],
    );
    db.run(
      `INSERT INTO room_ledger (room_id, seq, timestamp, author_participant_id, author_role, entry_type, content_hash, prev_hash, payload_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ['room-3', 0, 1, 'room-3::drafter-0', 'drafter-0', 'propose', 'a'.repeat(64), '0'.repeat(64), '{}'],
    );
    // Duplicate (room_id, seq) must fail
    let err: unknown;
    try {
      db.run(
        `INSERT INTO room_ledger (room_id, seq, timestamp, author_participant_id, author_role, entry_type, content_hash, prev_hash, payload_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ['room-3', 0, 2, 'room-3::drafter-1', 'drafter-1', 'propose', 'b'.repeat(64), 'a'.repeat(64), '{}'],
      );
    } catch (e) {
      err = e;
    }
    expect(err).toBeDefined();
  });

  it('room_blackboard has composite (room_id, key, version) primary key', () => {
    const db = freshDb();
    db.run(
      `INSERT INTO room_sessions (id, parent_task_id, contract_json, status, rounds_used, tokens_consumed, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ['room-4', 'task-4', '{}', 'active', 0, 0, 1],
    );
    db.run(
      `INSERT INTO room_blackboard (room_id, key, version, value_json, author_role, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      ['room-4', 'draft/0/mutations', 0, '[]', 'drafter-0', 1],
    );
    db.run(
      `INSERT INTO room_blackboard (room_id, key, version, value_json, author_role, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      ['room-4', 'draft/0/mutations', 1, '[{"file":"a.ts"}]', 'drafter-0', 2],
    );
    const rows = db
      .query('SELECT version FROM room_blackboard WHERE room_id = ? AND key = ? ORDER BY version')
      .all('room-4', 'draft/0/mutations') as Array<{ version: number }>;
    expect(rows).toHaveLength(2);
  });

  it('room_participants foreign key references room_sessions', () => {
    const db = freshDb();
    db.run(
      `INSERT INTO room_sessions (id, parent_task_id, contract_json, status, rounds_used, tokens_consumed, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ['room-5', 'task-5', '{}', 'active', 0, 0, 1],
    );
    db.run(
      `INSERT INTO room_participants (id, room_id, role_name, worker_id, worker_model_id, turns_used, tokens_used, status, admitted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ['room-5::drafter-0', 'room-5', 'drafter-0', 'w1', 'm1', 0, 0, 'admitted', 1],
    );
    const rows = db.query('SELECT role_name FROM room_participants WHERE room_id = ?').all('room-5') as Array<{
      role_name: string;
    }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.role_name).toBe('drafter-0');
  });
});
