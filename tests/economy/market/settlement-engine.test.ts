import { describe, expect, test } from 'bun:test';
import type { EngineBid } from '../../../src/economy/market/schemas.ts';
import { isAccurateBid, logRatioAccuracy, settleBid } from '../../../src/economy/market/settlement-engine.ts';

function makeBid(overrides?: Partial<EngineBid>): EngineBid {
  return {
    bidId: 'bid-1',
    auctionId: 'auc-task-1',
    bidderId: 'engine-1',
    bidderType: 'local',
    estimatedTokensInput: 1000,
    estimatedTokensOutput: 4000,
    estimatedDurationMs: 5000,
    estimatedUsd: 0.075,
    declaredConfidence: 0.8,
    acceptsTokenBudget: 50000,
    acceptsTimeLimitMs: 30000,
    submittedAt: Date.now(),
    ...overrides,
  };
}

describe('logRatioAccuracy', () => {
  test('perfect estimate = 1.0', () => {
    expect(logRatioAccuracy(100, 100)).toBeCloseTo(1.0, 5);
  });

  test('2x overestimate is penalized', () => {
    const acc = logRatioAccuracy(200, 100);
    expect(acc).toBeLessThan(1.0);
    expect(acc).toBeGreaterThan(0);
  });

  test('symmetric: 2x over and 2x under get same penalty', () => {
    const over = logRatioAccuracy(200, 100);
    const under = logRatioAccuracy(50, 100);
    expect(over).toBeCloseTo(under, 5);
  });

  test('zero values return 0', () => {
    expect(logRatioAccuracy(0, 100)).toBe(0);
    expect(logRatioAccuracy(100, 0)).toBe(0);
  });
});

describe('settleBid', () => {
  test('computes settlement from bid and actual', () => {
    const bid = makeBid();
    const settlement = settleBid(bid, {
      tokensConsumed: 5000,
      durationMs: 5000,
      computedUsd: 0.075,
      success: true,
    });
    expect(settlement.cost_accuracy).toBeGreaterThan(0);
    expect(settlement.duration_accuracy).toBeCloseTo(1.0, 3);
    expect(settlement.composite_accuracy).toBeGreaterThan(0);
    expect(settlement.penalty_type).toBeNull();
  });

  test('detects underbidding when actual >> estimated', () => {
    const bid = makeBid({ estimatedTokensInput: 100, estimatedTokensOutput: 400 });
    const settlement = settleBid(bid, {
      tokensConsumed: 10000,
      durationMs: 5000,
      computedUsd: 0.15,
      success: true,
    });
    expect(settlement.penalty_type).toBe('underbid');
  });

  test('no penalty when estimates are accurate', () => {
    const bid = makeBid({ estimatedTokensInput: 2000, estimatedTokensOutput: 3000 });
    const settlement = settleBid(bid, {
      tokensConsumed: 5000,
      durationMs: 5000,
      computedUsd: 0.075,
      success: true,
    });
    expect(settlement.penalty_type).toBeNull();
  });
});

describe('isAccurateBid', () => {
  test('accurate when composite >= 0.6', () => {
    const settlement = settleBid(makeBid(), {
      tokensConsumed: 5000,
      durationMs: 5000,
      computedUsd: 0.075,
      success: true,
    });
    if (settlement.composite_accuracy >= 0.6) {
      expect(isAccurateBid(settlement)).toBe(true);
    }
  });
});
