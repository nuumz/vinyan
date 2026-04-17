/**
 * API Server — Phase D+E endpoints.
 *
 * Exercises:
 *   POST /api/v1/sessions/:id/clarification/respond
 *   POST /api/v1/sessions/:id/workflow/approve
 *   POST /api/v1/sessions/:id/workflow/reject
 *
 * All three endpoints translate HTTP bodies into bus events so the
 * orchestrator can resume (structured clarification → agent-loop;
 * approve/reject → awaitApprovalDecision).
 */
import { Database } from 'bun:sqlite';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { VinyanAPIServer } from '../../src/api/server.ts';
import { SessionManager } from '../../src/api/session-manager.ts';
import { createBus, type VinyanBus } from '../../src/core/bus.ts';
import { ALL_MIGRATIONS, MigrationRunner } from '../../src/db/migrations/index.ts';
import { SessionStore } from '../../src/db/session-store.ts';
import type { TaskInput, TaskResult } from '../../src/orchestrator/types.ts';

const TEST_DIR = join(tmpdir(), `vinyan-api-workflow-test-${Date.now()}`);
const TOKEN_PATH = join(TEST_DIR, 'api-token');
const TEST_TOKEN = `test-token-${'a'.repeat(52)}`;

let server: VinyanAPIServer;
let db: Database;
let testBus: VinyanBus;
let capturedEvents: Array<{ name: string; payload: unknown }>;

function req(
  path: string,
  opts: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Request {
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

  testBus = createBus();
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
      bus: testBus,
      executeTask: async (input: TaskInput): Promise<TaskResult> => ({
        id: input.id,
        status: 'completed',
        mutations: [],
        trace: {} as TaskResult['trace'],
      }),
      sessionManager,
    },
  );
});

beforeEach(() => {
  capturedEvents = [];
  // Subscribe to the three events under test — fresh bus listeners per test.
  testBus.on('workflow:plan_approved', (p) => capturedEvents.push({ name: 'workflow:plan_approved', payload: p }));
  testBus.on('workflow:plan_rejected', (p) => capturedEvents.push({ name: 'workflow:plan_rejected', payload: p }));
  testBus.on('agent:clarification_response', (p) => capturedEvents.push({ name: 'agent:clarification_response', payload: p }));
});

afterAll(() => {
  db.close();
});

async function postJson(path: string, body: unknown): Promise<Response> {
  return server.handleRequest(
    req(path, { method: 'POST', headers: authHeaders, body: JSON.stringify(body) }),
  );
}

// ---------------------------------------------------------------------------
// Workflow approval
// ---------------------------------------------------------------------------

describe('POST /api/v1/sessions/:id/workflow/approve', () => {
  test('emits workflow:plan_approved and returns 200', async () => {
    const res = await postJson('/api/v1/sessions/sess-1/workflow/approve', { taskId: 'task-1' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; taskId: string; sessionId: string };
    expect(body.status).toBe('approved');
    expect(body.taskId).toBe('task-1');
    expect(body.sessionId).toBe('sess-1');

    const emitted = capturedEvents.find((e) => e.name === 'workflow:plan_approved');
    expect(emitted).toBeDefined();
    expect(emitted!.payload).toEqual({ taskId: 'task-1', sessionId: 'sess-1' });
  });

  test('returns 400 when taskId is missing', async () => {
    const res = await postJson('/api/v1/sessions/sess-1/workflow/approve', {});
    expect(res.status).toBe(400);
    expect(capturedEvents.filter((e) => e.name === 'workflow:plan_approved')).toHaveLength(0);
  });

  test('returns 400 on malformed JSON body', async () => {
    const res = await server.handleRequest(
      req('/api/v1/sessions/sess-1/workflow/approve', {
        method: 'POST',
        headers: authHeaders,
        body: '{not json',
      }),
    );
    expect(res.status).toBe(400);
  });
});

describe('POST /api/v1/sessions/:id/workflow/reject', () => {
  test('emits workflow:plan_rejected with reason and returns 200', async () => {
    const res = await postJson('/api/v1/sessions/sess-1/workflow/reject', {
      taskId: 'task-2',
      reason: 'scope too large',
    });
    expect(res.status).toBe(200);
    const emitted = capturedEvents.find((e) => e.name === 'workflow:plan_rejected');
    expect(emitted).toBeDefined();
    expect(emitted!.payload).toEqual({
      taskId: 'task-2',
      sessionId: 'sess-1',
      reason: 'scope too large',
    });
  });

  test('reason is optional', async () => {
    await postJson('/api/v1/sessions/sess-1/workflow/reject', { taskId: 'task-3' });
    const emitted = capturedEvents.find((e) => e.name === 'workflow:plan_rejected');
    expect(emitted).toBeDefined();
    expect((emitted!.payload as { reason?: string }).reason).toBeUndefined();
  });

  test('returns 400 when taskId is missing', async () => {
    const res = await postJson('/api/v1/sessions/sess-1/workflow/reject', { reason: 'nope' });
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// Clarification response
// ---------------------------------------------------------------------------

describe('POST /api/v1/sessions/:id/clarification/respond', () => {
  test('emits agent:clarification_response with structured responses', async () => {
    const res = await postJson('/api/v1/sessions/sess-1/clarification/respond', {
      taskId: 'task-10',
      responses: [
        { questionId: 'genre', selectedOptionIds: ['romance-fantasy'] },
        { questionId: 'tone', selectedOptionIds: ['serious', 'heartwarming'] },
        { questionId: 'audience', selectedOptionIds: [], freeText: 'adults who like slow-burn' },
      ],
    });
    expect(res.status).toBe(200);

    const emitted = capturedEvents.find((e) => e.name === 'agent:clarification_response');
    expect(emitted).toBeDefined();
    const payload = emitted!.payload as {
      taskId: string;
      sessionId: string;
      responses: Array<{ questionId: string; selectedOptionIds: string[]; freeText?: string }>;
    };
    expect(payload.taskId).toBe('task-10');
    expect(payload.sessionId).toBe('sess-1');
    expect(payload.responses).toHaveLength(3);
    expect(payload.responses[0]!.selectedOptionIds).toEqual(['romance-fantasy']);
    expect(payload.responses[1]!.selectedOptionIds).toEqual(['serious', 'heartwarming']);
    expect(payload.responses[2]!.freeText).toContain('slow-burn');
  });

  test('returns 400 when responses is missing', async () => {
    const res = await postJson('/api/v1/sessions/sess-1/clarification/respond', { taskId: 'task-10' });
    expect(res.status).toBe(400);
  });

  test('returns 400 when taskId is missing', async () => {
    const res = await postJson('/api/v1/sessions/sess-1/clarification/respond', { responses: [] });
    expect(res.status).toBe(400);
  });

  test('coerces non-string selectedOptionIds into strings defensively', async () => {
    const res = await postJson('/api/v1/sessions/sess-1/clarification/respond', {
      taskId: 'task-10',
      responses: [{ questionId: 'genre', selectedOptionIds: [123, 'ok'] as never }],
    });
    expect(res.status).toBe(200);
    const emitted = capturedEvents.find((e) => e.name === 'agent:clarification_response');
    const payload = emitted!.payload as {
      responses: Array<{ selectedOptionIds: string[] }>;
    };
    expect(payload.responses[0]!.selectedOptionIds).toEqual(['123', 'ok']);
  });
});
