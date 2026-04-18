/**
 * Checkpoint Recovery Tests — verify UC-6: task state survives shutdown/restart.
 *
 * Validates that:
 * 1. Graceful shutdown suspends active sessions
 * 2. Pending/running tasks are recoverable from a new SessionStore instance
 * 3. Session memory is preserved across restart
 */
import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { SessionManager } from '../../src/api/session-manager.ts';
import { ALL_MIGRATIONS, MigrationRunner } from '../../src/db/migrations/index.ts';
import { SessionStore } from '../../src/db/session-store.ts';
import type { TaskInput } from '../../src/orchestrator/types.ts';

const DB_PATH = ':memory:';
let db: Database;
let sessionStore: SessionStore;
let manager: SessionManager;

function createDb(): Database {
  const d = new Database(DB_PATH);
  d.exec('PRAGMA journal_mode = WAL');
  d.exec('PRAGMA foreign_keys = ON');
  new MigrationRunner().migrate(d, ALL_MIGRATIONS);
  return d;
}

function makeTaskInput(id: string): TaskInput {
  return {
    id,
    source: 'api',
    goal: `Test task ${id}`,
    taskType: 'code',
    budget: { maxTokens: 1000, maxDurationMs: 5000, maxRetries: 1 },
  };
}

beforeEach(() => {
  db = createDb();
  sessionStore = new SessionStore(db);
  manager = new SessionManager(sessionStore);
});

afterEach(() => {
  db.close();
});

describe('Checkpoint Recovery (UC-6)', () => {
  test('suspendAll marks active sessions as suspended', () => {
    const s1 = manager.create('api');
    const s2 = manager.create('cli');

    const suspended = manager.suspendAll();
    expect(suspended).toBe(2);

    // Verify both sessions are now suspended
    const session1 = manager.get(s1.id);
    const session2 = manager.get(s2.id);
    expect(session1!.status).toBe('suspended');
    expect(session2!.status).toBe('suspended');
  });

  test('recover returns suspended sessions', () => {
    const session = manager.create('api');
    manager.addTask(session.id, makeTaskInput('t1'));
    manager.addTask(session.id, makeTaskInput('t2'));

    // Simulate shutdown
    manager.suspendAll();

    // Recover — should find suspended session with task count
    const recovered = manager.recover();
    expect(recovered).toHaveLength(1);
    expect(recovered[0]!.id).toBe(session.id);
    expect(recovered[0]!.status).toBe('active');
    expect(recovered[0]!.taskCount).toBe(2);
  });

  test('pending tasks are recoverable via listPendingTasks', () => {
    const session = manager.create('api');
    manager.addTask(session.id, makeTaskInput('t1'));
    manager.addTask(session.id, makeTaskInput('t2'));

    // Mark t1 as running (simulates in-flight task at shutdown)
    sessionStore.updateTaskStatus(session.id, 't1', 'running');

    // Simulate shutdown
    manager.suspendAll();

    // Create new store from same DB (simulates restart with same SQLite file)
    const store2 = new SessionStore(db);
    const pending = store2.listPendingTasks();

    // Both t1 (running) and t2 (pending) should be recoverable
    expect(pending).toHaveLength(2);
    expect(pending.map((t) => t.task_id).sort()).toEqual(['t1', 't2']);
  });

  test('completed tasks are NOT in pending list', () => {
    const session = manager.create('api');
    manager.addTask(session.id, makeTaskInput('t1'));
    manager.addTask(session.id, makeTaskInput('t2'));

    // Complete t1
    sessionStore.updateTaskStatus(session.id, 't1', 'completed', JSON.stringify({ status: 'completed' }));

    const pending = sessionStore.listPendingTasks();
    expect(pending).toHaveLength(1);
    expect(pending[0]!.task_id).toBe('t2');
  });

  test('session working memory is preserved through suspend/recover cycle', () => {
    const session = manager.create('api');

    // Store working memory
    const memoryPayload = JSON.stringify({ failedApproaches: ['approach-a'], factCache: ['fact-1'] });
    sessionStore.updateSessionMemory(session.id, memoryPayload);

    // Suspend
    manager.suspendAll();

    // Verify memory persisted
    const raw = sessionStore.getSession(session.id);
    expect(raw!.working_memory_json).toBe(memoryPayload);
    expect(raw!.status).toBe('suspended');
  });

  test('recovery with no suspended sessions returns empty array', () => {
    const recovered = manager.recover();
    expect(recovered).toEqual([]);
  });

  test('failed tasks are NOT in pending list', () => {
    const session = manager.create('api');
    manager.addTask(session.id, makeTaskInput('t1'));
    manager.addTask(session.id, makeTaskInput('t2'));

    sessionStore.updateTaskStatus(session.id, 't1', 'failed', JSON.stringify({ status: 'failed' }));

    const pending = sessionStore.listPendingTasks();
    expect(pending).toHaveLength(1);
    expect(pending[0]!.task_id).toBe('t2');
  });

  test('task input JSON is recoverable after restart', () => {
    const session = manager.create('api');
    const input = makeTaskInput('t-recover');
    manager.addTask(session.id, input);

    manager.suspendAll();

    // Simulate reading from "new" store instance
    const store2 = new SessionStore(db);
    const pending = store2.listPendingTasks();
    expect(pending).toHaveLength(1);

    const recovered = JSON.parse(pending[0]!.task_input_json) as TaskInput;
    expect(recovered.id).toBe('t-recover');
    expect(recovered.goal).toBe('Test task t-recover');
    expect(recovered.budget.maxTokens).toBe(1000);
  });
});
