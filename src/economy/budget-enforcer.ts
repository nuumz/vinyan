/**
 * Budget Enforcer — global hourly/daily/monthly budget caps with enforcement.
 *
 * A3 compliant: all decisions are deterministic threshold comparisons.
 * No LLM in the decision path.
 *
 * Source of truth: Economy OS plan §E1.5
 */
import type { VinyanBus } from '../core/bus.ts';
import type { CostLedger } from './cost-ledger.ts';
import type { BudgetConfig } from './economy-config.ts';

type BudgetWindow = 'hour' | 'day' | 'month';

export interface BudgetStatus {
  window: BudgetWindow;
  spent_usd: number;
  limit_usd: number;
  utilization_pct: number;
  enforcement: 'warn' | 'block' | 'degrade';
  exceeded: boolean;
}

export interface BudgetCheckResult {
  allowed: boolean;
  statuses: BudgetStatus[];
  /** When enforcement=degrade and exceeded, reduce to this level. */
  degradeToLevel?: number;
}

/** Warning threshold: emit warning when utilization crosses this. */
const WARNING_THRESHOLD = 0.8;

export class BudgetEnforcer {
  private config: BudgetConfig;
  private ledger: CostLedger;
  private bus: VinyanBus | undefined;

  constructor(config: BudgetConfig, ledger: CostLedger, bus?: VinyanBus) {
    this.config = config;
    this.ledger = ledger;
    this.bus = bus;
  }

  /** Check all configured budget windows. */
  checkBudget(): BudgetStatus[] {
    const statuses: BudgetStatus[] = [];

    const windows: Array<{ window: BudgetWindow; limit: number | undefined }> = [
      { window: 'hour', limit: this.config.hourly_usd },
      { window: 'day', limit: this.config.daily_usd },
      { window: 'month', limit: this.config.monthly_usd },
    ];

    for (const { window, limit } of windows) {
      if (limit === undefined) continue;

      const agg = this.ledger.getAggregatedCost(window);
      const utilization = agg.total_usd / limit;
      const exceeded = agg.total_usd >= limit;

      statuses.push({
        window,
        spent_usd: agg.total_usd,
        limit_usd: limit,
        utilization_pct: utilization * 100,
        enforcement: this.config.enforcement,
        exceeded,
      });
    }

    return statuses;
  }

  /** Check if a new task can proceed given budget constraints. */
  canProceed(): BudgetCheckResult {
    const statuses = this.checkBudget();
    const exceededStatuses = statuses.filter((s) => s.exceeded);

    // Emit warnings for high utilization
    for (const status of statuses) {
      if (status.utilization_pct >= WARNING_THRESHOLD * 100 && !status.exceeded) {
        this.bus?.emit('economy:budget_warning', {
          window: status.window,
          utilization_pct: status.utilization_pct,
          spent_usd: status.spent_usd,
          limit_usd: status.limit_usd,
        });
      }
    }

    if (exceededStatuses.length === 0) {
      return { allowed: true, statuses };
    }

    // At least one window exceeded
    const enforcement = this.config.enforcement;

    for (const status of exceededStatuses) {
      this.bus?.emit('economy:budget_exceeded', {
        window: status.window,
        spent_usd: status.spent_usd,
        limit_usd: status.limit_usd,
        enforcement,
      });
    }

    switch (enforcement) {
      case 'warn':
        return { allowed: true, statuses };

      case 'block':
        return { allowed: false, statuses };

      case 'degrade':
        // Degrade: force L1 (cheapest LLM level) to minimize cost
        return { allowed: true, statuses, degradeToLevel: 1 };
    }
  }

  /** Persist budget snapshot for historical tracking. */
  snapshotBudgets(db: import('bun:sqlite').Database): void {
    const statuses = this.checkBudget();
    const now = Date.now();

    for (const status of statuses) {
      const periodKey = this.getPeriodKey(status.window, now);
      try {
        db.run(
          `INSERT INTO budget_snapshots (id, window, period_key, spent_usd, limit_usd, timestamp)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             spent_usd = excluded.spent_usd,
             timestamp = excluded.timestamp`,
          [`${status.window}:${periodKey}`, status.window, periodKey, status.spent_usd, status.limit_usd, now],
        );
      } catch {
        // Non-fatal
      }
    }
  }

  private getPeriodKey(window: BudgetWindow, now: number): string {
    const d = new Date(now);
    switch (window) {
      case 'hour':
        return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}T${String(d.getUTCHours()).padStart(2, '0')}`;
      case 'day':
        return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
      case 'month':
        return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
    }
  }
}
