/**
 * Operations console contract tests for `GET /api/v1/tasks` and friends.
 *
 * Covers the gaps the legacy list endpoint silently masked:
 *   - rich result statuses are preserved (not collapsed to `failed`)
 *   - filter / pagination / sort query params are honoured
 *   - cancel persists `cancelled` for session-backed tasks
 *   - retry emits a durable `task:retry_requested` event
 *   - archive / unarchive round-trips the visibility flag
 *   - the rich detail endpoint returns lifecycle + lineage fields
 */
import { Database } from 'bun:sqlite';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { VinyanAPIServer } from '../../src/api/server.ts';
import { SessionManager } from '../../src/api/session-manager.ts';
import { createBus, type VinyanBus } from '../../src/core/bus.ts';
import { ALL_MIGRATIONS, MigrationRunner } from '../../src/db/migrations/index.ts';
import { SessionStore } from '../../src/db/session-store.ts';
import { TaskEventStore } from '../../src/db/task-event-store.ts';
import type { TaskInput, TaskResult } from '../../src/orchestrator/types.ts';

const TEST_DIR = join(tmpdir(), `vinyan-tasks-ops-test-${Date.now()}`);
const TOKEN_PATH = join(TEST_DIR, 'api-token');
const TEST_TOKEN = `test-token-${'a'.repeat(52)}`;

let server: VinyanAPIServer;
let db: Database;
let bus: VinyanBus;
let sessionStore: SessionStore;
let sessionManager: SessionManager;
let taskEventStore: TaskEventStore;

const authHeaders = { Authorization: `Bearer ${TEST_TOKEN}`, 'Content-Type': 'application/json' };

function req(path: string, opts: { method?: string; body?: string } = {}): Request {
  return new Request(`http://localhost${path}`, {
    method: opts.method ?? 'GET',
    headers: authHeaders,
    body: opts.body,
  });
}

/**
 * Mock executor — distinguish goals so we can exercise multiple result
 * statuses (completed, failed, escalated, partial, timeout) without
 * spinning the full orchestrator.
 */
function mockExecuteTask(input: TaskInput): Promise<TaskResult> {
  const goal = input.goal;
  const baseTrace = {
    id: `trace-${input.id}`,
    taskId: input.id,
    timestamp: Date.now(),
    routingLevel: 1,
    approach: 'test',
    modelUsed: 'mock/test',
    tokensConsumed: 100,
    durationMs: 50,
    outcome: 'success',
    oracleVerdicts: {},
    affectedFiles: [],
  };
  if (goal === 'partial-task') {
    return Promise.resolve({
      id: input.id,
      status: 'partial',
      mutations: [],
      trace: { ...baseTrace, outcome: 'partial' },
      answer: 'partial result',
    } as TaskResult);
  }
  if (goal === 'escalated-task') {
    return Promise.resolve({
      id: input.id,
      status: 'escalated',
      mutations: [],
      trace: { ...baseTrace, outcome: 'escalated' },
      escalationReason: 'manual escalation',
    } as TaskResult);
  }
  if (goal === 'timeout-task') {
    return Promise.resolve({
      id: input.id,
      status: 'failed',
      mutations: [],
      trace: { ...baseTrace, approach: 'wall-clock-timeout', outcome: 'timeout', durationMs: 151_000 },
      answer: 'Task timed out after 151s.',
    } as TaskResult);
  }
  return Promise.resolve({
    id: input.id,
    status: 'completed',
    mutations: [],
    trace: baseTrace,
  } as unknown as TaskResult);
}

beforeAll(() => {
  mkdirSync(TEST_DIR, { recursive: true });
  writeFileSync(TOKEN_PATH, TEST_TOKEN);

  db = new Database(':memory:');
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  new MigrationRunner().migrate(db, ALL_MIGRATIONS);

  bus = createBus();
  sessionStore = new SessionStore(db);
  sessionManager = new SessionManager(sessionStore);
  taskEventStore = new TaskEventStore(db);

  // Wire the recorder so retry / cancel events land in `task_events` and
  // the operations console drawer can replay the lineage.
  bus.on('task:retry_requested', (payload) => {
    taskEventStore.append({
      taskId: payload.parentTaskId,
      sessionId: payload.sessionId,
      eventType: 'task:retry_requested',
      payload,
      ts: Date.now(),
    });
  });
  bus.on('task:cancelled', (payload) => {
    taskEventStore.append({
      taskId: payload.taskId,
      sessionId: payload.sessionId,
      eventType: 'task:cancelled',
      payload,
      ts: Date.now(),
    });
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
      bus,
      executeTask: mockExecuteTask,
      sessionManager,
      taskEventStore,
    },
  );
});

afterAll(() => {
  db.close();
});

async function createSession(): Promise<string> {
  const res = await server.handleRequest(
    req('/api/v1/sessions', {
      method: 'POST',
      body: JSON.stringify({ source: 'ui' }),
    }),
  );
  const body = (await res.json()) as { session: { id: string } };
  return body.session.id;
}

async function submitGoalInSession(sessionId: string, goal: string): Promise<string> {
  const res = await server.handleRequest(
    req('/api/v1/tasks', {
      method: 'POST',
      body: JSON.stringify({ goal, sessionId }),
    }),
  );
  const body = (await res.json()) as { result: TaskResult };
  return body.result.id;
}

describe('GET /api/v1/tasks operations console', () => {
  test('preserves rich result statuses (no failed-collapse)', async () => {
    const sid = await createSession();
    await submitGoalInSession(sid, 'partial-task');
    await submitGoalInSession(sid, 'escalated-task');

    const res = await server.handleRequest(req(`/api/v1/tasks?sessionId=${sid}&limit=50`));
    const body = (await res.json()) as { tasks: Array<{ status: string; resultStatus?: string }> };
    const statuses = body.tasks.map((t) => t.status);
    expect(statuses).toContain('partial');
    expect(statuses).toContain('escalated');
    // The legacy projection collapsed both to 'failed' — assert that did
    // not happen.
    expect(statuses).not.toEqual(expect.arrayContaining(['failed']));
  });

  test('honours status filter', async () => {
    const sid = await createSession();
    await submitGoalInSession(sid, 'completed-task-a');
    await submitGoalInSession(sid, 'partial-task');

    const res = await server.handleRequest(
      req(`/api/v1/tasks?sessionId=${sid}&status=partial&limit=50`),
    );
    const body = (await res.json()) as { tasks: Array<{ status: string }>; counts: { byStatus: Record<string, number> } };
    expect(body.tasks.every((t) => t.status === 'partial')).toBe(true);
    expect(body.tasks.length).toBeGreaterThanOrEqual(1);
  });

  test('honours search query against goal', async () => {
    const sid = await createSession();
    await submitGoalInSession(sid, 'unique-marker-zebra');
    await submitGoalInSession(sid, 'unrelated');

    const res = await server.handleRequest(
      req(`/api/v1/tasks?sessionId=${sid}&search=zebra`),
    );
    const body = (await res.json()) as { tasks: Array<{ goal?: string }>; total: number };
    expect(body.total).toBe(1);
    expect(body.tasks[0]?.goal).toBe('unique-marker-zebra');
  });

  test('paginates with limit + offset and exposes total', async () => {
    const sid = await createSession();
    for (let i = 0; i < 5; i++) {
      await submitGoalInSession(sid, `pagination-task-${i}`);
    }
    const first = await server.handleRequest(
      req(`/api/v1/tasks?sessionId=${sid}&limit=2&offset=0`),
    );
    const body = (await first.json()) as { tasks: unknown[]; total: number; limit: number; offset: number };
    expect(body.tasks.length).toBe(2);
    expect(body.limit).toBe(2);
    expect(body.offset).toBe(0);
    expect(body.total).toBeGreaterThanOrEqual(5);

    const second = await server.handleRequest(
      req(`/api/v1/tasks?sessionId=${sid}&limit=2&offset=2`),
    );
    const body2 = (await second.json()) as { tasks: unknown[]; offset: number };
    expect(body2.tasks.length).toBe(2);
    expect(body2.offset).toBe(2);
  });

  test('returns aggregate counts including needsActionTotal', async () => {
    const sid = await createSession();
    await submitGoalInSession(sid, 'completed-task-counts');
    await submitGoalInSession(sid, 'partial-task');
    await submitGoalInSession(sid, 'timeout-task');

    const res = await server.handleRequest(req(`/api/v1/tasks?sessionId=${sid}&limit=50`));
    const body = (await res.json()) as {
      counts: {
        byStatus: Record<string, number>;
        byNeedsAction: Record<string, number>;
        needsActionTotal: number;
      };
    };
    expect(body.counts.byStatus.completed).toBeGreaterThanOrEqual(1);
    expect(body.counts.byStatus.partial).toBeGreaterThanOrEqual(1);
    expect(body.counts.needsActionTotal).toBeGreaterThanOrEqual(1);
  });
});

describe('GET /api/v1/tasks/:id detail', () => {
  test('returns lifecycle + lineage fields', async () => {
    const sid = await createSession();
    const taskId = await submitGoalInSession(sid, 'detail-task');

    const res = await server.handleRequest(req(`/api/v1/tasks/${taskId}`));
    const body = (await res.json()) as {
      taskId: string;
      sessionId: string;
      status: string;
      lifecycle: { createdAt: number; updatedAt: number; archivedAt: number | null };
      lineage: { retryChildren: string[] };
      eventHistory: { recorder: boolean };
    };
    expect(body.taskId).toBe(taskId);
    expect(body.sessionId).toBe(sid);
    expect(body.status).toBe('completed');
    expect(body.lifecycle.archivedAt).toBeNull();
    expect(body.lifecycle.createdAt).toBeGreaterThan(0);
    expect(body.eventHistory.recorder).toBe(true);
    expect(Array.isArray(body.lineage.retryChildren)).toBe(true);
  });
});

describe('DELETE /api/v1/tasks/:id (cancel)', () => {
  test('persists cancelled status for session-backed task', async () => {
    const sid = await createSession();
    // Insert a pending task directly so it survives the mock executor's
    // immediate completion. We create an input row but do not invoke
    // executeTask — sessionManager.addTask just persists the row.
    const taskId = `pending-${Date.now()}`;
    sessionManager.addTask(sid, {
      id: taskId,
      source: 'api' as TaskInput['source'],
      goal: 'pending-task',
      taskType: 'reasoning' as TaskInput['taskType'],
      budget: { maxTokens: 100, maxDurationMs: 1000, maxRetries: 1 },
    });

    const cancel = await server.handleRequest(
      req(`/api/v1/tasks/${taskId}`, { method: 'DELETE' }),
    );
    expect(cancel.status).toBe(200);

    const list = await server.handleRequest(req(`/api/v1/tasks?sessionId=${sid}&limit=50&visibility=all`));
    const body = (await list.json()) as { tasks: Array<{ taskId: string; status: string; dbStatus?: string }> };
    const row = body.tasks.find((t) => t.taskId === taskId);
    expect(row).toBeDefined();
    expect(row?.status).toBe('cancelled');
    expect(row?.dbStatus).toBe('cancelled');

    // Lifecycle event recorded for replay.
    const events = taskEventStore.listForTask(taskId, { limit: 20 });
    expect(events.some((ev) => ev.eventType === 'task:cancelled')).toBe(true);
  });
});

describe('POST /api/v1/tasks/:id/retry lineage', () => {
  test('records task:retry_requested under the parent so replay sees the chain', async () => {
    const sid = await createSession();
    const parentId = await submitGoalInSession(sid, 'parent-task');

    const retry = await server.handleRequest(
      req(`/api/v1/tasks/${parentId}/retry`, {
        method: 'POST',
        body: JSON.stringify({ reason: 'unit-test' }),
      }),
    );
    expect(retry.status).toBe(202);
    const body = (await retry.json()) as { taskId: string; parentTaskId: string };
    expect(body.parentTaskId).toBe(parentId);

    // EVENT_MANIFEST flips this to record:true, so we expect at least one
    // persisted retry event under the parent's task id.
    const events = taskEventStore.listForTask(parentId, { limit: 20 });
    expect(events.some((ev) => ev.eventType === 'task:retry_requested')).toBe(true);
  });
});

describe('POST /api/v1/tasks/:id/retry — backend-authoritative budget policy', () => {
  test("timeout-trace parent → response budget = TIMEOUT_RETRY_BUDGET (240s) and policy = 'timeout'", async () => {
    const sid = await createSession();
    const parentId = await submitGoalInSession(sid, 'timeout-task');
    // Mock executor sets trace.outcome === 'timeout' for goal === 'timeout-task'.

    const retry = await server.handleRequest(
      req(`/api/v1/tasks/${parentId}/retry`, {
        method: 'POST',
        body: JSON.stringify({ reason: 'policy-test' }),
      }),
    );
    expect(retry.status).toBe(202);
    const body = (await retry.json()) as {
      policy: string;
      budget: { maxDurationMs: number; maxTokens: number; maxRetries: number };
    };
    expect(body.policy).toBe('timeout');
    expect(body.budget.maxDurationMs).toBe(240_000);
  });

  test("standard failure parent → response policy = 'standard' and budget shrinks", async () => {
    const sid = await createSession();
    // 'escalated-task' produces status='escalated' with non-timeout
    // trace.outcome — the standard branch.
    const parentId = await submitGoalInSession(sid, 'escalated-task');

    const retry = await server.handleRequest(
      req(`/api/v1/tasks/${parentId}/retry`, {
        method: 'POST',
        body: JSON.stringify({ reason: 'policy-test' }),
      }),
    );
    expect(retry.status).toBe(202);
    const body = (await retry.json()) as {
      policy: string;
      budget: { maxDurationMs: number; maxTokens: number; maxRetries: number };
    };
    expect(body.policy).toBe('standard');
    // The standard budget is short by design — see STANDARD_RETRY_BUDGET
    // in src/api/server.ts.
    expect(body.budget.maxDurationMs).toBeLessThan(240_000);
    expect(body.budget.maxRetries).toBeLessThan(3);
  });

  test("explicit body.maxDurationMs → policy = 'client-override' (UI escape hatch preserved)", async () => {
    const sid = await createSession();
    const parentId = await submitGoalInSession(sid, 'escalated-task');

    const retry = await server.handleRequest(
      req(`/api/v1/tasks/${parentId}/retry`, {
        method: 'POST',
        body: JSON.stringify({ reason: 'policy-test', maxDurationMs: 90_000 }),
      }),
    );
    expect(retry.status).toBe(202);
    const body = (await retry.json()) as { policy: string; budget: { maxDurationMs: number } };
    expect(body.policy).toBe('client-override');
    expect(body.budget.maxDurationMs).toBe(90_000);
  });
});

describe('archive / unarchive', () => {
  test('round-trips visibility flag', async () => {
    const sid = await createSession();
    const taskId = await submitGoalInSession(sid, 'archive-task');

    const archive = await server.handleRequest(
      req(`/api/v1/tasks/${taskId}/archive`, { method: 'POST' }),
    );
    expect(archive.status).toBe(200);

    // Default visibility=active → archived row is hidden.
    const active = await server.handleRequest(req(`/api/v1/tasks?sessionId=${sid}&limit=50`));
    const activeBody = (await active.json()) as { tasks: Array<{ taskId: string }> };
    expect(activeBody.tasks.find((t) => t.taskId === taskId)).toBeUndefined();

    const archivedView = await server.handleRequest(
      req(`/api/v1/tasks?sessionId=${sid}&visibility=archived&limit=50`),
    );
    const archivedBody = (await archivedView.json()) as { tasks: Array<{ taskId: string; archivedAt: number | null }> };
    const found = archivedBody.tasks.find((t) => t.taskId === taskId);
    expect(found).toBeDefined();
    expect(typeof found?.archivedAt).toBe('number');

    // Restoring puts it back in the active view.
    await server.handleRequest(req(`/api/v1/tasks/${taskId}/unarchive`, { method: 'POST' }));
    const restored = await server.handleRequest(req(`/api/v1/tasks?sessionId=${sid}&limit=50`));
    const restoredBody = (await restored.json()) as { tasks: Array<{ taskId: string }> };
    expect(restoredBody.tasks.some((t) => t.taskId === taskId)).toBe(true);
  });
});

describe('needs-action gate refinement', () => {
  test('partial result without an open gate is NOT flagged as partial-decision', async () => {
    const sid = await createSession();
    const taskId = await submitGoalInSession(sid, 'partial-task');

    const list = await server.handleRequest(req(`/api/v1/tasks?sessionId=${sid}&limit=50`));
    const body = (await list.json()) as { tasks: Array<{ taskId: string; status: string; needsActionType: string }> };
    const row = body.tasks.find((t) => t.taskId === taskId);
    expect(row?.status).toBe('partial');
    // No `_needed` event was recorded for this task — the row classifier
    // would have fired 'partial-decision' from the heuristic, but the
    // gate-state refinement strips it.
    expect(row?.needsActionType).toBe('none');
  });

  test('partial result WITH an open gate keeps the partial-decision flag', async () => {
    const sid = await createSession();
    const taskId = await submitGoalInSession(sid, 'partial-task');

    // Simulate the workflow recording a gate event without a paired
    // `_provided` — i.e. the user has not yet decided.
    taskEventStore.append({
      taskId,
      sessionId: sid,
      eventType: 'workflow:partial_failure_decision_needed',
      payload: { taskId, sessionId: sid, reason: 'researcher failed' },
      ts: Date.now(),
    });

    const list = await server.handleRequest(req(`/api/v1/tasks?sessionId=${sid}&limit=50`));
    const body = (await list.json()) as { tasks: Array<{ taskId: string; needsActionType: string }> };
    const row = body.tasks.find((t) => t.taskId === taskId);
    expect(row?.needsActionType).toBe('partial-decision');

    const detail = await server.handleRequest(req(`/api/v1/tasks/${taskId}`));
    const detailBody = (await detail.json()) as { pendingGates: { partialDecision: boolean } };
    expect(detailBody.pendingGates.partialDecision).toBe(true);
  });
});

describe('GET /api/v1/tasks/:id/export', () => {
  test('returns task summary + result + persisted events', async () => {
    const sid = await createSession();
    const taskId = await submitGoalInSession(sid, 'export-task');

    const res = await server.handleRequest(req(`/api/v1/tasks/${taskId}/export`));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      taskId: string;
      sessionId: string;
      result: TaskResult;
      events: unknown[];
    };
    expect(body.taskId).toBe(taskId);
    expect(body.sessionId).toBe(sid);
    expect(body.result?.status).toBe('completed');
    expect(Array.isArray(body.events)).toBe(true);
  });
});
