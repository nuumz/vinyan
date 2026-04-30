/**
 * Unified Skill Library API — `/api/v1/skills` list/detail/CRUD.
 *
 * Covers the contract the UI relies on:
 *   - GET /skills returns an aggregated `items[]` across simple/heavy/cached.
 *   - GET /skills?kind=simple narrows to one bucket.
 *   - GET /skills?agentId=<id> hides other agents' per-agent skills.
 *   - POST creates a project-scope SKILL.md on disk and the registry sees it.
 *   - PUT overwrites in place; DELETE removes the directory.
 *   - GET /skills/:id returns full body / approach / heavyFrontmatter.
 *   - status=<x> returns the legacy cached_skills shape (back-compat).
 */
import { Database } from 'bun:sqlite';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { VinyanAPIServer } from '../../src/api/server.ts';
import { SessionManager } from '../../src/api/session-manager.ts';
import { createBus } from '../../src/core/bus.ts';
import { ALL_MIGRATIONS, MigrationRunner } from '../../src/db/migrations/index.ts';
import { SessionStore } from '../../src/db/session-store.ts';
import { SkillStore } from '../../src/db/skill-store.ts';
import { createSimpleSkillRegistry } from '../../src/skills/simple/registry.ts';
import type { TaskInput, TaskResult } from '../../src/orchestrator/types.ts';

const TEST_ROOT = join(tmpdir(), `vinyan-skill-catalog-test-${Date.now()}-${process.pid}`);
const TOKEN_PATH = join(TEST_ROOT, 'api-token');
const TEST_TOKEN = `test-token-${'a'.repeat(52)}`;
const WORKSPACE = join(TEST_ROOT, 'workspace');
const PROJECT_SKILLS = join(WORKSPACE, '.vinyan', 'skills');
const PROJECT_AGENTS = join(WORKSPACE, '.vinyan', 'agents');
const USER_SKILLS = join(TEST_ROOT, 'home', '.vinyan', 'skills');
const USER_AGENTS = join(TEST_ROOT, 'home', '.vinyan', 'agents');

const authHeaders = { Authorization: `Bearer ${TEST_TOKEN}`, 'Content-Type': 'application/json' };

let server: VinyanAPIServer;
let db: Database;

function req(path: string, init: RequestInit = {}): Request {
  return new Request(`http://localhost${path}`, {
    method: init.method ?? 'GET',
    headers: { ...authHeaders, ...(init.headers as Record<string, string> | undefined) },
    body: init.body,
  });
}

beforeAll(() => {
  mkdirSync(TEST_ROOT, { recursive: true });
  mkdirSync(PROJECT_SKILLS, { recursive: true });
  mkdirSync(PROJECT_AGENTS, { recursive: true });
  mkdirSync(USER_SKILLS, { recursive: true });
  mkdirSync(USER_AGENTS, { recursive: true });
  writeFileSync(TOKEN_PATH, TEST_TOKEN);

  // Seed a simple project skill so list() has something to find before any
  // CRUD test runs.
  mkdirSync(join(PROJECT_SKILLS, 'code-review'), { recursive: true });
  writeFileSync(
    join(PROJECT_SKILLS, 'code-review', 'SKILL.md'),
    `---\nname: code-review\ndescription: Review TypeScript code for bugs.\n---\n\nReview procedure: check null derefs.\n`,
  );

  // Seed a per-agent skill (researcher) that should NOT show up for other agents.
  mkdirSync(join(PROJECT_AGENTS, 'researcher', 'skills', 'web-search'), { recursive: true });
  writeFileSync(
    join(PROJECT_AGENTS, 'researcher', 'skills', 'web-search', 'SKILL.md'),
    `---\nname: web-search\ndescription: Web search helper.\n---\n\nResearcher uses this.\n`,
  );

  // ── DB + skill store with one cached row.
  db = new Database(':memory:');
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  new MigrationRunner().migrate(db, ALL_MIGRATIONS);
  const skillStore = new SkillStore(db);
  skillStore.insert({
    taskSignature: 'review-typescript-file',
    approach: 'Use code-review skill, focus on null safety',
    successRate: 0.85,
    status: 'active',
    probationRemaining: 0,
    usageCount: 12,
    riskAtCreation: 0.2,
    depConeHashes: {},
    lastVerifiedAt: 1_700_000_000_000,
    verificationProfile: 'structural',
  });

  // ── Simple registry pointed at our tmp dirs.
  const simpleSkillRegistry = createSimpleSkillRegistry({
    workspace: WORKSPACE,
    userSkillsDir: USER_SKILLS,
    projectSkillsDir: PROJECT_SKILLS,
    userAgentsDir: USER_AGENTS,
    projectAgentsDir: PROJECT_AGENTS,
    watch: false,
  });

  // ── Session manager (stub trace store unused for these tests).
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
      skillStore,
      simpleSkillRegistry,
      simpleSkillFsOverrides: {
        userSkillsDir: USER_SKILLS,
        projectSkillsDir: PROJECT_SKILLS,
        userAgentsDir: USER_AGENTS,
        projectAgentsDir: PROJECT_AGENTS,
      },
      workspace: WORKSPACE,
    },
  );
});

afterAll(() => {
  db?.close();
});

describe('GET /api/v1/skills (unified)', () => {
  test('returns simple + cached items (no heavy artifact store wired)', async () => {
    const res = await server.handleRequest(req('/api/v1/skills'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: Array<{ kind: string; name: string }> };
    const kinds = new Set(body.items.map((i) => i.kind));
    expect(kinds.has('simple')).toBe(true);
    expect(kinds.has('cached')).toBe(true);
    const names = body.items.map((i) => i.name).sort();
    expect(names).toContain('code-review');
    expect(names).toContain('web-search');
    expect(names).toContain('review-typescript-file');
  });

  test('?kind=simple narrows to simple skills only', async () => {
    const res = await server.handleRequest(req('/api/v1/skills?kind=simple'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: Array<{ kind: string }> };
    expect(body.items.length).toBeGreaterThan(0);
    expect(body.items.every((i) => i.kind === 'simple')).toBe(true);
  });

  test('?agentId=researcher exposes researcher per-agent skills + shared, hides others', async () => {
    const res = await server.handleRequest(req('/api/v1/skills?kind=simple&agentId=researcher'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      items: Array<{ name: string; agentId?: string; scope?: string }>;
    };
    const names = body.items.map((i) => i.name).sort();
    expect(names).toContain('code-review');
    expect(names).toContain('web-search');
  });

  test('?agentId=developer hides researcher per-agent skills', async () => {
    const res = await server.handleRequest(req('/api/v1/skills?kind=simple&agentId=developer'));
    const body = (await res.json()) as { items: Array<{ name: string }> };
    const names = body.items.map((i) => i.name);
    expect(names).toContain('code-review');
    expect(names).not.toContain('web-search');
  });

  test('?status=active falls back to legacy cached_skills shape', async () => {
    const res = await server.handleRequest(req('/api/v1/skills?status=active'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      skills: Array<{ taskSignature?: string; status?: string }>;
      items?: unknown;
    };
    expect(body.items).toBeUndefined();
    expect(body.skills.length).toBe(1);
    expect(body.skills[0]?.taskSignature).toBe('review-typescript-file');
    expect(body.skills[0]?.status).toBe('active');
  });
});

describe('GET /api/v1/skills/:id (detail)', () => {
  test('detail for a simple skill returns body + scope + path', async () => {
    const res = await server.handleRequest(req('/api/v1/skills/simple:project:code-review'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      kind: string;
      name: string;
      body?: string;
      scope: string;
      path: string;
      editable: boolean;
    };
    expect(body.kind).toBe('simple');
    expect(body.name).toBe('code-review');
    expect(body.scope).toBe('project');
    expect(body.body).toContain('Review procedure');
    expect(body.editable).toBe(true);
  });

  test('detail for a cached skill returns approach + stats', async () => {
    const res = await server.handleRequest(req('/api/v1/skills/cached:review-typescript-file'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      kind: string;
      approach?: string;
      successRate?: number;
      editable: boolean;
    };
    expect(body.kind).toBe('cached');
    expect(body.approach).toContain('null safety');
    expect(body.successRate).toBeCloseTo(0.85);
    expect(body.editable).toBe(false);
  });

  test('unknown id returns 404', async () => {
    const res = await server.handleRequest(req('/api/v1/skills/simple:project:does-not-exist'));
    expect(res.status).toBe(404);
  });
});

describe('POST/PUT/DELETE /api/v1/skills (CRUD)', () => {
  test('POST creates a project-scope skill and lands on disk', async () => {
    const res = await server.handleRequest(
      req('/api/v1/skills', {
        method: 'POST',
        body: JSON.stringify({
          name: 'lint-check',
          description: 'Run linter and report issues.',
          body: '## Procedure\n\nRun bun run check.',
        }),
      }),
    );
    expect(res.status).toBe(201);
    const created = (await res.json()) as { id: string; path: string };
    expect(created.id).toBe('simple:project:lint-check');
    const onDisk = readFileSync(created.path, 'utf-8');
    expect(onDisk).toContain('name: lint-check');
    expect(onDisk).toContain('Run linter and report issues.');
  });

  test('POST rejects an invalid name (no slug)', async () => {
    const res = await server.handleRequest(
      req('/api/v1/skills', {
        method: 'POST',
        body: JSON.stringify({
          name: '../../etc/passwd',
          description: 'malicious',
          body: '...',
        }),
      }),
    );
    expect(res.status).toBe(400);
  });

  test('POST rejects user-agent scope without agentId', async () => {
    const res = await server.handleRequest(
      req('/api/v1/skills', {
        method: 'POST',
        body: JSON.stringify({
          name: 'has-no-agent',
          description: 'oops',
          body: '...',
          scope: 'user-agent',
        }),
      }),
    );
    expect(res.status).toBe(400);
  });

  test('PUT updates an existing simple skill in place', async () => {
    const res = await server.handleRequest(
      req('/api/v1/skills/simple:project:lint-check', {
        method: 'PUT',
        body: JSON.stringify({
          name: 'lint-check',
          description: 'Run linter and report issues. Updated.',
          body: '## Procedure\n\nRun bun run check, then biome check.',
          scope: 'project',
        }),
      }),
    );
    expect(res.status).toBe(200);
    const detailRes = await server.handleRequest(
      req('/api/v1/skills/simple:project:lint-check'),
    );
    const detail = (await detailRes.json()) as {
      description: string;
      body?: string;
    };
    expect(detail.description).toBe('Run linter and report issues. Updated.');
    expect(detail.body).toContain('biome check');
  });

  test('PUT rejects rename via body.name mismatch', async () => {
    const res = await server.handleRequest(
      req('/api/v1/skills/simple:project:lint-check', {
        method: 'PUT',
        body: JSON.stringify({
          name: 'lint-check-renamed',
          description: 'x',
          body: '...',
          scope: 'project',
        }),
      }),
    );
    expect(res.status).toBe(400);
  });

  test('PUT on a heavy id is rejected with 405', async () => {
    const res = await server.handleRequest(
      req('/api/v1/skills/heavy:local/whatever', {
        method: 'PUT',
        body: JSON.stringify({
          name: 'whatever',
          description: 'x',
          body: '...',
          scope: 'project',
        }),
      }),
    );
    expect(res.status).toBe(405);
  });

  test('DELETE removes the skill and is idempotent', async () => {
    const first = await server.handleRequest(
      req('/api/v1/skills/simple:project:lint-check', { method: 'DELETE' }),
    );
    expect(first.status).toBe(204);
    const second = await server.handleRequest(
      req('/api/v1/skills/simple:project:lint-check', { method: 'DELETE' }),
    );
    expect(second.status).toBe(204);
  });

  test('DELETE on a cached id is rejected with 405', async () => {
    const res = await server.handleRequest(
      req('/api/v1/skills/cached:review-typescript-file', { method: 'DELETE' }),
    );
    expect(res.status).toBe(405);
  });
});
