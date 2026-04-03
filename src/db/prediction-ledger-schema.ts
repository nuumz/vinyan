/**
 * PredictionLedger Schema — SQLite tables for ForwardPredictor persistence.
 *
 * Tables:
 * - prediction_ledger: predictions recorded before task execution
 * - prediction_outcomes: actual outcomes recorded after VERIFY step
 * - plan_rankings: counterfactual plan rankings (FP-G)
 *
 * Migration pattern: PRAGMA table_info for idempotent ALTER TABLE.
 */
import type { Database } from 'bun:sqlite';

export const PREDICTION_LEDGER_SCHEMA = `
  CREATE TABLE IF NOT EXISTS prediction_ledger (
    prediction_id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL,
    task_type_signature TEXT NOT NULL DEFAULT '',
    basis TEXT NOT NULL DEFAULT 'heuristic',
    test_outcome_json TEXT NOT NULL,
    blast_radius_json TEXT NOT NULL,
    quality_score_json TEXT NOT NULL,
    confidence REAL NOT NULL DEFAULT 0.0,
    timestamp INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_pl_task_type ON prediction_ledger(task_type_signature);
  CREATE INDEX IF NOT EXISTS idx_pl_timestamp ON prediction_ledger(timestamp);

  CREATE TABLE IF NOT EXISTS prediction_outcomes (
    prediction_id TEXT PRIMARY KEY REFERENCES prediction_ledger(prediction_id),
    actual_test_result TEXT NOT NULL,
    actual_blast_radius REAL NOT NULL,
    actual_quality REAL NOT NULL,
    actual_duration REAL NOT NULL,
    brier_score REAL,
    crps_blast REAL,
    crps_quality REAL,
    recorded_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS plan_rankings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id TEXT NOT NULL,
    selected_plan_id TEXT NOT NULL,
    selected_reason TEXT NOT NULL,
    rankings_json TEXT NOT NULL,
    actual_outcome_json TEXT,
    recorded_at INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_pr_task_id ON plan_rankings(task_id);
`;

/** Run prediction ledger migrations. Safe to call multiple times. */
export function migratePredictionLedgerSchema(db: Database): void {
  db.exec(PREDICTION_LEDGER_SCHEMA);

  // Future migrations: add columns via PRAGMA table_info pattern
  const columns = db.prepare('PRAGMA table_info(prediction_ledger)').all() as Array<{ name: string }>;
  const columnNames = new Set(columns.map((c) => c.name));

  if (!columnNames.has('affected_files_json')) {
    db.exec('ALTER TABLE prediction_ledger ADD COLUMN affected_files_json TEXT');
  }
}
