import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { migration012 } from '../../src/db/migrations/012_add_economy_tables.ts';
import { CostLedger, type CostLedgerEntry } from '../../src/economy/cost-ledger.ts';
import { DynamicBudgetAllocator } from '../../src/economy/dynamic-budget-allocator.ts';

function createEnv() {
  const db = new Database(':memory:');
  migration012.up(db);
  const ledger = new CostLedger(db);
  const allocator = new DynamicBudgetAllocator(ledger);
  return { ledger, allocator };
}

function makeEntry(overrides?: Partial<CostLedgerEntry>): CostLedgerEntry {
  return {
    id: `t-${Math.random().toString(36).slice(2)}:${Date.now()}`,
    taskId: 'task-1',
    workerId: null,
    engineId: 'claude-sonnet',
    timestamp: Date.now(),
    tokens_input: 5000,
    tokens_output: 2000,
    cache_read_tokens: 0,
    cache_creation_tokens: 0,
    duration_ms: 5000,
    oracle_invocations: 0,
    computed_usd: 0.075,
    cost_tier: 'billing',
    routing_level: 2,
    task_type_signature: 'refactor:ts:small',
    ...overrides,
  };
}

describe('DynamicBudgetAllocator', () => {
  test('returns default when no task type', () => {
    const { allocator } = createEnv();
    const alloc = allocator.allocate(null, 2);
    expect(alloc.maxTokens).toBe(50_000); // L2 default
    expect(alloc.source).toBe('default');
  });

  test('returns default when insufficient data', () => {
    const { allocator } = createEnv();
    const alloc = allocator.allocate('refactor:ts:small', 2);
    expect(alloc.maxTokens).toBe(50_000);
    expect(alloc.source).toBe('default');
  });

  test('uses historical percentile when enough data', () => {
    const { ledger, allocator } = createEnv();

    // Add 10 entries with varying token counts (enough for p95 but not p75 which needs more spread)
    for (let i = 0; i < 10; i++) {
      ledger.record(
        makeEntry({
          id: `h-${i}:1`,
          tokens_input: 3000 + i * 500,
          tokens_output: 1000 + i * 200,
          task_type_signature: 'test:ts:hist',
          routing_level: 2,
        }),
      );
    }

    const alloc = allocator.allocate('test:ts:hist', 2);
    // Should use historical data (p75 or p95)
    expect(alloc.source).not.toBe('default');
    expect(alloc.maxTokens).toBeGreaterThan(0);
  });

  test('respects default budget for each routing level', () => {
    const { allocator } = createEnv();

    expect(allocator.allocate(null, 0).maxTokens).toBe(0);
    expect(allocator.allocate(null, 1).maxTokens).toBe(10_000);
    expect(allocator.allocate(null, 2).maxTokens).toBe(50_000);
    expect(allocator.allocate(null, 3).maxTokens).toBe(100_000);
  });

  test('clamps allocation to 50%-200% of default', () => {
    const { ledger, allocator } = createEnv();

    // Add entries with very large token counts
    for (let i = 0; i < 10; i++) {
      ledger.record(
        makeEntry({
          id: `big-${i}:1`,
          tokens_input: 500_000,
          tokens_output: 500_000,
          task_type_signature: 'huge:ts:task',
          routing_level: 2,
        }),
      );
    }

    const alloc = allocator.allocate('huge:ts:task', 2);
    // L2 default is 50K, max allowed is 200% = 100K
    expect(alloc.maxTokens).toBeLessThanOrEqual(100_000);
  });

  test('accepts custom default budget override', () => {
    const { allocator } = createEnv();
    const alloc = allocator.allocate(null, 2, 75_000);
    expect(alloc.maxTokens).toBe(75_000);
  });
});
