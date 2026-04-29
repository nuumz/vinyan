/**
 * Phase-12 — `scoreBid` overclaim penalty integration.
 *
 * Verifies that:
 *   - `personaOverclaimPenalty` factor is multiplied into score
 *   - default 1.0 (legacy / cold-start) keeps pre-Phase-12 behaviour
 *   - a clean persona outscores an identical persona with overclaim history
 *   - MarketScheduler.allocate() injects the penalty for bids carrying personaId
 */
import { describe, expect, test } from 'bun:test';
import { type BidderContext, scoreBid } from '../../../src/economy/market/auction-engine.ts';
import type { MarketConfig } from '../../../src/economy/economy-config.ts';
import { MarketScheduler } from '../../../src/economy/market/market-scheduler.ts';
import type { EngineBid } from '../../../src/economy/market/schemas.ts';

function makeBid(overrides: Partial<EngineBid> = {}): EngineBid {
  return {
    bidId: 'bid-fixture',
    auctionId: 'auc-fixture',
    bidderId: 'provider-a',
    bidderType: 'local',
    estimatedTokensInput: 1000,
    estimatedTokensOutput: 500,
    estimatedDurationMs: 1000,
    declaredConfidence: 0.7,
    acceptsTokenBudget: 5000,
    acceptsTimeLimitMs: 10_000,
    submittedAt: 1,
    ...overrides,
  };
}

function makeContext(overrides: Partial<BidderContext> = {}): BidderContext {
  return {
    successes: 20,
    failures: 5,
    capabilityScore: 0.8,
    bidAccuracy: null,
    ...overrides,
  };
}

describe('scoreBid — Phase-12 personaOverclaimPenalty', () => {
  test('default (undefined) factor keeps pre-Phase-12 score (= explicit 1.0)', () => {
    const bid = makeBid();
    const a = scoreBid(bid, makeContext({ personaOverclaimPenalty: undefined }), 5000);
    const b = scoreBid(bid, makeContext({ personaOverclaimPenalty: 1.0 }), 5000);
    expect(a).toBeCloseTo(b);
  });

  test('penalty 0.5 halves the final score (vs 1.0 baseline, all else equal)', () => {
    const bid = makeBid();
    const baseline = scoreBid(bid, makeContext({ personaOverclaimPenalty: 1.0 }), 5000);
    const penalised = scoreBid(bid, makeContext({ personaOverclaimPenalty: 0.5 }), 5000);
    expect(penalised).toBeCloseTo(baseline * 0.5);
  });

  test('penalty 0.75 attenuates score by 25%', () => {
    const bid = makeBid();
    const baseline = scoreBid(bid, makeContext({ personaOverclaimPenalty: 1.0 }), 5000);
    const penalised = scoreBid(bid, makeContext({ personaOverclaimPenalty: 0.75 }), 5000);
    expect(penalised).toBeCloseTo(baseline * 0.75);
  });

  test('penalty does not interact with skillMatch — both attenuators stack', () => {
    const bid = makeBid({ declaredCapabilityIds: ['x'] });
    const required = [
      { id: 'x', weight: 0.5 },
      { id: 'y', weight: 0.5 },
    ];
    // skillMatch = 0.5 (covers x but not y), overclaim = 0.5 → total attenuator 0.25
    const baseline = scoreBid(makeBid(), makeContext({ personaOverclaimPenalty: 1.0 }), 5000);
    const stacked = scoreBid(bid, makeContext({ personaOverclaimPenalty: 0.5 }), 5000, required);
    expect(stacked).toBeCloseTo(baseline * 0.25);
  });
});

describe('MarketScheduler — Phase-12 penalty injection', () => {
  function makeScheduler(): MarketScheduler {
    const cfg: MarketConfig = {
      enabled: true,
      min_bidders: 2,
      max_bidders: 8,
      auction_timeout_ms: 1000,
      phase_a_min_observations: 1,
      phase_b_min_observations: 1,
      phase_c_min_observations: 1,
    } as unknown as MarketConfig;
    const s = new MarketScheduler(cfg);
    // Force phase out of A so isActive() returns true.
    const ph = s.getPhase();
    Object.assign(ph, { currentPhase: 'B' });
    // The phase state is a copy via getPhase; we need to hack-set the
    // internal one. Use the public path: simulate phase advancement by
    // calling allocate with enough fixture data. Easier: cast & overwrite.
    (s as unknown as { phaseState: { currentPhase: string } }).phaseState.currentPhase = 'B';
    return s;
  }

  test('a clean persona outscores an overclaiming one for the same provider', () => {
    const s = makeScheduler();
    const tracker = s.getPersonaOverclaimTracker();

    // 'reviewer' is squeaky clean — 20 obs, 0 overclaims → penalty 1.0
    for (let i = 0; i < 20; i++) tracker.recordObservation('reviewer');

    // 'developer' has 50% overclaim past cold-start → penalty 0.5
    for (let i = 0; i < 20; i++) tracker.recordObservation('developer');
    for (let i = 0; i < 10; i++) tracker.recordOverclaim('developer');

    const bidClean = makeBid({ bidId: 'bid-clean', bidderId: 'p-clean', personaId: 'reviewer' });
    const bidDirty = makeBid({ bidId: 'bid-dirty', bidderId: 'p-dirty', personaId: 'developer' });

    const contexts = new Map<string, BidderContext>([
      ['p-clean', makeContext()],
      ['p-dirty', makeContext()],
    ]);

    const result = s.allocate('task-x', [bidClean, bidDirty], contexts, 5000);
    expect(result).not.toBeNull();
    expect(result!.winnerId).toBe('p-clean');

    // Allocate is expected to MUTATE contexts in place — verify the
    // injected penalty multipliers landed correctly.
    expect(contexts.get('p-clean')?.personaOverclaimPenalty).toBe(1);
    expect(contexts.get('p-dirty')?.personaOverclaimPenalty).toBe(0.5);
  });

  test('bid without personaId gets default 1.0 penalty (legacy path safe)', () => {
    const s = makeScheduler();
    const bid = makeBid({ bidderId: 'p1' /* no personaId */ });
    const bid2 = makeBid({ bidId: 'bid-2', bidderId: 'p2' /* no personaId */ });
    const contexts = new Map<string, BidderContext>([
      ['p1', makeContext()],
      ['p2', makeContext()],
    ]);
    s.allocate('task-y', [bid, bid2], contexts, 5000);
    expect(contexts.get('p1')?.personaOverclaimPenalty).toBe(1);
    expect(contexts.get('p2')?.personaOverclaimPenalty).toBe(1);
  });

  test('cold-start persona (< 10 observations) gets 1.0 penalty even with overclaims', () => {
    const s = makeScheduler();
    s.getPersonaOverclaimTracker().recordOverclaim('newbie');
    s.getPersonaOverclaimTracker().recordObservation('newbie');
    const bid = makeBid({ bidderId: 'p1', personaId: 'newbie' });
    const bid2 = makeBid({ bidId: 'bid-2', bidderId: 'p2', personaId: 'newbie' });
    const contexts = new Map<string, BidderContext>([
      ['p1', makeContext()],
      ['p2', makeContext()],
    ]);
    s.allocate('task-z', [bid, bid2], contexts, 5000);
    expect(contexts.get('p1')?.personaOverclaimPenalty).toBe(1);
  });
});
