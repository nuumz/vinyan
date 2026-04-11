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
      // Don't allocate less than 50% or more than 200% of the default
      const clamped = Math.max(Math.floor(fallback * 0.5), Math.min(withHeadroom, fallback * 2));
      return { maxTokens: clamped, source: 'historical-p75' };
    }

    // Try p95 (conservative ceiling) — needs fewer observations (5 vs implicit 20 from p75)
    const p95 = this.ledger.getTokenPercentile(taskTypeSignature, routingLevel, 0.95);
    if (p95 !== null) {
      const clamped = Math.max(Math.floor(fallback * 0.5), Math.min(p95, fallback * 2));
      return { maxTokens: clamped, source: 'historical-p95' };
    }

    return { maxTokens: fallback, source: 'default' };
  }
}
