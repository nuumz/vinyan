/**
 * Dynamic Budget Allocator — adaptive task budgets from historical cost data.
 *
 * Instead of fixed per-level budgets (LEVEL_CONFIG), allocates tokens based on
 * historical percentiles for the task type. Falls back to defaults when
 * insufficient data.
 *
 * A3 compliant: deterministic percentile computation, no LLM.
 *
 * Source of truth: Economy OS plan §E2.3
 */
import type { CostLedger } from './cost-ledger.ts';

/** Default token budgets per routing level (from LEVEL_CONFIG in risk-router.ts). */
const DEFAULT_BUDGETS: Record<number, number> = {
  0: 0,
  1: 10_000,
  2: 50_000,
  3: 100_000,
};

export interface TaskBudgetAllocation {
  maxTokens: number;
  source: 'default' | 'historical-p75' | 'historical-p95';
}

export class DynamicBudgetAllocator {
  private ledger: CostLedger;

  constructor(ledger: CostLedger) {
    this.ledger = ledger;
  }

  /**
   * Allocate budget for a task based on historical cost data.
   *
   * @param taskTypeSignature — task type (e.g. 'refactor:ts:medium')
   * @param routingLevel — routing level (0-3)
   * @param defaultBudget — fallback from LEVEL_CONFIG (optional override)
   */
  allocate(taskTypeSignature: string | null, routingLevel: number, defaultBudget?: number): TaskBudgetAllocation {
    const fallback = defaultBudget ?? DEFAULT_BUDGETS[routingLevel] ?? DEFAULT_BUDGETS[2]!;

    if (!taskTypeSignature) {
      return { maxTokens: fallback, source: 'default' };
    }

    // Try p75 with 25% headroom (tight but efficient)
    const p75 = this.ledger.getTokenPercentile(taskTypeSignature, routingLevel, 0.75);
    if (p75 !== null) {
      const withHeadroom = Math.ceil(p75 * 1.25);
      const clamped = this.clamp(withHeadroom, fallback);
      return { maxTokens: clamped, source: 'historical-p75' };
    }

    // Try p95 (conservative ceiling) — needs fewer observations (5 vs implicit 20 from p75)
    const p95 = this.ledger.getTokenPercentile(taskTypeSignature, routingLevel, 0.95);
    if (p95 !== null) {
      const clamped = this.clamp(p95, fallback);
      return { maxTokens: clamped, source: 'historical-p95' };
    }

    return { maxTokens: fallback, source: 'default' };
  }

  /**
   * Clamp a historical estimate into the allowed band.
   *
   * The floor is the caller's own fallback, NOT half of it. Allocation may
   * grow toward the 2x ceiling when history says a task type needs more, but
   * it must never hand a task less budget than the routing level asked for.
   * A silent shrink is invisible at the call site — it surfaces to a user as
   * "the model got worse", announced only by an `economy:budget_allocated`
   * event nobody reads — and this component now runs on every task by
   * default. Growth-only keeps the adaptive value without that failure mode.
   */
  private clamp(estimate: number, fallback: number): number {
    return Math.max(fallback, Math.min(estimate, fallback * 2));
  }
}
