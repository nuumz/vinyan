/**
 * Auto-generator contract — `skill:outcome` → quarantined skill
 * proposal after N successes for the same (agentId, taskSignature).
 *
 * Verifies:
 *   - threshold not yet hit → no proposal created
 *   - exactly at threshold → proposal landed (pending or quarantined)
 *   - subsequent successes idempotent-merge into the same proposal,
 *     bumping successCount
 *   - failure outcomes do NOT count toward the threshold
 *   - distinct task signatures track independently
 *   - distinct agentIds track independently (shared vs per-agent)
 *   - proposalName survives the slug regex even for messy signatures
 *   - unsubscribe stops further proposal emissions
 */
import { Database } from 'bun:sqlite';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createBus } from '../../src/core/bus.ts';
import { ALL_MIGRATIONS, MigrationRunner } from '../../src/db/migrations/index.ts';
import { SkillProposalStore } from '../../src/db/skill-proposal-store.ts';
import { wireSkillProposalAutogen } from '../../src/skills/proposal-autogen.ts';
import type { CachedSkill } from '../../src/orchestrator/types.ts';

let db: Database;

function skill(overrides: Partial<CachedSkill> = {}): CachedSkill {
  return {
    taskSignature: 'sig:refactor:extract-types',
    approach: 'Read file → Edit type signatures → run tsc',
    successRate: 0.85,
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

beforeAll(() => {
  db = new Database(':memory:');
  db.exec('PRAGMA journal_mode = WAL');
  new MigrationRunner().migrate(db, ALL_MIGRATIONS);
});

afterAll(() => {
  db.close();
});

describe('wireSkillProposalAutogen', () => {
  test('does not fire below threshold', () => {
    const bus = createBus();
    const store = new SkillProposalStore(db);
    const off = wireSkillProposalAutogen({ bus, store, threshold: 3, defaultProfile: 'autogen-a' });
    bus.emit('skill:outcome', { taskId: 't1', skill: skill({ taskSignature: 'sig:a' }), success: true });
    bus.emit('skill:outcome', { taskId: 't2', skill: skill({ taskSignature: 'sig:a' }), success: true });
    off();
    const proposals = store.list('autogen-a');
    expect(proposals.length).toBe(0);
  });

  test('fires at exactly N successes and merges idempotently afterwards', () => {
    const bus = createBus();
    const store = new SkillProposalStore(db);
    const off = wireSkillProposalAutogen({ bus, store, threshold: 3, defaultProfile: 'autogen-b' });
    bus.emit('skill:outcome', { taskId: 't1', skill: skill({ taskSignature: 'sig:b' }), success: true });
    bus.emit('skill:outcome', { taskId: 't2', skill: skill({ taskSignature: 'sig:b' }), success: true });
    bus.emit('skill:outcome', { taskId: 't3', skill: skill({ taskSignature: 'sig:b' }), success: true });
    let proposals = store.list('autogen-b');
    expect(proposals.length).toBe(1);
    expect(proposals[0]?.successCount).toBe(3);
    expect(proposals[0]?.sourceTaskIds).toEqual(['t1', 't2', 't3']);

    // Two more successes — same proposal merges.
    bus.emit('skill:outcome', { taskId: 't4', skill: skill({ taskSignature: 'sig:b' }), success: true });
    bus.emit('skill:outcome', { taskId: 't5', skill: skill({ taskSignature: 'sig:b' }), success: true });
    off();
    proposals = store.list('autogen-b');
    expect(proposals.length).toBe(1);
    expect(proposals[0]?.successCount).toBe(5);
    expect(proposals[0]?.sourceTaskIds.sort()).toEqual(['t1', 't2', 't3', 't4', 't5']);
  });

  test('failure outcomes do not count toward threshold', () => {
    const bus = createBus();
    const store = new SkillProposalStore(db);
    const off = wireSkillProposalAutogen({ bus, store, threshold: 2, defaultProfile: 'autogen-c' });
    bus.emit('skill:outcome', { taskId: 't1', skill: skill({ taskSignature: 'sig:c' }), success: true });
    bus.emit('skill:outcome', { taskId: 't2', skill: skill({ taskSignature: 'sig:c' }), success: false });
    bus.emit('skill:outcome', { taskId: 't3', skill: skill({ taskSignature: 'sig:c' }), success: true });
    off();
    const proposals = store.list('autogen-c');
    expect(proposals.length).toBe(1);
    expect(proposals[0]?.successCount).toBe(2);
  });

  test('distinct task signatures track independently', () => {
    const bus = createBus();
    const store = new SkillProposalStore(db);
    const off = wireSkillProposalAutogen({ bus, store, threshold: 2, defaultProfile: 'autogen-d' });
    bus.emit('skill:outcome', { taskId: 't1', skill: skill({ taskSignature: 'sig:x' }), success: true });
    bus.emit('skill:outcome', { taskId: 't2', skill: skill({ taskSignature: 'sig:y' }), success: true });
    bus.emit('skill:outcome', { taskId: 't3', skill: skill({ taskSignature: 'sig:x' }), success: true });
    bus.emit('skill:outcome', { taskId: 't4', skill: skill({ taskSignature: 'sig:y' }), success: true });
    off();
    const proposals = store.list('autogen-d');
    expect(proposals.length).toBe(2);
    const names = proposals.map((p) => p.proposedName).sort();
    expect(names).toHaveLength(2);
    expect(new Set(names).size).toBe(2);
  });

  test('distinct agent ids track independently (shared vs per-agent)', () => {
    const bus = createBus();
    const store = new SkillProposalStore(db);
    const off = wireSkillProposalAutogen({ bus, store, threshold: 2, defaultProfile: 'autogen-e' });
    bus.emit('skill:outcome', {
      taskId: 't1',
      skill: skill({ taskSignature: 'sig:shared', agentId: 'developer' }),
      success: true,
    });
    bus.emit('skill:outcome', {
      taskId: 't2',
      skill: skill({ taskSignature: 'sig:shared' }), // shared (no agentId)
      success: true,
    });
    bus.emit('skill:outcome', {
      taskId: 't3',
      skill: skill({ taskSignature: 'sig:shared', agentId: 'developer' }),
      success: true,
    });
    bus.emit('skill:outcome', {
      taskId: 't4',
      skill: skill({ taskSignature: 'sig:shared' }),
      success: true,
    });
    off();
    const proposals = store.list('autogen-e');
    // Two distinct keys — `developer:sig:shared` and `shared:sig:shared`.
    expect(proposals.length).toBe(2);
  });

  test('proposed name survives slug regex /^[a-z][a-z0-9-]*$/ for messy signatures', () => {
    const bus = createBus();
    const store = new SkillProposalStore(db);
    const off = wireSkillProposalAutogen({ bus, store, threshold: 1, defaultProfile: 'autogen-f' });
    bus.emit('skill:outcome', {
      taskId: 't1',
      skill: skill({ taskSignature: '999_RANDOM/sig:WITH special.chars!' }),
      success: true,
    });
    off();
    const proposals = store.list('autogen-f');
    expect(proposals.length).toBe(1);
    expect(proposals[0]?.proposedName).toMatch(/^[a-z][a-z0-9-]*$/);
  });

  test('unsubscribe stops further emissions', () => {
    const bus = createBus();
    const store = new SkillProposalStore(db);
    const off = wireSkillProposalAutogen({ bus, store, threshold: 1, defaultProfile: 'autogen-g' });
    bus.emit('skill:outcome', { taskId: 't1', skill: skill({ taskSignature: 'sig:g' }), success: true });
    off();
    bus.emit('skill:outcome', { taskId: 't2', skill: skill({ taskSignature: 'sig:g-2' }), success: true });
    const proposals = store.list('autogen-g');
    // Only the first signature should produce a proposal.
    expect(proposals.length).toBe(1);
  });
});
