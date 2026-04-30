/**
 * API server — `GET /api/v1/sessions/:sessionId/event-history`.
 *
 * Wires a real `TaskEventStore` + `:memory:` SQLite into the API server
 * and verifies that the reconciler-facing endpoint composes correctly
 * through the HTTP routing layer. The store layer + handler each have
 * unit coverage already; this test pins the integration behaviour:
 * route match, query-string parsing, JSON shape, cursor round-trip, and
 * the 404 fallback when no recorder is wired.
 */
import { Database } from 'bun:sqlite';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { VinyanAPIServer } from '../../src/api/server.ts';
import { SessionManager } from '../../src/api/session-manager.ts';
import { createBus, type VinyanBus } from '../../src/core/bus.ts';
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

const TEST_DIR = join(tmpdir(), `vinyan-session-event-history-test-${Date.now()}`);
const TOKEN_PATH = join(TEST_DIR, 'api-token');
const TEST_TOKEN = `test-token-${'a'.repeat(52)}`;
const authHeaders = { Authorization: `Bearer ${TEST_TOKEN}`, 'Content-Type': 'application/json' };

let db: Database;
let bus: VinyanBus;
let taskEventStore: TaskEventStore;
let serverWithStore: VinyanAPIServer;
let serverWithoutStore: VinyanAPIServer;

function req(path: string): Request {
  return new Request(`http://localhost${path}`, { method: 'GET', headers: authHeaders });
}

beforeAll(() => {
  mkdirSync(TEST_DIR, { recursive: true });
  writeFileSync(TOKEN_PATH, TEST_TOKEN);

  db = new Database(':memory:');
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  new MigrationRunner().migrate(db, ALL_MIGRATIONS);
  // execution_traces lives outside ALL_MIGRATIONS — bootstrap separately
  // so SessionManager → TraceStore wiring doesn't blow up at startup.
  db.exec(TRACE_SCHEMA_SQL);
  migratePipelineConfidenceColumns(db);
  migrateTranscriptColumns(db);
  migrateThinkingColumns(db);

  bus = createBus();
  const sessionStore = new SessionStore(db);
  const traceStore = new TraceStore(db);
  taskEventStore = new TaskEventStore(db);
  const sessionManager = new SessionManager(sessionStore, traceStore);

  const apiOptions = {
    port: 0,
    bind: '127.0.0.1',
    tokenPath: TOKEN_PATH,
    authRequired: true,
    rateLimitEnabled: false,
  } as const;
  const baseDeps = {
    bus,
    executeTask: (input: TaskInput) =>
      Promise.resolve({ id: input.id, status: 'completed', mutations: [], answer: 'ok' } as unknown as TaskResult),
    sessionManager,
    traceStore,
  };

  serverWithStore = new VinyanAPIServer(apiOptions, { ...baseDeps, taskEventStore });
  serverWithoutStore = new VinyanAPIServer(apiOptions, { ...baseDeps });
});

afterAll(() => {
  db.close();
});

describe('GET /api/v1/sessions/:sessionId/event-history', () => {
  test('empty session returns empty events with no cursor', async () => {
    const res = await serverWithStore.handleRequest(req('/api/v1/sessions/never-seen/event-history'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { sessionId: string; events: unknown[]; nextCursor?: string };
    expect(body.sessionId).toBe('never-seen');
    expect(body.events).toEqual([]);
    expect(body.nextCursor).toBeUndefined();
  });

  test('returns events from multiple tasks ordered by (ts, id)', async () => {
    // Interleave events from two tasks under one session — the API
    // layer should expose them in chronological order regardless of
    // per-task seq.
    taskEventStore.appendBatch([
      { taskId: 'a', sessionId: 'sess-multi', eventType: 'phase:timing', payload: { i: 0 }, ts: 10 },
      { taskId: 'b', sessionId: 'sess-multi', eventType: 'phase:timing', payload: { i: 1 }, ts: 20 },
      { taskId: 'a', sessionId: 'sess-multi', eventType: 'phase:timing', payload: { i: 2 }, ts: 30 },
    ]);

    const res = await serverWithStore.handleRequest(
      req('/api/v1/sessions/sess-multi/event-history'),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      events: Array<{ taskId: string; payload: { i: number } }>;
      nextCursor?: string;
    };
    expect(body.events.map((e) => e.payload.i)).toEqual([0, 1, 2]);
    expect(body.events.map((e) => e.taskId)).toEqual(['a', 'b', 'a']);
    expect(typeof body.nextCursor).toBe('string');
  });

  test('cursor round-trip: paginates without overlap or gaps', async () => {
    for (let i = 0; i < 6; i++) {
      taskEventStore.append({
        taskId: i % 2 === 0 ? 'p' : 'q',
        sessionId: 'sess-page',
        eventType: 'phase:timing',
        payload: { i },
        // i+100 to avoid colliding with timestamps from the prior test.
        ts: i + 100,
      });
    }

    const page1Res = await serverWithStore.handleRequest(
      req('/api/v1/sessions/sess-page/event-history?limit=3'),
    );
    expect(page1Res.status).toBe(200);
    const page1 = (await page1Res.json()) as {
      events: Array<{ payload: { i: number } }>;
      nextCursor?: string;
    };
    expect(page1.events.length).toBe(3);
    expect(page1.nextCursor).toBeDefined();

    const page2Res = await serverWithStore.handleRequest(
      req(
        `/api/v1/sessions/sess-page/event-history?limit=3&since=${encodeURIComponent(
          page1.nextCursor as string,
        )}`,
      ),
    );
    expect(page2Res.status).toBe(200);
    const page2 = (await page2Res.json()) as {
      events: Array<{ payload: { i: number } }>;
      nextCursor?: string;
    };
    expect(page2.events.length).toBe(3);

    const merged = [...page1.events, ...page2.events].map((e) => e.payload.i);
    expect(merged).toEqual([0, 1, 2, 3, 4, 5]);

    // One more page beyond the data should be empty (and may or may not
    // expose a cursor — the contract says strict-greater pagination).
    const page3Res = await serverWithStore.handleRequest(
      req(
        `/api/v1/sessions/sess-page/event-history?since=${encodeURIComponent(
          page2.nextCursor as string,
        )}`,
      ),
    );
    expect(page3Res.status).toBe(200);
    const page3 = (await page3Res.json()) as { events: unknown[] };
    expect(page3.events.length).toBe(0);
  });

  test('returns 404 when no taskEventStore is wired (no DB)', async () => {
    const res = await serverWithoutStore.handleRequest(
      req('/api/v1/sessions/anything/event-history'),
    );
    expect(res.status).toBe(404);
  });
});
