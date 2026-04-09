/**
 * Market Schemas — Zod schemas and TypeScript interfaces for the market mechanism.
 *
 * Source of truth: Economy OS plan §E3
 */
import { z } from 'zod/v4';

// ── Bid ─────────────────────────────────────────────────────────────

export const EngineBidSchema = z.object({
  bidId: z.string(),
  auctionId: z.string(),
  bidderId: z.string(),
  bidderType: z.enum(['local', 'remote']),
  estimatedTokensInput: z.number().min(0).default(0),
  estimatedTokensOutput: z.number().min(0),
  estimatedDurationMs: z.number().min(0),
  estimatedUsd: z.number().min(0).optional(),
  declaredConfidence: z.number().min(0).max(1),
  acceptsTokenBudget: z.number().min(0),
  acceptsTimeLimitMs: z.number().min(0),
  submittedAt: z.number(),
  expiresAt: z.number().optional(),
});

export type EngineBid = z.infer<typeof EngineBidSchema>;

// ── Auction Result ──────────────────────────────────────────────────

export interface AuctionResult {
  auctionId: string;
  taskId: string;
  winnerId: string;
  winnerScore: number;
  secondScore: number | null;
  budgetCap: number | null;
  bidderCount: number;
  phase: MarketPhase;
  completedAt: number;
}

// ── Settlement ──────────────────────────────────────────────────────

export interface Settlement {
  settlementId: string;
  bidId: string;
  engineId: string;
  taskId: string;
  bid_usd: number;
  actual_usd: number;
  bid_duration_ms: number;
  actual_duration_ms: number;
  cost_accuracy: number;
  duration_accuracy: number;
  composite_accuracy: number;
  penalty_type: string | null;
  timestamp: number;
}

// ── Bid Accuracy ────────────────────────────────────────────────────

export interface BidAccuracyRecord {
  bidderId: string;
  accuracy_ema: number;
  total_settled_bids: number;
  underbid_violations: number;
  overclaim_violations: number;
  free_ride_violations: number;
  penalty_active: boolean;
  penalty_auctions_remaining: number;
  last_settled_at: number;
}

// ── Market Phase ────────────────────────────────────────────────────

export type MarketPhase = 'A' | 'B' | 'C' | 'D';

export interface MarketPhaseState {
  currentPhase: MarketPhase;
  activatedAt: number;
  auctionCount: number;
  lastEvaluatedAt: number;
}
