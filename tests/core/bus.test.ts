import { describe, test, expect, spyOn } from "bun:test";
import { EventBus, createBus, type VinyanBus } from "../../src/core/bus.ts";

describe("EventBus", () => {
  test("on/emit delivers payload synchronously", () => {
    const bus = createBus();
    let received: unknown = null;
    bus.on("task:start", (payload) => {
      received = payload;
    });
    const payload = {
      input: makeInput(),
      routing: { level: 0 as const, model: "test", budgetTokens: 100, latencyBudget_ms: 1000 },
    };
    bus.emit("task:start", payload);
    expect(received).toBe(payload);
  });

  test("unsubscribe prevents further delivery", () => {
    const bus = createBus();
    let count = 0;
    const unsub = bus.on("task:start", () => { count++; });
    bus.emit("task:start", { input: makeInput(), routing: makeRouting() });
    expect(count).toBe(1);
    unsub();
    bus.emit("task:start", { input: makeInput(), routing: makeRouting() });
    expect(count).toBe(1);
  });

  test("once fires exactly once", () => {
    const bus = createBus();
    let count = 0;
    bus.once("task:start", () => { count++; });
    bus.emit("task:start", { input: makeInput(), routing: makeRouting() });
    bus.emit("task:start", { input: makeInput(), routing: makeRouting() });
    expect(count).toBe(1);
  });

  test("FIFO ordering across multiple handlers", () => {
    const bus = createBus();
    const order: number[] = [];
    bus.on("task:start", () => order.push(1));
    bus.on("task:start", () => order.push(2));
    bus.on("task:start", () => order.push(3));
    bus.emit("task:start", { input: makeInput(), routing: makeRouting() });
    expect(order).toEqual([1, 2, 3]);
  });

  test("listenerCount tracks correctly after sub/unsub", () => {
    const bus = createBus();
    expect(bus.listenerCount("task:start")).toBe(0);
    const unsub1 = bus.on("task:start", () => {});
    const unsub2 = bus.on("task:start", () => {});
    expect(bus.listenerCount("task:start")).toBe(2);
    unsub1();
    expect(bus.listenerCount("task:start")).toBe(1);
    unsub2();
    expect(bus.listenerCount("task:start")).toBe(0);
  });

  test("emit with no listeners is a no-op", () => {
    const bus = createBus();
    // Should not throw
    bus.emit("task:start", { input: makeInput(), routing: makeRouting() });
  });

  test("removeAllListeners for specific event", () => {
    const bus = createBus();
    let startCount = 0;
    let completeCount = 0;
    bus.on("task:start", () => { startCount++; });
    bus.on("task:complete", () => { completeCount++; });
    bus.removeAllListeners("task:start");
    bus.emit("task:start", { input: makeInput(), routing: makeRouting() });
    bus.emit("task:complete", { result: makeResult() });
    expect(startCount).toBe(0);
    expect(completeCount).toBe(1);
  });

  test("removeAllListeners clears everything", () => {
    const bus = createBus();
    let count = 0;
    bus.on("task:start", () => { count++; });
    bus.on("task:complete", () => { count++; });
    bus.removeAllListeners();
    bus.emit("task:start", { input: makeInput(), routing: makeRouting() });
    bus.emit("task:complete", { result: makeResult() });
    expect(count).toBe(0);
  });

  test("maxListeners warning fires on excess", () => {
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    const bus = createBus({ maxListeners: 2 });
    bus.on("task:start", () => {});
    bus.on("task:start", () => {});
    // Third registration should warn
    bus.on("task:start", () => {});
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]![0]).toContain("task:start");
    warnSpy.mockRestore();
  });

  test("handler throwing does not break other handlers", () => {
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});
    const bus = createBus();
    const results: string[] = [];
    bus.on("task:start", () => { results.push("before"); });
    bus.on("task:start", () => { throw new Error("boom"); });
    bus.on("task:start", () => { results.push("after"); });
    bus.emit("task:start", { input: makeInput(), routing: makeRouting() });
    expect(results).toEqual(["before", "after"]);
    expect(errorSpy).toHaveBeenCalledTimes(1);
    errorSpy.mockRestore();
  });

  test("generic EventBus works with custom event map", () => {
    interface CustomEvents {
      ping: { ts: number };
      pong: { ts: number; echo: string };
    }
    const bus = new EventBus<CustomEvents>();
    let received: CustomEvents["pong"] | undefined;
    bus.on("pong", (p) => { received = p; });
    bus.emit("pong", { ts: 1, echo: "hello" });
    expect(received).toBeDefined();
    expect(received!.echo).toBe("hello");
  });

  test("createBus returns a typed VinyanBus", () => {
    const bus: VinyanBus = createBus();
    // Verify it accepts spec events without type errors
    let called = false;
    bus.on("oracle:verdict", () => { called = true; });
    bus.emit("oracle:verdict", {
      taskId: "t1",
      oracleName: "ast",
      verdict: {
        type: "known",
        confidence: 1.0,
        verified: true,
        evidence: [],
        fileHashes: {},
        duration_ms: 0,
      },
    });
    expect(called).toBe(true);
  });
});

// ── Helpers ──────────────────────────────────────────────────────────

function makeInput() {
  return {
    id: "test-1",
    source: "cli" as const,
    goal: "test task",
    budget: { maxTokens: 1000, maxDurationMs: 5000, maxRetries: 3 },
  };
}

function makeRouting() {
  return { level: 0 as const, model: "test", budgetTokens: 100, latencyBudget_ms: 1000 };
}

function makeResult() {
  return {
    id: "test-1",
    status: "completed" as const,
    mutations: [],
    trace: {
      id: "trace-1",
      taskId: "test-1",
      timestamp: Date.now(),
      routingLevel: 0 as const,
      approach: "test",
      oracleVerdicts: {},
      model_used: "test",
      tokens_consumed: 0,
      duration_ms: 0,
      outcome: "success" as const,
      affected_files: [],
    },
  };
}
