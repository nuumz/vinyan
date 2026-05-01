/**
 * Migration 035 — verifies cross-task `session_id` backfill via parent
 * `workflow:delegate_dispatched` rows.
 *
 * Migration 025 covered the case where a task has at least one row with
 * `session_id` set (sibling-copy). 035 covers the harder case where every
 * row for the child task is NULL — i.e. the recorder never received a
 * `task:start` for it (or received it without sessionId), and the
 * pre-`a3e9c41` recorder didn't pre-seed the sub-task session map on
 * `workflow:delegate_dispatched`. The parent's dispatch row carries the
 * authoritative session_id and `payload.subTaskId = childTaskId`; that's
 * the source of truth.
 */
import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { migration001 } from '../../src/db/migrations/001_initial_schema.ts';
import { migration025 } from '../../src/db/migrations/025_task_events_session_backfill.ts';
import { migration035 } from '../../src/db/migrations/035_task_events_cross_task_session_backfill.ts';
import { MigrationRunner } from '../../src/db/migrations/migration-runner.ts';

function setupDb(): Database {
  const db = new Database(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  // Apply 001 (base schema), 017 (task_events). 025 is applied
  // explicitly per test where the order matters.
  new MigrationRunner().migrate(db, [migration001]);
  return db;
}

interface InsertOpts {
  id: string;
  taskId: string;
  sessionId: string | null;
  seq: number;
  eventType: string;
  payload?: Record<string, unknown>;
  ts: number;
}

function insertEvent(db: Database, opts: InsertOpts): void {
  db.prepare(
    `INSERT INTO task_events (id, task_id, session_id, seq, event_type, payload_json, ts)
     VALUES ($id, $task_id, $session_id, $seq, $event_type, $payload, $ts)`,
  ).run({
    $id: opts.id,
    $task_id: opts.taskId,
    $session_id: opts.sessionId,
    $seq: opts.seq,
    $event_type: opts.eventType,
    $payload: JSON.stringify(opts.payload ?? {}),
    $ts: opts.ts,
  });
}

function sessionByRowId(db: Database): Map<string, string | null> {
  const rows = db
    .query<{ id: string; session_id: string | null }, []>(
      'SELECT id, session_id FROM task_events ORDER BY seq',
    )
    .all();
  return new Map(rows.map((r) => [r.id, r.session_id]));
}

describe('Migration 035 — cross-task session_id backfill via parent dispatch', () => {
  test('child rows that are entirely NULL get session_id from parent dispatch', () => {
    const db = setupDb();
    // Parent has session_id (recorded from task:start.input.sessionId).
    insertEvent(db, {
      id: 'p-1',
      taskId: 'parent',
      sessionId: 'sess-A',
      seq: 1,
      eventType: 'task:start',
      payload: { input: { id: 'parent', sessionId: 'sess-A' } },
      ts: 100,
    });
    insertEvent(db, {
      id: 'p-2',
      taskId: 'parent',
      sessionId: 'sess-A',
      seq: 2,
      eventType: 'workflow:delegate_dispatched',
      payload: { taskId: 'parent', subTaskId: 'parent-c1', stepId: 's1', agentId: 'researcher' },
      ts: 110,
    });
    // Child has zero rows with session_id — sibling backfill (mig025)
    // cannot recover this.
    insertEvent(db, {
      id: 'c1-1',
      taskId: 'parent-c1',
      sessionId: null,
      seq: 1,
      eventType: 'agent:tool_started',
      payload: { taskId: 'parent-c1', toolName: 'Read' },
      ts: 120,
    });
    insertEvent(db, {
      id: 'c1-2',
      taskId: 'parent-c1',
      sessionId: null,
      seq: 2,
      eventType: 'llm:stream_delta',
      payload: { taskId: 'parent-c1', kind: 'content', text: 'hi' },
      ts: 130,
    });

    // Sanity: mig025 (sibling-copy) leaves the child rows NULL because
    // no sibling has a session_id to copy from.
    migration025.up(db);
    expect(sessionByRowId(db).get('c1-1')).toBeNull();
    expect(sessionByRowId(db).get('c1-2')).toBeNull();

    // 035 walks the parent's dispatch row and inherits its session_id.
    migration035.up(db);
    const sessions = sessionByRowId(db);
    expect(sessions.get('c1-1')).toBe('sess-A');
    expect(sessions.get('c1-2')).toBe('sess-A');
    // Parent rows untouched.
    expect(sessions.get('p-1')).toBe('sess-A');
    expect(sessions.get('p-2')).toBe('sess-A');
  });

  test('does not overwrite an already-set session_id', () => {
    const db = setupDb();
    insertEvent(db, {
      id: 'p',
      taskId: 'parent',
      sessionId: 'sess-A',
      seq: 1,
      eventType: 'workflow:delegate_dispatched',
      payload: { subTaskId: 'parent-c' },
      ts: 100,
    });
    // Child already has session_id set (e.g. from a later forward-fix
    // emit). 035 must NOT clobber it even if parent says something else.
    insertEvent(db, {
      id: 'c',
      taskId: 'parent-c',
      sessionId: 'sess-A',
      seq: 1,
      eventType: 'agent:tool_executed',
      payload: { taskId: 'parent-c' },
      ts: 110,
    });

    migration035.up(db);
    expect(sessionByRowId(db).get('c')).toBe('sess-A');
  });

  test('does not cross-contaminate sessions — parent in sess-A, unrelated NULL row stays NULL', () => {
    const db = setupDb();
    insertEvent(db, {
      id: 'p',
      taskId: 'parent',
      sessionId: 'sess-A',
      seq: 1,
      eventType: 'workflow:delegate_dispatched',
      payload: { subTaskId: 'parent-c' },
      ts: 100,
    });
    // An orphan task with no parent edge — must remain NULL because
    // there is no source of truth.
    insertEvent(db, {
      id: 'orphan',
      taskId: 'orphan-task',
      sessionId: null,
      seq: 1,
      eventType: 'agent:plan_update',
      payload: {},
      ts: 200,
    });

    migration035.up(db);
    const sessions = sessionByRowId(db);
    expect(sessions.get('orphan')).toBeNull();
  });

  test('recursive — grandchild whose parent (child) is also NULL gets recovered through chain', () => {
    const db = setupDb();
    // Root has session_id, dispatched a child.
    insertEvent(db, {
      id: 'r-disp',
      taskId: 'root',
      sessionId: 'sess-X',
      seq: 1,
      eventType: 'workflow:delegate_dispatched',
      payload: { subTaskId: 'root-c' },
      ts: 100,
    });
    // Child task's events all NULL.
    insertEvent(db, {
      id: 'c-disp',
      taskId: 'root-c',
      sessionId: null,
      seq: 1,
      eventType: 'workflow:delegate_dispatched',
      payload: { subTaskId: 'root-c-g' },
      ts: 110,
    });
    insertEvent(db, {
      id: 'c-tool',
      taskId: 'root-c',
      sessionId: null,
      seq: 2,
      eventType: 'agent:tool_executed',
      payload: { taskId: 'root-c' },
      ts: 120,
    });
    // Grandchild's events all NULL.
    insertEvent(db, {
      id: 'g-tool',
      taskId: 'root-c-g',
      sessionId: null,
      seq: 1,
      eventType: 'agent:tool_executed',
      payload: { taskId: 'root-c-g' },
      ts: 130,
    });

    migration035.up(db);
    const sessions = sessionByRowId(db);
    // First pass recovers child via root's dispatched row.
    expect(sessions.get('c-disp')).toBe('sess-X');
    expect(sessions.get('c-tool')).toBe('sess-X');
    // Second pass recovers grandchild via child's now-non-NULL dispatch row.
    expect(sessions.get('g-tool')).toBe('sess-X');
  });

  test('idempotent — second run is a no-op', () => {
    const db = setupDb();
    insertEvent(db, {
      id: 'p',
      taskId: 'parent',
      sessionId: 'sess-A',
      seq: 1,
      eventType: 'workflow:delegate_dispatched',
      payload: { subTaskId: 'parent-c' },
      ts: 100,
    });
    insertEvent(db, {
      id: 'c',
      taskId: 'parent-c',
      sessionId: null,
      seq: 1,
      eventType: 'agent:tool_executed',
      payload: { taskId: 'parent-c' },
      ts: 110,
    });

    migration035.up(db);
    const after1 = sessionByRowId(db).get('c');
    migration035.up(db);
    const after2 = sessionByRowId(db).get('c');

    expect(after1).toBe('sess-A');
    expect(after2).toBe('sess-A');
  });

  test('integration — task-tree query returns previously-NULL child rows after migration', async () => {
    // Real shape: child events are gated by `AND session_id = ?` in
    // `listForTaskTree`. Pre-035 this returns nothing for the child.
    // Post-035 the rows surface in the result.
    const { TaskEventStore } = await import('../../src/db/task-event-store.ts');
    const db = setupDb();

    insertEvent(db, {
      id: 'p-start',
      taskId: 'parent',
      sessionId: 'sess-Z',
      seq: 1,
      eventType: 'task:start',
      payload: { input: { id: 'parent', sessionId: 'sess-Z' } },
      ts: 100,
    });
    insertEvent(db, {
      id: 'p-disp',
      taskId: 'parent',
      sessionId: 'sess-Z',
      seq: 2,
      eventType: 'workflow:delegate_dispatched',
      payload: { taskId: 'parent', subTaskId: 'parent-c', stepId: 's1' },
      ts: 110,
    });
    insertEvent(db, {
      id: 'c-tool',
      taskId: 'parent-c',
      sessionId: null,
      seq: 1,
      eventType: 'agent:tool_executed',
      payload: { taskId: 'parent-c', toolName: 'Read' },
      ts: 120,
    });

    const store = new TaskEventStore(db);
    // Before mig035 — child row dropped by session guard.
    const before = store.listForTaskTree('parent', {
      taskIds: ['parent', 'parent-c'],
      rootSessionId: 'sess-Z',
    });
    expect(before.events.find((e) => e.taskId === 'parent-c')).toBeUndefined();

    // Apply migration.
    migration035.up(db);

    // After — child row surfaces and carries the parent's session_id.
    const after = store.listForTaskTree('parent', {
      taskIds: ['parent', 'parent-c'],
      rootSessionId: 'sess-Z',
    });
    const childRow = after.events.find((e) => e.taskId === 'parent-c');
    expect(childRow).toBeDefined();
    expect(childRow?.sessionId).toBe('sess-Z');
  });
});
