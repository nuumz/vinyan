/**
 * SQLite schema for ExecutionTrace persistence.
 *
 * Denormalized QualityScore columns for efficient Sleep Cycle queries.
 * Source of truth: vinyan-tdd.md §12B, implementation-plan.md §2.3
 */

export const TRACE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS execution_traces (
  id                     TEXT PRIMARY KEY,
  task_id                TEXT NOT NULL,
  session_id             TEXT,
  worker_id              TEXT,
  timestamp              INTEGER NOT NULL,
  routing_level          INTEGER NOT NULL,
  task_type_signature    TEXT,
  approach               TEXT NOT NULL,
  approach_description   TEXT,
  risk_score             REAL,
  quality_composite      REAL,
  quality_arch           REAL,
  quality_efficiency     REAL,
  quality_simplification REAL,
  quality_testmutation   REAL,
  model_used             TEXT NOT NULL,
  tokens_consumed        INTEGER NOT NULL,
  duration_ms            INTEGER NOT NULL,
  outcome                TEXT NOT NULL CHECK(outcome IN ('success','failure','timeout','escalated')),
  failure_reason         TEXT,
  oracle_verdicts        TEXT NOT NULL,
  affected_files         TEXT NOT NULL,
  prediction_error       TEXT,
  validation_depth       TEXT,
  shadow_validation      TEXT
);

CREATE INDEX IF NOT EXISTS idx_et_task_type ON execution_traces(task_type_signature);
CREATE INDEX IF NOT EXISTS idx_et_outcome ON execution_traces(outcome);
CREATE INDEX IF NOT EXISTS idx_et_timestamp ON execution_traces(timestamp);
CREATE INDEX IF NOT EXISTS idx_et_quality ON execution_traces(quality_composite);
CREATE INDEX IF NOT EXISTS idx_et_approach ON execution_traces(task_type_signature, approach);
`;

export const MODEL_PARAMS_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS model_parameters (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
`;
