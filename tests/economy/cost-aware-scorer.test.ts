import { describe, expect, test } from 'bun:test';
import type { BudgetStatus } from '../../src/economy/budget-enforcer.ts';
import { costAwareScore, costAwareWorkerScore } from '../../src/economy/cost-aware-scorer.ts';
import type { CostPrediction } from '../../src/economy/cost-predictor.ts';

function makePrediction(overrides?: Partial<CostPrediction>): CostPrediction {
  return {
    taskTypeSignature: 'test:ts:small',
    predicted_usd: 0.05,
    confidence: 0.8,
    p95_usd: 0.15,
    basis: 'ema-calibrated',
    observation_count: 20,
    ...overrides,
  };
}

function makeBudgetStatus(overrides?: Partial<BudgetStatus>): BudgetStatus {
  return {
    window: 'hour',
    spent_usd: 5.0,
    limit_usd: 100.0,
    utilization_pct: 5.0,
    enforcement: 'warn',
    exceeded: false,
    ...overrides,
  };
}

describe('costAwareScore', () => {
  test('returns 0.5 when no prediction', () => {
    expect(costAwareScore(null, 1.0, [])).toBe(0.5);
  });

  test('higher score for cheaper predictions', () => {
    const cheap = makePrediction({ predicted_usd: 0.01 });
    const expensive = makePrediction({ predicted_usd: 0.14 });

    const cheapScore = costAwareScore(cheap, 0.15, []);
    const expensiveScore = costAwareScore(expensive, 0.15, []);

    expect(cheapScore).toBeGreaterThan(expensiveScore);
  });

  test('budget pressure reduces score', () => {
    const pred = makePrediction({ predicted_usd: 0.05 });

    const relaxed = costAwareScore(pred, 0.15, [makeBudgetStatus({ utilization_pct: 10 })]);
    const tight = costAwareScore(pred, 0.15, [makeBudgetStatus({ utilization_pct: 90 })]);

    expect(relaxed).toBeGreaterThan(tight);
  });

  test('score is clamped to [0.1, 1.0]', () => {
    const veryExpensive = makePrediction({ predicted_usd: 10.0 });
    const score = costAwareScore(veryExpensive, 0.15, []);
    expect(score).toBeGreaterThanOrEqual(0.1);
    expect(score).toBeLessThanOrEqual(1.0);
  });
});

describe('costAwareWorkerScore', () => {
  test('computes full score with cost awareness', () => {
    const pred = makePrediction({ predicted_usd: 0.05 });
    const score = costAwareWorkerScore(0.8, 0.9, 1.0, pred, 0.15, []);
    // capability^2 * quality * costScore^0.5 * staleness
    expect(score).toBeGreaterThan(0);
    expect(score).toBeLessThan(1);
  });

  test('higher capability produces higher score', () => {
    const pred = makePrediction();
    const lowCap = costAwareWorkerScore(0.5, 0.9, 1.0, pred, 0.15, []);
    const highCap = costAwareWorkerScore(0.9, 0.9, 1.0, pred, 0.15, []);
    expect(highCap).toBeGreaterThan(lowCap);
  });

  test('falls back gracefully with null prediction', () => {
    const score = costAwareWorkerScore(0.8, 0.9, 1.0, null, 0.15, []);
    expect(score).toBeGreaterThan(0);
  });
});
