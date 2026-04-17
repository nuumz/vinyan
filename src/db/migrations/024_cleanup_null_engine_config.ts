/**
 * Migration 024 — delete orphaned worker_profiles rows with NULL engine_config.
 *
 * Background: before migration 008 made `engine_config` authoritative,
 * worker_profiles rows were created with individual config columns
 * (temperature, system_prompt_tpl, etc.). Migration 022 dropped those
 * columns but did not backfill `engine_config` for existing rows.
 *
 * The result: rows created prior to the authoritative-JSON cutover have
 * `engine_config IS NULL`, which the Zod row schema (z.string()) rejects
 * at load time. These rows cannot be reconstructed — the source config
 * data was dropped by migration 022 — so the only safe action is to
 * delete them. The worker-selector will re-create fresh profiles on
 * first dispatch as needed.
 *
 * Idempotent: DELETE with a WHERE clause affects only bad rows.
 */

import type { Database } from 'bun:sqlite';
import type { Migration } from './migration-runner.ts';

export const migration024: Migration = {
  version: 24,
  description: 'Delete orphaned worker_profiles rows with NULL engine_config',
  up(db: Database): void {
    // Guard: if the column doesn't exist yet (shouldn't happen at v24,
    // but be defensive), skip silently.
    const cols = db.prepare("PRAGMA table_info('worker_profiles')").all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === 'engine_config')) return;

    const result = db.prepare('DELETE FROM worker_profiles WHERE engine_config IS NULL').run();
    if (result.changes > 0) {
      console.log(
        `[migration 024] Deleted ${result.changes} orphaned worker_profiles row(s) with NULL engine_config`,
      );
    }
  },
};
