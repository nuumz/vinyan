/**
 * API Server — Phase D+E endpoints.
 *
 * Exercises:
 *   POST /api/v1/sessions/:id/clarification/respond
 *   POST /api/v1/sessions/:id/workflow/approve
 *   POST /api/v1/sessions/:id/workflow/reject
 *
 * All three endpoints translate HTTP bodies into bus events so the
 * orchestrator can resume (structured clarification → agent-loop;
 * approve/reject → awaitApprovalDecision).
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
import { LLMProviderRegistry } from '../../src/orchestrator/llm/provider-registry.ts';
import type { LLMProvider, TaskInput, TaskResult } from '../../src/orchestrator/types.ts';

const TEST_DIR = join(tmpdir(), `vinyan-api-workflow-test-${Date.now()}`);
const TOKEN_PATH = join(TEST_DIR, 'api-token');
const TEST_TOKEN = `test-token-${'a'.repeat(52)}`;

let server: VinyanAPIServer;
let db: Database;
let testBus: VinyanBus;
let capturedEvents: Array<{ name: string; payload: unknown }>;
// Mutable handle so individual `human-input/suggest` tests can swap the
// provider's `generate` behavior (success / parse-fallback / error / no
// items) without rebuilding the whole server.
let suggestProviderImpl: LLMProvider['generate'] = async () => ({
  content: '',
  tokensUsed: { input: 0, output: 0 },
});

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
  const sessionManager = new SessionManager(sessionStore);

  // Stub LLM registry — exercised by the human-input/suggest endpoint.
  // Per-test behavior swaps via `suggestProviderImpl`.
  const llmRegistry = new LLMProviderRegistry();
  llmRegistry.register({
    id: 'mock-fast',
    tier: 'fast',
    generate: (req) => suggestProviderImpl(req),
  });

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
      executeTask: async (input: TaskInput): Promise<TaskResult> => ({
        id: input.id,
        status: 'completed',
        mutations: [],
        trace: {} as TaskResult['trace'],
      }),
      sessionManager,
      llmRegistry,
    },
  );
});

beforeEach(() => {
  capturedEvents = [];
  // Subscribe to the three events under test — fresh bus listeners per test.
  testBus.on('workflow:plan_approved', (p) => capturedEvents.push({ name: 'workflow:plan_approved', payload: p }));
  testBus.on('workflow:plan_rejected', (p) => capturedEvents.push({ name: 'workflow:plan_rejected', payload: p }));
  testBus.on('agent:clarification_response', (p) => capturedEvents.push({ name: 'agent:clarification_response', payload: p }));
});

afterAll(() => {
  db.close();
});

async function postJson(path: string, body: unknown): Promise<Response> {
  return server.handleRequest(
    req(path, { method: 'POST', headers: authHeaders, body: JSON.stringify(body) }),
  );
}

// ---------------------------------------------------------------------------
// Workflow approval
// ---------------------------------------------------------------------------

describe('POST /api/v1/sessions/:id/workflow/approve', () => {
  test('emits workflow:plan_approved and returns 200', async () => {
    const res = await postJson('/api/v1/sessions/sess-1/workflow/approve', { taskId: 'task-1' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; taskId: string; sessionId: string };
    expect(body.status).toBe('approved');
    expect(body.taskId).toBe('task-1');
    expect(body.sessionId).toBe('sess-1');

    const emitted = capturedEvents.find((e) => e.name === 'workflow:plan_approved');
    expect(emitted).toBeDefined();
    expect(emitted!.payload).toEqual({ taskId: 'task-1', sessionId: 'sess-1' });
  });

  test('returns 400 when taskId is missing', async () => {
    const res = await postJson('/api/v1/sessions/sess-1/workflow/approve', {});
    expect(res.status).toBe(400);
    expect(capturedEvents.filter((e) => e.name === 'workflow:plan_approved')).toHaveLength(0);
  });

  test('returns 400 on malformed JSON body', async () => {
    const res = await server.handleRequest(
      req('/api/v1/sessions/sess-1/workflow/approve', {
        method: 'POST',
        headers: authHeaders,
        body: '{not json',
      }),
    );
    expect(res.status).toBe(400);
  });
});

describe('POST /api/v1/sessions/:id/workflow/reject', () => {
  test('emits workflow:plan_rejected with reason and returns 200', async () => {
    const res = await postJson('/api/v1/sessions/sess-1/workflow/reject', {
      taskId: 'task-2',
      reason: 'scope too large',
    });
    expect(res.status).toBe(200);
    const emitted = capturedEvents.find((e) => e.name === 'workflow:plan_rejected');
    expect(emitted).toBeDefined();
    expect(emitted!.payload).toEqual({
      taskId: 'task-2',
      sessionId: 'sess-1',
      reason: 'scope too large',
    });
  });

  test('reason is optional', async () => {
    await postJson('/api/v1/sessions/sess-1/workflow/reject', { taskId: 'task-3' });
    const emitted = capturedEvents.find((e) => e.name === 'workflow:plan_rejected');
    expect(emitted).toBeDefined();
    expect((emitted!.payload as { reason?: string }).reason).toBeUndefined();
  });

  test('returns 400 when taskId is missing', async () => {
    const res = await postJson('/api/v1/sessions/sess-1/workflow/reject', { reason: 'nope' });
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// Workflow human-input answer suggestions
// ---------------------------------------------------------------------------

describe('POST /api/v1/sessions/:id/workflow/human-input/suggest', () => {
  test('returns LLM-supplied suggestions parsed from strict JSON', async () => {
    suggestProviderImpl = async () => ({
      content: '{"suggestions":["Climate change","Universal basic income","AGI alignment"]}',
      tokensUsed: { input: 10, output: 20 },
    });
    const res = await postJson('/api/v1/sessions/sess-1/workflow/human-input/suggest', {
      taskId: 'task-hi',
      stepId: 'step1',
      question: 'What topic should the agents debate?',
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      taskId: string;
      stepId: string;
      sessionId: string;
      suggestions: string[];
    };
    expect(body.taskId).toBe('task-hi');
    expect(body.stepId).toBe('step1');
    expect(body.sessionId).toBe('sess-1');
    expect(body.suggestions).toEqual([
      'Climate change',
      'Universal basic income',
      'AGI alignment',
    ]);
  });

  test('salvages suggestions from a fenced JSON block surrounded by prose', async () => {
    // Some `fast`-tier providers wrap structured output in markdown fences
    // even with strict-JSON system prompts. The endpoint must not surface
    // those as 502s as long as a usable list is recoverable.
    suggestProviderImpl = async () => ({
      content:
        'Here are three ideas for you:\n```json\n{"suggestions":["Quantum computing","Neuro-symbolic AI","Open-source LLMs"]}\n```\nPick whichever resonates.',
      tokensUsed: { input: 10, output: 30 },
    });
    const res = await postJson('/api/v1/sessions/sess-1/workflow/human-input/suggest', {
      taskId: 'task-hi',
      stepId: 'step1',
      question: 'topic?',
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { suggestions: string[] };
    expect(body.suggestions).toHaveLength(3);
    expect(body.suggestions[0]).toBe('Quantum computing');
  });

  test('falls back to numbered/bulleted line parsing when no JSON is found', async () => {
    suggestProviderImpl = async () => ({
      content: '1. Climate change\n2. Universal basic income\n3. AGI alignment',
      tokensUsed: { input: 5, output: 15 },
    });
    const res = await postJson('/api/v1/sessions/sess-1/workflow/human-input/suggest', {
      taskId: 'task-hi',
      stepId: 'step1',
      question: 'topic?',
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { suggestions: string[] };
    expect(body.suggestions).toEqual(['Climate change', 'Universal basic income', 'AGI alignment']);
  });

  test('returns 502 when the LLM returns nothing parseable', async () => {
    suggestProviderImpl = async () => ({
      content: 'I am not sure what to suggest.',
      tokensUsed: { input: 5, output: 8 },
    });
    const res = await postJson('/api/v1/sessions/sess-1/workflow/human-input/suggest', {
      taskId: 'task-hi',
      stepId: 'step1',
      question: 'topic?',
    });
    expect(res.status).toBe(502);
  });

  test('returns 502 when the LLM call throws', async () => {
    suggestProviderImpl = async () => {
      throw new Error('upstream rate limit');
    };
    const res = await postJson('/api/v1/sessions/sess-1/workflow/human-input/suggest', {
      taskId: 'task-hi',
      stepId: 'step1',
      question: 'topic?',
    });
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/rate limit/);
  });

  test('returns 400 when taskId, stepId, or question is missing', async () => {
    const cases: Array<Record<string, unknown>> = [
      { stepId: 'step1', question: 'q' },
      { taskId: 't', question: 'q' },
      { taskId: 't', stepId: 'step1' },
      { taskId: 't', stepId: 'step1', question: '   ' },
    ];
    for (const body of cases) {
      const res = await postJson('/api/v1/sessions/sess-1/workflow/human-input/suggest', body);
      expect(res.status).toBe(400);
    }
  });

  test('clamps count to [2,4] before asking the LLM', async () => {
    // Caller asks for 99 — endpoint must internally cap at 4 (the LLM
    // returning more is fine; the endpoint slices the array to the
    // capped count). Easy to verify by giving the LLM a 6-item answer
    // and asserting only 4 come back.
    suggestProviderImpl = async () => ({
      content: '{"suggestions":["a","b","c","d","e","f"]}',
      tokensUsed: { input: 5, output: 15 },
    });
    const res = await postJson('/api/v1/sessions/sess-1/workflow/human-input/suggest', {
      taskId: 'task-hi',
      stepId: 'step1',
      question: 'topic?',
      count: 99,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { suggestions: string[] };
    expect(body.suggestions).toEqual(['a', 'b', 'c', 'd']);
  });
});

// ---------------------------------------------------------------------------
// Workflow partial-failure decision
// ---------------------------------------------------------------------------

describe('POST /api/v1/sessions/:id/workflow/partial-decision', () => {
  beforeEach(() => {
    testBus.on('workflow:partial_failure_decision_provided', (p) =>
      capturedEvents.push({ name: 'workflow:partial_failure_decision_provided', payload: p }),
    );
  });

  test("emits decision_provided with decision='continue'", async () => {
    const res = await postJson('/api/v1/sessions/sess-1/workflow/partial-decision', {
      taskId: 'task-pf',
      decision: 'continue',
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { decision: string; status: string };
    expect(body.decision).toBe('continue');
    expect(body.status).toBe('recorded');
    const emitted = capturedEvents.find(
      (e) => e.name === 'workflow:partial_failure_decision_provided',
    );
    expect(emitted).toBeDefined();
    expect(emitted!.payload).toEqual({
      taskId: 'task-pf',
      sessionId: 'sess-1',
      decision: 'continue',
    });
  });

  test("emits decision_provided with decision='abort' + rationale", async () => {
    const res = await postJson('/api/v1/sessions/sess-1/workflow/partial-decision', {
      taskId: 'task-pf-2',
      decision: 'abort',
      rationale: 'user wants to redo step2 first',
    });
    expect(res.status).toBe(200);
    const emitted = capturedEvents
      .filter((e) => e.name === 'workflow:partial_failure_decision_provided')
      .pop();
    expect(emitted).toBeDefined();
    expect((emitted!.payload as { rationale: string }).rationale).toBe(
      'user wants to redo step2 first',
    );
  });

  test('returns 400 for invalid decision values', async () => {
    const res = await postJson('/api/v1/sessions/sess-1/workflow/partial-decision', {
      taskId: 'task-pf',
      decision: 'maybe',
    });
    expect(res.status).toBe(400);
  });

  test('returns 400 when taskId missing', async () => {
    const res = await postJson('/api/v1/sessions/sess-1/workflow/partial-decision', {
      decision: 'continue',
    });
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// Clarification response
// ---------------------------------------------------------------------------

describe('POST /api/v1/sessions/:id/clarification/respond', () => {
  test('emits agent:clarification_response with structured responses', async () => {
    const res = await postJson('/api/v1/sessions/sess-1/clarification/respond', {
      taskId: 'task-10',
      responses: [
        { questionId: 'genre', selectedOptionIds: ['romance-fantasy'] },
        { questionId: 'tone', selectedOptionIds: ['serious', 'heartwarming'] },
        { questionId: 'audience', selectedOptionIds: [], freeText: 'adults who like slow-burn' },
      ],
    });
    expect(res.status).toBe(200);

    const emitted = capturedEvents.find((e) => e.name === 'agent:clarification_response');
    expect(emitted).toBeDefined();
    const payload = emitted!.payload as {
      taskId: string;
      sessionId: string;
      responses: Array<{ questionId: string; selectedOptionIds: string[]; freeText?: string }>;
    };
    expect(payload.taskId).toBe('task-10');
    expect(payload.sessionId).toBe('sess-1');
    expect(payload.responses).toHaveLength(3);
    expect(payload.responses[0]!.selectedOptionIds).toEqual(['romance-fantasy']);
    expect(payload.responses[1]!.selectedOptionIds).toEqual(['serious', 'heartwarming']);
    expect(payload.responses[2]!.freeText).toContain('slow-burn');
  });

  test('returns 400 when responses is missing', async () => {
    const res = await postJson('/api/v1/sessions/sess-1/clarification/respond', { taskId: 'task-10' });
    expect(res.status).toBe(400);
  });

  test('returns 400 when taskId is missing', async () => {
    const res = await postJson('/api/v1/sessions/sess-1/clarification/respond', { responses: [] });
    expect(res.status).toBe(400);
  });

  test('coerces non-string selectedOptionIds into strings defensively', async () => {
    const res = await postJson('/api/v1/sessions/sess-1/clarification/respond', {
      taskId: 'task-10',
      responses: [{ questionId: 'genre', selectedOptionIds: [123, 'ok'] as never }],
    });
    expect(res.status).toBe(200);
    const emitted = capturedEvents.find((e) => e.name === 'agent:clarification_response');
    const payload = emitted!.payload as {
      responses: Array<{ selectedOptionIds: string[] }>;
    };
    expect(payload.responses[0]!.selectedOptionIds).toEqual(['123', 'ok']);
  });
});
