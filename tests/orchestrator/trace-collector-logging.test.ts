import { describe, test, expect, spyOn, beforeEach, afterEach } from "bun:test";
import { TraceCollectorImpl } from "../../src/orchestrator/trace-collector.ts";
import type { TraceStore } from "../../src/db/trace-store.ts";
import type { ExecutionTrace } from "../../src/orchestrator/types.ts";

function makeTrace(overrides: Partial<ExecutionTrace> = {}): ExecutionTrace {
  return {
    id: "trace-001",
    taskId: "task-001",
    timestamp: Date.now(),
    routingLevel: 1,
    approach: "direct-edit",
    oracleVerdicts: {},
    model_used: "claude-haiku",
    tokens_consumed: 100,
    duration_ms: 500,
    outcome: "success",
    affected_files: [],
    ...overrides,
  };
}

/** Minimal TraceStore stub — only insert is exercised by TraceCollectorImpl. */
function makeThrowingStore(error: Error): TraceStore {
  return { insert: () => { throw error; } } as unknown as TraceStore;
}

describe("TraceCollectorImpl error logging (WU5)", () => {
  let warnSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    warnSpy = spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  test("logs warning when TraceStore.insert throws", async () => {
    const insertError = new Error("DB locked");
    const collector = new TraceCollectorImpl(undefined, makeThrowingStore(insertError));

    await collector.record(makeTrace());

    expect(warnSpy).toHaveBeenCalledTimes(1);
    const [msg, err] = warnSpy.mock.calls[0]!;
    expect(msg).toBe("[vinyan] Trace INSERT failed:");
    expect(err).toBe(insertError);
  });

  test("record() does not throw even when store throws (best-effort)", async () => {
    const collector = new TraceCollectorImpl(undefined, makeThrowingStore(new Error("disk full")));
    await expect(collector.record(makeTrace())).resolves.toBeUndefined();
  });

  test("trace is still kept in memory even when SQLite insert fails", async () => {
    const collector = new TraceCollectorImpl(undefined, makeThrowingStore(new Error("write error")));
    const trace = makeTrace({ id: "trace-999" });

    await collector.record(trace);

    expect(collector.getTraceCount()).toBe(1);
    expect(collector.getLatestTrace()?.id).toBe("trace-999");
  });

  test("no warning when store is absent (no TraceStore injected)", async () => {
    const collector = new TraceCollectorImpl();
    await collector.record(makeTrace());
    expect(warnSpy).not.toHaveBeenCalled();
  });
});
