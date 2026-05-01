/**
 * Migration 027 — Task operations console support.
 *
 * Adds two columns to `session_tasks`:
 *   - `archived_at` (epoch-ms, NULL by default) — soft-hide for the Tasks
 *     operations console without deleting audit data (I16). Active list
 *     filters by `archived_at IS NULL`; archive view flips it.
 *   - `updated_at` (epoch-ms, NULL by default) — terminal/state-change
 *     timestamp. Backfilled from `created_at` for existing rows so
 *     duration/recency sorts have a value. Distinct from `created_at` so
 *     "completed at" is queryable without parsing `result_json`.
 *
 * Indexes: `(archived_at, created_at)` so the filtered list scan is
 * cheap, and `(status, created_at)` for the per-status drilldowns the
 * console renders.
 */
import type { Database } from 'bun:sqlite';
import type { Migration } from './migration-runner.ts';

export const migration027: Migration = {
  version: 27,
  description: 'session_tasks archive + updated_at for ops console',
  up(db: Database) {
    db.exec(`
      ALTER TABLE session_tasks ADD COLUMN archived_at INTEGER;
      ALTER TABLE session_tasks ADD COLUMN updated_at INTEGER;
      UPDATE session_tasks SET updated_at = created_at WHERE updated_at IS NULL;
      CREATE INDEX IF NOT EXISTS idx_st_archived_created
        ON session_tasks(archived_at, created_at);
      CREATE INDEX IF NOT EXISTS idx_st_status_created
        ON session_tasks(status, created_at);
      CREATE INDEX IF NOT EXISTS idx_st_task_id
        ON session_tasks(task_id);
    `);
  },
};
