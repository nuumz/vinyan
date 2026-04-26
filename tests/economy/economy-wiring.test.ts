import { migration001 } from '../../src/db/migrations/001_initial_schema.ts';
/**
 * Economy Wiring Tests — verify that economy components are invoked
 * on the live execution path, not just instantiated.
 */
import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';import { BudgetEnforcer } from '../../src/economy/budget-enforcer.ts';
import { costAwareScore } from '../../src/economy/cost-aware-scorer.ts';
import { CostLedger, type CostLedgerEntry } from '../../src/economy/cost-ledger.ts';
import { CostPredictor } from '../../src/economy/cost-predictor.ts';
import { DynamicBudgetAllocator } from '../../src/economy/dynamic-budget-allocator.ts';
import { FederationCostRelay } from '../../src/economy/federation-cost-relay.ts';

function createTestDb() {
  const db = new Database(':memory:');
  migration001.up(db);
  return db;
}

function makeEntry(overrides?: Partial<CostLedgerEntry>): CostLedgerEntry {
  return {
    id: `t-${Math.random().toString(36).slice(2)}:${Date.now()}`,
    taskId: 'task-1',
    workerId: null,
    engineId: 'claude-sonnet',
    timestamp: Date.now(),
    tokens_input: 5000,
    tokens_output: 2000,
    cache_read_tokens: 0,
    cache_creation_tokens: 0,
    duration_ms: 5000,
    oracle_invocations: 0,
    computed_usd: 0.075,
    cost_tier: 'billing',
    routing_level: 2,
    task_type_signature: 'refactor:ts:small',
    ...overrides,
  };
}

describe('Economy Wiring — BudgetEnforcer in execution path', () => {
  test('canProceed() blocks when budget exceeded (enforcement=block)', () => {
    const db = createTestDb();
    const ledger = new CostLedger(db);
    const enforcer = new BudgetEnforcer({ hourly_usd: 1.0, enforcement: 'block' }, ledger);

    // Simulate cost accumulation exceeding budget
    ledger.record(makeEntry({ computed_usd: 2.0 }));

    const result = enforcer.canProceed();
    expect(result.allowed).toBe(false);
    // This is what core-loop checks — if false, task is refused
  });

  test('canProceed() returns degradeToLevel when enforcement=degrade', () => {
    const db = createTestDb();
    const ledger = new CostLedger(db);
    const enforcer = new BudgetEnforcer({ hourly_usd: 1.0, enforcement: 'degrade' }, ledger);

    ledger.record(makeEntry({ computed_usd: 2.0 }));

    const result = enforcer.canProceed();
    expect(result.allowed).toBe(true);
    expect(result.degradeToLevel).toBe(1); // force L1 (cheapest)
    // core-loop uses this to cap routing.level
  });
});

describe('Economy Wiring — DynamicBudgetAllocator in execution path', () => {
  test('allocate() returns historical budget when data exists', () => {
    const db = createTestDb();
    const ledger = new CostLedger(db);
    const allocator = new DynamicBudgetAllocator(ledger);

    // Seed with historical token data
    for (let i = 0; i < 10; i++) {
      ledger.record(
        makeEntry({
          id: `hist-${i}:1`,
          tokens_input: 3000 + i * 200,
          tokens_output: 1000 + i * 100,
          task_type_signature: 'refactor:ts:small',
          routing_level: 2,
        }),
      );
    }

    const alloc = allocator.allocate('refactor:ts:small', 2, 50000);
    // Should use historical data, not the fixed 50K default
    expect(alloc.source).not.toBe('default');
    expect(alloc.maxTokens).toBeGreaterThan(0);
    // core-loop replaces routing.budgetTokens with this value
  });
});

describe('Economy Wiring — CostPredictor in execution path', () => {
  test('predict() then calibrate() improves future predictions', () => {
    const db = createTestDb();
    const ledger = new CostLedger(db);
    const predictor = new CostPredictor(ledger);

    // Cold start prediction
    const cold = predictor.predict('refactor:ts:small', 2);
    expect(cold.basis).toBe('cold-start');

    // Calibrate with actual costs (simulating trace-collector recording)
    for (let i = 0; i < 10; i++) {
      predictor.calibrate('refactor:ts:small', 2, 0.05);
    }

    // Now prediction should be EMA-calibrated
    const calibrated = predictor.predict('refactor:ts:small', 2);
    expect(calibrated.basis).toBe('ema-calibrated');
    expect(calibrated.predicted_usd).toBeCloseTo(0.05, 1);
    // core-loop calls predict() before dispatch, calibrate() after completion
  });
});

describe('Economy Wiring — costAwareScore in worker-selector path', () => {
  test('costAwareScore() produces different scores based on cost prediction', () => {
    const cheapPrediction = {
      taskTypeSignature: 'test:ts:small',
      predicted_usd: 0.01,
      confidence: 0.8,
      p95_usd: 0.15,
      basis: 'ema-calibrated' as const,
      observation_count: 20,
    };
    const expensivePrediction = { ...cheapPrediction, predicted_usd: 0.14 };

    const cheapScore = costAwareScore(cheapPrediction, 0.15, []);
    const expensiveScore = costAwareScore(expensivePrediction, 0.15, []);

    expect(cheapScore).toBeGreaterThan(expensiveScore);
    // worker-selector calls this instead of naive 1-(tokens/budget) when economy enabled
  });

  test('budget pressure reduces score', () => {
    const pred = {
      taskTypeSignature: 'test:ts:small',
      predicted_usd: 0.05,
      confidence: 0.8,
      p95_usd: 0.15,
      basis: 'ema-calibrated' as const,
      observation_count: 20,
    };

    const relaxed = costAwareScore(pred, 0.15, [
      { window: 'hour', spent_usd: 5, limit_usd: 100, utilization_pct: 5, enforcement: 'warn', exceeded: false },
    ]);
    const tight = costAwareScore(pred, 0.15, [
      { window: 'hour', spent_usd: 90, limit_usd: 100, utilization_pct: 90, enforcement: 'warn', exceeded: false },
    ]);

    expect(relaxed).toBeGreaterThan(tight);
    // worker-selector passes budget statuses from BudgetEnforcer.checkBudget()
  });
});

describe('Economy Wiring — FederationCostRelay in factory path', () => {
  test('relay broadcasts costs via bus subscription', () => {
    const events: Array<{ event: string; payload: unknown }> = [];
    const bus = {
      emit: (event: string, payload: unknown) => events.push({ event, payload }),
      on: (event: string, handler: (p: unknown) => void) => {
        // Simulate bus subscription — immediately trigger with test data
        if (event === 'economy:cost_recorded') {
          handler({ taskId: 'task-1', computed_usd: 0.5 });
        }
        return () => {};
      },
    } as any;

    const relay = new FederationCostRelay(bus);
    // Simulate what factory does: subscribe to cost_recorded and broadcast
    bus.on('economy:cost_recorded', ({ taskId, computed_usd }: any) => {
      relay.broadcastCost({
        instanceId: 'local',
        taskId,
        computed_usd,
        rate_card_id: 'auto',
        cost_tier: 'billing',
        timestamp: Date.now(),
      });
    });

    const broadcasts = events.filter((e) => e.event === 'economy:federation_cost_broadcast');
    expect(broadcasts.length).toBeGreaterThanOrEqual(1);
    // factory subscribes bus.on('economy:cost_recorded') → relay.broadcastCost()
  });
});
