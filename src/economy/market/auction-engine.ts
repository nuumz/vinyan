/**
 * Auction Engine — Modified Vickrey (sealed-bid, second-price) with trust weighting.
 *
 * A3 compliant: deterministic sort + select, no LLM.
 * Truthful bidding is dominant strategy in Vickrey auctions.
 *
 * Source of truth: Economy OS plan §E3
 */
import { wilsonLowerBound } from '../../sleep-cycle/wilson.ts';
import type { AuctionResult, BidAccuracyRecord, EngineBid, MarketPhase } from './schemas.ts';

export interface BidderContext {
  successes: number;
  failures: number;
  capabilityScore: number;
  bidAccuracy: BidAccuracyRecord | null;
}

export interface ScoredBid {
  bid: EngineBid;
  score: number;
}

/**
 * Score a single bid. A3: deterministic formula.
 *
 * score = trust² × capability² × costEfficiency^0.5 × accuracyPremium
 */
export function scoreBid(bid: EngineBid, context: BidderContext, taskBudgetTokens: number): number {
  // Trust: Wilson LB of (successes / total)
  const total = context.successes + context.failures;
  const trust = total > 0 ? wilsonLowerBound(context.successes, total) : 0.1;

  // Capability match (from external CapabilityModel)
  const capability = Math.max(0.1, context.capabilityScore);

  // Cost efficiency
  const estimatedTokens = bid.estimatedTokensInput + bid.estimatedTokensOutput;
  const costRatio = taskBudgetTokens > 0 ? Math.min(estimatedTokens / taskBudgetTokens, 1.0) : 0;
  const costEfficiency = Math.max(0.1, 1 - costRatio);

  // Accuracy premium from bid history
  let accuracyPremium: number;
  if (!context.bidAccuracy || context.bidAccuracy.total_settled_bids < 10) {
    accuracyPremium = 0.5; // cold-start neutral
  } else {
    accuracyPremium = Math.max(0.3, context.bidAccuracy.accuracy_ema);
    // Penalty multiplier if active
    if (context.bidAccuracy.penalty_active) {
      accuracyPremium *= 0.5;
    }
  }

  // Remote bidders get a trust penalty (A5: prefer local evidence)
  const remotePenalty = bid.bidderType === 'remote' ? 0.9 : 1.0;

  return trust ** 2 * capability ** 2 * costEfficiency ** 0.5 * accuracyPremium * remotePenalty;
}

/**
 * Run a Vickrey auction: score all bids, select winner, compute budget cap.
 */
export function runAuction(
  auctionId: string,
  taskId: string,
  bids: EngineBid[],
  contexts: Map<string, BidderContext>,
  taskBudgetTokens: number,
  phase: MarketPhase,
): AuctionResult | null {
  if (bids.length === 0) return null;

  // Score and sort
  const scored: ScoredBid[] = bids
    .map((bid) => {
      const ctx = contexts.get(bid.bidderId) ?? { successes: 0, failures: 0, capabilityScore: 0.5, bidAccuracy: null };
      return { bid, score: scoreBid(bid, ctx, taskBudgetTokens) };
    })
    .sort((a, b) => b.score - a.score);

  const winner = scored[0]!;
  const second = scored.length >= 2 ? scored[1]! : null;

  // Vickrey budget cap: bound by second-price estimate
  let budgetCap: number | null = null;
  if (second) {
    const winnerTokens = winner.bid.estimatedTokensInput + winner.bid.estimatedTokensOutput;
    const secondTokens = second.bid.estimatedTokensInput + second.bid.estimatedTokensOutput;
    budgetCap = Math.max(winnerTokens, Math.ceil(secondTokens * 1.1));
  }

  return {
    auctionId,
    taskId,
    winnerId: winner.bid.bidderId,
    winnerScore: winner.score,
    secondScore: second?.score ?? null,
    budgetCap,
    bidderCount: bids.length,
    phase,
    completedAt: Date.now(),
  };
}
