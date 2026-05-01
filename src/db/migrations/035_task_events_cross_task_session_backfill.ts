/**
 * Migration 035 — recover `task_events.session_id` for descendant rows
 * that have no sibling row to copy from.
 *
 * Background. Migration 025 backfills NULL `session_id` from a sibling
 * row of the same `task_id`. That works when the recorder later wrote
 * at least one non-NULL row for the task (e.g. a delayed `task:start`
 * arriving after the inner orchestrator's first `agent:tool_*`). It
 * does NOT recover the case where EVERY row for a child task landed
 * NULL — typically because the child was a delegate sub-task whose own
 * `task:start` never carried `sessionId` (or never fired at all in the
 * pre-`a3e9c41` recorder, which had no sub-task session pre-seed on
 * `workflow:delegate_dispatched`).
 *
 * The forward fix lives in two places:
 *   - `task-event-recorder.ts` pre-seeds `sessionByTask[subTaskId] =
 *     parent.sessionId` the moment `workflow:delegate_dispatched` is
 *     recorded (commit `a3e9c41`).
 *   - `vinyan-ui/src/lib/replay-process-log.ts` backfills
 *     `payload.taskId` from the row-level `taskId` so the reducer's
 *     subTaskIdIndex lookup always has a key (commit landing with this
 *     migration).
 *
 * This migration is the matching one-shot historical recovery so chat
 * history that already lost the join key starts rendering correctly
 * after upgrade — no operator action required, no UI masking.
 *
 * Strategy. Walk the delegation graph rooted at `workflow:delegate_
 * dispatched` events whose own `session_id` is non-NULL. The parent's
 * `session_id` is the recorded session of the dispatching task; the
 * child taskId comes from `payload.subTaskId`. Every NULL row whose
 * `task_id` matches a discovered child gets the parent's session_id.
 * Re-run the pass until no further row updates land — handles nested
 * workflows (parent → child → grandchild) where the child itself was
 * NULL on the first sweep.
 *
 * Safety / axioms:
 *   - A3 deterministic. SQL has no LLM in the path; idempotent.
 *   - A4 content-addressed. We only set session_id from a row that
 *     already carries the authoritative parent session_id (the
 *     recorder wrote it from `task:start.input.sessionId`).
 *   - A8 traceable. Never overwrites a non-NULL session_id; only
 *     fills NULLs. Cross-session leakage is impossible: the parent's
 *     `session_id` is bound to its own recorded events, and every
 *     descendant inherits the same session by orchestrator contract.
 *   - A9 idempotent. The loop is bounded (`MAX_PASSES`) and converges
 *     when the pass updates zero rows.
 */
import type { Database } from 'bun:sqlite';
import type { Migration } from './migration-runner.ts';

const MAX_PASSES = 16;

const COUNT_NULL_SQL = `SELECT COUNT(*) AS n FROM task_events WHERE session_id IS NULL`;

const BACKFILL_SQL = `
  UPDATE task_events
     SET session_id = (
       SELECT te2.session_id
         FROM task_events te2
        WHERE te2.event_type = 'workflow:delegate_dispatched'
          AND te2.session_id IS NOT NULL
          AND json_extract(te2.payload_json, '$.subTaskId') = task_events.task_id
        ORDER BY te2.seq ASC
        LIMIT 1
     )
   WHERE session_id IS NULL
     AND EXISTS (
       SELECT 1 FROM task_events te2
        WHERE te2.event_type = 'workflow:delegate_dispatched'
          AND te2.session_id IS NOT NULL
          AND json_extract(te2.payload_json, '$.subTaskId') = task_events.task_id
     );
`;

export const migration035: Migration = {
  version: 35,
  description: 'Backfill task_events.session_id for descendants via parent workflow:delegate_dispatched',
  up(db: Database) {
    const stmt = db.prepare(BACKFILL_SQL);
    const countStmt = db.query<{ n: number }, []>(COUNT_NULL_SQL);
    let lastNullCount = (countStmt.get() as { n: number } | null)?.n ?? 0;
    if (lastNullCount === 0) return;
    for (let pass = 0; pass < MAX_PASSES; pass++) {
      stmt.run();
      const nowNullCount = (countStmt.get() as { n: number } | null)?.n ?? 0;
      if (nowNullCount === lastNullCount) break;
      lastNullCount = nowNullCount;
    }
  },
};
