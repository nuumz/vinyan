/**
 * Migration 034 — Volunteer protocol tables.
 *
 * Two tables:
 *  - `volunteer_offers`   — historical log of offers per task
 *  - `engine_helpfulness` — per-engine counter (volunteer offers that reached
 *                            a `delivered` commitment resolution)
 *
 * The helpfulness metric feeds promotion gates in the career FSM
 * (`WorkerLifecycle`). It deliberately does NOT feed bid scoring —
 * otherwise agents could game the auction by volunteering indiscriminately.
 *
 * Source of truth: docs/design/vinyan-os-ecosystem-plan.md §3.3
 */
import type { Database } from 'bun:sqlite';
import type { Migration } from './migration-runner.ts';

export const migration034: Migration = {
  version: 34,
  description: 'Add volunteer_offers + engine_helpfulness tables (O4 ecosystem)',
  up(db: Database) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS volunteer_offers (
        offer_id         TEXT PRIMARY KEY,
        task_id          TEXT NOT NULL,
        engine_id        TEXT NOT NULL,
        offered_at       INTEGER NOT NULL,
        accepted_at      INTEGER,
        commitment_id    TEXT,
        declined_reason  TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_volunteer_offers_task
        ON volunteer_offers(task_id);
      CREATE INDEX IF NOT EXISTS idx_volunteer_offers_engine
        ON volunteer_offers(engine_id);
      CREATE INDEX IF NOT EXISTS idx_volunteer_offers_commitment
        ON volunteer_offers(commitment_id)
        WHERE commitment_id IS NOT NULL;

      CREATE TABLE IF NOT EXISTS engine_helpfulness (
        engine_id            TEXT PRIMARY KEY,
        offers_made          INTEGER NOT NULL DEFAULT 0,
        offers_accepted      INTEGER NOT NULL DEFAULT 0,
        deliveries_completed INTEGER NOT NULL DEFAULT 0,
        last_updated_at      INTEGER NOT NULL
      );
    `);
  },
};
