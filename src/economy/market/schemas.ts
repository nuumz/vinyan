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
  /**
   * Trust-accumulation key. Stays provider-keyed (e.g. 'anthropic-sonnet-4')
   * to preserve cardinality bounds — a (provider, persona, skill-set) tuple
   * would explode the trust table and starve the Wilson-LB pools that the
   * scorer depends on. Persona attribution lives on `personaId` and
   * per-(persona, skill, taskSig) outcomes live in `skill_outcome_store`.
   */
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
  // ── Phase 3 — persona-aware bidding (all optional for backward compat) ────
  /** Persona this bid represents (e.g. 'developer'). Optional for legacy bids. */
  personaId: z.string().optional(),
  /** Skill ids loaded for this bid (base + bound). Used by `skill_outcome_store`. */
  loadedSkillIds: z.array(z.string()).optional(),
  /** Capability ids the persona+skill loadout claims to fulfill. Drives skillMatch. */
  declaredCapabilityIds: z.array(z.string()).optional(),
  /**
   * sha256 hex of sorted `loadedSkillIds`. Lets the auction record outcomes
   * against the exact skill loadout that won, so a future re-run can correlate
   * outcome quality with skill set rather than persona alone (A4 + A8).
   */
  skillFingerprint: z.string().optional(),
  /**
   * Tokens consumed by skill cards in the system prompt. Folded into the
   * Vickrey budget cap so the winner is funded for the prompt overhead its
   * skill loadout introduces (risk L4 mitigation).
   */
  skillTokenOverhead: z.number().min(0).optional(),
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
