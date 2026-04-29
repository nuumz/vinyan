/**
 * /api/v1/traces — `taskSignature` filter (canonical) + `taskType` legacy alias.
 *
 * Wires a real `TraceStore` into the API server and verifies:
 *   - `?taskSignature=<sig>` filters to that fingerprint exactly.
 *   - `?taskType=<sig>` still works (back-compat with older clients).
 *   - The two routes return the same rows for the same value.
 *   - Filter is exact (not prefix) — `review::typescript::small` does NOT
 *     match `review::typescript::medium`.
 *   - Unfiltered listing returns recent rows ordered by timestamp desc.
 *
 * The deep-link in the agent drawer drives this filter, so a regression
 * here breaks the proficiency row → trace history flow.
 */
import { Database } from 'bun:sqlite';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { VinyanAPIServer } from '../../src/api/server.ts';
import { SessionManager } from '../../src/api/session-manager.ts';
import { createBus } from '../../src/core/bus.ts';
import { ALL_MIGRATIONS, MigrationRunner } from '../../src/db/migrations/index.ts';
import { SessionStore } from '../../src/db/session-store.ts';
import {
  migratePipelineConfidenceColumns,
  migrateThinkingColumns,
  migrateTranscriptColumns,
  TRACE_SCHEMA_SQL,
} from '../../src/db/trace-schema.ts';
import { TraceStore } from '../../src/db/trace-store.ts';
import type { ExecutionTrace, TaskInput, TaskResult } from '../../src/orchestrator/types.ts';

const TEST_ROOT = join(tmpdir(), `vinyan-traces-by-sig-${Date.now()}-${process.pid}`);
const TOKEN_PATH = join(TEST_ROOT, 'api-token');
const TEST_TOKEN = `test-token-${'a'.repeat(52)}`;
const authHeaders = { Authorization: `Bearer ${TEST_TOKEN}`, 'Content-Type': 'application/json' };

let server: VinyanAPIServer;
let db: Database;

function req(path: string): Request {
  return new Request(`http://localhost${path}`, {
    method: 'GET',
    headers: authHeaders,
  });
}

function makeTrace(over: Partial<ExecutionTrace> & Pick<ExecutionTrace, 'id' | 'taskId' | 'taskTypeSignature'>): ExecutionTrace {
  return {
    id: over.id,
    taskId: over.taskId,
    timestamp: over.timestamp ?? Date.now(),
    routingLevel: 2,
    approach: 'mock',
    modelUsed: 'mock/test',
    tokensConsumed: 100,
    durationMs: 500,
    outcome: over.outcome ?? 'success',
    affectedFiles: [],
    oracleVerdicts: {},
    taskTypeSignature: over.taskTypeSignature,
    ...over,
  } as ExecutionTrace;
}

beforeAll(() => {
  mkdirSync(TEST_ROOT, { recursive: true });
  writeFileSync(TOKEN_PATH, TEST_TOKEN);

  db = new Database(':memory:');
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  new MigrationRunner().migrate(db, ALL_MIGRATIONS);
  db.exec(TRACE_SCHEMA_SQL);
  migratePipelineConfidenceColumns(db);
  migrateTranscriptColumns(db);
  migrateThinkingColumns(db);

  const traceStore = new TraceStore(db);
  // Three signatures, varying counts — enough to verify exact-match filtering.
  traceStore.insert(makeTrace({ id: 't1', taskId: 'task-1', taskTypeSignature: 'review::typescript::small', timestamp: 100 }));
  traceStore.insert(makeTrace({ id: 't2', taskId: 'task-2', taskTypeSignature: 'review::typescript::small', timestamp: 200 }));
  traceStore.insert(makeTrace({ id: 't3', taskId: 'task-3', taskTypeSignature: 'review::typescript::medium', timestamp: 300 }));
  traceStore.insert(makeTrace({ id: 't4', taskId: 'task-4', taskTypeSignature: 'unknown::none::single', timestamp: 400 }));

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
      bus: createBus(),
      executeTask: (input: TaskInput) =>
        Promise.resolve({ id: input.id, status: 'completed', mutations: [], answer: 'ok' } as unknown as TaskResult),
      sessionManager,
      traceStore,
    },
  );
});

afterAll(() => {
  db?.close();
});

describe('GET /api/v1/traces filtering', () => {
  test('?taskSignature= returns only matching rows (exact match, ordered by timestamp desc)', async () => {
    const res = await server.handleRequest(
      req('/api/v1/traces?taskSignature=review%3A%3Atypescript%3A%3Asmall'),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { traces: Array<{ id: string; taskTypeSignature: string }> };
    expect(body.traces.map((t) => t.id)).toEqual(['t2', 't1']);
    for (const t of body.traces) {
      expect(t.taskTypeSignature).toBe('review::typescript::small');
    }
  });

  test('?taskSignature= is exact, not prefix (medium does NOT bleed into small)', async () => {
    const res = await server.handleRequest(
      req('/api/v1/traces?taskSignature=review%3A%3Atypescript%3A%3Amedium'),
    );
    const body = (await res.json()) as { traces: Array<{ id: string }> };
    expect(body.traces.map((t) => t.id)).toEqual(['t3']);
  });

  test('?taskType= legacy alias still works for back-compat', async () => {
    const res = await server.handleRequest(
      req('/api/v1/traces?taskType=unknown%3A%3Anone%3A%3Asingle'),
    );
    const body = (await res.json()) as { traces: Array<{ id: string }> };
    expect(body.traces.map((t) => t.id)).toEqual(['t4']);
  });

  test('?taskSignature= takes precedence when both legacy and canonical are supplied', async () => {
    const res = await server.handleRequest(
      req(
        '/api/v1/traces?taskSignature=review%3A%3Atypescript%3A%3Asmall&taskType=unknown%3A%3Anone%3A%3Asingle',
      ),
    );
    const body = (await res.json()) as { traces: Array<{ id: string }> };
    expect(body.traces.map((t) => t.id).sort()).toEqual(['t1', 't2']);
  });

  test('no filter — returns all rows ordered by timestamp desc', async () => {
    const res = await server.handleRequest(req('/api/v1/traces'));
    const body = (await res.json()) as { traces: Array<{ id: string }>; total: number };
    expect(body.total).toBe(4);
    expect(body.traces.map((t) => t.id)).toEqual(['t4', 't3', 't2', 't1']);
  });

  test('unknown signature returns empty', async () => {
    const res = await server.handleRequest(
      req('/api/v1/traces?taskSignature=nope%3A%3Anope%3A%3Anope'),
    );
    const body = (await res.json()) as { traces: unknown[] };
    expect(body.traces).toEqual([]);
  });
});
