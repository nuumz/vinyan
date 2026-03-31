import { describe, test, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { createBus } from "../../src/core/bus.ts";
import { SleepCycleRunner } from "../../src/sleep-cycle/sleep-cycle.ts";
import { TraceStore } from "../../src/db/trace-store.ts";
import { PatternStore } from "../../src/db/pattern-store.ts";
import { TRACE_SCHEMA_SQL } from "../../src/db/trace-schema.ts";
import { PATTERN_SCHEMA_SQL } from "../../src/db/pattern-schema.ts";
import type { ExecutionTrace } from "../../src/orchestrator/types.ts";

function createStores() {
  const db = new Database(":memory:");
  db.exec(TRACE_SCHEMA_SQL);
  db.exec(PATTERN_SCHEMA_SQL);
  return {
    traceStore: new TraceStore(db),
    patternStore: new PatternStore(db),
  };
}

function makeTrace(overrides?: Partial<ExecutionTrace>): ExecutionTrace {
  return {
    id: `t-${Math.random().toString(36).slice(2)}`,
    taskId: "task-1",
    timestamp: Date.now(),
    routingLevel: 1,
    task_type_signature: "refactor::auth.ts",
    approach: "direct-edit",
    oracleVerdicts: { type: true },
    model_used: "mock",
    tokens_consumed: 100,
    duration_ms: 500,
    outcome: "success",
    affected_files: ["auth.ts"],
    ...overrides,
  };
}

describe("Sleep Cycle Trigger (H1)", () => {
  test("getInterval returns configured interval_sessions", () => {
    const { traceStore, patternStore } = createStores();
    const runner = new SleepCycleRunner({
      traceStore,
      patternStore,
      config: { interval_sessions: 15 },
    });
    expect(runner.getInterval()).toBe(15);
  });

  test("getInterval returns default (20) when not configured", () => {
    const { traceStore, patternStore } = createStores();
    const runner = new SleepCycleRunner({ traceStore, patternStore });
    expect(runner.getInterval()).toBe(20);
  });

  test("run() returns rulesPromoted field", async () => {
    const { traceStore, patternStore } = createStores();
    const runner = new SleepCycleRunner({ traceStore, patternStore });

    const result = await runner.run();
    expect(typeof result.rulesPromoted).toBe("number");
    expect(result.rulesPromoted).toBe(0);
  });

  test("sleep:cycleComplete event includes rulesPromoted", async () => {
    const { traceStore, patternStore } = createStores();
    const bus = createBus();
    let emitted: any = null;
    bus.on("sleep:cycleComplete", (payload) => { emitted = payload; });

    // Insert enough data to pass the data gate
    for (let i = 0; i < 110; i++) {
      traceStore.insert(makeTrace({
        id: `t-${i}`,
        task_type_signature: `type-${i % 6}::file.ts`,
      }));
    }

    const runner = new SleepCycleRunner({
      traceStore,
      patternStore,
      bus,
      config: { min_traces_for_analysis: 50 },
    });

    await runner.run();
    expect(emitted).not.toBeNull();
    expect(typeof emitted.rulesPromoted).toBe("number");
  });
});
