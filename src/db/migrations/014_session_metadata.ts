/**
 * Migration 014 — session metadata + archive/soft-delete columns.
 *
 * Adds operator-grade session affordances expected by the UI:
 *   - title / description: human-friendly identifiers and context that
 *     can be surfaced to the agent as auxiliary grounding (NOT a goal
 *     rewrite, NOT a routing input — A1/A3 compliant).
 *   - archived_at: epoch-ms timestamp; non-null means the session is
 *     hidden from the default "active" list but still readable.
 *   - deleted_at: epoch-ms timestamp; non-null means soft-deleted
 *     (Trash). Audit trail (turns, tasks, traces) is preserved.
 *
 * All columns are nullable — existing rows remain valid without a
 * default value. We add filtered indexes so the common list queries
 * (active, archived, trash) avoid a full table scan once the
 * `session_store` row count grows.
 */
import type { Database } from 'bun:sqlite';
import type { Migration } from './migration-runner.ts';

interface PragmaColumn {
  name: string;
}

function hasColumn(db: Database, table: string, column: string): boolean {
  const rows = db.query(`PRAGMA table_info(${table})`).all() as PragmaColumn[];
  return rows.some((r) => r.name === column);
}

export const migration014: Migration = {
  version: 14,
  description: 'Session metadata: title/description + archived_at/deleted_at',
  up(db: Database) {
    if (!hasColumn(db, 'session_store', 'title')) {
      db.exec('ALTER TABLE session_store ADD COLUMN title TEXT');
    }
    if (!hasColumn(db, 'session_store', 'description')) {
      db.exec('ALTER TABLE session_store ADD COLUMN description TEXT');
    }
    if (!hasColumn(db, 'session_store', 'archived_at')) {
      db.exec('ALTER TABLE session_store ADD COLUMN archived_at INTEGER');
    }
    if (!hasColumn(db, 'session_store', 'deleted_at')) {
      db.exec('ALTER TABLE session_store ADD COLUMN deleted_at INTEGER');
    }

    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_ss_archived_at ON session_store(archived_at);
      CREATE INDEX IF NOT EXISTS idx_ss_deleted_at ON session_store(deleted_at);
      CREATE INDEX IF NOT EXISTS idx_ss_updated_at ON session_store(updated_at);
    `);
  },
};
