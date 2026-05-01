/**
 * GET /api/v1/tasks/:id/process-state — HTTP integration tests.
 *
 * Wires real durable stores into a VinyanAPIServer (no port binding) and
 * verifies the endpoint returns a TaskProcessProjection with the
 * authoritative state vinyan-ui will render.
 *
 * Also verifies the task list / detail handlers now report
 * `needsActionType: 'coding-cli-approval'` and a
 * `pendingGates.codingCliApproval: true` flag derived from the durable
 * `coding_cli_approvals` row — frontend no longer folds raw events.
 */
import { Database } from 'bun:sqlite';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { VinyanAPIServer } from '../../src/api/server.ts';
import { SessionManager } from '../../src/api/session-manager.ts';
import { createBus, type VinyanBus } from '../../src/core/bus.ts';
import { CodingCliStore } from '../../src/db/coding-cli-store.ts';
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
import type { TaskProcessProjection } from '../../src/api/projections/task-process-projection.ts';

const TEST_DIR = join(tmpdir(), `vinyan-process-state-${Date.now()}`);
const TOKEN_PATH = join(TEST_DIR, 'api-token');
const TEST_TOKEN = `test-token-${'a'.repeat(52)}`;
const headers = { Authorization: `Bearer ${TEST_TOKEN}`, 'Content-Type': 'application/json' };

let server: VinyanAPIServer;
let db: Database;
let bus: VinyanBus;
let sessionStore: SessionStore;
let taskEventStore: TaskEventStore;
let codingCliStore: CodingCliStore;

function get(path: string): Request {
  return new Request(`http://localhost${path}`, { method: 'GET', headers });
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
  sessionStore = new SessionStore(db);
  const traceStore = new TraceStore(db);
  taskEventStore = new TaskEventStore(db);
  codingCliStore = new CodingCliStore(db);

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
        Promise.resolve({
          id: input.id,
          status: 'completed',
          mutations: [],
          answer: 'ok',
        } as unknown as TaskResult),
      sessionManager,
      traceStore,
      taskEventStore,
      codingCliStore,
    },
  );
});

afterAll(() => {
  db.close();
});

function plantSessionTask(opts: {
  sessionId: string;
  taskId: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
  result?: TaskResult;
}) {
  // session_store is the durable sessions table. Use INSERT OR IGNORE so
  // multiple plants in the same session can coexist.
  db.run(
    `INSERT OR IGNORE INTO session_store (id, source, created_at, status, working_memory_json, compaction_json, updated_at)
     VALUES (?, 'test', ?, 'active', NULL, NULL, ?)`,
    [opts.sessionId, 1000, 1100],
  );
  db.run(
    `INSERT INTO session_tasks (session_id, task_id, task_input_json, status, result_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      opts.sessionId,
      opts.taskId,
      JSON.stringify({
        id: opts.taskId,
        goal: 'g',
        taskType: 'reasoning',
        budget: { maxTokens: 1000, maxDurationMs: 1000, maxRetries: 1 },
      }),
      opts.status,
      opts.result ? JSON.stringify(opts.result) : null,
      1000,
      1100,
    ],
  );
}

function appendEvent(taskId: string, eventType: string, payload: Record<string, unknown> = {}, ts = 1500): void {
  taskEventStore.append({ taskId, sessionId: 'sess-proc', eventType, payload, ts });
}

describe('GET /api/v1/tasks/:id/process-state', () => {
  test('returns 404 for an unknown task', async () => {
    const res = await server.handleRequest(get('/api/v1/tasks/task-ghost/process-state'));
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('not found');
  });

  test('returns a complete projection for a successfully terminated task', async () => {
    plantSessionTask({ sessionId: 'sess-proc', taskId: 'task-good', status: 'completed' });
    appendEvent('task-good', 'task:start', {}, 1000);
    appendEvent('task-good', 'task:complete', {}, 2000);
    const res = await server.handleRequest(get('/api/v1/tasks/task-good/process-state'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as TaskProcessProjection;
    expect(body.lifecycle.status).toBe('completed');
    expect(body.completeness.kind).toBe('complete');
    expect(body.lifecycle.terminalEventType).toBe('task:complete');
    expect(body.gates.workflowHumanInput.open).toBe(false);
    expect(body.gates.codingCliApproval.open).toBe(false);
  });

  test('exposes coding-cli approval as an open gate', async () => {
    plantSessionTask({ sessionId: 'sess-proc', taskId: 'task-cli', status: 'running' });
    codingCliStore.insert({
      id: 'cli-X',
      taskId: 'task-cli',
      sessionId: null,
      providerId: 'claude-code',
      binaryPath: '/usr/local/bin/claude',
      binaryVersion: '0.0.1',
      capabilities: {} as never,
      cwd: '/tmp',
      pid: null,
      state: 'running',
      startedAt: 1000,
      updatedAt: 1100,
      endedAt: null,
      lastOutputAt: null,
      lastHookAt: null,
      transcriptPath: null,
      eventLogPath: null,
      filesChanged: [],
      commandsRequested: [],
      finalResult: null,
      rawMeta: {},
    });
    codingCliStore.recordApproval({
      id: 'appr-X',
      sessionId: 'cli-X',
      taskId: 'task-cli',
      requestId: 'r1',
      command: 'rm -rf /',
      reason: 'destructive',
      policyDecision: 'request_approval',
      humanDecision: null,
      decidedBy: null,
      decidedAt: null,
      requestedAt: 1500,
      rawJson: '{}',
    });

    const res = await server.handleRequest(get('/api/v1/tasks/task-cli/process-state'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as TaskProcessProjection;
    expect(body.gates.codingCliApproval.open).toBe(true);
    expect(body.codingCliSessions).toHaveLength(1);
    expect(body.codingCliSessions[0]!.pendingApprovals).toHaveLength(1);
    expect(body.codingCliSessions[0]!.pendingApprovals[0]!.command).toBe('rm -rf /');
  });
});

describe('GET /api/v1/tasks — needsActionType reflects coding-cli approval', () => {
  test('promotes a task to coding-cli-approval when an open approval row exists', async () => {
    plantSessionTask({ sessionId: 'sess-proc', taskId: 'task-list-cli', status: 'running' });
    codingCliStore.insert({
      id: 'cli-list',
      taskId: 'task-list-cli',
      sessionId: null,
      providerId: 'claude-code',
      binaryPath: '/usr/local/bin/claude',
      binaryVersion: '0.0.1',
      capabilities: {} as never,
      cwd: '/tmp',
      pid: null,
      state: 'running',
      startedAt: 2000,
      updatedAt: 2100,
      endedAt: null,
      lastOutputAt: null,
      lastHookAt: null,
      transcriptPath: null,
      eventLogPath: null,
      filesChanged: [],
      commandsRequested: [],
      finalResult: null,
      rawMeta: {},
    });
    codingCliStore.recordApproval({
      id: 'appr-list',
      sessionId: 'cli-list',
      taskId: 'task-list-cli',
      requestId: 'rl',
      command: 'edit',
      reason: 'edit',
      policyDecision: 'request_approval',
      humanDecision: null,
      decidedBy: null,
      decidedAt: null,
      requestedAt: 2200,
      rawJson: '{}',
    });

    const res = await server.handleRequest(get('/api/v1/tasks'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { tasks: Array<{ taskId: string; needsActionType: string; needsAction: boolean }> };
    const row = body.tasks.find((t) => t.taskId === 'task-list-cli');
    expect(row).toBeDefined();
    expect(row!.needsActionType).toBe('coding-cli-approval');
    expect(row!.needsAction).toBe(true);
  });
});

describe('GET /api/v1/tasks/:id — pendingGates.codingCliApproval', () => {
  test('exposes the durable coding-cli gate alongside other gates', async () => {
    plantSessionTask({ sessionId: 'sess-proc', taskId: 'task-detail-cli', status: 'running' });
    codingCliStore.insert({
      id: 'cli-detail',
      taskId: 'task-detail-cli',
      sessionId: null,
      providerId: 'claude-code',
      binaryPath: '/usr/local/bin/claude',
      binaryVersion: '0.0.1',
      capabilities: {} as never,
      cwd: '/tmp',
      pid: null,
      state: 'running',
      startedAt: 3000,
      updatedAt: 3100,
      endedAt: null,
      lastOutputAt: null,
      lastHookAt: null,
      transcriptPath: null,
      eventLogPath: null,
      filesChanged: [],
      commandsRequested: [],
      finalResult: null,
      rawMeta: {},
    });
    codingCliStore.recordApproval({
      id: 'appr-detail',
      sessionId: 'cli-detail',
      taskId: 'task-detail-cli',
      requestId: 'rd',
      command: 'mv /a /b',
      reason: 'move',
      policyDecision: 'request_approval',
      humanDecision: null,
      decidedBy: null,
      decidedAt: null,
      requestedAt: 3200,
      rawJson: '{}',
    });

    const res = await server.handleRequest(get('/api/v1/tasks/task-detail-cli'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      pendingGates: {
        partialDecision: boolean;
        humanInput: boolean;
        approval: boolean;
        codingCliApproval: boolean;
      };
    };
    expect(body.pendingGates.codingCliApproval).toBe(true);
  });
});
