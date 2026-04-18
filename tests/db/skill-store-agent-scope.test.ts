/**
 * SkillStore multi-agent scoping tests — verify agent_id partitioning
 * with legacy (agent_id IS NULL) fallback semantics.
 */
import { Database } from 'bun:sqlite';
import { beforeEach, describe, expect, test } from 'bun:test';
import { ALL_MIGRATIONS, MigrationRunner } from '../../src/db/migrations/index.ts';
import { SkillStore } from '../../src/db/skill-store.ts';
import type { CachedSkill } from '../../src/orchestrator/types.ts';

function makeSkill(overrides?: Partial<CachedSkill>): CachedSkill {
  return {
    taskSignature: 'refactor::ts::medium',
    approach: 'extract-method + inline tests',
    successRate: 0.9,
    status: 'active',
    probationRemaining: 0,
    usageCount: 5,
    riskAtCreation: 0.3,
    depConeHashes: {},
    lastVerifiedAt: Date.now(),
    verificationProfile: 'structural',
    origin: 'local',
    ...overrides,
  };
}

describe('SkillStore agent_id scoping', () => {
  let db: Database;
  let store: SkillStore;

  beforeEach(() => {
    db = new Database(':memory:');
    new MigrationRunner().migrate(db, ALL_MIGRATIONS);
    store = new SkillStore(db);
  });

  test('insert persists agent_id', () => {
    store.insert(makeSkill({ agentId: 'ts-coder' }));
    const retrieved = store.findBySignature('refactor::ts::medium');
    expect(retrieved?.agentId).toBe('ts-coder');
  });

  test('insert without agentId stores NULL (shared)', () => {
    store.insert(makeSkill());
    const retrieved = store.findBySignature('refactor::ts::medium');
    expect(retrieved?.agentId).toBeUndefined();
  });

  test('findBySignature(sig, agentId) with agent-owned skill returns it', () => {
    store.insert(makeSkill({ taskSignature: 'sig-agent', approach: 'ts-coder specific', agentId: 'ts-coder' }));

    const asTsCoder = store.findBySignature('sig-agent', 'ts-coder');
    expect(asTsCoder?.approach).toBe('ts-coder specific');

    // Different agent gets null (no match, no legacy shared either)
    const asWriter = store.findBySignature('sig-agent', 'writer');
    expect(asWriter).toBeNull();
  });

  test('findBySignature(sig, agentId) falls back to legacy shared (agent_id IS NULL)', () => {
    store.insert(makeSkill({ taskSignature: 'sig-legacy', approach: 'legacy shared' }));
    // Any agent can see the legacy row
    const asWriter = store.findBySignature('sig-legacy', 'writer');
    expect(asWriter?.approach).toBe('legacy shared');
  });

  test('findBySignature(sig) without agentId matches any', () => {
    store.insert(makeSkill({ taskSignature: 'sig-2', agentId: 'ts-coder' }));
    const found = store.findBySignature('sig-2');
    expect(found).not.toBeNull();
  });

  test('findActive(agentId) filters to agent + legacy shared', () => {
    store.insert(makeSkill({ taskSignature: 'sig-ts', agentId: 'ts-coder' }));
    store.insert(makeSkill({ taskSignature: 'sig-writer', agentId: 'writer' }));
    store.insert(makeSkill({ taskSignature: 'sig-shared' })); // no agent_id

    const tsCoderActive = store.findActive('ts-coder');
    const sigs = tsCoderActive.map((s) => s.taskSignature).sort();
    expect(sigs).toEqual(['sig-shared', 'sig-ts']);
    expect(sigs).not.toContain('sig-writer');

    const allActive = store.findActive();
    expect(allActive.length).toBe(3);
  });
});
