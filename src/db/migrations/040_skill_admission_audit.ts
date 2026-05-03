/**
 * Migration 040 — Phase B: skill admission audit table.
 *
 * Records every admission verdict (`accept` | `reject`) emitted by
 * `proposeAcquiredToBoundPromotions` when an admission gate is wired in.
 * Append-only ledger; readers consume it via `SkillAdmissionStore`.
 *
 * Composite PK on (persona_id, skill_id, decided_at): two concurrent
 * sleep-cycle workers cannot collide unless they share a millisecond
 * clock. `INSERT OR IGNORE` swallows the unlikely tie.
 *
 * Idempotent: `CREATE TABLE IF NOT EXISTS` + `CREATE INDEX IF NOT EXISTS`
 * make a re-run a no-op.
 */
import type { Database } from 'bun:sqlite';
import type { Migration } from './migration-runner.ts';

export const migration040: Migration = {
  version: 40,
  description: 'skill_admission_audit table for Phase B persona/skill admission gate',
  up(db: Database) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS skill_admission_audit (
        persona_id     TEXT NOT NULL,
        skill_id       TEXT NOT NULL,
        verdict        TEXT NOT NULL CHECK (verdict IN ('accept', 'reject')),
        overlap_ratio  REAL NOT NULL,
        reason         TEXT,
        decided_at     INTEGER NOT NULL,
        PRIMARY KEY (persona_id, skill_id, decided_at)
      )
    `);
    db.exec(
      'CREATE INDEX IF NOT EXISTS idx_saa_persona_decided ON skill_admission_audit (persona_id, decided_at DESC)',
    );
    db.exec('CREATE INDEX IF NOT EXISTS idx_saa_verdict_decided ON skill_admission_audit (verdict, decided_at DESC)');
  },
};
