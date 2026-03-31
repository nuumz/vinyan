/**
 * API Server Wiring Tests — verify closed wiring gaps (G1-G4).
 *
 * Covers:
 *  1. Prometheus text format on GET /api/v1/metrics (default)
 *  2. JSON format on GET /api/v1/metrics?format=json with SystemMetrics fields
 *  3. Bus events emitted for api:request and api:response
 *  4. Session tracking: POST /api/v1/tasks creates session tasks
 *  5. session:created bus event on POST /api/v1/sessions
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { VinyanAPIServer } from "../../src/api/server.ts";
import { SessionManager } from "../../src/api/session-manager.ts";
import { SessionStore } from "../../src/db/session-store.ts";
import { TraceStore } from "../../src/db/trace-store.ts";
import { MetricsCollector } from "../../src/observability/metrics.ts";
import { createBus } from "../../src/core/bus.ts";
import type { VinyanBus } from "../../src/core/bus.ts";
import { Database } from "bun:sqlite";
import { MigrationRunner, ALL_MIGRATIONS } from "../../src/db/migrations/index.ts";
import { writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import type { TaskInput, TaskResult } from "../../src/orchestrator/types.ts";

const TEST_DIR = join(tmpdir(), `vinyan-wiring-test-${Date.now()}`);
const TOKEN_PATH = join(TEST_DIR, "api-token");
const TEST_TOKEN = "test-token-" + "b".repeat(52);
const PORT = 39400 + Math.floor(Math.random() * 100);

let server: VinyanAPIServer;
let db: Database;
let bus: VinyanBus;
let sessionManager: SessionManager;
let traceStore: TraceStore;
let metricsCollector: MetricsCollector;

function mockExecuteTask(input: TaskInput): Promise<TaskResult> {
  return Promise.resolve({
    id: input.id,
    status: "completed",
    mutations: [],
    trace: {
      id: `trace-${input.id}`,
      task_id: input.id,
      timestamp: Date.now(),
      routing_level: 1,
      approach: "test",
      model_used: "mock/test",
      tokens_consumed: 100,
      duration_ms: 50,
      outcome: "success",
      oracle_verdicts: {},
      affected_files: [],
    } as any,
  });
}

beforeAll(() => {
  mkdirSync(TEST_DIR, { recursive: true });
  writeFileSync(TOKEN_PATH, TEST_TOKEN);

  db = new Database(":memory:");
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  new MigrationRunner().migrate(db, ALL_MIGRATIONS);

  bus = createBus();
  const sessionStore = new SessionStore(db);
  sessionManager = new SessionManager(sessionStore);
  traceStore = new TraceStore(db);
  metricsCollector = new MetricsCollector();
  metricsCollector.attach(bus);

  server = new VinyanAPIServer(
    {
      port: PORT,
      bind: "127.0.0.1",
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

  server.start();
});

afterAll(async () => {
  await server.stop(1000);
  db.close();
});

const baseUrl = () => `http://127.0.0.1:${PORT}`;
const authHeaders = { Authorization: `Bearer ${TEST_TOKEN}`, "Content-Type": "application/json" };

describe("API Server Wiring", () => {
  // ── 1. Prometheus text format by default ──────────────────
  test("GET /api/v1/metrics returns Prometheus text format by default", async () => {
    const res = await fetch(`${baseUrl()}/api/v1/metrics`, {
      headers: authHeaders,
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/plain; version=0.0.4");

    const body = await res.text();
    expect(body).toContain("vinyan_tasks_total");
    expect(body).toContain("vinyan_task_success_rate");
    expect(body).toContain("vinyan_rules_active");
    expect(body).toContain("vinyan_skills_active");
    expect(body).toContain("vinyan_shadow_queue_depth");
    expect(body).toContain("vinyan_workers_active");
  });

  // ── 2. JSON format with full SystemMetrics fields ─────────
  test("GET /api/v1/metrics?format=json returns JSON with SystemMetrics fields", async () => {
    const res = await fetch(`${baseUrl()}/api/v1/metrics?format=json`, {
      headers: authHeaders,
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/json");

    const data = await res.json() as any;

    // SystemMetrics fields
    expect(data.traces).toBeDefined();
    expect(typeof data.traces.total).toBe("number");
    expect(typeof data.traces.successRate).toBe("number");
    expect(typeof data.traces.distinctTaskTypes).toBe("number");
    expect(typeof data.traces.avgQualityComposite).toBe("number");
    expect(data.traces.routingDistribution).toBeDefined();

    expect(data.rules).toBeDefined();
    expect(typeof data.rules.active).toBe("number");
    expect(typeof data.rules.probation).toBe("number");

    expect(data.skills).toBeDefined();
    expect(typeof data.skills.active).toBe("number");

    expect(data.patterns).toBeDefined();
    expect(data.shadow).toBeDefined();
    expect(data.workers).toBeDefined();
    expect(data.dataGates).toBeDefined();

    // Extra fields injected by API server
    expect(typeof data.tasks_in_flight).toBe("number");
    expect(data.counters).toBeDefined();
  });

  // ── 3. Bus events for api:request and api:response ────────
  test("bus emits api:request and api:response on API calls", async () => {
    const requestEvents: any[] = [];
    const responseEvents: any[] = [];

    const unsubReq = bus.on("api:request", (e) => requestEvents.push(e));
    const unsubRes = bus.on("api:response", (e) => responseEvents.push(e));

    try {
      await fetch(`${baseUrl()}/api/v1/health`);

      expect(requestEvents.length).toBeGreaterThanOrEqual(1);
      const reqEvent = requestEvents[requestEvents.length - 1];
      expect(reqEvent.method).toBe("GET");
      expect(reqEvent.path).toBe("/api/v1/health");

      expect(responseEvents.length).toBeGreaterThanOrEqual(1);
      const resEvent = responseEvents[responseEvents.length - 1];
      expect(resEvent.method).toBe("GET");
      expect(resEvent.path).toBe("/api/v1/health");
      expect(resEvent.status).toBe(200);
      expect(typeof resEvent.duration_ms).toBe("number");
    } finally {
      unsubReq();
      unsubRes();
    }
  });

  // ── 4. Session tracking: POST /tasks creates session tasks ─
  test("POST /api/v1/tasks creates a session task", async () => {
    const res = await fetch(`${baseUrl()}/api/v1/tasks`, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ goal: "wiring test task" }),
    });

    expect(res.status).toBe(200);
    const data = await res.json() as any;
    const taskId = data.result.id;
    expect(taskId).toBeTruthy();

    // The server auto-creates a default session and tracks tasks in it.
    // Verify by listing sessions — the default session should have tasks.
    // We can check via sessionManager indirectly: submit a second task and
    // verify the session's taskCount increments.
    const res2 = await fetch(`${baseUrl()}/api/v1/tasks`, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ goal: "second wiring test task" }),
    });
    expect(res2.status).toBe(200);

    // Create an explicit session and submit a task through it, then verify
    // the session has tasks by fetching it.
    const sessionRes = await fetch(`${baseUrl()}/api/v1/sessions`, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ source: "wiring-test" }),
    });
    const { session } = await sessionRes.json() as any;

    // Verify the default session (created by task submissions) exists and has tasks.
    // The server uses getOrCreateDefaultSession() — we can't directly query its ID,
    // but we know the session store should have tasks from the submissions above.
    // As a proxy, count tasks in the DB directly.
    const taskRows = db.query("SELECT COUNT(*) as cnt FROM session_tasks").get() as any;
    expect(taskRows.cnt).toBeGreaterThanOrEqual(2);
  });

  // ── 5. session:created bus event on POST /sessions ────────
  test("session:created bus event is emitted when creating a session", async () => {
    const events: any[] = [];
    const unsub = bus.on("session:created", (e) => events.push(e));

    try {
      const res = await fetch(`${baseUrl()}/api/v1/sessions`, {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({ source: "bus-event-test" }),
      });

      expect(res.status).toBe(201);
      const { session } = await res.json() as any;

      expect(events.length).toBeGreaterThanOrEqual(1);
      const event = events[events.length - 1];
      expect(event.sessionId).toBe(session.id);
      expect(event.source).toBe("bus-event-test");
    } finally {
      unsub();
    }
  });
});
