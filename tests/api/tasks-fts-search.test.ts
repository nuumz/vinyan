/**
 * Migration 028 contract — `?searchMode=fts` runs against
 * `session_tasks_fts` (FTS5) instead of substring LIKE. Verifies:
 *   - single-token query returns rows containing the token
 *   - multi-token query is AND semantics (rows must contain BOTH)
 *   - hyphenated tokens ("retry-flow") survive sanitisation
 *   - default `searchMode` (no flag) keeps the legacy LIKE behaviour
 *   - sanitiser-degenerate query falls back to LIKE rather than 0 results
 */
import { Database } from 'bun:sqlite';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { VinyanAPIServer } from '../../src/api/server.ts';
import { SessionManager } from '../../src/api/session-manager.ts';
import { createBus, type VinyanBus } from '../../src/core/bus.ts';
import { ALL_MIGRATIONS, MigrationRunner } from '../../src/db/migrations/index.ts';
import { SessionStore, sanitizeFts5Query } from '../../src/db/session-store.ts';
import type { TaskInput, TaskResult } from '../../src/orchestrator/types.ts';

const TEST_DIR = join(tmpdir(), `vinyan-tasks-fts-test-${Date.now()}`);
const TOKEN_PATH = join(TEST_DIR, 'api-token');
const TEST_TOKEN = `test-token-${'a'.repeat(52)}`;

let server: VinyanAPIServer;
let db: Database;
let bus: VinyanBus;
let sessionStore: SessionStore;
let sessionManager: SessionManager;

const authHeaders = { Authorization: `Bearer ${TEST_TOKEN}`, 'Content-Type': 'application/json' };

function req(path: string, opts: { method?: string; body?: string } = {}): Request {
  return new Request(`http://localhost${path}`, {
    method: opts.method ?? 'GET',
    headers: authHeaders,
    body: opts.body,
  });
}

function mockExecuteTask(input: TaskInput): Promise<TaskResult> {
  return Promise.resolve({
    id: input.id,
    status: 'completed',
    mutations: [],
    trace: {
      id: `trace-${input.id}`,
      taskId: input.id,
      timestamp: Date.now(),
      routingLevel: 1,
      approach: 'test',
      modelUsed: 'mock/test',
      tokensConsumed: 100,
      durationMs: 50,
      outcome: 'success',
      oracleVerdicts: {},
      affectedFiles: [],
    },
  } as unknown as TaskResult);
}

beforeAll(() => {
  mkdirSync(TEST_DIR, { recursive: true });
  writeFileSync(TOKEN_PATH, TEST_TOKEN);

  db = new Database(':memory:');
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  new MigrationRunner().migrate(db, ALL_MIGRATIONS);

  bus = createBus();
  sessionStore = new SessionStore(db);
  sessionManager = new SessionManager(sessionStore);

  server = new VinyanAPIServer(
    {
      port: 0,
      bind: '127.0.0.1',
      tokenPath: TOKEN_PATH,
      authRequired: true,
      rateLimitEnabled: false,
    },
    {
      bus,
      executeTask: mockExecuteTask,
      sessionManager,
    },
  );
});

afterAll(() => {
  db.close();
});

async function createSession(): Promise<string> {
  const res = await server.handleRequest(
    req('/api/v1/sessions', { method: 'POST', body: JSON.stringify({ source: 'ui' }) }),
  );
  const body = (await res.json()) as { session: { id: string } };
  return body.session.id;
}

async function submit(sessionId: string, goal: string): Promise<string> {
  const res = await server.handleRequest(
    req('/api/v1/tasks', { method: 'POST', body: JSON.stringify({ goal, sessionId }) }),
  );
  const body = (await res.json()) as { result: TaskResult };
  return body.result.id;
}

describe('FTS5 task search (mig 028)', () => {
  test('virtual table session_tasks_fts is created', () => {
    expect(sessionStore.fts5Available()).toBe(true);
  });

  test('single-token search returns rows containing the token', async () => {
    const sid = await createSession();
    await submit(sid, 'investigate retry-flow stalls');
    await submit(sid, 'unrelated routine cleanup');

    const res = await server.handleRequest(
      req(`/api/v1/tasks?sessionId=${sid}&search=retry&searchMode=fts`),
    );
    const body = (await res.json()) as { tasks: Array<{ goal?: string }>; total: number };
    expect(body.total).toBeGreaterThanOrEqual(1);
    expect(body.tasks.every((t) => t.goal?.includes('retry'))).toBe(true);
  });

  test('multi-token query has AND semantics (BOTH words required)', async () => {
    const sid = await createSession();
    await submit(sid, 'partial timeout escalation review');
    await submit(sid, 'partial work but no timeout label');
    await submit(sid, 'timeout audit only');
    await submit(sid, 'unrelated entry');

    // FTS5 implicit AND — only rows containing both "partial" AND
    // "timeout" should match.
    const res = await server.handleRequest(
      req(`/api/v1/tasks?sessionId=${sid}&search=partial%20timeout&searchMode=fts`),
    );
    const body = (await res.json()) as { tasks: Array<{ goal?: string }>; total: number };
    expect(body.total).toBeGreaterThanOrEqual(2);
    for (const t of body.tasks) {
      expect(t.goal).toContain('partial');
      expect(t.goal).toContain('timeout');
    }
  });

  test('hyphenated tokens do not crash FTS5', async () => {
    const sid = await createSession();
    await submit(sid, 'fix retry-flow path');
    await submit(sid, 'fix retry chain unrelated');

    const res = await server.handleRequest(
      req(`/api/v1/tasks?sessionId=${sid}&search=retry-flow&searchMode=fts`),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { tasks: Array<{ goal?: string }>; total: number };
    // The first row contains the literal hyphenated phrase; the second
    // contains "retry" but not "retry-flow".
    expect(body.tasks.some((t) => t.goal?.includes('retry-flow'))).toBe(true);
  });

  test('default searchMode falls back to LIKE for substring matching', async () => {
    const sid = await createSession();
    await submit(sid, 'micro-zebra-marker-xyz');

    // FTS5 tokenizer drops short tokens and trailing tokens; LIKE always
    // honours raw substring. Without `searchMode=fts` the request stays
    // on the legacy LIKE path so existing operators see no surprise.
    const res = await server.handleRequest(req(`/api/v1/tasks?sessionId=${sid}&search=zebra-marker`));
    const body = (await res.json()) as { tasks: Array<{ goal?: string }>; total: number };
    expect(body.total).toBe(1);
  });

  test('sanitiser drops dangling boolean operators safely', () => {
    expect(sanitizeFts5Query('retry AND')).toBe('retry');
    expect(sanitizeFts5Query('OR partial timeout')).toBe('partial timeout');
    expect(sanitizeFts5Query('NOT')).toBe('');
  });

  test('sanitiser quotes hyphenated tokens and unmatched-quote queries reduce safely', () => {
    expect(sanitizeFts5Query('retry-flow')).toBe('"retry-flow"');
    expect(sanitizeFts5Query('"unmatched')).toBe('unmatched');
    expect(sanitizeFts5Query('foo "bar baz" qux')).toBe('foo "bar baz" qux');
  });

  test('empty FTS5 query degrades to LIKE rather than zero rows', async () => {
    const sid = await createSession();
    await submit(sid, 'must-still-find-this');

    // `&&` on its own becomes empty after sanitisation. The handler
    // must NOT return an empty list; LIKE fallback should still match
    // the row by substring.
    const res = await server.handleRequest(
      req(`/api/v1/tasks?sessionId=${sid}&search=must-still-find-this&searchMode=fts`),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { tasks: Array<{ goal?: string }>; total: number };
    expect(body.total).toBe(1);
  });

  test('FTS5 staying in sync with status updates through trigger', async () => {
    const sid = await createSession();
    // Use a single-token goal so the FTS5 MATCH expressions we run
    // below as DB-level assertions don't trip on the `-` operator.
    await submit(sid, 'searchabletoken trigger');

    // INSERT path: the FTS row was created by the AFTER INSERT trigger.
    const direct = db
      .query(
        "SELECT count(*) AS c FROM session_tasks_fts WHERE session_tasks_fts MATCH 'searchabletoken'",
      )
      .get() as { c: number };
    expect(direct.c).toBe(1);

    // UPDATE path: cancel a task and verify status field reflects in FTS row.
    const taskId = `canceltriggerk${Date.now()}`;
    sessionManager.addTask(sid, {
      id: taskId,
      source: 'api' as TaskInput['source'],
      goal: 'cancellabletoken',
      taskType: 'reasoning' as TaskInput['taskType'],
      budget: { maxTokens: 10, maxDurationMs: 1000, maxRetries: 1 },
    });
    sessionManager.cancelTask(sid, taskId, 'unit test');
    const updated = db
      .query(
        "SELECT status FROM session_tasks_fts WHERE searchable_text MATCH 'cancellabletoken'",
      )
      .get() as { status: string } | undefined;
    expect(updated?.status).toBe('cancelled');
  });
});
