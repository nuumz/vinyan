import { describe, test, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { WorkerStore } from "../../src/db/worker-store.ts";
import { WORKER_SCHEMA_SQL } from "../../src/db/worker-schema.ts";
import { TRACE_SCHEMA_SQL } from "../../src/db/trace-schema.ts";
import { CapabilityModel } from "../../src/orchestrator/capability-model.ts";
import { giniCoefficient, evaluateFleet, type FleetMetrics } from "../../src/orchestrator/fleet-evaluator.ts";
import type { WorkerProfile } from "../../src/orchestrator/types.ts";

function createDb(): Database {
  const db = new Database(":memory:");
  db.exec(WORKER_SCHEMA_SQL);
  db.exec(TRACE_SCHEMA_SQL);
  return db;
}

function makeProfile(id: string, status: WorkerProfile["status"] = "active"): WorkerProfile {
  return {
    id,
    config: { modelId: `model-${id}`, temperature: 0.7, systemPromptTemplate: "default" },
    status,
    createdAt: Date.now(),
    demotionCount: 0,
  };
}

function insertTraces(db: Database, workerId: string, count: number, opts: {
  taskTypeSig: string;
  successRate?: number;
  quality?: number;
  tokens?: number;
}) {
  const successRate = opts.successRate ?? 1.0;
  for (let i = 0; i < count; i++) {
    const isSuccess = i / count < successRate;
    db.run(
      `INSERT INTO execution_traces (
        id, task_id, timestamp, routing_level, approach, model_used,
        tokens_consumed, duration_ms, outcome, oracle_verdicts, affected_files,
        worker_id, quality_composite, task_type_signature
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        `trace-${workerId}-${i}-${Math.random().toString(36).slice(2, 8)}`,
        `task-${i}`, Date.now(), 1, "approach", `model-${workerId}`,
        opts.tokens ?? 1000, 5000,
        isSuccess ? "success" : "failure",
        "{}", "[]",
        workerId, isSuccess ? (opts.quality ?? 0.8) : 0.3,
        opts.taskTypeSig,
      ],
    );
  }
}

describe("giniCoefficient", () => {
  test("returns 0 for empty array", () => {
    expect(giniCoefficient([])).toBe(0);
  });

  test("returns 0 for single value", () => {
    expect(giniCoefficient([5])).toBe(0);
  });

  test("returns 0 for equal distribution", () => {
    expect(giniCoefficient([10, 10, 10, 10])).toBe(0);
  });

  test("returns 0 for all zeros", () => {
    expect(giniCoefficient([0, 0, 0])).toBe(0);
  });

  test("returns high value for extreme inequality", () => {
    // One worker does all the work
    const gini = giniCoefficient([0, 0, 0, 100]);
    expect(gini).toBeGreaterThan(0.6);
  });

  test("returns moderate value for moderate inequality", () => {
    const gini = giniCoefficient([10, 20, 30, 40]);
    expect(gini).toBeGreaterThan(0);
    expect(gini).toBeLessThan(0.5);
  });

  test("is order-independent", () => {
    const g1 = giniCoefficient([5, 10, 20, 50]);
    const g2 = giniCoefficient([50, 5, 20, 10]);
    expect(Math.abs(g1 - g2)).toBeLessThan(0.001);
  });
});

describe("evaluateFleet", () => {
  let db: Database;
  let store: WorkerStore;
  let capModel: CapabilityModel;

  beforeEach(() => {
    db = createDb();
    store = new WorkerStore(db);
    capModel = new CapabilityModel({ db, minTraces: 5, negativeCapabilityThreshold: 0.6 });
  });

  test("returns zero metrics for empty fleet", () => {
    const metrics = evaluateFleet(store);
    expect(metrics.activeWorkers).toBe(0);
    expect(metrics.probationWorkers).toBe(0);
    expect(metrics.demotedWorkers).toBe(0);
    expect(metrics.retiredWorkers).toBe(0);
    expect(metrics.diversityScore).toBe(0);
    expect(metrics.capabilityCoverage).toBe(0);
    expect(metrics.avgWorkerSpecialization).toBe(0);
    expect(Object.keys(metrics.workerUtilization)).toHaveLength(0);
  });

  test("counts workers by status", () => {
    store.insert(makeProfile("w1", "active"));
    store.insert(makeProfile("w2", "active"));
    store.insert(makeProfile("w3", "probation"));
    store.insert(makeProfile("w4", "demoted"));
    store.insert(makeProfile("w5", "retired"));

    const metrics = evaluateFleet(store);
    expect(metrics.activeWorkers).toBe(2);
    expect(metrics.probationWorkers).toBe(1);
    expect(metrics.demotedWorkers).toBe(1);
    expect(metrics.retiredWorkers).toBe(1);
  });

  test("computes worker utilization fractions", () => {
    store.insert(makeProfile("w1"));
    store.insert(makeProfile("w2"));

    // w1 gets 30 tasks, w2 gets 10 tasks → w1 = 0.75, w2 = 0.25
    insertTraces(db, "w1", 30, { taskTypeSig: "refactor::.ts::small" });
    insertTraces(db, "w2", 10, { taskTypeSig: "refactor::.ts::small" });
    store.invalidateCache();

    const metrics = evaluateFleet(store);
    expect(metrics.workerUtilization["w1"]).toBeCloseTo(0.75, 1);
    expect(metrics.workerUtilization["w2"]).toBeCloseTo(0.25, 1);
  });

  test("computes diversity score from active worker task distribution", () => {
    store.insert(makeProfile("w1"));
    store.insert(makeProfile("w2"));
    store.insert(makeProfile("w3"));

    // Unequal distribution → non-zero Gini
    insertTraces(db, "w1", 50, { taskTypeSig: "refactor::.ts::small" });
    insertTraces(db, "w2", 10, { taskTypeSig: "refactor::.ts::small" });
    insertTraces(db, "w3", 5, { taskTypeSig: "refactor::.ts::small" });
    store.invalidateCache();

    const metrics = evaluateFleet(store);
    expect(metrics.diversityScore).toBeGreaterThan(0);
    expect(metrics.diversityScore).toBeLessThan(1);
  });

  test("computes capability coverage with capability model", () => {
    store.insert(makeProfile("w1"));
    store.insert(makeProfile("w2"));

    // w1 good at refactor, w2 good at fix
    insertTraces(db, "w1", 10, { taskTypeSig: "refactor::.ts::small", successRate: 0.9, quality: 0.9 });
    insertTraces(db, "w2", 10, { taskTypeSig: "fix::.ts::small", successRate: 0.9, quality: 0.9 });
    store.invalidateCache();

    const metrics = evaluateFleet(store, capModel);
    expect(metrics.capabilityCoverage).toBeGreaterThan(0);
  });

  test("computes average specialization across workers", () => {
    store.insert(makeProfile("w1"));

    // Worker with varied task type performance → non-zero specialization
    insertTraces(db, "w1", 10, { taskTypeSig: "refactor::.ts::small", successRate: 0.9, quality: 0.9 });
    insertTraces(db, "w1", 10, { taskTypeSig: "fix::.ts::small", successRate: 0.5, quality: 0.4 });
    store.invalidateCache();

    const metrics = evaluateFleet(store, capModel);
    // avgWorkerSpecialization is variance of capability scores
    expect(metrics.avgWorkerSpecialization).toBeGreaterThanOrEqual(0);
  });
});
