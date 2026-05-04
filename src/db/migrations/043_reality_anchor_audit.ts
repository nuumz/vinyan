/**
 * Migration 043 — Phase C4: reality_anchor_audit table.
 *
 * Append-only ledger for every reality-anchor state transition + sub-
 * action. Each row records (persona, prev_state, new_state, stage,
 * reason, ts).
 *
 * The persona's CURRENT state is derived from the latest row per
 * persona_id (`recorded_at DESC LIMIT 1`). On orchestrator boot the
 * regrounder hydrates an in-memory cache from this table. No separate
 * "current state" table — single source of truth, replayable.
 *
 * Schema notes:
 *   - `prev_state` and `new_state` are CHECKed against the four valid
 *     states. Catches malformed inserts (e.g. typos).
 *   - `stage` is CHECKed against the five named workflow stages.
 *   - Composite PK (persona_id, recorded_at) prevents a duplicate write
 *     within a single millisecond. Real concurrent regrounders would
 *     collide here, but only one regrounder per orchestrator exists by
 *     design (subscribed once in factory).
 *
 * Idempotent: `CREATE TABLE IF NOT EXISTS` + `CREATE INDEX IF NOT EXISTS`.
 */
import type { Database } from 'bun:sqlite';
import type { Migration } from './migration-runner.ts';

export const migration043: Migration = {
  version: 43,
  description: 'reality_anchor_audit table for Phase C4 re-grounding state machine',
  up(db: Database) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS reality_anchor_audit (
        persona_id   TEXT NOT NULL,
        prev_state   TEXT NOT NULL CHECK (prev_state IN ('active', 'quarantined', 'rebuilding', 'shadow-mode')),
        new_state    TEXT NOT NULL CHECK (new_state  IN ('active', 'quarantined', 'rebuilding', 'shadow-mode')),
        stage        TEXT NOT NULL CHECK (stage IN ('quarantine', 'rebuild', 'prune', 'replay', 'reentry')),
        reason       TEXT NOT NULL,
        recorded_at  INTEGER NOT NULL,
        PRIMARY KEY (persona_id, recorded_at)
      )
    `);
    db.exec('CREATE INDEX IF NOT EXISTS idx_raa_persona_ts ON reality_anchor_audit (persona_id, recorded_at DESC)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_raa_stage ON reality_anchor_audit (stage)');
  },
};
