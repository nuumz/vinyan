/**
 * A8 / T2 — governance search/replay endpoint tests.
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
import { TRACE_SCHEMA_SQL, migratePipelineConfidenceColumns, migrateThinkingColumns, migrateTranscriptColumns } from '../../src/db/trace-schema.ts';
import { TraceStore } from '../../src/db/trace-store.ts';
import type { ExecutionTrace, GovernanceProvenance, TaskInput, TaskResult } from '../../src/orchestrator/types.ts';

const TEST_DIR = join(tmpdir(), `vinyan-governance-api-${Date.now()}`);
const TOKEN_PATH = join(TEST_DIR, 'api-token');
const TEST_TOKEN = `test-token-${'b'.repeat(52)}`;

let server: VinyanAPIServer;
let db: Database;

function makeProv(overrides: Partial<GovernanceProvenance> = {}): GovernanceProvenance {
  return {
    decisionId: 'orchestrator:t1:short-circuit-l0',
    policyVersion: 'orchestrator-governance:v1',
    attributedTo: 'orchestrator',
    wasGeneratedBy: 'risk-router',
    wasDerivedFrom: [{ kind: 'task-input', source: 't1', observedAt: 1_700_000_000_000 }],
    decidedAt: 1_700_000_000_000,
    evidenceObservedAt: 1_700_000_000_000,
    reason: 'L0 short-circuit',
    escalationPath: [0],
    ...overrides,
  };
}

function makeTrace(overrides: Partial<ExecutionTrace> = {}): ExecutionTrace {
  return {
    id: `trace-${Math.random().toString(36).slice(2, 8)}`,
    taskId: 'task-1',
    timestamp: 1_700_000_000_000,
    routingLevel: 0,
    approach: 'reflex',
    oracleVerdicts: { ast: true },
    modelUsed: 'none',
    tokensConsumed: 0,
    durationMs: 50,
    outcome: 'success',
    affectedFiles: [],
    ...overrides,
  };
}

function authHeaders() {
  return { Authorization: `Bearer ${TEST_TOKEN}`, 'Content-Type': 'application/json' };
}

function req(path: string): Request {
  return new Request(`http://localhost${path}`, { headers: authHeaders() });
}

beforeAll(() => {
  mkdirSync(TEST_DIR, { recursive: true });
  writeFileSync(TOKEN_PATH, TEST_TOKEN);

  db = new Database(':memory:');
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  new MigrationRunner().migrate(db, ALL_MIGRATIONS);
  // Migrations build session/etc tables; trace schema is owned by TRACE_SCHEMA_SQL
  // which holds the full `execution_traces` definition (including denormalized
  // confidence + governance columns). It is `IF NOT EXISTS`, so it composes safely.
  db.exec(TRACE_SCHEMA_SQL);
  migratePipelineConfidenceColumns(db);
  migrateTranscriptColumns(db);
  migrateThinkingColumns(db);

  const bus = createBus();
  const sessionManager = new SessionManager(new SessionStore(db));
  const traceStore = new TraceStore(db);

  // Seed: one available, one legacy.
  traceStore.insert(makeTrace({ id: 't-A', governanceProvenance: makeProv({ decisionId: 'd-A' }) }));
  traceStore.insert(
    makeTrace({
      id: 't-B',
      governanceProvenance: makeProv({
        decisionId: 'd-B',
        attributedTo: 'goal-grounding',
        policyVersion: 'goal-time-grounding:v1',
        decidedAt: 1_700_000_500_000,
      }),
    }),
  );
  traceStore.insert(makeTrace({ id: 't-legacy', governanceProvenance: undefined, taskId: 'task-legacy' }));

  const executeTask = (input: TaskInput): Promise<TaskResult> =>
    Promise.resolve({ id: input.id, status: 'completed', mutations: [], trace: {} as any });

  server = new VinyanAPIServer(
    { port: 0, bind: '127.0.0.1', tokenPath: TOKEN_PATH, authRequired: true, rateLimitEnabled: false },
    { bus, executeTask, sessionManager, traceStore },
  );
});

afterAll(() => {
  db.close();
});

describe('GET /api/v1/governance/search', () => {
  test('returns all rows with availability flags', async () => {
    const res = await server.handleRequest(req('/api/v1/governance/search'));
    expect(res.status).toBe(200);
    const data = (await res.json()) as any;
    expect(data.total).toBe(3);
    expect(data.rows).toHaveLength(3);
    const availabilities = data.rows.map((r: any) => r.availability).sort();
    expect(availabilities).toEqual(['available', 'available', 'unavailable']);
  });

  test('filters by actor', async () => {
    const res = await server.handleRequest(req('/api/v1/governance/search?actor=goal-grounding'));
    const data = (await res.json()) as any;
    expect(data.total).toBe(1);
    expect(data.rows[0].traceId).toBe('t-B');
  });

  test('filters by policyVersion + paginates', async () => {
    const res = await server.handleRequest(
      req('/api/v1/governance/search?policyVersion=orchestrator-governance:v1&limit=10'),
    );
    const data = (await res.json()) as any;
    expect(data.total).toBe(1);
    expect(data.rows[0].traceId).toBe('t-A');
  });

  test('time range filter', async () => {
    const res = await server.handleRequest(req('/api/v1/governance/search?from=1700000000001'));
    const data = (await res.json()) as any;
    expect(data.total).toBe(1);
    expect(data.rows[0].traceId).toBe('t-B');
  });
});

describe('GET /api/v1/governance/decisions/:id/replay', () => {
  test('returns replay envelope for known decision', async () => {
    const res = await server.handleRequest(req('/api/v1/governance/decisions/d-A/replay'));
    expect(res.status).toBe(200);
    const data = (await res.json()) as any;
    expect(data.decisionId).toBe('d-A');
    expect(data.availability).toBe('available');
    expect(data.policyVersion).toBe('orchestrator-governance:v1');
    expect(data.attributedTo).toBe('orchestrator');
    expect(data.evidence).toBeArray();
  });

  test('returns 404 for unknown decision id', async () => {
    const res = await server.handleRequest(req('/api/v1/governance/decisions/unknown-id/replay'));
    expect(res.status).toBe(404);
    const data = (await res.json()) as any;
    expect(data.error).toContain('not found');
  });
});
