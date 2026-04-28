/**
 * Per-session serialization regression tests.
 *
 * Live-confirmed bug (round 4): two POST /sessions/:id/messages requests
 * arriving 100ms apart in the same session → both `recordUserTurn` calls
 * happen synchronously → both `executeTask` runs read history that
 * includes the OTHER task's user message → LLM answers BOTH questions in
 * BOTH responses → duplicate assistant turns with identical concatenated
 * content.
 *
 * Fix (server.ts `sessionTaskChain`): chain `recordUserTurn + executeTask`
 * per-session. The 2nd send waits for the 1st to fully complete (assistant
 * turn recorded) before its user turn is recorded.
 *
 * These tests pin that fix so a future refactor doesn't silently restore
 * the bug.
 */

import { Database } from 'bun:sqlite';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { VinyanAPIServer } from '../../src/api/server.ts';
import { SessionManager } from '../../src/api/session-manager.ts';
import { createBus } from '../../src/core/bus.ts';
import { ALL_MIGRATIONS, MigrationRunner } from '../../src/db/migrations/index.ts';
import { SessionStore } from '../../src/db/session-store.ts';
import type { TaskInput, TaskResult } from '../../src/orchestrator/types.ts';

const TEST_DIR = join(tmpdir(), `vinyan-serialize-${Date.now()}`);
const TOKEN_PATH = join(TEST_DIR, 'api-token');
const TEST_TOKEN = `test-token-${'b'.repeat(52)}`;
const HEADERS = { Authorization: `Bearer ${TEST_TOKEN}`, 'Content-Type': 'application/json' };

let server: VinyanAPIServer;
let db: Database;
let sessionManager: SessionManager;
/**
 * Track the order in which executeTask runs sees the session history.
 * Each entry: snapshot of role+content for every turn that was already
 * persisted when this task started executing. The serialization fix
 * guarantees these snapshots are monotonically growing and never
 * cross-contaminate (i.e. task1's snapshot never includes task2's user
 * message).
 */
let historySnapshots: Array<{
  taskId: string;
  goal: string;
  sessionId: string;
  startedAt: number;
  turnsAtStart: Array<{ role: string; text: string }>;
}> = [];

function mockExecuteTask(input: TaskInput): Promise<TaskResult> {
  // Snapshot history at the moment executeTask is called (mirrors what
  // the real core-loop's getTurnsHistory would see).
  const turns = sessionManager.getSessionStore().getTurns(input.sessionId ?? '');
  historySnapshots.push({
    taskId: input.id,
    goal: input.goal,
    sessionId: input.sessionId ?? '',
    startedAt: Date.now(),
    turnsAtStart: turns.map((t) => {
      const text = t.blocks
        .filter((b): b is Extract<typeof b, { type: 'text' }> => b.type === 'text')
        .map((b) => b.text)
        .join('');
      return { role: t.role, text };
    }),
  });
  // Slow path so a second concurrent send actually races.
  return new Promise((resolve) => {
    setTimeout(() => {
      resolve({
        id: input.id,
        status: 'completed',
        mutations: [],
        trace: {
          id: `trace-${input.id}`,
          taskId: input.id,
          timestamp: Date.now(),
          routingLevel: 0,
          approach: 'mock',
          modelUsed: 'mock',
          tokensConsumed: 10,
          durationMs: 5,
          outcome: 'success',
          oracleVerdicts: {},
          affectedFiles: [],
        },
        answer: `answered: ${input.goal}`,
      } as TaskResult);
    }, 50);
  });
}

beforeAll(() => {
  mkdirSync(TEST_DIR, { recursive: true });
  writeFileSync(TOKEN_PATH, TEST_TOKEN);

  db = new Database(':memory:');
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  new MigrationRunner().migrate(db, ALL_MIGRATIONS);

  const bus = createBus();
  const sessionStore = new SessionStore(db);
  sessionManager = new SessionManager(sessionStore);

  server = new VinyanAPIServer(
    { port: 0, bind: '127.0.0.1', tokenPath: TOKEN_PATH, authRequired: true, rateLimitEnabled: false },
    { bus, executeTask: mockExecuteTask, sessionManager },
  );
});

afterAll(() => {
  db.close();
});

describe('Per-session message serialization', () => {
  test('two rapid streaming sends do NOT share conversation history', async () => {
    historySnapshots = [];
    const session = sessionManager.create('ui');

    const send = (content: string) =>
      server.handleRequest(
        new Request(`http://localhost/api/v1/sessions/${session.id}/messages`, {
          method: 'POST',
          headers: HEADERS,
          body: JSON.stringify({ content, stream: true }),
        }),
      );

    // Fire two POSTs back-to-back. Both return SSE streams, but the
    // chain serializes the underlying executeTask calls.
    const [r1, r2] = await Promise.all([send('Q1'), send('Q2')]);
    // Cancel the streams so Bun releases the readers; the chained
    // executeTask still completes and persists the assistant turn.
    await r1.body?.cancel();
    await r2.body?.cancel();

    // Wait for both chained tasks to complete.
    await new Promise((r) => setTimeout(r, 250));

    // Two snapshots, in the order the chain dispatched them.
    expect(historySnapshots.length).toBe(2);

    // First task's snapshot: ONLY its own user turn. If it sees Q2
    // here, the serialization broke (the original bug).
    const first = historySnapshots[0]!;
    expect(first.turnsAtStart.length).toBe(1);
    expect(first.turnsAtStart[0]).toEqual({ role: 'user', text: 'Q1' });

    // Second task's snapshot: the prior user/assistant pair PLUS its
    // own user turn. The chain guarantees the prior assistant turn
    // landed before this snapshot was taken.
    const second = historySnapshots[1]!;
    expect(second.turnsAtStart.length).toBe(3);
    expect(second.turnsAtStart[0]).toEqual({ role: 'user', text: 'Q1' });
    expect(second.turnsAtStart[1]?.role).toBe('assistant');
    expect(second.turnsAtStart[1]?.text).toContain('answered: Q1');
    expect(second.turnsAtStart[2]).toEqual({ role: 'user', text: 'Q2' });
  });

  test('final session history is in correct user→assistant order with no duplicates', async () => {
    historySnapshots = [];
    const session = sessionManager.create('ui');

    const send = (content: string) =>
      server.handleRequest(
        new Request(`http://localhost/api/v1/sessions/${session.id}/messages`, {
          method: 'POST',
          headers: HEADERS,
          body: JSON.stringify({ content, stream: true }),
        }),
      );

    const [r1, r2, r3] = await Promise.all([send('A'), send('B'), send('C')]);
    await r1.body?.cancel();
    await r2.body?.cancel();
    await r3.body?.cancel();

    await new Promise((r) => setTimeout(r, 350));

    const turns = sessionManager.getSessionStore().getTurns(session.id);
    // Expected: 3 user + 3 assistant, strictly alternating.
    expect(turns.length).toBe(6);
    expect(turns.map((t) => t.role)).toEqual([
      'user',
      'assistant',
      'user',
      'assistant',
      'user',
      'assistant',
    ]);

    // No duplicate assistant content (the original bug produced two
    // identical assistants answering both questions).
    const assistantTexts = turns
      .filter((t) => t.role === 'assistant')
      .map((t) => {
        const b = t.blocks.find((x): x is Extract<typeof x, { type: 'text' }> => x.type === 'text');
        return b?.text ?? '';
      });
    expect(new Set(assistantTexts).size).toBe(3);
    expect(assistantTexts[0]).toContain('answered: A');
    expect(assistantTexts[1]).toContain('answered: B');
    expect(assistantTexts[2]).toContain('answered: C');
  });

  test('different sessions still run in parallel (chain is per-session, not global)', async () => {
    historySnapshots = [];
    const sA = sessionManager.create('ui');
    const sB = sessionManager.create('ui');

    const send = (sid: string, content: string) =>
      server.handleRequest(
        new Request(`http://localhost/api/v1/sessions/${sid}/messages`, {
          method: 'POST',
          headers: HEADERS,
          body: JSON.stringify({ content, stream: true }),
        }),
      );

    const [r1, r2] = await Promise.all([send(sA.id, 'in-A'), send(sB.id, 'in-B')]);
    await r1.body?.cancel();
    await r2.body?.cancel();
    await new Promise((r) => setTimeout(r, 250));

    // Two tasks dispatched, one per session. Compare their startedAt
    // timestamps directly — if the chain were global (or shared across
    // sessions) the second would start AFTER the first finished
    // (~50ms delay). Running per-session, both should start within a
    // few ms of each other.
    expect(historySnapshots.length).toBe(2);
    const sessions = historySnapshots.map((s) => s.sessionId).sort();
    expect(sessions).toEqual([sA.id, sB.id].sort());
    const gap = Math.abs(historySnapshots[0]!.startedAt - historySnapshots[1]!.startedAt);
    // 50ms is the mock task duration; allow generous slack for CI but
    // assert decisively under that bound.
    expect(gap).toBeLessThan(40);
  });
});
