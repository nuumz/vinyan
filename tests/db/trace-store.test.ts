import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { TraceStore } from "../../src/db/trace-store.ts";
import { TRACE_SCHEMA_SQL } from "../../src/db/trace-schema.ts";
import type { ExecutionTrace } from "../../src/orchestrator/types.ts";
import type { QualityScore } from "../../src/core/types.ts";

function createTestDb(): Database {
  const db = new Database(":memory:");
  db.exec("PRAGMA journal_mode = WAL");
  db.exec(TRACE_SCHEMA_SQL);
  return db;
}

function makeTrace(overrides: Partial<ExecutionTrace> = {}): ExecutionTrace {
  return {
    id: "trace-001",
    taskId: "task-001",
    timestamp: Date.now(),
    routingLevel: 1,
    approach: "direct-edit",
    oracleVerdicts: { ast: true, type: true, dep: false },
    model_used: "claude-haiku",
    tokens_consumed: 500,
    duration_ms: 1200,
    outcome: "success",
    affected_files: ["src/foo.ts", "src/bar.ts"],
    ...overrides,
  };
}

const PHASE1_QUALITY: QualityScore = {
  architecturalCompliance: 0.85,
  efficiency: 0.72,
  simplificationGain: 0.60,
  testMutationScore: 0.45,
  composite: 0.66,
  dimensions_available: 4,
  phase: "phase1",
};

describe("TraceStore", () => {
  let db: Database;
  let store: TraceStore;

  beforeEach(() => {
    db = createTestDb();
    store = new TraceStore(db);
  });

  afterEach(() => {
    db.close();
  });

  test("insert and query roundtrip", () => {
    const trace = makeTrace();
    store.insert(trace);

    const results = store.findRecent(10);
    expect(results).toHaveLength(1);
    expect(results[0]!.id).toBe("trace-001");
    expect(results[0]!.taskId).toBe("task-001");
    expect(results[0]!.routingLevel).toBe(1);
    expect(results[0]!.approach).toBe("direct-edit");
    expect(results[0]!.model_used).toBe("claude-haiku");
    expect(results[0]!.tokens_consumed).toBe(500);
    expect(results[0]!.outcome).toBe("success");
  });

  test("JSON fields deserialized correctly", () => {
    const trace = makeTrace({
      oracleVerdicts: { ast: true, type: false },
      affected_files: ["src/a.ts", "src/b.ts", "src/c.ts"],
    });
    store.insert(trace);

    const result = store.findRecent(1)[0]!;
    expect(result.oracleVerdicts).toEqual({ ast: true, type: false });
    expect(result.affected_files).toEqual(["src/a.ts", "src/b.ts", "src/c.ts"]);
  });

  test("QualityScore denormalized into columns and reconstructed", () => {
    const trace = makeTrace({ qualityScore: PHASE1_QUALITY });
    store.insert(trace);

    const result = store.findRecent(1)[0]!;
    expect(result.qualityScore).toBeDefined();
    expect(result.qualityScore!.architecturalCompliance).toBe(0.85);
    expect(result.qualityScore!.efficiency).toBe(0.72);
    expect(result.qualityScore!.simplificationGain).toBe(0.60);
    expect(result.qualityScore!.testMutationScore).toBe(0.45);
    expect(result.qualityScore!.composite).toBe(0.66);
    expect(result.qualityScore!.dimensions_available).toBe(4);
    expect(result.qualityScore!.phase).toBe("phase1");
  });

  test("trace without QualityScore returns undefined", () => {
    store.insert(makeTrace());

    const result = store.findRecent(1)[0]!;
    expect(result.qualityScore).toBeUndefined();
  });

  test("phase0 QualityScore (2 dims) roundtrip", () => {
    const phase0: QualityScore = {
      architecturalCompliance: 0.9,
      efficiency: 0.8,
      composite: 0.86,
      dimensions_available: 2,
      phase: "phase0",
    };
    store.insert(makeTrace({ qualityScore: phase0 }));

    const result = store.findRecent(1)[0]!;
    expect(result.qualityScore!.phase).toBe("phase0");
    expect(result.qualityScore!.dimensions_available).toBe(2);
    expect(result.qualityScore!.simplificationGain).toBeUndefined();
  });

  test("findByTaskType filters correctly", () => {
    store.insert(makeTrace({ id: "t1", task_type_signature: "refactor:rename" }));
    store.insert(makeTrace({ id: "t2", task_type_signature: "bugfix:null-check" }));
    store.insert(makeTrace({ id: "t3", task_type_signature: "refactor:rename" }));

    const refactors = store.findByTaskType("refactor:rename");
    expect(refactors).toHaveLength(2);
    expect(refactors.every(t => t.task_type_signature === "refactor:rename")).toBe(true);
  });

  test("findByOutcome filters correctly", () => {
    store.insert(makeTrace({ id: "t1", outcome: "success" }));
    store.insert(makeTrace({ id: "t2", outcome: "failure", failure_reason: "type error" }));
    store.insert(makeTrace({ id: "t3", outcome: "timeout" }));

    const failures = store.findByOutcome("failure");
    expect(failures).toHaveLength(1);
    expect(failures[0]!.failure_reason).toBe("type error");
  });

  test("findByTimeRange filters correctly", () => {
    const now = Date.now();
    store.insert(makeTrace({ id: "t1", timestamp: now - 5000 }));
    store.insert(makeTrace({ id: "t2", timestamp: now - 1000 }));
    store.insert(makeTrace({ id: "t3", timestamp: now + 5000 }));

    const results = store.findByTimeRange(now - 6000, now);
    expect(results).toHaveLength(2);
    expect(results[0]!.id).toBe("t1"); // ASC order
    expect(results[1]!.id).toBe("t2");
  });

  test("count returns total traces", () => {
    expect(store.count()).toBe(0);
    store.insert(makeTrace({ id: "t1" }));
    store.insert(makeTrace({ id: "t2" }));
    expect(store.count()).toBe(2);
  });

  test("countDistinctTaskTypes counts unique signatures", () => {
    store.insert(makeTrace({ id: "t1", task_type_signature: "a" }));
    store.insert(makeTrace({ id: "t2", task_type_signature: "a" }));
    store.insert(makeTrace({ id: "t3", task_type_signature: "b" }));
    store.insert(makeTrace({ id: "t4" })); // no signature — not counted

    expect(store.countDistinctTaskTypes()).toBe(2);
  });

  test("predictionError JSON roundtrip", () => {
    const trace = makeTrace({
      predictionError: {
        taskId: "task-001",
        predicted: {
          taskId: "task-001", timestamp: Date.now(),
          expectedTestResults: "pass", expectedBlastRadius: 3,
          expectedDuration: 5000, expectedQualityScore: 0.7,
          uncertainAreas: [], confidence: 0.6, metaConfidence: 0.2,
          basis: "static-heuristic", calibrationDataPoints: 0,
        },
        actual: { testResults: "fail", blastRadius: 5, duration: 8000, qualityScore: 0.4 },
        error: { testResultMatch: false, blastRadiusDelta: 2, durationDelta: 3000, qualityScoreDelta: -0.3, composite: 0.45 },
      },
    });
    store.insert(trace);

    const result = store.findRecent(1)[0]!;
    expect(result.predictionError).toBeDefined();
    expect(result.predictionError!.error.composite).toBe(0.45);
    expect(result.predictionError!.actual.testResults).toBe("fail");
  });

  test("optional fields handled gracefully", () => {
    store.insert(makeTrace({
      session_id: "sess-1",
      worker_id: "w-1",
      approach_description: "detailed explanation",
      risk_score: 0.35,
      validation_depth: "structural",
    }));

    const result = store.findRecent(1)[0]!;
    expect(result.session_id).toBe("sess-1");
    expect(result.worker_id).toBe("w-1");
    expect(result.approach_description).toBe("detailed explanation");
    expect(result.risk_score).toBe(0.35);
    expect(result.validation_depth).toBe("structural");
  });
});
