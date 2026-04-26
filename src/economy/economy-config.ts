/**
 * Economy Config — Zod schemas for cost tracking, budgets, market, federation.
 *
 * All fields optional with sensible defaults.
 * economy.enabled = false (default) means all economy code is inert.
 *
 * Source of truth: Economy OS plan §E1.1
 */
import { z } from 'zod/v4';

// ── Rate Card Schema ────────────────────────────────────────────────

const RateCardEntrySchema = z.object({
  input_per_mtok: z.number().positive(),
  output_per_mtok: z.number().positive(),
  cache_read_per_mtok: z.number().nonnegative().default(0),
  cache_create_per_mtok: z.number().nonnegative().default(0),
});

export type RateCardEntry = z.infer<typeof RateCardEntrySchema>;

// ── Budget Schema ───────────────────────────────────────────────────

const BudgetConfigSchema = z.object({
  hourly_usd: z.number().positive().optional(),
  daily_usd: z.number().positive().optional(),
  monthly_usd: z.number().positive().optional(),
  /** warn = log only, block = refuse task, degrade = reduce routing level */
  enforcement: z.enum(['warn', 'block', 'degrade']).default('warn'),
  /**
   * G6 cost-aware soft degrade: when true, BudgetEnforcer suggests reducing
   * the routing level **before** the cap is exceeded — at the 80% warning
   * threshold. Listeners that opt in see `softDegradeToLevel` in the
   * BudgetCheckResult and may downgrade non-critical phases (perceive,
   * comprehend) preemptively. The hard `degrade` enforcement on exceed is
   * unchanged.
   *
   * Optional so existing BudgetConfig literals across the codebase stay
   * valid without retro-fitting every test fixture. When loaded via Zod
   * the absence is treated as `false`.
   */
  degrade_on_warning: z.boolean().optional(),
  /** Routing level the soft degrade suggests. Default 1 (cheapest). */
  soft_degrade_level: z.number().int().min(0).max(3).optional(),
});

export type BudgetConfig = z.infer<typeof BudgetConfigSchema>;

// ── Market Schema ───────────────────────────────────────────────────

export const MarketConfigSchema = z.object({
  enabled: z.boolean().default(false),
  /** Minimum cost_ledger entries before market activates (data gate). */
  min_cost_records: z.number().positive().default(200),
  /** Bid time-to-live in ms. */
  bid_ttl_ms: z.number().positive().default(30_000),
  /** Minimum bidders for auction activation. */
  min_bidders: z.number().positive().default(2),
  /** Scoring weights for bid ranking. */
  weights: z
    .object({
      cost: z.number().min(0).max(1).default(0.3),
      quality: z.number().min(0).max(1).default(0.4),
      duration: z.number().min(0).max(1).default(0.1),
      accuracy: z.number().min(0).max(1).default(0.2),
    })
    .default({ cost: 0.3, quality: 0.4, duration: 0.1, accuracy: 0.2 }),
});

export type MarketConfig = z.infer<typeof MarketConfigSchema>;

// ── Federation Economy Schema ───────────────────────────────────────

export const FederationEconomyConfigSchema = z.object({
  cost_sharing_enabled: z.boolean().default(false),
  peer_pricing_enabled: z.boolean().default(false),
  /** Fraction of local budget contributed to shared pool (0-1). */
  shared_pool_fraction: z.number().min(0).max(1).default(0.1),
  /** Max negotiation rounds for peer pricing. */
  max_negotiation_rounds: z.number().positive().default(3),
});

export type FederationEconomyConfig = z.infer<typeof FederationEconomyConfigSchema>;

// ── Top-Level Economy Schema ────────────────────────────────────────

export const EconomyConfigSchema = z.object({
  enabled: z.boolean().default(false),
  /** Provider rate cards: model pattern → pricing. */
  rate_cards: z.record(z.string(), RateCardEntrySchema).default({}),
  /** Global budget caps. */
  budgets: BudgetConfigSchema.default({ enforcement: 'warn' }),
  /** Market mechanism config. */
  market: MarketConfigSchema.default({
    enabled: false,
    min_cost_records: 200,
    bid_ttl_ms: 30_000,
    min_bidders: 2,
    weights: { cost: 0.3, quality: 0.4, duration: 0.1, accuracy: 0.2 },
  }),
  /** Federation economy config. */
  federation: FederationEconomyConfigSchema.default({
    cost_sharing_enabled: false,
    peer_pricing_enabled: false,
    shared_pool_fraction: 0.1,
    max_negotiation_rounds: 3,
  }),
});

export type EconomyConfig = z.infer<typeof EconomyConfigSchema>;
