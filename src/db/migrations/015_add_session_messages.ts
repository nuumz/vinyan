/**
 * Migration 015 — Session messages for Conversation Agent Mode.
 *
 * Stores per-turn conversation entries (user messages + assistant responses)
 * linked to a session. Lightweight alternative to session_tasks for chat history.
 */
import type { Database } from 'bun:sqlite';
import type { Migration } from './migration-runner.ts';

export const migration015: Migration = {
  version: 15,
  description: 'Add session_messages for conversation agent mode',
  up(db: Database) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS session_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL REFERENCES session_store(id),
        task_id TEXT,
        role TEXT NOT NULL CHECK(role IN ('user', 'assistant', 'system')),
        content TEXT NOT NULL,
        thinking TEXT,
        tools_used TEXT,
        token_estimate INTEGER DEFAULT 0,
        created_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_session_messages_session_time
        ON session_messages(session_id, created_at);
    `);
  },
};
