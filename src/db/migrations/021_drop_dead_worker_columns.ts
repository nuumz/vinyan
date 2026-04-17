/**
 * Migration 021 — drop unused `project_id` column from worker_profiles.
 *
 * The column was reserved in the initial schema (001) for per-project fleet
 * scoping but was never wired into any read or write path. Removing it tidies
 * the row shape now that `engine_config` (JSON blob) is the authoritative
 * config store. Legacy config columns (temperature, system_prompt_tpl, etc.)
 * remain in place for this release — dual-write needs one release of overlap
 * before we can drop them safely.
 *
 * SQLite DROP COLUMN is available since 3.35. The migration is idempotent:
 * PRAGMA table_info is checked before ALTER.
 */

import type { Database } from 'bun:sqlite';
import type { Migration } from './migration-runner.ts';

export const migration021: Migration = {
  version: 21,
  description: 'Drop unused project_id column from worker_profiles',
  up(db: Database) {
    const cols = db.prepare("PRAGMA table_info('worker_profiles')").all() as Array<{ name: string }>;
    const hasProjectId = cols.some((c) => c.name === 'project_id');
    if (hasProjectId) {
      db.exec(`ALTER TABLE worker_profiles DROP COLUMN project_id`);
    }
  },
};
