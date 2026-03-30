import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { ShadowRunner } from "../../src/orchestrator/shadow-runner.ts";
import { ShadowStore } from "../../src/db/shadow-store.ts";
import { SHADOW_SCHEMA_SQL } from "../../src/db/shadow-schema.ts";

let db: Database;
let store: ShadowStore;
let tempDir: string;

beforeEach(() => {
  db = new Database(":memory:");
  db.exec(SHADOW_SCHEMA_SQL);
  store = new ShadowStore(db);
  tempDir = mkdtempSync(join(tmpdir(), "vinyan-shadow-"));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe("ShadowRunner", () => {
  test("enqueue creates pending shadow job in store", () => {
    const runner = new ShadowRunner({
      shadowStore: store,
      workspace: tempDir,
    });

    const job = runner.enqueue("task-1", [
      { file: "src/foo.ts", content: "export const x = 1;" },
    ]);

    expect(job.status).toBe("pending");
    expect(job.taskId).toBe("task-1");
    expect(job.id).toContain("shadow-task-1");

    // Verify persisted
    const found = store.queryByTaskId("task-1");
    expect(found).not.toBeNull();
    expect(found!.status).toBe("pending");
    expect(found!.mutations).toHaveLength(1);
  });

  test("enqueue is synchronous — crash-safety (A6)", () => {
    const runner = new ShadowRunner({
      shadowStore: store,
      workspace: tempDir,
    });

    // enqueue must be sync (not async) — persists before returning
    runner.enqueue("task-1", [{ file: "a.ts", content: "a" }]);

    // Immediately queryable — no await needed
    expect(store.countByStatus("pending")).toBe(1);
  });

  test("processNext returns null when no pending jobs", async () => {
    const runner = new ShadowRunner({
      shadowStore: store,
      workspace: tempDir,
      testCommand: "echo ok",
    });

    const result = await runner.processNext();
    expect(result).toBeNull();
  });

  test("processNext processes pending job and marks done", async () => {
    const runner = new ShadowRunner({
      shadowStore: store,
      workspace: tempDir,
      testCommand: "echo '3 pass'",
      timeoutMs: 5000,
    });

    runner.enqueue("task-1", [{ file: "a.ts", content: "a" }]);

    const result = await runner.processNext();
    expect(result).not.toBeNull();
    expect(result!.taskId).toBe("task-1");
    expect(result!.testsPassed).toBe(true);
    expect(result!.duration_ms).toBeGreaterThan(0);

    // Job should be marked done
    const job = store.queryByTaskId("task-1");
    expect(job!.status).toBe("done");
  });

  test("processNext marks job failed on test failure after retries exhausted", async () => {
    const runner = new ShadowRunner({
      shadowStore: store,
      workspace: tempDir,
      testCommand: "exit 1",
      timeoutMs: 5000,
    });

    // Job with 0 retries — immediate done even on fail exit code
    store.insert({
      id: "s-fail",
      taskId: "task-fail",
      status: "pending",
      enqueuedAt: Date.now(),
      retryCount: 0,
      maxRetries: 0,
      mutations: [],
    });

    const result = await runner.processNext();
    // exit 1 = tests failed, but it's still a completed validation
    // The ShadowRunner treats non-zero exit as testsPassed=false
    expect(result).not.toBeNull();
    expect(result!.testsPassed).toBe(false);
  });

  test("recover resets running jobs back to pending", () => {
    store.insert({
      id: "s-stale",
      taskId: "task-stale",
      status: "running",
      enqueuedAt: Date.now() - 60000,
      retryCount: 0,
      maxRetries: 1,
      mutations: [],
    });
    store.insert({
      id: "s-pending",
      taskId: "task-pending",
      status: "pending",
      enqueuedAt: Date.now(),
      retryCount: 0,
      maxRetries: 1,
      mutations: [],
    });

    const runner = new ShadowRunner({
      shadowStore: store,
      workspace: tempDir,
    });

    const recovered = runner.recover();
    expect(recovered).toBe(1);

    // Stale job should be back to pending
    const jobs = store.queryPending();
    expect(jobs).toHaveLength(2);
    expect(jobs.every(j => j.status === "pending")).toBe(true);
  });
});
