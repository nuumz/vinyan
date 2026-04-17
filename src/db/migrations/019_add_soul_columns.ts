/**
 * Migration 019 — Add soul columns to agent_contexts table.
 *
 * Adds:
 *   - soul_md: denormalized cache of the SOUL.md content (filesystem is source of truth)
 *   - soul_version: monotonic version counter for drift dampening
 *   - pending_insights: JSON array of PendingInsight from per-task reflections
 */
import type { Database } from 'bun:sqlite';
import type { Migration } from './migration-runner.ts';

export const migration019: Migration = {
  version: 19,
  description: 'Add soul_md, soul_version, and pending_insights columns to agent_contexts',
  up(db: Database) {
    // Idempotent ALTER TABLE — check if columns exist before adding
    const cols = db.prepare("PRAGMA table_info('agent_contexts')").all() as Array<{ name: string }>;
    const colNames = new Set(cols.map((c) => c.name));

    if (!colNames.has('soul_md')) {
      db.exec(`ALTER TABLE agent_contexts ADD COLUMN soul_md TEXT DEFAULT NULL`);
    }
    if (!colNames.has('soul_version')) {
      db.exec(`ALTER TABLE agent_contexts ADD COLUMN soul_version INTEGER NOT NULL DEFAULT 0`);
    }
    if (!colNames.has('pending_insights')) {
      db.exec(`ALTER TABLE agent_contexts ADD COLUMN pending_insights TEXT NOT NULL DEFAULT '[]'`);
    }
  },
};
