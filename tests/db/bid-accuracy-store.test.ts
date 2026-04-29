/**
 * Phase-15 (Item 2) — `BidAccuracyStore` SQLite persistence + tracker rehydration.
 *
 * Mirrors `tests/db/persona-overclaim-store.test.ts` shape. Covers:
 *   - bootstrap from inline schema builds the table
 *   - upsert round-trip + repeated upserts (no duplicate row)
 *   - listAll snapshots all rows ordered by bidder_id
 *   - tracker rehydrates EMA + violation counts from store on construction
 *   - writes flow tracker → store on every recordSettlement
 *   - A9: store throws on listAll → cold-start in memory; tracker still works
 *   - A9: store throws on upsertRecord → tracker doesn't propagate
 */
import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { BidAccuracyStore } from '../../src/db/bid-accuracy-store.ts';
import { BidAccuracyTracker } from '../../src/economy/market/bid-accuracy-tracker.ts';
import type { BidAccuracyRecord, Settlement } from '../../src/economy/market/schemas.ts';

function makeStore(): { store: BidAccuracyStore; db: Database } {
  const db = new Database(':memory:');
  // Inline schema mirrors `bid_accuracy` columns from migration 001.
  db.exec(`
    CREATE TABLE bid_accuracy (
      bidder_id                  TEXT PRIMARY KEY,
      accuracy_ema               REAL NOT NULL DEFAULT 0.5,
      total_settled_bids         INTEGER NOT NULL DEFAULT 0,
      underbid_violations        INTEGER NOT NULL DEFAULT 0,
      overclaim_violations       INTEGER NOT NULL DEFAULT 0,
      free_ride_violations       INTEGER NOT NULL DEFAULT 0,
      penalty_active             INTEGER NOT NULL DEFAULT 0,
      penalty_auctions_remaining INTEGER NOT NULL DEFAULT 0,
      last_settled_at            INTEGER NOT NULL DEFAULT 0
    );
  `);
  return { store: new BidAccuracyStore(db), db };
}

function makeRecord(opts: Partial<BidAccuracyRecord> = {}): BidAccuracyRecord {
  return {
    bidderId: 'anthropic-sonnet',
    accuracy_ema: 0.85,
    total_settled_bids: 25,
    underbid_violations: 1,
    overclaim_violations: 0,
    free_ride_violations: 0,
    penalty_active: false,
    penalty_auctions_remaining: 0,
    last_settled_at: 1000,
    ...opts,
  };
}

function makeSettlement(opts: Partial<Settlement> = {}): Settlement {
  return {
    settlementId: 'set-1',
    bidId: 'bid-1',
    engineId: 'anthropic-sonnet',
    taskId: 'task-1',
    bid_usd: 0.01,
    actual_usd: 0.012,
    bid_duration_ms: 1000,
    actual_duration_ms: 1100,
    cost_accuracy: 0.83,
    duration_accuracy: 0.91,
    composite_accuracy: 0.87,
    penalty_type: null,
    timestamp: 1000,
    ...opts,
  };
}

describe('BidAccuracyStore', () => {
  test('unknown bidder → getRecord null', () => {
    const { store } = makeStore();
    expect(store.getRecord('absent')).toBeNull();
  });

  test('upsertRecord → getRecord round-trip', () => {
    const { store } = makeStore();
    const rec = makeRecord();
    store.upsertRecord(rec);
    const out = store.getRecord('anthropic-sonnet');
    expect(out).toEqual(rec);
  });

  test('upsertRecord twice on same bidder updates fields (no duplicate row)', () => {
    const { store } = makeStore();
    store.upsertRecord(makeRecord({ accuracy_ema: 0.7 }));
    store.upsertRecord(makeRecord({ accuracy_ema: 0.85, total_settled_bids: 50 }));
    const all = store.listAll();
    expect(all).toHaveLength(1);
    expect(all[0]!.accuracy_ema).toBe(0.85);
    expect(all[0]!.total_settled_bids).toBe(50);
  });

  test('penalty_active boolean round-trips through INTEGER column', () => {
    const { store } = makeStore();
    store.upsertRecord(makeRecord({ penalty_active: true, penalty_auctions_remaining: 12 }));
    const out = store.getRecord('anthropic-sonnet');
    expect(out!.penalty_active).toBe(true);
    expect(out!.penalty_auctions_remaining).toBe(12);
  });

  test('listAll orders by bidder_id ASC', () => {
    const { store } = makeStore();
    store.upsertRecord(makeRecord({ bidderId: 'openrouter' }));
    store.upsertRecord(makeRecord({ bidderId: 'anthropic' }));
    store.upsertRecord(makeRecord({ bidderId: 'mistral' }));
    expect(store.listAll().map((r) => r.bidderId)).toEqual(['anthropic', 'mistral', 'openrouter']);
  });
});

describe('BidAccuracyTracker — restart-replay (Phase-15 Item 2)', () => {
  test('tracker rehydrates from store on construction', () => {
    const { store } = makeStore();
    store.upsertRecord(makeRecord({ accuracy_ema: 0.92, total_settled_bids: 30 }));

    const tracker = new BidAccuracyTracker(store);
    const r = tracker.getAccuracy('anthropic-sonnet');
    expect(r).not.toBeNull();
    expect(r!.accuracy_ema).toBe(0.92);
    expect(r!.total_settled_bids).toBe(30);
    // Past cold-start (≥10 settled), getAccuracyPremium uses real EMA.
    expect(tracker.getAccuracyPremium('anthropic-sonnet')).toBe(0.92);
  });

  test('writes flow through tracker → store on recordSettlement', () => {
    const { store } = makeStore();
    const tracker = new BidAccuracyTracker(store);
    tracker.recordSettlement(makeSettlement({ engineId: 'anthropic', composite_accuracy: 0.9 }));
    const persisted = store.getRecord('anthropic');
    expect(persisted).not.toBeNull();
    expect(persisted!.accuracy_ema).toBeCloseTo(0.9);
    expect(persisted!.total_settled_bids).toBe(1);
  });

  test('counters survive tracker re-instantiation against the same store', () => {
    const { store } = makeStore();
    const t1 = new BidAccuracyTracker(store);
    for (let i = 0; i < 12; i++) {
      t1.recordSettlement(makeSettlement({ settlementId: `s-${i}`, composite_accuracy: 0.9 }));
    }

    // Drop t1, simulate restart
    const t2 = new BidAccuracyTracker(store);
    const r = t2.getAccuracy('anthropic-sonnet');
    expect(r!.total_settled_bids).toBe(12);
    // Past cold-start floor (>= 10), the EMA flows through getAccuracyPremium.
    expect(t2.getAccuracyPremium('anthropic-sonnet')).toBeGreaterThan(0.5);
  });

  test('tracker without persistence still works (legacy / minimal setup)', () => {
    const tracker = new BidAccuracyTracker();
    tracker.recordSettlement(makeSettlement());
    expect(tracker.getAccuracy('anthropic-sonnet')).not.toBeNull();
  });

  test('A9 — listAll throws on construction → tracker degrades to in-memory cold-start', () => {
    const failingStore = {
      upsertRecord: () => {},
      listAll: () => {
        throw new Error('boom');
      },
    };
    const tracker = new BidAccuracyTracker(failingStore);
    // Construction must not throw; tracker cold-starts in memory.
    tracker.recordSettlement(makeSettlement());
    expect(tracker.getAccuracy('anthropic-sonnet')).not.toBeNull();
  });

  test('A9 — upsertRecord throws → tracker does not propagate', () => {
    const failingStore = {
      upsertRecord: () => {
        throw new Error('boom');
      },
      listAll: () => [],
    };
    const tracker = new BidAccuracyTracker(failingStore);
    expect(() => tracker.recordSettlement(makeSettlement())).not.toThrow();
    // In-memory state still updates.
    expect(tracker.getAccuracy('anthropic-sonnet')!.total_settled_bids).toBe(1);
  });
});
