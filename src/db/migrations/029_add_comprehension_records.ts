/**
 * Migration 029 — Add `comprehension_records` for the A7 learning loop.
 *
 * Each row is one comprehension phase outcome: what the engine proposed,
 * whether the oracle accepted it, and (filled on a later turn) whether
 * the user subsequently confirmed or corrected the resolvedGoal.
 *
 * Primary key: `input_hash` (A4 content-addressed). A session can have
 * many records over time; retrievals typically key on session_id + ordered
 * by created_at, or on engine_id for calibration aggregates.
 *
 * `outcome` is NULL on insert; the CorrectionDetector fills it on the
 * NEXT turn by inspecting follow-up signals. A nightly sweep can set
 * `outcome = 'abandoned'` on stale records without a follow-up.
 *
 * The `envelope_json` + `verdict_reason` are audit-trail fields — they
 * let us reconstruct why any particular comprehension was made, which is
 * critical when the learning loop flags a miscalibration and a human
 * wants to inspect the envelope that caused it.
 */
import type { Database } from 'bun:sqlite';
import type { Migration } from './migration-runner.ts';

export const migration029: Migration = {
  version: 29,
  description: 'Add comprehension_records for A7 learning loop',
  up(db: Database): void {
    db.exec(`
      CREATE TABLE IF NOT EXISTS comprehension_records (
        input_hash        TEXT PRIMARY KEY,
        task_id           TEXT NOT NULL,
        session_id        TEXT,
        engine_id         TEXT NOT NULL,
        tier              TEXT NOT NULL,
        type              TEXT NOT NULL,
        confidence        REAL NOT NULL,
        verdict_pass      INTEGER NOT NULL,
        verdict_reason    TEXT,
        envelope_json     TEXT NOT NULL,
        created_at        INTEGER NOT NULL,
        outcome           TEXT,
        outcome_evidence  TEXT,
        outcome_at        INTEGER
      );
    `);
    // Session queries — most recent comprehension per session.
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_cr_session_created
        ON comprehension_records(session_id, created_at DESC);
    `);
    // Calibration queries — per-engine, filter by outcome, recent first.
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_cr_engine_outcome
        ON comprehension_records(engine_id, outcome, created_at DESC);
    `);
    // Sweep index — find pending (outcome IS NULL) records older than N.
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_cr_pending_sweep
        ON comprehension_records(outcome, created_at)
        WHERE outcome IS NULL;
    `);
  },
};
