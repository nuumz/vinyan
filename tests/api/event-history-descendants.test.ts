/**
 * API server — `GET /api/v1/tasks/:id/event-history?includeDescendants=true`.
 *
 * The chat UI's "Multi-agent complete" Process Replay card needs per-sub-
 * agent tool activity (Read/Grep/Bash counts inside expandable rows). Sub-
 * agents emit `agent:tool_*` events under their own `taskId`, so a per-task
 * fetch on the parent only sees `workflow:delegate_*` summaries. The
 * descendants flag widens the result to the resolved tree.
 *
 * These tests pin the contract: tree resolution via `workflow:delegate_
 * dispatched.subTaskId`, depth/cycle bounds, the cursor shape switch, the
 * cross-session defense-in-depth filter, and the 64-task truncation cap.
 */
import { Database } from 'bun:sqlite';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { VinyanAPIServer } from '../../src/api/server.ts';
import { SessionManager } from '../../src/api/session-manager.ts';
import { createBus, type VinyanBus } from '../../src/core/bus.ts';
import { ALL_MIGRATIONS, MigrationRunner } from '../../src/db/migrations/index.ts';
import { SessionStore } from '../../src/db/session-store.ts';
import { TaskEventStore, TREE_TASKID_CAP } from '../../src/db/task-event-store.ts';
import {
  migratePipelineConfidenceColumns,
  migrateThinkingColumns,
  migrateTranscriptColumns,
  TRACE_SCHEMA_SQL,
} from '../../src/db/trace-schema.ts';
import { TraceStore } from '../../src/db/trace-store.ts';
import type { TaskInput, TaskResult } from '../../src/orchestrator/types.ts';

const TEST_DIR = join(tmpdir(), `vinyan-event-history-desc-test-${Date.now()}`);
const TOKEN_PATH = join(TEST_DIR, 'api-token');
const TEST_TOKEN = `test-token-${'a'.repeat(52)}`;
const authHeaders = { Authorization: `Bearer ${TEST_TOKEN}`, 'Content-Type': 'application/json' };

let db: Database;
let bus: VinyanBus;
let taskEventStore: TaskEventStore;
let serverWithStore: VinyanAPIServer;
let serverWithoutStore: VinyanAPIServer;

function req(path: string): Request {
  return new Request(`http://localhost${path}`, { method: 'GET', headers: authHeaders });
}

beforeAll(() => {
  mkdirSync(TEST_DIR, { recursive: true });
  writeFileSync(TOKEN_PATH, TEST_TOKEN);

  db = new Database(':memory:');
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  new MigrationRunner().migrate(db, ALL_MIGRATIONS);
  db.exec(TRACE_SCHEMA_SQL);
  migratePipelineConfidenceColumns(db);
  migrateTranscriptColumns(db);
  migrateThinkingColumns(db);

  bus = createBus();
  const sessionStore = new SessionStore(db);
  const traceStore = new TraceStore(db);
  taskEventStore = new TaskEventStore(db);
  const sessionManager = new SessionManager(sessionStore, traceStore);

  const apiOptions = {
    port: 0,
    bind: '127.0.0.1',
    tokenPath: TOKEN_PATH,
    authRequired: true,
    rateLimitEnabled: false,
  } as const;
  const baseDeps = {
    bus,
    executeTask: (input: TaskInput) =>
      Promise.resolve({ id: input.id, status: 'completed', mutations: [], answer: 'ok' } as unknown as TaskResult),
    sessionManager,
    traceStore,
  };
  serverWithStore = new VinyanAPIServer(apiOptions, { ...baseDeps, taskEventStore });
  serverWithoutStore = new VinyanAPIServer(apiOptions, { ...baseDeps });
});

afterAll(() => {
  db.close();
});

/** Append a parent → child dispatch edge plus a tool call inside the child. */
function seedDelegateAndTool(opts: {
  parentTaskId: string;
  childTaskId: string;
  sessionId: string;
  parentTs: number;
  childTs: number;
  toolName?: string;
}): void {
  taskEventStore.append({
    taskId: opts.parentTaskId,
    sessionId: opts.sessionId,
    eventType: 'workflow:delegate_dispatched',
    payload: { taskId: opts.parentTaskId, subTaskId: opts.childTaskId, agentId: 'researcher', stepId: 'step-1' },
    ts: opts.parentTs,
  });
  taskEventStore.append({
    taskId: opts.childTaskId,
    sessionId: opts.sessionId,
    eventType: 'agent:tool_executed',
    payload: { taskId: opts.childTaskId, toolName: opts.toolName ?? 'Read', durationMs: 5 },
    ts: opts.childTs,
  });
}

describe('GET /api/v1/tasks/:id/event-history — descendants mode', () => {
  test('default mode (no flag) returns only parent events with lastSeq cursor', async () => {
    const T = 'tree-A';
    seedDelegateAndTool({
      parentTaskId: T,
      childTaskId: 'tree-A-c1',
      sessionId: 'sess-A',
      parentTs: 100,
      childTs: 200,
      toolName: 'Read',
    });

    const res = await serverWithStore.handleRequest(req(`/api/v1/tasks/${T}/event-history`));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      taskId: string;
      events: Array<{ eventType: string; taskId: string }>;
      lastSeq: number;
      nextCursor?: string;
    };
    // Legacy shape: lastSeq present, nextCursor absent.
    expect(body.taskId).toBe(T);
    expect(body.lastSeq).toBeGreaterThan(0);
    expect(body.nextCursor).toBeUndefined();
    // Only the parent's own delegate_dispatched event — child tool call is
    // under tree-A-c1, not tree-A.
    expect(body.events.every((e) => e.taskId === T)).toBe(true);
    expect(body.events.some((e) => e.eventType === 'workflow:delegate_dispatched')).toBe(true);
    expect(body.events.some((e) => e.eventType === 'agent:tool_executed')).toBe(false);
  });

  test('descendants mode returns parent + child events ordered by ts', async () => {
    const T = 'tree-B';
    seedDelegateAndTool({
      parentTaskId: T,
      childTaskId: 'tree-B-c1',
      sessionId: 'sess-B',
      parentTs: 1000,
      childTs: 1100,
      toolName: 'Read',
    });

    const res = await serverWithStore.handleRequest(
      req(`/api/v1/tasks/${T}/event-history?includeDescendants=true`),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      taskId: string;
      rootTaskId: string;
      taskIds: string[];
      events: Array<{ eventType: string; taskId: string; ts: number }>;
      nextCursor?: string;
      truncated: boolean;
    };
    expect(body.taskId).toBe(T);
    expect(body.rootTaskId).toBe(T);
    expect(body.taskIds.sort()).toEqual([T, 'tree-B-c1'].sort());
    expect(body.truncated).toBe(false);

    // ts-ordered: dispatch (1000) before tool_executed (1100)
    const types = body.events.map((e) => e.eventType);
    expect(types).toContain('workflow:delegate_dispatched');
    expect(types).toContain('agent:tool_executed');
    const dispatchTs = body.events.find((e) => e.eventType === 'workflow:delegate_dispatched')?.ts ?? Infinity;
    const toolTs = body.events.find((e) => e.eventType === 'agent:tool_executed')?.ts ?? -Infinity;
    expect(dispatchTs).toBeLessThan(toolTs);

    const childToolEvent = body.events.find(
      (e) => e.taskId === 'tree-B-c1' && e.eventType === 'agent:tool_executed',
    );
    expect(childToolEvent).toBeDefined();
  });

  test('depth limit honored — maxDepth bounds tree expansion', async () => {
    // Chain T → C1 → C2 → C3. Each link via delegate_dispatched on the
    // parent of that edge; each child also emits a tool_executed so we
    // can check inclusion by counting events.
    const T = 'tree-D';
    taskEventStore.append({
      taskId: T,
      sessionId: 'sess-D',
      eventType: 'workflow:delegate_dispatched',
      payload: { taskId: T, subTaskId: 'tree-D-c1', agentId: 'r', stepId: 's1' },
      ts: 1,
    });
    taskEventStore.append({
      taskId: 'tree-D-c1',
      sessionId: 'sess-D',
      eventType: 'workflow:delegate_dispatched',
      payload: { taskId: 'tree-D-c1', subTaskId: 'tree-D-c2', agentId: 'r', stepId: 's1' },
      ts: 2,
    });
    taskEventStore.append({
      taskId: 'tree-D-c2',
      sessionId: 'sess-D',
      eventType: 'workflow:delegate_dispatched',
      payload: { taskId: 'tree-D-c2', subTaskId: 'tree-D-c3', agentId: 'r', stepId: 's1' },
      ts: 3,
    });
    taskEventStore.append({
      taskId: 'tree-D-c3',
      sessionId: 'sess-D',
      eventType: 'agent:tool_executed',
      payload: { taskId: 'tree-D-c3', toolName: 'Read' },
      ts: 4,
    });

    const res2 = await serverWithStore.handleRequest(
      req(`/api/v1/tasks/${T}/event-history?includeDescendants=true&maxDepth=2`),
    );
    const body2 = (await res2.json()) as { taskIds: string[] };
    // depth=2 covers root + 2 generations: T, c1, c2 — c3 excluded.
    expect(body2.taskIds.sort()).toEqual([T, 'tree-D-c1', 'tree-D-c2'].sort());

    const res3 = await serverWithStore.handleRequest(
      req(`/api/v1/tasks/${T}/event-history?includeDescendants=true&maxDepth=3`),
    );
    const body3 = (await res3.json()) as { taskIds: string[] };
    expect(body3.taskIds.sort()).toEqual([T, 'tree-D-c1', 'tree-D-c2', 'tree-D-c3'].sort());
  });

  test('cycle protection — does not infinite-loop on a self-referencing edge', async () => {
    const T = 'tree-Cy';
    taskEventStore.append({
      taskId: T,
      sessionId: 'sess-Cy',
      eventType: 'workflow:delegate_dispatched',
      payload: { taskId: T, subTaskId: 'tree-Cy-c1', agentId: 'r', stepId: 's1' },
      ts: 1,
    });
    // C1 emits a dispatched event whose subTaskId loops back to T.
    taskEventStore.append({
      taskId: 'tree-Cy-c1',
      sessionId: 'sess-Cy',
      eventType: 'workflow:delegate_dispatched',
      payload: { taskId: 'tree-Cy-c1', subTaskId: T, agentId: 'r', stepId: 's1' },
      ts: 2,
    });

    const res = await serverWithStore.handleRequest(
      req(`/api/v1/tasks/${T}/event-history?includeDescendants=true&maxDepth=5`),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { taskIds: string[] };
    // Only T and C1 — the back-edge to T is blocked by the visited set.
    expect(body.taskIds.sort()).toEqual([T, 'tree-Cy-c1'].sort());
  });

  test('cursor round-trip — limit=N produces stable pagination across parent + child', async () => {
    const T = 'tree-Cur';
    taskEventStore.append({
      taskId: T,
      sessionId: 'sess-Cur',
      eventType: 'workflow:delegate_dispatched',
      payload: { taskId: T, subTaskId: 'tree-Cur-c1', agentId: 'r', stepId: 's1' },
      ts: 10,
    });
    for (let i = 0; i < 4; i++) {
      taskEventStore.append({
        taskId: 'tree-Cur-c1',
        sessionId: 'sess-Cur',
        eventType: 'agent:tool_executed',
        payload: { taskId: 'tree-Cur-c1', toolName: 'Read', i },
        ts: 20 + i,
      });
    }

    const page1 = await serverWithStore
      .handleRequest(req(`/api/v1/tasks/${T}/event-history?includeDescendants=true&limit=2`))
      .then((r) => r.json() as Promise<{ events: Array<{ id: string }>; nextCursor?: string }>);
    expect(page1.events.length).toBe(2);
    expect(page1.nextCursor).toBeDefined();

    const page2 = await serverWithStore
      .handleRequest(
        req(
          `/api/v1/tasks/${T}/event-history?includeDescendants=true&limit=2&since=${encodeURIComponent(
            page1.nextCursor as string,
          )}`,
        ),
      )
      .then((r) => r.json() as Promise<{ events: Array<{ id: string }>; nextCursor?: string }>);
    expect(page2.events.length).toBe(2);

    const page3 = await serverWithStore
      .handleRequest(
        req(
          `/api/v1/tasks/${T}/event-history?includeDescendants=true&limit=2&since=${encodeURIComponent(
            page2.nextCursor as string,
          )}`,
        ),
      )
      .then((r) => r.json() as Promise<{ events: Array<{ id: string }>; nextCursor?: string }>);
    expect(page3.events.length).toBe(1);

    // No overlaps — every id should appear exactly once across pages.
    const seen = new Set<string>();
    for (const e of [...page1.events, ...page2.events, ...page3.events]) {
      expect(seen.has(e.id)).toBe(false);
      seen.add(e.id);
    }
    expect(seen.size).toBe(5);
  });

  test('cross-session protection — descendant events in a sibling session are filtered out', async () => {
    const T = 'tree-Xs';
    // Parent in sess-Xs; child in sess-OTHER (artificial — defense-in-
    // depth check that the session guard kicks in).
    taskEventStore.append({
      taskId: T,
      sessionId: 'sess-Xs',
      eventType: 'workflow:delegate_dispatched',
      payload: { taskId: T, subTaskId: 'tree-Xs-c1', agentId: 'r', stepId: 's1' },
      ts: 1,
    });
    taskEventStore.append({
      taskId: 'tree-Xs-c1',
      sessionId: 'sess-OTHER',
      eventType: 'agent:tool_executed',
      payload: { taskId: 'tree-Xs-c1', toolName: 'Read' },
      ts: 2,
    });

    const res = await serverWithStore.handleRequest(
      req(`/api/v1/tasks/${T}/event-history?includeDescendants=true`),
    );
    const body = (await res.json()) as {
      taskIds: string[];
      events: Array<{ taskId: string; eventType: string }>;
    };
    // Tree resolver still discovers c1 (via the dispatched payload) so it
    // appears in `taskIds`, but the session-guard SQL clause keeps c1's
    // cross-session row out of `events`.
    expect(body.taskIds).toContain('tree-Xs-c1');
    const childToolEvent = body.events.find(
      (e) => e.taskId === 'tree-Xs-c1' && e.eventType === 'agent:tool_executed',
    );
    expect(childToolEvent).toBeUndefined();
  });

  test('truncation — discovery stops at TREE_TASKID_CAP and reports `truncated: true`', async () => {
    const T = 'tree-Tr';
    // Create TREE_TASKID_CAP + 6 children → resolver should stop early.
    for (let i = 0; i < TREE_TASKID_CAP + 6; i++) {
      taskEventStore.append({
        taskId: T,
        sessionId: 'sess-Tr',
        eventType: 'workflow:delegate_dispatched',
        payload: { taskId: T, subTaskId: `tree-Tr-c${i}`, agentId: 'r', stepId: `s${i}` },
        ts: i + 1,
      });
    }

    const res = await serverWithStore.handleRequest(
      req(`/api/v1/tasks/${T}/event-history?includeDescendants=true`),
    );
    const body = (await res.json()) as { taskIds: string[]; truncated: boolean };
    expect(body.taskIds.length).toBe(TREE_TASKID_CAP);
    expect(body.truncated).toBe(true);
  });

  test('returns 404 in both modes when no taskEventStore is wired', async () => {
    const def = await serverWithoutStore.handleRequest(req(`/api/v1/tasks/anything/event-history`));
    expect(def.status).toBe(404);
    const desc = await serverWithoutStore.handleRequest(
      req(`/api/v1/tasks/anything/event-history?includeDescendants=true`),
    );
    expect(desc.status).toBe(404);
  });

  test('multi-agent realistic scenario — parent + child tool + child stream + terminal', async () => {
    // Pinned contract for the historical Process Replay surface. Two
    // delegates (researcher / author) run under the parent, each emits
    // its own `agent:tool_*` and `llm:stream_delta` rows under its own
    // taskId, and the parent emits `workflow:delegate_completed` (with
    // outputPreview) plus `task:complete` at the end. The descendants
    // endpoint must return every row with correct row-level taskId
    // attribution and (ts, id) ordering. The cross-session guard remains
    // in force.
    const T = 'multi-A';
    const SESSION = 'sess-multi-A';
    const C1 = 'multi-A-delegate-step1_researcher';
    const C2 = 'multi-A-delegate-step2_author';

    // Parent kickoff
    taskEventStore.append({
      taskId: T,
      sessionId: SESSION,
      eventType: 'task:start',
      payload: { input: { id: T, sessionId: SESSION, goal: 'compare strategies' } },
      ts: 100,
    });
    taskEventStore.append({
      taskId: T,
      sessionId: SESSION,
      eventType: 'workflow:subtasks_planned',
      payload: {
        taskId: T,
        groupMode: 'competition',
        subtasks: [
          { subtaskId: 'st-r', stepId: 'step1_researcher', fallbackLabel: 'Agent 1', agentName: 'researcher' },
          { subtaskId: 'st-a', stepId: 'step2_author', fallbackLabel: 'Agent 2', agentName: 'author' },
        ],
      },
      ts: 110,
    });

    // Parent dispatches researcher (child C1)
    taskEventStore.append({
      taskId: T,
      sessionId: SESSION,
      eventType: 'workflow:delegate_dispatched',
      payload: { taskId: T, stepId: 'step1_researcher', subTaskId: C1, agentId: 'researcher' },
      ts: 200,
    });
    // Researcher emits its own tool + stream rows under its own taskId
    taskEventStore.append({
      taskId: C1,
      sessionId: SESSION,
      eventType: 'agent:tool_started',
      payload: { taskId: C1, turnId: 'turn-r-1', toolCallId: 'tc-r-1', toolName: 'Read' },
      ts: 220,
    });
    taskEventStore.append({
      taskId: C1,
      sessionId: SESSION,
      eventType: 'agent:tool_executed',
      payload: { taskId: C1, turnId: 'turn-r-1', toolCallId: 'tc-r-1', toolName: 'Read', durationMs: 12, isError: false },
      ts: 230,
    });
    taskEventStore.append({
      taskId: C1,
      sessionId: SESSION,
      eventType: 'llm:stream_delta',
      payload: { taskId: C1, turnId: 'turn-r-1', kind: 'content', text: 'researcher answer body…' },
      ts: 240,
    });
    taskEventStore.append({
      taskId: T,
      sessionId: SESSION,
      eventType: 'workflow:delegate_completed',
      payload: {
        taskId: T,
        stepId: 'step1_researcher',
        subTaskId: C1,
        agentId: 'researcher',
        status: 'completed',
        outputPreview: 'researcher answer body…',
      },
      ts: 250,
    });

    // Parent dispatches author (child C2)
    taskEventStore.append({
      taskId: T,
      sessionId: SESSION,
      eventType: 'workflow:delegate_dispatched',
      payload: { taskId: T, stepId: 'step2_author', subTaskId: C2, agentId: 'author' },
      ts: 300,
    });
    taskEventStore.append({
      taskId: C2,
      sessionId: SESSION,
      eventType: 'agent:tool_started',
      payload: { taskId: C2, turnId: 'turn-a-1', toolCallId: 'tc-a-1', toolName: 'Grep' },
      ts: 320,
    });
    taskEventStore.append({
      taskId: C2,
      sessionId: SESSION,
      eventType: 'llm:stream_delta',
      payload: { taskId: C2, turnId: 'turn-a-1', kind: 'content', text: 'author narrative…' },
      ts: 340,
    });
    taskEventStore.append({
      taskId: T,
      sessionId: SESSION,
      eventType: 'workflow:delegate_completed',
      payload: {
        taskId: T,
        stepId: 'step2_author',
        subTaskId: C2,
        agentId: 'author',
        status: 'completed',
        outputPreview: 'author narrative…',
      },
      ts: 360,
    });

    // Terminal — note no top-level `taskId`; row.task_id derived from
    // payload.result.id. The replay path must still attribute correctly.
    taskEventStore.append({
      taskId: T,
      sessionId: SESSION,
      eventType: 'task:complete',
      payload: { result: { id: T, status: 'partial', content: 'comparison synthesis' } },
      ts: 400,
    });

    const res = await serverWithStore.handleRequest(
      req(`/api/v1/tasks/${T}/event-history?includeDescendants=true`),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      taskId: string;
      rootTaskId: string;
      taskIds: string[];
      events: Array<{ id: string; taskId: string; eventType: string; ts: number; payload: Record<string, unknown> }>;
      truncated: boolean;
    };

    expect(body.taskId).toBe(T);
    expect(body.rootTaskId).toBe(T);
    expect(body.truncated).toBe(false);
    expect(body.taskIds.sort()).toEqual([T, C1, C2].sort());

    // Row-level taskId is correct on every persisted row.
    const byType = (eventType: string, taskId: string) =>
      body.events.find((e) => e.eventType === eventType && e.taskId === taskId);
    expect(byType('agent:tool_started', C1)).toBeDefined();
    expect(byType('agent:tool_executed', C1)).toBeDefined();
    expect(byType('llm:stream_delta', C1)).toBeDefined();
    expect(byType('agent:tool_started', C2)).toBeDefined();
    expect(byType('llm:stream_delta', C2)).toBeDefined();
    expect(byType('workflow:delegate_completed', T)).toBeDefined();
    expect(byType('task:complete', T)).toBeDefined();

    // Order is parent dispatch → child child tool → child stream → parent
    // completed → next child… → parent terminal. Pure (ts, id) order.
    const tsOf = (eventType: string, taskId: string) => byType(eventType, taskId)?.ts ?? Infinity;
    expect(tsOf('workflow:delegate_dispatched', T)).toBeLessThan(tsOf('agent:tool_executed', C1));
    expect(tsOf('agent:tool_executed', C1)).toBeLessThan(tsOf('llm:stream_delta', C1));
    expect(tsOf('llm:stream_delta', C1)).toBeLessThan(tsOf('workflow:delegate_completed', T));
    expect(tsOf('llm:stream_delta', C2)).toBeLessThan(tsOf('task:complete', T));

    // Defense-in-depth: a row written into a sibling session must NOT
    // surface under T's descendants result. Append after the main scenario
    // so the `taskIds` discovery still finds C1/C2 via parent's
    // `delegate_dispatched`, but the cross-session row is filtered at
    // query time.
    const C_LEAK = 'multi-A-delegate-step3_leak';
    taskEventStore.append({
      taskId: T,
      sessionId: SESSION,
      eventType: 'workflow:delegate_dispatched',
      payload: { taskId: T, stepId: 'step3_leak', subTaskId: C_LEAK, agentId: 'mentor' },
      ts: 500,
    });
    taskEventStore.append({
      taskId: C_LEAK,
      sessionId: 'sess-OTHER',
      eventType: 'agent:tool_executed',
      payload: { taskId: C_LEAK, toolName: 'Read', durationMs: 1, isError: false },
      ts: 510,
    });

    const res2 = await serverWithStore.handleRequest(
      req(`/api/v1/tasks/${T}/event-history?includeDescendants=true&limit=5000`),
    );
    const body2 = (await res2.json()) as {
      taskIds: string[];
      events: Array<{ taskId: string; eventType: string }>;
    };
    expect(body2.taskIds).toContain(C_LEAK); // discovered via parent dispatch
    const leakedToolEvent = body2.events.find(
      (e) => e.taskId === C_LEAK && e.eventType === 'agent:tool_executed',
    );
    expect(leakedToolEvent).toBeUndefined(); // session guard suppressed it
  });
});
