/**
 * Migration 040 — Drop the `team_blackboard` table.
 *
 * Phase 2 introduced a filesystem-backed team blackboard
 * (`src/orchestrator/ecosystem/team-blackboard-fs.ts`). The DB table
 * was kept as a mirror + migration source during the Phase 2 window.
 * This migration removes it: filesystem is the only source of truth
 * going forward.
 *
 * Paired with code changes in:
 *   - src/db/team-store.ts (blackboard statements deleted)
 *   - src/orchestrator/ecosystem/builder.ts (boot migration deleted)
 *
 * Source: docs/plans/sqlite-joyful-lynx.md §Phase 4.
 */
import type { Database } from 'bun:sqlite';
import type { Migration } from './migration-runner.ts';

export const migration040: Migration = {
  version: 40,
  description: 'Drop team_blackboard table (filesystem is source of truth)',
  up(db: Database) {
    db.exec(`
      DROP INDEX IF EXISTS idx_team_blackboard_team_key;
      DROP TABLE IF EXISTS team_blackboard;
    `);
  },
};
