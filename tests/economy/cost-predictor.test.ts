import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { CostLedger, type CostLedgerEntry } from '../../src/economy/cost-ledger.ts';
import { CostPredictor } from '../../src/economy/cost-predictor.ts';
import { migration001 } from '../../src/db/migrations/001_initial_schema.ts';

function createEnv() {
  const db = new Database(':memory:');
  migration001.up(db);
  const ledger = new CostLedger(db);
  const predictor = new CostPredictor(ledger);
  return { ledger, predictor };
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
    oracle_invocations: 3,
    computed_usd: 0.075,
    cost_tier: 'billing',
    routing_level: 2,
    task_type_signature: 'refactor:ts:small',
    ...overrides,
  };
}

describe('CostPredictor', () => {
  test('cold-start returns heuristic for L2', () => {
    const { predictor } = createEnv();
    const pred = predictor.predict('refactor:ts:small', 2);
    expect(pred.basis).toBe('cold-start');
    expect(pred.predicted_usd).toBeGreaterThan(0);
    expect(pred.confidence).toBe(0.1);
    expect(pred.observation_count).toBe(0);
  });

  test('cold-start returns 0 for L0', () => {
    const { predictor } = createEnv();
    const pred = predictor.predict('any:task', 0);
    expect(pred.predicted_usd).toBe(0);
  });

  test('calibrate updates predictions', () => {
    const { predictor } = createEnv();
    // Calibrate with 10 observations
    for (let i = 0; i < 10; i++) {
      predictor.calibrate('refactor:ts:small', 2, 0.05 + i * 0.01);
    }

    const pred = predictor.predict('refactor:ts:small', 2);
    expect(pred.basis).toBe('ema-calibrated');
    expect(pred.predicted_usd).toBeGreaterThan(0);
    expect(pred.confidence).toBeGreaterThan(0.1);
    expect(pred.observation_count).toBe(10);
  });

  test('EMA converges toward actual cost', () => {
    const { predictor } = createEnv();
    const targetCost = 0.1;

    // Feed consistent cost observations
    for (let i = 0; i < 30; i++) {
      predictor.calibrate('test:ts:medium', 2, targetCost);
    }

    const pred = predictor.predict('test:ts:medium', 2);
    // Should be within 20% of target after 30 observations
    expect(Math.abs(pred.predicted_usd - targetCost) / targetCost).toBeLessThan(0.2);
  });

  test('separate predictions per routing level', () => {
    const { predictor } = createEnv();
    predictor.calibrate('task:ts:small', 1, 0.003);
    predictor.calibrate('task:ts:small', 2, 0.075);

    expect(predictor.getObservationCount('task:ts:small', 1)).toBe(1);
    expect(predictor.getObservationCount('task:ts:small', 2)).toBe(1);
  });

  test('p95 from ledger when available', () => {
    const { ledger, predictor } = createEnv();
    // Add enough entries to the ledger for p95 computation
    for (let i = 0; i < 20; i++) {
      ledger.record(
        makeEntry({
          id: `p-${i}:1`,
          computed_usd: 0.05 + i * 0.005,
          task_type_signature: 'test:ts:p95',
          routing_level: 2,
        }),
      );
      predictor.calibrate('test:ts:p95', 2, 0.05 + i * 0.005);
    }

    const pred = predictor.predict('test:ts:p95', 2);
    expect(pred.p95_usd).toBeGreaterThan(pred.predicted_usd);
  });
});
