/**
 * API server — agent-context export + proficiency-reset endpoints.
 *
 *   GET  /api/v1/agents/:id/context/export
 *   POST /api/v1/agents/:id/proficiencies/reset
 *
 * Both go through `handleRequest()` so the test exercises the live route
 * matcher (avoids drift if the URL pattern changes). A real
 * `AgentContextStore` is wired into a `:memory:` SQLite — exercises the
 * persistence path that matters for reset (mutate → upsert → re-find).
 */
import { Database } from 'bun:sqlite';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { VinyanAPIServer } from '../../src/api/server.ts';
import { SessionManager } from '../../src/api/session-manager.ts';
import { createBus } from '../../src/core/bus.ts';
import { AgentContextStore } from '../../src/db/agent-context-store.ts';
import { ALL_MIGRATIONS, MigrationRunner } from '../../src/db/migrations/index.ts';
import { SessionStore } from '../../src/db/session-store.ts';
import type { AgentContext } from '../../src/orchestrator/agent-context/types.ts';
import type { TaskInput, TaskResult } from '../../src/orchestrator/types.ts';

const TEST_ROOT = join(tmpdir(), `vinyan-agent-context-actions-${Date.now()}-${process.pid}`);
const TOKEN_PATH = join(TEST_ROOT, 'api-token');
const TEST_TOKEN = `test-token-${'a'.repeat(52)}`;
const authHeaders = { Authorization: `Bearer ${TEST_TOKEN}`, 'Content-Type': 'application/json' };

let server: VinyanAPIServer;
let db: Database;
let agentContextStore: AgentContextStore;

function req(path: string, init: RequestInit = {}): Request {
  return new Request(`http://localhost${path}`, {
    method: init.method ?? 'GET',
    headers: { ...authHeaders, ...(init.headers as Record<string, string> | undefined) },
    body: init.body,
  });
}

function makeContext(agentId: string): AgentContext {
  return {
    identity: {
      agentId,
      persona: 'developer',
      strengths: ['typescript'],
      weaknesses: [],
      approachStyle: 'iterative',
    },
    memory: { episodes: [], lessonsSummary: 'be careful with mutations' },
    skills: {
      proficiencies: {
        'review::typescript::small': {
          taskSignature: 'review::typescript::small',
          level: 'competent',
          successRate: 0.8,
          totalAttempts: 5,
          lastAttempt: 1_700_000_000_000,
        },
        'unknown::none::single': {
          taskSignature: 'unknown::none::single',
          level: 'novice',
          successRate: 1,
          totalAttempts: 1,
          lastAttempt: 1_700_000_000_000,
        },
      },
      preferredApproaches: {},
      antiPatterns: [],
    },
    lastUpdated: 1_700_000_000_000,
  };
}

beforeAll(() => {
  mkdirSync(TEST_ROOT, { recursive: true });
  writeFileSync(TOKEN_PATH, TEST_TOKEN);

  db = new Database(':memory:');
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  new MigrationRunner().migrate(db, ALL_MIGRATIONS);

  agentContextStore = new AgentContextStore(db);
  const sessionStore = new SessionStore(db);
  const sessionManager = new SessionManager(sessionStore);

  server = new VinyanAPIServer(
    {
      port: 0,
      bind: '127.0.0.1',
      tokenPath: TOKEN_PATH,
      authRequired: true,
      rateLimitEnabled: false,
    },
    {
      bus: createBus(),
      executeTask: (input: TaskInput) =>
        Promise.resolve({ id: input.id, status: 'completed', mutations: [], answer: 'ok' } as unknown as TaskResult),
      sessionManager,
      agentContextStore,
    },
  );
});

afterAll(() => {
  db?.close();
});

beforeEach(() => {
  // Reset state for every test — keep them order-independent.
  db.prepare('DELETE FROM agent_contexts').run();
});

describe('GET /api/v1/agents/:id/context/export', () => {
  test('returns full context JSON with timestamp', async () => {
    agentContextStore.upsert(makeContext('developer'));

    const res = await server.handleRequest(
      req('/api/v1/agents/developer/context/export'),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      agentId: string;
      context: AgentContext;
      exportedAt: number;
    };
    expect(body.agentId).toBe('developer');
    expect(typeof body.exportedAt).toBe('number');
    expect(Object.keys(body.context.skills.proficiencies).sort()).toEqual([
      'review::typescript::small',
      'unknown::none::single',
    ]);
    // `lessonsSummary` and `preferredApproaches`/`antiPatterns` are
    // intentionally NOT persisted by `AgentContextStore.upsert` — those
    // are derived/'filled by builder' fields on read. The export reflects
    // exactly what the store persisted, which is the operator-facing truth.
  });

  test('404 when agent has no recorded context', async () => {
    const res = await server.handleRequest(
      req('/api/v1/agents/never-seen/context/export'),
    );
    expect(res.status).toBe(404);
  });
});

describe('POST /api/v1/agents/:id/proficiencies/reset', () => {
  test('removes a single proficiency entry and persists', async () => {
    agentContextStore.upsert(makeContext('developer'));

    const res = await server.handleRequest(
      req('/api/v1/agents/developer/proficiencies/reset', {
        method: 'POST',
        body: JSON.stringify({
          signature: 'unknown::none::single',
          reason: 'noise from one-off task',
        }),
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: true;
      removed: boolean;
      signature: string;
      remaining?: number;
    };
    expect(body.ok).toBe(true);
    expect(body.removed).toBe(true);
    expect(body.signature).toBe('unknown::none::single');
    expect(body.remaining).toBe(1);

    // Persistence — re-read confirms removal AND that the other entry stays.
    const after = agentContextStore.findById('developer');
    expect(after).not.toBeNull();
    expect(Object.keys(after!.skills.proficiencies)).toEqual([
      'review::typescript::small',
    ]);
  });

  test('idempotent — second reset returns removed:false', async () => {
    agentContextStore.upsert(makeContext('developer'));

    const r1 = await server.handleRequest(
      req('/api/v1/agents/developer/proficiencies/reset', {
        method: 'POST',
        body: JSON.stringify({ signature: 'unknown::none::single' }),
      }),
    );
    expect(r1.status).toBe(200);

    const r2 = await server.handleRequest(
      req('/api/v1/agents/developer/proficiencies/reset', {
        method: 'POST',
        body: JSON.stringify({ signature: 'unknown::none::single' }),
      }),
    );
    expect(r2.status).toBe(200);
    const body2 = (await r2.json()) as { removed: boolean };
    expect(body2.removed).toBe(false);
  });

  test('does not touch episodes, lessons, or other proficiencies', async () => {
    const ctx = makeContext('developer');
    ctx.memory.episodes = [
      {
        taskId: 'task-1',
        taskSignature: 'unknown::none::single',
        outcome: 'success',
        lesson: 'one-off task',
        filesInvolved: [],
        approachUsed: 'direct',
        timestamp: 1_700_000_000_000,
      },
    ];
    agentContextStore.upsert(ctx);

    await server.handleRequest(
      req('/api/v1/agents/developer/proficiencies/reset', {
        method: 'POST',
        body: JSON.stringify({ signature: 'unknown::none::single' }),
      }),
    );

    const after = agentContextStore.findById('developer')!;
    // Episodes immutable — kept as-is.
    expect(after.memory.episodes).toHaveLength(1);
    expect(after.memory.episodes[0]?.taskId).toBe('task-1');
    // Other proficiency untouched.
    expect(after.skills.proficiencies['review::typescript::small']?.totalAttempts).toBe(5);
  });

  test('400 on missing/invalid signature', async () => {
    agentContextStore.upsert(makeContext('developer'));
    const r1 = await server.handleRequest(
      req('/api/v1/agents/developer/proficiencies/reset', {
        method: 'POST',
        body: JSON.stringify({}),
      }),
    );
    expect(r1.status).toBe(400);

    const r2 = await server.handleRequest(
      req('/api/v1/agents/developer/proficiencies/reset', {
        method: 'POST',
        body: JSON.stringify({ signature: '   ' }),
      }),
    );
    expect(r2.status).toBe(400);
  });

  test('404 when agent has no recorded context', async () => {
    const res = await server.handleRequest(
      req('/api/v1/agents/never-seen/proficiencies/reset', {
        method: 'POST',
        body: JSON.stringify({ signature: 'whatever' }),
      }),
    );
    expect(res.status).toBe(404);
  });
});
