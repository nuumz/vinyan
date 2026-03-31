import { describe, test, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { ShadowStore } from "../../src/db/shadow-store.ts";
import { SHADOW_SCHEMA_SQL } from "../../src/db/shadow-schema.ts";

let db: Database;
let store: ShadowStore;

beforeEach(() => {
  db = new Database(":memory:");
  db.exec(SHADOW_SCHEMA_SQL);
  store = new ShadowStore(db);
});

function makeJob(overrides?: Record<string, unknown>) {
  return {
    id: `shadow-task1-${Date.now()}`,
    taskId: "task-1",
    status: "pending" as const,
    enqueuedAt: Date.now(),
    retryCount: 0,
    maxRetries: 1,
    mutations: [{ file: "src/foo.ts", content: "export const x = 1;" }],
    ...overrides,
  };
}

describe("ShadowStore", () => {
  test("insert and query by task ID", () => {
    const job = makeJob();
    store.insert(job);

    const found = store.findByTaskId("task-1");
    expect(found).not.toBeNull();
    expect(found!.id).toBe(job.id);
    expect(found!.taskId).toBe("task-1");
    expect(found!.status).toBe("pending");
    expect(found!.mutations).toEqual([{ file: "src/foo.ts", content: "export const x = 1;" }]);
  });

  test("findPending returns pending and running jobs", () => {
    store.insert(makeJob({ id: "s1", status: "pending" }));
    store.insert(makeJob({ id: "s2", status: "running" }));
    store.insert(makeJob({ id: "s3", status: "done" }));

    const pending = store.findPending();
    expect(pending).toHaveLength(2);
    expect(pending.map(j => j.id).sort()).toEqual(["s1", "s2"]);
  });

  test("updateStatus to running sets started_at", () => {
    const job = makeJob({ id: "s-run" });
    store.insert(job);
    store.updateStatus("s-run", "running");

    const found = store.findByTaskId("task-1");
    expect(found!.status).toBe("running");
    expect(found!.startedAt).toBeDefined();
  });

  test("updateStatus to done sets completed_at and result", () => {
    const job = makeJob({ id: "s-done" });
    store.insert(job);

    const result = {
      taskId: "task-1",
      testsPassed: true,
      testResults: { total: 10, passed: 10, failed: 0, skipped: 0 },
      duration_ms: 500,
      timestamp: Date.now(),
    };
    store.updateStatus("s-done", "done", result);

    const found = store.findByTaskId("task-1");
    expect(found!.status).toBe("done");
    expect(found!.completedAt).toBeDefined();
    expect(found!.result!.testsPassed).toBe(true);
    expect(found!.result!.testResults!.passed).toBe(10);
  });

  test("incrementRetry increases retry_count", () => {
    store.insert(makeJob({ id: "s-retry" }));
    store.incrementRetry("s-retry");

    const found = store.findByTaskId("task-1");
    expect(found!.retryCount).toBe(1);
  });

  test("countByStatus returns correct counts", () => {
    store.insert(makeJob({ id: "s1", status: "pending" }));
    store.insert(makeJob({ id: "s2", status: "pending", taskId: "task-2" }));
    store.insert(makeJob({ id: "s3", status: "done", taskId: "task-3" }));

    expect(store.countByStatus("pending")).toBe(2);
    expect(store.countByStatus("done")).toBe(1);
    expect(store.countByStatus("failed")).toBe(0);
    expect(store.count()).toBe(3);
  });

  test("findByStatus filters correctly", () => {
    store.insert(makeJob({ id: "s1", status: "pending" }));
    store.insert(makeJob({ id: "s2", status: "done", taskId: "task-2" }));

    const pending = store.findByStatus("pending");
    expect(pending).toHaveLength(1);
    expect(pending[0]!.id).toBe("s1");
  });
});
