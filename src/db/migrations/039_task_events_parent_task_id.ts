/**
 * Migration 039 — Phase 2.6 audit redesign: `task_events.parent_task_id`
 * column + covering index + chunked backfill.
 *
 * Goal: replace the `json_extract(payload_json, '$.subTaskId')` scan in
 * `TaskEventStore.listChildTaskIds` with a structured-column read so
 * sub-tree pagination is O(index) not O(table-scan-and-parse).
 *
 * Idempotency / replayability — the migration is safe to re-run:
 *   1. column ADD is guarded by a `PRAGMA table_info` probe;
 *   2. index CREATE uses `IF NOT EXISTS`;
 *   3. backfill UPDATE is `WHERE parent_task_id IS NULL` so already-
 *      filled rows are skipped on a second run; rows whose parent has
 *      since been hard-deleted simply remain NULL (the orphaned event
 *      was unlinkable to begin with).
 *
 * Chunk size — backfill processes 1000 rows per UPDATE. Justification:
 * SQLite's WAL checkpoint cadence in bun:sqlite (Phase 2 settings) lands
 * around 1000 page writes; a single 50K-row UPDATE in a hot DB triggers
 * a checkpoint mid-transaction and stalls concurrent readers. 1000 rows
 * keeps each UPDATE under one checkpoint window with measured ~50ms cost
 * per chunk on a populated dev DB. Fewer rows means more transactions
 * (more overhead); more rows means fatter checkpoints. 1000 is the sweet
 * spot empirically; the loop runs until no more rows match the filter.
 */
import type { Database } from 'bun:sqlite';
import type { Migration } from './migration-runner.ts';

interface ColumnInfo {
  cid: number;
  name: string;
}

function hasColumn(db: Database, table: string, column: string): boolean {
  const rows = db.query(`PRAGMA table_info(${table})`).all() as ColumnInfo[];
  return rows.some((c) => c.name === column);
}

const BACKFILL_CHUNK = 1000;

export const migration039: Migration = {
  version: 39,
  description: 'task_events.parent_task_id + covering index + delegate-dispatched backfill',
  up(db: Database) {
    // Step 1: additive column. Guarded so a re-run is a no-op.
    if (!hasColumn(db, 'task_events', 'parent_task_id')) {
      db.exec('ALTER TABLE task_events ADD COLUMN parent_task_id TEXT');
    }

    // Step 2: covering index for sub-tree pagination + filter-by-parent
    // queries. (parent_task_id, ts, id) covers the common access pattern
    // "list all events under this parent in chronological order".
    db.exec('CREATE INDEX IF NOT EXISTS idx_task_events_parent_ts ON task_events (parent_task_id, ts, id)');

    // Step 3: chunked backfill. Each iteration fills `parent_task_id` for
    // up to BACKFILL_CHUNK sub-task rows by joining against the parent's
    // `workflow:delegate_dispatched` rows. Loop terminates when no rows
    // remain to update.
    let totalFilled = 0;
    for (;;) {
      const result = db.run(
        `UPDATE task_events
            SET parent_task_id = (
              SELECT parent.task_id
                FROM task_events AS parent
               WHERE parent.event_type = 'workflow:delegate_dispatched'
                 AND json_extract(parent.payload_json, '$.subTaskId') = task_events.task_id
               LIMIT 1
            )
          WHERE rowid IN (
            SELECT child.rowid
              FROM task_events AS child
              JOIN task_events AS dispatch
                ON dispatch.event_type = 'workflow:delegate_dispatched'
               AND json_extract(dispatch.payload_json, '$.subTaskId') = child.task_id
             WHERE child.parent_task_id IS NULL
             LIMIT ?
          )`,
        [BACKFILL_CHUNK],
      );
      const changes = result.changes ?? 0;
      totalFilled += Number(changes);
      if (changes === 0 || changes < BACKFILL_CHUNK) break;
    }
    // Diagnostic — only fires when there was actual work to do.
    if (totalFilled > 0) {
      console.log(`[vinyan] migration039: backfilled ${totalFilled} task_events.parent_task_id rows`);
    }
  },
};
