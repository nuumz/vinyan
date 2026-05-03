/**
 * Migration 041 — Phase A2: role_protocol_run audit table.
 *
 * Records every step of every protocol run keyed by (task_id, step_id,
 * started_at). Operators query this table to answer "why did this
 * researcher's investigation fail?" — surfacing per-step outcomes,
 * oracle verdicts, retry attempts, and (for blocked steps) the
 * structured reason.
 *
 * Append-only ledger; no UPDATEs after insert. The `evidence_json`
 * column stores the step's `evidence` payload (gather hashes, synthesis
 * text excerpt, etc.) — capped at ~64KB by application code; SQLite
 * itself imposes no limit but the audit table is not the place to
 * stash full document bodies.
 *
 * Composite PK guards against double-writes from a retry loop within a
 * single millisecond. Two indexes cover the common access patterns:
 *   - (task_id, step_index)        — replay one task's protocol run
 *   - (protocol_id, started_at DESC) — recent runs of one protocol
 *
 * Idempotent: `CREATE TABLE IF NOT EXISTS` + `CREATE INDEX IF NOT EXISTS`.
 */
import type { Database } from 'bun:sqlite';
import type { Migration } from './migration-runner.ts';

export const migration041: Migration = {
  version: 41,
  description: 'role_protocol_run table for Phase A2 protocol step audit',
  up(db: Database) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS role_protocol_run (
        task_id              TEXT NOT NULL,
        persona_id           TEXT NOT NULL,
        protocol_id          TEXT NOT NULL,
        step_id              TEXT NOT NULL,
        step_index           INTEGER NOT NULL,
        outcome              TEXT NOT NULL CHECK (outcome IN ('success', 'failure', 'skipped', 'oracle-blocked')),
        attempts             INTEGER NOT NULL,
        confidence           REAL,
        tokens_consumed      INTEGER NOT NULL,
        duration_ms          INTEGER NOT NULL,
        reason               TEXT,
        oracle_verdicts_json TEXT,
        evidence_json        TEXT,
        started_at           INTEGER NOT NULL,
        PRIMARY KEY (task_id, step_id, started_at)
      )
    `);
    db.exec('CREATE INDEX IF NOT EXISTS idx_rpr_task_step ON role_protocol_run (task_id, step_index)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_rpr_protocol_started ON role_protocol_run (protocol_id, started_at DESC)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_rpr_persona_started ON role_protocol_run (persona_id, started_at DESC)');
  },
};
