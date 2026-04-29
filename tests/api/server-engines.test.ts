/**
 * Engine API surface — `/api/v1/workers` + `/api/v1/engines`.
 *
 * The bedtime-story dashboard bug had a sibling failure mode: the Engines
 * page showed "No engines registered" on a fresh server because the existing
 * `/workers` endpoint only consulted `workerStore` (historical trace
 * records). Live engines registered at startup were invisible until the
 * first task ran.
 *
 * This test pins the fix:
 *   - `/api/v1/workers` returns engines from the live `ReasoningEngineRegistry`
 *     even when `workerStore` is empty.
 *   - `/api/v1/engines` is the new list endpoint with the same payload
 *     shape under `{ engines: ... }` for future UI migration.
 *   - `/api/v1/engines/{id}` falls back to the registry when the engine
 *     has never appeared in a trace.
 *   - Both endpoints are allowlisted (no auth required).
 */
import { Database } from 'bun:sqlite';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { VinyanAPIServer } from '../../src/api/server.ts';
import { SessionManager } from '../../src/api/session-manager.ts';
import { createBus } from '../../src/core/bus.ts';
import { ALL_MIGRATIONS, MigrationRunner } from '../../src/db/migrations/index.ts';
import { SessionStore } from '../../src/db/session-store.ts';
import { WorkerStore } from '../../src/db/worker-store.ts';
import { engineIdFromWorker } from '../../src/orchestrator/llm/engine-worker-binding.ts';
import { LLMReasoningEngine, ReasoningEngineRegistry } from '../../src/orchestrator/llm/llm-reasoning-engine.ts';
import type { EngineProfile, LLMProvider, TaskInput, TaskResult } from '../../src/orchestrator/types.ts';
import { requiresAuth } from '../../src/security/auth.ts';

const TEST_DIR = join(tmpdir(), `vinyan-engines-test-${Date.now()}`);
const TOKEN_PATH = join(TEST_DIR, 'api-token');
const TEST_TOKEN = `test-token-${'a'.repeat(52)}`;

let db: Database;
let traceSeq = 0;

function mockExecuteTask(input: TaskInput): Promise<TaskResult> {
  return Promise.resolve({
    id: input.id,
    status: 'completed',
    mutations: [],
    trace: {} as never,
  });
}

function makeProvider(id: string, tier: LLMProvider['tier']): LLMProvider {
  return {
    id,
    tier,
    capabilities: ['code-generation', 'reasoning'],
    maxContextTokens: 200_000,
    async generate() {
      throw new Error('not used by these tests');
    },
  };
}

function makeServer(opts: { withRegistry: boolean; workerStore?: WorkerStore }) {
  const bus = createBus();
  const sessionStore = new SessionStore(db);
  const sessionManager = new SessionManager(sessionStore);

  const engineRegistry = opts.withRegistry ? new ReasoningEngineRegistry() : undefined;
  if (engineRegistry) {
    engineRegistry.register(new LLMReasoningEngine(makeProvider('openrouter/balanced/anthropic/claude-sonnet-4.6', 'balanced')));
    engineRegistry.register(new LLMReasoningEngine(makeProvider('openrouter/fast/google/gemma-4-31b-it', 'fast')));
  }

  return new VinyanAPIServer(
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
      engineRegistry,
      workerStore: opts.workerStore,
    },
  );
}

/**
 * Build a worker profile mirroring what `autoRegisterWorkers` produces — id
 * pattern is `worker-${engine.id}` and config.modelId equals engine.id.
 */
function workerForEngine(engineId: string, status: EngineProfile['status']): EngineProfile {
  return {
    id: `worker-${engineId}`,
    config: { modelId: engineId, temperature: 0.7 },
    status,
    createdAt: 1_700_000_000_000,
    demotionCount: 0,
  };
}

function insertTrace(
  workerId: string,
  opts?: {
    outcome?: 'success' | 'failure';
    qualityComposite?: number;
    tokensConsumed?: number;
    durationMs?: number;
  },
) {
  traceSeq += 1;
  db.run(
    `INSERT INTO execution_traces (
      id, task_id, timestamp, routing_level, approach, model_used,
      tokens_consumed, duration_ms, outcome, oracle_verdicts, affected_files,
      worker_id, quality_composite, task_type_signature
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      `trace-engine-api-${traceSeq}`,
      `task-engine-api-${traceSeq}`,
      1_700_000_000_000 + traceSeq,
      1,
      'test approach',
      engineIdFromWorker(workerId),
      opts?.tokensConsumed ?? 100,
      opts?.durationMs ?? 1000,
      opts?.outcome ?? 'success',
      '{}',
      '[]',
      workerId,
      opts?.qualityComposite ?? 0.8,
      'api::engine',
    ],
  );
}

beforeAll(() => {
  mkdirSync(TEST_DIR, { recursive: true });
  writeFileSync(TOKEN_PATH, TEST_TOKEN);
  db = new Database(':memory:');
  db.exec('PRAGMA journal_mode = WAL');
  new MigrationRunner().migrate(db, ALL_MIGRATIONS);
});

beforeEach(() => {
  // The db is shared across tests for migration speed. Worker profiles
  // accumulate via INSERT OR IGNORE, so wipe them to keep each test
  // operating on a clean fixture.
  db.exec('DELETE FROM worker_profiles');
  db.exec('DELETE FROM execution_traces');
  traceSeq = 0;
});

afterAll(() => {
  db.close();
});

describe('GET /api/v1/workers — live engine merge', () => {
  test('returns engines from the live registry when workerStore is absent', async () => {
    // Reproduces the fresh-server scenario: no traces yet, no workerStore,
    // but the LLM registry has providers. The dashboard should still see
    // them — that was the production bug.
    const server = makeServer({ withRegistry: true });
    const res = await server.handleRequest(new Request('http://localhost/api/v1/workers'));
    expect(res.status).toBe(200);
    const data = (await res.json()) as { workers: Array<{ id: string; config: { modelId: string }; status: string }> };
    expect(data.workers.length).toBe(2);
    // ids are minted via `workerIdForEngine` so they share the `worker-`
    // prefix with worker-store rows — keeps a single canonical form.
    const ids = data.workers.map((w) => w.id).sort();
    expect(ids).toContain('worker-openrouter/balanced/anthropic/claude-sonnet-4.6');
    expect(ids).toContain('worker-openrouter/fast/google/gemma-4-31b-it');
    // The underlying modelId is the engine id itself (no prefix).
    const modelIds = data.workers.map((w) => w.config.modelId);
    expect(modelIds).toContain('openrouter/balanced/anthropic/claude-sonnet-4.6');
    // Live-registry-derived workers are reported as 'active' so the UI's
    // status filter doesn't accidentally hide them.
    for (const w of data.workers) expect(w.status).toBe('active');
  });

  test('returns empty array when neither workerStore nor registry is wired', async () => {
    const server = makeServer({ withRegistry: false });
    const res = await server.handleRequest(new Request('http://localhost/api/v1/workers'));
    expect(res.status).toBe(200);
    const data = (await res.json()) as { workers: unknown[] };
    expect(data.workers).toEqual([]);
  });
});

describe('GET /api/v1/engines — new list endpoint', () => {
  test('returns the same payload shape under `engines` key', async () => {
    const server = makeServer({ withRegistry: true });
    const res = await server.handleRequest(new Request('http://localhost/api/v1/engines'));
    expect(res.status).toBe(200);
    const data = (await res.json()) as { engines: Array<{ id: string }> };
    expect(data.engines.length).toBe(2);
    expect(data.engines.every((e) => typeof e.id === 'string')).toBe(true);
  });

  test('is allowlisted in requiresAuth so the dashboard can fetch without a token', () => {
    expect(requiresAuth('GET', '/api/v1/engines')).toBe(false);
    expect(requiresAuth('GET', '/api/v1/workers')).toBe(false);
  });

  test('enriches engine rows with authoritative worker stats', async () => {
    const workerStore = new WorkerStore(db);
    const engineId = 'openrouter/balanced/anthropic/claude-sonnet-4.6';
    const worker = workerForEngine(engineId, 'active');
    workerStore.insert(worker);
    insertTrace(worker.id, { outcome: 'success', qualityComposite: 0.9, tokensConsumed: 100, durationMs: 1000 });
    insertTrace(worker.id, { outcome: 'failure', qualityComposite: 0.3, tokensConsumed: 300, durationMs: 3000 });

    const server = makeServer({ withRegistry: true, workerStore });
    const res = await server.handleRequest(new Request('http://localhost/api/v1/engines'));
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      engines: Array<{
        id: string;
        stats?: { totalTasks: number; successRate: number; avgQualityScore: number; avgTokenCost: number; avgDurationMs: number };
      }>;
    };
    const row = data.engines.find((e) => e.id === worker.id);
    expect(row?.stats?.totalTasks).toBe(2);
    expect(row?.stats?.successRate).toBe(0.5);
    expect(row?.stats?.avgQualityScore).toBeCloseTo(0.6);
    expect(row?.stats?.avgTokenCost).toBe(200);
    expect(row?.stats?.avgDurationMs).toBe(2000);
  });

  test('surfaces stats for legacy traces written under the bare engine id', async () => {
    // Traces from before the canonical `worker-${engine.id}` migration
    // landed are stored with `worker_id = engine.id` (no prefix). The
    // dashboard previously showed Tasks=0 for those rows even though
    // recent tasks were visible in the drilldown.
    const workerStore = new WorkerStore(db);
    const engineId = 'openrouter/balanced/anthropic/claude-sonnet-4.6';
    const worker = workerForEngine(engineId, 'probation');
    workerStore.insert(worker);
    // Trace recorded with the legacy worker_id alias (bare engine id).
    insertTrace(engineId, { outcome: 'success', qualityComposite: 0.85, tokensConsumed: 200, durationMs: 2000 });

    const server = makeServer({ withRegistry: true, workerStore });
    const res = await server.handleRequest(new Request('http://localhost/api/v1/engines'));
    const data = (await res.json()) as { engines: Array<{ id: string; stats?: { totalTasks: number } }> };
    const row = data.engines.find((e) => e.id === worker.id);
    expect(row?.stats?.totalTasks).toBe(1);
  });
});

describe('engine list dedup — registry × workerStore', () => {
  test('one row per engine when both registry and worker-<engine.id> exist; worker status wins', async () => {
    // Reproduces the production screenshot anomaly: every engine appeared
    // twice (once "active" from the registry, once "probation" from the
    // worker entry created by autoRegisterWorkers). The fix is dedup via
    // the `worker-${engine.id}` mapping.
    const workerStore = new WorkerStore(db);
    workerStore.insert(workerForEngine('openrouter/balanced/anthropic/claude-sonnet-4.6', 'probation'));
    workerStore.insert(workerForEngine('openrouter/fast/google/gemma-4-31b-it', 'probation'));

    const server = makeServer({ withRegistry: true, workerStore });
    const res = await server.handleRequest(new Request('http://localhost/api/v1/workers'));
    expect(res.status).toBe(200);
    const data = (await res.json()) as { workers: Array<{ id: string; status: string; config: { modelId: string } }> };

    // Exactly two engines — no phantom duplicates from the registry.
    expect(data.workers.length).toBe(2);

    // Worker entry wins — status reflects fleet "earn" policy lifecycle,
    // not the registry's hardcoded 'active'.
    for (const w of data.workers) expect(w.status).toBe('probation');

    // Each engine appears at most once. Group by config.modelId to catch
    // any future regression that re-introduces a duplicate via a different
    // id scheme.
    const byModel = new Map<string, number>();
    for (const w of data.workers) {
      byModel.set(w.config.modelId, (byModel.get(w.config.modelId) ?? 0) + 1);
    }
    for (const count of byModel.values()) expect(count).toBe(1);
  });

  test('registry-only engines (no matching worker) still appear, marked active', async () => {
    // Edge case: an engine registered AFTER autoRegisterWorkers ran (or in
    // tests that skip the seeder). Live entry should surface so the
    // dashboard never goes blind to a real engine.
    const workerStore = new WorkerStore(db);
    // Only seed ONE of the two registry engines.
    workerStore.insert(workerForEngine('openrouter/balanced/anthropic/claude-sonnet-4.6', 'probation'));

    const server = makeServer({ withRegistry: true, workerStore });
    const res = await server.handleRequest(new Request('http://localhost/api/v1/engines'));
    const data = (await res.json()) as { engines: Array<{ id: string; status: string }> };
    expect(data.engines.length).toBe(2);
    const seeded = data.engines.find((e) => e.id === 'worker-openrouter/balanced/anthropic/claude-sonnet-4.6');
    // Live-only entries also get the canonical 'worker-' prefixed id
    // synthesized by engineFromRegistry — single id form across both paths.
    const liveOnly = data.engines.find((e) => e.id === 'worker-openrouter/fast/google/gemma-4-31b-it');
    expect(seeded?.status).toBe('probation');
    expect(liveOnly?.status).toBe('active');
  });

  test('historical-only engines (no matching live engine) appear at the end as retired view', async () => {
    // Worker for an engine that is NOT in the current registry — e.g. a
    // model that was decommissioned. Should still be visible for
    // retrospective inspection.
    const workerStore = new WorkerStore(db);
    workerStore.insert(workerForEngine('openrouter/legacy/old-model', 'retired'));

    const server = makeServer({ withRegistry: true, workerStore });
    const res = await server.handleRequest(new Request('http://localhost/api/v1/engines'));
    const data = (await res.json()) as { engines: Array<{ id: string; status: string }> };
    // 2 live + 1 retired = 3 entries total.
    expect(data.engines.length).toBe(3);
    expect(data.engines.find((e) => e.id === 'worker-openrouter/legacy/old-model')?.status).toBe('retired');
  });
});

describe('GET /api/v1/engines/:id — registry fallback', () => {
  test('returns 200 for a live engine with no historical trace record', async () => {
    const server = makeServer({ withRegistry: true });
    // Engine ids contain slashes; UI URL-encodes the id segment so the
    // route regex (which forbids slashes inside the id position) still
    // matches. Mirror that here.
    const id = encodeURIComponent('openrouter/balanced/anthropic/claude-sonnet-4.6');
    const res = await server.handleRequest(
      new Request(`http://localhost/api/v1/engines/${id}`),
    );
    expect(res.status).toBe(200);
    const data = (await res.json()) as { worker: { id: string; status: string; config: { modelId: string } } };
    // Detail endpoint surfaces the canonical (prefixed) id; modelId carries
    // the engine id without prefix.
    expect(data.worker.id).toBe('worker-openrouter/balanced/anthropic/claude-sonnet-4.6');
    expect(data.worker.config.modelId).toBe('openrouter/balanced/anthropic/claude-sonnet-4.6');
    expect(data.worker.status).toBe('active');
  });

  test('accepts a canonical worker id for a live registry-only engine', async () => {
    const server = makeServer({ withRegistry: true });
    const id = encodeURIComponent('worker-openrouter/balanced/anthropic/claude-sonnet-4.6');
    const res = await server.handleRequest(new Request(`http://localhost/api/v1/engines/${id}`));
    expect(res.status).toBe(200);
    const data = (await res.json()) as { worker: { id: string; config: { modelId: string } } };
    expect(data.worker.id).toBe('worker-openrouter/balanced/anthropic/claude-sonnet-4.6');
    expect(data.worker.config.modelId).toBe('openrouter/balanced/anthropic/claude-sonnet-4.6');
  });

  test('resolves an engine id to the historical worker row before registry fallback', async () => {
    const workerStore = new WorkerStore(db);
    const engineId = 'openrouter/balanced/anthropic/claude-sonnet-4.6';
    workerStore.insert(workerForEngine(engineId, 'probation'));

    const server = makeServer({ withRegistry: true, workerStore });
    const id = encodeURIComponent(engineId);
    const res = await server.handleRequest(new Request(`http://localhost/api/v1/engines/${id}`));
    expect(res.status).toBe(200);
    const data = (await res.json()) as { worker: { id: string; status: string } };
    expect(data.worker.id).toBe(`worker-${engineId}`);
    expect(data.worker.status).toBe('probation');
  });

  test('returns 404 for an unknown engine id', async () => {
    const server = makeServer({ withRegistry: true });
    const res = await server.handleRequest(
      new Request('http://localhost/api/v1/engines/does-not-exist'),
    );
    expect(res.status).toBe(404);
  });
});
