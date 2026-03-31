import { describe, test, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { WorkerStore } from "../../src/db/worker-store.ts";
import { WORKER_SCHEMA_SQL } from "../../src/db/worker-schema.ts";
import { TRACE_SCHEMA_SQL } from "../../src/db/trace-schema.ts";
import { WorkerLifecycle } from "../../src/orchestrator/worker-lifecycle.ts";
import { createBus, type VinyanBus } from "../../src/core/bus.ts";
import type { WorkerProfile } from "../../src/orchestrator/types.ts";

function createDb(): Database {
  const db = new Database(":memory:");
  db.exec(WORKER_SCHEMA_SQL);
  db.exec(TRACE_SCHEMA_SQL);
  return db;
}

function makeProfile(id: string, status: WorkerProfile["status"] = "probation"): WorkerProfile {
  return {
    id,
    config: { modelId: `model-${id}`, temperature: 0.7, systemPromptTemplate: "default" },
    status,
    createdAt: Date.now(),
    demotionCount: 0,
  };
}

function insertTraces(
  db: Database,
  workerId: string,
  count: number,
  opts?: { successRate?: number; avgQuality?: number; taskTypeSig?: string },
) {
  const successRate = opts?.successRate ?? 1.0;
  const avgQuality = opts?.avgQuality ?? 0.8;
  const taskTypeSig = opts?.taskTypeSig ?? "refactor::.ts";

  for (let i = 0; i < count; i++) {
    const isSuccess = i / count < successRate;
    const quality = isSuccess ? avgQuality : avgQuality * 0.5;
    db.run(
      `INSERT INTO execution_traces (
        id, task_id, timestamp, routing_level, approach, model_used,
        tokens_consumed, duration_ms, outcome, oracle_verdicts, affected_files,
        worker_id, quality_composite, task_type_signature
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        `trace-${workerId}-${i}-${Math.random().toString(36).slice(2, 6)}`,
        `task-${workerId}-${i}`,
        Date.now() - (count - i) * 1000, // stagger timestamps
        1, "test approach", `model-${workerId}`,
        1000, 5000,
        isSuccess ? "success" : "failure",
        "{}", "[]",
        workerId, quality,
        taskTypeSig,
      ],
    );
  }
}

describe("WorkerLifecycle", () => {
  let db: Database;
  let store: WorkerStore;
  let bus: VinyanBus;
  let lifecycle: WorkerLifecycle;

  beforeEach(() => {
    db = createDb();
    store = new WorkerStore(db);
    bus = createBus();
    lifecycle = new WorkerLifecycle({
      workerStore: store,
      bus,
      probationMinTasks: 30,
      demotionWindowTasks: 30,
      demotionMaxReentries: 3,
      reentryCooldownSessions: 50,
    });
  });

  describe("evaluatePromotion", () => {
    test("rejects worker not on probation", () => {
      store.insert(makeProfile("w1", "active"));
      const result = lifecycle.evaluatePromotion("w1");
      expect(result.promoted).toBe(false);
      expect(result.reason).toContain("not on probation");
    });

    test("rejects unknown worker", () => {
      const result = lifecycle.evaluatePromotion("nonexistent");
      expect(result.promoted).toBe(false);
    });

    test("rejects worker with insufficient tasks", () => {
      store.insert(makeProfile("w1", "probation"));
      insertTraces(db, "w1", 15, { successRate: 1.0, avgQuality: 0.9 });
      store.invalidateCache("w1");
      const result = lifecycle.evaluatePromotion("w1");
      expect(result.promoted).toBe(false);
      expect(result.reason).toContain("insufficient tasks");
    });

    test("promotes worker with good stats when no active workers exist (baseline=0)", () => {
      store.insert(makeProfile("w1", "probation"));
      insertTraces(db, "w1", 35, { successRate: 0.9, avgQuality: 0.8 });
      store.invalidateCache("w1");
      const result = lifecycle.evaluatePromotion("w1");
      expect(result.promoted).toBe(true);
      expect(result.reason).toContain("all promotion gates passed");

      const profile = store.findById("w1")!;
      expect(profile.status).toBe("active");
      expect(profile.promotedAt).toBeDefined();
    });

    test("promotes worker beating active worker median", () => {
      // Set up an existing active worker with moderate stats
      store.insert(makeProfile("w-active", "active"));
      insertTraces(db, "w-active", 50, { successRate: 0.7, avgQuality: 0.6 });

      // Probation worker with better stats
      store.insert(makeProfile("w1", "probation"));
      insertTraces(db, "w1", 35, { successRate: 0.95, avgQuality: 0.85 });
      store.invalidateCache();

      const result = lifecycle.evaluatePromotion("w1");
      expect(result.promoted).toBe(true);
    });

    test("rejects worker with success rate below active median", () => {
      // Active worker with high success
      store.insert(makeProfile("w-active", "active"));
      insertTraces(db, "w-active", 50, { successRate: 0.95, avgQuality: 0.9 });

      // Probation worker with low success
      store.insert(makeProfile("w1", "probation"));
      insertTraces(db, "w1", 35, { successRate: 0.5, avgQuality: 0.5 });
      store.invalidateCache();

      const result = lifecycle.evaluatePromotion("w1");
      expect(result.promoted).toBe(false);
      expect(result.reason).toContain("Wilson LB");
    });

    test("emits worker:promoted event", () => {
      const events: unknown[] = [];
      bus.on("worker:promoted", (e) => events.push(e));

      store.insert(makeProfile("w1", "probation"));
      insertTraces(db, "w1", 35, { successRate: 0.9, avgQuality: 0.8 });
      store.invalidateCache("w1");
      lifecycle.evaluatePromotion("w1");

      expect(events).toHaveLength(1);
      expect((events[0] as any).workerId).toBe("w1");
    });
  });

  describe("checkDemotions", () => {
    test("does not demote the last active worker (I8)", () => {
      store.insert(makeProfile("w1", "active"));
      insertTraces(db, "w1", 30, { successRate: 0.1, avgQuality: 0.1 });
      store.invalidateCache();

      const results = lifecycle.checkDemotions();
      expect(results).toHaveLength(0);
      expect(store.findById("w1")!.status).toBe("active");
    });

    test("demotes worker with low success rate", () => {
      store.insert(makeProfile("w1", "active"));
      store.insert(makeProfile("w2", "active"));
      insertTraces(db, "w1", 50, { successRate: 0.95, avgQuality: 0.9 });
      insertTraces(db, "w2", 50, { successRate: 0.3, avgQuality: 0.3 });
      store.invalidateCache();

      const results = lifecycle.checkDemotions();
      expect(results.some(r => r.demoted)).toBe(true);
      expect(store.findById("w2")!.status).toBe("demoted");
      expect(store.findById("w1")!.status).toBe("active");
    });

    test("permanent retirement after 3 demotions", () => {
      const profile = makeProfile("w1", "active");
      profile.demotionCount = 2; // already demoted twice
      store.insert(profile);
      store.insert(makeProfile("w2", "active"));
      insertTraces(db, "w1", 50, { successRate: 0.2, avgQuality: 0.2 });
      insertTraces(db, "w2", 50, { successRate: 0.95, avgQuality: 0.9 });
      store.invalidateCache();

      const results = lifecycle.checkDemotions();
      const w1Result = results.find(r => r.demoted);
      expect(w1Result).toBeDefined();
      expect(w1Result!.permanent).toBe(true);
      expect(store.findById("w1")!.status).toBe("retired");
    });

    test("emits worker:demoted event", () => {
      const events: unknown[] = [];
      bus.on("worker:demoted", (e) => events.push(e));

      store.insert(makeProfile("w1", "active"));
      store.insert(makeProfile("w2", "active"));
      insertTraces(db, "w1", 50, { successRate: 0.95, avgQuality: 0.9 });
      insertTraces(db, "w2", 50, { successRate: 0.2, avgQuality: 0.2 });
      store.invalidateCache();

      lifecycle.checkDemotions();
      expect(events.length).toBeGreaterThan(0);
      expect((events[0] as any).workerId).toBe("w2");
    });

    test("skips workers with insufficient data", () => {
      store.insert(makeProfile("w1", "active"));
      store.insert(makeProfile("w2", "active"));
      insertTraces(db, "w1", 50, { successRate: 0.95, avgQuality: 0.9 });
      insertTraces(db, "w2", 10, { successRate: 0.1, avgQuality: 0.1 }); // only 10, below window
      store.invalidateCache();

      const results = lifecycle.checkDemotions();
      expect(results).toHaveLength(0);
      expect(store.findById("w2")!.status).toBe("active");
    });
  });

  describe("reEnrollExpired", () => {
    test("re-enrolls demoted worker after cooldown (trace-count based)", () => {
      store.insert(makeProfile("w1", "active"));
      store.updateStatus("w1", "demoted", "quality drop");

      // Set demotedAt in the past
      const demotedAt = Date.now() - 60 * 60_000;
      db.run(`UPDATE worker_profiles SET demoted_at = ? WHERE id = ?`, [demotedAt, "w1"]);

      // Insert 50+ traces since demotion to satisfy cooldown (reentryCooldownSessions=50)
      for (let i = 0; i < 55; i++) {
        db.run(
          `INSERT INTO execution_traces (id, task_id, timestamp, routing_level, approach, model_used, tokens_consumed, duration_ms, outcome, oracle_verdicts, affected_files, worker_id)
           VALUES (?, ?, ?, 1, 'test', 'model', 1000, 5000, 'success', '{}', '[]', ?)`,
          [`trace-cooldown-${i}`, `task-cooldown-${i}`, demotedAt + (i + 1) * 1000, "w1"],
        );
      }

      const reEnrolled = lifecycle.reEnrollExpired(100);
      expect(reEnrolled).toContain("w1");
      expect(store.findById("w1")!.status).toBe("probation");
    });

    test("does not re-enroll if cooldown not met", () => {
      store.insert(makeProfile("w1", "active"));
      store.updateStatus("w1", "demoted", "quality drop");
      // demotedAt is very recent and no traces since — cooldown not met

      const reEnrolled = lifecycle.reEnrollExpired(1);
      expect(reEnrolled).toHaveLength(0);
      expect(store.findById("w1")!.status).toBe("demoted");
    });

    test("retires worker at max re-entries instead of re-enrolling", () => {
      const profile = makeProfile("w1", "active");
      profile.demotionCount = 3; // already at max
      store.insert(profile);
      store.updateStatus("w1", "demoted", "quality drop");

      const demotedAt = Date.now() - 60 * 60_000;
      db.run(`UPDATE worker_profiles SET demoted_at = ? WHERE id = ?`, [demotedAt, "w1"]);

      // Insert traces to satisfy cooldown
      for (let i = 0; i < 55; i++) {
        db.run(
          `INSERT INTO execution_traces (id, task_id, timestamp, routing_level, approach, model_used, tokens_consumed, duration_ms, outcome, oracle_verdicts, affected_files, worker_id)
           VALUES (?, ?, ?, 1, 'test', 'model', 1000, 5000, 'success', '{}', '[]', ?)`,
          [`trace-retire-${i}`, `task-retire-${i}`, demotedAt + (i + 1) * 1000, "w1"],
        );
      }

      const reEnrolled = lifecycle.reEnrollExpired(100);
      expect(reEnrolled).toHaveLength(0);
      // Should have been retired
      expect(store.findById("w1")!.status).toBe("retired");
    });

    test("emits worker:reactivated event", () => {
      const events: unknown[] = [];
      bus.on("worker:reactivated", (e) => events.push(e));

      store.insert(makeProfile("w1", "active"));
      store.updateStatus("w1", "demoted", "test");

      const demotedAt = Date.now() - 60 * 60_000;
      db.run(`UPDATE worker_profiles SET demoted_at = ? WHERE id = ?`, [demotedAt, "w1"]);

      // Insert traces to satisfy cooldown
      for (let i = 0; i < 55; i++) {
        db.run(
          `INSERT INTO execution_traces (id, task_id, timestamp, routing_level, approach, model_used, tokens_consumed, duration_ms, outcome, oracle_verdicts, affected_files, worker_id)
           VALUES (?, ?, ?, 1, 'test', 'model', 1000, 5000, 'success', '{}', '[]', ?)`,
          [`trace-event-${i}`, `task-event-${i}`, demotedAt + (i + 1) * 1000, "w1"],
        );
      }

      lifecycle.reEnrollExpired(100);
      expect(events).toHaveLength(1);
      expect((events[0] as any).workerId).toBe("w1");
    });
  });

  describe("emergencyReactivation", () => {
    test("does nothing when active workers exist", () => {
      store.insert(makeProfile("w1", "active"));
      expect(lifecycle.emergencyReactivation()).toBeNull();
    });

    test("reactivates best demoted worker when no active workers", () => {
      store.insert(makeProfile("w1", "probation")); // not active
      store.insert(makeProfile("w2", "active"));
      store.updateStatus("w2", "demoted", "test");
      insertTraces(db, "w2", 10, { avgQuality: 0.8 });
      store.invalidateCache();

      const result = lifecycle.emergencyReactivation();
      expect(result).toBe("w2");
      expect(store.findById("w2")!.status).toBe("active");
    });

    test("emits fleet:emergency_reactivation event", () => {
      const events: unknown[] = [];
      bus.on("fleet:emergency_reactivation", (e) => events.push(e));

      store.insert(makeProfile("w1", "active"));
      store.updateStatus("w1", "demoted", "test");

      lifecycle.emergencyReactivation();
      expect(events).toHaveLength(1);
    });
  });

  describe("isOnProbation", () => {
    test("returns true for probation worker", () => {
      store.insert(makeProfile("w1", "probation"));
      expect(lifecycle.isOnProbation("w1")).toBe(true);
    });

    test("returns false for active worker", () => {
      store.insert(makeProfile("w1", "active"));
      expect(lifecycle.isOnProbation("w1")).toBe(false);
    });

    test("returns false for unknown worker", () => {
      expect(lifecycle.isOnProbation("nonexistent")).toBe(false);
    });
  });

  describe("shouldShadowForProbation", () => {
    test("returns boolean (probabilistic, ~20% rate)", () => {
      let trueCount = 0;
      for (let i = 0; i < 1000; i++) {
        if (lifecycle.shouldShadowForProbation("task-1", "w1")) trueCount++;
      }
      // Should be roughly 20% (±5%)
      expect(trueCount / 1000).toBeGreaterThan(0.10);
      expect(trueCount / 1000).toBeLessThan(0.35);
    });
  });
});
