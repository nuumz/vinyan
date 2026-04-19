/**
 * Golden snapshot — history compaction block shape (Phase 1).
 *
 * Pins the `[SESSION CONTEXT …]` summary emitted by
 * `SessionManager.getConversationHistoryCompacted` for a hand-curated
 * 30-turn fixture so any future rewording of the header, topic list,
 * clarification lines, or inline KEY-DECISION interleave produces a
 * reviewable diff in `__snapshots__/history-compaction.test.ts.snap`.
 *
 * Deterministic: all content is hand-written, timestamps are fixed via
 * the sqlite `:memory:` database's monotonic Date.now() — we only
 * snapshot the *content* of the summary entry, not timestamps.
 */

import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { SessionManager } from '../../src/api/session-manager.ts';
import { ALL_MIGRATIONS, MigrationRunner } from '../../src/db/migrations/index.ts';
import { SessionStore } from '../../src/db/session-store.ts';

let db: Database;
let sessionStore: SessionStore;
let manager: SessionManager;

beforeEach(() => {
  db = new Database(':memory:');
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  new MigrationRunner().migrate(db, ALL_MIGRATIONS);
  sessionStore = new SessionStore(db);
  manager = new SessionManager(sessionStore);
});

afterEach(() => {
  db.close();
});

/**
 * 30-turn fixture (15 user + 15 assistant messages). Covers:
 *  - decision turns (plan preambles, negation+alt),
 *  - tool-result turns (toolsUsed on assistant),
 *  - [INPUT-REQUIRED] pairs (one resolved, one open-ish but resolved
 *    by the very next user turn),
 *  - normal chit-chat.
 */
const FIXTURE: Array<{ role: 'user' | 'assistant'; content: string; toolsUsed?: string[] }> = [
  { role: 'user', content: 'help me design a session-memory system' },
  { role: 'assistant', content: "I'll draft a 4-layer compression plan starting with the DB layer" },
  { role: 'user', content: 'what files are involved' },
  { role: 'assistant', content: 'we will touch src/api/session-manager.ts and src/db/session-store.ts' },
  { role: 'user', content: 'go ahead' },
  {
    role: 'assistant',
    content: 'reading session-manager.ts for the getConversationHistoryCompacted function',
    toolsUsed: ['file_read'],
  },
  { role: 'user', content: 'any issues?' },
  {
    role: 'assistant',
    content:
      '[INPUT-REQUIRED]\n- should priority cap be 30% or 40% of maxTokens?\n- do we need a separate drop marker?',
  },
  { role: 'user', content: '40% cap, yes to drop marker' },
  { role: 'assistant', content: 'Plan: 40% priority cap, inline drop marker, done' },
  { role: 'user', content: 'sounds good' },
  { role: 'assistant', content: 'running tests for session-manager', toolsUsed: ['shell_exec'] },
  { role: 'user', content: 'ใช้ postgres for store persistence please' },
  {
    role: 'assistant',
    content: 'Going to switch the store backend to postgres and update tests accordingly',
  },
  { role: 'user', content: 'not redis — use postgres everywhere' },
  { role: 'assistant', content: 'Let me audit each adapter and flip them' },
  { role: 'user', content: 'thanks' },
  { role: 'assistant', content: 'no problem, here are the three modified files' },
  { role: 'user', content: 'what about tests/api/session-manager.test.ts' },
  { role: 'assistant', content: 'already covered — 15 tests green' },
  { role: 'user', content: 'any docs to update' },
  {
    role: 'assistant',
    content: 'docs/design/session-memory.md has the architecture diagram',
  },
  { role: 'user', content: 'can you summarize the plan so far' },
  { role: 'assistant', content: 'classifier, weighted budget, drop marker, transparency header' },
  { role: 'user', content: 'what is next' },
  { role: 'assistant', content: 'golden snapshot test and then regression run' },
  { role: 'user', content: 'ok' },
  { role: 'assistant', content: 'starting the snapshot fixture now' },
  { role: 'user', content: 'final review please' },
  { role: 'assistant', content: 'looks good — merging to the feature branch' },
];

describe('Golden: history compaction summary', () => {
  test('30-turn fixture summary shape', () => {
    const s = manager.create('api');
    for (const entry of FIXTURE) {
      sessionStore.insertMessage({
        session_id: s.id,
        task_id: entry.role === 'assistant' ? 't' : null,
        role: entry.role,
        content: entry.content,
        thinking: null,
        tools_used: entry.toolsUsed ? JSON.stringify(entry.toolsUsed) : null,
        token_estimate: Math.ceil(entry.content.length / 3.5),
        created_at: Date.now(),
      });
    }
    const compacted = manager.getConversationHistoryCompacted(s.id, 50_000, 5);
    const summary = compacted.find((e) => e.content.startsWith('[SESSION CONTEXT'));
    expect(summary).toBeDefined();
    // Snapshot ONLY the summary content — recent turns and drop markers are
    // covered by dedicated unit tests and we want the golden diff to focus
    // on the compaction shape.
    expect(summary!.content).toMatchSnapshot();
  });
});
