/**
 * Tests for AgentEvolution — sleep cycle agent identity refinement.
 */
import { Database } from 'bun:sqlite';
import { describe, expect, test, beforeEach } from 'bun:test';
import { AgentContextStore } from '../../../src/db/agent-context-store.ts';
import { ALL_MIGRATIONS, MigrationRunner } from '../../../src/db/migrations/index.ts';
import { AgentEvolution } from '../../../src/orchestrator/agent-context/agent-evolution.ts';
import { createEmptyContext } from '../../../src/orchestrator/agent-context/types.ts';

describe('AgentEvolution', () => {
  let db: Database;
  let store: AgentContextStore;
  let evolution: AgentEvolution;

  beforeEach(() => {
    db = new Database(':memory:');
    const runner = new MigrationRunner();
    runner.migrate(db, ALL_MIGRATIONS);
    store = new AgentContextStore(db);
    evolution = new AgentEvolution({ agentContextStore: store });
  });

  test('evolveAll with no agents returns zero', async () => {
    const result = await evolution.evolveAll();
    expect(result.agentsEvolved).toBe(0);
  });

  test('evolveAll compacts lessons from episodes (narrative → soul.md post-migration-041)', async () => {
    const ctx = createEmptyContext('worker-1');
    for (let i = 0; i < 10; i++) {
      ctx.memory.episodes.push({
        taskId: `task-${i}`,
        taskSignature: 'code:refactor:medium',
        outcome: i % 3 === 0 ? 'failed' : 'success',
        lesson: i % 3 === 0 ? `Failed: timeout on attempt ${i}` : 'Completed successfully.',
        filesInvolved: [`src/file-${i}.ts`],
        approachUsed: 'extract-method',
        timestamp: 1000 + i,
      });
    }
    store.upsert(ctx);

    const result = await evolution.evolveAll();
    // Evolution still runs and counts agents; narrative `lessonsSummary`
    // no longer persists in DB (soul.md is home), so we assert the run
    // signal rather than the deprecated DB field.
    expect(result.agentsEvolved).toBeGreaterThanOrEqual(1);
  });

  test('evolveAll graduates skills based on proficiency data', async () => {
    const ctx = createEmptyContext('worker-1');
    ctx.skills.proficiencies['code:refactor:medium'] = {
      taskSignature: 'code:refactor:medium',
      level: 'novice',
      successRate: 0.9,
      totalAttempts: 10,
      lastAttempt: Date.now(),
    };
    store.upsert(ctx);

    const result = await evolution.evolveAll();

    const evolved = store.findById('worker-1')!;
    expect(evolved.skills.proficiencies['code:refactor:medium']!.level).toBe('expert');
    expect(result.skillsGraduated).toBeGreaterThanOrEqual(1);
  });

  test('evolveAll runs persona refinement (narrative now lands in soul.md)', async () => {
    const ctx = createEmptyContext('worker-1');
    ctx.skills.proficiencies['code:refactor:medium'] = {
      taskSignature: 'code:refactor:medium',
      level: 'expert',
      successRate: 0.95,
      totalAttempts: 20,
      lastAttempt: Date.now(),
    };
    store.upsert(ctx);

    const result = await evolution.evolveAll();
    // Persona is a narrative field — DB no longer holds it post-migration-041.
    // The reflector / soul-store path owns it; here we just assert the
    // evolution job saw the agent.
    expect(result.agentsEvolved).toBeGreaterThanOrEqual(1);
  });

  test('evolveAll handles multiple agents', async () => {
    for (let i = 0; i < 3; i++) {
      const ctx = createEmptyContext(`worker-${i}`);
      ctx.skills.proficiencies['code:test:small'] = {
        taskSignature: 'code:test:small',
        level: 'novice',
        successRate: 0.8,
        totalAttempts: 5,
        lastAttempt: Date.now(),
      };
      store.upsert(ctx);
    }

    const result = await evolution.evolveAll();
    expect(result.agentsEvolved).toBe(3);
    expect(result.skillsGraduated).toBe(3);
  });
});
