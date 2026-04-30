/**
 * Migration 024 — External Coding CLI persistence.
 *
 * Tables:
 *   - coding_cli_sessions: one row per task-bound session, with provider id,
 *     binary metadata, capabilities snapshot, lifecycle timestamps, and the
 *     final result envelope (untrusted, A1) the CLI emitted.
 *   - coding_cli_events: append-only normalized event log per session
 *     (mirrors task_events but keyed on coding_cli_session_id so replay can
 *     reconstruct process state without depending on the global task event
 *     stream).
 *   - coding_cli_approvals: every permission request the CLI raised, with
 *     policy decision, human decision, and decided-by metadata for replay
 *     (A8).
 *   - coding_cli_decisions: structured decisions the CLI claimed in its
 *     result envelope, captured for audit (A8).
 */
import type { Database } from 'bun:sqlite';
import type { Migration } from './migration-runner.ts';

export const CODING_CLI_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS coding_cli_sessions (
  id                      TEXT PRIMARY KEY,
  task_id                 TEXT NOT NULL,
  session_id              TEXT,
  provider_id             TEXT NOT NULL,
  binary_path             TEXT NOT NULL,
  binary_version          TEXT,
  capabilities_json       TEXT NOT NULL,
  cwd                     TEXT NOT NULL,
  pid                     INTEGER,
  state                   TEXT NOT NULL,
  started_at              INTEGER NOT NULL,
  updated_at              INTEGER NOT NULL,
  ended_at                INTEGER,
  last_output_at          INTEGER,
  last_hook_at            INTEGER,
  transcript_path         TEXT,
  event_log_path          TEXT,
  files_changed_json      TEXT NOT NULL DEFAULT '[]',
  commands_requested_json TEXT NOT NULL DEFAULT '[]',
  final_result_json       TEXT,
  raw_meta_json           TEXT NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_coding_cli_sessions_task
  ON coding_cli_sessions (task_id);

CREATE INDEX IF NOT EXISTS idx_coding_cli_sessions_session
  ON coding_cli_sessions (session_id);

CREATE INDEX IF NOT EXISTS idx_coding_cli_sessions_state
  ON coding_cli_sessions (state, updated_at);

CREATE TABLE IF NOT EXISTS coding_cli_events (
  id                      TEXT PRIMARY KEY,
  coding_cli_session_id   TEXT NOT NULL,
  task_id                 TEXT NOT NULL,
  seq                     INTEGER NOT NULL,
  event_type              TEXT NOT NULL,
  payload_json            TEXT NOT NULL,
  ts                      INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_coding_cli_events_session_seq
  ON coding_cli_events (coding_cli_session_id, seq);

CREATE INDEX IF NOT EXISTS idx_coding_cli_events_task_ts
  ON coding_cli_events (task_id, ts);

CREATE TABLE IF NOT EXISTS coding_cli_approvals (
  id                      TEXT PRIMARY KEY,
  coding_cli_session_id   TEXT NOT NULL,
  task_id                 TEXT NOT NULL,
  request_id              TEXT NOT NULL,
  command                 TEXT NOT NULL,
  reason                  TEXT NOT NULL,
  policy_decision         TEXT NOT NULL,
  human_decision          TEXT,
  decided_by              TEXT,
  decided_at              INTEGER,
  requested_at            INTEGER NOT NULL,
  raw_json                TEXT NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_coding_cli_approvals_session
  ON coding_cli_approvals (coding_cli_session_id);

CREATE INDEX IF NOT EXISTS idx_coding_cli_approvals_request
  ON coding_cli_approvals (task_id, request_id);

CREATE TABLE IF NOT EXISTS coding_cli_decisions (
  id                      TEXT PRIMARY KEY,
  coding_cli_session_id   TEXT NOT NULL,
  task_id                 TEXT NOT NULL,
  decision                TEXT NOT NULL,
  rationale               TEXT NOT NULL,
  alternatives_json       TEXT NOT NULL DEFAULT '[]',
  ts                      INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_coding_cli_decisions_session
  ON coding_cli_decisions (coding_cli_session_id, ts);
`;

export const migration024: Migration = {
  version: 24,
  description: 'External Coding CLI session/event/approval/decision persistence',
  up(db: Database) {
    db.exec(CODING_CLI_SCHEMA_SQL);
  },
};
