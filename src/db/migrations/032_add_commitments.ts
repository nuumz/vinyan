/**
 * Migration 032 — Commitment ledger.
 *
 * A commitment records "engine X owes deliverable Y by deadline Z".
 * Created at bid-accept (market:auction_completed) and resolved at
 * oracle-verdict (trace:record with outcome).
 *
 * A4: deliverable_hash binds the commitment to a content-addressed goal.
 * A7: resolution outcome (delivered|failed|transferred) becomes learning signal.
 *
 * Source of truth: docs/design/vinyan-os-ecosystem-plan.md §3.2
 */
import type { Database } from 'bun:sqlite';
import type { Migration } from './migration-runner.ts';

export const migration032: Migration = {
  version: 32,
  description: 'Add commitments table (O2 ecosystem)',
  up(db: Database) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS commitments (
        commitment_id     TEXT PRIMARY KEY,
        engine_id         TEXT NOT NULL,
        task_id           TEXT NOT NULL,
        deliverable_hash  TEXT NOT NULL,
        deadline_at       INTEGER NOT NULL,
        accepted_at       INTEGER NOT NULL,
        resolved_at       INTEGER,
        resolution_kind   TEXT
                           CHECK(resolution_kind IN ('delivered','failed','transferred') OR resolution_kind IS NULL),
        resolution_evidence TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_commitments_engine
        ON commitments(engine_id);
      CREATE INDEX IF NOT EXISTS idx_commitments_task
        ON commitments(task_id);
      CREATE INDEX IF NOT EXISTS idx_commitments_open
        ON commitments(engine_id)
        WHERE resolved_at IS NULL;
    `);
  },
};
