/**
 * `/api/v1/skill-proposals/*` contract — agent-managed skill creation
 * with quarantine + human approval.
 *
 * Verifies:
 *   - create with safe SKILL.md → status:pending, emits skill:proposed
 *   - create with credential-shaped content → status:quarantined, emits
 *     skill:proposal_quarantined
 *   - quarantined proposals cannot be one-click approved (409)
 *   - approve flips status, emits skill:proposal_approved
 *   - reject requires reason + decidedBy, emits skill:proposal_rejected
 *   - profile isolation — A-profile proposal is invisible to B-profile
 *   - duplicate (same name, same profile) merges sourceTaskIds + bumps
 *     successCount, preserving prior status
 *   - 503 when store not wired
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

const TEST_DIR = join(tmpdir(), `vinyan-skill-proposals-test-${Date.now()}`);
const TOKEN_PATH = join(TEST_DIR, 'api-token');
const TEST_TOKEN = `test-token-${'a'.repeat(52)}`;

let server: VinyanAPIServer;
let db: Database;
let bus: VinyanBus;
let store: SkillProposalStore;

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

beforeAll(() => {
  mkdirSync(TEST_DIR, { recursive: true });
  writeFileSync(TOKEN_PATH, TEST_TOKEN);

  db = new Database(':memory:');
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
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

const SAFE_SKILL_MD = `# extract-ts-types
Use when refactoring a TypeScript module's interface signatures.

## Steps
1. Run \`bun x tsc --noEmit\` to ensure baseline is green.
2. Use the Read tool to inspect the file.
3. Apply Edit with type changes.
`;

const DANGEROUS_SKILL_MD = `# danger-skill
Internal helper.

## Setup
export OPENAI_API_KEY=sk-secretproductiontoken12345678
`;

describe('POST /api/v1/skill-proposals (create)', () => {
  test('safe SKILL.md lands as pending and emits skill:proposed', async () => {
    const events: Array<{ proposedName: string }> = [];
    const off = bus.on('skill:proposed', (p) => events.push(p as { proposedName: string }));
    const res = await server.handleRequest(
      authedReq('/api/v1/skill-proposals', {
        method: 'POST',
        body: JSON.stringify({
          proposedName: 'extract-ts-types',
          proposedCategory: 'refactor',
          skillMd: SAFE_SKILL_MD,
          capabilityTags: ['refactor', 'typescript'],
          toolsRequired: ['Read', 'Edit', 'Bash'],
          sourceTaskIds: ['task-1', 'task-2'],
          successCount: 2,
        }),
      }),
    );
    off();
    expect(res.status).toBe(201);
    const body = (await res.json()) as { proposal: { id: string; status: string; safetyFlags: string[] } };
    expect(body.proposal.status).toBe('pending');
    expect(body.proposal.safetyFlags.length).toBe(0);
    expect(events.length).toBe(1);
    expect(events[0]?.proposedName).toBe('extract-ts-types');
  });

  test('credential-shaped SKILL.md lands as quarantined and emits proposal_quarantined', async () => {
    const events: Array<{ safetyFlags: ReadonlyArray<string> }> = [];
    const off = bus.on('skill:proposal_quarantined', (p) => events.push(p));
    const res = await server.handleRequest(
      authedReq('/api/v1/skill-proposals', {
        method: 'POST',
        body: JSON.stringify({
          proposedName: 'leaky-credential-skill',
          proposedCategory: 'misc',
          skillMd: DANGEROUS_SKILL_MD,
        }),
      }),
    );
    off();
    expect(res.status).toBe(201);
    const body = (await res.json()) as { proposal: { status: string; safetyFlags: string[] } };
    expect(body.proposal.status).toBe('quarantined');
    expect(body.proposal.safetyFlags).toContain('credential:openai');
    expect(events.length).toBe(1);
    expect(events[0]?.safetyFlags).toContain('credential:openai');
  });

  test('rejects invalid proposedName (must be slug)', async () => {
    const res = await server.handleRequest(
      authedReq('/api/v1/skill-proposals', {
        method: 'POST',
        body: JSON.stringify({
          proposedName: 'NotAValidSlug!',
          proposedCategory: 'refactor',
          skillMd: SAFE_SKILL_MD,
        }),
      }),
    );
    expect(res.status).toBe(400);
  });

  test('rejects empty skillMd', async () => {
    const res = await server.handleRequest(
      authedReq('/api/v1/skill-proposals', {
        method: 'POST',
        body: JSON.stringify({
          proposedName: 'no-body',
          proposedCategory: 'misc',
          skillMd: '   ',
        }),
      }),
    );
    expect(res.status).toBe(400);
  });
});

describe('lifecycle: approve / reject', () => {
  test('quarantined proposal cannot be one-click approved (409)', async () => {
    const create = await server.handleRequest(
      authedReq('/api/v1/skill-proposals', {
        method: 'POST',
        body: JSON.stringify({
          proposedName: 'quarantined-attempt',
          proposedCategory: 'misc',
          skillMd: `note ‮ reversed bidi`, // hidden unicode trips the safety scanner
        }),
      }),
    );
    const created = (await create.json()) as { proposal: { id: string; status: string } };
    expect(created.proposal.status).toBe('quarantined');
    const approve = await server.handleRequest(
      authedReq(`/api/v1/skill-proposals/${created.proposal.id}/approve`, {
        method: 'POST',
        body: JSON.stringify({ decidedBy: 'operator-a', reason: 'looks fine' }),
      }),
    );
    expect(approve.status).toBe(409);
    const body = (await approve.json()) as { flags: string[] };
    expect(body.flags).toContain('hidden-unicode');
  });

  test('pending proposal flips to approved and emits proposal_approved', async () => {
    const create = await server.handleRequest(
      authedReq('/api/v1/skill-proposals', {
        method: 'POST',
        body: JSON.stringify({
          proposedName: 'approve-me',
          proposedCategory: 'refactor',
          skillMd: SAFE_SKILL_MD,
        }),
      }),
    );
    const created = (await create.json()) as { proposal: { id: string } };

    const events: Array<{ decidedBy: string }> = [];
    const off = bus.on('skill:proposal_approved', (p) =>
      events.push(p as { decidedBy: string }),
    );
    const approve = await server.handleRequest(
      authedReq(`/api/v1/skill-proposals/${created.proposal.id}/approve`, {
        method: 'POST',
        body: JSON.stringify({ decidedBy: 'operator-b', reason: 'verified' }),
      }),
    );
    off();
    expect(approve.status).toBe(200);
    const body = (await approve.json()) as { proposal: { status: string; decidedBy: string } };
    expect(body.proposal.status).toBe('approved');
    expect(body.proposal.decidedBy).toBe('operator-b');
    expect(events[0]?.decidedBy).toBe('operator-b');
  });

  test('reject requires reason + decidedBy', async () => {
    const create = await server.handleRequest(
      authedReq('/api/v1/skill-proposals', {
        method: 'POST',
        body: JSON.stringify({
          proposedName: 'reject-target',
          proposedCategory: 'refactor',
          skillMd: SAFE_SKILL_MD,
        }),
      }),
    );
    const created = (await create.json()) as { proposal: { id: string } };

    // Missing reason → 400.
    const noReason = await server.handleRequest(
      authedReq(`/api/v1/skill-proposals/${created.proposal.id}/reject`, {
        method: 'POST',
        body: JSON.stringify({ decidedBy: 'operator-c' }),
      }),
    );
    expect(noReason.status).toBe(400);

    // Missing decidedBy → 400.
    const noWho = await server.handleRequest(
      authedReq(`/api/v1/skill-proposals/${created.proposal.id}/reject`, {
        method: 'POST',
        body: JSON.stringify({ reason: 'unsafe' }),
      }),
    );
    expect(noWho.status).toBe(400);

    // Both → 200 + event.
    const events: Array<{ reason: string }> = [];
    const off = bus.on('skill:proposal_rejected', (p) => events.push(p as { reason: string }));
    const ok = await server.handleRequest(
      authedReq(`/api/v1/skill-proposals/${created.proposal.id}/reject`, {
        method: 'POST',
        body: JSON.stringify({ decidedBy: 'operator-c', reason: 'duplicate of existing skill' }),
      }),
    );
    off();
    expect(ok.status).toBe(200);
    expect(events[0]?.reason).toBe('duplicate of existing skill');
  });
});

describe('idempotent merge', () => {
  test('re-creating same proposedName bumps successCount + appends source ids', async () => {
    const first = await server.handleRequest(
      authedReq('/api/v1/skill-proposals', {
        method: 'POST',
        body: JSON.stringify({
          proposedName: 'merge-target',
          proposedCategory: 'refactor',
          skillMd: SAFE_SKILL_MD,
          sourceTaskIds: ['task-A'],
          successCount: 1,
        }),
      }),
    );
    const firstBody = (await first.json()) as { proposal: { id: string; successCount: number; sourceTaskIds: string[] } };
    expect(firstBody.proposal.successCount).toBe(1);

    const second = await server.handleRequest(
      authedReq('/api/v1/skill-proposals', {
        method: 'POST',
        body: JSON.stringify({
          proposedName: 'merge-target',
          proposedCategory: 'refactor',
          skillMd: SAFE_SKILL_MD,
          sourceTaskIds: ['task-B'],
          successCount: 1,
        }),
      }),
    );
    const secondBody = (await second.json()) as { proposal: { id: string; successCount: number; sourceTaskIds: string[] } };
    expect(secondBody.proposal.id).toBe(firstBody.proposal.id);
    expect(secondBody.proposal.successCount).toBe(2);
    expect(secondBody.proposal.sourceTaskIds.sort()).toEqual(['task-A', 'task-B']);
  });
});

describe('profile isolation', () => {
  test('proposal in profile-a is invisible to profile-b', async () => {
    await server.handleRequest(
      authedReq('/api/v1/skill-proposals', {
        method: 'POST',
        body: JSON.stringify({
          proposedName: 'a-only',
          proposedCategory: 'refactor',
          skillMd: SAFE_SKILL_MD,
          profile: 'profile-a',
        }),
      }),
    );
    const aList = await server.handleRequest(
      authedReq('/api/v1/skill-proposals', { headers: { 'X-Vinyan-Profile': 'profile-a' } }),
    );
    const bList = await server.handleRequest(
      authedReq('/api/v1/skill-proposals', { headers: { 'X-Vinyan-Profile': 'profile-b' } }),
    );
    const aBody = (await aList.json()) as { proposals: Array<{ proposedName: string }> };
    const bBody = (await bList.json()) as { proposals: Array<{ proposedName: string }> };
    expect(aBody.proposals.some((p) => p.proposedName === 'a-only')).toBe(true);
    expect(bBody.proposals.some((p) => p.proposedName === 'a-only')).toBe(false);
  });
});

describe('503 when store not configured', () => {
  test('list / create return 503 when skillProposalStore is omitted', async () => {
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
        sessionManager: new SessionManager(new SessionStore(db)),
      },
    );
    const list = await stub.handleRequest(authedReq('/api/v1/skill-proposals'));
    expect(list.status).toBe(503);
    const create = await stub.handleRequest(
      authedReq('/api/v1/skill-proposals', {
        method: 'POST',
        body: JSON.stringify({
          proposedName: 'no-store',
          proposedCategory: 'misc',
          skillMd: SAFE_SKILL_MD,
        }),
      }),
    );
    expect(create.status).toBe(503);
  });
});
