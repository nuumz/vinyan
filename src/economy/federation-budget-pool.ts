/**
 * Federation Budget Pool — shared budget pools across instances.
 *
 * Each instance contributes a fraction of its budget to a shared pool.
 * Tracked locally per-instance (no global coordinator — A3 determinism).
 * Pool exhaustion → reject incoming delegation requests.
 *
 * Source of truth: Economy OS plan §E4
 */
import type { VinyanBus } from '../core/bus.ts';

export interface PoolStatus {
  total_contributed_usd: number;
  total_consumed_usd: number;
  remaining_usd: number;
  exhausted: boolean;
}

export class FederationBudgetPool {
  private contributed = 0;
  private consumed = 0;
  private fraction: number;
  private bus: VinyanBus | undefined;

  /**
   * @param fraction — fraction of local budget contributed (0-1, default 0.1)
   */
  constructor(fraction = 0.1, bus?: VinyanBus) {
    this.fraction = fraction;
    this.bus = bus;
  }

  /** Contribute from a local task's cost. Called after each local task completion. */
  contribute(taskCostUsd: number): void {
    this.contributed += taskCostUsd * this.fraction;
  }

  /** Consume from pool for a delegated task. Returns false if pool exhausted. */
  consume(delegationCostUsd: number): boolean {
    const remaining = this.contributed - this.consumed;
    if (delegationCostUsd > remaining) {
      return false;
    }
    this.consumed += delegationCostUsd;
    return true;
  }

  /** Check current pool status. */
  getStatus(): PoolStatus {
    const remaining = Math.max(0, this.contributed - this.consumed);
    return {
      total_contributed_usd: this.contributed,
      total_consumed_usd: this.consumed,
      remaining_usd: remaining,
      exhausted: remaining <= 0 && this.contributed > 0,
    };
  }

  /** Check if delegation is affordable. */
  canAfford(estimatedCostUsd: number): boolean {
    return this.contributed - this.consumed >= estimatedCostUsd;
  }
}
