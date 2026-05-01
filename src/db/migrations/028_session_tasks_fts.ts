/**
 * Migration 028 — FTS5 search index over `session_tasks`.
 *
 * Hermes session-storage lesson: substring `LIKE '%foo%'` does not scale
 * once the task table grows past tens of thousands of rows, and it cannot
 * express multi-token AND queries (`partial timeout` returns rows that
 * contain either word, not both). FTS5 with `porter unicode61` matches
 * the convention already used for `memory_records_fts` (mig 003) and
 * `memory_wiki_pages_fts` (mig 026), so retrieval call-sites stay
 * idiomatic.
 *
 * Indexed surface:
 *   - `searchable_text` — task_id + session_id + extracted goal. Goal
 *     is `json_extract(task_input_json, '$.goal')` so we don't tokenize
 *     the entire JSON envelope (the keys would otherwise pollute every
 *     query).
 *   - `task_id`, `session_id`, `status` — UNINDEXED columns retained on
 *     the FTS row so filter clauses (`WHERE status = 'partial'`) can be
 *     applied at the FTS layer without a join back to `session_tasks`.
 *
 * Opt-in at the call site: `SessionStore.searchTasksFts(...)` is a new
 * method; existing `listTasksFiltered({ search })` continues to use the
 * cheap LIKE path. The /api/v1/tasks handler chooses based on the
 * `searchMode=fts` query flag — no behavior change for unmigrated
 * clients.
 *
 * Backfill: existing rows are inserted in bulk after the table + triggers
 * are created. New / updated / deleted rows stay in sync via triggers.
 */
import type { Database } from 'bun:sqlite';
import type { Migration } from './migration-runner.ts';

export const migration028: Migration = {
  version: 28,
  description: 'session_tasks FTS5 search index (multi-token, BM25-ranked)',
  up(db: Database) {
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS session_tasks_fts USING fts5(
        task_id UNINDEXED,
        session_id UNINDEXED,
        status UNINDEXED,
        searchable_text,
        tokenize = 'porter unicode61'
      );

      -- Backfill: combine task_id + session_id + extracted goal so a free
      -- text search hits the operator-visible surface. COALESCE so a NULL
      -- goal does not produce a literal "null" token in the index.
      INSERT INTO session_tasks_fts (task_id, session_id, status, searchable_text)
      SELECT
        task_id,
        session_id,
        status,
        COALESCE(task_id, '')
          || ' ' || COALESCE(session_id, '')
          || ' ' || COALESCE(json_extract(task_input_json, '$.goal'), '')
      FROM session_tasks;

      -- INSERT trigger — index a new row using the same projection as
      -- backfill so the two paths cannot drift.
      CREATE TRIGGER IF NOT EXISTS session_tasks_fts_ai
      AFTER INSERT ON session_tasks BEGIN
        INSERT INTO session_tasks_fts (task_id, session_id, status, searchable_text)
        VALUES (
          new.task_id,
          new.session_id,
          new.status,
          COALESCE(new.task_id, '')
            || ' ' || COALESCE(new.session_id, '')
            || ' ' || COALESCE(json_extract(new.task_input_json, '$.goal'), '')
        );
      END;

      -- DELETE trigger — keep FTS in lockstep when a row is hard-deleted
      -- (session purge, test cleanup). Match by (session_id, task_id) which
      -- is the effective unique key on session_tasks.
      CREATE TRIGGER IF NOT EXISTS session_tasks_fts_ad
      AFTER DELETE ON session_tasks BEGIN
        DELETE FROM session_tasks_fts
        WHERE task_id = old.task_id AND session_id = old.session_id;
      END;

      -- UPDATE trigger — status transitions are the dominant write path
      -- (pending → running → completed/cancelled). Refresh status +
      -- searchable_text so a status filter stays accurate.
      CREATE TRIGGER IF NOT EXISTS session_tasks_fts_au
      AFTER UPDATE ON session_tasks BEGIN
        UPDATE session_tasks_fts
           SET status = new.status,
               searchable_text =
                 COALESCE(new.task_id, '')
                   || ' ' || COALESCE(new.session_id, '')
                   || ' ' || COALESCE(json_extract(new.task_input_json, '$.goal'), '')
         WHERE task_id = old.task_id AND session_id = old.session_id;
      END;
    `);
  },
};
