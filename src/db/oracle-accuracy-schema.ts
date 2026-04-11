/**
 * Oracle Accuracy Schema — SQLite tables for retrospective oracle accuracy tracking.
 *
 * Replaces the circular in-memory accuracy tracker (C4 fix).
 * Records each oracle verdict at gate time, resolves outcome post-hoc
 * when task completes/fails or after a staleness sweep.
 */

export const ORACLE_ACCURACY_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS oracle_accuracy (
  id TEXT PRIMARY KEY,
  oracle_name TEXT NOT NULL,
  gate_run_id TEXT NOT NULL,
  verdict TEXT NOT NULL CHECK (verdict IN ('pass','fail')),
  confidence REAL NOT NULL,
  tier TEXT NOT NULL,
  timestamp INTEGER NOT NULL,
  affected_files TEXT NOT NULL,
  outcome TEXT NOT NULL DEFAULT 'pending',
  outcome_timestamp INTEGER,
  UNIQUE(gate_run_id, oracle_name)
);
CREATE INDEX IF NOT EXISTS idx_oracle_accuracy_name ON oracle_accuracy(oracle_name);
CREATE INDEX IF NOT EXISTS idx_oracle_accuracy_outcome ON oracle_accuracy(outcome);
CREATE INDEX IF NOT EXISTS idx_oracle_accuracy_timestamp ON oracle_accuracy(timestamp);
`;
