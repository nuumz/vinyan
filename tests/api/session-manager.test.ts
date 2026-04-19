/**
 * Session Manager Tests — lifecycle, compaction, I16 audit preservation
 */

import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { SessionManager } from '../../src/api/session-manager.ts';
import { ALL_MIGRATIONS, MigrationRunner } from '../../src/db/migrations/index.ts';
import { SessionStore } from '../../src/db/session-store.ts';
import type { TaskInput, TaskResult } from '../../src/orchestrator/types.ts';

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

function makeTaskInput(id: string): TaskInput {
  return {
    id,
    source: 'api',
    goal: `Test task ${id}`,
    taskType: 'code',
    budget: { maxTokens: 1000, maxDurationMs: 5000, maxRetries: 1 },
  };
}

function makeTaskResult(id: string, status: 'completed' | 'failed'): TaskResult {
  return {
    id,
    status,
    mutations: [],
    trace: {
      id: `trace-${id}`,
      task_id: id,
      timestamp: Date.now(),
      routing_level: 1,
      taskTypeSignature: 'test::ts',
      approach: 'test-approach',
      modelUsed: 'mock/test',
      tokensConsumed: 500,
      durationMs: 200,
      outcome: status === 'completed' ? 'success' : 'failure',
      oracleVerdicts: {},
      affectedFiles: [],
      failureReason: status === 'failed' ? 'test failure' : undefined,
    } as any,
    escalationReason: status === 'failed' ? 'test failure' : undefined,
  };
}

describe('SessionManager', () => {
  test('create returns session with ID', () => {
    const session = manager.create('api');
    expect(session.id).toBeTruthy();
    expect(session.source).toBe('api');
    expect(session.status).toBe('active');
    expect(session.taskCount).toBe(0);
  });

  test('get returns session with task count', () => {
    const session = manager.create('cli');
    const input = makeTaskInput('task-1');
    manager.addTask(session.id, input);

    const retrieved = manager.get(session.id);
    expect(retrieved).toBeTruthy();
    expect(retrieved!.taskCount).toBe(1);
  });

  test('get returns undefined for nonexistent session', () => {
    expect(manager.get('nonexistent')).toBeUndefined();
  });

  test('addTask links task to session', () => {
    const session = manager.create('api');
    manager.addTask(session.id, makeTaskInput('t1'));
    manager.addTask(session.id, makeTaskInput('t2'));

    const tasks = sessionStore.listSessionTasks(session.id);
    expect(tasks.length).toBe(2);
    expect(tasks[0]!.status).toBe('pending');
  });

  test('completeTask updates status and result', () => {
    const session = manager.create('api');
    const input = makeTaskInput('t1');
    manager.addTask(session.id, input);
    manager.completeTask(session.id, 't1', makeTaskResult('t1', 'completed'));

    const task = sessionStore.getTask(session.id, 't1');
    expect(task!.status).toBe('completed');
    expect(task!.result_json).toBeTruthy();
  });
});

describe('Session Compaction', () => {
  test('compact produces CompactionResult', () => {
    const session = manager.create('api');

    // Add and complete tasks
    for (let i = 0; i < 5; i++) {
      const id = `t${i}`;
      manager.addTask(session.id, makeTaskInput(id));
      manager.completeTask(session.id, id, makeTaskResult(id, i < 4 ? 'completed' : 'failed'));
    }

    const result = manager.compact(session.id);
    expect(result.sessionId).toBe(session.id);
    expect(result.statistics.totalTasks).toBe(5);
    expect(result.statistics.successRate).toBe(0.8);
    expect(result.keyFailures.length).toBeGreaterThan(0);
    expect(result.successfulPatterns.length).toBeGreaterThan(0);
    expect(result.compactedAt).toBeGreaterThan(0);
  });

  test('compaction is additive — does not delete task data (I16)', () => {
    const session = manager.create('api');
    manager.addTask(session.id, makeTaskInput('t1'));
    manager.completeTask(session.id, 't1', makeTaskResult('t1', 'completed'));

    manager.compact(session.id);

    // Original task data still accessible
    const tasks = sessionStore.listSessionTasks(session.id);
    expect(tasks.length).toBe(1);
    expect(tasks[0]!.result_json).toBeTruthy();

    // Compaction stored separately
    const row = sessionStore.getSession(session.id);
    expect(row!.status).toBe('compacted');
    expect(row!.compaction_json).toBeTruthy();
  });
});

// Helper: write an assistant [INPUT-REQUIRED] turn directly to the session
// store so tests can construct arbitrary clarification histories without
// needing a full TaskResult round-trip.
function insertInputRequiredAssistant(sessionId: string, questions: string[]): void {
  const body = questions.map((q) => `- ${q}`).join('\n');
  sessionStore.insertMessage({
    session_id: sessionId,
    task_id: 'test-ir',
    role: 'assistant',
    content: `[INPUT-REQUIRED]\n${body}`,
    thinking: null,
    tools_used: null,
    token_estimate: 10,
    created_at: Date.now(),
  });
}

describe('SessionManager.getOriginalTaskGoal', () => {
  test('returns null for empty session', () => {
    const s = manager.create('api');
    expect(manager.getOriginalTaskGoal(s.id)).toBeNull();
  });

  test('returns the only user message when history has just one turn', () => {
    const s = manager.create('api');
    manager.recordUserTurn(s.id, 'write me a bedtime story');
    expect(manager.getOriginalTaskGoal(s.id)).toBe('write me a bedtime story');
  });

  test('returns the user message that triggered an open clarification', () => {
    const s = manager.create('api');
    manager.recordUserTurn(s.id, 'write me a bedtime story');
    insertInputRequiredAssistant(s.id, ['Genre?', 'Length?']);
    // Pending clarification is active; root goal is the user message before it.
    expect(manager.getOriginalTaskGoal(s.id)).toBe('write me a bedtime story');
  });

  test('skips clarification reply pairs to find the root goal across re-clarification', () => {
    const s = manager.create('api');
    manager.recordUserTurn(s.id, 'write me a bedtime story');
    insertInputRequiredAssistant(s.id, ['Genre?']);
    manager.recordUserTurn(s.id, 'romance');
    insertInputRequiredAssistant(s.id, ['Length?']);
    // Two clarification rounds layered on the same root task.
    expect(manager.getOriginalTaskGoal(s.id)).toBe('write me a bedtime story');
  });

  test('returns the MOST RECENT root task when prior tasks already completed', () => {
    const s = manager.create('api');
    // Turn 1: completed normally (not an IR).
    manager.recordUserTurn(s.id, 'first task done');
    sessionStore.insertMessage({
      session_id: s.id,
      task_id: 't1',
      role: 'assistant',
      content: 'ok, done',
      thinking: null,
      tools_used: null,
      token_estimate: 5,
      created_at: Date.now(),
    });
    // Turn 2: new task, assistant asks for clarification.
    manager.recordUserTurn(s.id, 'now write a poem');
    insertInputRequiredAssistant(s.id, ['Style?']);

    expect(manager.getOriginalTaskGoal(s.id)).toBe('now write a poem');
  });

  test('returns the most recent user message when no clarification is pending', () => {
    const s = manager.create('api');
    manager.recordUserTurn(s.id, 'hello');
    sessionStore.insertMessage({
      session_id: s.id,
      task_id: 't1',
      role: 'assistant',
      content: 'hi back',
      thinking: null,
      tools_used: null,
      token_estimate: 3,
      created_at: Date.now(),
    });
    manager.recordUserTurn(s.id, 'latest goal');
    // No [INPUT-REQUIRED] in play — latest user message wins.
    expect(manager.getOriginalTaskGoal(s.id)).toBe('latest goal');
  });
});

// ── Phase 1: compaction markers + weighted retention ─────────────────

/**
 * Insert a user+assistant pair. Returns nothing; timestamps are
 * monotonically increasing via Date.now() since tests don't care about
 * clock precision.
 */
function insertTurnPair(sessionId: string, user: string, assistant: string): void {
  sessionStore.insertMessage({
    session_id: sessionId,
    task_id: null,
    role: 'user',
    content: user,
    thinking: null,
    tools_used: null,
    token_estimate: Math.ceil(user.length / 3.5),
    created_at: Date.now(),
  });
  sessionStore.insertMessage({
    session_id: sessionId,
    task_id: 't',
    role: 'assistant',
    content: assistant,
    thinking: null,
    tools_used: null,
    token_estimate: Math.ceil(assistant.length / 3.5),
    created_at: Date.now(),
  });
}

describe('compaction markers', () => {
  test('header reports `M of N total messages compacted, K recent turn-pairs verbatim`', () => {
    const s = manager.create('api');
    // 10 pairs = 20 messages; keepRecent=5 → 10 recent, 10 compacted.
    for (let i = 0; i < 10; i++) {
      insertTurnPair(s.id, `user turn ${i}`, `assistant reply ${i}`);
    }
    const compacted = manager.getConversationHistoryCompacted(s.id, 50_000, 5);
    const header = compacted.find((e) => e.content.startsWith('[SESSION CONTEXT'));
    expect(header).toBeDefined();
    expect(header!.content).toContain('10 of 20 total messages compacted');
    expect(header!.content).toContain('5 recent turn-pairs verbatim');
  });

  test('[DROPPED BY BUDGET] entry appears when budget exceeded', () => {
    const s = manager.create('api');
    // Fill the session with long turns so the budget bites. Each content is
    // ~2000 chars → ~570 tokens. 20 pairs = ~22_800 tokens total.
    const bulk = 'x'.repeat(2000);
    for (let i = 0; i < 20; i++) {
      insertTurnPair(s.id, `${bulk} user ${i}`, `${bulk} assistant ${i}`);
    }
    // Very tight budget forces enforceTokenBudget to drop.
    const compacted = manager.getConversationHistoryCompacted(s.id, 2000, 5);
    const dropMarker = compacted.find((e) => e.content.startsWith('[DROPPED BY BUDGET'));
    expect(dropMarker).toBeDefined();
    expect(dropMarker!.content).toMatch(/\d+ turn\(s\) not shown/);
    expect(dropMarker!.content).toMatch(/~\d+ tokens/);
  });

  test('drop marker is absent when budget is comfortable', () => {
    const s = manager.create('api');
    for (let i = 0; i < 6; i++) {
      insertTurnPair(s.id, `short user ${i}`, `short assistant ${i}`);
    }
    const compacted = manager.getConversationHistoryCompacted(s.id, 50_000, 5);
    const dropMarker = compacted.find((e) => e.content.startsWith('[DROPPED BY BUDGET'));
    expect(dropMarker).toBeUndefined();
  });

  test('inline KEY-DECISION lines are interleaved into the summary block', () => {
    const s = manager.create('api');
    // Turn 1-2: normal chit-chat
    insertTurnPair(s.id, 'hi there', 'hello back');
    insertTurnPair(s.id, 'just saying', 'yes indeed');
    // Turn 3: assistant plan preamble → decision
    insertTurnPair(s.id, 'what is the plan', "I'll break this into three commits and land them in order");
    // Turn 4: assistant IR block; turn 5: user reply (zero-regex shortcut decision)
    insertTurnPair(s.id, 'keep going', '[INPUT-REQUIRED]\n- which db should I use?');
    insertTurnPair(s.id, 'postgres please', 'ok, going with postgres');
    // Turn 6-11: pad so compaction runs (keepRecent=5)
    for (let i = 0; i < 6; i++) {
      insertTurnPair(s.id, `filler user ${i}`, `filler assistant ${i}`);
    }
    const compacted = manager.getConversationHistoryCompacted(s.id, 50_000, 5);
    const header = compacted.find((e) => e.content.startsWith('[SESSION CONTEXT'));
    expect(header).toBeDefined();
    // The IR assistant turn must appear as a clarification line.
    expect(header!.content).toContain('clarification');
    // At least one `→ [Turn K, …]` line.
    expect(header!.content).toMatch(/→ \[Turn \d+, (decision|clarification)\]/);
  });
});

describe('weighted retention', () => {
  test('decision turns survive at >=2x rate of normal turns under tight budget', () => {
    const s = manager.create('api');
    // 50 turns: every 5th assistant turn is a "decision" (plan preamble);
    // others are plain chit-chat. Content lengths are equalised so the
    // differential survival rate must come from weighting, not size.
    const baseAssistant = 'normal assistant reply with no decision signals included here at all '.repeat(10);
    const decisionAssistant = "I'll go with postgres and here is the rationale ".repeat(10);
    for (let i = 0; i < 25; i++) {
      insertTurnPair(s.id, `user turn ${i} talking about stuff`, i % 5 === 0 ? decisionAssistant : baseAssistant);
    }
    // Budget sized so some turns drop but the summary block still fits.
    // keepRecent=1 forces the older weighted entries to compete.
    const compacted = manager.getConversationHistoryCompacted(s.id, 4000, 1);
    // The recent turn-pair is always preserved; focus on the summary block
    // which captures which older turns "survived" into inline KEY-DECISION
    // lines (weight=0.5 candidates).
    const header = compacted.find((e) => e.content.startsWith('[SESSION CONTEXT'));
    expect(header).toBeDefined();
    // Count inline decision lines.
    const decisionLineMatches = header!.content.match(/→ \[Turn \d+, decision\]/g) ?? [];
    // We emitted ~5 decision turns across 50 messages; the inline block
    // should surface most of them unless the budget is catastrophic.
    expect(decisionLineMatches.length).toBeGreaterThanOrEqual(3);
  });

  test('weighted priority entries survive longer than plain entries', () => {
    // Two parallel sessions: identical content sizes but different
    // importance mix. Under a tight budget, the "decision-heavy" session
    // must retain >= as many older entries as the "normal-heavy" one.
    const sDecision = manager.create('api');
    const sNormal = manager.create('api');
    // 12 pairs each. In sDecision every assistant message is a plan
    // preamble; in sNormal every assistant message is pure chit-chat.
    const decisionMsg = "I'll implement this approach step by step, beginning with…";
    const normalMsg = 'ok sure, that works for me and also for the team';
    for (let i = 0; i < 12; i++) {
      insertTurnPair(sDecision.id, `user ${i}`, decisionMsg);
      insertTurnPair(sNormal.id, `user ${i}`, normalMsg);
    }
    const tightBudget = 400;
    const decResult = manager.getConversationHistoryCompacted(sDecision.id, tightBudget, 2);
    const normResult = manager.getConversationHistoryCompacted(sNormal.id, tightBudget, 2);
    // Compare drop counts. Decision-heavy session should drop no MORE than
    // the normal session (it may drop fewer because priority entries count
    // at 0.5× their raw token weight).
    const decDrops = parseDroppedCount(decResult);
    const normDrops = parseDroppedCount(normResult);
    expect(decDrops).toBeLessThanOrEqual(normDrops);
  });

  test('priority weighting applies to recent entries, not just older entries', () => {
    // Regression guard for the dead-weights bug — pre-fix the weights map
    // was keyed on olderEntries (compacted away before budget enforcement),
    // so weights.has() always returned false and priority weighting was a
    // no-op. This test contrasts two sessions whose ONLY meaningful
    // difference is the importance of their recent turns.
    const sDecisionRecent = manager.create('api');
    const sNormalRecent = manager.create('api');
    // Large, identical older history so both sessions' summaries are
    // equal-sized. Then only recent content differs: decision vs normal.
    const olderUser = 'what about this approach';
    const olderAssistant = 'proceeding with standard flow';
    // Recent assistant messages are meaty enough that the tail-sum exceeds
    // the budget at full weight but fits at half weight. The leading clause
    // of each message drives classification ("I'll …" → decision preamble;
    // plain prose → normal) while the long body inflates the token cost.
    const decisionRecent =
      "I'll split the PR into two commits and land the API shim first. " +
      'We will ship the SQLite backend behind the feature flag, migrate ' +
      'existing sessions in a background job, and retire the legacy path ' +
      'once the p99 latency holds for 48 hours under production load.';
    const normalRecent =
      'ok sounds good, please proceed on your own time and let me know ' +
      'once the initial slice is ready for review so we can sync up. ' +
      'Take your time and drop any concerns in the thread — happy to ' +
      'context-switch if anything blocks the rest of the work.';
    for (let i = 0; i < 20; i++) {
      insertTurnPair(sDecisionRecent.id, olderUser, olderAssistant);
      insertTurnPair(sNormalRecent.id, olderUser, olderAssistant);
    }
    // Append 3 recent pairs — the tail that enforceTokenBudget actually sees.
    for (let i = 0; i < 3; i++) {
      insertTurnPair(sDecisionRecent.id, `follow-up ${i}`, decisionRecent);
      insertTurnPair(sNormalRecent.id, `follow-up ${i}`, normalRecent);
    }
    // Budget tight enough that a full-weight tail overflows but a
    // half-weighted tail doesn't, so the weighting is decisive.
    const budget = 200;
    const decResult = manager.getConversationHistoryCompacted(sDecisionRecent.id, budget, 3);
    const normResult = manager.getConversationHistoryCompacted(sNormalRecent.id, budget, 3);
    const decDrops = parseDroppedCount(decResult);
    const normDrops = parseDroppedCount(normResult);
    // Decision-heavy recent tail must retain strictly more entries under the
    // same budget — if this assertion fails we're back to the dead-weights bug.
    expect(decDrops).toBeLessThan(normDrops);
  });
});

/** Parse the integer from a `[DROPPED BY BUDGET: N turn(s) …]` marker. */
function parseDroppedCount(entries: ReturnType<SessionManager['getConversationHistoryCompacted']>): number {
  const marker = entries.find((e) => e.content.startsWith('[DROPPED BY BUDGET'));
  if (!marker) return 0;
  const m = marker.content.match(/(\d+) turn\(s\)/);
  return m ? parseInt(m[1]!, 10) : 0;
}

describe('Session Recovery', () => {
  test('suspendAll suspends active sessions', () => {
    manager.create('api');
    manager.create('api');

    const suspended = manager.suspendAll();
    expect(suspended).toBe(2);

    const active = sessionStore.listActiveSessions();
    expect(active.length).toBe(0);
  });

  test('recover returns suspended sessions and reactivates them', () => {
    const s1 = manager.create('api');
    manager.suspendAll();

    const recovered = manager.recover();
    expect(recovered.length).toBe(1);
    expect(recovered[0]!.id).toBe(s1.id);
    expect(recovered[0]!.status).toBe('active');
  });
});
