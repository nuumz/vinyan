/**
 * `BidAccuracyStore` — Phase-15 (Item 2) SQLite persistence for the
 * provider-keyed bid-accuracy ledger (`BidAccuracyTracker`). Mirrors the
 * `PersonaOverclaimStore` pattern.
 *
 * The `bid_accuracy` table schema slot already exists from migration
 * 001 — no new migration needed.
 *
 * Tracker handles all EMA + violation-window math; this store is dumb
 * persistence — accept the aggregate `BidAccuracyRecord` and UPSERT it.
 *
 * Bounded write rate: at most one `recordSettlement` per task settlement,
 * fired by `MarketScheduler.settle`. Per-record writes are well within
 * SQLite's tolerance.
 */
import type { Database } from 'bun:sqlite';
import type { BidAccuracyRecord } from '../economy/market/schemas.ts';

interface BidAccuracyRow {
  bidder_id: string;
  accuracy_ema: number;
  total_settled_bids: number;
  underbid_violations: number;
  overclaim_violations: number;
  free_ride_violations: number;
  penalty_active: number;
  penalty_auctions_remaining: number;
  last_settled_at: number;
}

export class BidAccuracyStore {
  constructor(private readonly db: Database) {}

  /**
   * Write-through every settlement: tracker mutates its in-memory map and
   * passes the new aggregate state here. ON CONFLICT updates every column
   * — the row's value at any moment IS the tracker's view, no out-of-band
   * accumulation lives in SQLite.
   */
  upsertRecord(record: BidAccuracyRecord): void {
    this.db
      .prepare(
        `INSERT INTO bid_accuracy
          (bidder_id, accuracy_ema, total_settled_bids,
           underbid_violations, overclaim_violations, free_ride_violations,
           penalty_active, penalty_auctions_remaining, last_settled_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(bidder_id) DO UPDATE SET
           accuracy_ema = excluded.accuracy_ema,
           total_settled_bids = excluded.total_settled_bids,
           underbid_violations = excluded.underbid_violations,
           overclaim_violations = excluded.overclaim_violations,
           free_ride_violations = excluded.free_ride_violations,
           penalty_active = excluded.penalty_active,
           penalty_auctions_remaining = excluded.penalty_auctions_remaining,
           last_settled_at = excluded.last_settled_at`,
      )
      .run(
        record.bidderId,
        record.accuracy_ema,
        record.total_settled_bids,
        record.underbid_violations,
        record.overclaim_violations,
        record.free_ride_violations,
        record.penalty_active ? 1 : 0,
        record.penalty_auctions_remaining,
        record.last_settled_at,
      );
  }

  getRecord(bidderId: string): BidAccuracyRecord | null {
    const row = this.db
      .prepare(`SELECT * FROM bid_accuracy WHERE bidder_id = ?`)
      .get(bidderId) as BidAccuracyRow | undefined;
    return row ? rowToRecord(row) : null;
  }

  /** Snapshot every row — tracker calls on construction to rehydrate. */
  listAll(): BidAccuracyRecord[] {
    const rows = this.db
      .prepare(`SELECT * FROM bid_accuracy ORDER BY bidder_id ASC`)
      .all() as BidAccuracyRow[];
    return rows.map(rowToRecord);
  }
}

function rowToRecord(row: BidAccuracyRow): BidAccuracyRecord {
  return {
    bidderId: row.bidder_id,
    accuracy_ema: row.accuracy_ema,
    total_settled_bids: row.total_settled_bids,
    underbid_violations: row.underbid_violations,
    overclaim_violations: row.overclaim_violations,
    free_ride_violations: row.free_ride_violations,
    penalty_active: row.penalty_active === 1,
    penalty_auctions_remaining: row.penalty_auctions_remaining,
    last_settled_at: row.last_settled_at,
  };
}
