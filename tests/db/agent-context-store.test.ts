/**
 * Tests for AgentContextStore — CRUD persistence for agent contexts.
 */
import { Database } from 'bun:sqlite';
import { describe, expect, test, beforeEach } from 'bun:test';
import { AgentContextStore } from '../../src/db/agent-context-store.ts';
import { ALL_MIGRATIONS, MigrationRunner } from '../../src/db/migrations/index.ts';
import { createEmptyContext } from '../../src/orchestrator/agent-context/types.ts';

describe('AgentContextStore', () => {
  let db: Database;
  let store: AgentContextStore;

  beforeEach(() => {
    db = new Database(':memory:');
    const runner = new MigrationRunner();
    runner.migrate(db, ALL_MIGRATIONS);
    store = new AgentContextStore(db);
  });

  test('findById returns null for non-existent agent', () => {
    expect(store.findById('worker-nonexistent')).toBeNull();
  });

  test('findOrCreate returns empty context for new agent', () => {
    const ctx = store.findOrCreate('worker-new');
    expect(ctx.identity.agentId).toBe('worker-new');
    expect(ctx.identity.persona).toBe('');
    expect(ctx.identity.strengths).toEqual([]);
    expect(ctx.memory.episodes).toEqual([]);
    expect(ctx.skills.proficiencies).toEqual({});
  });

  test('upsert inserts new context (machine slice only — narrative lives in soul.md)', () => {
    const ctx = createEmptyContext('worker-1');
    // Narrative fields are set BUT the store intentionally ignores them
    // post-migration-041. SoulStore owns the narrative.
    ctx.identity.persona = 'this will not persist';
    ctx.identity.strengths = ['will not persist'];
    ctx.lastUpdated = 1000;

    store.upsert(ctx);

    const loaded = store.findById('worker-1');
    expect(loaded).not.toBeNull();
    expect(loaded!.identity.agentId).toBe('worker-1');
    // Narrative comes back empty — not persisted by the store.
    expect(loaded!.identity.persona).toBe('');
    expect(loaded!.identity.strengths).toEqual([]);
    expect(loaded!.lastUpdated).toBe(1000);
  });

  test('upsert updates updated_at on re-write', () => {
    const ctx = createEmptyContext('worker-1');
    store.upsert(ctx);

    ctx.lastUpdated = 2000;
    store.upsert(ctx);

    const loaded = store.findById('worker-1');
    expect(loaded!.lastUpdated).toBe(2000);
  });

  test('upsert persists the machine slice: episodes + proficiencies', () => {
    const ctx = createEmptyContext('worker-1');
    ctx.memory.episodes = [
      {
        taskId: 'task-1',
        taskSignature: 'code:refactor:medium',
        outcome: 'success',
        lesson: 'Completed successfully.',
        filesInvolved: ['src/foo.ts'],
        approachUsed: 'extract method',
        timestamp: 1000,
      },
    ];
    ctx.skills.proficiencies = {
      'code:refactor:medium': {
        taskSignature: 'code:refactor:medium',
        level: 'expert',
        successRate: 0.9,
        totalAttempts: 10,
        lastAttempt: 1000,
      },
    };
    // Narrative fields populated but ignored by upsert.
    ctx.memory.lessonsSummary = 'ignored';
    ctx.skills.preferredApproaches = { 'code:refactor:medium': 'ignored' };
    ctx.skills.antiPatterns = ['ignored'];

    store.upsert(ctx);

    const loaded = store.findById('worker-1')!;
    expect(loaded.memory.episodes).toHaveLength(1);
    expect(loaded.memory.episodes[0]!.taskId).toBe('task-1');
    expect(loaded.skills.proficiencies['code:refactor:medium']!.level).toBe('expert');
    // Narrative comes back empty from the DB-only path.
    expect(loaded.memory.lessonsSummary).toBe('');
    expect(loaded.skills.preferredApproaches).toEqual({});
    expect(loaded.skills.antiPatterns).toEqual([]);
  });

  test('findAll returns all contexts', () => {
    store.upsert(createEmptyContext('worker-1'));
    store.upsert(createEmptyContext('worker-2'));
    store.upsert(createEmptyContext('worker-3'));

    const all = store.findAll();
    expect(all).toHaveLength(3);
  });

  test('delete removes context', () => {
    store.upsert(createEmptyContext('worker-1'));
    expect(store.findById('worker-1')).not.toBeNull();

    store.delete('worker-1');
    expect(store.findById('worker-1')).toBeNull();
  });
});
