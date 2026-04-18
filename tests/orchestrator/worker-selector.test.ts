import { Database } from 'bun:sqlite';
import { beforeEach, describe, expect, test } from 'bun:test';
import { createBus } from '../../src/core/bus.ts';
import { TRACE_SCHEMA_SQL } from '../../src/db/trace-schema.ts';
import { WORKER_SCHEMA_SQL } from '../../src/db/worker-schema.ts';
import { WorkerStore } from '../../src/db/worker-store.ts';
import { CapabilityModel } from '../../src/orchestrator/fleet/capability-model.ts';
import type { DataGateStats, DataGateThresholds } from '../../src/orchestrator/data-gate.ts';
import type { TaskFingerprint, EngineProfile } from '../../src/orchestrator/types.ts';
import { WorkerSelector } from '../../src/orchestrator/fleet/worker-selector.ts';

function createDb(): Database {
  const db = new Database(':memory:');
  db.exec(WORKER_SCHEMA_SQL);
  db.exec(TRACE_SCHEMA_SQL);
  return db;
}

function makeProfile(id: string, status: EngineProfile['status'] = 'active'): EngineProfile {
  return {
    id,
    config: { modelId: `model-${id}`, temperature: 0.7, systemPromptTemplate: 'default' },
    status,
    createdAt: Date.now(),
    demotionCount: 0,
  };
}

function insertTraces(
  db: Database,
  workerId: string,
  count: number,
  opts: {
    taskTypeSig: string;
    successRate?: number;
    quality?: number;
    tokens?: number;
  },
) {
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
        `task-${i}`,
        Date.now(),
        1,
        'approach',
        `model-${workerId}`,
        opts.tokens ?? 1000,
        5000,
        isSuccess ? 'success' : 'failure',
        '{}',
        '[]',
        workerId,
        isSuccess ? (opts.quality ?? 0.8) : 0.3,
        opts.taskTypeSig,
      ],
    );
  }
}

const FP: TaskFingerprint = {
  actionVerb: 'refactor',
  fileExtensions: ['.ts'],
  blastRadiusBucket: 'small',
};

const BUDGET = { maxTokens: 10000, timeoutMs: 60000 };

const GATE_MET: DataGateStats = {
  traceCount: 200,
  distinctTaskTypes: 5,
  patternsExtracted: 10,
  activeSkills: 1,
  sleepCyclesRun: 5,
  activeWorkers: 3,
  workerTraceDiversity: 3,
  thinkingTraceCount: 50,
  thinkingDistinctTaskTypes: 3,
};

const GATE_NOT_MET: DataGateStats = {
  traceCount: 10,
  distinctTaskTypes: 1,
  patternsExtracted: 0,
  activeSkills: 0,
  sleepCyclesRun: 0,
  activeWorkers: 1,
  workerTraceDiversity: 1,
  thinkingTraceCount: 0,
  thinkingDistinctTaskTypes: 0,
};

const THRESHOLDS: DataGateThresholds = {
  sleep_cycle_min_traces: 100,
  sleep_cycle_min_task_types: 5,
  skill_min_patterns: 1,
  skill_min_sleep_cycles: 1,
  evolution_min_traces: 200,
  evolution_min_active_skills: 1,
  evolution_min_sleep_cycles: 3,
  fleet_min_active_workers: 2,
  fleet_min_worker_trace_diversity: 2,
  thinking_calibration_min_traces: 50,
  thinking_uncertainty_min_traces: 30,
  thinking_uncertainty_min_task_types: 3,
};

describe('WorkerSelector', () => {
  let db: Database;
  let store: WorkerStore;
  let capModel: CapabilityModel;
  let selector: WorkerSelector;

  beforeEach(() => {
    db = createDb();
    store = new WorkerStore(db);
    capModel = new CapabilityModel({ db, minTraces: 5, negativeCapabilityThreshold: 0.6 });
    selector = new WorkerSelector({
      workerStore: store,
      capabilityModel: capModel,
      bus: createBus(),
      epsilonWorker: 0, // disable exploration for deterministic tests
      diversityCapPct: 0.7,
      gateStats: () => GATE_MET,
      gateThresholds: THRESHOLDS,
    });
  });

  describe('tier fallback', () => {
    test('falls back when data gate not met', () => {
      store.insert(makeProfile('w1'));
      const fallbackSelector = new WorkerSelector({
        workerStore: store,
        capabilityModel: capModel,
        bus: createBus(),
        epsilonWorker: 0,
        diversityCapPct: 0.7,
        gateStats: () => GATE_NOT_MET,
        gateThresholds: THRESHOLDS,
      });

      const result = fallbackSelector.selectWorker(FP, 1, BUDGET);
      expect(result.reason).toBe('tier-fallback');
      expect(result.dataGateMet).toBe(false);
    });

    test('falls back when no active candidates', () => {
      // No workers registered
      const result = selector.selectWorker(FP, 1, BUDGET);
      expect(result.reason).toBe('tier-fallback');
    });
  });

  describe('capability-based scoring', () => {
    test('selects worker with better capability', () => {
      store.insert(makeProfile('w1'));
      store.insert(makeProfile('w2'));

      // w1 has high success rate on this fingerprint
      insertTraces(db, 'w1', 20, { taskTypeSig: 'refactor::.ts::small', successRate: 0.95, quality: 0.9 });
      // w2 has lower success rate
      insertTraces(db, 'w2', 20, { taskTypeSig: 'refactor::.ts::small', successRate: 0.5, quality: 0.5 });
      store.invalidateCache();

      const result = selector.selectWorker(FP, 1, BUDGET);
      expect(result.reason).toBe('capability-score');
      expect(result.selectedWorkerId).toBe('w1');
      expect(result.score).toBeGreaterThan(0);
      expect(result.dataGateMet).toBe(true);
    });

    test('excludes worker with negative capability', () => {
      store.insert(makeProfile('w1'));
      store.insert(makeProfile('w2'));

      // w1 has mostly failures (negative capability)
      insertTraces(db, 'w1', 20, { taskTypeSig: 'refactor::.ts::small', successRate: 0.05 });
      // w2 is moderate
      insertTraces(db, 'w2', 20, { taskTypeSig: 'refactor::.ts::small', successRate: 0.7, quality: 0.7 });
      store.invalidateCache();

      const result = selector.selectWorker(FP, 1, BUDGET);
      expect(result.selectedWorkerId).toBe('w2');
    });

    test('provides alternatives in audit trail', () => {
      store.insert(makeProfile('w1'));
      store.insert(makeProfile('w2'));
      store.insert(makeProfile('w3'));

      insertTraces(db, 'w1', 10, { taskTypeSig: 'refactor::.ts::small', successRate: 0.9, quality: 0.9 });
      insertTraces(db, 'w2', 10, { taskTypeSig: 'refactor::.ts::small', successRate: 0.7, quality: 0.7 });
      insertTraces(db, 'w3', 10, { taskTypeSig: 'refactor::.ts::small', successRate: 0.5, quality: 0.5 });
      store.invalidateCache();

      const result = selector.selectWorker(FP, 1, BUDGET);
      expect(result.alternatives.length).toBeGreaterThanOrEqual(1);
    });

    test('respects excludeWorkerIds', () => {
      store.insert(makeProfile('w1'));
      store.insert(makeProfile('w2'));

      insertTraces(db, 'w1', 10, { taskTypeSig: 'refactor::.ts::small', successRate: 0.95, quality: 0.9 });
      insertTraces(db, 'w2', 10, { taskTypeSig: 'refactor::.ts::small', successRate: 0.7, quality: 0.7 });
      store.invalidateCache();

      const result = selector.selectWorker(FP, 1, BUDGET, ['w1']);
      expect(result.selectedWorkerId).toBe('w2');
    });
  });

  describe('exploration', () => {
    test('epsilon-worker exploration selects non-default worker', () => {
      const exploringSelector = new WorkerSelector({
        workerStore: store,
        capabilityModel: capModel,
        bus: createBus(),
        epsilonWorker: 1.0, // always explore
        diversityCapPct: 0.7,
        gateStats: () => GATE_MET,
        gateThresholds: THRESHOLDS,
      });

      store.insert(makeProfile('w1'));
      store.insert(makeProfile('w2'));
      insertTraces(db, 'w1', 10, { taskTypeSig: 'refactor::.ts::small', successRate: 0.95, quality: 0.9 });
      insertTraces(db, 'w2', 10, { taskTypeSig: 'refactor::.ts::small', successRate: 0.5, quality: 0.5 });
      store.invalidateCache();

      const result = exploringSelector.selectWorker(FP, 1, BUDGET);
      expect(result.reason).toBe('exploration');
      expect(result.explorationTriggered).toBe(true);
      expect(result.selectedWorkerId).toBe('w2'); // not the default best (w1)
    });

    test('exploration never selects probation workers', () => {
      const exploringSelector = new WorkerSelector({
        workerStore: store,
        capabilityModel: capModel,
        bus: createBus(),
        epsilonWorker: 1.0,
        diversityCapPct: 0.7,
        gateStats: () => GATE_MET,
        gateThresholds: THRESHOLDS,
      });

      store.insert(makeProfile('w1', 'active'));
      store.insert(makeProfile('w2', 'probation')); // should be excluded
      insertTraces(db, 'w1', 10, { taskTypeSig: 'refactor::.ts::small' });
      store.invalidateCache();

      const result = exploringSelector.selectWorker(FP, 1, BUDGET);
      // With only 1 active candidate, no exploration possible
      expect(result.selectedWorkerId).toBe('w1');
    });
  });

  describe('scoring formula', () => {
    test('cost efficiency impacts score', () => {
      store.insert(makeProfile('w1'));
      store.insert(makeProfile('w2'));

      // Same success/quality but w1 uses fewer tokens
      insertTraces(db, 'w1', 10, { taskTypeSig: 'refactor::.ts::small', successRate: 0.8, quality: 0.8, tokens: 500 });
      insertTraces(db, 'w2', 10, { taskTypeSig: 'refactor::.ts::small', successRate: 0.8, quality: 0.8, tokens: 9000 });
      store.invalidateCache();

      const result = selector.selectWorker(FP, 1, BUDGET);
      // w1 should score higher due to cost efficiency
      expect(result.selectedWorkerId).toBe('w1');
    });

    test('score is 0 for negative capability worker', () => {
      store.insert(makeProfile('w1'));
      // 20 failures → negative capability
      insertTraces(db, 'w1', 20, { taskTypeSig: 'refactor::.ts::small', successRate: 0.05 });
      store.invalidateCache();

      // Even though w1 is the only candidate, its score should be 0
      // but it will still be selected as the only option
      const result = selector.selectWorker(FP, 1, BUDGET);
      // Score 0 but still selected as only candidate
      expect(result.score).toBe(0);
    });
  });

  describe('uncertainty detection (Gap #4)', () => {
    test('returns uncertain when all workers below capability threshold', () => {
      store.insert(makeProfile('w1'));
      store.insert(makeProfile('w2'));

      // Both workers have very low success rate → capability < 0.3
      insertTraces(db, 'w1', 20, { taskTypeSig: 'refactor::.ts::small', successRate: 0.15, quality: 0.2 });
      insertTraces(db, 'w2', 20, { taskTypeSig: 'refactor::.ts::small', successRate: 0.1, quality: 0.1 });
      store.invalidateCache();

      const result = selector.selectWorker(FP, 1, BUDGET);
      expect(result.isUncertain).toBe(true);
      expect(result.reason).toBe('uncertain');
      expect(result.selectedWorkerId).toBe('');
      expect(result.maxCapability).toBeDefined();
      expect(result.maxCapability!).toBeLessThan(0.3);
    });

    test('does not return uncertain when at least one worker has sufficient capability', () => {
      store.insert(makeProfile('w1'));
      store.insert(makeProfile('w2'));

      // w1 has good success rate → capability > 0.3
      insertTraces(db, 'w1', 20, { taskTypeSig: 'refactor::.ts::small', successRate: 0.9, quality: 0.8 });
      // w2 has low success rate
      insertTraces(db, 'w2', 20, { taskTypeSig: 'refactor::.ts::small', successRate: 0.1, quality: 0.1 });
      store.invalidateCache();

      const result = selector.selectWorker(FP, 1, BUDGET);
      expect(result.isUncertain).toBeFalsy();
      expect(result.selectedWorkerId).toBe('w1');
    });
  });

  describe('staleness penalty (Gap #5)', () => {
    test('stale worker gets lower score than active worker', () => {
      store.insert(makeProfile('w1'));
      store.insert(makeProfile('w2'));

      // w1: traces from 10 cycles ago (very stale) — same quality/success as w2
      const tenCyclesAgo = Date.now() - 10 * 600_000;
      for (let i = 0; i < 10; i++) {
        db.run(
          `INSERT INTO execution_traces (
            id, task_id, timestamp, routing_level, approach, model_used,
            tokens_consumed, duration_ms, outcome, oracle_verdicts, affected_files,
            worker_id, quality_composite, task_type_signature
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            `trace-w1-stale-${i}`,
            `task-${i}`,
            tenCyclesAgo,
            1,
            'approach',
            'model-w1',
            1000,
            5000,
            'success',
            '{}',
            '[]',
            'w1',
            0.8,
            'refactor::.ts::small',
          ],
        );
      }
      // w2: traces from just now (active) — same quality/success as w1
      insertTraces(db, 'w2', 10, { taskTypeSig: 'refactor::.ts::small', successRate: 1.0, quality: 0.8 });
      store.invalidateCache();

      const result = selector.selectWorker(FP, 1, BUDGET);
      // w2 should win: equal capability but w1 has 0.9^10 ≈ 0.35 staleness penalty
      expect(result.selectedWorkerId).toBe('w2');
    });
  });

  describe('weighted exploration (Gap #6)', () => {
    test('exploration exists and selects a non-default worker', () => {
      const exploringSelector = new WorkerSelector({
        workerStore: store,
        capabilityModel: capModel,
        bus: createBus(),
        epsilonWorker: 1.0, // always explore
        diversityCapPct: 0.7,
        gateStats: () => GATE_MET,
        gateThresholds: THRESHOLDS,
      });

      store.insert(makeProfile('w1'));
      store.insert(makeProfile('w2'));
      store.insert(makeProfile('w3'));
      insertTraces(db, 'w1', 10, { taskTypeSig: 'refactor::.ts::small', successRate: 0.9, quality: 0.9 });
      insertTraces(db, 'w2', 10, { taskTypeSig: 'refactor::.ts::small', successRate: 0.7, quality: 0.7 });
      insertTraces(db, 'w3', 10, { taskTypeSig: 'refactor::.ts::small', successRate: 0.5, quality: 0.5 });
      store.invalidateCache();

      const result = exploringSelector.selectWorker(FP, 1, BUDGET);
      expect(result.explorationTriggered).toBe(true);
      expect(result.selectedWorkerId).not.toBe('w1'); // not the default best
    });
  });

  describe('bus events', () => {
    test('emits worker:selected event', () => {
      const bus = createBus();
      const events: unknown[] = [];
      bus.on('worker:selected', (e) => events.push(e));

      const eventSelector = new WorkerSelector({
        workerStore: store,
        capabilityModel: capModel,
        bus,
        epsilonWorker: 0,
        diversityCapPct: 0.7,
        gateStats: () => GATE_MET,
        gateThresholds: THRESHOLDS,
      });

      store.insert(makeProfile('w1'));
      insertTraces(db, 'w1', 10, { taskTypeSig: 'refactor::.ts::small' });
      store.invalidateCache();

      eventSelector.selectWorker(FP, 1, BUDGET);
      expect(events).toHaveLength(1);
    });
  });
});
