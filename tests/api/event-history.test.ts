/**
 * API server — `/api/v1/tasks/:id/event-history` endpoint and detailed
 * message shape.
 *
 * Wires a real TaskEventStore + TraceStore into the API server and verifies
 * the chat UI's historical-process replay path end-to-end through
 * `handleRequest()` — no port binding.
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
import { SessionStore } from '../../src/db/session-store.ts';
import { TaskEventStore } from '../../src/db/task-event-store.ts';
import { TRACE_SCHEMA_SQL, migratePipelineConfidenceColumns, migrateThinkingColumns, migrateTranscriptColumns } from '../../src/db/trace-schema.ts';
import { TraceStore } from '../../src/db/trace-store.ts';
import type { ExecutionTrace, TaskInput, TaskResult } from '../../src/orchestrator/types.ts';

const TEST_DIR = join(tmpdir(), `vinyan-event-history-test-${Date.now()}`);
const TOKEN_PATH = join(TEST_DIR, 'api-token');
const TEST_TOKEN = `test-token-${'a'.repeat(52)}`;

let server: VinyanAPIServer;
let db: Database;
let bus: VinyanBus;
let sessionStore: SessionStore;
let traceStore: TraceStore;
let taskEventStore: TaskEventStore;

const authHeaders = { Authorization: `Bearer ${TEST_TOKEN}`, 'Content-Type': 'application/json' };

function req(path: string): Request {
  return new Request(`http://localhost${path}`, { method: 'GET', headers: authHeaders });
}

function makeTrace(taskId: string): ExecutionTrace {
  return {
    id: `trace-${taskId}`,
    taskId,
    timestamp: Date.now(),
    routingLevel: 2,
    approach: 'mock',
    modelUsed: 'mock/test',
    tokensConsumed: 250,
    durationMs: 1234,
    outcome: 'success',
    oracleVerdicts: [],
    affectedFiles: [],
  } as unknown as ExecutionTrace;
}

beforeAll(() => {
  mkdirSync(TEST_DIR, { recursive: true });
  writeFileSync(TOKEN_PATH, TEST_TOKEN);

  db = new Database(':memory:');
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  new MigrationRunner().migrate(db, ALL_MIGRATIONS);
  // execution_traces lives outside ALL_MIGRATIONS — bootstrap separately.
  db.exec(TRACE_SCHEMA_SQL);
  migratePipelineConfidenceColumns(db);
  migrateTranscriptColumns(db);
  migrateThinkingColumns(db);

  bus = createBus();
  sessionStore = new SessionStore(db);
  traceStore = new TraceStore(db);
  taskEventStore = new TaskEventStore(db);

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
          trace: makeTrace(input.id),
          answer: 'ok',
        } as TaskResult),
      sessionManager,
      traceStore,
      taskEventStore,
    },
  );
});

afterAll(() => {
  db.close();
});

describe('GET /api/v1/tasks/:id/event-history', () => {
  test('returns persisted events in seq order', async () => {
    taskEventStore.appendBatch([
      { taskId: 'task-A', eventType: 'phase:timing', payload: { phase: 'plan', durationMs: 5 }, ts: 100 },
      { taskId: 'task-A', eventType: 'agent:thinking', payload: { content: 'hmm' }, ts: 101 },
      { taskId: 'task-A', eventType: 'oracle:verdict', payload: { oracle: 'ast', verdict: 'pass' }, ts: 102 },
    ]);

    const res = await server.handleRequest(req('/api/v1/tasks/task-A/event-history'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      taskId: string;
      events: Array<{ eventType: string; seq: number }>;
      lastSeq: number;
    };

    expect(body.taskId).toBe('task-A');
    expect(body.events.map((e) => e.eventType)).toEqual([
      'phase:timing',
      'agent:thinking',
      'oracle:verdict',
    ]);
    expect(body.lastSeq).toBe(3);
  });

  test('honors `since` cursor for incremental fetch', async () => {
    const res = await server.handleRequest(req('/api/v1/tasks/task-A/event-history?since=3'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { events: Array<{ seq: number }>; lastSeq: number };
    // Only seq=3 (oracle:verdict) matches since>=3.
    expect(body.events.length).toBe(1);
    expect(body.events[0]?.seq).toBe(3);
  });

  test('returns empty array (not 404) for an unknown task with recorder wired', async () => {
    const res = await server.handleRequest(req('/api/v1/tasks/unknown-task/event-history'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { events: unknown[] };
    expect(body.events).toEqual([]);
  });
});

describe('GET /api/v1/sessions/:id/messages — detailed shape', () => {
  test('attaches traceSummary onto assistant turns when traceStore is wired', async () => {
    // Create a session and seed it directly via SessionStore to keep the
    // test focused on the messages endpoint shape.
    const sessRes = await server.handleRequest(
      new Request('http://localhost/api/v1/sessions', {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({ source: 'test' }),
      }),
    );
    const { session } = (await sessRes.json()) as { session: { id: string } };

    const taskId = 'task-msg-1';
    traceStore.insert(makeTrace(taskId));

    sessionStore.appendTurn({
      id: 'turn-user',
      sessionId: session.id,
      seq: 0,
      role: 'user',
      blocks: [{ type: 'text', text: 'hello' }],
      tokenCount: { input: 1, output: 0, cacheRead: 0, cacheCreation: 0 },
      createdAt: Date.now(),
    });
    sessionStore.appendTurn({
      id: 'turn-asst',
      sessionId: session.id,
      seq: 1,
      role: 'assistant',
      blocks: [
        { type: 'thinking', thinking: 'reasoning…' },
        { type: 'tool_use', id: 'tu-1', name: 'read', input: { path: '/x' } },
        { type: 'text', text: 'done' },
      ],
      tokenCount: { input: 5, output: 5, cacheRead: 0, cacheCreation: 0 },
      createdAt: Date.now(),
      taskId,
    });

    const res = await server.handleRequest(req(`/api/v1/sessions/${session.id}/messages`));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      messages: Array<{
        role: string;
        content: string;
        taskId: string;
        thinking?: string;
        toolsUsed?: Array<{ name: string }>;
        traceSummary?: { modelUsed: string; routingLevel: number };
      }>;
    };

    const assistant = body.messages.find((m) => m.role === 'assistant');
    expect(assistant).toBeDefined();
    expect(assistant?.thinking).toContain('reasoning');
    expect(assistant?.toolsUsed?.[0]?.name).toBe('read');
    expect(assistant?.traceSummary?.modelUsed).toBe('mock/test');
    expect(assistant?.traceSummary?.routingLevel).toBe(2);
  });
});
