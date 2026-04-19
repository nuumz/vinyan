/**
 * Migration 037 — composite PK `(input_hash, engine_id)` on
 * `comprehension_records`.
 *
 * BUG#1: the pipeline runs BOTH stage 1 (rule-comprehender) and stage 2
 * (llm-comprehender) against the SAME `ComprehensionInput`. Their
 * envelopes therefore carry the SAME `inputHash`. With
 * `PRIMARY KEY = input_hash`, `INSERT OR IGNORE` silently drops stage
 * 2. Calibrator for `llm-comprehender` has had ZERO data since the
 * factory wired stage 2 (GAP#1). All self-recusal / divergence /
 * Brier / weighted-accuracy math for the LLM engine has been no-op
 * in production.
 *
 * Fix: composite PK on (input_hash, engine_id). Each engine gets its
 * own row per turn; `markOutcome(inputHash, ...)` continues to update
 * BOTH rows because outcome is a property of the user's turn, not of a
 * specific engine.
 *
 * SQLite lacks in-place PK modification — we recreate the table:
 *   1. Create new table with composite PK.
 *   2. Copy rows from old (dedup by (input_hash, engine_id); earliest wins).
 *   3. Drop old table; rename new into place.
 *   4. Recreate indexes.
 *
 * Data preservation: rows currently keyed on input_hash alone are
 * migrated intact (the single row becomes the stage-1 row per turn).
 * Stage-2 rows that were silently dropped cannot be recovered —
 * they were never written. Future turns get the fix.
 */
import type { Database } from 'bun:sqlite';
import type { Migration } from './migration-runner.ts';

export const migration037: Migration = {
  version: 37,
  description: 'comprehension_records: composite PK (input_hash, engine_id) — fixes silent stage-2 drop',
  up(db: Database): void {
    // Guard — skip if already migrated (idempotent re-run).
    const pkInfo = db
      .prepare("PRAGMA index_list('comprehension_records')")
      .all() as Array<{ name: string; origin: string; unique: number }>;
    const hasCompositePk = pkInfo.some(
      (ix) => ix.origin === 'pk' && ix.unique === 1 && ix.name.includes('sqlite_autoindex'),
    );
    // A cleaner detection: check the schema text contains composite PK.
    const tableRow = db
      .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='comprehension_records'")
      .get() as { sql: string } | undefined;
    if (tableRow && /PRIMARY KEY\s*\(\s*input_hash\s*,\s*engine_id\s*\)/i.test(tableRow.sql)) {
      return; // already migrated
    }
    // `hasCompositePk` kept for future schemas — suppress unused-var lint.
    void hasCompositePk;

    // No explicit BEGIN/COMMIT here: the MigrationRunner already wraps
    // each `up()` call in `db.transaction(...)`, so an inner BEGIN
    // would throw "cannot start a transaction within a transaction".
    // A thrown error inside this block rolls the outer tx back
    // automatically.

    db.exec(`
      CREATE TABLE comprehension_records_new (
        input_hash        TEXT NOT NULL,
        task_id           TEXT NOT NULL,
        session_id        TEXT,
        engine_id         TEXT NOT NULL,
        engine_type       TEXT,
        tier              TEXT NOT NULL,
        type              TEXT NOT NULL,
        confidence        REAL NOT NULL,
        verdict_pass      INTEGER NOT NULL,
        verdict_reason    TEXT,
        envelope_json     TEXT NOT NULL,
        created_at        INTEGER NOT NULL,
        outcome           TEXT,
        outcome_evidence  TEXT,
        outcome_at        INTEGER,
        PRIMARY KEY (input_hash, engine_id)
      );
    `);

    // Preserve all existing rows. Pre-migration rows are guaranteed
    // unique on input_hash (old PK), so (input_hash, engine_id) is
    // trivially unique too.
    db.exec(`
      INSERT INTO comprehension_records_new (
        input_hash, task_id, session_id, engine_id, engine_type,
        tier, type, confidence, verdict_pass, verdict_reason,
        envelope_json, created_at, outcome, outcome_evidence, outcome_at
      )
      SELECT
        input_hash, task_id, session_id, engine_id, engine_type,
        tier, type, confidence, verdict_pass, verdict_reason,
        envelope_json, created_at, outcome, outcome_evidence, outcome_at
      FROM comprehension_records;
    `);

    db.exec('DROP TABLE comprehension_records');
    db.exec('ALTER TABLE comprehension_records_new RENAME TO comprehension_records');

    // Recreate indexes. These mirror migrations 029 + 030.
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_cr_session_created
        ON comprehension_records(session_id, created_at DESC);
    `);
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_cr_engine_outcome
        ON comprehension_records(engine_id, outcome, created_at DESC);
    `);
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_cr_pending_sweep
        ON comprehension_records(outcome, created_at)
        WHERE outcome IS NULL;
    `);
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_cr_engine_type
        ON comprehension_records(engine_type, created_at DESC);
    `);
  },
};
