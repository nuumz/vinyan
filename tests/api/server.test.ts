/**
 * API Server Tests — TDD §22.8 Acceptance Criteria
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { VinyanAPIServer } from "../../src/api/server.ts";
import { SessionManager } from "../../src/api/session-manager.ts";
import { SessionStore } from "../../src/db/session-store.ts";
import { createBus } from "../../src/core/bus.ts";
import { Database } from "bun:sqlite";
import { MigrationRunner, ALL_MIGRATIONS } from "../../src/db/migrations/index.ts";
import { writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import type { TaskInput, TaskResult } from "../../src/orchestrator/types.ts";

const TEST_DIR = join(tmpdir(), `vinyan-api-test-${Date.now()}`);
const TOKEN_PATH = join(TEST_DIR, "api-token");
const TEST_TOKEN = "test-token-" + "a".repeat(52);
const PORT = 39270 + Math.floor(Math.random() * 100);

let server: VinyanAPIServer;
let db: Database;

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

  const bus = createBus();
  const sessionStore = new SessionStore(db);
  const sessionManager = new SessionManager(sessionStore);

  server = new VinyanAPIServer(
    {
      port: PORT,
      bind: "127.0.0.1",
      tokenPath: TOKEN_PATH,
      authRequired: true,
      rateLimitEnabled: false, // disable for tests
    },
    {
      bus,
      executeTask: mockExecuteTask,
      sessionManager,
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

describe("API Server", () => {
  // ── Criterion 1: Sync task submission ───────────────────
  test("POST /api/v1/tasks returns TaskResult", async () => {
    const res = await fetch(`${baseUrl()}/api/v1/tasks`, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ goal: "test task" }),
    });

    expect(res.status).toBe(200);
    const data = await res.json() as any;
    expect(data.result.status).toBe("completed");
  });

  // ── Criterion 2: Async task submission ──────────────────
  test("POST /api/v1/tasks/async returns 202 with taskId", async () => {
    const res = await fetch(`${baseUrl()}/api/v1/tasks/async`, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ goal: "async test" }),
    });

    expect(res.status).toBe(202);
    const data = await res.json() as any;
    expect(data.taskId).toBeTruthy();
    expect(data.status).toBe("accepted");

    // Poll for completion
    await new Promise((r) => setTimeout(r, 100));
    const poll = await fetch(`${baseUrl()}/api/v1/tasks/${data.taskId}`, {
      headers: authHeaders,
    });
    const pollData = await poll.json() as any;
    expect(pollData.status).toBe("completed");
  });

  // ── Criterion 4: Session management ─────────────────────
  test("session create + get", async () => {
    const createRes = await fetch(`${baseUrl()}/api/v1/sessions`, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ source: "test" }),
    });

    expect(createRes.status).toBe(201);
    const { session } = await createRes.json() as any;
    expect(session.id).toBeTruthy();
    expect(session.source).toBe("test");

    const getRes = await fetch(`${baseUrl()}/api/v1/sessions/${session.id}`, {
      headers: authHeaders,
    });
    expect(getRes.status).toBe(200);
  });

  // ── Criterion 7: Auth enforcement (I15) ─────────────────
  test("POST /tasks without token returns 401", async () => {
    const res = await fetch(`${baseUrl()}/api/v1/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ goal: "no auth" }),
    });

    expect(res.status).toBe(401);
  });

  test("GET /health without token returns 200", async () => {
    const res = await fetch(`${baseUrl()}/api/v1/health`);
    expect(res.status).toBe(200);
    const data = await res.json() as any;
    expect(data.status).toBe("ok");
  });

  // ── Read-only endpoints ─────────────────────────────────
  test("GET /workers returns array", async () => {
    const res = await fetch(`${baseUrl()}/api/v1/workers`);
    expect(res.status).toBe(200);
    const data = await res.json() as any;
    expect(data.workers).toBeArray();
  });

  test("GET /rules returns array", async () => {
    const res = await fetch(`${baseUrl()}/api/v1/rules`);
    expect(res.status).toBe(200);
    const data = await res.json() as any;
    expect(data.rules).toBeArray();
  });

  // ── 404 for unknown routes ──────────────────────────────
  test("unknown route returns 404", async () => {
    const res = await fetch(`${baseUrl()}/api/v1/unknown`, {
      headers: authHeaders,
    });
    expect(res.status).toBe(404);
  });
});
