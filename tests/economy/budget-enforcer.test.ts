import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { migration012 } from '../../src/db/migrations/012_add_economy_tables.ts';
import { BudgetEnforcer } from '../../src/economy/budget-enforcer.ts';
import { CostLedger, type CostLedgerEntry } from '../../src/economy/cost-ledger.ts';
import type { BudgetConfig } from '../../src/economy/economy-config.ts';

function createTestEnv(budgetConfig: Partial<BudgetConfig> = {}) {
  const db = new Database(':memory:');
  migration012.up(db);
  const ledger = new CostLedger(db);
  const config: BudgetConfig = {
    enforcement: 'warn',
    ...budgetConfig,
  };
  const events: Array<{ event: string; payload: unknown }> = [];
  const bus = {
    emit: (event: string, payload: unknown) => {
      events.push({ event, payload });
    },
  } as any;
  const enforcer = new BudgetEnforcer(config, ledger, bus);
  return { ledger, enforcer, events, db };
}

function makeEntry(overrides?: Partial<CostLedgerEntry>): CostLedgerEntry {
  return {
    id: `t-${Math.random().toString(36).slice(2)}:${Date.now()}`,
    taskId: 'task-1',
    workerId: null,
    engineId: 'claude-sonnet',
    timestamp: Date.now(),
    tokens_input: 1000,
    tokens_output: 500,
    cache_read_tokens: 0,
    cache_creation_tokens: 0,
    duration_ms: 5000,
    oracle_invocations: 0,
    computed_usd: 1.0,
    cost_tier: 'billing',
    routing_level: 2,
    task_type_signature: null,
    ...overrides,
  };
}

describe('BudgetEnforcer', () => {
  test('returns empty statuses when no budgets configured', () => {
    const { enforcer } = createTestEnv({});
    const statuses = enforcer.checkBudget();
    expect(statuses).toHaveLength(0);
  });

  test('checkBudget tracks hourly spend', () => {
    const { ledger, enforcer } = createTestEnv({ hourly_usd: 10.0 });
    ledger.record(makeEntry({ computed_usd: 3.0 }));
    ledger.record(makeEntry({ id: 'x:1', computed_usd: 2.0 }));

    const statuses = enforcer.checkBudget();
    expect(statuses).toHaveLength(1);
    expect(statuses[0]!.window).toBe('hour');
    expect(statuses[0]!.spent_usd).toBeCloseTo(5.0, 5);
    expect(statuses[0]!.limit_usd).toBe(10.0);
    expect(statuses[0]!.exceeded).toBe(false);
    expect(statuses[0]!.utilization_pct).toBeCloseTo(50, 1);
  });

  test('canProceed allows when under budget', () => {
    const { ledger, enforcer } = createTestEnv({ hourly_usd: 100.0, enforcement: 'block' });
    ledger.record(makeEntry({ computed_usd: 10.0 }));

    const result = enforcer.canProceed();
    expect(result.allowed).toBe(true);
  });

  test('canProceed blocks when budget exceeded with enforcement=block', () => {
    const { ledger, enforcer } = createTestEnv({ hourly_usd: 5.0, enforcement: 'block' });
    ledger.record(makeEntry({ computed_usd: 6.0 }));

    const result = enforcer.canProceed();
    expect(result.allowed).toBe(false);
    expect(result.statuses[0]!.exceeded).toBe(true);
  });

  test('canProceed warns but allows when enforcement=warn', () => {
    const { ledger, enforcer } = createTestEnv({ hourly_usd: 5.0, enforcement: 'warn' });
    ledger.record(makeEntry({ computed_usd: 6.0 }));

    const result = enforcer.canProceed();
    expect(result.allowed).toBe(true);
  });

  test('canProceed degrades when enforcement=degrade', () => {
    const { ledger, enforcer } = createTestEnv({ hourly_usd: 5.0, enforcement: 'degrade' });
    ledger.record(makeEntry({ computed_usd: 6.0 }));

    const result = enforcer.canProceed();
    expect(result.allowed).toBe(true);
    expect(result.degradeToLevel).toBe(1);
  });

  test('emits budget_exceeded event', () => {
    const { ledger, enforcer, events } = createTestEnv({ hourly_usd: 5.0, enforcement: 'block' });
    ledger.record(makeEntry({ computed_usd: 6.0 }));

    enforcer.canProceed();
    const exceeded = events.filter((e) => e.event === 'economy:budget_exceeded');
    expect(exceeded).toHaveLength(1);
  });

  test('emits budget_warning at 80%+ utilization', () => {
    const { ledger, enforcer, events } = createTestEnv({ hourly_usd: 10.0, enforcement: 'warn' });
    ledger.record(makeEntry({ computed_usd: 8.5 }));

    enforcer.canProceed();
    const warnings = events.filter((e) => e.event === 'economy:budget_warning');
    expect(warnings).toHaveLength(1);
  });

  test('supports multiple budget windows', () => {
    const { ledger, enforcer } = createTestEnv({
      hourly_usd: 100.0,
      daily_usd: 500.0,
      monthly_usd: 10000.0,
    });
    ledger.record(makeEntry({ computed_usd: 50.0 }));

    const statuses = enforcer.checkBudget();
    expect(statuses).toHaveLength(3);
    const windows = statuses.map((s) => s.window);
    expect(windows).toContain('hour');
    expect(windows).toContain('day');
    expect(windows).toContain('month');
  });

  test('snapshotBudgets persists to SQLite', () => {
    const { ledger, enforcer, db } = createTestEnv({ hourly_usd: 100.0 });
    ledger.record(makeEntry({ computed_usd: 25.0 }));

    enforcer.snapshotBudgets(db);

    const rows = db.prepare('SELECT * FROM budget_snapshots').all() as any[];
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows[0].window).toBe('hour');
    expect(rows[0].spent_usd).toBeCloseTo(25.0, 5);
  });
});
