/**
 * R2 — `/api/v1/skill-proposals/scan`, `/draft`, `/revisions` contract.
 *
 * Verifies:
 *   - scan endpoint returns deterministic verdict for the same bytes
 *   - dangerous content lights credential / hidden-unicode flags
 *   - draft patch updates skill_md AND re-scans
 *   - draft patch flips status: quarantined → pending when flags clear
 *   - draft patch flips status: pending → quarantined when flags fire
 *   - draft patch requires actor (no anonymous edits)
 *   - decided proposals (approved / rejected) cannot be edited (409)
 *   - revisions endpoint returns history newest-first with revision 1
 *     == initial create
 *   - approve now requires reason (R2 tightening)
 *   - revisions never bypass safety: editing dangerous content keeps
 *     status quarantined and the row records the flagged verdict
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
import { SkillProposalStore } from '../../src/db/skill-proposal-store.ts';
import type { TaskInput, TaskResult } from '../../src/orchestrator/types.ts';

const TEST_DIR = join(tmpdir(), `vinyan-skill-editor-test-${Date.now()}`);
const TOKEN_PATH = join(TEST_DIR, 'api-token');
const TEST_TOKEN = `test-token-${'a'.repeat(52)}`;

let server: VinyanAPIServer;
let db: Database;
let bus: VinyanBus;
let store: SkillProposalStore;

function authedReq(
  path: string,
  opts: { method?: string; body?: string } = {},
): Request {
  return new Request(`http://localhost${path}`, {
    method: opts.method ?? 'GET',
    headers: {
      Authorization: `Bearer ${TEST_TOKEN}`,
      'Content-Type': 'application/json',
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
      approach: 'mock',
      modelUsed: 'mock/test',
      tokensConsumed: 50,
      durationMs: 25,
      outcome: 'success',
      oracleVerdicts: {},
      affectedFiles: [],
    },
  } as unknown as TaskResult);
}

const SAFE_MD = `# safe-skill\nUse for refactor.\n## Steps\n1. Do thing.\n`;
const DANGEROUS_MD = `# danger\nuse: Bearer eyJfakefakefakefakefake\n`;

beforeAll(() => {
  mkdirSync(TEST_DIR, { recursive: true });
  writeFileSync(TOKEN_PATH, TEST_TOKEN);

  db = new Database(':memory:');
  db.exec('PRAGMA journal_mode = WAL');
  new MigrationRunner().migrate(db, ALL_MIGRATIONS);

  bus = createBus();
  store = new SkillProposalStore(db);

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
      sessionManager: new SessionManager(new SessionStore(db)),
      skillProposalStore: store,
      defaultProfile: 'default',
    },
  );
});

afterAll(() => {
  db.close();
});

describe('POST /api/v1/skill-proposals/scan', () => {
  test('returns safe verdict for clean SKILL.md', async () => {
    const res = await server.handleRequest(
      authedReq('/api/v1/skill-proposals/scan', {
        method: 'POST',
        body: JSON.stringify({ skillMd: SAFE_MD }),
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { safe: boolean; flags: string[] };
    expect(body.safe).toBe(true);
    expect(body.flags.length).toBe(0);
  });

  test('flags credential-shaped tokens', async () => {
    const res = await server.handleRequest(
      authedReq('/api/v1/skill-proposals/scan', {
        method: 'POST',
        body: JSON.stringify({ skillMd: DANGEROUS_MD }),
      }),
    );
    const body = (await res.json()) as { safe: boolean; flags: string[] };
    expect(body.safe).toBe(false);
    expect(body.flags.some((f) => f.startsWith('credential:'))).toBe(true);
  });

  test('deterministic — same input → same output', async () => {
    const inputs = ['# t\ndo X\n', '# t\ndo X\n'];
    const verdicts = await Promise.all(
      inputs.map(async (skillMd) => {
        const res = await server.handleRequest(
          authedReq('/api/v1/skill-proposals/scan', {
            method: 'POST',
            body: JSON.stringify({ skillMd }),
          }),
        );
        return (await res.json()) as { safe: boolean; flags: string[] };
      }),
    );
    expect(verdicts[0]).toEqual(verdicts[1]);
  });

  test('rejects body without skillMd field', async () => {
    const res = await server.handleRequest(
      authedReq('/api/v1/skill-proposals/scan', { method: 'POST', body: '{}' }),
    );
    expect(res.status).toBe(400);
  });
});

describe('PATCH /api/v1/skill-proposals/:id/draft', () => {
  test('updates SKILL.md and seeds revision 2', async () => {
    const create = await server.handleRequest(
      authedReq('/api/v1/skill-proposals', {
        method: 'POST',
        body: JSON.stringify({
          proposedName: 'edit-me',
          proposedCategory: 'refactor',
          skillMd: SAFE_MD,
        }),
      }),
    );
    const created = (await create.json()) as { proposal: { id: string } };

    const patch = await server.handleRequest(
      authedReq(`/api/v1/skill-proposals/${created.proposal.id}/draft`, {
        method: 'PATCH',
        body: JSON.stringify({
          skillMd: `${SAFE_MD}\n## Notes\nClarified scope.`,
          actor: 'alice',
          reason: 'clarify scope',
        }),
      }),
    );
    expect(patch.status).toBe(200);
    const after = (await patch.json()) as {
      proposal: { skillMd: string; status: string };
      revision: number;
    };
    expect(after.revision).toBe(2);
    expect(after.proposal.skillMd).toContain('Clarified scope');
    expect(after.proposal.status).toBe('pending');
  });

  test('flips quarantined → pending when flags clear', async () => {
    const create = await server.handleRequest(
      authedReq('/api/v1/skill-proposals', {
        method: 'POST',
        body: JSON.stringify({
          proposedName: 'clear-flags',
          proposedCategory: 'refactor',
          skillMd: DANGEROUS_MD,
        }),
      }),
    );
    const created = (await create.json()) as { proposal: { id: string; status: string } };
    expect(created.proposal.status).toBe('quarantined');

    const patch = await server.handleRequest(
      authedReq(`/api/v1/skill-proposals/${created.proposal.id}/draft`, {
        method: 'PATCH',
        body: JSON.stringify({
          skillMd: SAFE_MD,
          actor: 'alice',
          reason: 'removed credential token',
        }),
      }),
    );
    const after = (await patch.json()) as { proposal: { status: string; safetyFlags: string[] } };
    expect(after.proposal.status).toBe('pending');
    expect(after.proposal.safetyFlags.length).toBe(0);
  });

  test('flips pending → quarantined when flags fire', async () => {
    const create = await server.handleRequest(
      authedReq('/api/v1/skill-proposals', {
        method: 'POST',
        body: JSON.stringify({
          proposedName: 'inject-flags',
          proposedCategory: 'refactor',
          skillMd: SAFE_MD,
        }),
      }),
    );
    const created = (await create.json()) as { proposal: { id: string; status: string } };
    expect(created.proposal.status).toBe('pending');

    const patch = await server.handleRequest(
      authedReq(`/api/v1/skill-proposals/${created.proposal.id}/draft`, {
        method: 'PATCH',
        body: JSON.stringify({
          skillMd: DANGEROUS_MD,
          actor: 'alice',
          reason: 'simulated mistake',
        }),
      }),
    );
    const after = (await patch.json()) as { proposal: { status: string; safetyFlags: string[] } };
    expect(after.proposal.status).toBe('quarantined');
    expect(after.proposal.safetyFlags.length).toBeGreaterThan(0);
  });

  test('requires actor (no anonymous edits — A8)', async () => {
    const create = await server.handleRequest(
      authedReq('/api/v1/skill-proposals', {
        method: 'POST',
        body: JSON.stringify({
          proposedName: 'no-actor-target',
          proposedCategory: 'refactor',
          skillMd: SAFE_MD,
        }),
      }),
    );
    const created = (await create.json()) as { proposal: { id: string } };
    const patch = await server.handleRequest(
      authedReq(`/api/v1/skill-proposals/${created.proposal.id}/draft`, {
        method: 'PATCH',
        body: JSON.stringify({ skillMd: `${SAFE_MD}\nedited` }),
      }),
    );
    expect(patch.status).toBe(400);
  });

  test('decided proposals are immutable (409)', async () => {
    const create = await server.handleRequest(
      authedReq('/api/v1/skill-proposals', {
        method: 'POST',
        body: JSON.stringify({
          proposedName: 'decided-target',
          proposedCategory: 'refactor',
          skillMd: SAFE_MD,
        }),
      }),
    );
    const created = (await create.json()) as { proposal: { id: string } };
    await server.handleRequest(
      authedReq(`/api/v1/skill-proposals/${created.proposal.id}/approve`, {
        method: 'POST',
        body: JSON.stringify({ decidedBy: 'operator', reason: 'verified' }),
      }),
    );
    const patch = await server.handleRequest(
      authedReq(`/api/v1/skill-proposals/${created.proposal.id}/draft`, {
        method: 'PATCH',
        body: JSON.stringify({ skillMd: 'late edit', actor: 'alice', reason: 'too late' }),
      }),
    );
    expect(patch.status).toBe(409);
  });
});

describe('GET /api/v1/skill-proposals/:id/revisions', () => {
  test('lists revisions newest-first with revision 1 == initial create', async () => {
    const create = await server.handleRequest(
      authedReq('/api/v1/skill-proposals', {
        method: 'POST',
        body: JSON.stringify({
          proposedName: 'revs-target',
          proposedCategory: 'refactor',
          skillMd: SAFE_MD,
        }),
      }),
    );
    const created = (await create.json()) as { proposal: { id: string } };

    await server.handleRequest(
      authedReq(`/api/v1/skill-proposals/${created.proposal.id}/draft`, {
        method: 'PATCH',
        body: JSON.stringify({
          skillMd: `${SAFE_MD}\n## v2`,
          actor: 'alice',
          reason: 'first edit',
        }),
      }),
    );
    await server.handleRequest(
      authedReq(`/api/v1/skill-proposals/${created.proposal.id}/draft`, {
        method: 'PATCH',
        body: JSON.stringify({
          skillMd: `${SAFE_MD}\n## v3`,
          actor: 'bob',
          reason: 'second edit',
        }),
      }),
    );

    const list = await server.handleRequest(
      authedReq(`/api/v1/skill-proposals/${created.proposal.id}/revisions`),
    );
    expect(list.status).toBe(200);
    const body = (await list.json()) as {
      revisions: Array<{
        revision: number;
        actor: string;
        reason: string | null;
        skillMd: string;
      }>;
      total: number;
    };
    expect(body.total).toBe(3);
    // Newest first.
    expect(body.revisions[0]?.revision).toBe(3);
    expect(body.revisions[0]?.actor).toBe('bob');
    expect(body.revisions[1]?.revision).toBe(2);
    expect(body.revisions[1]?.actor).toBe('alice');
    expect(body.revisions[2]?.revision).toBe(1);
    expect(body.revisions[2]?.actor).toBe('auto-generator');
    expect(body.revisions[2]?.reason).toBe('initial create');
  });
});

describe('R2 — approve / trust-tier require reason', () => {
  test('approve without reason returns 400', async () => {
    const create = await server.handleRequest(
      authedReq('/api/v1/skill-proposals', {
        method: 'POST',
        body: JSON.stringify({
          proposedName: 'no-reason-approve-target',
          proposedCategory: 'refactor',
          skillMd: SAFE_MD,
        }),
      }),
    );
    const created = (await create.json()) as { proposal: { id: string } };
    const res = await server.handleRequest(
      authedReq(`/api/v1/skill-proposals/${created.proposal.id}/approve`, {
        method: 'POST',
        body: JSON.stringify({ decidedBy: 'operator-z' }),
      }),
    );
    expect(res.status).toBe(400);
  });
});
