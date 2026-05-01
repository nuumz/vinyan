/**
 * `/api/v1/scheduler/jobs` operations console contract.
 *
 * The scheduler runtime (`gateway_schedules` table + `ScheduleRunner`)
 * already exists; this surface adds CRUD + lifecycle events + recursion
 * guard. Tests verify:
 *   - create from raw cron expression
 *   - create from natural-language phrase via `parseCron`
 *   - list / get round-trip projection
 *   - pause clears nextFireAt and emits scheduler:job_paused
 *   - resume recomputes nextFireAt and emits scheduler:job_resumed
 *   - patch goal/cron/timezone emits scheduler:job_updated with the
 *     mutated field set
 *   - run-now starts a task and emits scheduler:job_started/completed
 *   - delete removes the row and emits scheduler:job_deleted
 *   - profile isolation — a job created in profile A is invisible to
 *     a request scoped to profile B
 *   - recursion guard — a request carrying X-Vinyan-Origin: gateway-cron
 *     is rejected with 423 and emits scheduler:recursion_blocked
 *   - invalid cron string returns 400, not crashes the server
 */
import { Database } from 'bun:sqlite';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { VinyanAPIServer } from '../../src/api/server.ts';
import { SessionManager } from '../../src/api/session-manager.ts';
import { createBus, type VinyanBus } from '../../src/core/bus.ts';
import { GatewayScheduleStore } from '../../src/db/gateway-schedule-store.ts';
import { ALL_MIGRATIONS, MigrationRunner } from '../../src/db/migrations/index.ts';
import { SessionStore } from '../../src/db/session-store.ts';
import type { TaskInput, TaskResult } from '../../src/orchestrator/types.ts';

const TEST_DIR = join(tmpdir(), `vinyan-scheduler-api-test-${Date.now()}`);
const TOKEN_PATH = join(TEST_DIR, 'api-token');
const TEST_TOKEN = `test-token-${'a'.repeat(52)}`;

let server: VinyanAPIServer;
let db: Database;
let bus: VinyanBus;
let sessionStore: SessionStore;
let sessionManager: SessionManager;
let scheduleStore: GatewayScheduleStore;

function authedReq(
  path: string,
  opts: { method?: string; body?: string; headers?: Record<string, string> } = {},
): Request {
  return new Request(`http://localhost${path}`, {
    method: opts.method ?? 'GET',
    headers: {
      Authorization: `Bearer ${TEST_TOKEN}`,
      'Content-Type': 'application/json',
      ...(opts.headers ?? {}),
    },
    body: opts.body,
  });
}

function mockExecuteTask(input: TaskInput): Promise<TaskResult> {
  return Promise.resolve({
    id: input.id,
    status: 'completed',
    mutations: [],
    trace: {
      id: `trace-${input.id}`,
      taskId: input.id,
      timestamp: Date.now(),
      routingLevel: 1,
      approach: 'mock-cron',
      modelUsed: 'mock/test',
      tokensConsumed: 50,
      durationMs: 25,
      outcome: 'success',
      oracleVerdicts: {},
      affectedFiles: [],
    },
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
  scheduleStore = new GatewayScheduleStore(db);

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
      gatewayScheduleStore: scheduleStore,
      defaultProfile: 'default',
    },
  );
});

afterAll(() => {
  db.close();
});

describe('POST /api/v1/scheduler/jobs (create)', () => {
  test('creates a job from a raw cron expression', async () => {
    const events: Array<{ name: string; payload: unknown }> = [];
    const off = bus.on('scheduler:job_created', (payload) =>
      events.push({ name: 'scheduler:job_created', payload }),
    );
    const res = await server.handleRequest(
      authedReq('/api/v1/scheduler/jobs', {
        method: 'POST',
        body: JSON.stringify({
          cron: '0 9 * * 1-5',
          timezone: 'UTC',
          goal: 'weekday morning summary',
        }),
      }),
    );
    off();
    expect(res.status).toBe(201);
    const body = (await res.json()) as { job: { id: string; cron: string; status: string; nextFireAt: number | null } };
    expect(body.job.cron).toBe('0 9 * * 1-5');
    expect(body.job.status).toBe('active');
    expect(typeof body.job.nextFireAt).toBe('number');
    expect(events.length).toBe(1);
  });

  test('creates a job from a natural-language phrase', async () => {
    const res = await server.handleRequest(
      authedReq('/api/v1/scheduler/jobs', {
        method: 'POST',
        body: JSON.stringify({
          nl: 'every weekday at 9am',
          goal: 'NL morning summary',
        }),
      }),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { job: { cron: string; nlOriginal: string } };
    expect(body.job.cron).toBe('0 9 * * 1-5');
    expect(body.job.nlOriginal).toBe('every weekday at 9am');
  });

  test('rejects invalid cron with 400 instead of crashing', async () => {
    const res = await server.handleRequest(
      authedReq('/api/v1/scheduler/jobs', {
        method: 'POST',
        body: JSON.stringify({ cron: 'not a cron', goal: 'broken' }),
      }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error.toLowerCase()).toContain('cron');
  });

  test('rejects empty goal', async () => {
    const res = await server.handleRequest(
      authedReq('/api/v1/scheduler/jobs', {
        method: 'POST',
        body: JSON.stringify({ cron: '0 9 * * 1-5', goal: '   ' }),
      }),
    );
    expect(res.status).toBe(400);
  });

  test('rejects request when neither cron nor nl provided', async () => {
    const res = await server.handleRequest(
      authedReq('/api/v1/scheduler/jobs', {
        method: 'POST',
        body: JSON.stringify({ goal: 'no schedule' }),
      }),
    );
    expect(res.status).toBe(400);
  });
});

describe('GET /api/v1/scheduler/jobs (list)', () => {
  test('returns jobs for the requesting profile only by default', async () => {
    // Create one in profile-a, one in profile-b directly via the store
    // so we don't depend on profile-aware POST routing in this test.
    const baseTuple = {
      createdAt: Date.now(),
      createdByHermesUserId: null,
      origin: { platform: 'cli' as const, chatId: null },
      cron: '0 9 * * *',
      timezone: 'UTC',
      goal: 'g',
      constraints: {},
      confidenceAtCreation: 1,
      evidenceHash: '',
      status: 'active' as const,
      failureStreak: 0,
      nextFireAt: Date.now() + 60_000,
      runHistory: [],
    };
    scheduleStore.save({ id: 'scoped-a', profile: 'profile-a', nlOriginal: 'a', ...baseTuple });
    scheduleStore.save({ id: 'scoped-b', profile: 'profile-b', nlOriginal: 'b', ...baseTuple });

    const res = await server.handleRequest(
      authedReq('/api/v1/scheduler/jobs', {
        headers: { 'X-Vinyan-Profile': 'profile-a' },
      }),
    );
    const body = (await res.json()) as { jobs: Array<{ id: string; profile: string }> };
    expect(body.jobs.some((j) => j.id === 'scoped-a')).toBe(true);
    expect(body.jobs.every((j) => j.profile === 'profile-a')).toBe(true);
  });

  test('honours ?profile=* admin override', async () => {
    const res = await server.handleRequest(authedReq('/api/v1/scheduler/jobs?profile=*'));
    const body = (await res.json()) as { jobs: unknown[]; profile: string };
    expect(body.profile).toBe('*');
    expect(body.jobs.length).toBeGreaterThanOrEqual(2);
  });
});

describe('lifecycle: pause / resume / patch / delete', () => {
  test('pause emits event and clears nextFireAt', async () => {
    const create = await server.handleRequest(
      authedReq('/api/v1/scheduler/jobs', {
        method: 'POST',
        body: JSON.stringify({ cron: '0 9 * * *', goal: 'pause-target' }),
      }),
    );
    const job = (await create.json()) as { job: { id: string; nextFireAt: number | null } };
    expect(job.job.nextFireAt).not.toBeNull();

    const events: unknown[] = [];
    const off = bus.on('scheduler:job_paused', (p) => events.push(p));
    const pause = await server.handleRequest(
      authedReq(`/api/v1/scheduler/jobs/${job.job.id}/pause`, { method: 'POST' }),
    );
    off();
    expect(pause.status).toBe(200);
    const after = (await pause.json()) as { job: { status: string; nextFireAt: number | null } };
    expect(after.job.status).toBe('paused');
    expect(after.job.nextFireAt).toBeNull();
    expect(events.length).toBe(1);
  });

  test('resume recomputes nextFireAt and emits event', async () => {
    const create = await server.handleRequest(
      authedReq('/api/v1/scheduler/jobs', {
        method: 'POST',
        body: JSON.stringify({ cron: '0 9 * * *', goal: 'resume-target' }),
      }),
    );
    const job = (await create.json()) as { job: { id: string } };
    await server.handleRequest(
      authedReq(`/api/v1/scheduler/jobs/${job.job.id}/pause`, { method: 'POST' }),
    );

    const events: unknown[] = [];
    const off = bus.on('scheduler:job_resumed', (p) => events.push(p));
    const resume = await server.handleRequest(
      authedReq(`/api/v1/scheduler/jobs/${job.job.id}/resume`, { method: 'POST' }),
    );
    off();
    expect(resume.status).toBe(200);
    const after = (await resume.json()) as { job: { status: string; nextFireAt: number | null } };
    expect(after.job.status).toBe('active');
    expect(typeof after.job.nextFireAt).toBe('number');
    expect(events.length).toBe(1);
  });

  test('PATCH updates fields and emits event with mutated keys', async () => {
    const create = await server.handleRequest(
      authedReq('/api/v1/scheduler/jobs', {
        method: 'POST',
        body: JSON.stringify({ cron: '0 9 * * *', goal: 'patch-target' }),
      }),
    );
    const job = (await create.json()) as { job: { id: string } };

    const events: Array<{ fields: ReadonlyArray<string> }> = [];
    const off = bus.on('scheduler:job_updated', (p) => events.push(p));
    const patch = await server.handleRequest(
      authedReq(`/api/v1/scheduler/jobs/${job.job.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ goal: 'patched goal', cron: '30 9 * * *' }),
      }),
    );
    off();
    expect(patch.status).toBe(200);
    const after = (await patch.json()) as { job: { goal: string; cron: string } };
    expect(after.job.goal).toBe('patched goal');
    expect(after.job.cron).toBe('30 9 * * *');
    expect([...(events[0]?.fields ?? [])].sort()).toEqual(['cron', 'goal']);
  });

  test('DELETE removes row and emits event', async () => {
    const create = await server.handleRequest(
      authedReq('/api/v1/scheduler/jobs', {
        method: 'POST',
        body: JSON.stringify({ cron: '0 9 * * *', goal: 'delete-target' }),
      }),
    );
    const job = (await create.json()) as { job: { id: string } };

    const events: unknown[] = [];
    const off = bus.on('scheduler:job_deleted', (p) => events.push(p));
    const del = await server.handleRequest(
      authedReq(`/api/v1/scheduler/jobs/${job.job.id}`, { method: 'DELETE' }),
    );
    off();
    expect(del.status).toBe(200);
    const after = (await del.json()) as { deleted: boolean };
    expect(after.deleted).toBe(true);

    // Subsequent GET returns 404.
    const fetch404 = await server.handleRequest(authedReq(`/api/v1/scheduler/jobs/${job.job.id}`));
    expect(fetch404.status).toBe(404);
    expect(events.length).toBe(1);
  });
});

describe('run-now (POST /:id/run)', () => {
  test('starts a task and emits started + due events', async () => {
    const create = await server.handleRequest(
      authedReq('/api/v1/scheduler/jobs', {
        method: 'POST',
        body: JSON.stringify({ cron: '0 9 * * *', goal: 'run-now-target' }),
      }),
    );
    const job = (await create.json()) as { job: { id: string } };

    const dueEvents: unknown[] = [];
    const startedEvents: Array<{ taskId: string }> = [];
    const completedEvents: Array<{ outcome: string }> = [];
    const offDue = bus.on('scheduler:job_due', (p) => dueEvents.push(p));
    const offStarted = bus.on('scheduler:job_started', (p) =>
      startedEvents.push(p as { taskId: string }),
    );
    const offCompleted = bus.on('scheduler:job_completed', (p) =>
      completedEvents.push(p as { outcome: string }),
    );

    const run = await server.handleRequest(
      authedReq(`/api/v1/scheduler/jobs/${job.job.id}/run`, { method: 'POST' }),
    );
    expect(run.status).toBe(202);
    const body = (await run.json()) as { taskId: string; status: string };
    expect(body.status).toBe('started');
    expect(typeof body.taskId).toBe('string');
    // Allow the async chain to resolve.
    await new Promise((r) => setTimeout(r, 25));
    offDue();
    offStarted();
    offCompleted();
    expect(dueEvents.length).toBe(1);
    expect(startedEvents[0]?.taskId).toBe(body.taskId);
    expect(completedEvents[0]?.outcome).toBe('completed');
  });
});

describe('recursion guard', () => {
  test('rejects scheduler-mutation when X-Vinyan-Origin is gateway-cron', async () => {
    const events: Array<{ blockedPath: string }> = [];
    const off = bus.on('scheduler:recursion_blocked', (p) =>
      events.push(p as { blockedPath: string }),
    );
    const res = await server.handleRequest(
      authedReq('/api/v1/scheduler/jobs', {
        method: 'POST',
        body: JSON.stringify({ cron: '0 9 * * *', goal: 'recursion-attempt' }),
        headers: { 'X-Vinyan-Origin': 'gateway-cron' },
      }),
    );
    off();
    expect(res.status).toBe(423);
    const body = (await res.json()) as { error: string; code: string };
    expect(body.code).toBe('recursion-blocked');
    expect(events.length).toBe(1);
    expect(events[0]?.blockedPath).toBe('/api/v1/scheduler/jobs');
  });

  test('rejects recursive patch by body-origin signal', async () => {
    const create = await server.handleRequest(
      authedReq('/api/v1/scheduler/jobs', {
        method: 'POST',
        body: JSON.stringify({ cron: '0 9 * * *', goal: 'recursion-patch-target' }),
      }),
    );
    const job = (await create.json()) as { job: { id: string } };

    const res = await server.handleRequest(
      authedReq(`/api/v1/scheduler/jobs/${job.job.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ goal: 'mutated', originSource: 'gateway-cron' }),
      }),
    );
    expect(res.status).toBe(423);
  });
});

describe('503 when scheduler not configured', () => {
  test('list / create return 503 when gatewayScheduleStore is omitted', async () => {
    const stub = new VinyanAPIServer(
      {
        port: 0,
        bind: '127.0.0.1',
        tokenPath: TOKEN_PATH,
        authRequired: true,
        rateLimitEnabled: false,
      },
      {
        bus: createBus(),
        executeTask: mockExecuteTask,
        sessionManager,
      },
    );
    const list = await stub.handleRequest(authedReq('/api/v1/scheduler/jobs'));
    expect(list.status).toBe(503);
    const create = await stub.handleRequest(
      authedReq('/api/v1/scheduler/jobs', {
        method: 'POST',
        body: JSON.stringify({ cron: '0 9 * * *', goal: 'no-store' }),
      }),
    );
    expect(create.status).toBe(503);
  });
});
