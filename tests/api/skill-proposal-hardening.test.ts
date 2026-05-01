/**
 * Round 5 hardening contract — G1 (size cap), G2 (optimistic lock),
 * G6 (revision retention cap), G7 (configurable fresh-evidence floor),
 * plus mig 032 backfill (G5) and the autogen event-semantics fix (G4).
 *
 * Verifies:
 *   - G1: oversized SKILL.md on /scan and /draft → 413
 *   - G2: stale expectedRevision → 412 + latestRevision in payload
 *   - G2: matching expectedRevision → 200
 *   - G2: omitted expectedRevision → still works (backward-compat)
 *   - G6: more than MAX_REVISIONS_PER_PROPOSAL revisions retains
 *     revision 1 + most-recent (cap - 1)
 *   - G4: below-threshold success no longer fires
 *     `skill:autogen_promotion_blocked` (event noise reduction)
 *   - G4: cooldown / fresh-evidence still fire when threshold met
 *   - G5: migration 032 backfills revision 1 for pre-existing
 *     proposals
 *   - G7: configurable `minPostRestartEvidence` floor (clamped to ≥1)
 */
import { Database } from 'bun:sqlite';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { VinyanAPIServer } from '../../src/api/server.ts';
import { SessionManager } from '../../src/api/session-manager.ts';
import { createBus, type VinyanBus } from '../../src/core/bus.ts';
import { ALL_MIGRATIONS, MigrationRunner } from '../../src/db/migrations/index.ts';
import { migration032 } from '../../src/db/migrations/032_skill_proposal_revisions.ts';
import { SessionStore } from '../../src/db/session-store.ts';
import {
  MAX_REVISIONS_PER_PROPOSAL,
  MAX_SKILL_MD_BYTES,
  SkillProposalStore,
} from '../../src/db/skill-proposal-store.ts';
import { SkillAutogenStateStore } from '../../src/skills/autogen-state-store.ts';
import { wireSkillProposalAutogen } from '../../src/skills/proposal-autogen.ts';
import type { TaskInput, TaskResult, CachedSkill } from '../../src/orchestrator/types.ts';

const TEST_DIR = join(tmpdir(), `vinyan-skill-hardening-test-${Date.now()}`);
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

function makeSkill(overrides: Partial<CachedSkill> = {}): CachedSkill {
  return {
    taskSignature: 'sig:test',
    approach: 'do thing',
    successRate: 0.9,
    status: 'active',
    probationRemaining: 0,
    usageCount: 5,
    riskAtCreation: 0.2,
    depConeHashes: {},
    lastVerifiedAt: 1_700_000_000_000,
    verificationProfile: 'structural',
    ...overrides,
  };
}

const SAFE_MD = `# safe\n## Steps\n1. Do thing.\n`;

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

describe('G1 — body size cap on /scan and /draft', () => {
  test('/scan rejects oversized SKILL.md with 413', async () => {
    const oversized = 'x'.repeat(MAX_SKILL_MD_BYTES + 1);
    const res = await server.handleRequest(
      authedReq('/api/v1/skill-proposals/scan', {
        method: 'POST',
        body: JSON.stringify({ skillMd: oversized }),
      }),
    );
    expect(res.status).toBe(413);
    const body = (await res.json()) as { error: string; maxBytes: number };
    expect(body.maxBytes).toBe(MAX_SKILL_MD_BYTES);
  });

  test('/draft rejects oversized SKILL.md with 413', async () => {
    const create = await server.handleRequest(
      authedReq('/api/v1/skill-proposals', {
        method: 'POST',
        body: JSON.stringify({
          proposedName: 'oversize-target',
          proposedCategory: 'refactor',
          skillMd: SAFE_MD,
        }),
      }),
    );
    const created = (await create.json()) as { proposal: { id: string } };
    const oversized = 'x'.repeat(MAX_SKILL_MD_BYTES + 1);
    const patch = await server.handleRequest(
      authedReq(`/api/v1/skill-proposals/${created.proposal.id}/draft`, {
        method: 'PATCH',
        body: JSON.stringify({
          skillMd: oversized,
          actor: 'alice',
          reason: 'attempted oversize',
        }),
      }),
    );
    expect(patch.status).toBe(413);
  });

  test('/scan accepts payload at the cap', async () => {
    const atCap = 'x'.repeat(MAX_SKILL_MD_BYTES);
    const res = await server.handleRequest(
      authedReq('/api/v1/skill-proposals/scan', {
        method: 'POST',
        body: JSON.stringify({ skillMd: atCap }),
      }),
    );
    expect(res.status).toBe(200);
  });
});

describe('G2 — optimistic locking on /draft', () => {
  test('stale expectedRevision returns 412 + latestRevision', async () => {
    const create = await server.handleRequest(
      authedReq('/api/v1/skill-proposals', {
        method: 'POST',
        body: JSON.stringify({
          proposedName: 'optimistic-target',
          proposedCategory: 'refactor',
          skillMd: SAFE_MD,
        }),
      }),
    );
    const created = (await create.json()) as { proposal: { id: string } };

    // First operator lands a save (revision 2).
    await server.handleRequest(
      authedReq(`/api/v1/skill-proposals/${created.proposal.id}/draft`, {
        method: 'PATCH',
        body: JSON.stringify({
          skillMd: `${SAFE_MD}\nedit-1`,
          actor: 'alice',
          reason: 'first edit',
          expectedRevision: 1,
        }),
      }),
    );

    // Second operator was viewing revision 1 — submits with stale token.
    const stale = await server.handleRequest(
      authedReq(`/api/v1/skill-proposals/${created.proposal.id}/draft`, {
        method: 'PATCH',
        body: JSON.stringify({
          skillMd: `${SAFE_MD}\nedit-2-from-stale`,
          actor: 'bob',
          reason: 'overwrite attempt',
          expectedRevision: 1,
        }),
      }),
    );
    expect(stale.status).toBe(412);
    const body = (await stale.json()) as { code: string; latestRevision: number };
    expect(body.code).toBe('precondition-failed');
    expect(body.latestRevision).toBe(2);
  });

  test('matching expectedRevision succeeds', async () => {
    const create = await server.handleRequest(
      authedReq('/api/v1/skill-proposals', {
        method: 'POST',
        body: JSON.stringify({
          proposedName: 'matching-target',
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
          skillMd: `${SAFE_MD}\nedit-1`,
          actor: 'alice',
          reason: 'matching',
          expectedRevision: 1,
        }),
      }),
    );
    expect(patch.status).toBe(200);
    const body = (await patch.json()) as { revision: number };
    expect(body.revision).toBe(2);
  });

  test('omitted expectedRevision still works (backward-compat)', async () => {
    const create = await server.handleRequest(
      authedReq('/api/v1/skill-proposals', {
        method: 'POST',
        body: JSON.stringify({
          proposedName: 'no-expectation-target',
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
          skillMd: `${SAFE_MD}\nedit-1`,
          actor: 'alice',
          reason: 'no-expectation',
          // no expectedRevision
        }),
      }),
    );
    expect(patch.status).toBe(200);
  });
});

describe('G2-extension — latestRevision on the proposal entity', () => {
  test('GET /:id returns latestRevision = 1 right after create', async () => {
    const create = await server.handleRequest(
      authedReq('/api/v1/skill-proposals', {
        method: 'POST',
        body: JSON.stringify({
          proposedName: 'g2x-fresh',
          proposedCategory: 'refactor',
          skillMd: SAFE_MD,
        }),
      }),
    );
    const created = (await create.json()) as { proposal: { id: string; latestRevision: number } };
    expect(created.proposal.latestRevision).toBe(1);

    const detail = await server.handleRequest(
      authedReq(`/api/v1/skill-proposals/${created.proposal.id}`),
    );
    const body = (await detail.json()) as { proposal: { latestRevision: number } };
    expect(body.proposal.latestRevision).toBe(1);
  });

  test('latestRevision reflects post-PATCH revision count', async () => {
    const create = await server.handleRequest(
      authedReq('/api/v1/skill-proposals', {
        method: 'POST',
        body: JSON.stringify({
          proposedName: 'g2x-bumps',
          proposedCategory: 'refactor',
          skillMd: SAFE_MD,
        }),
      }),
    );
    const created = (await create.json()) as { proposal: { id: string } };
    // Three patches → revisions 2, 3, 4.
    for (let i = 0; i < 3; i += 1) {
      await server.handleRequest(
        authedReq(`/api/v1/skill-proposals/${created.proposal.id}/draft`, {
          method: 'PATCH',
          body: JSON.stringify({
            skillMd: `${SAFE_MD}\nedit-${i}`,
            actor: 'alice',
            reason: `edit ${i}`,
          }),
        }),
      );
    }
    const detail = await server.handleRequest(
      authedReq(`/api/v1/skill-proposals/${created.proposal.id}`),
    );
    const body = (await detail.json()) as { proposal: { latestRevision: number } };
    expect(body.proposal.latestRevision).toBe(4);
  });

  test('list endpoint includes latestRevision per proposal', async () => {
    // Seed two proposals + bump one.
    await server.handleRequest(
      authedReq('/api/v1/skill-proposals', {
        method: 'POST',
        body: JSON.stringify({
          proposedName: 'g2x-list-a',
          proposedCategory: 'refactor',
          skillMd: SAFE_MD,
        }),
      }),
    );
    const createB = await server.handleRequest(
      authedReq('/api/v1/skill-proposals', {
        method: 'POST',
        body: JSON.stringify({
          proposedName: 'g2x-list-b',
          proposedCategory: 'refactor',
          skillMd: SAFE_MD,
        }),
      }),
    );
    const b = (await createB.json()) as { proposal: { id: string } };
    await server.handleRequest(
      authedReq(`/api/v1/skill-proposals/${b.proposal.id}/draft`, {
        method: 'PATCH',
        body: JSON.stringify({
          skillMd: `${SAFE_MD}\nbump`,
          actor: 'alice',
          reason: 'bump',
        }),
      }),
    );
    const list = await server.handleRequest(authedReq('/api/v1/skill-proposals?limit=200'));
    const body = (await list.json()) as {
      proposals: Array<{ proposedName: string; latestRevision: number }>;
    };
    const a = body.proposals.find((p) => p.proposedName === 'g2x-list-a');
    const bRow = body.proposals.find((p) => p.proposedName === 'g2x-list-b');
    expect(a?.latestRevision).toBe(1);
    expect(bRow?.latestRevision).toBe(2);
  });
});

describe('G3 — revision endpoint immediately reflects PATCH (data freshness)', () => {
  test('PATCH followed by GET /revisions returns the new revision in the same request flow', async () => {
    const create = await server.handleRequest(
      authedReq('/api/v1/skill-proposals', {
        method: 'POST',
        body: JSON.stringify({
          proposedName: 'g3-fresh',
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
          skillMd: `${SAFE_MD}\nfresh`,
          actor: 'alice',
          reason: 'freshness check',
        }),
      }),
    );
    // No delay — the GET should see revision 2 immediately. If the
    // PATCH wasn't persisted before the response returned, this would
    // be racy.
    const list = await server.handleRequest(
      authedReq(`/api/v1/skill-proposals/${created.proposal.id}/revisions`),
    );
    const body = (await list.json()) as {
      revisions: Array<{ revision: number; reason: string | null }>;
    };
    expect(body.revisions[0]?.revision).toBe(2);
    expect(body.revisions[0]?.reason).toBe('freshness check');
  });
});

describe('G8 — transactional recordSuccess rolls back on outer-tx failure', () => {
  test('increment rolls back when wrapping transaction throws', () => {
    const localDb = new Database(':memory:');
    localDb.exec('PRAGMA journal_mode = WAL');
    new MigrationRunner().migrate(localDb, ALL_MIGRATIONS);
    const stateStore = new SkillAutogenStateStore(localDb);
    const bootId = stateStore.reconcile().bootId;

    // Establish a baseline: one persisted increment.
    stateStore.recordSuccess({
      profile: 'g8',
      signatureKey: 'sig:tx',
      bootId,
      taskId: 't0',
    });
    expect(stateStore.get('g8', 'sig:tx')!.successes).toBe(1);

    // Wrap a recordSuccess inside an outer transaction that throws
    // AFTER the inner increment lands. SQLite's nested-transaction
    // (SAVEPOINT) semantics roll the inner write back together with
    // the outer rollback, so the persisted counter is unchanged.
    expect(() => {
      localDb.transaction(() => {
        stateStore.recordSuccess({
          profile: 'g8',
          signatureKey: 'sig:tx',
          bootId,
          taskId: 't1',
        });
        throw new Error('outer-tx-rollback');
      })();
    }).toThrow('outer-tx-rollback');

    // Counter unchanged — the inner write was reverted.
    expect(stateStore.get('g8', 'sig:tx')!.successes).toBe(1);
    localDb.close();
  });

  test('successive serial increments accumulate cleanly (no lost updates)', () => {
    const localDb = new Database(':memory:');
    localDb.exec('PRAGMA journal_mode = WAL');
    new MigrationRunner().migrate(localDb, ALL_MIGRATIONS);
    const stateStore = new SkillAutogenStateStore(localDb);
    const bootId = stateStore.reconcile().bootId;
    for (let i = 0; i < 50; i += 1) {
      stateStore.recordSuccess({
        profile: 'g8',
        signatureKey: 'sig:serial',
        bootId,
        taskId: `t-${i}`,
      });
    }
    expect(stateStore.get('g8', 'sig:serial')!.successes).toBe(50);
    localDb.close();
  });
});

describe('G6 — revision retention cap', () => {
  test('keeps revision 1 + most recent (cap - 1) revisions', async () => {
    const create = await server.handleRequest(
      authedReq('/api/v1/skill-proposals', {
        method: 'POST',
        body: JSON.stringify({
          proposedName: 'cap-target',
          proposedCategory: 'refactor',
          skillMd: SAFE_MD,
        }),
      }),
    );
    const created = (await create.json()) as { proposal: { id: string } };

    // Submit `cap + 5` revisions. Each PATCH adds revision 2..(cap+5).
    for (let i = 0; i < MAX_REVISIONS_PER_PROPOSAL + 5; i += 1) {
      await server.handleRequest(
        authedReq(`/api/v1/skill-proposals/${created.proposal.id}/draft`, {
          method: 'PATCH',
          body: JSON.stringify({
            skillMd: `${SAFE_MD}\nedit-${i}`,
            actor: 'alice',
            reason: `edit ${i}`,
          }),
        }),
      );
    }

    const list = await server.handleRequest(
      authedReq(`/api/v1/skill-proposals/${created.proposal.id}/revisions?limit=200`),
    );
    const body = (await list.json()) as {
      revisions: Array<{ revision: number; actor: string }>;
      total: number;
    };
    // Cap retained — at most MAX_REVISIONS_PER_PROPOSAL rows.
    expect(body.total).toBeLessThanOrEqual(MAX_REVISIONS_PER_PROPOSAL);
    // Revision 1 always preserved as provenance.
    expect(body.revisions.some((r) => r.revision === 1)).toBe(true);
    // Newest revision is (created)+ (cap+5) = MAX_REVISIONS_PER_PROPOSAL + 6.
    const expectedLatest = MAX_REVISIONS_PER_PROPOSAL + 6;
    expect(body.revisions[0]?.revision).toBe(expectedLatest);
    // Mid-history revisions evicted — revision 2 should be gone.
    expect(body.revisions.some((r) => r.revision === 2)).toBe(false);
  });
});

describe('G4 — autogen event noise reduction', () => {
  test('below-threshold success does NOT emit promotion_blocked', async () => {
    const events: Array<{ reason: string }> = [];
    const off = bus.on('skill:autogen_promotion_blocked', (p) =>
      events.push(p as { reason: string }),
    );
    const localStore = new SkillProposalStore(db);
    const wired = wireSkillProposalAutogen({
      bus,
      store: localStore,
      threshold: 5,
      defaultProfile: 'g4-quiet',
      policyEnabled: false,
      cooldownMs: 0,
    });
    bus.emit('skill:outcome', {
      taskId: 'g4-t1',
      skill: makeSkill({ taskSignature: 'sig:g4-quiet' }),
      success: true,
    });
    bus.emit('skill:outcome', {
      taskId: 'g4-t2',
      skill: makeSkill({ taskSignature: 'sig:g4-quiet' }),
      success: true,
    });
    wired();
    off();
    // Two below-threshold emits — both silent.
    expect(events.length).toBe(0);
  });

  test('above-threshold success in cooldown DOES emit promotion_blocked', async () => {
    const events: Array<{ reason: string; signatureKey: string }> = [];
    const off = bus.on('skill:autogen_promotion_blocked', (p) =>
      events.push(p as { reason: string; signatureKey: string }),
    );
    const stateStore = new SkillAutogenStateStore(db);
    const localStore = new SkillProposalStore(db);
    const wired = wireSkillProposalAutogen({
      bus,
      store: localStore,
      stateStore,
      threshold: 2,
      defaultProfile: 'g4-cooldown',
      policyEnabled: false,
      cooldownMs: 60_000,
    });
    // Two emits to cross threshold + lock the cooldown.
    bus.emit('skill:outcome', {
      taskId: 'g4-c1',
      skill: makeSkill({ taskSignature: 'sig:g4-cool' }),
      success: true,
    });
    bus.emit('skill:outcome', {
      taskId: 'g4-c2',
      skill: makeSkill({ taskSignature: 'sig:g4-cool' }),
      success: true,
    });
    // Third emit hits cooldown — would-have-promoted, but blocked.
    bus.emit('skill:outcome', {
      taskId: 'g4-c3',
      skill: makeSkill({ taskSignature: 'sig:g4-cool' }),
      success: true,
    });
    wired();
    off();
    const cooldownEvents = events.filter((e) => e.reason === 'cooldown');
    expect(cooldownEvents.length).toBeGreaterThanOrEqual(1);
  });
});

describe('G5 — mig 032 backfills revision 1 for pre-existing proposals', () => {
  test('proposal without revision rows gets revision 1 on backfill', () => {
    // Create a fresh DB so we can simulate "proposal exists without
    // a corresponding revision row" without colliding with the
    // module-scope `db`.
    const localDb = new Database(':memory:');
    localDb.exec('PRAGMA journal_mode = WAL');
    new MigrationRunner().migrate(localDb, ALL_MIGRATIONS);
    // Simulate a pre-mig-032 proposal by inserting via raw SQL
    // (bypassing SkillProposalStore.create which auto-seeds the
    // revision row), then deleting its revision-1 row so we look
    // like a pre-mig-032 leftover.
    const localStore = new SkillProposalStore(localDb);
    const proposal = localStore.create({
      profile: 'backfill',
      proposedName: 'pre-mig-target',
      proposedCategory: 'refactor',
      skillMd: SAFE_MD,
    });
    localDb.run(`DELETE FROM skill_proposal_revisions WHERE proposal_id = ?`, [proposal.id]);
    expect(
      (localDb
        .query(
          `SELECT COUNT(*) AS c FROM skill_proposal_revisions WHERE proposal_id = ?`,
        )
        .get(proposal.id) as { c: number }).c,
    ).toBe(0);

    // Re-run mig 032's backfill. The migration is idempotent — the
    // CREATE TABLE / TRIGGER blocks all use IF NOT EXISTS, and the
    // backfill is INSERT OR IGNORE.
    migration032.up(localDb);

    const after = localStore.listRevisions('backfill', proposal.id);
    expect(after.length).toBe(1);
    expect(after[0]?.revision).toBe(1);
    expect(after[0]?.actor).toBe('auto-generator');
    expect(after[0]?.reason).toContain('backfilled by migration 032');
    localDb.close();
  });
});

describe('G7 — configurable minPostRestartEvidence', () => {
  let localDb: Database;
  beforeEach(() => {
    localDb = new Database(':memory:');
    localDb.exec('PRAGMA journal_mode = WAL');
    new MigrationRunner().migrate(localDb, ALL_MIGRATIONS);
  });
  afterEach(() => {
    localDb.close();
  });

  test('higher floor blocks promotion until enough fresh evidence', () => {
    const stateStore = new SkillAutogenStateStore(localDb, {
      minPostRestartEvidence: 3,
    });
    const bootId = stateStore.reconcile().bootId;
    // Two fresh successes — sinceBoot reaches 1 (first is creation).
    stateStore.recordSuccess({
      profile: 'g7',
      signatureKey: 'sig:floor',
      bootId,
      taskId: 'g7-t1',
    });
    let r = stateStore.recordSuccess({
      profile: 'g7',
      signatureKey: 'sig:floor',
      bootId,
      taskId: 'g7-t2',
    });
    expect(stateStore.canPromote(r, 1).reason).toBe('fresh-evidence');

    // Third success → sinceBoot = 2; still below floor of 3.
    r = stateStore.recordSuccess({
      profile: 'g7',
      signatureKey: 'sig:floor',
      bootId,
      taskId: 'g7-t3',
    });
    expect(stateStore.canPromote(r, 1).reason).toBe('fresh-evidence');

    // Fourth success → sinceBoot = 3; now passes the floor.
    r = stateStore.recordSuccess({
      profile: 'g7',
      signatureKey: 'sig:floor',
      bootId,
      taskId: 'g7-t4',
    });
    expect(stateStore.canPromote(r, 1).ok).toBe(true);
  });

  test('floor clamped to absolute minimum of 1 (never disabled)', () => {
    const zero = new SkillAutogenStateStore(localDb, { minPostRestartEvidence: 0 });
    expect(zero.getMinFreshEvidence()).toBe(1);
    const negative = new SkillAutogenStateStore(localDb, { minPostRestartEvidence: -5 });
    expect(negative.getMinFreshEvidence()).toBe(1);
  });
});
