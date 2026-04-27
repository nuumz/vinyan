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
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { VinyanAPIServer } from '../../src/api/server.ts';
import { SessionManager } from '../../src/api/session-manager.ts';
import { createBus } from '../../src/core/bus.ts';
import { Database } from 'bun:sqlite';
import { ALL_MIGRATIONS, MigrationRunner } from '../../src/db/migrations/index.ts';
import { SessionStore } from '../../src/db/session-store.ts';
import { LLMReasoningEngine, ReasoningEngineRegistry } from '../../src/orchestrator/llm/llm-reasoning-engine.ts';
import { requiresAuth } from '../../src/security/auth.ts';
import type { LLMProvider, TaskInput, TaskResult } from '../../src/orchestrator/types.ts';

const TEST_DIR = join(tmpdir(), `vinyan-engines-test-${Date.now()}`);
const TOKEN_PATH = join(TEST_DIR, 'api-token');
const TEST_TOKEN = `test-token-${'a'.repeat(52)}`;

let db: Database;

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

function makeServer(opts: { withRegistry: boolean }) {
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
    },
  );
}

beforeAll(() => {
  mkdirSync(TEST_DIR, { recursive: true });
  writeFileSync(TOKEN_PATH, TEST_TOKEN);
  db = new Database(':memory:');
  db.exec('PRAGMA journal_mode = WAL');
  new MigrationRunner().migrate(db, ALL_MIGRATIONS);
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
    const ids = data.workers.map((w) => w.id).sort();
    expect(ids).toContain('openrouter/balanced/anthropic/claude-sonnet-4.6');
    expect(ids).toContain('openrouter/fast/google/gemma-4-31b-it');
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
    const data = (await res.json()) as { worker: { id: string; status: string } };
    expect(data.worker.id).toBe('openrouter/balanced/anthropic/claude-sonnet-4.6');
    expect(data.worker.status).toBe('active');
  });

  test('returns 404 for an unknown engine id', async () => {
    const server = makeServer({ withRegistry: true });
    const res = await server.handleRequest(
      new Request('http://localhost/api/v1/engines/does-not-exist'),
    );
    expect(res.status).toBe(404);
  });
});
