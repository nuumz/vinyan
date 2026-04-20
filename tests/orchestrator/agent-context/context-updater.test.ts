/**
 * Tests for AgentContextUpdater — post-task learning for agent context.
 */
import { Database } from 'bun:sqlite';
import { describe, expect, test, beforeEach } from 'bun:test';
import { AgentContextStore } from '../../../src/db/agent-context-store.ts';
import { ALL_MIGRATIONS, MigrationRunner } from '../../../src/db/migrations/index.ts';
import { AgentContextUpdater } from '../../../src/orchestrator/agent-context/context-updater.ts';
import { createEmptyContext, MAX_EPISODES } from '../../../src/orchestrator/agent-context/types.ts';
import type { ExecutionTrace } from '../../../src/orchestrator/types.ts';

function makeTrace(overrides: Partial<ExecutionTrace> = {}): ExecutionTrace {
  return {
    id: 'trace-1',
    taskId: 'task-1',
    workerId: 'worker-1',
    timestamp: Date.now(),
    routingLevel: 1 as ExecutionTrace['routingLevel'],
    approach: 'read-then-edit',
    taskTypeSignature: 'code:refactor:medium',
    oracleVerdicts: { type: true, lint: true },
    modelUsed: 'claude-sonnet',
    tokensConsumed: 500,
    durationMs: 3000,
    outcome: 'success',
    affectedFiles: ['src/foo.ts'],
    ...overrides,
  };
}

describe('AgentContextUpdater', () => {
  let db: Database;
  let store: AgentContextStore;
  let updater: AgentContextUpdater;

  beforeEach(() => {
    db = new Database(':memory:');
    const runner = new MigrationRunner();
    runner.migrate(db, ALL_MIGRATIONS);
    store = new AgentContextStore(db);
    updater = new AgentContextUpdater({ agentContextStore: store });
  });

  test('creates context for new agent on first task', () => {
    updater.updateAfterTask('worker-1', makeTrace());

    const ctx = store.findById('worker-1');
    expect(ctx).not.toBeNull();
    expect(ctx!.memory.episodes).toHaveLength(1);
    expect(ctx!.memory.episodes[0]!.outcome).toBe('success');
  });

  test('accumulates episodes across tasks', () => {
    updater.updateAfterTask('worker-1', makeTrace({ taskId: 'task-1' }));
    updater.updateAfterTask('worker-1', makeTrace({ taskId: 'task-2' }));
    updater.updateAfterTask('worker-1', makeTrace({ taskId: 'task-3' }));

    const ctx = store.findById('worker-1')!;
    expect(ctx.memory.episodes).toHaveLength(3);
    // Most recent first
    expect(ctx.memory.episodes[0]!.taskId).toBe('task-3');
  });

  test('bounds episodes to MAX_EPISODES', () => {
    for (let i = 0; i < MAX_EPISODES + 5; i++) {
      updater.updateAfterTask('worker-1', makeTrace({ taskId: `task-${i}` }));
    }

    const ctx = store.findById('worker-1')!;
    expect(ctx.memory.episodes.length).toBeLessThanOrEqual(MAX_EPISODES);
  });

  // NOTE post-migration-041: preferredApproaches / antiPatterns no longer
  // persist through AgentContextStore — soul.md is the authoritative home.
  // These tests assert the DB-level machine slice; narrative updates flow
  // via the soul-reflector path (covered in soul-reflector.test.ts).

  test('persists episode + proficiency on success (machine slice)', () => {
    updater.updateAfterTask('worker-1', makeTrace({
      outcome: 'success',
      approach: 'extract-method',
      taskTypeSignature: 'code:refactor:medium',
    }));

    const ctx = store.findById('worker-1')!;
    expect(ctx.memory.episodes.length).toBeGreaterThan(0);
    expect(ctx.skills.proficiencies['code:refactor:medium']).toBeDefined();
  });

  test('persists episode on failure (machine slice)', () => {
    updater.updateAfterTask('worker-1', makeTrace({
      outcome: 'failure',
      approach: 'inline-everything',
      failureReason: 'type oracle failed: missing import',
    }));

    const ctx = store.findById('worker-1')!;
    expect(ctx.memory.episodes.length).toBeGreaterThan(0);
    expect(ctx.memory.episodes[0]!.outcome).toBe('failed');
  });

  test('updates skill proficiency from trace outcomes', () => {
    // 5 successes → should reach competent or expert
    for (let i = 0; i < 5; i++) {
      updater.updateAfterTask('worker-1', makeTrace({
        taskId: `task-${i}`,
        outcome: 'success',
        taskTypeSignature: 'code:refactor:medium',
      }));
    }

    const ctx = store.findById('worker-1')!;
    const prof = ctx.skills.proficiencies['code:refactor:medium']!;
    expect(prof).toBeDefined();
    expect(prof.totalAttempts).toBe(5);
    expect(prof.successRate).toBe(1.0);
    expect(prof.level).toBe('expert');
  });

  test('never throws (best-effort)', () => {
    // Even with a closed DB, updateAfterTask should not throw
    db.close();
    expect(() => {
      updater.updateAfterTask('worker-1', makeTrace());
    }).not.toThrow();
  });
});
