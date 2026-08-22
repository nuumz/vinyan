/**
 * Worker selection stays cost-discriminating with the economy layer on.
 *
 * `CostPredictor.predict` is keyed by task type, never by worker. The previous
 * economy branch fed the prediction's own `p95_usd` back in as the budget
 * ceiling, making `predicted/p95` a constant (1/3 cold-start, 1/2 calibrated)
 * that was byte-identical for every worker — the cost term dropped out of the
 * ranking entirely, and the naive fallback it replaced was the ONLY per-worker
 * signal. Turning economy on by default would have silently removed cost from
 * worker selection everywhere.
 *
 * Also pinned: `enforcement: 'warn'` must not squeeze selection scores. Warn
 * means warn.
 */
import { Database } from 'bun:sqlite';
import { beforeEach, describe, expect, test } from 'bun:test';
import { createBus } from '../../src/core/bus.ts';
import { migration001 } from '../../src/db/migrations/001_initial_schema.ts';
import { TRACE_SCHEMA_SQL } from '../../src/db/trace-schema.ts';
import { WORKER_SCHEMA_SQL } from '../../src/db/worker-schema.ts';
import { WorkerStore } from '../../src/db/worker-store.ts';
import { BudgetEnforcer } from '../../src/economy/budget-enforcer.ts';
import { CostLedger, type CostLedgerEntry } from '../../src/economy/cost-ledger.ts';
import { CostPredictor } from '../../src/economy/cost-predictor.ts';
import type { DataGateStats, DataGateThresholds } from '../../src/orchestrator/data-gate.ts';
import { CapabilityModel } from '../../src/orchestrator/fleet/capability-model.ts';
import { WorkerSelector } from '../../src/orchestrator/fleet/worker-selector.ts';
import { computeTaskSignature, taskSignatureFromFingerprint } from '../../src/orchestrator/prediction/self-model.ts';
import type { EngineProfile, TaskFingerprint, TaskInput } from '../../src/orchestrator/types.ts';

const FP: TaskFingerprint = { actionVerb: 'refactor', fileExtensions: ['.ts'], blastRadiusBucket: 'single' };
const BUDGET = { maxTokens: 10_000, timeoutMs: 60_000 };

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

function makeProfile(id: string): EngineProfile {
  return {
    id,
    config: { modelId: `model-${id}`, temperature: 0.7, systemPromptTemplate: 'default' },
    status: 'active',
    createdAt: Date.now(),
    demotionCount: 0,
  };
}

function insertTraces(db: Database, workerId: string, count: number, tokens: number): void {
  for (let i = 0; i < count; i++) {
    db.run(
      `INSERT INTO execution_traces (
        id, task_id, timestamp, routing_level, approach, model_used,
        tokens_consumed, duration_ms, outcome, oracle_verdicts, affected_files,
        worker_id, quality_composite, task_type_signature
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        `trace-${workerId}-${i}-${Math.random().toString(36).slice(2, 8)}`,
        `task-${workerId}-${i}`,
        Date.now(),
        1,
        'approach',
        `model-${workerId}`,
        tokens,
        5000,
        'success',
        '{}',
        '[]',
        workerId,
        0.8,
        'refactor::ts::single',
      ],
    );
  }
}

function seededLedger(): CostLedger {
  const db = new Database(':memory:');
  migration001.up(db);
  const ledger = new CostLedger(db);
  const entry: CostLedgerEntry = {
    id: 'seed:1:1',
    taskId: 'seed',
    workerId: null,
    engineId: 'claude-sonnet-4',
    timestamp: Date.now(),
    tokens_input: 10_000,
    tokens_output: 5_000,
    cache_read_tokens: 0,
    cache_creation_tokens: 0,
    duration_ms: 1000,
    oracle_invocations: 0,
    computed_usd: 500.0,
    cost_tier: 'billing',
    routing_level: 2,
    task_type_signature: 'refactor::ts::single',
  };
  ledger.record(entry);
  return ledger;
}

describe('signature agreement between producers', () => {
  test('a fingerprint and its task produce the same signature string', () => {
    const input = {
      id: 't1',
      source: 'cli',
      goal: 'refactor the parser',
      taskType: 'code',
      targetFiles: ['src/parser.ts'],
      budget: { maxTokens: 1, maxDurationMs: 1, maxRetries: 0 },
    } as unknown as TaskInput;

    const fromInput = computeTaskSignature(input);
    const fromFingerprint = taskSignatureFromFingerprint({
      actionVerb: 'refactor',
      fileExtensions: ['.ts'],
      blastRadiusBucket: 'single',
    });

    expect(fromFingerprint).toBe(fromInput);
    // Double colon — a single-colon variant keys a bucket nobody writes to.
    expect(fromInput).toBe('refactor::ts::single');
  });
});

describe('WorkerSelector cost term with the economy layer on', () => {
  let db: Database;
  let store: WorkerStore;
  let capModel: CapabilityModel;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(WORKER_SCHEMA_SQL);
    db.exec(TRACE_SCHEMA_SQL);
    store = new WorkerStore(db);
    capModel = new CapabilityModel({ db, minTraces: 5, negativeCapabilityThreshold: 0.6 });
  });

  function build(costPredictor?: CostPredictor, budgetEnforcer?: BudgetEnforcer): WorkerSelector {
    return new WorkerSelector({
      workerStore: store,
      capabilityModel: capModel,
      bus: createBus(),
      epsilonWorker: 0,
      diversityCapPct: 1.0,
      gateStats: () => GATE_MET,
      gateThresholds: THRESHOLDS,
      costPredictor,
      budgetEnforcer,
    });
  }

  /** Cheap and expensive workers, identical in every other respect. */
  function seedTwoWorkers(): void {
    store.insert(makeProfile('cheap'));
    store.insert(makeProfile('pricey'));
    insertTraces(db, 'cheap', 10, 500);
    insertTraces(db, 'pricey', 10, 9_000);
  }

  test('the cheaper worker still wins when a cost predictor is wired', () => {
    seedTwoWorkers();
    const ledger = seededLedger();
    const selected = build(new CostPredictor(ledger)).selectWorker(FP, 1, BUDGET);

    expect(selected.selectedWorkerId).toBe('cheap');
    // And the two candidates are genuinely scored apart, not tied.
    const cheapScore = selected.score;
    const alt = selected.alternatives.find((a) => a.workerId === 'pricey');
    expect(alt).toBeDefined();
    expect(cheapScore).toBeGreaterThan(alt!.score);
  });

  test('scores match the no-economy path when the only budget is warn-mode', () => {
    seedTwoWorkers();
    const ledger = seededLedger();

    const withoutEconomy = build().selectWorker(FP, 1, BUDGET);
    const warnEnforcer = new BudgetEnforcer({ enforcement: 'warn', hourly_usd: 1.0 }, ledger);
    // The seeded ledger blows a $1 hourly cap many times over.
    expect(warnEnforcer.checkBudget()[0]!.exceeded).toBe(true);
    const withWarnBudget = build(new CostPredictor(ledger), warnEnforcer).selectWorker(FP, 1, BUDGET);

    // A warn-mode cap must not apply back-pressure to selection. Compare the
    // SCORES, not just the ordering: budget pressure is a uniform multiplier,
    // so an ordering-only assertion cannot see it.
    const noBudgetEnforcer = build(new CostPredictor(ledger)).selectWorker(FP, 1, BUDGET);
    expect(withWarnBudget.selectedWorkerId).toBe(withoutEconomy.selectedWorkerId);
    expect(withWarnBudget.score).toBeCloseTo(noBudgetEnforcer.score, 10);
    expect(withWarnBudget.alternatives.map((a) => a.workerId)).toEqual(
      noBudgetEnforcer.alternatives.map((a) => a.workerId),
    );
  });
});
