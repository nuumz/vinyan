/**
 * Migration 035 — Turn model for conversation persistence.
 *
 * Adds `session_turns` — the Anthropic-native ContentBlock[] store that
 * replaces the flat `session_messages` table. Multi-turn tool-use loops need
 * tool_use / tool_result blocks preserved verbatim so the agent does not
 * re-derive parameters on every turn.
 *
 * Hard cut-over (plan commit A): any pre-existing rows in session_store,
 * session_tasks, and session_messages are wiped. The schema shape of those
 * tables is kept so legacy code paths still compile during the sub-commit
 * sequence; a later migration will DROP the dead tables once all readers
 * have moved to session_turns.
 *
 * See /root/.claude/plans/cached-zooming-platypus.md for the full plan.
 */
import type { Database } from 'bun:sqlite';
import type { Migration } from './migration-runner.ts';

export const migration035: Migration = {
  version: 35,
  description: 'Add session_turns for turn-model conversation persistence (hard cut-over wipe)',
  up(db: Database) {
    db.exec(`
      DELETE FROM session_messages;
      DELETE FROM session_tasks;
      DELETE FROM session_store;

      CREATE TABLE IF NOT EXISTS session_turns (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES session_store(id),
        seq INTEGER NOT NULL,
        role TEXT NOT NULL CHECK(role IN ('user', 'assistant')),
        blocks_json TEXT NOT NULL,
        cancelled_at INTEGER,
        token_count_json TEXT NOT NULL,
        task_id TEXT,
        created_at INTEGER NOT NULL,
        UNIQUE(session_id, seq)
      );

      CREATE INDEX IF NOT EXISTS idx_session_turns_session_seq
        ON session_turns(session_id, seq);

      CREATE INDEX IF NOT EXISTS idx_session_turns_session_time
        ON session_turns(session_id, created_at);
    `);
  },
};
