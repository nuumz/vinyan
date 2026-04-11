/**
 * Migration 014 — Add federation economy tables: peer_pricing, federation_budget.
 *
 * Economy OS Layer 4: cross-instance cost sharing and peer pricing.
 */
import type { Database } from 'bun:sqlite';
import type { Migration } from './migration-runner.ts';

export const migration014: Migration = {
  version: 14,
  description: 'Add federation economy tables (peer_pricing, federation_budget)',
  up(db: Database): void {
    db.exec(`
      CREATE TABLE IF NOT EXISTS peer_pricing (
        id              TEXT PRIMARY KEY,
        instance_id     TEXT NOT NULL,
        task_type       TEXT NOT NULL,
        price_input     REAL NOT NULL,
        price_output    REAL NOT NULL,
        min_charge_usd  REAL NOT NULL DEFAULT 0,
        valid_until     INTEGER NOT NULL,
        created_at      INTEGER NOT NULL
      )
    `);
    db.exec('CREATE INDEX IF NOT EXISTS idx_pp_instance ON peer_pricing(instance_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_pp_task_type ON peer_pricing(task_type)');

    db.exec(`
      CREATE TABLE IF NOT EXISTS federation_budget (
        id              INTEGER PRIMARY KEY DEFAULT 1,
        contributed_usd REAL NOT NULL DEFAULT 0,
        consumed_usd    REAL NOT NULL DEFAULT 0,
        last_updated    INTEGER NOT NULL
      )
    `);
  },
};
