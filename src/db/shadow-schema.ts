/**
 * Shadow Job Schema — SQLite tables for async shadow validation jobs.
 *
 * Shadow jobs are enqueued BEFORE online response returns (A6 crash-safety).
 * Background process picks them up for full test suite + PHE validation.
 *
 * Source of truth: vinyan-tdd.md §12B (Shadow Execution), Phase 2.2
 */

export const SHADOW_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS shadow_jobs (
  id           TEXT PRIMARY KEY,
  task_id      TEXT NOT NULL,
  status       TEXT NOT NULL CHECK(status IN ('pending', 'running', 'done', 'failed')),
  enqueued_at  INTEGER NOT NULL,
  started_at   INTEGER,
  completed_at INTEGER,
  result       TEXT,
  mutations    TEXT NOT NULL,
  retry_count  INTEGER NOT NULL DEFAULT 0,
  max_retries  INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS idx_shadow_status ON shadow_jobs(status);
CREATE INDEX IF NOT EXISTS idx_shadow_task_id ON shadow_jobs(task_id);
`;
