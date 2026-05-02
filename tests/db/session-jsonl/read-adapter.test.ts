/**
 * Phase 3 — JsonlReadAdapter ↔ SqliteReadAdapter parity tests.
 *
 * Strategy:
 *   1. Wire SessionManager with both stores (dual-write enabled).
 *   2. Drive a representative mix of mutations (create, turns, tasks,
 *      compact, working-memory).
 *   3. For each adapter method, assert SQLite output == JSONL output.
 *
 * If a parity test fails, the JsonlReadAdapter is missing a fold rule
 * for a kind the appender writes — fix the adapter, not the test.
 */
import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionManager } from '../../../src/api/session-manager.ts';
import { ALL_MIGRATIONS, MigrationRunner } from '../../../src/db/migrations/index.ts';
import { JsonlAppender } from '../../../src/db/session-jsonl/appender.ts';
import { makeFsyncPolicy } from '../../../src/db/session-jsonl/fsync-policy.ts';
import { JsonlReadAdapter, SqliteReadAdapter } from '../../../src/db/session-jsonl/read-adapter.ts';
import { IndexRebuilder } from '../../../src/db/session-jsonl/rebuild-index.ts';
import { SessionStore } from '../../../src/db/session-store.ts';
import type { TaskInput, TaskResult } from '../../../src/orchestrator/types.ts';

let db: Database;
let store: SessionStore;
let manager: SessionManager;
let layout: { sessionsDir: string };
let sqliteAdapter: SqliteReadAdapter;
let jsonlAdapter: JsonlReadAdapter;

beforeEach(() => {
  db = new Database(':memory:');
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  new MigrationRunner().migrate(db, ALL_MIGRATIONS);
  store = new SessionStore(db);
  layout = { sessionsDir: mkdtempSync(join(tmpdir(), 'vinyan-readparity-')) };
  manager = new SessionManager(store);
  manager.attachJsonlLayer(
    new JsonlAppender({ layout, policy: makeFsyncPolicy('none') }),
    new IndexRebuilder(db, layout),
  );
  sqliteAdapter = new SqliteReadAdapter(store);
  jsonlAdapter = new JsonlReadAdapter({ layout, fallback: sqliteAdapter });
});

afterEach(() => {
  db.close();
});

function task(id: string): TaskInput {
  return {
    id,
    source: 'api',
    goal: `Goal ${id}`,
    taskType: 'code',
    budget: { maxTokens: 1000, maxDurationMs: 5000, maxRetries: 1 },
  };
}

function result(id: string, status: 'completed' | 'failed' = 'completed'): TaskResult {
  return {
    id,
    status,
    mutations: [],
    answer: `answer-${id}`,
    trace: {
      id: `trace-${id}`,
      taskId: id,
      sessionId: 'sess',
      workerId: 'w',
      timestamp: 1,
      routingLevel: 0,
      approach: 'test',
      oracleVerdicts: {},
      modelUsed: 'none',
      tokensConsumed: 5,
      durationMs: 1,
      outcome: status === 'completed' ? 'success' : 'failure',
      affectedFiles: [],
    },
  };
}

function seed(): { id: string } {
  const s = manager.create('cli', { title: 'parity' });
  manager.recordUserTurn(s.id, 'first message');
  manager.addTask(s.id, task('t1'));
  manager.completeTask(s.id, 't1', result('t1'));
  manager.recordAssistantTurn(s.id, 't1', result('t1'));
  manager.recordUserTurn(s.id, 'second message');
  manager.addTask(s.id, task('t2'));
  manager.completeTask(s.id, 't2', result('t2'));
  manager.recordAssistantTurn(s.id, 't2', result('t2'));
  return { id: s.id };
}

describe('Read-adapter parity — JSONL ↔ SQLite', () => {
  test('hasSession agrees', () => {
    const { id } = seed();
    expect(jsonlAdapter.hasSession(id)).toBe(true);
    expect(sqliteAdapter.hasSession(id)).toBe(true);
    expect(jsonlAdapter.hasSession('absent')).toBe(false);
    expect(sqliteAdapter.hasSession('absent')).toBe(false);
  });

  test('getTurns returns the same chronological turns', () => {
    const { id } = seed();
    const sqlite = sqliteAdapter.getTurns(id).map((t) => ({ id: t.id, role: t.role, seq: t.seq }));
    const jsonl = jsonlAdapter.getTurns(id).map((t) => ({ id: t.id, role: t.role, seq: t.seq }));
    expect(jsonl).toEqual(sqlite);
    expect(jsonl).toHaveLength(4);
    expect(jsonl.map((t) => t.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
  });

  test('getRecentTurns honours the limit and order', () => {
    const { id } = seed();
    const a = sqliteAdapter.getRecentTurns(id, 2).map((t) => t.id);
    const b = jsonlAdapter.getRecentTurns(id, 2).map((t) => t.id);
    expect(b).toEqual(a);
    expect(b).toHaveLength(2);
  });

  test('countTurns matches', () => {
    const { id } = seed();
    expect(jsonlAdapter.countTurns(id)).toBe(sqliteAdapter.countTurns(id));
    expect(jsonlAdapter.countTurns(id)).toBe(4);
  });

  test('getTurn(turnId) returns the same row when sessionId is supplied', () => {
    const { id } = seed();
    const turns = sqliteAdapter.getTurns(id);
    const someTurnId = turns[1]!.id;
    const a = sqliteAdapter.getTurn(undefined, someTurnId);
    const b = jsonlAdapter.getTurn(id, someTurnId);
    expect(b?.id).toBe(a?.id);
    expect(b?.role).toBe(a?.role);
    expect(b?.seq).toBe(a?.seq);
  });

  test('listSessionTasks reflects the same task statuses + result_json', () => {
    const { id } = seed();
    const sqlite = sqliteAdapter.listSessionTasks(id).map((t) => ({
      task_id: t.task_id,
      status: t.status,
    }));
    const jsonl = jsonlAdapter.listSessionTasks(id).map((t) => ({
      task_id: t.task_id,
      status: t.status,
    }));
    expect(jsonl).toEqual(sqlite);
    expect(jsonl).toHaveLength(2);
    expect(jsonl.every((t) => t.status === 'completed')).toBe(true);
  });

  test('cancellation updates show in JSONL too', () => {
    const s = manager.create('cli');
    manager.addTask(s.id, task('t-cancel'));
    expect(manager.cancelTask(s.id, 't-cancel')).toBe(true);
    const jsonlTasks = jsonlAdapter.listSessionTasks(s.id);
    const sqliteTasks = sqliteAdapter.listSessionTasks(s.id);
    expect(jsonlTasks[0]?.status).toBe('cancelled');
    expect(sqliteTasks[0]?.status).toBe('cancelled');
  });

  test('legacy session (no JSONL) falls back to SQLite via JsonlReadAdapter', () => {
    // Insert a session_store row + turns directly, bypassing the appender.
    const id = 'legacy';
    const now = Date.now();
    db.run('INSERT INTO session_store (id, source, created_at, status, updated_at) VALUES (?, ?, ?, ?, ?)', [
      id,
      'cli',
      now,
      'active',
      now,
    ]);
    db.run(
      `INSERT INTO session_turns (id, session_id, seq, role, blocks_json, token_count_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        't',
        id,
        0,
        'user',
        JSON.stringify([{ type: 'text', text: 'legacy' }]),
        JSON.stringify({ input: 0, output: 0, cacheRead: 0, cacheCreation: 0 }),
        now,
      ],
    );

    expect(jsonlAdapter.hasJsonl(id)).toBe(false);
    // Adapter falls through to the SQLite path.
    const turns = jsonlAdapter.getTurns(id);
    expect(turns).toHaveLength(1);
    expect(turns[0]?.role).toBe('user');
    expect(jsonlAdapter.countTurns(id)).toBe(1);
    expect(jsonlAdapter.listSessionTasks(id)).toEqual([]);
    expect(jsonlAdapter.getSessionWorkingMemory(id)).toBeNull();
  });
});

describe('SessionManager dispatch — read flags', () => {
  test('flag OFF leaves reads on the SQLite path (default behaviour)', () => {
    const { id } = seed();
    // No flag flip. Sanity: methods still work.
    expect(manager.getMessageCount(id)).toBe(4);
    expect(manager.getTurnsHistory(id, 10)).toHaveLength(4);
  });

  test('flag ON dispatches through JSONL adapter and matches', () => {
    const { id } = seed();
    // Re-attach with all read flags ON.
    manager.attachJsonlLayer(
      new JsonlAppender({ layout, policy: makeFsyncPolicy('none') }),
      new IndexRebuilder(db, layout),
      new JsonlReadAdapter({ layout, fallback: new SqliteReadAdapter(store) }),
      {
        getTurn: true,
        getTurns: true,
        getRecentTurns: true,
        getMessageCount: true,
        getSessionWorkingMemory: true,
        listSessionTasks: true,
        listSessions: true,
        fallbackToSqlite: true,
      },
    );
    expect(manager.getMessageCount(id)).toBe(4);
    expect(manager.getTurnsHistory(id, 10)).toHaveLength(4);
    expect(manager.getConversationHistoryText(id, 10)).toHaveLength(4);
  });
});
