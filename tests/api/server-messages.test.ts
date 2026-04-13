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
    const history = sessionManager.getConversationHistory(sessionId);
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

  test('input-required round-trip: first call pauses, second call injects CLARIFIED constraint', async () => {
    const sessionId = await createSession();
    const questions = [
      'Which helper did you mean — auth or utils?',
      'Should the old one stay as an alias?',
    ];

    // Turn 1: the agent pauses with two questions.
    mockBehavior = (input) => inputRequiredResult(input, questions);
    const firstRes = await server.handleRequest(
      req(`/api/v1/sessions/${sessionId}/messages`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({ content: 'refactor the helper' }),
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
    // previous turn was input-required and inject CLARIFIED:<q>=><answer>
    // constraints into the next TaskInput.
    mockBehavior = (input) => completedResult(input, 'applied');
    const secondRes = await server.handleRequest(
      req(`/api/v1/sessions/${sessionId}/messages`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({ content: 'the auth one; no, remove it entirely' }),
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

    // Critically: the SECOND captured TaskInput should carry the
    // CLARIFIED: constraints for BOTH questions so
    // buildInitUserMessage renders them in the init prompt.
    expect(capturedInputs).toHaveLength(2);
    const secondInput = capturedInputs[1]!;
    const constraints = secondInput.constraints ?? [];
    expect(constraints).toContain(
      `CLARIFIED:${questions[0]}=>the auth one; no, remove it entirely`,
    );
    expect(constraints).toContain(
      `CLARIFIED:${questions[1]}=>the auth one; no, remove it entirely`,
    );
    // And the sessionId is still set so core-loop can load history.
    expect(secondInput.sessionId).toBe(sessionId);
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
    expect(turn2Constraints.some((c) => c.startsWith('CLARIFIED:'))).toBe(true);

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
    expect(turn3Constraints.some((c) => c.startsWith('CLARIFIED:'))).toBe(false);
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

    const history = sessionManager.getConversationHistory(sessionId);
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

  test('streamed clarification follow-up carries CLARIFIED: constraint on the next turn', async () => {
    const sessionId = await createSession();
    const questions = ['Which file?'];

    // Turn 1 (stream): input-required
    mockBehavior = (input) => inputRequiredResult(input, questions);
    const firstRes = await server.handleRequest(
      req(`/api/v1/sessions/${sessionId}/messages`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({ content: 'do it', stream: true }),
      }),
    );
    await firstRes.text();
    await flushMicrotasks();

    // Turn 2 (stream): user answers — server auto-wraps as CLARIFIED: constraint
    mockBehavior = (input) => completedResult(input, 'done');
    const secondRes = await server.handleRequest(
      req(`/api/v1/sessions/${sessionId}/messages`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({ content: 'src/auth.ts', stream: true }),
      }),
    );
    await secondRes.text();
    await flushMicrotasks();

    expect(capturedInputs).toHaveLength(2);
    const secondInput = capturedInputs[1]!;
    expect(secondInput.constraints).toContain(`CLARIFIED:${questions[0]}=>src/auth.ts`);
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
