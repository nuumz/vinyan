/**
 * Migration 038 — Phase 4 destructive: drop blob columns from session_store.
 *
 * Removes `working_memory_json` and `compaction_json` from `session_store`.
 * After Phase 2 dual-write, both blobs have JSONL representatives
 * (`working-memory.snapshot`, `session.compacted`); after Phase 3 reads
 * route through the adapter; this migration retires the SQLite cache.
 *
 * **NOT registered in `ALL_MIGRATIONS`**. Applied via `vinyan session
 * migrate-phase4` only — same gate as migration 037.
 *
 * SQLite limitations:
 *   `ALTER TABLE … DROP COLUMN` is supported in SQLite ≥ 3.35.0 (2021).
 *   We rely on Bun's bundled SQLite (≥ 3.43) so a direct `DROP COLUMN`
 *   is fine. We still wrap each drop in `IF EXISTS`-style guards via a
 *   PRAGMA probe to keep the migration idempotent — a partial re-run
 *   (e.g. interrupted between the two drops) must converge.
 *
 * Companion to migration 037 (drops `session_turns`).
 */
import type { Database } from 'bun:sqlite';
import type { Migration } from './migration-runner.ts';

interface ColumnInfo {
  name: string;
}

function hasColumn(db: Database, table: string, column: string): boolean {
  const cols = db.query(`PRAGMA table_info(${table})`).all() as ColumnInfo[];
  return cols.some((c) => c.name === column);
}

export const migration038: Migration = {
  version: 38,
  description: 'Phase 4: drop session_store blob columns (working_memory_json, compaction_json)',
  up(db: Database) {
    if (hasColumn(db, 'session_store', 'working_memory_json')) {
      db.exec('ALTER TABLE session_store DROP COLUMN working_memory_json');
    }
    if (hasColumn(db, 'session_store', 'compaction_json')) {
      db.exec('ALTER TABLE session_store DROP COLUMN compaction_json');
    }
  },
};
