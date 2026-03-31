import { describe, test, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { TRACE_SCHEMA_SQL } from "../../src/db/trace-schema.ts";
import { CapabilityModel } from "../../src/orchestrator/capability-model.ts";
import type { TaskFingerprint } from "../../src/orchestrator/types.ts";

function createDb(): Database {
  const db = new Database(":memory:");
  db.exec(TRACE_SCHEMA_SQL);
  return db;
}

function insertTrace(db: Database, workerId: string, opts: {
  taskTypeSig: string;
  outcome: string;
  quality?: number;
}) {
  const id = `trace-${Math.random().toString(36).slice(2, 10)}`;
  db.run(
    `INSERT INTO execution_traces (
      id, task_id, timestamp, routing_level, approach, model_used,
      tokens_consumed, duration_ms, outcome, oracle_verdicts, affected_files,
      worker_id, quality_composite, task_type_signature
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id, `task-${id}`, Date.now(), 1, "approach", "model",
      1000, 5000, opts.outcome, "{}", "[]",
      workerId, opts.quality ?? 0.8, opts.taskTypeSig,
    ],
  );
}

const FP: TaskFingerprint = {
  actionVerb: "refactor",
  fileExtensions: [".ts"],
  blastRadiusBucket: "small",
};

describe("CapabilityModel", () => {
  let db: Database;
  let model: CapabilityModel;

  beforeEach(() => {
    db = createDb();
    model = new CapabilityModel({
      db,
      minTraces: 5,
      negativeCapabilityThreshold: 0.6,
    });
  });

  describe("getCapability", () => {
    test("returns null capability for cold-start (< minTraces)", () => {
      insertTrace(db, "w1", { taskTypeSig: "refactor::.ts::small", outcome: "success" });
      insertTrace(db, "w1", { taskTypeSig: "refactor::.ts::small", outcome: "success" });
      const score = model.getCapability("w1", FP);
      expect(score.capability).toBeNull();
      expect(score.total).toBe(2);
    });

    test("computes Wilson LB when sufficient traces", () => {
      for (let i = 0; i < 8; i++) {
        insertTrace(db, "w1", { taskTypeSig: "refactor::.ts::small", outcome: "success" });
      }
      insertTrace(db, "w1", { taskTypeSig: "refactor::.ts::small", outcome: "failure" });
      insertTrace(db, "w1", { taskTypeSig: "refactor::.ts::small", outcome: "failure" });

      const score = model.getCapability("w1", FP);
      expect(score.capability).not.toBeNull();
      expect(score.capability!).toBeGreaterThan(0);
      expect(score.capability!).toBeLessThan(1);
      expect(score.total).toBe(10);
      expect(score.successes).toBe(8);
    });

    test("returns 0 total for unknown worker", () => {
      const score = model.getCapability("nonexistent", FP);
      expect(score.total).toBe(0);
      expect(score.capability).toBeNull();
    });
  });

  describe("negative capability", () => {
    test("detects negative capability when failure rate is high", () => {
      // 18 failures out of 20 — Wilson LB well above 0.6
      for (let i = 0; i < 18; i++) {
        insertTrace(db, "w1", { taskTypeSig: "refactor::.ts::small", outcome: "failure" });
      }
      insertTrace(db, "w1", { taskTypeSig: "refactor::.ts::small", outcome: "success" });
      insertTrace(db, "w1", { taskTypeSig: "refactor::.ts::small", outcome: "success" });

      const score = model.getCapability("w1", FP);
      expect(score.negative).toBe(true);
    });

    test("no negative capability when success rate is decent", () => {
      for (let i = 0; i < 7; i++) {
        insertTrace(db, "w1", { taskTypeSig: "refactor::.ts::small", outcome: "success" });
      }
      for (let i = 0; i < 3; i++) {
        insertTrace(db, "w1", { taskTypeSig: "refactor::.ts::small", outcome: "failure" });
      }

      const score = model.getCapability("w1", FP);
      expect(score.negative).toBe(false);
    });

    test("no negative capability for cold-start", () => {
      insertTrace(db, "w1", { taskTypeSig: "refactor::.ts::small", outcome: "failure" });
      insertTrace(db, "w1", { taskTypeSig: "refactor::.ts::small", outcome: "failure" });
      const score = model.getCapability("w1", FP);
      expect(score.negative).toBe(false); // insufficient data
    });

    test("hasNegativeCapability returns true for exclusion", () => {
      for (let i = 0; i < 20; i++) {
        insertTrace(db, "w1", { taskTypeSig: "refactor::.ts::small", outcome: "failure" });
      }
      expect(model.hasNegativeCapability("w1", FP)).toBe(true);
    });
  });

  describe("getWorkerCapabilities", () => {
    test("returns capabilities across task types", () => {
      for (let i = 0; i < 10; i++) {
        insertTrace(db, "w1", { taskTypeSig: "refactor::.ts::small", outcome: "success" });
      }
      for (let i = 0; i < 10; i++) {
        insertTrace(db, "w1", { taskTypeSig: "fix::.ts::single", outcome: "failure" });
      }

      const caps = model.getWorkerCapabilities("w1");
      expect(caps).toHaveLength(2);

      const refactorCap = caps.find(c => c.fingerprint.includes("refactor"));
      const fixCap = caps.find(c => c.fingerprint.includes("fix"));
      expect(refactorCap!.capability).toBeGreaterThan(0.5);
      expect(fixCap!.negative).toBe(true);
    });

    test("returns empty array for unknown worker", () => {
      expect(model.getWorkerCapabilities("nonexistent")).toEqual([]);
    });
  });

  describe("getMaxCapabilityForFingerprint", () => {
    test("returns best worker for fingerprint", () => {
      for (let i = 0; i < 10; i++) {
        insertTrace(db, "w1", { taskTypeSig: "refactor::.ts::small", outcome: "success" });
      }
      for (let i = 0; i < 5; i++) {
        insertTrace(db, "w2", { taskTypeSig: "refactor::.ts::small", outcome: "success" });
      }
      for (let i = 0; i < 5; i++) {
        insertTrace(db, "w2", { taskTypeSig: "refactor::.ts::small", outcome: "failure" });
      }

      const result = model.getMaxCapabilityForFingerprint(["w1", "w2"], FP);
      expect(result.bestWorkerId).toBe("w1");
      expect(result.maxCapability).toBeGreaterThan(0);
    });

    test("returns 0 when all workers have cold-start", () => {
      insertTrace(db, "w1", { taskTypeSig: "refactor::.ts::small", outcome: "success" });
      const result = model.getMaxCapabilityForFingerprint(["w1"], FP);
      expect(result.maxCapability).toBe(0);
      expect(result.bestWorkerId).toBeNull();
    });
  });
});
