/**
 * Migration 036 — JSONL source-of-truth index columns.
 *
 * Phase 1 of the Hybrid Session Storage migration (see
 * `~/.claude/plans/hybrid-model-tranquil-deer.md`). Purely additive:
 *
 *   - `session_store` gains three nullable columns that record where
 *     the JSONL writer left off:
 *       last_line_id      TEXT       lineId of the most recent append
 *       last_line_offset  INTEGER    byte offset just past that append
 *       active_segment    TEXT       segment filename (Phase 5: rotation)
 *
 *   - `session_turn_summary` (new table) replaces the per-listSessions
 *     window function in `session-store.ts:243-247`. One row per
 *     session, denormalized hot-path read.
 *
 * Phase 1 only creates the schema; nothing writes to these columns
 * yet. Phase 2 (dual-write) wires `JsonlAppender` to populate them on
 * every append. Phase 3 (read-from-JSONL) makes them load-bearing.
 *
 * Safety / axioms:
 *   - A3 deterministic. SQL only; no LLM in the migration path.
 *   - A9 resilient. Idempotent — column-presence check guards the
 *     ALTER TABLE statements (SQLite has no ADD COLUMN IF NOT EXISTS).
 */
import type { Database } from 'bun:sqlite';
import type { Migration } from './migration-runner.ts';

interface ColumnInfo {
  cid: number;
  name: string;
  type: string;
}

function hasColumn(db: Database, table: string, column: string): boolean {
  const rows = db.query(`PRAGMA table_info(${table})`).all() as ColumnInfo[];
  return rows.some((c) => c.name === column);
}

export const migration036: Migration = {
  version: 36,
  description: 'Session JSONL index columns + session_turn_summary table',
  up(db: Database) {
    if (!hasColumn(db, 'session_store', 'last_line_id')) {
      db.exec('ALTER TABLE session_store ADD COLUMN last_line_id TEXT');
    }
    if (!hasColumn(db, 'session_store', 'last_line_offset')) {
      db.exec('ALTER TABLE session_store ADD COLUMN last_line_offset INTEGER');
    }
    if (!hasColumn(db, 'session_store', 'active_segment')) {
      db.exec('ALTER TABLE session_store ADD COLUMN active_segment TEXT');
    }

    db.exec(`
      CREATE TABLE IF NOT EXISTS session_turn_summary (
        session_id                  TEXT PRIMARY KEY REFERENCES session_store(id),
        latest_seq                  INTEGER,
        latest_turn_id              TEXT,
        latest_turn_role            TEXT CHECK(latest_turn_role IN ('user','assistant')),
        latest_turn_blocks_preview  TEXT,
        turn_count                  INTEGER NOT NULL DEFAULT 0,
        updated_at                  INTEGER NOT NULL
      );
    `);
    db.exec('CREATE INDEX IF NOT EXISTS idx_sts_updated_at ON session_turn_summary(updated_at)');
  },
};
