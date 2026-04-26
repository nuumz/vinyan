import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { CostLedger, type CostLedgerEntry } from '../../src/economy/cost-ledger.ts';
import { migration001 } from '../../src/db/migrations/001_initial_schema.ts';

function createLedger(): { ledger: CostLedger; db: Database } {
  const db = new Database(':memory:');
  migration001.up(db);
  const ledger = new CostLedger(db);
  return { ledger, db };
}

function makeEntry(overrides?: Partial<CostLedgerEntry>): CostLedgerEntry {
  return {
    id: `task-${Math.random().toString(36).slice(2)}:${Date.now()}`,
    taskId: 'task-1',
    workerId: 'worker-1',
    engineId: 'claude-sonnet',
    timestamp: Date.now(),
    tokens_input: 1000,
    tokens_output: 500,
    cache_read_tokens: 0,
    cache_creation_tokens: 0,
    duration_ms: 5000,
    oracle_invocations: 3,
    computed_usd: 0.0105,
    cost_tier: 'billing',
    routing_level: 2,
    task_type_signature: 'refactor:ts:small',
    ...overrides,
  };
}

describe('CostLedger', () => {
  test('record and count', () => {
    const { ledger } = createLedger();
    expect(ledger.count()).toBe(0);
    ledger.record(makeEntry());
    expect(ledger.count()).toBe(1);
    ledger.record(makeEntry({ id: 'task-2:123' }));
    expect(ledger.count()).toBe(2);
  });

  test('queryByTask returns matching entries', () => {
    const { ledger } = createLedger();
    ledger.record(makeEntry({ taskId: 'task-A' }));
    ledger.record(makeEntry({ id: 'x:1', taskId: 'task-B' }));
    ledger.record(makeEntry({ id: 'x:2', taskId: 'task-A' }));

    const results = ledger.queryByTask('task-A');
    expect(results.length).toBe(2);
    expect(results.every((r) => r.taskId === 'task-A')).toBe(true);
  });

  test('queryByEngine returns matching entries', () => {
    const { ledger } = createLedger();
    ledger.record(makeEntry({ engineId: 'claude-opus' }));
    ledger.record(makeEntry({ id: 'x:1', engineId: 'claude-haiku' }));

    const results = ledger.queryByEngine('claude-opus');
    expect(results.length).toBe(1);
    expect(results[0]!.engineId).toBe('claude-opus');
  });

  test('queryByTimeRange filters correctly', () => {
    const { ledger } = createLedger();
    const now = Date.now();
    ledger.record(makeEntry({ timestamp: now - 5000 }));
    ledger.record(makeEntry({ id: 'x:1', timestamp: now - 1000 }));
    ledger.record(makeEntry({ id: 'x:2', timestamp: now + 5000 }));

    const results = ledger.queryByTimeRange(now - 3000, now);
    expect(results.length).toBe(1);
  });

  test('getAggregatedCost sums USD for current hour', () => {
    const { ledger } = createLedger();
    const now = Date.now();
    ledger.record(makeEntry({ timestamp: now, computed_usd: 0.5 }));
    ledger.record(makeEntry({ id: 'x:1', timestamp: now, computed_usd: 0.3 }));

    const agg = ledger.getAggregatedCost('hour');
    expect(agg.total_usd).toBeCloseTo(0.8, 5);
    expect(agg.count).toBe(2);
  });

  test('persists to SQLite', () => {
    const { db } = createLedger();
    // Create a fresh ledger over same DB to verify persistence
    const ledger1 = new CostLedger(db);
    ledger1.record(makeEntry({ id: 'persist-test:1', computed_usd: 1.23 }));

    // New ledger should warm cache from SQLite
    const ledger2 = new CostLedger(db);
    expect(ledger2.count()).toBe(1);
    const entries = ledger2.queryByTask('task-1');
    expect(entries[0]!.computed_usd).toBeCloseTo(1.23, 5);
  });

  test('getTokenPercentile returns null with insufficient data', () => {
    const { ledger } = createLedger();
    expect(ledger.getTokenPercentile('refactor:ts:small', 2, 0.75)).toBeNull();
  });

  test('getTokenPercentile computes correctly', () => {
    const { ledger } = createLedger();
    // Insert 10 entries with varying token counts
    for (let i = 0; i < 10; i++) {
      ledger.record(
        makeEntry({
          id: `p-${i}:1`,
          tokens_input: (i + 1) * 100,
          tokens_output: (i + 1) * 50,
          task_type_signature: 'test:ts:small',
          routing_level: 2,
        }),
      );
    }
    // p75 should be around the 7th-8th value
    const p75 = ledger.getTokenPercentile('test:ts:small', 2, 0.75);
    expect(p75).not.toBeNull();
    expect(p75!).toBeGreaterThan(0);
  });
});
