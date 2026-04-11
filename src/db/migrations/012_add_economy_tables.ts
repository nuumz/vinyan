/**
 * Migration 012 — Add economy tables: cost_ledger + budget_snapshots.
 *
 * Economy OS Layer 1: persistent cost tracking per task/worker/provider
 * with global budget snapshot history.
 */
import type { Database } from 'bun:sqlite';
import type { Migration } from './migration-runner.ts';

export const migration012: Migration = {
  version: 12,
  description: 'Add economy tables (cost_ledger, budget_snapshots)',
  up(db: Database): void {
    db.exec(`
      CREATE TABLE IF NOT EXISTS cost_ledger (
        id                    TEXT PRIMARY KEY,
        task_id               TEXT NOT NULL,
        worker_id             TEXT,
        engine_id             TEXT NOT NULL,
        timestamp             INTEGER NOT NULL,
        tokens_input          INTEGER NOT NULL DEFAULT 0,
        tokens_output         INTEGER NOT NULL DEFAULT 0,
        cache_read_tokens     INTEGER NOT NULL DEFAULT 0,
        cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
        duration_ms           INTEGER NOT NULL DEFAULT 0,
        oracle_invocations    INTEGER NOT NULL DEFAULT 0,
        computed_usd          REAL NOT NULL,
        cost_tier             TEXT NOT NULL CHECK(cost_tier IN ('billing','estimated')),
        routing_level         INTEGER NOT NULL,
        task_type_signature   TEXT
      )
    `);
    db.exec('CREATE INDEX IF NOT EXISTS idx_cl_timestamp ON cost_ledger(timestamp)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_cl_task_id ON cost_ledger(task_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_cl_engine_id ON cost_ledger(engine_id)');

    db.exec(`
      CREATE TABLE IF NOT EXISTS budget_snapshots (
        id         TEXT PRIMARY KEY,
        window     TEXT NOT NULL CHECK(window IN ('hour','day','month')),
        period_key TEXT NOT NULL,
        spent_usd  REAL NOT NULL,
        limit_usd  REAL,
        timestamp  INTEGER NOT NULL
      )
    `);
    db.exec('CREATE INDEX IF NOT EXISTS idx_bs_period ON budget_snapshots(window, period_key)');
  },
};
