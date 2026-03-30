/**
 * Pattern Store Schema — SQLite tables for Sleep Cycle extracted patterns.
 *
 * Source of truth: vinyan-tdd.md §12B (Sleep Cycle)
 */

export const PATTERN_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS extracted_patterns (
  id                  TEXT PRIMARY KEY,
  type                TEXT NOT NULL CHECK(type IN ('anti-pattern', 'success-pattern')),
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
  decay_weight        REAL NOT NULL DEFAULT 1.0
);

CREATE INDEX IF NOT EXISTS idx_patterns_type ON extracted_patterns(type);
CREATE INDEX IF NOT EXISTS idx_patterns_task_sig ON extracted_patterns(task_type_signature);
CREATE INDEX IF NOT EXISTS idx_patterns_created ON extracted_patterns(created_at);

CREATE TABLE IF NOT EXISTS sleep_cycle_runs (
  id            TEXT PRIMARY KEY,
  started_at    INTEGER NOT NULL,
  completed_at  INTEGER,
  traces_analyzed INTEGER NOT NULL DEFAULT 0,
  patterns_found  INTEGER NOT NULL DEFAULT 0,
  status        TEXT NOT NULL CHECK(status IN ('running', 'completed', 'failed'))
);
`;
