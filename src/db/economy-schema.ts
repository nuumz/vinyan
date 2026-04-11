/**
 * Economy Schema — DDL for cost_ledger and budget_snapshots tables.
 *
 * Used by migration 012. Separated for reuse in tests.
 */

export const COST_LEDGER_DDL = `
CREATE TABLE IF NOT EXISTS cost_ledger (
  id                    TEXT PRIMARY KEY,
  task_id               TEXT NOT NULL,
  worker_id             TEXT,
  engine_id             TEXT NOT NULL,
  timestamp             INTEGER NOT NULL,
  tokens_input          INTEGER NOT NULL DEFAULT 0,
  tokens_output         INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens     INTEGER NOT NULL DEFAULT 0,
  cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
  duration_ms           INTEGER NOT NULL DEFAULT 0,
  oracle_invocations    INTEGER NOT NULL DEFAULT 0,
  computed_usd          REAL NOT NULL,
  cost_tier             TEXT NOT NULL CHECK(cost_tier IN ('billing','estimated')),
  routing_level         INTEGER NOT NULL,
  task_type_signature   TEXT
);
CREATE INDEX IF NOT EXISTS idx_cl_timestamp ON cost_ledger(timestamp);
CREATE INDEX IF NOT EXISTS idx_cl_task_id ON cost_ledger(task_id);
CREATE INDEX IF NOT EXISTS idx_cl_engine_id ON cost_ledger(engine_id);
`;

export const BUDGET_SNAPSHOTS_DDL = `
CREATE TABLE IF NOT EXISTS budget_snapshots (
  id         TEXT PRIMARY KEY,
  window     TEXT NOT NULL CHECK(window IN ('hour','day','month')),
  period_key TEXT NOT NULL,
  spent_usd  REAL NOT NULL,
  limit_usd  REAL,
  timestamp  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_bs_period ON budget_snapshots(window, period_key);
`;
