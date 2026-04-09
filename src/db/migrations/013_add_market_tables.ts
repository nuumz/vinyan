/**
 * Migration 013 — Add market tables: bid_records, settlement_records,
 * bid_accuracy, auction_records, market_phase.
 *
 * Economy OS Layer 3: bid-based task allocation with settlement tracking.
 */
import type { Database } from 'bun:sqlite';
import type { Migration } from './migration-runner.ts';

export const migration013: Migration = {
  version: 13,
  description: 'Add market tables (bids, settlements, accuracy, auctions, phase)',
  up(db: Database): void {
    db.exec(`
      CREATE TABLE IF NOT EXISTS bid_records (
        id                    TEXT PRIMARY KEY,
        auction_id            TEXT NOT NULL,
        bidder_id             TEXT NOT NULL,
        bidder_type           TEXT NOT NULL CHECK(bidder_type IN ('local','remote')),
        task_id               TEXT NOT NULL,
        estimated_tokens_in   INTEGER NOT NULL DEFAULT 0,
        estimated_tokens_out  INTEGER NOT NULL,
        estimated_duration_ms INTEGER NOT NULL,
        estimated_usd         REAL,
        declared_confidence   REAL NOT NULL,
        accepts_token_budget  INTEGER NOT NULL,
        accepts_time_limit_ms INTEGER NOT NULL,
        score                 REAL,
        is_winner             INTEGER NOT NULL DEFAULT 0,
        submitted_at          INTEGER NOT NULL,
        expires_at            INTEGER
      )
    `);
    db.exec('CREATE INDEX IF NOT EXISTS idx_br_auction ON bid_records(auction_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_br_bidder ON bid_records(bidder_id)');

    db.exec(`
      CREATE TABLE IF NOT EXISTS settlement_records (
        id                    TEXT PRIMARY KEY,
        bid_id                TEXT NOT NULL,
        engine_id             TEXT NOT NULL,
        task_id               TEXT NOT NULL,
        bid_usd               REAL NOT NULL,
        actual_usd            REAL NOT NULL,
        cost_accuracy         REAL NOT NULL,
        duration_accuracy     REAL NOT NULL,
        composite_accuracy    REAL NOT NULL,
        penalty_type          TEXT,
        settled_at            INTEGER NOT NULL
      )
    `);
    db.exec('CREATE INDEX IF NOT EXISTS idx_sr_engine ON settlement_records(engine_id)');

    db.exec(`
      CREATE TABLE IF NOT EXISTS bid_accuracy (
        bidder_id                 TEXT PRIMARY KEY,
        accuracy_ema              REAL NOT NULL DEFAULT 0.5,
        total_settled_bids        INTEGER NOT NULL DEFAULT 0,
        underbid_violations       INTEGER NOT NULL DEFAULT 0,
        overclaim_violations      INTEGER NOT NULL DEFAULT 0,
        free_ride_violations      INTEGER NOT NULL DEFAULT 0,
        penalty_active            INTEGER NOT NULL DEFAULT 0,
        penalty_auctions_remaining INTEGER NOT NULL DEFAULT 0,
        last_settled_at           INTEGER NOT NULL DEFAULT 0
      )
    `);

    db.exec(`
      CREATE TABLE IF NOT EXISTS auction_records (
        id              TEXT PRIMARY KEY,
        task_id         TEXT NOT NULL,
        phase           TEXT NOT NULL CHECK(phase IN ('A','B','C','D')),
        bidder_count    INTEGER NOT NULL,
        winner_id       TEXT,
        winner_score    REAL,
        second_score    REAL,
        budget_cap      INTEGER,
        started_at      INTEGER NOT NULL,
        completed_at    INTEGER NOT NULL
      )
    `);
    db.exec('CREATE INDEX IF NOT EXISTS idx_ar_task ON auction_records(task_id)');

    db.exec(`
      CREATE TABLE IF NOT EXISTS market_phase (
        id              INTEGER PRIMARY KEY DEFAULT 1,
        current_phase   TEXT NOT NULL DEFAULT 'A' CHECK(current_phase IN ('A','B','C','D')),
        activated_at    INTEGER NOT NULL,
        auction_count   INTEGER NOT NULL DEFAULT 0,
        last_evaluated_at INTEGER NOT NULL
      )
    `);
  },
};
