/**
 * API Server Tests — TDD §22.8 Acceptance Criteria
 *
 * Uses handleRequest() directly — no Bun.serve(), no port binding.
 */

import { Database } from 'bun:sqlite';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { VinyanAPIServer } from '../../src/api/server.ts';
import { SessionManager } from '../../src/api/session-manager.ts';
import { createBus } from '../../src/core/bus.ts';
import { ALL_MIGRATIONS, MigrationRunner } from '../../src/db/migrations/index.ts';
import { SessionStore } from '../../src/db/session-store.ts';
import type { TaskInput, TaskResult } from '../../src/orchestrator/types.ts';

const TEST_DIR = join(tmpdir(), `vinyan-api-test-${Date.now()}`);
const TOKEN_PATH = join(TEST_DIR, 'api-token');
const TEST_TOKEN = `test-token-${'a'.repeat(52)}`;

let server: VinyanAPIServer;
let db: Database;

function mockExecuteTask(input: TaskInput): Promise<TaskResult> {
  return Promise.resolve({
    id: input.id,
    status: 'completed',
    mutations: [],
    trace: {
      id: `trace-${input.id}`,
      task_id: input.id,
      timestamp: Date.now(),
      routing_level: 1,
      approach: 'test',
      modelUsed: 'mock/test',
      tokensConsumed: 100,
      durationMs: 50,
      outcome: 'success',
      oracleVerdicts: {},
      affectedFiles: [],
    } as any,
  });
}

/** Build a Request targeting the server's handleRequest directly. */
function req(path: string, opts: { method?: string; headers?: Record<string, string>; body?: string } = {}): Request {
  return new Request(`http://localhost${path}`, {
    method: opts.method ?? 'GET',
    headers: opts.headers,
    body: opts.body,
  });
}

const authHeaders = { Authorization: `Bearer ${TEST_TOKEN}`, 'Content-Type': 'application/json' };

beforeAll(() => {
  mkdirSync(TEST_DIR, { recursive: true });
  writeFileSync(TOKEN_PATH, TEST_TOKEN);

  db = new Database(':memory:');
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  new MigrationRunner().migrate(db, ALL_MIGRATIONS);

  const bus = createBus();
  const sessionStore = new SessionStore(db);
  const sessionManager = new SessionManager(sessionStore);

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
  // No server.start() — we call handleRequest directly
});

afterAll(() => {
  db.close();
});

describe('API Server', () => {
  // ── Criterion 1: Sync task submission ───────────────────
  test('POST /api/v1/tasks returns TaskResult', async () => {
    const res = await server.handleRequest(
      req('/api/v1/tasks', {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({ goal: 'test task' }),
      }),
    );

    expect(res.status).toBe(200);
    const data = (await res.json()) as any;
    expect(data.result.status).toBe('completed');
  });

  // ── Criterion 2: Async task submission ──────────────────
  test('POST /api/v1/tasks/async returns 202 with taskId', async () => {
    const res = await server.handleRequest(
      req('/api/v1/tasks/async', {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({ goal: 'async test' }),
      }),
    );

    expect(res.status).toBe(202);
    const data = (await res.json()) as any;
    expect(data.taskId).toBeTruthy();
    expect(data.status).toBe('accepted');

    // Poll for completion
    await new Promise((r) => setTimeout(r, 50));
    const poll = await server.handleRequest(req(`/api/v1/tasks/${data.taskId}`, { headers: authHeaders }));
    const pollData = (await poll.json()) as any;
    expect(pollData.status).toBe('completed');
  });

  // ── Criterion 4: Session management ─────────────────────
  test('session create + get', async () => {
    const createRes = await server.handleRequest(
      req('/api/v1/sessions', {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({ source: 'test' }),
      }),
    );

    expect(createRes.status).toBe(201);
    const { session } = (await createRes.json()) as any;
    expect(session.id).toBeTruthy();
    expect(session.source).toBe('test');

    const getRes = await server.handleRequest(req(`/api/v1/sessions/${session.id}`, { headers: authHeaders }));
    expect(getRes.status).toBe(200);
  });

  // ── Criterion 7: Auth enforcement (I15) ─────────────────
  test('POST /tasks without token returns 401', async () => {
    const res = await server.handleRequest(
      req('/api/v1/tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ goal: 'no auth' }),
      }),
    );

    expect(res.status).toBe(401);
  });

  test('GET /health without token returns 200', async () => {
    const res = await server.handleRequest(req('/api/v1/health'));
    expect(res.status).toBe(200);
    const data = (await res.json()) as any;
    expect(data.status).toBe('ok');
  });

  // ── Read-only endpoints ─────────────────────────────────
  test('GET /workers returns array', async () => {
    const res = await server.handleRequest(req('/api/v1/workers'));
    expect(res.status).toBe(200);
    const data = (await res.json()) as any;
    expect(data.workers).toBeArray();
  });

  test('GET /rules returns array', async () => {
    const res = await server.handleRequest(req('/api/v1/rules'));
    expect(res.status).toBe(200);
    const data = (await res.json()) as any;
    expect(data.rules).toBeArray();
  });

  // ── 404 for unknown routes ──────────────────────────────
  test('unknown route returns 404', async () => {
    const res = await server.handleRequest(req('/api/v1/unknown', { headers: authHeaders }));
    expect(res.status).toBe(404);
  });
});
