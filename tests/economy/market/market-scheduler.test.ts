import { describe, expect, test } from 'bun:test';
import type { MarketConfig } from '../../../src/economy/economy-config.ts';
import type { BidderContext } from '../../../src/economy/market/auction-engine.ts';
import { MarketScheduler } from '../../../src/economy/market/market-scheduler.ts';
import type { EngineBid } from '../../../src/economy/market/schemas.ts';

function makeConfig(overrides?: Partial<MarketConfig>): MarketConfig {
  return {
    enabled: true,
    min_cost_records: 200,
    bid_ttl_ms: 30000,
    min_bidders: 2,
    weights: { cost: 0.3, quality: 0.4, duration: 0.1, accuracy: 0.2 },
    ...overrides,
  };
}

function makeBid(overrides?: Partial<EngineBid>): EngineBid {
  return {
    bidId: `bid-${Math.random().toString(36).slice(2)}`,
    auctionId: 'auc-test',
    bidderId: 'engine-1',
    bidderType: 'local',
    estimatedTokensInput: 1000,
    estimatedTokensOutput: 3000,
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

describe('MarketScheduler', () => {
  test('inactive at Phase A', () => {
    const scheduler = new MarketScheduler(makeConfig());
    expect(scheduler.isActive()).toBe(false);
  });

  test('allocate returns null when inactive', () => {
    const scheduler = new MarketScheduler(makeConfig());
    const result = scheduler.allocate('task-1', [makeBid()], new Map(), 50000);
    expect(result).toBeNull();
  });

  test('allocate returns null with insufficient bidders', () => {
    const scheduler = new MarketScheduler(makeConfig());
    // Force Phase B
    scheduler.evaluatePhase({
      activeEngines: 3,
      minTasksPerEngine: 100,
      totalTraces: 1000,
      auctionCount: 0,
      trustedRemotePeers: 0,
      minRemotePeerTasks: 0,
      distinctEnginesWithBids: 0,
      minSettledBidsPerEngine: 0,
      dominantWinRate: 0.5,
    });
    expect(scheduler.isActive()).toBe(true);

    // Only 1 bidder — needs 2
    const result = scheduler.allocate('task-1', [makeBid()], new Map([['engine-1', makeContext()]]), 50000);
    expect(result).toBeNull();
  });

  test('allocate runs auction with sufficient bidders', () => {
    const scheduler = new MarketScheduler(makeConfig());
    scheduler.evaluatePhase({
      activeEngines: 3,
      minTasksPerEngine: 100,
      totalTraces: 1000,
      auctionCount: 0,
      trustedRemotePeers: 0,
      minRemotePeerTasks: 0,
      distinctEnginesWithBids: 0,
      minSettledBidsPerEngine: 0,
      dominantWinRate: 0.5,
    });

    const bids = [makeBid({ bidderId: 'engine-A' }), makeBid({ bidderId: 'engine-B' })];
    const contexts = new Map([
      ['engine-A', makeContext({ successes: 30, failures: 2 })],
      ['engine-B', makeContext({ successes: 10, failures: 5 })],
    ]);

    const result = scheduler.allocate('task-1', bids, contexts, 50000);
    expect(result).not.toBeNull();
    expect(result!.winnerId).toBe('engine-A'); // higher trust
    expect(result!.bidderCount).toBe(2);
  });

  test('settle records accuracy', () => {
    const scheduler = new MarketScheduler(makeConfig());
    const bid = makeBid({ bidderId: 'engine-A', estimatedTokensOutput: 5000 });
    scheduler.settle(bid, {
      tokensConsumed: 5000,
      durationMs: 5000,
      computedUsd: 0.075,
      success: true,
    });

    const accuracy = scheduler.getAccuracyTracker().getAccuracy('engine-A');
    expect(accuracy).not.toBeNull();
    expect(accuracy!.total_settled_bids).toBe(1);
  });

  test('phase transition emits event', () => {
    const events: Array<{ event: string; payload: unknown }> = [];
    const bus = { emit: (e: string, p: unknown) => events.push({ event: e, payload: p }) } as any;
    const scheduler = new MarketScheduler(makeConfig(), bus);

    scheduler.evaluatePhase({
      activeEngines: 3,
      minTasksPerEngine: 100,
      totalTraces: 1000,
      auctionCount: 0,
      trustedRemotePeers: 0,
      minRemotePeerTasks: 0,
      distinctEnginesWithBids: 0,
      minSettledBidsPerEngine: 0,
      dominantWinRate: 0.5,
    });

    const transitions = events.filter((e) => e.event === 'market:phase_transition');
    expect(transitions).toHaveLength(1);
  });
});
