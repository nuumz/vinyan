import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { migration001 } from '../../src/db/migrations/001_initial_schema.ts';
import { CostLedger, type CostLedgerEntry } from '../../src/economy/cost-ledger.ts';
import { DynamicBudgetAllocator } from '../../src/economy/dynamic-budget-allocator.ts';

function createEnv() {
  const db = new Database(':memory:');
  migration001.up(db);
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

  test('never shrinks a budget below the caller fallback on zero-token history', () => {
    const { ledger, allocator } = createEnv();

    // The shape a no-LLM phase used to write: a ledger row with zero tokens.
    for (let i = 0; i < 8; i++) {
      ledger.record(
        makeEntry({
          id: `zero-${i}:1`,
          tokens_input: 0,
          tokens_output: 0,
          task_type_signature: 'zero:ts:task',
          routing_level: 2,
        }),
      );
    }

    const alloc = allocator.allocate('zero:ts:task', 2, 50_000);
    expect(alloc.maxTokens).toBe(50_000);
    // Zero-token rows are not evidence, so they never reach the percentile.
    expect(alloc.source).toBe('default');
  });

  test('never shrinks a budget below the caller fallback on small-but-real history', () => {
    const { ledger, allocator } = createEnv();

    // Real but cheap tasks: 8K tokens each. p75*1.25 = 10K, far below the
    // 50K L2 fallback — the old 50% floor handed the next task 25K.
    for (let i = 0; i < 8; i++) {
      ledger.record(
        makeEntry({
          id: `small-${i}:1`,
          tokens_input: 6_000,
          tokens_output: 2_000,
          task_type_signature: 'small:ts:task',
          routing_level: 2,
        }),
      );
    }

    const alloc = allocator.allocate('small:ts:task', 2, 50_000);
    expect(alloc.maxTokens).toBeGreaterThanOrEqual(50_000);
  });

  test('still grows the budget when history exceeds the fallback', () => {
    const { ledger, allocator } = createEnv();

    // 60K tokens per task → p75*1.25 = 75K, above the 50K fallback and below
    // the 100K ceiling. The no-shrink floor must not disable growth.
    for (let i = 0; i < 8; i++) {
      ledger.record(
        makeEntry({
          id: `grow-${i}:1`,
          tokens_input: 40_000,
          tokens_output: 20_000,
          task_type_signature: 'grow:ts:task',
          routing_level: 2,
        }),
      );
    }

    const alloc = allocator.allocate('grow:ts:task', 2, 50_000);
    expect(alloc.maxTokens).toBeGreaterThan(50_000);
    expect(alloc.maxTokens).toBeLessThanOrEqual(100_000);
    expect(alloc.source).not.toBe('default');
  });

  test('accepts custom default budget override', () => {
    const { allocator } = createEnv();
    const alloc = allocator.allocate(null, 2, 75_000);
    expect(alloc.maxTokens).toBe(75_000);
  });
});
