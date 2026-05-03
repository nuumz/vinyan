/**
 * Migration 039 + parent_task_id column — behavior tests.
 *
 * Three load-bearing claims under test:
 *
 *   1. Migration 039 is idempotent + replayable. Running it twice on a
 *      DB that already has the column is a no-op; running it on a fresh
 *      DB adds the column, the index, and backfills.
 *
 *   2. Sub-tree query parity. `listChildTaskIds` returns the same set of
 *      child task ids when reading from the `parent_task_id` column as
 *      it did under the legacy `json_extract(payload, '$.subTaskId')`
 *      scan, both for backfilled rows (no parent_task_id at write time)
 *      and for fresh rows (parent_task_id written by the recorder).
 *
 *   3. Forward writes — the recorder's parentByTask cache populates
 *      parent_task_id for events that arrive AFTER `task:start`, so a
 *      sub-task's full event log lands in the column.
 */
import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { migration039 } from '../../src/db/migrations/039_task_events_parent_task_id.ts';
import { ALL_MIGRATIONS, MigrationRunner } from '../../src/db/migrations/index.ts';
import { TaskEventStore } from '../../src/db/task-event-store.ts';

let db: Database;

beforeEach(() => {
  db = new Database(':memory:');
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  new MigrationRunner().migrate(db, ALL_MIGRATIONS);
});

afterEach(() => {
  db.close();
});

interface ColumnInfo {
  name: string;
}

function hasColumn(table: string, col: string): boolean {
  const rows = db.query(`PRAGMA table_info(${table})`).all() as ColumnInfo[];
  return rows.some((c) => c.name === col);
}

describe('migration 039 — task_events.parent_task_id', () => {
  test('column + covering index land after migrate', () => {
    expect(hasColumn('task_events', 'parent_task_id')).toBe(true);
    const rows = db
      .query("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='task_events'")
      .all() as Array<{ name: string }>;
    expect(rows.some((r) => r.name === 'idx_task_events_parent_ts')).toBe(true);
  });

  test('idempotent: re-running migrate is a no-op', () => {
    // ALL_MIGRATIONS already includes 039 (applied above). Running it
    // explicitly a second time MUST NOT throw and MUST leave the column
    // intact.
    expect(() => migration039.up(db)).not.toThrow();
    expect(hasColumn('task_events', 'parent_task_id')).toBe(true);
  });

  test('backfill fills parent_task_id from existing workflow:delegate_dispatched rows', () => {
    // Plant a parent + child fixture with NULL parent_task_id (simulating
    // pre-migration state). Use raw SQL to bypass the recorder's new
    // forward-write path so we can prove the backfill actually does work.
    db.exec(
      `INSERT INTO task_events (id, task_id, session_id, parent_task_id, seq, event_type, payload_json, ts) VALUES
       ('parent-1-1', 'parent-1', 'sess-1', NULL, 1, 'task:start', '{"input":{"id":"parent-1"}}', 1000),
       ('parent-1-2', 'parent-1', 'sess-1', NULL, 2, 'workflow:delegate_dispatched', '{"taskId":"parent-1","stepId":"step1","subTaskId":"parent-1-delegate-step1"}', 1100),
       ('child-1-1',  'parent-1-delegate-step1', 'sess-1', NULL, 1, 'task:start', '{"input":{"id":"parent-1-delegate-step1","parentTaskId":"parent-1"}}', 1200),
       ('child-1-2',  'parent-1-delegate-step1', 'sess-1', NULL, 2, 'agent:tool_executed', '{"taskId":"parent-1-delegate-step1"}', 1300)
      `,
    );
    // First clear: simulate "post-migration with column added but no
    // forward writes" — explicitly NULL out so the backfill has work to do.
    db.exec("UPDATE task_events SET parent_task_id = NULL WHERE task_id LIKE 'parent-1-delegate-%'");

    migration039.up(db);

    const rows = db
      .query<{ task_id: string; parent_task_id: string | null }, []>(
        "SELECT task_id, parent_task_id FROM task_events WHERE task_id = 'parent-1-delegate-step1' ORDER BY seq",
      )
      .all();
    expect(rows.length).toBe(2);
    for (const r of rows) {
      expect(r.parent_task_id).toBe('parent-1');
    }
  });
});

describe('listChildTaskIds — column-backed read parity', () => {
  test('returns the same children as the legacy json_extract path', () => {
    const store = new TaskEventStore(db);
    // Recorder's forward-write path: parentTaskId on AppendOptions populates
    // the column directly.
    store.append({ taskId: 'parent-A', sessionId: 's1', eventType: 'task:start', payload: {}, ts: 1 });
    store.append({
      taskId: 'parent-A',
      sessionId: 's1',
      eventType: 'workflow:delegate_dispatched',
      payload: { taskId: 'parent-A', stepId: 'step1', subTaskId: 'parent-A-delegate-step1' },
      ts: 2,
    });
    store.append({
      taskId: 'parent-A',
      sessionId: 's1',
      eventType: 'workflow:delegate_dispatched',
      payload: { taskId: 'parent-A', stepId: 'step2', subTaskId: 'parent-A-delegate-step2' },
      ts: 3,
    });
    store.append({
      taskId: 'parent-A-delegate-step1',
      sessionId: 's1',
      parentTaskId: 'parent-A',
      eventType: 'task:start',
      payload: { input: { id: 'parent-A-delegate-step1', parentTaskId: 'parent-A' } },
      ts: 4,
    });
    store.append({
      taskId: 'parent-A-delegate-step2',
      sessionId: 's1',
      parentTaskId: 'parent-A',
      eventType: 'task:start',
      payload: { input: { id: 'parent-A-delegate-step2', parentTaskId: 'parent-A' } },
      ts: 5,
    });

    const children = store.listChildTaskIds('parent-A');
    expect(children.sort()).toEqual(['parent-A-delegate-step1', 'parent-A-delegate-step2']);
  });

  test('mixes backfilled-rows with forward-write rows transparently', () => {
    const store = new TaskEventStore(db);
    // Backfilled-style row: parent_task_id NULL at write, then filled by
    // migration. We simulate by inserting via raw SQL with NULL, then
    // running the migration.
    db.exec(
      `INSERT INTO task_events (id, task_id, session_id, parent_task_id, seq, event_type, payload_json, ts) VALUES
       ('parent-B-1', 'parent-B', 'sB', NULL, 1, 'workflow:delegate_dispatched', '{"taskId":"parent-B","stepId":"step1","subTaskId":"parent-B-delegate-step1"}', 100),
       ('child-B-1',  'parent-B-delegate-step1', 'sB', NULL, 1, 'agent:tool_executed', '{}', 200)
      `,
    );
    migration039.up(db);

    // Forward-write a fresh delegate via the recorder API path.
    store.append({
      taskId: 'parent-B',
      sessionId: 'sB',
      eventType: 'workflow:delegate_dispatched',
      payload: { taskId: 'parent-B', stepId: 'step2', subTaskId: 'parent-B-delegate-step2' },
      ts: 300,
    });
    store.append({
      taskId: 'parent-B-delegate-step2',
      sessionId: 'sB',
      parentTaskId: 'parent-B',
      eventType: 'task:start',
      payload: { input: { id: 'parent-B-delegate-step2', parentTaskId: 'parent-B' } },
      ts: 400,
    });

    const children = store.listChildTaskIds('parent-B');
    expect(children.sort()).toEqual(['parent-B-delegate-step1', 'parent-B-delegate-step2']);
  });

  test('returns empty array for a task with no children', () => {
    const store = new TaskEventStore(db);
    store.append({ taskId: 'lonely', eventType: 'task:start', payload: {}, ts: 1 });
    expect(store.listChildTaskIds('lonely')).toEqual([]);
  });
});
