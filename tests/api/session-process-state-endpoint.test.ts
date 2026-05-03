/**
 * GET /api/v1/sessions/:sid/process-state — HTTP integration tests.
 *
 * Mirrors `process-state-endpoint.test.ts` for the task variant. The
 * session-scoped endpoint backs the A8 audit redesign's
 * `/audit/sessions/:sid` UI route. Thin pass-through to
 * `SessionProcessProjectionService`; the service's own behavior is
 * already pinned by `tests/api/session-process-projection.test.ts`.
 *
 * Three claims under test:
 *
 *   1. 200 path — a real seeded session returns the projection with
 *      `lifecycle.lifecycleState` matching the service-layer derivation
 *      and `audit` counts matching `session_tasks` rows.
 *   2. 404 path — unknown sessionId returns 404 with the
 *      `{ error: 'Session not found', sessionId }` envelope shape that
 *      mirrors the task-variant 404.
 *   3. Auth path — missing / invalid bearer behaves identically to the
 *      task variant (HTTP 401, no body leak).
 */
import { Database } from 'bun:sqlite';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SessionProcessProjection } from '../../src/api/projections/session-process-projection.ts';
import { VinyanAPIServer } from '../../src/api/server.ts';
import { SessionManager } from '../../src/api/session-manager.ts';
import { createBus } from '../../src/core/bus.ts';
import { ALL_MIGRATIONS, MigrationRunner } from '../../src/db/migrations/index.ts';
import { SessionStore } from '../../src/db/session-store.ts';
import { TaskEventStore } from '../../src/db/task-event-store.ts';
import {
  migratePipelineConfidenceColumns,
  migrateThinkingColumns,
  migrateTranscriptColumns,
  TRACE_SCHEMA_SQL,
} from '../../src/db/trace-schema.ts';
import { TraceStore } from '../../src/db/trace-store.ts';
import type { TaskInput, TaskResult } from '../../src/orchestrator/types.ts';

const TEST_DIR = join(tmpdir(), `vinyan-session-process-state-${Date.now()}`);
const TOKEN_PATH = join(TEST_DIR, 'api-token');
const TEST_TOKEN = `test-token-${'b'.repeat(52)}`;
const headersWithAuth = { Authorization: `Bearer ${TEST_TOKEN}`, 'Content-Type': 'application/json' };

let server: VinyanAPIServer;
let db: Database;
let sessionStore: SessionStore;

function get(path: string, headers: Record<string, string> = headersWithAuth): Request {
  return new Request(`http://localhost${path}`, { method: 'GET', headers });
}

beforeAll(() => {
  mkdirSync(TEST_DIR, { recursive: true });
  writeFileSync(TOKEN_PATH, TEST_TOKEN);

  db = new Database(':memory:');
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  new MigrationRunner().migrate(db, ALL_MIGRATIONS);
  db.exec(TRACE_SCHEMA_SQL);
  migratePipelineConfidenceColumns(db);
  migrateTranscriptColumns(db);
  migrateThinkingColumns(db);

  const bus = createBus();
  sessionStore = new SessionStore(db);
  const traceStore = new TraceStore(db);
  const taskEventStore = new TaskEventStore(db);
  const sessionManager = new SessionManager(sessionStore, traceStore);

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
      executeTask: (input: TaskInput) =>
        Promise.resolve({
          id: input.id,
          status: 'completed',
          mutations: [],
          answer: 'ok',
        } as unknown as TaskResult),
      sessionManager,
      traceStore,
      taskEventStore,
    },
  );
});

afterAll(() => {
  db.close();
});

function plantSession(opts: {
  sessionId: string;
  status?: 'active' | 'suspended' | 'compacted' | 'closed';
  archivedAt?: number | null;
  deletedAt?: number | null;
  title?: string | null;
}): void {
  sessionStore.insertSession({
    id: opts.sessionId,
    source: 'cli',
    created_at: 1000,
    status: opts.status ?? 'active',
    working_memory_json: null,
    compaction_json: null,
    updated_at: 2000,
    title: opts.title ?? null,
    description: null,
    archived_at: opts.archivedAt ?? null,
    deleted_at: opts.deletedAt ?? null,
  });
}

function plantTask(
  sessionId: string,
  taskId: string,
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled',
): void {
  sessionStore.insertTask({
    session_id: sessionId,
    task_id: taskId,
    task_input_json: JSON.stringify({ id: taskId, goal: 'g' }),
    status,
    result_json: null,
    created_at: 1100,
    updated_at: 1200,
    archived_at: null,
  });
}

describe('GET /api/v1/sessions/:sid/process-state', () => {
  test('returns 404 for an unknown session with the same envelope shape as the task variant', async () => {
    const res = await server.handleRequest(get('/api/v1/sessions/sess-ghost/process-state'));
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string; sessionId: string };
    expect(body.error).toBe('Session not found');
    expect(body.sessionId).toBe('sess-ghost');
  });

  test('returns the projection with correct lifecycleState + audit counts for a seeded session', async () => {
    plantSession({ sessionId: 'sess-active', title: 'audit smoke' });
    plantTask('sess-active', 't-c1', 'completed');
    plantTask('sess-active', 't-r1', 'running');
    plantTask('sess-active', 't-f1', 'failed');

    const res = await server.handleRequest(get('/api/v1/sessions/sess-active/process-state'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as SessionProcessProjection;

    expect(body.lifecycle.sessionId).toBe('sess-active');
    expect(body.lifecycle.lifecycleState).toBe('active');
    expect(body.lifecycle.title).toBe('audit smoke');
    expect(body.lifecycle.source).toBe('cli');

    expect(body.audit.totalTasks).toBe(3);
    expect(body.audit.completedTasks).toBe(1);
    expect(body.audit.runningTasks).toBe(1);
    expect(body.audit.failedTasks).toBe(1);
    expect(body.audit.archivedTasks).toBe(0);

    expect(body.tasks.map((t) => t.taskId).sort()).toEqual(['t-c1', 't-f1', 't-r1']);
  });

  test('lifecycleState derives "trashed" when deleted_at is set (priority over archived)', async () => {
    plantSession({
      sessionId: 'sess-trashed',
      archivedAt: 5000,
      deletedAt: 6000,
    });
    const res = await server.handleRequest(get('/api/v1/sessions/sess-trashed/process-state'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as SessionProcessProjection;
    expect(body.lifecycle.lifecycleState).toBe('trashed');
  });

  test('returns 401 without a bearer token (mirrors task variant)', async () => {
    plantSession({ sessionId: 'sess-noauth' });
    const res = await server.handleRequest(
      get('/api/v1/sessions/sess-noauth/process-state', { 'Content-Type': 'application/json' }),
    );
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('Unauthorized');
  });

  test('returns 401 with an invalid bearer token (mirrors task variant)', async () => {
    plantSession({ sessionId: 'sess-badtok' });
    const res = await server.handleRequest(
      get('/api/v1/sessions/sess-badtok/process-state', {
        Authorization: 'Bearer wrong-token-value',
        'Content-Type': 'application/json',
      }),
    );
    expect(res.status).toBe(401);
  });
});
