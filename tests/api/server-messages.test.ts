/**
 * API Server — Agent Conversation message endpoint tests.
 *
 * Exercises POST /api/v1/sessions/:id/messages and GET /api/v1/sessions/:id/messages
 * end-to-end via handleRequest() (no port binding). The mock executeTask is
 * mutable per test so we can simulate completed / input-required / failed
 * outcomes and assert on the captured TaskInput (which is how we verify
 * clarification auto-detection wraps the user's answer as CLARIFIED:
 * constraints).
 *
 * Related: tests/api/server.test.ts, src/api/server.ts handleSessionMessage
 * and handleListSessionMessages, docs/design/agent-conversation.md.
 */
import { Database } from 'bun:sqlite';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { VinyanAPIServer } from '../../src/api/server.ts';
import { SessionManager } from '../../src/api/session-manager.ts';
import { createBus, type VinyanBus } from '../../src/core/bus.ts';
import { ALL_MIGRATIONS, MigrationRunner } from '../../src/db/migrations/index.ts';
import { SessionStore } from '../../src/db/session-store.ts';
import type { TaskInput, TaskResult } from '../../src/orchestrator/types.ts';

const TEST_DIR = join(tmpdir(), `vinyan-api-messages-test-${Date.now()}`);
const TOKEN_PATH = join(TEST_DIR, 'api-token');
const TEST_TOKEN = `test-token-${'a'.repeat(52)}`;

let server: VinyanAPIServer;
let db: Database;
let sessionManager: SessionManager;
let testBus: VinyanBus;

// Per-test mutable state
let mockBehavior: (input: TaskInput) => TaskResult;
let capturedInputs: TaskInput[];

/**
 * Mock executeTask that simulates the bus events real core-loop.executeTask
 * emits in production. The SSE streaming path of handleSessionMessage
 * subscribes to `task:start` and `task:complete` (via createSSEStream) and
 * auto-closes the stream on the latter — so the mock has to emit them for
 * stream tests to work. For agent-driven clarifications, also emit
 * `agent:clarification_requested` with source='agent' so streamed clients
 * see it in the event log.
 */
function mockExecuteTask(input: TaskInput): Promise<TaskResult> {
  capturedInputs.push(input);
  const result = mockBehavior(input);

  // Simulate the start-of-task bus event. Routing is synthetic — only the
  // taskId filter in createSSEStream matters here.
  testBus.emit('task:start', {
    input,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    routing: {
      level: 1,
      model: 'mock',
      budgetTokens: 10_000,
      latencyBudgetMs: 5_000,
    } as any,
  });

  // For input-required results, emit the clarification event so streaming
  // clients see it in the SSE log.
  if (result.status === 'input-required' && result.clarificationNeeded) {
    testBus.emit('agent:clarification_requested', {
      taskId: input.id,
      sessionId: input.sessionId,
      questions: [...result.clarificationNeeded],
      routingLevel: 1,
      source: 'agent',
    });
  }

  // End-of-task event — the SSE stream auto-closes on this.
  testBus.emit('task:complete', { result });

  return Promise.resolve(result);
}

function makeTrace(taskId: string, outcome: 'success' | 'failure' = 'success') {
  return {
    id: `trace-${taskId}`,
    taskId,
    timestamp: Date.now(),
    routingLevel: 1,
    approach: 'test',
    modelUsed: 'mock/test',
    tokensConsumed: 100,
    durationMs: 50,
    outcome,
    oracleVerdicts: {},
    affectedFiles: [],
  } as any;
}

function completedResult(input: TaskInput, answer = 'task done'): TaskResult {
  return {
    id: input.id,
    status: 'completed',
    mutations: [],
    trace: makeTrace(input.id),
    answer,
  };
}

function inputRequiredResult(input: TaskInput, questions: string[]): TaskResult {
  return {
    id: input.id,
    status: 'input-required',
    mutations: [],
    trace: makeTrace(input.id),
    clarificationNeeded: questions,
  };
}

function req(
  path: string,
  opts: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Request {
  return new Request(`http://localhost${path}`, {
    method: opts.method ?? 'GET',
    headers: opts.headers,
    body: opts.body,
  });
}

const authHeaders = { Authorization: `Bearer ${TEST_TOKEN}`, 'Content-Type': 'application/json' };

beforeAll(() => {
  mkdirSync(TEST_DIR, { recursive: true });
  writeFileSync(TOKEN_PATH, TEST_TOKEN);

  db = new Database(':memory:');
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  new MigrationRunner().migrate(db, ALL_MIGRATIONS);

  testBus = createBus();
  const sessionStore = new SessionStore(db);
  sessionManager = new SessionManager(sessionStore);

  server = new VinyanAPIServer(
    {
      port: 0,
      bind: '127.0.0.1',
      tokenPath: TOKEN_PATH,
      authRequired: true,
      rateLimitEnabled: false,
    },
    {
      bus: testBus,
      executeTask: mockExecuteTask,
      sessionManager,
    },
  );
});

beforeEach(() => {
  capturedInputs = [];
  mockBehavior = (input) => completedResult(input);
});

afterAll(() => {
  db.close();
});

/** Helper: create a session and return its id. */
async function createSession(): Promise<string> {
  const res = await server.handleRequest(
    req('/api/v1/sessions', {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ source: 'test' }),
    }),
  );
  expect(res.status).toBe(201);
  const data = (await res.json()) as { session: { id: string } };
  return data.session.id;
}

describe('API Server — Agent Conversation messages', () => {
  // ── POST /api/v1/sessions/:id/messages ──────────────────

  test('POST /messages returns TaskResult and records turns', async () => {
    const sessionId = await createSession();
    mockBehavior = (input) => completedResult(input, 'here is your answer');

    const res = await server.handleRequest(
      req(`/api/v1/sessions/${sessionId}/messages`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({ content: 'what is 2 + 2?' }),
      }),
    );

    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      session: { id: string; pendingClarifications: string[] };
      task: TaskResult;
    };
    expect(data.task.status).toBe('completed');
    expect(data.task.answer).toBe('here is your answer');
    expect(data.session.id).toBe(sessionId);
    // No pending clarifications after a clean completion
    expect(data.session.pendingClarifications).toEqual([]);

    // Both turns persisted
    const history = sessionManager.getConversationHistoryText(sessionId);
    expect(history).toHaveLength(2);
    expect(history[0]!.role).toBe('user');
    expect(history[0]!.content).toBe('what is 2 + 2?');
    expect(history[1]!.role).toBe('assistant');
    expect(history[1]!.content).toContain('here is your answer');

    // TaskInput was constructed with sessionId set so core-loop can load
    // conversation history for subsequent turns.
    expect(capturedInputs).toHaveLength(1);
    expect(capturedInputs[0]!.sessionId).toBe(sessionId);
    expect(capturedInputs[0]!.source).toBe('api');
    expect(capturedInputs[0]!.goal).toBe('what is 2 + 2?');
  });

  test('first message auto-names the session and exposes the title in SESSION_CONTEXT', async () => {
    const sessionId = await createSession();
    mockBehavior = (input) => completedResult(input, 'started');

    const res = await server.handleRequest(
      req(`/api/v1/sessions/${sessionId}/messages`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({ content: 'please help plan a bedtime story for kids' }),
      }),
    );

    expect(res.status).toBe(200);
    expect(capturedInputs).toHaveLength(1);
    const context = (capturedInputs[0]!.constraints ?? []).find((c) => c.startsWith('SESSION_CONTEXT:'));
    expect(context).toBeDefined();
    const payload = JSON.parse(context!.slice('SESSION_CONTEXT:'.length)) as { title?: string };
    expect(payload.title).toBe('Help plan a bedtime story for kids');
    expect(sessionManager.get(sessionId)?.title).toBe('Help plan a bedtime story for kids');
  });

  test('POST /messages on unknown session returns 404', async () => {
    const res = await server.handleRequest(
      req('/api/v1/sessions/does-not-exist/messages', {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({ content: 'hello' }),
      }),
    );
    expect(res.status).toBe(404);
  });

  test('POST /messages with empty content returns 400', async () => {
    const sessionId = await createSession();
    const res = await server.handleRequest(
      req(`/api/v1/sessions/${sessionId}/messages`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({ content: '' }),
      }),
    );
    expect(res.status).toBe(400);
  });

  test('POST /messages with missing content returns 400', async () => {
    const sessionId = await createSession();
    const res = await server.handleRequest(
      req(`/api/v1/sessions/${sessionId}/messages`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({}),
      }),
    );
    expect(res.status).toBe(400);
  });

  test('POST /messages with malformed JSON returns 400', async () => {
    const sessionId = await createSession();
    const res = await server.handleRequest(
      req(`/api/v1/sessions/${sessionId}/messages`, {
        method: 'POST',
        headers: authHeaders,
        body: 'not json at all',
      }),
    );
    expect(res.status).toBe(400);
  });

  test('POST /messages without auth returns 401', async () => {
    // No Authorization header
    const res = await server.handleRequest(
      req('/api/v1/sessions/x/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: 'hi' }),
      }),
    );
    expect(res.status).toBe(401);
  });

  // ── Clarification round-trip ─────────────────────────────

  test('input-required round-trip: second call batches reply and preserves original goal', async () => {
    const sessionId = await createSession();
    const questions = [
      'Which helper did you mean — auth or utils?',
      'Should the old one stay as an alias?',
    ];
    const originalGoal = 'refactor the helper';
    const replyContent = 'the auth one; no, remove it entirely';

    // Turn 1: the agent pauses with two questions.
    mockBehavior = (input) => inputRequiredResult(input, questions);
    const firstRes = await server.handleRequest(
      req(`/api/v1/sessions/${sessionId}/messages`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({ content: originalGoal }),
      }),
    );

    expect(firstRes.status).toBe(200);
    const firstData = (await firstRes.json()) as {
      session: { pendingClarifications: string[] };
      task: TaskResult;
    };
    expect(firstData.task.status).toBe('input-required');
    expect(firstData.task.clarificationNeeded).toEqual(questions);
    // Session now reports the same open questions via pendingClarifications.
    expect(firstData.session.pendingClarifications).toEqual(questions);

    // Turn 2: the user answers. The server must auto-detect that the
    // previous turn was input-required and (a) pack the open questions +
    // reply into a single CLARIFICATION_BATCH constraint, (b) anchor the
    // task's goal to the original user request rather than overwriting it
    // with the reply text.
    mockBehavior = (input) => completedResult(input, 'applied');
    const secondRes = await server.handleRequest(
      req(`/api/v1/sessions/${sessionId}/messages`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({ content: replyContent }),
      }),
    );

    expect(secondRes.status).toBe(200);
    const secondData = (await secondRes.json()) as {
      session: { pendingClarifications: string[] };
      task: TaskResult;
    };
    expect(secondData.task.status).toBe('completed');
    // After completion, no more pending clarifications.
    expect(secondData.session.pendingClarifications).toEqual([]);

    // Critically: the SECOND captured TaskInput should carry exactly ONE
    // CLARIFICATION_BATCH constraint (not N fan-out CLARIFIED entries) and
    // its goal should be the ORIGINAL user request — the reply text only
    // appears inside the batch payload.
    expect(capturedInputs).toHaveLength(2);
    const secondInput = capturedInputs[1]!;
    expect(secondInput.goal).toBe(originalGoal);
    expect(secondInput.sessionId).toBe(sessionId);

    const constraints = secondInput.constraints ?? [];
    const batches = constraints.filter((c) => c.startsWith('CLARIFICATION_BATCH:'));
    expect(batches).toHaveLength(1);
    const batch = JSON.parse(batches[0]!.slice('CLARIFICATION_BATCH:'.length)) as {
      questions: string[];
      reply: string;
    };
    expect(batch.questions).toEqual(questions);
    expect(batch.reply).toBe(replyContent);

    // And no legacy fan-out CLARIFIED:<q>=><a> entries leak in.
    expect(constraints.some((c) => c.startsWith('CLARIFIED:'))).toBe(false);
  });

  test('clarifications are one-shot: a third call does NOT reinject them', async () => {
    const sessionId = await createSession();

    // Turn 1: pause with one question.
    mockBehavior = (input) => inputRequiredResult(input, ['Which?']);
    await server.handleRequest(
      req(`/api/v1/sessions/${sessionId}/messages`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({ content: 'do it' }),
      }),
    );

    // Turn 2: user answers — the clarification should be injected.
    mockBehavior = (input) => completedResult(input, 'ok');
    await server.handleRequest(
      req(`/api/v1/sessions/${sessionId}/messages`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({ content: 'the first one' }),
      }),
    );
    const turn2Constraints = capturedInputs[1]!.constraints ?? [];
    expect(turn2Constraints.some((c) => c.startsWith('CLARIFICATION_BATCH:'))).toBe(true);

    // Turn 3: a fresh intent — clarifications should NOT be re-injected
    // because the previous assistant turn was a plain completion, not
    // another input-required.
    await server.handleRequest(
      req(`/api/v1/sessions/${sessionId}/messages`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({ content: 'now do something else' }),
      }),
    );
    expect(capturedInputs).toHaveLength(3);
    const turn3Constraints = capturedInputs[2]!.constraints ?? [];
    expect(turn3Constraints.some((c) => c.startsWith('CLARIFICATION_BATCH:'))).toBe(false);
    expect(turn3Constraints.some((c) => c.startsWith('CLARIFIED:'))).toBe(false);
    // Turn 3's goal is the fresh intent, not any prior text.
    expect(capturedInputs[2]!.goal).toBe('now do something else');
  });

  test('re-clarification chain keeps the root goal across multiple rounds', async () => {
    const sessionId = await createSession();
    const rootGoal = 'ช่วยแต่งนิยายก่อนนอนให้สักเรื่อง';

    // Turn 1: user asks, agent needs clarification.
    mockBehavior = (input) => inputRequiredResult(input, ['แนวอะไรดี?']);
    await server.handleRequest(
      req(`/api/v1/sessions/${sessionId}/messages`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({ content: rootGoal }),
      }),
    );

    // Turn 2: user answers partially, agent asks a second clarification.
    mockBehavior = (input) => inputRequiredResult(input, ['ยาวแค่ไหน?']);
    await server.handleRequest(
      req(`/api/v1/sessions/${sessionId}/messages`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({ content: 'โรแมนติก' }),
      }),
    );

    // Turn 3: user answers the second clarification; agent finishes.
    mockBehavior = (input) => completedResult(input, 'เขียนเสร็จแล้ว');
    await server.handleRequest(
      req(`/api/v1/sessions/${sessionId}/messages`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({ content: 'สั้นๆ 500 คำ' }),
      }),
    );

    expect(capturedInputs).toHaveLength(3);
    // Every turn in the clarification chain must resolve to the same root
    // goal, not to the intermediate reply text.
    expect(capturedInputs[1]!.goal).toBe(rootGoal);
    expect(capturedInputs[2]!.goal).toBe(rootGoal);

    // Each follow-up turn carries its own CLARIFICATION_BATCH with the
    // NEW question being answered (not the full accumulated history).
    const batch2 = (capturedInputs[1]!.constraints ?? []).find((c) =>
      c.startsWith('CLARIFICATION_BATCH:'),
    )!;
    const batch3 = (capturedInputs[2]!.constraints ?? []).find((c) =>
      c.startsWith('CLARIFICATION_BATCH:'),
    )!;
    const parsed2 = JSON.parse(batch2.slice('CLARIFICATION_BATCH:'.length)) as {
      questions: string[];
      reply: string;
    };
    const parsed3 = JSON.parse(batch3.slice('CLARIFICATION_BATCH:'.length)) as {
      questions: string[];
      reply: string;
    };
    expect(parsed2.questions).toEqual(['แนวอะไรดี?']);
    expect(parsed2.reply).toBe('โรแมนติก');
    expect(parsed3.questions).toEqual(['ยาวแค่ไหน?']);
    expect(parsed3.reply).toBe('สั้นๆ 500 คำ');
  });

  // ── GET /api/v1/sessions/:id/messages ───────────────────

  test('GET /messages returns conversation history', async () => {
    const sessionId = await createSession();
    mockBehavior = (input) => completedResult(input, 'reply 1');
    await server.handleRequest(
      req(`/api/v1/sessions/${sessionId}/messages`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({ content: 'user 1' }),
      }),
    );
    mockBehavior = (input) => completedResult(input, 'reply 2');
    await server.handleRequest(
      req(`/api/v1/sessions/${sessionId}/messages`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({ content: 'user 2' }),
      }),
    );

    const res = await server.handleRequest(
      req(`/api/v1/sessions/${sessionId}/messages`, { headers: authHeaders }),
    );
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      session: { id: string; pendingClarifications: string[] };
      messages: Array<{ role: string; content: string }>;
    };
    expect(data.session.id).toBe(sessionId);
    expect(data.messages).toHaveLength(4);
    expect(data.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
    expect(data.messages[0]!.content).toBe('user 1');
    expect(data.messages[1]!.content).toContain('reply 1');
    expect(data.messages[2]!.content).toBe('user 2');
    expect(data.messages[3]!.content).toContain('reply 2');
  });

  test('GET /messages?limit=N returns only the most recent N entries', async () => {
    const sessionId = await createSession();
    for (let i = 0; i < 5; i++) {
      mockBehavior = (input) => completedResult(input, `reply ${i}`);
      await server.handleRequest(
        req(`/api/v1/sessions/${sessionId}/messages`, {
          method: 'POST',
          headers: authHeaders,
          body: JSON.stringify({ content: `user ${i}` }),
        }),
      );
    }

    const res = await server.handleRequest(
      req(`/api/v1/sessions/${sessionId}/messages?limit=3`, { headers: authHeaders }),
    );
    expect(res.status).toBe(200);
    const data = (await res.json()) as { messages: Array<{ content: string }> };
    expect(data.messages).toHaveLength(3);
    // Limit slices the TAIL — the 3 most recent entries.
    expect(data.messages[data.messages.length - 1]!.content).toContain('reply 4');
  });

  test('GET /messages on unknown session returns 404', async () => {
    const res = await server.handleRequest(
      req('/api/v1/sessions/nope/messages', { headers: authHeaders }),
    );
    expect(res.status).toBe(404);
  });

  test('GET /messages surfaces open pending clarifications', async () => {
    const sessionId = await createSession();
    const questions = ['Q1?', 'Q2?'];
    mockBehavior = (input) => inputRequiredResult(input, questions);
    await server.handleRequest(
      req(`/api/v1/sessions/${sessionId}/messages`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({ content: 'start' }),
      }),
    );

    const res = await server.handleRequest(
      req(`/api/v1/sessions/${sessionId}/messages`, { headers: authHeaders }),
    );
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      session: { pendingClarifications: string[] };
    };
    expect(data.session.pendingClarifications).toEqual(questions);
  });
});

// ── SSE streaming variant ─────────────────────────────────────────────

/**
 * Parse a text/event-stream response body into `{event, data}` pairs.
 * Handles the SSE wire format:
 *   event: <name>\n
 *   data: <json>\n
 *   \n  (event delimiter)
 */
interface SSEEvent {
  event: string;
  data: { event?: string; payload?: unknown; ts?: number };
}
function parseSSE(text: string): SSEEvent[] {
  const blocks = text.split('\n\n').filter((b) => b.trim().length > 0);
  return blocks.map((block) => {
    const lines = block.split('\n');
    const eventLine = lines.find((l) => l.startsWith('event: '));
    const dataLine = lines.find((l) => l.startsWith('data: '));
    return {
      event: eventLine ? eventLine.slice('event: '.length) : '',
      data: dataLine ? (JSON.parse(dataLine.slice('data: '.length)) as SSEEvent['data']) : {},
    };
  });
}

/**
 * Flush pending microtasks / timers so the .then() handler that records the
 * assistant turn has a chance to run after we've consumed the stream. The
 * .then callback is scheduled during the stream-path branch of
 * handleSessionMessage but runs asynchronously; we give it one event loop
 * turn before inspecting SessionManager state.
 */
async function flushMicrotasks(): Promise<void> {
  await new Promise((r) => setTimeout(r, 5));
}

describe('API Server — Agent Conversation streaming (stream: true)', () => {
  test('POST /messages with stream:true returns text/event-stream with task:start and task:complete', async () => {
    const sessionId = await createSession();
    mockBehavior = (input) => completedResult(input, 'streamed answer');

    const res = await server.handleRequest(
      req(`/api/v1/sessions/${sessionId}/messages`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({ content: 'stream please', stream: true }),
      }),
    );

    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('text/event-stream');
    expect(res.headers.get('Cache-Control')).toBe('no-cache');

    const text = await res.text();
    const events = parseSSE(text);

    // Both the start and the end event must appear in order.
    const eventNames = events.map((e) => e.event);
    expect(eventNames).toContain('task:start');
    expect(eventNames).toContain('task:complete');
    expect(eventNames.indexOf('task:start')).toBeLessThan(eventNames.indexOf('task:complete'));

    // The task:complete payload carries the TaskResult.
    const completeEvent = events.find((e) => e.event === 'task:complete')!;
    const completePayload = completeEvent.data.payload as { result: TaskResult };
    expect(completePayload.result.status).toBe('completed');
    expect(completePayload.result.answer).toBe('streamed answer');
  });

  test('stream records user turn before starting and assistant turn after completing', async () => {
    const sessionId = await createSession();
    mockBehavior = (input) => completedResult(input, 'ok');

    const res = await server.handleRequest(
      req(`/api/v1/sessions/${sessionId}/messages`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({ content: 'streamed user input', stream: true }),
      }),
    );
    // Consume the stream so the task actually resolves.
    await res.text();
    // Flush microtasks so recordAssistantTurn .then handler runs.
    await flushMicrotasks();

    const history = sessionManager.getConversationHistoryText(sessionId);
    expect(history).toHaveLength(2);
    expect(history[0]!.role).toBe('user');
    expect(history[0]!.content).toBe('streamed user input');
    expect(history[1]!.role).toBe('assistant');
    expect(history[1]!.content).toContain('ok');

    // Input carries sessionId + api source, same as sync path.
    expect(capturedInputs).toHaveLength(1);
    expect(capturedInputs[0]!.sessionId).toBe(sessionId);
    expect(capturedInputs[0]!.source).toBe('api');
  });

  test('stream emits agent:clarification_requested when the task pauses for user input', async () => {
    const sessionId = await createSession();
    const questions = ['Which module?', 'Delete or deprecate?'];
    mockBehavior = (input) => inputRequiredResult(input, questions);

    const res = await server.handleRequest(
      req(`/api/v1/sessions/${sessionId}/messages`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({ content: 'refactor the helper', stream: true }),
      }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('text/event-stream');

    const events = parseSSE(await res.text());
    const clarificationEvent = events.find((e) => e.event === 'agent:clarification_requested');
    expect(clarificationEvent).toBeDefined();
    const payload = clarificationEvent!.data.payload as {
      taskId: string;
      questions: string[];
      source?: string;
    };
    expect(payload.questions).toEqual(questions);
    expect(payload.source).toBe('agent');

    // task:complete still fires (closes the stream) carrying the
    // input-required result.
    const completeEvent = events.find((e) => e.event === 'task:complete')!;
    const completePayload = completeEvent.data.payload as { result: TaskResult };
    expect(completePayload.result.status).toBe('input-required');
    expect(completePayload.result.clarificationNeeded).toEqual(questions);
  });

  test('streamed clarification follow-up batches reply and preserves original goal', async () => {
    const sessionId = await createSession();
    const questions = ['Which file?'];
    const originalGoal = 'do it';
    const reply = 'src/auth.ts';

    // Turn 1 (stream): input-required
    mockBehavior = (input) => inputRequiredResult(input, questions);
    const firstRes = await server.handleRequest(
      req(`/api/v1/sessions/${sessionId}/messages`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({ content: originalGoal, stream: true }),
      }),
    );
    await firstRes.text();
    await flushMicrotasks();

    // Turn 2 (stream): user answers — server packs questions + reply into a
    // single CLARIFICATION_BATCH constraint and keeps the original goal.
    mockBehavior = (input) => completedResult(input, 'done');
    const secondRes = await server.handleRequest(
      req(`/api/v1/sessions/${sessionId}/messages`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({ content: reply, stream: true }),
      }),
    );
    await secondRes.text();
    await flushMicrotasks();

    expect(capturedInputs).toHaveLength(2);
    const secondInput = capturedInputs[1]!;
    expect(secondInput.goal).toBe(originalGoal);
    const constraints = secondInput.constraints ?? [];
    const batches = constraints.filter((c) => c.startsWith('CLARIFICATION_BATCH:'));
    expect(batches).toHaveLength(1);
    const parsed = JSON.parse(batches[0]!.slice('CLARIFICATION_BATCH:'.length)) as {
      questions: string[];
      reply: string;
    };
    expect(parsed.questions).toEqual(questions);
    expect(parsed.reply).toBe(reply);
  });

  test('stream:true with unknown session returns JSON 404 (not SSE)', async () => {
    const res = await server.handleRequest(
      req('/api/v1/sessions/no-such-session/messages', {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({ content: 'hi', stream: true }),
      }),
    );
    expect(res.status).toBe(404);
    // Content-Type is NOT event-stream because validation fails before
    // streaming setup.
    expect(res.headers.get('Content-Type')).toContain('application/json');
  });

  test('stream:true with empty content returns JSON 400 (not SSE)', async () => {
    const sessionId = await createSession();
    const res = await server.handleRequest(
      req(`/api/v1/sessions/${sessionId}/messages`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({ content: '', stream: true }),
      }),
    );
    expect(res.status).toBe(400);
    expect(res.headers.get('Content-Type')).toContain('application/json');
  });

  test('stream:false (or omitted) preserves the existing sync response shape', async () => {
    // Regression guard: setting stream:false explicitly should behave
    // identically to the sync path — returns JSON, not SSE.
    const sessionId = await createSession();
    mockBehavior = (input) => completedResult(input, 'sync answer');

    const res = await server.handleRequest(
      req(`/api/v1/sessions/${sessionId}/messages`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({ content: 'hi', stream: false }),
      }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('application/json');
    const data = (await res.json()) as { task: TaskResult };
    expect(data.task.status).toBe('completed');
    expect(data.task.answer).toBe('sync answer');
  });
});

// ── Long-lived session-scoped SSE (PR #10) ────────────────────────────

/**
 * Read a bounded prefix of an SSE stream by consuming chunks until
 * either a timeout elapses or a specific event appears. This lets us
 * assert on the events emitted during a session's lifetime without
 * waiting for the 60-minute safety-net cleanup.
 */
async function readSSEUntil(
  res: Response,
  predicate: (events: SSEEvent[]) => boolean,
  timeoutMs = 1500,
): Promise<SSEEvent[]> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const events: SSEEvent[] = [];
  const startTime = Date.now();

  while (Date.now() - startTime < timeoutMs) {
    const { value, done } = await Promise.race([
      reader.read(),
      new Promise<{ value: undefined; done: true }>((r) =>
        setTimeout(() => r({ value: undefined, done: true }), 50),
      ),
    ]);
    if (done || !value) {
      // Check predicate even on timeout so we can return whatever
      // we've accumulated so far for diagnostics.
      if (predicate(events)) break;
      continue;
    }
    buffer += decoder.decode(value, { stream: true });
    // Parse any complete events from the buffer.
    const parts = buffer.split('\n\n');
    // Keep the last (possibly incomplete) part in the buffer.
    buffer = parts.pop() ?? '';
    for (const block of parts) {
      if (block.trim().length === 0) continue;
      // Skip SSE comment lines (heartbeats) — they start with ':'.
      if (block.startsWith(':')) continue;
      const lines = block.split('\n');
      const eventLine = lines.find((l) => l.startsWith('event: '));
      const dataLine = lines.find((l) => l.startsWith('data: '));
      if (!eventLine) continue;
      events.push({
        event: eventLine.slice('event: '.length),
        data: dataLine ? (JSON.parse(dataLine.slice('data: '.length)) as SSEEvent['data']) : {},
      });
    }
    if (predicate(events)) break;
  }

  try {
    await reader.cancel();
  } catch {
    /* ignore */
  }
  return events;
}

describe('API Server — long-lived session-scoped SSE', () => {
  test('GET /api/v1/sessions/:id/stream returns SSE content type and emits session:stream_open', async () => {
    const sessionId = await createSession();

    const res = await server.handleRequest(
      req(`/api/v1/sessions/${sessionId}/stream`, { headers: authHeaders }),
    );

    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('text/event-stream');
    expect(res.headers.get('Cache-Control')).toBe('no-cache');

    const events = await readSSEUntil(
      res,
      (evts) => evts.some((e) => e.event === 'session:stream_open'),
      500,
    );
    const open = events.find((e) => e.event === 'session:stream_open');
    expect(open).toBeDefined();
    const payload = open!.data.payload as { sessionId: string; heartbeatIntervalMs: number };
    expect(payload.sessionId).toBe(sessionId);
    expect(payload.heartbeatIntervalMs).toBe(30_000);
  });

  test('GET /stream on unknown session returns JSON 404', async () => {
    const res = await server.handleRequest(
      req('/api/v1/sessions/does-not-exist/stream', { headers: authHeaders }),
    );
    expect(res.status).toBe(404);
    expect(res.headers.get('Content-Type')).toContain('application/json');
  });

  test('session stream emits task:start and task:complete for tasks in its session', async () => {
    const sessionId = await createSession();

    const streamRes = await server.handleRequest(
      req(`/api/v1/sessions/${sessionId}/stream`, { headers: authHeaders }),
    );
    expect(streamRes.status).toBe(200);

    // Trigger a task in the session. mockExecuteTask emits task:start
    // and task:complete on the bus synchronously (from the earlier
    // test-harness extension in server-messages.test.ts).
    mockBehavior = (input) => completedResult(input, 'session-stream answer');
    const messageRes = await server.handleRequest(
      req(`/api/v1/sessions/${sessionId}/messages`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({ content: 'run task in session' }),
      }),
    );
    expect(messageRes.status).toBe(200);

    const events = await readSSEUntil(
      streamRes,
      (evts) => evts.some((e) => e.event === 'task:complete'),
      1000,
    );
    const starts = events.filter((e) => e.event === 'task:start');
    const completes = events.filter((e) => e.event === 'task:complete');
    expect(starts.length).toBeGreaterThanOrEqual(1);
    expect(completes.length).toBeGreaterThanOrEqual(1);
    const completePayload = completes[0]!.data.payload as { result: TaskResult };
    expect(completePayload.result.status).toBe('completed');
    expect(completePayload.result.answer).toBe('session-stream answer');
  });

  test('session stream does NOT leak events from other sessions', async () => {
    const sessionA = await createSession();
    const sessionB = await createSession();

    const streamRes = await server.handleRequest(
      req(`/api/v1/sessions/${sessionA}/stream`, { headers: authHeaders }),
    );
    expect(streamRes.status).toBe(200);

    // Run a task in session B. The stream (scoped to session A) must
    // NOT emit any task events for it.
    mockBehavior = (input) => completedResult(input, 'leaked?');
    await server.handleRequest(
      req(`/api/v1/sessions/${sessionB}/messages`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({ content: 'task in B' }),
      }),
    );

    // Wait briefly then collect whatever events fired.
    const events = await readSSEUntil(streamRes, () => false, 300);
    const taskEvents = events.filter(
      (e) => e.event === 'task:start' || e.event === 'task:complete',
    );
    expect(taskEvents).toHaveLength(0);
    // session:stream_open should still appear for session A's stream.
    const open = events.find((e) => e.event === 'session:stream_open');
    expect(open).toBeDefined();
  });

  test('session stream stays open across multiple turns (does NOT auto-close on task:complete)', async () => {
    const sessionId = await createSession();

    const streamRes = await server.handleRequest(
      req(`/api/v1/sessions/${sessionId}/stream`, { headers: authHeaders }),
    );

    // Turn 1
    mockBehavior = (input) => completedResult(input, 'turn 1');
    await server.handleRequest(
      req(`/api/v1/sessions/${sessionId}/messages`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({ content: 'first' }),
      }),
    );

    // Turn 2 — a long-lived stream MUST still be receiving events
    // after the first task:complete fired. If the stream auto-closed
    // (as the per-task variant does), turn 2 events would not appear.
    mockBehavior = (input) => completedResult(input, 'turn 2');
    await server.handleRequest(
      req(`/api/v1/sessions/${sessionId}/messages`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({ content: 'second' }),
      }),
    );

    const events = await readSSEUntil(
      streamRes,
      (evts) => evts.filter((e) => e.event === 'task:complete').length >= 2,
      1500,
    );
    const completes = events.filter((e) => e.event === 'task:complete');
    expect(completes.length).toBeGreaterThanOrEqual(2);
    const answers = completes.map((c) => {
      const p = c.data.payload as { result: TaskResult };
      return p.result.answer;
    });
    expect(answers).toContain('turn 1');
    expect(answers).toContain('turn 2');
  });

  test('session stream forwards agent:clarification_requested events during an input-required turn', async () => {
    const sessionId = await createSession();

    const streamRes = await server.handleRequest(
      req(`/api/v1/sessions/${sessionId}/stream`, { headers: authHeaders }),
    );

    const questions = ['Which module did you mean?'];
    mockBehavior = (input) => inputRequiredResult(input, questions);
    await server.handleRequest(
      req(`/api/v1/sessions/${sessionId}/messages`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({ content: 'ambiguous goal' }),
      }),
    );

    const events = await readSSEUntil(
      streamRes,
      (evts) => evts.some((e) => e.event === 'agent:clarification_requested'),
      1000,
    );
    const clarification = events.find((e) => e.event === 'agent:clarification_requested');
    expect(clarification).toBeDefined();
    const payload = clarification!.data.payload as {
      questions: string[];
      source?: string;
    };
    expect(payload.questions).toEqual(questions);
    expect(payload.source).toBe('agent');
  });
});
