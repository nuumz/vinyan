/**
 * Migration 025 — Backfill `task_events.session_id` for rows that landed as NULL.
 *
 * Background. Several emitters (workflow-executor's `agent:plan_update` /
 * `workflow:plan_ready` / `workflow:delegate_dispatched`, agent-loop
 * sub-paths) historically didn't include `sessionId` on the payload. The
 * recorder's `extractIds` returned `sessionId=undefined` for those events
 * and the row was inserted with `session_id=NULL`. The task-tree query at
 * `/tasks/:id/event-history?includeDescendants=true` filters by
 * `session_id = ?`, so NULL rows were silently excluded from replay —
 * the chat UI's HistoricalProcessCard rendered with an empty body
 * (no plan checklist, no sub-agent rows, no process timeline).
 *
 * Forward fix lives in the recorder (taskId→sessionId cache populated
 * from `task:start` and applied as a fallback). This migration is the
 * matching one-shot backfill so old data the user can already see in
 * the chat history starts rendering correctly too.
 *
 * Strategy: for every task_id that has at least one non-NULL session_id
 * row, copy that session_id onto every NULL row for the same task_id.
 * If a task_id has zero non-NULL rows, those rows remain NULL — there's
 * no source of truth to recover from.
 */
import type { Database } from 'bun:sqlite';
import type { Migration } from './migration-runner.ts';

export const migration025: Migration = {
  version: 25,
  description: 'Backfill task_events.session_id from sibling rows for the same task',
  up(db: Database) {
    db.exec(`
      UPDATE task_events
         SET session_id = (
           SELECT t2.session_id
             FROM task_events t2
            WHERE t2.task_id = task_events.task_id
              AND t2.session_id IS NOT NULL
            LIMIT 1
         )
       WHERE session_id IS NULL
         AND EXISTS (
           SELECT 1 FROM task_events t3
            WHERE t3.task_id = task_events.task_id
              AND t3.session_id IS NOT NULL
         );
    `);
  },
};
