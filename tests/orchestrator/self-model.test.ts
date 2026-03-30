import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { CalibratedSelfModel } from "../../src/orchestrator/self-model.ts";
import { TRACE_SCHEMA_SQL, MODEL_PARAMS_SCHEMA_SQL } from "../../src/db/trace-schema.ts";
import type { TaskInput, PerceptualHierarchy, ExecutionTrace } from "../../src/orchestrator/types.ts";

function makeInput(overrides: Partial<TaskInput> = {}): TaskInput {
  return {
    id: "task-001",
    source: "cli",
    goal: "add JSDoc to function",
    targetFiles: ["src/foo.ts"],
    budget: { maxTokens: 10000, maxRetries: 3, maxDurationMs: 60000 },
    ...overrides,
  };
}

function makePerception(overrides: Partial<PerceptualHierarchy> = {}): PerceptualHierarchy {
  return {
    taskTarget: { file: "src/foo.ts", description: "add JSDoc" },
    dependencyCone: {
      directImporters: [],
      directImportees: ["src/bar.ts"],
      transitiveBlastRadius: 3,
    },
    diagnostics: {
      lintWarnings: [],
      typeErrors: [],
      failingTests: [],
    },
    verifiedFacts: [],
    runtime: { nodeVersion: "18.0.0", os: "darwin", availableTools: [] },
    ...overrides,
  };
}

function makeTrace(overrides: Partial<ExecutionTrace> = {}): ExecutionTrace {
  return {
    id: "trace-001",
    taskId: "task-001",
    timestamp: Date.now(),
    routingLevel: 2,
    approach: "direct-edit",
    oracleVerdicts: { ast: true, type: true },
    model_used: "claude-sonnet",
    tokens_consumed: 1000,
    duration_ms: 5000,
    outcome: "success",
    affected_files: ["src/foo.ts", "src/bar.ts"],
    ...overrides,
  };
}

describe("CalibratedSelfModel", () => {
  test("predict returns valid prediction without DB", async () => {
    const model = new CalibratedSelfModel();
    const pred = await model.predict(makeInput(), makePerception());

    expect(pred.taskId).toBe("task-001");
    expect(pred.expectedBlastRadius).toBe(3);
    expect(pred.expectedTestResults).toBe("pass");
    expect(pred.expectedQualityScore).toBe(0.5); // cold start default
    expect(pred.confidence).toBe(0.5);
    expect(pred.basis).toBe("static-heuristic");
    expect(pred.calibrationDataPoints).toBe(0);
  });

  test("S2: metaConfidence < 0.3 when < 10 task-type observations", async () => {
    const model = new CalibratedSelfModel();
    const pred = await model.predict(makeInput(), makePerception());

    expect(pred.metaConfidence).toBeLessThan(0.3);
  });

  test("type errors in perception → expectedTestResults = partial", async () => {
    const model = new CalibratedSelfModel();
    const perception = makePerception({
      diagnostics: {
        lintWarnings: [],
        typeErrors: [{ file: "src/foo.ts", line: 10, message: "Type error" }],
        failingTests: [],
      },
    });
    const pred = await model.predict(makeInput(), perception);

    expect(pred.expectedTestResults).toBe("partial");
    expect(pred.uncertainAreas).toContain("type-errors-present");
  });

  test("expectedDuration scales with file count", async () => {
    const model = new CalibratedSelfModel();
    const input1 = makeInput({ targetFiles: ["a.ts"] });
    const input3 = makeInput({ targetFiles: ["a.ts", "b.ts", "c.ts"] });

    const pred1 = await model.predict(input1, makePerception());
    const pred3 = await model.predict(input3, makePerception());

    expect(pred3.expectedDuration).toBeGreaterThan(pred1.expectedDuration);
  });

  test("calibrate updates observation count and accuracy", () => {
    const model = new CalibratedSelfModel();
    const pred = {
      taskId: "task-001",
      timestamp: Date.now(),
      expectedTestResults: "pass" as const,
      expectedBlastRadius: 2,
      expectedDuration: 4000,
      expectedQualityScore: 0.5,
      uncertainAreas: [],
      confidence: 0.5,
      metaConfidence: 0.1,
      basis: "static-heuristic" as const,
      calibrationDataPoints: 0,
    };

    const trace = makeTrace({
      qualityScore: {
        architecturalCompliance: 0.9,
        efficiency: 0.8,
        composite: 0.85,
        dimensions_available: 2,
        phase: "phase0",
      },
    });

    const error = model.calibrate(pred, trace);
    expect(error.taskId).toBe("task-001");
    expect(error.error.testResultMatch).toBe(true);
    expect(error.actual.qualityScore).toBe(0.85);

    const params = model.getParams();
    expect(params.observationCount).toBe(1);
  });

  test("EMA calibration shifts avgQualityScore toward actuals", () => {
    const model = new CalibratedSelfModel();

    for (let i = 0; i < 20; i++) {
      const pred = {
        taskId: `task-${i}`,
        timestamp: Date.now(),
        expectedTestResults: "pass" as const,
        expectedBlastRadius: 2,
        expectedDuration: 4000,
        expectedQualityScore: 0.5,
        uncertainAreas: [],
        confidence: 0.5,
        metaConfidence: 0.1,
        basis: "static-heuristic" as const,
        calibrationDataPoints: i,
      };

      model.calibrate(pred, makeTrace({
        id: `trace-${i}`,
        task_type_signature: "refactor",
        qualityScore: {
          architecturalCompliance: 0.9,
          efficiency: 0.9,
          composite: 0.9,
          dimensions_available: 2,
          phase: "phase0",
        },
      }));
    }

    const params = model.getParams();
    // After 20 observations of 0.9 quality, EMA should have moved from 0.5 toward 0.9
    expect(params.avgQualityScore).toBeGreaterThan(0.75);
    expect(params.observationCount).toBe(20);
  });

  test("basis switches to trace-calibrated after 10 observations", async () => {
    const model = new CalibratedSelfModel();

    for (let i = 0; i < 10; i++) {
      model.calibrate(
        {
          taskId: `task-${i}`, timestamp: Date.now(),
          expectedTestResults: "pass", expectedBlastRadius: 2,
          expectedDuration: 4000, expectedQualityScore: 0.5,
          uncertainAreas: [], confidence: 0.5, metaConfidence: 0.1,
          basis: "static-heuristic", calibrationDataPoints: i,
        },
        makeTrace({ id: `trace-${i}`, task_type_signature: "refactor" }),
      );
    }

    const pred = await model.predict(makeInput(), makePerception());
    expect(pred.basis).toBe("trace-calibrated");
    expect(pred.calibrationDataPoints).toBe(10);
  });

  describe("with SQLite persistence", () => {
    let db: Database;

    beforeEach(() => {
      db = new Database(":memory:");
      db.exec("PRAGMA journal_mode = WAL");
      db.exec(MODEL_PARAMS_SCHEMA_SQL);
    });

    afterEach(() => {
      db.close();
    });

    test("params persist across instances", () => {
      const model1 = new CalibratedSelfModel({ db });
      model1.calibrate(
        {
          taskId: "t1", timestamp: Date.now(),
          expectedTestResults: "pass", expectedBlastRadius: 2,
          expectedDuration: 4000, expectedQualityScore: 0.5,
          uncertainAreas: [], confidence: 0.5, metaConfidence: 0.1,
          basis: "static-heuristic", calibrationDataPoints: 0,
        },
        makeTrace({ qualityScore: {
          architecturalCompliance: 0.9, efficiency: 0.9,
          composite: 0.9, dimensions_available: 2, phase: "phase0",
        }}),
      );

      expect(model1.getParams().observationCount).toBe(1);

      // New instance loads from same DB
      const model2 = new CalibratedSelfModel({ db });
      expect(model2.getParams().observationCount).toBe(1);
      expect(model2.getParams().avgQualityScore).toBeGreaterThan(0.5);
    });
  });
});
