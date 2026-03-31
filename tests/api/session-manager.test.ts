/**
 * Session Manager Tests — lifecycle, compaction, I16 audit preservation
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { SessionManager } from "../../src/api/session-manager.ts";
import { SessionStore } from "../../src/db/session-store.ts";
import { Database } from "bun:sqlite";
import { MigrationRunner, ALL_MIGRATIONS } from "../../src/db/migrations/index.ts";
import type { TaskInput, TaskResult } from "../../src/orchestrator/types.ts";

let db: Database;
let sessionStore: SessionStore;
let manager: SessionManager;

beforeEach(() => {
  db = new Database(":memory:");
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  new MigrationRunner().migrate(db, ALL_MIGRATIONS);

  sessionStore = new SessionStore(db);
  manager = new SessionManager(sessionStore);
});

afterEach(() => {
  db.close();
});

function makeTaskInput(id: string): TaskInput {
  return {
    id,
    source: "api",
    goal: `Test task ${id}`,
    budget: { maxTokens: 1000, maxDurationMs: 5000, maxRetries: 1 },
  };
}

function makeTaskResult(id: string, status: "completed" | "failed"): TaskResult {
  return {
    id,
    status,
    mutations: [],
    trace: {
      id: `trace-${id}`,
      task_id: id,
      timestamp: Date.now(),
      routing_level: 1,
      task_type_signature: "test::ts",
      approach: "test-approach",
      model_used: "mock/test",
      tokens_consumed: 500,
      duration_ms: 200,
      outcome: status === "completed" ? "success" : "failure",
      oracle_verdicts: {},
      affected_files: [],
      failure_reason: status === "failed" ? "test failure" : undefined,
    } as any,
    escalationReason: status === "failed" ? "test failure" : undefined,
  };
}

describe("SessionManager", () => {
  test("create returns session with ID", () => {
    const session = manager.create("api");
    expect(session.id).toBeTruthy();
    expect(session.source).toBe("api");
    expect(session.status).toBe("active");
    expect(session.taskCount).toBe(0);
  });

  test("get returns session with task count", () => {
    const session = manager.create("cli");
    const input = makeTaskInput("task-1");
    manager.addTask(session.id, input);

    const retrieved = manager.get(session.id);
    expect(retrieved).toBeTruthy();
    expect(retrieved!.taskCount).toBe(1);
  });

  test("get returns undefined for nonexistent session", () => {
    expect(manager.get("nonexistent")).toBeUndefined();
  });

  test("addTask links task to session", () => {
    const session = manager.create("api");
    manager.addTask(session.id, makeTaskInput("t1"));
    manager.addTask(session.id, makeTaskInput("t2"));

    const tasks = sessionStore.listSessionTasks(session.id);
    expect(tasks.length).toBe(2);
    expect(tasks[0]!.status).toBe("pending");
  });

  test("completeTask updates status and result", () => {
    const session = manager.create("api");
    const input = makeTaskInput("t1");
    manager.addTask(session.id, input);
    manager.completeTask(session.id, "t1", makeTaskResult("t1", "completed"));

    const task = sessionStore.getTask(session.id, "t1");
    expect(task!.status).toBe("completed");
    expect(task!.result_json).toBeTruthy();
  });
});

describe("Session Compaction", () => {
  test("compact produces CompactionResult", () => {
    const session = manager.create("api");

    // Add and complete tasks
    for (let i = 0; i < 5; i++) {
      const id = `t${i}`;
      manager.addTask(session.id, makeTaskInput(id));
      manager.completeTask(session.id, id, makeTaskResult(id, i < 4 ? "completed" : "failed"));
    }

    const result = manager.compact(session.id);
    expect(result.sessionId).toBe(session.id);
    expect(result.statistics.totalTasks).toBe(5);
    expect(result.statistics.successRate).toBe(0.8);
    expect(result.keyFailures.length).toBeGreaterThan(0);
    expect(result.successfulPatterns.length).toBeGreaterThan(0);
    expect(result.compactedAt).toBeGreaterThan(0);
  });

  test("compaction is additive — does not delete task data (I16)", () => {
    const session = manager.create("api");
    manager.addTask(session.id, makeTaskInput("t1"));
    manager.completeTask(session.id, "t1", makeTaskResult("t1", "completed"));

    manager.compact(session.id);

    // Original task data still accessible
    const tasks = sessionStore.listSessionTasks(session.id);
    expect(tasks.length).toBe(1);
    expect(tasks[0]!.result_json).toBeTruthy();

    // Compaction stored separately
    const row = sessionStore.getSession(session.id);
    expect(row!.status).toBe("compacted");
    expect(row!.compaction_json).toBeTruthy();
  });
});

describe("Session Recovery", () => {
  test("suspendAll suspends active sessions", () => {
    manager.create("api");
    manager.create("api");

    const suspended = manager.suspendAll();
    expect(suspended).toBe(2);

    const active = sessionStore.listActiveSessions();
    expect(active.length).toBe(0);
  });

  test("recover returns suspended sessions", () => {
    const s1 = manager.create("api");
    manager.suspendAll();

    const recovered = manager.recover();
    expect(recovered.length).toBe(1);
    expect(recovered[0]!.id).toBe(s1.id);
    expect(recovered[0]!.status).toBe("suspended");
  });
});
