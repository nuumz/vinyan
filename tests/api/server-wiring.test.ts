/**
 * API Server Wiring Tests — verify closed wiring gaps (G1-G4).
 *
 * Uses handleRequest() directly — no Bun.serve(), no port binding.
 *
 * Covers:
 *  1. Prometheus text format on GET /api/v1/metrics (default)
 *  2. JSON format on GET /api/v1/metrics?format=json with SystemMetrics fields
 *  3. Bus events emitted for api:request and api:response
 *  4. Session tracking: POST /api/v1/tasks creates session tasks
 *  5. session:created bus event on POST /api/v1/sessions
 */

import { Database } from 'bun:sqlite';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { VinyanAPIServer } from '../../src/api/server.ts';
import { SessionManager } from '../../src/api/session-manager.ts';
import type { VinyanBus } from '../../src/core/bus.ts';
import { createBus } from '../../src/core/bus.ts';
import { ALL_MIGRATIONS, MigrationRunner } from '../../src/db/migrations/index.ts';
import { migratePipelineConfidenceColumns } from '../../src/db/trace-schema.ts';
import { SessionStore } from '../../src/db/session-store.ts';
import { TraceStore } from '../../src/db/trace-store.ts';
import { MetricsCollector } from '../../src/observability/metrics.ts';
import type { TaskInput, TaskResult } from '../../src/orchestrator/types.ts';

const TEST_DIR = join(tmpdir(), `vinyan-wiring-test-${Date.now()}`);
const TOKEN_PATH = join(TEST_DIR, 'api-token');
const TEST_TOKEN = `test-token-${'b'.repeat(52)}`;

let server: VinyanAPIServer;
let db: Database;
let bus: VinyanBus;

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
  migratePipelineConfidenceColumns(db);

  bus = createBus();
  const sessionStore = new SessionStore(db);
  const sessionManager = new SessionManager(sessionStore);
  const traceStore = new TraceStore(db);
  const metricsCollector = new MetricsCollector();
  metricsCollector.attach(bus);

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
      traceStore,
      metricsCollector,
    },
  );
  // No server.start() — we call handleRequest directly
});

afterAll(() => {
  db.close();
});

describe('API Server Wiring', () => {
  // ── 1. Prometheus text format by default ──────────────────
  test('GET /api/v1/metrics returns Prometheus text format by default', async () => {
    const res = await server.handleRequest(req('/api/v1/metrics', { headers: authHeaders }));

    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('text/plain; version=0.0.4');

    const body = await res.text();
    expect(body).toContain('vinyan_tasks_total');
    expect(body).toContain('vinyan_task_success_rate');
    expect(body).toContain('vinyan_rules_active');
    expect(body).toContain('vinyan_skills_active');
    expect(body).toContain('vinyan_shadow_queue_depth');
    expect(body).toContain('vinyan_workers_active');
  });

  // ── 2. JSON format with full SystemMetrics fields ─────────
  test('GET /api/v1/metrics?format=json returns JSON with SystemMetrics fields', async () => {
    const res = await server.handleRequest(req('/api/v1/metrics?format=json', { headers: authHeaders }));

    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('application/json');

    const data = (await res.json()) as any;

    // SystemMetrics fields
    expect(data.traces).toBeDefined();
    expect(typeof data.traces.total).toBe('number');
    expect(typeof data.traces.successRate).toBe('number');
    expect(typeof data.traces.distinctTaskTypes).toBe('number');
    expect(typeof data.traces.avgQualityComposite).toBe('number');
    expect(data.traces.routingDistribution).toBeDefined();

    expect(data.rules).toBeDefined();
    expect(typeof data.rules.active).toBe('number');
    expect(typeof data.rules.probation).toBe('number');

    expect(data.skills).toBeDefined();
    expect(typeof data.skills.active).toBe('number');

    expect(data.patterns).toBeDefined();
    expect(data.shadow).toBeDefined();
    expect(data.workers).toBeDefined();
    expect(data.dataGates).toBeDefined();

    // Extra fields injected by API server
    expect(typeof data.tasks_in_flight).toBe('number');
    expect(data.counters).toBeDefined();
  });

  // ── 3. Bus events for api:request and api:response ────────
  test('bus emits api:request and api:response on API calls', async () => {
    const requestEvents: any[] = [];
    const responseEvents: any[] = [];

    const unsubReq = bus.on('api:request', (e) => requestEvents.push(e));
    const unsubRes = bus.on('api:response', (e) => responseEvents.push(e));

    try {
      await server.handleRequest(req('/api/v1/health'));

      expect(requestEvents.length).toBeGreaterThanOrEqual(1);
      const reqEvent = requestEvents[requestEvents.length - 1];
      expect(reqEvent.method).toBe('GET');
      expect(reqEvent.path).toBe('/api/v1/health');

      expect(responseEvents.length).toBeGreaterThanOrEqual(1);
      const resEvent = responseEvents[responseEvents.length - 1];
      expect(resEvent.method).toBe('GET');
      expect(resEvent.path).toBe('/api/v1/health');
      expect(resEvent.status).toBe(200);
      expect(typeof resEvent.durationMs).toBe('number');
    } finally {
      unsubReq();
      unsubRes();
    }
  });

  // ── 4. Session tracking: POST /tasks creates session tasks ─
  test('POST /api/v1/tasks creates a session task', async () => {
    const res = await server.handleRequest(
      req('/api/v1/tasks', {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({ goal: 'wiring test task' }),
      }),
    );

    expect(res.status).toBe(200);
    const data = (await res.json()) as any;
    const taskId = data.result.id;
    expect(taskId).toBeTruthy();

    const res2 = await server.handleRequest(
      req('/api/v1/tasks', {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({ goal: 'second wiring test task' }),
      }),
    );
    expect(res2.status).toBe(200);

    // Create an explicit session
    const sessionRes = await server.handleRequest(
      req('/api/v1/sessions', {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({ source: 'wiring-test' }),
      }),
    );
    expect(sessionRes.status).toBe(201);

    // Verify the default session has tasks via DB
    const taskRows = db.query('SELECT COUNT(*) as cnt FROM session_tasks').get() as any;
    expect(taskRows.cnt).toBeGreaterThanOrEqual(2);
  });

  // ── 5. session:created bus event on POST /sessions ────────
  test('session:created bus event is emitted when creating a session', async () => {
    const events: any[] = [];
    const unsub = bus.on('session:created', (e) => events.push(e));

    try {
      const res = await server.handleRequest(
        req('/api/v1/sessions', {
          method: 'POST',
          headers: authHeaders,
          body: JSON.stringify({ source: 'bus-event-test' }),
        }),
      );

      expect(res.status).toBe(201);
      const { session } = (await res.json()) as any;

      expect(events.length).toBeGreaterThanOrEqual(1);
      const event = events[events.length - 1];
      expect(event.sessionId).toBe(session.id);
      expect(event.source).toBe('bus-event-test');
    } finally {
      unsub();
    }
  });
});
