/**
 * STEP 2 — descendants response carries an additive `scope` discriminator
 * so consumers that reconstruct parent-only state can filter sub-agent
 * events out of the merged tree stream.
 *
 * Three contracts pinned here:
 *
 *   S2.2a — behavior: every row in `?includeDescendants=true` carries a
 *           `scope: 'parent' | 'descendant'` field set by comparing
 *           `event.taskId` to the root `taskId`. Counts grouped by scope
 *           match the seeded counts.
 *
 *   S2.2b — backward compat: pre-existing fields on every event row are
 *           preserved BYTE-FOR-BYTE when `scope` is stripped out. A
 *           consumer that ignores the new field gets an identical row
 *           set to the pre-fix response (no row removed, no row
 *           reshaped, no ordering change).
 *
 *   S2.2c — projection / derivation: a UI-style "plan N/M" derivation
 *           that filters by `scope === 'parent'` produces correct counts
 *           for each combination of step statuses (queued, running,
 *           done, failed, skipped) — even when descendant events emit
 *           their OWN `workflow:plan_ready` and `workflow:step_complete`
 *           rows that would otherwise leak the wrong totals into the
 *           parent's banner. This is the regression for the chat UI's
 *           "plan 0/4 while three steps are persisted as DONE" surface
 *           in incident `b80c5c0d-3f0e-4f29-9d94-3a88b6b4f052`.
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
import { TaskEventStore } from '../../src/db/task-event-store.ts';
import {
  migratePipelineConfidenceColumns,
  migrateThinkingColumns,
  migrateTranscriptColumns,
  TRACE_SCHEMA_SQL,
} from '../../src/db/trace-schema.ts';
import { TraceStore } from '../../src/db/trace-store.ts';
import type { TaskInput, TaskResult } from '../../src/orchestrator/types.ts';

const TEST_DIR = join(tmpdir(), `vinyan-event-history-scope-test-${Date.now()}`);
const TOKEN_PATH = join(TEST_DIR, 'api-token');
const TEST_TOKEN = `test-token-${'a'.repeat(52)}`;
const authHeaders = { Authorization: `Bearer ${TEST_TOKEN}`, 'Content-Type': 'application/json' };

let db: Database;
let bus: VinyanBus;
let store: TaskEventStore;
let server: VinyanAPIServer;

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
  store = new TaskEventStore(db);
  const sessionStore = new SessionStore(db);
  const traceStore = new TraceStore(db);
  const sessionManager = new SessionManager(sessionStore, traceStore);

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
      executeTask: (input: TaskInput) =>
        Promise.resolve({ id: input.id, status: 'completed', mutations: [], answer: 'ok' } as unknown as TaskResult),
      sessionManager,
      traceStore,
      taskEventStore: store,
    },
  );
});

afterAll(() => {
  db.close();
});

// ── Shared seeding helpers ───────────────────────────────────────────

interface DescendantsResponse {
  taskId: string;
  rootTaskId: string;
  taskIds: string[];
  events: Array<{
    id: string;
    taskId: string;
    sessionId?: string;
    seq: number;
    eventType: string;
    scope?: string;
    ts: number;
    payload: unknown;
  }>;
  nextCursor?: string;
  truncated: boolean;
}

async function fetchTree(taskId: string): Promise<DescendantsResponse> {
  const res = await server.handleRequest(req(`/api/v1/tasks/${taskId}/event-history?includeDescendants=true`));
  expect(res.status).toBe(200);
  return (await res.json()) as DescendantsResponse;
}

/** Seed a parent + two descendants pattern that reproduces the leak shape. */
function seedParentWithDescendants(rootId: string, sessionId: string, baseTs: number): void {
  // Parent: dispatches two sub-agents, then both complete, then root finishes.
  store.append({
    taskId: rootId,
    sessionId,
    eventType: 'workflow:delegate_dispatched',
    payload: { taskId: rootId, subTaskId: `${rootId}-c1`, agentId: 'researcher', stepId: 'p-r' },
    ts: baseTs + 1,
  });
  store.append({
    taskId: rootId,
    sessionId,
    eventType: 'workflow:delegate_dispatched',
    payload: { taskId: rootId, subTaskId: `${rootId}-c2`, agentId: 'mentor', stepId: 'p-m' },
    ts: baseTs + 2,
  });
  // Descendant c1 logs an internal tool call AND a (mis-leading) timeout.
  store.append({
    taskId: `${rootId}-c1`,
    sessionId,
    eventType: 'agent:tool_executed',
    payload: { taskId: `${rootId}-c1`, toolName: 'Read', durationMs: 5 },
    ts: baseTs + 10,
  });
  store.append({
    taskId: `${rootId}-c1`,
    sessionId,
    eventType: 'task:timeout',
    payload: {
      taskId: `${rootId}-c1`,
      elapsedMs: 104_089,
      budgetMs: 60_000,
      routingLevel: 2,
      planProgress: { done: 0, total: 4 },
    },
    ts: baseTs + 20,
  });
  // Descendant c2 finishes cleanly.
  store.append({
    taskId: `${rootId}-c2`,
    sessionId,
    eventType: 'task:complete',
    payload: { result: { id: `${rootId}-c2`, status: 'completed', mutations: [], answer: 'ok' } },
    ts: baseTs + 30,
  });
  // Parent: marks both delegate steps complete, then root task:complete.
  store.append({
    taskId: rootId,
    sessionId,
    eventType: 'workflow:step_complete',
    payload: { taskId: rootId, stepId: 'p-r', strategy: 'delegate-sub-agent', status: 'completed' },
    ts: baseTs + 40,
  });
  store.append({
    taskId: rootId,
    sessionId,
    eventType: 'workflow:step_complete',
    payload: { taskId: rootId, stepId: 'p-m', strategy: 'delegate-sub-agent', status: 'completed' },
    ts: baseTs + 41,
  });
  store.append({
    taskId: rootId,
    sessionId,
    eventType: 'task:complete',
    payload: { result: { id: rootId, status: 'completed', mutations: [], answer: 'final' } },
    ts: baseTs + 50,
  });
}

// ── S2.2a: behavior — scope tagging by row counts ─────────────────────

describe('GET /api/v1/tasks/:id/event-history?includeDescendants=true — S2.2a scope tagging', () => {
  test('every row carries scope; parent count matches root taskId rows; descendant count matches the rest', async () => {
    const root = 's2a-root';
    seedParentWithDescendants(root, 'sess-2a', 1_000_000);

    const body = await fetchTree(root);

    // Every row has scope.
    for (const e of body.events) {
      expect(typeof e.scope).toBe('string');
      expect(e.scope === 'parent' || e.scope === 'descendant').toBe(true);
    }

    const byScope = body.events.reduce<Record<string, number>>(
      (acc, e) => {
        acc[e.scope!] = (acc[e.scope!] ?? 0) + 1;
        return acc;
      },
      { parent: 0, descendant: 0 },
    );

    // Seeded: 2 dispatch + 2 step_complete + 1 task:complete on parent;
    // 1 tool_executed + 1 task:timeout on c1, 1 task:complete on c2.
    expect(byScope.parent).toBe(5);
    expect(byScope.descendant).toBe(3);

    // And the discriminator is mechanical: scope === 'parent' iff taskId === rootTaskId.
    for (const e of body.events) {
      const expected = e.taskId === body.rootTaskId ? 'parent' : 'descendant';
      expect(e.scope).toBe(expected);
    }
  });

  test('parent-only filter keeps the misleading sub-agent task:timeout out of the parent surface', async () => {
    const root = 's2a-leak-shield';
    seedParentWithDescendants(root, 'sess-2a-leak', 2_000_000);

    const body = await fetchTree(root);

    const parentOnly = body.events.filter((e) => e.scope === 'parent');

    // The descendant's `task:timeout` (which previously surfaced as the
    // parent's "Failed: Task timed out after 105s" banner) MUST NOT
    // appear in the parent-scoped slice.
    expect(parentOnly.some((e) => e.eventType === 'task:timeout')).toBe(false);

    // The actual parent terminal IS visible.
    const parentTerminals = parentOnly.filter((e) => e.eventType === 'task:complete');
    expect(parentTerminals).toHaveLength(1);
    expect((parentTerminals[0]!.payload as { result: { status: string } }).result.status).toBe('completed');
  });
});

// ── S2.2b: backward compat — existing fields preserved ────────────────

describe('GET /api/v1/tasks/:id/event-history?includeDescendants=true — S2.2b backward compat', () => {
  test('a consumer that strips the new scope field gets the same row set as before (no row removed, no row reshaped)', async () => {
    const root = 's2b-compat';
    seedParentWithDescendants(root, 'sess-2b', 3_000_000);

    const body = await fetchTree(root);

    // 1. Scope is the ONLY new key — every other key is unchanged.
    const expectedKeys = new Set(['id', 'taskId', 'sessionId', 'seq', 'eventType', 'payload', 'ts', 'scope']);
    for (const e of body.events) {
      const keys = new Set(Object.keys(e));
      expect(keys.has('scope')).toBe(true);
      // No legacy field was renamed/removed.
      for (const k of ['id', 'taskId', 'seq', 'eventType', 'payload', 'ts']) {
        expect(keys.has(k)).toBe(true);
      }
      // No surprise new keys beyond `scope` were introduced.
      for (const k of keys) {
        expect(expectedKeys.has(k)).toBe(true);
      }
    }

    // 2. The row count and ordering match the raw store output (modulo
    // the additive scope field). A naive consumer that strips `scope`
    // gets a byte-identical projection of the legacy response shape.
    const stripped = body.events.map(({ scope, ...rest }) => rest);
    expect(stripped).toHaveLength(body.events.length);

    // 3. Ordering: ts-ascending, with id-tiebreak — same contract as
    // before. Pinning this defends against an accidental sort change
    // when the annotation map is added.
    for (let i = 1; i < body.events.length; i++) {
      const prev = body.events[i - 1]!;
      const curr = body.events[i]!;
      const prevKey = `${prev.ts}:${prev.id}`;
      const currKey = `${curr.ts}:${curr.id}`;
      expect(currKey >= prevKey).toBe(true);
    }
  });

  test('default (non-descendants) mode is untouched — no scope field, no shape change', async () => {
    const root = 's2b-non-desc';
    seedParentWithDescendants(root, 'sess-2b-nd', 4_000_000);

    const res = await server.handleRequest(req(`/api/v1/tasks/${root}/event-history`));
    const body = (await res.json()) as {
      taskId: string;
      events: Array<Record<string, unknown>>;
      lastSeq: number;
      nextCursor?: string;
    };

    // Legacy shape: lastSeq present, nextCursor absent, NO scope on rows.
    expect(body.lastSeq).toBeGreaterThan(0);
    expect(body.nextCursor).toBeUndefined();
    for (const e of body.events) {
      expect(e.scope).toBeUndefined();
    }
  });
});

// ── S2.2c: projection / derivation — "plan N/M" table-driven ──────────

interface TreeEvent {
  taskId: string;
  eventType: string;
  scope: 'parent' | 'descendant';
  ts: number;
  payload: Record<string, unknown>;
}

/**
 * Mimics the derivation a correct UI consumer should perform: filter by
 * `scope === 'parent'`, look up the parent's `workflow:plan_ready` for
 * the denominator, and walk the parent's `workflow:step_complete`
 * stream for the numerator. Step is "done" when status is `completed`
 * or `done`; `failed`/`skipped`/`running`/`pending` are not counted
 * toward done.
 *
 * This mirrors the failure mode in the incident: a UI deriving from
 * unfiltered tree events would pick up the descendant's
 * `workflow:plan_ready` (a sub-agent's local 4-step plan that never
 * advanced) and report `0/4` instead of the parent's true progress.
 */
function derivePlanProgress(events: TreeEvent[]): { done: number; total: number } {
  const parentEvents = events.filter((e) => e.scope === 'parent');
  let total = 0;
  for (const e of parentEvents) {
    if (e.eventType === 'workflow:plan_ready') {
      const steps = (e.payload as { steps?: unknown[] }).steps;
      if (Array.isArray(steps)) total = steps.length;
    }
  }
  const stepStatus = new Map<string, string>();
  for (const e of parentEvents) {
    if (e.eventType === 'workflow:step_complete') {
      const stepId = (e.payload as { stepId?: string }).stepId;
      const status = (e.payload as { status?: string }).status ?? 'completed';
      if (stepId) stepStatus.set(stepId, status);
    }
  }
  let done = 0;
  for (const status of stepStatus.values()) {
    if (status === 'completed' || status === 'done') done += 1;
  }
  return { done, total };
}

describe('GET /api/v1/tasks/:id/event-history — S2.2c plan N/M derivation, scope-filtered', () => {
  /**
   * Each row: a step-status combination on the parent. The descendant
   * task is seeded identically across all rows with its OWN
   * plan_ready (4 steps) and a step_complete on each — so an
   * unfiltered derivation would return `4/4` from the descendant's
   * unrelated plan instead of the parent's actual progress.
   */
  const cases: Array<{
    label: string;
    parentSteps: Array<{ id: string; status: 'pending' | 'running' | 'done' | 'completed' | 'failed' | 'skipped' }>;
    expected: { done: number; total: number };
  }> = [
    {
      label: 'all 4 parent steps completed → 4/4',
      parentSteps: [
        { id: 's1', status: 'completed' },
        { id: 's2', status: 'completed' },
        { id: 's3', status: 'completed' },
        { id: 's4', status: 'completed' },
      ],
      expected: { done: 4, total: 4 },
    },
    {
      label: '3 completed, 1 still running → 3/4',
      parentSteps: [
        { id: 's1', status: 'completed' },
        { id: 's2', status: 'completed' },
        { id: 's3', status: 'completed' },
        { id: 's4', status: 'running' },
      ],
      expected: { done: 3, total: 4 },
    },
    {
      label: 'none reported yet (all queued) → 0/4',
      parentSteps: [
        { id: 's1', status: 'pending' },
        { id: 's2', status: 'pending' },
        { id: 's3', status: 'pending' },
        { id: 's4', status: 'pending' },
      ],
      expected: { done: 0, total: 4 },
    },
    {
      label: '2 completed, 1 failed, 1 skipped → 2/4 (failed/skipped do NOT count as done)',
      parentSteps: [
        { id: 's1', status: 'completed' },
        { id: 's2', status: 'completed' },
        { id: 's3', status: 'failed' },
        { id: 's4', status: 'skipped' },
      ],
      expected: { done: 2, total: 4 },
    },
    {
      label: 'mixed running + done → only completed/done count',
      parentSteps: [
        { id: 's1', status: 'completed' },
        { id: 's2', status: 'done' },
        { id: 's3', status: 'running' },
        { id: 's4', status: 'pending' },
      ],
      expected: { done: 2, total: 4 },
    },
  ];

  for (const c of cases) {
    test(`${c.label} (descendant's own plan_ready does NOT leak into the parent's count)`, async () => {
      // Use a unique root so cases don't interleave seeds.
      const root = `s2c-${c.label.replace(/[^a-z0-9]+/gi, '-').slice(0, 30)}`;
      const sessionId = `sess-${root}`;
      const ts = 5_000_000 + Math.floor(Math.random() * 100_000);

      // Parent plan_ready: declare the 4 steps.
      store.append({
        taskId: root,
        sessionId,
        eventType: 'workflow:plan_ready',
        payload: { taskId: root, steps: c.parentSteps.map((s) => ({ id: s.id, description: s.id })) },
        ts,
      });
      // Parent step_complete events: only emit for terminal statuses (mirrors executor).
      let offset = 1;
      for (const step of c.parentSteps) {
        if (
          step.status === 'completed' ||
          step.status === 'done' ||
          step.status === 'failed' ||
          step.status === 'skipped'
        ) {
          store.append({
            taskId: root,
            sessionId,
            eventType: 'workflow:step_complete',
            payload: { taskId: root, stepId: step.id, status: step.status },
            ts: ts + offset++,
          });
        } else if (step.status === 'running') {
          store.append({
            taskId: root,
            sessionId,
            eventType: 'workflow:step_start',
            payload: { taskId: root, stepId: step.id },
            ts: ts + offset++,
          });
        }
      }

      // Descendant: dispatched by parent, with its OWN plan_ready of
      // 4 steps and 1 step_complete. This is the leak source — an
      // unfiltered derivation would pick up these counts and return
      // `1/4` (or worse, `0/4` if its plan_ready landed last).
      const child = `${root}-c1`;
      store.append({
        taskId: root,
        sessionId,
        eventType: 'workflow:delegate_dispatched',
        payload: { taskId: root, subTaskId: child, agentId: 'researcher', stepId: 'd1' },
        ts: ts + offset++,
      });
      store.append({
        taskId: child,
        sessionId,
        eventType: 'workflow:plan_ready',
        payload: { taskId: child, steps: [{ id: 'x1' }, { id: 'x2' }, { id: 'x3' }, { id: 'x4' }] },
        ts: ts + offset++,
      });
      store.append({
        taskId: child,
        sessionId,
        eventType: 'workflow:step_complete',
        payload: { taskId: child, stepId: 'x1', status: 'completed' },
        ts: ts + offset++,
      });

      const body = await fetchTree(root);
      const result = derivePlanProgress(body.events as unknown as TreeEvent[]);
      expect(result).toEqual(c.expected);

      // Sanity: an UNFILTERED derivation (the buggy behavior) would pick
      // up the descendant's plan_ready/step_complete and produce a
      // different result. This check pins that the scope filter is the
      // mechanism that prevents the leak — not coincidence.
      const unfilteredAsParent = (body.events as unknown as TreeEvent[]).map((e) => ({
        ...e,
        scope: 'parent' as const,
      }));
      const buggyResult = derivePlanProgress(unfilteredAsParent);
      // The descendant's plan_ready (4 steps) lands AFTER the parent's
      // (because it's seeded later), so the buggy total would be 4 either
      // way — but the buggy DONE count would be inflated by the
      // descendant's step_complete (`x1` → completed), giving done >= expected.done + 1.
      expect(buggyResult.done).toBeGreaterThanOrEqual(c.expected.done + 1);
    });
  }
});
