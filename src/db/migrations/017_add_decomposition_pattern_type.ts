/**
 * Migration 017 — Add 'decomposition-pattern' to extracted_patterns type CHECK.
 *
 * Wave B: The decomposition learner stores winning DAG shapes as patterns.
 * SQLite doesn't support ALTER CHECK, so we recreate the table with the
 * updated constraint, copy data, and recreate indexes.
 */
import type { Migration } from './migration-runner.ts';

export const migration017: Migration = {
  version: 17,
  description: 'Add decomposition-pattern type to extracted_patterns',
  up(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS extracted_patterns_new (
        id                  TEXT PRIMARY KEY,
        type                TEXT NOT NULL CHECK(type IN ('anti-pattern', 'success-pattern', 'worker-performance', 'decomposition-pattern')),
        description         TEXT NOT NULL,
        frequency           INTEGER NOT NULL,
        confidence          REAL NOT NULL,
        task_type_signature TEXT NOT NULL,
        approach            TEXT,
        compared_approach   TEXT,
        quality_delta       REAL,
        source_trace_ids    TEXT NOT NULL,
        created_at          INTEGER NOT NULL,
        expires_at          INTEGER,
        decay_weight        REAL NOT NULL DEFAULT 1.0,
        derived_from        TEXT,
        worker_id           TEXT,
        compared_worker_id  TEXT
      );

      INSERT OR IGNORE INTO extracted_patterns_new SELECT * FROM extracted_patterns;
      DROP TABLE IF EXISTS extracted_patterns;
      ALTER TABLE extracted_patterns_new RENAME TO extracted_patterns;

      CREATE INDEX IF NOT EXISTS idx_patterns_type ON extracted_patterns(type);
      CREATE INDEX IF NOT EXISTS idx_patterns_task_sig ON extracted_patterns(task_type_signature);
      CREATE INDEX IF NOT EXISTS idx_patterns_created ON extracted_patterns(created_at);
    `);
  },
};
