/**
 * Migration 037 — Drop the legacy session_messages table (plan commit A7).
 *
 * session_messages was the original flat-string conversation store that
 * backed the ConversationEntry type. A1-A6 migrated every prompt-assembly,
 * worker, agent-loop, and comprehension path onto the Anthropic-native
 * Turn model (session_turns, ContentBlock[]). A7 is the final cut-over:
 * the table has no remaining readers, the SessionStore methods
 * (insertMessage, getMessages, getRecentMessages, countMessages) are
 * deleted, and this migration drops the schema.
 *
 * Hard cut-over semantics match migration 035: all session_messages rows
 * disappear. That's intentional — the Turn model has already indexed
 * everything worth keeping via SessionManager.recordUserTurn /
 * recordAssistantTurn since Commit A.
 */
import type { Database } from 'bun:sqlite';
import type { Migration } from './migration-runner.ts';

export const migration037: Migration = {
  version: 37,
  description: 'Drop legacy session_messages table (Turn model is now the only conversation path)',
  up(db: Database) {
    db.exec(`
      DROP INDEX IF EXISTS idx_session_messages_session_time;
      DROP TABLE IF EXISTS session_messages;
    `);
  },
};
