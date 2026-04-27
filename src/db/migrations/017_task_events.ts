/**
 * Migration 017 — Persist curated bus events per task.
 *
 * Stores the same event allow-list that flows through SSE today
 * (`src/api/sse.ts` → `SSE_EVENTS`) so historical UI can replay the per-turn
 * process timeline (thinking, plan updates, tool calls, oracle verdicts,
 * routing/synthesis, capability research) after page reload — not just
 * during the live stream.
 *
 * Append-only, indexed by (task_id, seq). Payload retained verbatim as
 * JSON for deterministic replay; size capped per row by the recorder
 * (recorder truncates oversized payloads, never the table).
 */
import type { Database } from 'bun:sqlite';
import type { Migration } from './migration-runner.ts';

export const TASK_EVENTS_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS task_events (
  id           TEXT    PRIMARY KEY,
  task_id      TEXT    NOT NULL,
  session_id   TEXT,
  seq          INTEGER NOT NULL,
  event_type   TEXT    NOT NULL,
  payload_json TEXT    NOT NULL,
  ts           INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_task_events_task_seq
  ON task_events (task_id, seq);

CREATE INDEX IF NOT EXISTS idx_task_events_session_ts
  ON task_events (session_id, ts);
`;

export const migration017: Migration = {
  version: 17,
  description: 'Persist curated bus events per task for historical process replay',
  up(db: Database) {
    db.exec(TASK_EVENTS_SCHEMA_SQL);
  },
};
