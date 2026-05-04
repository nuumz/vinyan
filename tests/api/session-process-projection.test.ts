/**
 * SessionProcessProjectionService — Phase 2.7 backend session-scoped read.
 *
 * Joins session_store with session_tasks; surfaces lifecycle + per-task
 * summary + audit count rollup. Backs `/api/v1/sessions/:sid/process-state`
 * (route lands later when the UI work in Phase 3 needs it).
 */
import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { SessionProcessProjectionService } from '../../src/api/projections/session-process-projection.ts';
import { ALL_MIGRATIONS, MigrationRunner } from '../../src/db/migrations/index.ts';
import { SessionStore } from '../../src/db/session-store.ts';
import { TaskEventStore } from '../../src/db/task-event-store.ts';

let db: Database;
let sessionStore: SessionStore;
let service: SessionProcessProjectionService;

function plantSession(
  over: Partial<{
    id: string;
    status: string;
    archived_at: number | null;
    deleted_at: number | null;
    title: string | null;
  }> = {},
): string {
  const id = over.id ?? 'sess-1';
  sessionStore.insertSession({
    id,
    source: 'cli',
    created_at: 1000,
    status: (over.status ?? 'active') as 'active' | 'suspended' | 'compacted' | 'closed',
    working_memory_json: null,
    compaction_json: null,
    updated_at: 2000,
    title: over.title ?? null,
    description: null,
    archived_at: over.archived_at ?? null,
    deleted_at: over.deleted_at ?? null,
  });
  return id;
}

function plantTask(
  sessionId: string,
  taskId: string,
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled',
  archivedAt: number | null = null,
) {
  sessionStore.insertTask({
    session_id: sessionId,
    task_id: taskId,
    task_input_json: JSON.stringify({ id: taskId }),
    status,
    result_json: null,
    created_at: 1100,
    updated_at: 1200,
    archived_at: archivedAt,
  });
}

beforeEach(() => {
  db = new Database(':memory:');
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  new MigrationRunner().migrate(db, ALL_MIGRATIONS);
  sessionStore = new SessionStore(db);
  service = new SessionProcessProjectionService({ sessionStore });
});

afterEach(() => {
  db.close();
});

describe('SessionProcessProjectionService.build', () => {
  test('returns null when session row is unknown', () => {
    expect(service.build('does-not-exist')).toBeNull();
  });

  test('lifecycle.lifecycleState derives correctly: active', () => {
    plantSession({ id: 'sess-A' });
    const proj = service.build('sess-A');
    expect(proj?.lifecycle.lifecycleState).toBe('active');
  });

  test('lifecycle.lifecycleState derives correctly: archived (priority over status)', () => {
    plantSession({ id: 'sess-B', archived_at: 5000 });
    const proj = service.build('sess-B');
    expect(proj?.lifecycle.lifecycleState).toBe('archived');
  });

  test('lifecycle.lifecycleState derives correctly: trashed (priority over archived)', () => {
    plantSession({ id: 'sess-C', archived_at: 5000, deleted_at: 6000 });
    const proj = service.build('sess-C');
    expect(proj?.lifecycle.lifecycleState).toBe('trashed');
  });

  test('audit counts roll up from session_tasks', () => {
    const sid = plantSession();
    plantTask(sid, 't1', 'completed');
    plantTask(sid, 't2', 'running');
    plantTask(sid, 't3', 'failed');
    plantTask(sid, 't4', 'pending');
    plantTask(sid, 't5', 'cancelled');
    plantTask(sid, 't6', 'completed', 9999); // archived

    const proj = service.build(sid);
    expect(proj?.audit.totalTasks).toBe(6);
    expect(proj?.audit.completedTasks).toBe(2);
    expect(proj?.audit.runningTasks).toBe(1);
    expect(proj?.audit.failedTasks).toBe(1);
    expect(proj?.audit.pendingTasks).toBe(1);
    expect(proj?.audit.cancelledTasks).toBe(1);
    expect(proj?.audit.archivedTasks).toBe(1);
  });

  test('tasks list mirrors session_tasks ordered by createdAt', () => {
    const sid = plantSession();
    plantTask(sid, 't1', 'completed');
    plantTask(sid, 't2', 'completed');
    plantTask(sid, 't3', 'pending');

    const proj = service.build(sid);
    expect(proj?.tasks.map((t) => t.taskId)).toEqual(['t1', 't2', 't3']);
  });

  test('respects maxTasks cap', () => {
    const sid = plantSession();
    for (let i = 1; i <= 10; i++) plantTask(sid, `t${i}`, 'completed');

    const cappedService = new SessionProcessProjectionService({ sessionStore, maxTasks: 3 });
    const proj = cappedService.build(sid);
    expect(proj?.tasks.length).toBe(3);
  });

  test('sessionId / metadata threading', () => {
    plantSession({ id: 'sess-meta', title: 'My audit session' });
    const proj = service.build('sess-meta');
    expect(proj?.lifecycle.sessionId).toBe('sess-meta');
    expect(proj?.lifecycle.title).toBe('My audit session');
    expect(proj?.lifecycle.source).toBe('cli');
  });

  test('descendantTasks defaults to [] when taskEventStore is not wired', () => {
    plantSession({ id: 'sess-no-events' });
    plantTask('sess-no-events', 'root-1', 'completed');
    const proj = service.build('sess-no-events');
    expect(proj?.descendantTasks).toEqual([]);
  });
});

describe('SessionProcessProjectionService.build with taskEventStore', () => {
  test('surfaces sub-agent tasks recorded only in task_events', () => {
    const sid = plantSession({ id: 'sess-multi' });
    plantTask(sid, 'root-1', 'running');
    const taskEventStore = new TaskEventStore(db);
    // Root task event
    taskEventStore.append({
      taskId: 'root-1',
      sessionId: sid,
      eventType: 'task:start',
      payload: { taskId: 'root-1', sessionId: sid },
      ts: 1100,
    });
    // Two delegate sub-tasks dispatched by root-1
    taskEventStore.append({
      taskId: 'sub-A',
      sessionId: sid,
      parentTaskId: 'root-1',
      eventType: 'task:start',
      payload: { taskId: 'sub-A', sessionId: sid, input: { parentTaskId: 'root-1' } },
      ts: 1150,
    });
    taskEventStore.append({
      taskId: 'sub-A',
      sessionId: sid,
      parentTaskId: 'root-1',
      eventType: 'task:complete',
      payload: { taskId: 'sub-A', result: { id: 'sub-A', status: 'completed' } },
      ts: 1200,
    });
    taskEventStore.append({
      taskId: 'sub-B',
      sessionId: sid,
      parentTaskId: 'root-1',
      eventType: 'task:start',
      payload: { taskId: 'sub-B', sessionId: sid, input: { parentTaskId: 'root-1' } },
      ts: 1175,
    });
    // sub-B has no task:complete → should report as 'running'

    const enriched = new SessionProcessProjectionService({ sessionStore, taskEventStore });
    const proj = enriched.build(sid);
    expect(proj).not.toBeNull();
    // root-1 stays in tasks (authoritative from session_tasks); the
    // descendants tier excludes it because it's already a root.
    const descendantIds = proj!.descendantTasks.map((d) => d.taskId).sort();
    expect(descendantIds).toEqual(['sub-A', 'sub-B']);
    const subA = proj!.descendantTasks.find((d) => d.taskId === 'sub-A')!;
    expect(subA.parentTaskId).toBe('root-1');
    expect(subA.status).toBe('completed');
    expect(subA.eventCount).toBe(2);
    const subB = proj!.descendantTasks.find((d) => d.taskId === 'sub-B')!;
    expect(subB.status).toBe('running');
    expect(subB.eventCount).toBe(1);
  });

  test('respects maxDescendantTasks cap', () => {
    const sid = plantSession({ id: 'sess-cap' });
    const taskEventStore = new TaskEventStore(db);
    for (let i = 0; i < 10; i++) {
      taskEventStore.append({
        taskId: `sub-${i}`,
        sessionId: sid,
        parentTaskId: 'root-X',
        eventType: 'task:start',
        payload: { taskId: `sub-${i}` },
        ts: 1000 + i,
      });
    }
    const enriched = new SessionProcessProjectionService({
      sessionStore,
      taskEventStore,
      maxDescendantTasks: 3,
    });
    const proj = enriched.build(sid);
    expect(proj!.descendantTasks.length).toBe(3);
  });

  test('failed sub-task derived status maps cleanly', () => {
    const sid = plantSession({ id: 'sess-fail' });
    const taskEventStore = new TaskEventStore(db);
    taskEventStore.append({
      taskId: 'sub-fail',
      sessionId: sid,
      eventType: 'task:start',
      payload: {},
      ts: 1000,
    });
    taskEventStore.append({
      taskId: 'sub-fail',
      sessionId: sid,
      eventType: 'task:complete',
      payload: { result: { id: 'sub-fail', status: 'failed' } },
      ts: 1100,
    });
    const enriched = new SessionProcessProjectionService({ sessionStore, taskEventStore });
    const proj = enriched.build(sid);
    expect(proj!.descendantTasks[0]!.status).toBe('failed');
  });
});
