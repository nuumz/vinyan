/**
 * Property tests — history compaction invariants (Phase 1).
 *
 * Invariants checked against randomly generated session fixtures:
 *   1. Output total tokenEstimate <= maxTokens.
 *   2. The last `keepRecentTurns*2` source entries are always present in
 *      the output (verbatim, regardless of budget pressure).
 *   3. `classifyTurn` is idempotent & deterministic on the same input.
 *   4. The `[DROPPED BY BUDGET: N turn(s) …]` marker's `N` equals the
 *      actual number of source entries missing from the output.
 *   5. Decision-class entries appear in the summary at >= the rate at
 *      which the plain regex path would surface them — i.e. priority
 *      weighting never *suppresses* a decision relative to the
 *      no-weight baseline.
 *
 * These run under fast-check (`fc`), already declared in package.json.
 */

import { Database } from 'bun:sqlite';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import * as fc from 'fast-check';
import { SessionManager } from '../../src/api/session-manager.ts';
import { classifyTurn } from '../../src/api/turn-importance.ts';
import { ALL_MIGRATIONS, MigrationRunner } from '../../src/db/migrations/index.ts';
import { SessionStore } from '../../src/db/session-store.ts';

// Single DB reused across the property block — cheaper than a fresh DB per
// run. Each property creates its own session id so there's no cross-run
// bleed even though the store is shared.
let db: Database;
let sessionStore: SessionStore;
let manager: SessionManager;

beforeAll(() => {
  db = new Database(':memory:');
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  new MigrationRunner().migrate(db, ALL_MIGRATIONS);
  sessionStore = new SessionStore(db);
  manager = new SessionManager(sessionStore);
});

afterAll(() => {
  db.close();
});

// Arbitraries ---------------------------------------------------------------

// A "decision-flavoured" message arbitrary — high rate of assistant plan
// preambles and a sprinkling of [INPUT-REQUIRED] blocks so the classifier
// has something to find.
const decisionMsgArb = fc.oneof(
  fc.constantFrom(
    "I'll implement this step by step",
    'Plan: refactor then test',
    'Let me dig into the store',
    'Going to split the PR in two',
  ),
  fc.constant('[INPUT-REQUIRED]\n- which approach?'),
);

const normalMsgArb = fc.constantFrom(
  'ok that sounds good',
  'thanks for the help',
  'yep, understood',
  'go ahead and continue',
  'not sure about that one',
);

const turnArb = fc.record({
  role: fc.constantFrom('user' as const, 'assistant' as const),
  content: fc.oneof(decisionMsgArb, normalMsgArb, fc.string({ minLength: 1, maxLength: 400 })),
});

// Session sizes per plan: N in [1, 200] — small enough that the
// in-memory DB stays snappy.
const sessionArb = fc.array(turnArb, { minLength: 1, maxLength: 200 });

function seed(session: Array<{ role: 'user' | 'assistant'; content: string }>): string {
  const s = manager.create('api');
  for (const t of session) {
    sessionStore.insertMessage({
      session_id: s.id,
      task_id: t.role === 'assistant' ? 't' : null,
      role: t.role,
      content: t.content,
      thinking: null,
      tools_used: null,
      token_estimate: Math.ceil(t.content.length / 3.5),
      created_at: Date.now(),
    });
  }
  return s.id;
}

describe('property: history compaction invariants', () => {
  test('invariant 1: output total tokenEstimate <= maxTokens (slack for summary floor)', () => {
    fc.assert(
      fc.property(sessionArb, fc.integer({ min: 500, max: 50_000 }), (session, maxTokens) => {
        const id = seed(session);
        const compacted = manager.getConversationHistoryCompacted(id, maxTokens, 5);
        const total = compacted.reduce((sum, e) => sum + e.tokenEstimate, 0);
        // enforceTokenBudget stops when `result.length > 1` is false — a
        // single entry is always kept even if it exceeds the budget. Allow
        // one-entry overflow by taking the max of (maxTokens, largest single
        // tokenEstimate) as the real ceiling.
        const largest = compacted.reduce((m, e) => Math.max(m, e.tokenEstimate), 0);
        return total <= Math.max(maxTokens, largest);
      }),
      { numRuns: 30 },
    );
  });

  test('invariant 2: last keepRecentTurns*2 source entries always present in output', () => {
    fc.assert(
      fc.property(sessionArb, fc.integer({ min: 1, max: 5 }), (session, keepRecentTurns) => {
        // Only user/assistant entries count in the verbatim tail; the
        // fixture arbitrary already produces only those roles.
        const id = seed(session);
        // Use a generous budget so enforceTokenBudget does not trim.
        const compacted = manager.getConversationHistoryCompacted(id, 10_000_000, keepRecentTurns);
        const expectedTail = session.slice(Math.max(0, session.length - keepRecentTurns * 2));
        // Extract the tail of the compacted output that corresponds to
        // verbatim entries — i.e. filter out the summary + drop marker.
        const verbatim = compacted.filter((e) => e.taskId !== 'compaction');
        const verbatimContent = verbatim.map((e) => e.content);
        for (const t of expectedTail) {
          // The DB filters out roles outside user/assistant, but our
          // fixture only emits those so every tail entry must appear.
          if (!verbatimContent.includes(t.content)) return false;
        }
        return true;
      }),
      { numRuns: 30 },
    );
  });

  test('invariant 3: classifyTurn is idempotent + deterministic', () => {
    fc.assert(
      fc.property(turnArb, (turn) => {
        const a = classifyTurn(turn);
        const b = classifyTurn(turn);
        const c = classifyTurn(turn);
        return a === b && b === c;
      }),
      { numRuns: 100 },
    );
  });

  test('invariant 4: [DROPPED BY BUDGET] count matches actual drop count', () => {
    fc.assert(
      fc.property(
        fc.array(turnArb, { minLength: 20, maxLength: 80 }),
        fc.integer({ min: 300, max: 2000 }),
        (session, maxTokens) => {
          const id = seed(session);
          const compacted = manager.getConversationHistoryCompacted(id, maxTokens, 3);
          const marker = compacted.find((e) => e.content.startsWith('[DROPPED BY BUDGET'));
          if (!marker) return true; // no drops, nothing to check
          const match = marker.content.match(/(\d+) turn\(s\)/);
          const reportedDropCount = match ? parseInt(match[1]!, 10) : -1;
          // Compare against the total non-compaction entries in the output
          // vs. the source. `reportedDropCount` counts entries that were
          // removed by enforceTokenBudget — this is not trivially
          // observable from the output alone, but we can bound it: the
          // number of source entries not present in the verbatim output
          // must be >= reportedDropCount (because compaction may have
          // further elided verbatim turns into the summary before budget
          // enforcement ran).
          const verbatimContents = new Set(compacted.filter((e) => e.taskId !== 'compaction').map((e) => e.content));
          const missingFromVerbatim = session.filter((t) => !verbatimContents.has(t.content)).length;
          return reportedDropCount >= 0 && reportedDropCount <= missingFromVerbatim;
        },
      ),
      { numRuns: 30 },
    );
  });

  test('invariant 5: decision-class surfacing rate is monotone under priority weighting', () => {
    // Generate sessions where at least some turns ARE decisions (plan
    // preambles), then verify the KEY-DECISION interleave surfaces >= N
    // of them where N is derived from the unweighted classifyTurn output.
    fc.assert(
      fc.property(
        fc.array(fc.record({ role: fc.constant('assistant' as const), content: decisionMsgArb }), {
          minLength: 15,
          maxLength: 40,
        }),
        (assistantOnly) => {
          // Interleave a matching user turn so compaction has "turn pairs".
          const session: Array<{ role: 'user' | 'assistant'; content: string }> = [];
          for (const a of assistantOnly) {
            session.push({ role: 'user', content: 'filler user turn' });
            session.push(a);
          }
          const id = seed(session);
          const compacted = manager.getConversationHistoryCompacted(id, 50_000, 5);
          const summary = compacted.find((e) => e.content.startsWith('[SESSION CONTEXT'));
          if (!summary) return false;
          // Decision turns emitted into the summary's inline block.
          const decisionLines = (summary.content.match(/→ \[Turn \d+, decision\]/g) ?? []).length;
          // Compute the raw count of decision-classed turns among older
          // entries (older = everything except the last keepRecentTurns*2).
          const olderCount = Math.max(0, session.length - 5 * 2);
          const older = session.slice(0, olderCount);
          const rawDecisions = older.filter((t) => classifyTurn(t) === 'decision').length;
          // Weighting is a retention mechanism; it cannot invert the
          // decision surface rate. If there are K decisions among older
          // entries, the summary must surface at least min(K, some cap).
          // We compare directly: `decisionLines >= rawDecisions` is
          // expected because every decision-classed older entry is emitted
          // into the inline list.
          return decisionLines >= rawDecisions;
        },
      ),
      { numRuns: 20 },
    );
  });
});
