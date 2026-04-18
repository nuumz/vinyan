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

  test('upsert inserts new context', () => {
    const ctx = createEmptyContext('worker-1');
    ctx.identity.persona = 'reliable TypeScript specialist';
    ctx.identity.strengths = ['refactoring', 'test-gen'];
    ctx.identity.weaknesses = ['python'];
    ctx.identity.approachStyle = 'reads thoroughly before editing';
    ctx.lastUpdated = 1000;

    store.upsert(ctx);

    const loaded = store.findById('worker-1');
    expect(loaded).not.toBeNull();
    expect(loaded!.identity.persona).toBe('reliable TypeScript specialist');
    expect(loaded!.identity.strengths).toEqual(['refactoring', 'test-gen']);
    expect(loaded!.identity.weaknesses).toEqual(['python']);
    expect(loaded!.identity.approachStyle).toBe('reads thoroughly before editing');
    expect(loaded!.lastUpdated).toBe(1000);
  });

  test('upsert updates existing context', () => {
    const ctx = createEmptyContext('worker-1');
    ctx.identity.persona = 'original';
    store.upsert(ctx);

    ctx.identity.persona = 'updated persona';
    ctx.lastUpdated = 2000;
    store.upsert(ctx);

    const loaded = store.findById('worker-1');
    expect(loaded!.identity.persona).toBe('updated persona');
    expect(loaded!.lastUpdated).toBe(2000);
  });

  test('upsert persists episodes and skills', () => {
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
    ctx.memory.lessonsSummary = 'Strong at refactoring.';
    ctx.skills.proficiencies = {
      'code:refactor:medium': {
        taskSignature: 'code:refactor:medium',
        level: 'expert',
        successRate: 0.9,
        totalAttempts: 10,
        lastAttempt: 1000,
      },
    };
    ctx.skills.preferredApproaches = { 'code:refactor:medium': 'extract method' };
    ctx.skills.antiPatterns = ['never inline without tests'];

    store.upsert(ctx);

    const loaded = store.findById('worker-1')!;
    expect(loaded.memory.episodes).toHaveLength(1);
    expect(loaded.memory.episodes[0]!.taskId).toBe('task-1');
    expect(loaded.memory.lessonsSummary).toBe('Strong at refactoring.');
    expect(loaded.skills.proficiencies['code:refactor:medium']!.level).toBe('expert');
    expect(loaded.skills.preferredApproaches['code:refactor:medium']).toBe('extract method');
    expect(loaded.skills.antiPatterns).toEqual(['never inline without tests']);
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
