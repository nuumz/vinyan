/**
 * Session Manager Tests — lifecycle, compaction, I16 audit preservation
 */

import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { SessionManager } from '../../src/api/session-manager.ts';
import { ALL_MIGRATIONS, MigrationRunner } from '../../src/db/migrations/index.ts';
import { SessionStore } from '../../src/db/session-store.ts';
import type { TaskInput, TaskResult } from '../../src/orchestrator/types.ts';

let db: Database;
let sessionStore: SessionStore;
let manager: SessionManager;

beforeEach(() => {
  db = new Database(':memory:');
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  new MigrationRunner().migrate(db, ALL_MIGRATIONS);

  sessionStore = new SessionStore(db);
  manager = new SessionManager(sessionStore);
});

afterEach(() => {
  db.close();
});

function makeTaskInput(id: string): TaskInput {
  return {
    id,
    source: 'api',
    goal: `Test task ${id}`,
    taskType: 'code',
    budget: { maxTokens: 1000, maxDurationMs: 5000, maxRetries: 1 },
  };
}

function makeTaskResult(id: string, status: 'completed' | 'failed'): TaskResult {
  return {
    id,
    status,
    mutations: [],
    trace: {
      id: `trace-${id}`,
      task_id: id,
      timestamp: Date.now(),
      routing_level: 1,
      taskTypeSignature: 'test::ts',
      approach: 'test-approach',
      modelUsed: 'mock/test',
      tokensConsumed: 500,
      durationMs: 200,
      outcome: status === 'completed' ? 'success' : 'failure',
      oracleVerdicts: {},
      affectedFiles: [],
      failureReason: status === 'failed' ? 'test failure' : undefined,
    } as any,
    escalationReason: status === 'failed' ? 'test failure' : undefined,
  };
}

describe('SessionManager', () => {
  test('create returns session with ID', () => {
    const session = manager.create('api');
    expect(session.id).toBeTruthy();
    expect(session.source).toBe('api');
    expect(session.status).toBe('active');
    expect(session.taskCount).toBe(0);
  });

  test('get returns session with task count', () => {
    const session = manager.create('cli');
    const input = makeTaskInput('task-1');
    manager.addTask(session.id, input);

    const retrieved = manager.get(session.id);
    expect(retrieved).toBeTruthy();
    expect(retrieved!.taskCount).toBe(1);
  });

  test('get returns undefined for nonexistent session', () => {
    expect(manager.get('nonexistent')).toBeUndefined();
  });

  test('addTask links task to session', () => {
    const session = manager.create('api');
    manager.addTask(session.id, makeTaskInput('t1'));
    manager.addTask(session.id, makeTaskInput('t2'));

    const tasks = sessionStore.listSessionTasks(session.id);
    expect(tasks.length).toBe(2);
    expect(tasks[0]!.status).toBe('pending');
  });

  test('completeTask updates status and result', () => {
    const session = manager.create('api');
    const input = makeTaskInput('t1');
    manager.addTask(session.id, input);
    manager.completeTask(session.id, 't1', makeTaskResult('t1', 'completed'));

    const task = sessionStore.getTask(session.id, 't1');
    expect(task!.status).toBe('completed');
    expect(task!.result_json).toBeTruthy();
  });
});

describe('Session Compaction', () => {
  test('compact produces CompactionResult', () => {
    const session = manager.create('api');

    // Add and complete tasks
    for (let i = 0; i < 5; i++) {
      const id = `t${i}`;
      manager.addTask(session.id, makeTaskInput(id));
      manager.completeTask(session.id, id, makeTaskResult(id, i < 4 ? 'completed' : 'failed'));
    }

    const result = manager.compact(session.id);
    expect(result.sessionId).toBe(session.id);
    expect(result.statistics.totalTasks).toBe(5);
    expect(result.statistics.successRate).toBe(0.8);
    expect(result.keyFailures.length).toBeGreaterThan(0);
    expect(result.successfulPatterns.length).toBeGreaterThan(0);
    expect(result.compactedAt).toBeGreaterThan(0);
  });

  test('compaction is additive — does not delete task data (I16)', () => {
    const session = manager.create('api');
    manager.addTask(session.id, makeTaskInput('t1'));
    manager.completeTask(session.id, 't1', makeTaskResult('t1', 'completed'));

    manager.compact(session.id);

    // Original task data still accessible
    const tasks = sessionStore.listSessionTasks(session.id);
    expect(tasks.length).toBe(1);
    expect(tasks[0]!.result_json).toBeTruthy();

    // Compaction stored separately
    const row = sessionStore.getSession(session.id);
    expect(row!.status).toBe('compacted');
    expect(row!.compaction_json).toBeTruthy();
  });
});

// Helper: append an assistant [INPUT-REQUIRED] turn directly to session_turns
// so tests can construct arbitrary clarification histories without needing a
// full TaskResult round-trip. A7: uses Turn model instead of session_messages.
function insertInputRequiredAssistant(sessionId: string, questions: string[]): void {
  const body = questions.map((q) => `- ${q}`).join('\n');
  sessionStore.appendTurn({
    id: `test-ir-${Math.random().toString(36).slice(2, 8)}`,
    sessionId,
    role: 'assistant',
    blocks: [{ type: 'text', text: `[INPUT-REQUIRED]\n${body}` }],
    tokenCount: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
    taskId: 'test-ir',
    createdAt: Date.now(),
  });
}

describe('SessionManager.getOriginalTaskGoal', () => {
  test('returns null for empty session', () => {
    const s = manager.create('api');
    expect(manager.getOriginalTaskGoal(s.id)).toBeNull();
  });

  test('returns the only user message when history has just one turn', () => {
    const s = manager.create('api');
    manager.recordUserTurn(s.id, 'write me a bedtime story');
    expect(manager.getOriginalTaskGoal(s.id)).toBe('write me a bedtime story');
  });

  test('returns the user message that triggered an open clarification', () => {
    const s = manager.create('api');
    manager.recordUserTurn(s.id, 'write me a bedtime story');
    insertInputRequiredAssistant(s.id, ['Genre?', 'Length?']);
    // Pending clarification is active; root goal is the user message before it.
    expect(manager.getOriginalTaskGoal(s.id)).toBe('write me a bedtime story');
  });

  test('skips clarification reply pairs to find the root goal across re-clarification', () => {
    const s = manager.create('api');
    manager.recordUserTurn(s.id, 'write me a bedtime story');
    insertInputRequiredAssistant(s.id, ['Genre?']);
    manager.recordUserTurn(s.id, 'romance');
    insertInputRequiredAssistant(s.id, ['Length?']);
    // Two clarification rounds layered on the same root task.
    expect(manager.getOriginalTaskGoal(s.id)).toBe('write me a bedtime story');
  });

  test('returns the MOST RECENT root task when prior tasks already completed', () => {
    const s = manager.create('api');
    // Turn 1: completed normally (not an IR).
    manager.recordUserTurn(s.id, 'first task done');
    sessionStore.appendTurn({
      id: 't1-assistant',
      sessionId: s.id,
      role: 'assistant',
      blocks: [{ type: 'text', text: 'ok, done' }],
      tokenCount: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
      taskId: 't1',
      createdAt: Date.now(),
    });
    // Turn 2: new task, assistant asks for clarification.
    manager.recordUserTurn(s.id, 'now write a poem');
    insertInputRequiredAssistant(s.id, ['Style?']);

    expect(manager.getOriginalTaskGoal(s.id)).toBe('now write a poem');
  });

  test('returns the most recent user message when no clarification is pending', () => {
    const s = manager.create('api');
    manager.recordUserTurn(s.id, 'hello');
    sessionStore.appendTurn({
      id: 't1-assistant-2',
      sessionId: s.id,
      role: 'assistant',
      blocks: [{ type: 'text', text: 'hi back' }],
      tokenCount: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
      taskId: 't1',
      createdAt: Date.now(),
    });
    manager.recordUserTurn(s.id, 'latest goal');
    // No [INPUT-REQUIRED] in play — latest user message wins.
    expect(manager.getOriginalTaskGoal(s.id)).toBe('latest goal');
  });
});

describe('Session Recovery', () => {
  test('suspendAll suspends active sessions', () => {
    manager.create('api');
    manager.create('api');

    const suspended = manager.suspendAll();
    expect(suspended).toBe(2);

    const active = sessionStore.listActiveSessions();
    expect(active.length).toBe(0);
  });

  test('recover returns suspended sessions and reactivates them', () => {
    const s1 = manager.create('api');
    manager.suspendAll();

    const recovered = manager.recover();
    expect(recovered.length).toBe(1);
    expect(recovered[0]!.id).toBe(s1.id);
    expect(recovered[0]!.status).toBe('active');
  });

  test('suspend/recover cycle does not bump updated_at (server restart is not user activity)', async () => {
    const s = manager.create('api');
    const originalUpdatedAt = sessionStore.getSession(s.id)!.updated_at;

    // Sleep long enough that Date.now() would visibly differ if the cycle
    // were touching updated_at.
    await new Promise((r) => setTimeout(r, 5));

    manager.suspendAll();
    manager.recover();

    expect(sessionStore.getSession(s.id)!.updated_at).toBe(originalUpdatedAt);
  });
});
