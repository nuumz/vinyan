/**
 * Migration 025 — verifies the one-shot backfill of `task_events.session_id`
 * for rows that landed as NULL because their emitter omitted sessionId.
 */
import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { migration001 } from '../../src/db/migrations/001_initial_schema.ts';
import { migration025 } from '../../src/db/migrations/025_task_events_session_backfill.ts';
import { MigrationRunner } from '../../src/db/migrations/migration-runner.ts';

function setupDbAtVersion024(): Database {
  const db = new Database(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  // Run only the migrations we need — 001 for the base schema, 017 for the
  // task_events table. The 025 backfill doesn't depend on anything else.
  new MigrationRunner().migrate(db, [migration001]);
  return db;
}

function insertEvent(
  db: Database,
  opts: {
    id: string;
    taskId: string;
    sessionId: string | null;
    seq: number;
    eventType: string;
    ts: number;
  },
) {
  db.prepare(
    `INSERT INTO task_events (id, task_id, session_id, seq, event_type, payload_json, ts)
     VALUES ($id, $task_id, $session_id, $seq, $event_type, '{}', $ts)`,
  ).run({
    $id: opts.id,
    $task_id: opts.taskId,
    $session_id: opts.sessionId,
    $seq: opts.seq,
    $event_type: opts.eventType,
    $ts: opts.ts,
  });
}

describe('Migration 025 — session_id backfill', () => {
  test('copies session_id onto NULL siblings of the same task', () => {
    const db = setupDbAtVersion024();
    // Mixed rows for a single task: task:start carries session_id, the
    // workflow emits land as NULL.
    insertEvent(db, { id: 't1-1', taskId: 't1', sessionId: 'sess-A', seq: 1, eventType: 'task:start', ts: 100 });
    insertEvent(db, { id: 't1-2', taskId: 't1', sessionId: null, seq: 2, eventType: 'agent:plan_update', ts: 110 });
    insertEvent(db, { id: 't1-3', taskId: 't1', sessionId: null, seq: 3, eventType: 'workflow:plan_ready', ts: 120 });

    migration025.up(db);

    const rows = db
      .query<{ id: string; session_id: string | null }, []>('SELECT id, session_id FROM task_events ORDER BY seq')
      .all();
    expect(rows.every((r) => r.session_id === 'sess-A')).toBe(true);
  });

  test('does not cross-contaminate session_id between different tasks', () => {
    const db = setupDbAtVersion024();
    insertEvent(db, { id: 'a-1', taskId: 'a', sessionId: 'sess-A', seq: 1, eventType: 'task:start', ts: 100 });
    insertEvent(db, { id: 'a-2', taskId: 'a', sessionId: null, seq: 2, eventType: 'agent:plan_update', ts: 110 });
    insertEvent(db, { id: 'b-1', taskId: 'b', sessionId: 'sess-B', seq: 1, eventType: 'task:start', ts: 200 });
    insertEvent(db, { id: 'b-2', taskId: 'b', sessionId: null, seq: 2, eventType: 'agent:plan_update', ts: 210 });

    migration025.up(db);

    const aSession = db.query<{ session_id: string }, [string]>('SELECT session_id FROM task_events WHERE id = ?').get('a-2');
    const bSession = db.query<{ session_id: string }, [string]>('SELECT session_id FROM task_events WHERE id = ?').get('b-2');
    expect(aSession?.session_id).toBe('sess-A');
    expect(bSession?.session_id).toBe('sess-B');
  });

  test('leaves rows untouched when no sibling row carries session_id', () => {
    const db = setupDbAtVersion024();
    // Pathological case: every event for this task is NULL — no source of
    // truth to recover. Backfill must be a no-op rather than fabricate data.
    insertEvent(db, { id: 'orphan-1', taskId: 'orphan', sessionId: null, seq: 1, eventType: 'agent:plan_update', ts: 100 });
    insertEvent(db, { id: 'orphan-2', taskId: 'orphan', sessionId: null, seq: 2, eventType: 'workflow:step_start', ts: 110 });

    migration025.up(db);

    const rows = db
      .query<{ session_id: string | null }, []>('SELECT session_id FROM task_events')
      .all();
    expect(rows.every((r) => r.session_id === null)).toBe(true);
  });

  test('idempotent — second run does nothing', () => {
    const db = setupDbAtVersion024();
    insertEvent(db, { id: 'x-1', taskId: 'x', sessionId: 'sess-X', seq: 1, eventType: 'task:start', ts: 100 });
    insertEvent(db, { id: 'x-2', taskId: 'x', sessionId: null, seq: 2, eventType: 'agent:plan_update', ts: 110 });

    migration025.up(db);
    migration025.up(db);

    const sessions = db
      .query<{ session_id: string }, []>('SELECT session_id FROM task_events ORDER BY seq')
      .all()
      .map((r) => r.session_id);
    expect(sessions).toEqual(['sess-X', 'sess-X']);
  });
});
