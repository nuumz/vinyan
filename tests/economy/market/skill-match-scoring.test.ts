/**
 * Tests for Phase-3 skillMatch in `scoreBid`.
 *
 * Covers:
 *   - computeSkillMatch: empty requirements → 1.0
 *   - computeSkillMatch: full coverage → 1.0
 *   - computeSkillMatch: missing required attenuates by weight share
 *   - scoreBid: skill-aware bid outscores skill-blind bid for same task
 *   - runAuction: required capabilities forwarded; budget cap includes skillTokenOverhead
 */
import { describe, expect, test } from 'bun:test';
import {
  type BidderContext,
  computeSkillMatch,
  type RequiredCapability,
  runAuction,
  scoreBid,
} from '../../../src/economy/market/auction-engine.ts';
import type { EngineBid } from '../../../src/economy/market/schemas.ts';

function makeBid(overrides: Partial<EngineBid>): EngineBid {
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

describe('computeSkillMatch', () => {
  test('empty requirements → 1.0 (legacy path, no penalty)', () => {
    expect(computeSkillMatch(['code.mutation'], [])).toBe(1.0);
    expect(computeSkillMatch(['code.mutation'], undefined)).toBe(1.0);
    expect(computeSkillMatch(undefined, undefined)).toBe(1.0);
  });

  test('full coverage of required capabilities → 1.0', () => {
    const required: RequiredCapability[] = [
      { id: 'code.mutation', weight: 0.7 },
      { id: 'code.testing', weight: 0.3 },
    ];
    expect(computeSkillMatch(['code.mutation', 'code.testing'], required)).toBeCloseTo(1.0);
  });

  test('partial coverage attenuates by missing weight', () => {
    const required: RequiredCapability[] = [
      { id: 'a', weight: 0.7 },
      { id: 'b', weight: 0.3 },
    ];
    expect(computeSkillMatch(['a'], required)).toBeCloseTo(0.7);
    expect(computeSkillMatch(['b'], required)).toBeCloseTo(0.3);
  });

  test('zero coverage → 0', () => {
    const required: RequiredCapability[] = [{ id: 'needed', weight: 1 }];
    expect(computeSkillMatch(['unrelated'], required)).toBe(0);
    expect(computeSkillMatch([], required)).toBe(0);
  });

  test('zero-weight requirements → 1.0 (no signal)', () => {
    expect(computeSkillMatch([], [{ id: 'x', weight: 0 }])).toBe(1.0);
  });
});

describe('scoreBid skillMatch attenuation', () => {
  test('skill-aware bid outscores skill-blind bid when requirements present', () => {
    const required: RequiredCapability[] = [{ id: 'code.mutation.ts', weight: 1 }];

    const aware = makeBid({ bidderId: 'aware', declaredCapabilityIds: ['code.mutation.ts'] });
    const blind = makeBid({ bidderId: 'blind', declaredCapabilityIds: [] });
    const ctx = makeContext();

    const awareScore = scoreBid(aware, ctx, 5000, required);
    const blindScore = scoreBid(blind, ctx, 5000, required);
    expect(awareScore).toBeGreaterThan(blindScore);
    // Blind bid is fully attenuated (skillMatch=0) → score 0
    expect(blindScore).toBe(0);
  });

  test('legacy bid without declared capabilities and no requirements is unaffected', () => {
    const bid = makeBid({ declaredCapabilityIds: undefined });
    const ctx = makeContext();
    const score = scoreBid(bid, ctx, 5000);
    expect(score).toBeGreaterThan(0);
  });

  test('skillTokenOverhead reduces costEfficiency proportionally', () => {
    const noOverhead = makeBid({ skillTokenOverhead: 0 });
    const withOverhead = makeBid({ skillTokenOverhead: 1500 });
    const ctx = makeContext();
    const taskBudget = 5000;
    const noOverheadScore = scoreBid(noOverhead, ctx, taskBudget);
    const withOverheadScore = scoreBid(withOverhead, ctx, taskBudget);
    expect(withOverheadScore).toBeLessThan(noOverheadScore);
  });
});

describe('runAuction skill awareness', () => {
  test('forwards requirements to scoreBid; winner is the persona-matched bid', () => {
    const required: RequiredCapability[] = [{ id: 'design.interface', weight: 1 }];

    const matched = makeBid({
      bidId: 'b1',
      bidderId: 'provider-a',
      personaId: 'architect',
      declaredCapabilityIds: ['design.interface'],
    });
    const unmatched = makeBid({
      bidId: 'b2',
      bidderId: 'provider-b',
      personaId: 'developer',
      declaredCapabilityIds: ['code.mutation'],
    });
    const contexts = new Map<string, BidderContext>([
      ['provider-a', makeContext()],
      ['provider-b', makeContext({ successes: 100, failures: 0 })], // higher trust but wrong skill
    ]);
    const result = runAuction('auc-1', 'task-1', [matched, unmatched], contexts, 5000, 'B', required);
    expect(result?.winnerId).toBe('provider-a');
  });

  test('budget cap funds the winner-side skillTokenOverhead', () => {
    const winner = makeBid({
      bidId: 'b1',
      bidderId: 'aware',
      estimatedTokensInput: 1000,
      estimatedTokensOutput: 500,
      skillTokenOverhead: 800,
      declaredCapabilityIds: ['x'],
    });
    const second = makeBid({
      bidId: 'b2',
      bidderId: 'blind',
      estimatedTokensInput: 800,
      estimatedTokensOutput: 400,
      skillTokenOverhead: 0,
      declaredCapabilityIds: ['x'],
    });
    const contexts = new Map<string, BidderContext>([
      ['aware', makeContext({ successes: 100, failures: 0 })],
      ['blind', makeContext()],
    ]);
    const required: RequiredCapability[] = [{ id: 'x', weight: 1 }];
    const result = runAuction('auc-2', 'task-2', [winner, second], contexts, 5000, 'B', required);
    // budgetCap must cover at least the winner's full token + overhead spend
    const winnerTotal = 1000 + 500 + 800;
    expect(result?.budgetCap ?? 0).toBeGreaterThanOrEqual(winnerTotal);
  });

  test('legacy path (no requirements) still produces a winner with skillMatch=1.0', () => {
    const a = makeBid({ bidderId: 'a' });
    const b = makeBid({ bidderId: 'b' });
    const contexts = new Map<string, BidderContext>([
      ['a', makeContext({ successes: 50, failures: 5 })],
      ['b', makeContext({ successes: 10, failures: 50 })],
    ]);
    const result = runAuction('auc-3', 'task-3', [a, b], contexts, 5000, 'B');
    expect(result?.winnerId).toBe('a');
  });
});
