/**
 * Cost Ledger A9 fail-open contract test (T3 slice).
 *
 * Contract: when the SQLite INSERT throws, `CostLedger.record()` MUST NOT
 * propagate the failure. The in-memory cache is authoritative, so
 * `queryByTimeRange()` and aggregate queries continue to work.
 *
 * Companion contract doc: docs/design/a9-degradation-contract.md (row #3).
 */
import { Database } from 'bun:sqlite';
import { migration001 } from '../../src/db/migrations/001_initial_schema.ts';
import { describe, expect, test } from 'bun:test';
import { CostLedger, type CostLedgerEntry } from '../../src/economy/cost-ledger.ts';

function makeEntry(overrides?: Partial<CostLedgerEntry>): CostLedgerEntry {
  return {
    id: `t-${Math.random().toString(36).slice(2)}:${Date.now()}`,
    taskId: 'task-1',
    workerId: null,
    engineId: 'mock-engine',
    timestamp: Date.now(),
    tokens_input: 100,
    tokens_output: 50,
    cache_read_tokens: 0,
    cache_creation_tokens: 0,
    duration_ms: 1000,
    oracle_invocations: 0,
    computed_usd: 0.001,
    cost_tier: 'estimated',
    routing_level: 1,
    task_type_signature: null,
    ...overrides,
  };
}

describe('CostLedger A9 fail-open contract', () => {
  test('record() absorbs SQLite INSERT failure and keeps the cache authoritative', () => {
    // Intentionally skip migration001 — `cost_ledger` table is missing, so
    // every INSERT throws "no such table: cost_ledger". This faithfully
    // simulates the disk-full / SQLITE_BUSY / corrupted-DB class of failure
    // for which row #3 of the A9 contract is fail-open.
    const db = new Database(':memory:');
    const ledger = new CostLedger(db);

    const entry = makeEntry({ id: 'fail-open-1', computed_usd: 0.42 });

    // Contract: must not throw.
    expect(() => ledger.record(entry)).not.toThrow();

    // Contract: cache stays authoritative — query path keeps working.
    const window = ledger.queryByTimeRange(entry.timestamp - 10, entry.timestamp + 10);
    expect(window).toHaveLength(1);
    expect(window[0]!.id).toBe('fail-open-1');
    expect(window[0]!.computed_usd).toBeCloseTo(0.42, 5);

    // Contract: subsequent records continue to work; failure is per-call,
    // not a permanent latch.
    const second = makeEntry({ id: 'fail-open-2', computed_usd: 0.5 });
    expect(() => ledger.record(second)).not.toThrow();

    const both = ledger.queryByTimeRange(entry.timestamp - 10, second.timestamp + 10);
    expect(both.map((e) => e.id).sort()).toEqual(['fail-open-1', 'fail-open-2']);
  });

  test('record() fault-injection: emits economy:accounting_failed when bus is wired (A9 T3.b)', async () => {
    const { createBus } = await import('../../src/core/bus.ts');
    const bus = createBus();
    const events: Array<{ taskId?: string; reason: string }> = [];
    bus.on('economy:accounting_failed', (e) => events.push(e));

    // Same fault-injection: missing table → INSERT throws.
    const db = new Database(':memory:');
    const ledger = new CostLedger(db, bus);

    const entry = makeEntry({ id: 'fault-injection-1', taskId: 'task-fi' });
    expect(() => ledger.record(entry)).not.toThrow();

    // User-visible flow remains unblocked: cache query still works.
    expect(ledger.queryByTask('task-fi')).toHaveLength(1);
    // Fail-open observability: accounting failure is surfaced for the
    // degradation bridge to normalize, but the task itself is not blocked.
    expect(events).toHaveLength(1);
    expect(events[0]?.taskId).toBe('task-fi');
    expect(events[0]?.reason.length).toBeGreaterThan(0);
  });
});
