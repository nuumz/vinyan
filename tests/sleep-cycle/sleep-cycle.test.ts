import { describe, test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { SleepCycleRunner } from "../../src/sleep-cycle/sleep-cycle.ts";
import { TraceStore } from "../../src/db/trace-store.ts";
import { PatternStore } from "../../src/db/pattern-store.ts";
import { TRACE_SCHEMA_SQL } from "../../src/db/trace-schema.ts";
import { PATTERN_SCHEMA_SQL } from "../../src/db/pattern-schema.ts";
import type { ExecutionTrace } from "../../src/orchestrator/types.ts";
import type { QualityScore } from "../../src/core/types.ts";

function createStores(): { traceStore: TraceStore; patternStore: PatternStore } {
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

function makeQS(composite: number): QualityScore {
  return {
    architecturalCompliance: composite,
    efficiency: composite,
    composite,
    dimensions_available: 2,
    phase: "phase0",
  };
}

/** Insert N traces with given outcome and approach */
function insertTraces(
  store: TraceStore,
  count: number,
  overrides: Partial<ExecutionTrace>,
): void {
  for (let i = 0; i < count; i++) {
    store.insert(makeTrace({
      id: `t-${Math.random().toString(36).slice(2, 8)}`,
      session_id: `s-${i % 5}`, // 5 distinct sessions
      ...overrides,
    }));
  }
}

describe("SleepCycleRunner", () => {
  test("returns empty when data gate not satisfied", async () => {
    const { traceStore, patternStore } = createStores();
    // Only 10 traces (need 100)
    insertTraces(traceStore, 10, {});

    const runner = new SleepCycleRunner({
      traceStore, patternStore,
      config: { min_traces_for_analysis: 100 },
    });

    const result = await runner.run();
    expect(result.patterns).toHaveLength(0);
    expect(result.tracesAnalyzed).toBe(0);
  });

  test("detects anti-pattern: approach fails ≥80% of the time", async () => {
    const { traceStore, patternStore } = createStores();

    // Insert 80 failures + 20 successes for "bad-approach"
    insertTraces(traceStore, 80, {
      approach: "bad-approach",
      outcome: "failure",
      task_type_signature: "refactor::auth.ts",
    });
    insertTraces(traceStore, 20, {
      approach: "bad-approach",
      outcome: "success",
      task_type_signature: "refactor::auth.ts",
    });
    // Need distinct task types ≥ 5
    for (let i = 1; i <= 5; i++) {
      insertTraces(traceStore, 1, {
        approach: "other",
        task_type_signature: `type-${i}::file.ts`,
      });
    }

    const runner = new SleepCycleRunner({
      traceStore, patternStore,
      config: { min_traces_for_analysis: 50, pattern_min_frequency: 5 },
    });

    const result = await runner.run();
    const antiPatterns = result.patterns.filter(p => p.type === "anti-pattern");
    expect(antiPatterns.length).toBeGreaterThanOrEqual(1);
    expect(antiPatterns[0]!.approach).toBe("bad-approach");
    expect(antiPatterns[0]!.confidence).toBeGreaterThanOrEqual(0.6);
  });

  test("does NOT detect anti-pattern when fail rate < 80%", async () => {
    const { traceStore, patternStore } = createStores();

    // 60% failure rate — below threshold
    insertTraces(traceStore, 60, { approach: "mediocre", outcome: "failure" });
    insertTraces(traceStore, 40, { approach: "mediocre", outcome: "success" });
    for (let i = 1; i <= 5; i++) {
      insertTraces(traceStore, 1, { task_type_signature: `t${i}::f.ts` });
    }

    const runner = new SleepCycleRunner({
      traceStore, patternStore,
      config: { min_traces_for_analysis: 50, pattern_min_frequency: 5 },
    });

    const result = await runner.run();
    const antiPatterns = result.patterns.filter(p => p.type === "anti-pattern");
    expect(antiPatterns).toHaveLength(0);
  });

  test("detects success pattern: approach A outperforms B by ≥25%", async () => {
    const { traceStore, patternStore } = createStores();

    // Approach A: high quality (0.9)
    insertTraces(traceStore, 50, {
      approach: "good-approach",
      outcome: "success",
      qualityScore: makeQS(0.9),
      task_type_signature: "fix::db.ts",
    });
    // Approach B: low quality (0.4)
    insertTraces(traceStore, 50, {
      approach: "bad-approach",
      outcome: "success",
      qualityScore: makeQS(0.4),
      task_type_signature: "fix::db.ts",
    });
    // Distinct task types
    for (let i = 1; i <= 5; i++) {
      insertTraces(traceStore, 1, { task_type_signature: `t${i}::f.ts` });
    }

    const runner = new SleepCycleRunner({
      traceStore, patternStore,
      config: { min_traces_for_analysis: 50, pattern_min_frequency: 5 },
    });

    const result = await runner.run();
    const successPatterns = result.patterns.filter(p => p.type === "success-pattern");
    expect(successPatterns.length).toBeGreaterThanOrEqual(1);
    expect(successPatterns[0]!.approach).toBe("good-approach");
    expect(successPatterns[0]!.qualityDelta).toBeGreaterThanOrEqual(0.25);
  });

  test("minimum frequency filter rejects small samples", async () => {
    const { traceStore, patternStore } = createStores();

    // Only 3 traces for "rare-bad" (below min frequency of 5)
    insertTraces(traceStore, 3, { approach: "rare-bad", outcome: "failure" });
    // Pad to reach min_traces threshold
    insertTraces(traceStore, 100, { approach: "normal", outcome: "success" });
    for (let i = 1; i <= 5; i++) {
      insertTraces(traceStore, 1, { task_type_signature: `t${i}::f.ts` });
    }

    const runner = new SleepCycleRunner({
      traceStore, patternStore,
      config: { min_traces_for_analysis: 50, pattern_min_frequency: 5 },
    });

    const result = await runner.run();
    // "rare-bad" has only 3 samples — should be filtered out
    const rarePatterns = result.patterns.filter(p => p.approach === "rare-bad");
    expect(rarePatterns).toHaveLength(0);
  });

  test("records cycle run in pattern store", async () => {
    const { traceStore, patternStore } = createStores();

    insertTraces(traceStore, 100, {});
    for (let i = 1; i <= 5; i++) {
      insertTraces(traceStore, 1, { task_type_signature: `t${i}::f.ts` });
    }

    const runner = new SleepCycleRunner({
      traceStore, patternStore,
      config: { min_traces_for_analysis: 50 },
    });

    expect(patternStore.countCycleRuns()).toBe(0);
    await runner.run();
    expect(patternStore.countCycleRuns()).toBe(1);
  });

  test("result includes correct counts", async () => {
    const { traceStore, patternStore } = createStores();

    insertTraces(traceStore, 100, { approach: "test", outcome: "success" });
    for (let i = 1; i <= 5; i++) {
      insertTraces(traceStore, 1, { task_type_signature: `t${i}::f.ts` });
    }

    const runner = new SleepCycleRunner({
      traceStore, patternStore,
      config: { min_traces_for_analysis: 50 },
    });

    const result = await runner.run();
    expect(result.cycleId).toContain("cycle-");
    expect(result.tracesAnalyzed).toBeGreaterThanOrEqual(100);
    expect(typeof result.antiPatterns).toBe("number");
    expect(typeof result.successPatterns).toBe("number");
  });
});
