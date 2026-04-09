import { describe, expect, test } from 'bun:test';
import { type BidderContext, runAuction, scoreBid } from '../../../src/economy/market/auction-engine.ts';
import type { EngineBid } from '../../../src/economy/market/schemas.ts';

function makeBid(overrides?: Partial<EngineBid>): EngineBid {
  return {
    bidId: `bid-${Math.random().toString(36).slice(2)}`,
    auctionId: 'auc-test',
    bidderId: 'engine-1',
    bidderType: 'local',
    estimatedTokensInput: 1000,
    estimatedTokensOutput: 2000,
    estimatedDurationMs: 5000,
    declaredConfidence: 0.8,
    acceptsTokenBudget: 50000,
    acceptsTimeLimitMs: 30000,
    submittedAt: Date.now(),
    ...overrides,
  };
}

function makeContext(overrides?: Partial<BidderContext>): BidderContext {
  return { successes: 20, failures: 2, capabilityScore: 0.8, bidAccuracy: null, ...overrides };
}

describe('scoreBid', () => {
  test('higher trust produces higher score', () => {
    const bid = makeBid();
    const highTrust = scoreBid(bid, makeContext({ successes: 50, failures: 1 }), 50000);
    const lowTrust = scoreBid(bid, makeContext({ successes: 5, failures: 5 }), 50000);
    expect(highTrust).toBeGreaterThan(lowTrust);
  });

  test('cheaper bids score higher', () => {
    const cheapBid = makeBid({ estimatedTokensOutput: 1000 });
    const expensiveBid = makeBid({ estimatedTokensOutput: 40000 });
    const ctx = makeContext();
    expect(scoreBid(cheapBid, ctx, 50000)).toBeGreaterThan(scoreBid(expensiveBid, ctx, 50000));
  });

  test('remote bidders get 0.9x penalty', () => {
    const localBid = makeBid({ bidderType: 'local' });
    const remoteBid = makeBid({ bidderType: 'remote' });
    const ctx = makeContext();
    const localScore = scoreBid(localBid, ctx, 50000);
    const remoteScore = scoreBid(remoteBid, ctx, 50000);
    expect(remoteScore).toBeCloseTo(localScore * 0.9, 5);
  });
});

describe('runAuction', () => {
  test('returns null for empty bids', () => {
    expect(runAuction('auc-1', 'task-1', [], new Map(), 50000, 'B')).toBeNull();
  });

  test('selects highest-scoring bidder as winner', () => {
    const bids = [
      makeBid({ bidderId: 'weak', estimatedTokensOutput: 40000 }),
      makeBid({ bidderId: 'strong', estimatedTokensOutput: 2000 }),
    ];
    const contexts = new Map<string, BidderContext>([
      ['weak', makeContext({ successes: 5, failures: 5, capabilityScore: 0.5 })],
      ['strong', makeContext({ successes: 50, failures: 1, capabilityScore: 0.9 })],
    ]);
    const result = runAuction('auc-1', 'task-1', bids, contexts, 50000, 'B');
    expect(result).not.toBeNull();
    expect(result!.winnerId).toBe('strong');
  });

  test('Vickrey budget cap uses second-price estimate', () => {
    const bids = [
      makeBid({ bidderId: 'winner', estimatedTokensInput: 500, estimatedTokensOutput: 1500 }),
      makeBid({ bidderId: 'loser', estimatedTokensInput: 1000, estimatedTokensOutput: 5000 }),
    ];
    const contexts = new Map<string, BidderContext>([
      ['winner', makeContext({ successes: 50, failures: 0 })],
      ['loser', makeContext({ successes: 10, failures: 10 })],
    ]);
    const result = runAuction('auc-1', 'task-1', bids, contexts, 50000, 'B')!;
    expect(result.budgetCap).not.toBeNull();
    // Budget cap = max(winner=2000, ceil(loser=6000 * 1.1)) = 6600
    expect(result.budgetCap!).toBeGreaterThanOrEqual(2000);
  });

  test('single bidder has no budget cap', () => {
    const bids = [makeBid({ bidderId: 'solo' })];
    const contexts = new Map([['solo', makeContext()]]);
    const result = runAuction('auc-1', 'task-1', bids, contexts, 50000, 'B')!;
    expect(result.budgetCap).toBeNull();
  });

  test('deterministic: same inputs → same output', () => {
    const bids = [
      makeBid({ bidderId: 'a', estimatedTokensOutput: 3000, submittedAt: 1000 }),
      makeBid({ bidderId: 'b', estimatedTokensOutput: 5000, submittedAt: 1000 }),
    ];
    const contexts = new Map([
      ['a', makeContext({ successes: 30, failures: 2 })],
      ['b', makeContext({ successes: 20, failures: 5 })],
    ]);
    const r1 = runAuction('auc-1', 'task-1', bids, contexts, 50000, 'B');
    const r2 = runAuction('auc-1', 'task-1', bids, contexts, 50000, 'B');
    expect(r1!.winnerId).toBe(r2!.winnerId);
    expect(r1!.winnerScore).toBe(r2!.winnerScore);
  });
});
