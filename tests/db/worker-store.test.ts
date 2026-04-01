import { Database } from 'bun:sqlite';
import { beforeEach, describe, expect, test } from 'bun:test';
import { TRACE_SCHEMA_SQL } from '../../src/db/trace-schema.ts';
import { WORKER_SCHEMA_SQL } from '../../src/db/worker-schema.ts';
import { WorkerStore } from '../../src/db/worker-store.ts';
import type { WorkerProfile } from '../../src/orchestrator/types.ts';

function createDb(): Database {
  const db = new Database(':memory:');
  db.exec(WORKER_SCHEMA_SQL);
  db.exec(TRACE_SCHEMA_SQL);
  return db;
}

function makeProfile(overrides?: Partial<WorkerProfile>): WorkerProfile {
  return {
    id: 'worker-claude-sonnet-07-default',
    config: {
      modelId: 'claude-sonnet',
      temperature: 0.7,
      systemPromptTemplate: 'default',
    },
    status: 'probation',
    createdAt: Date.now(),
    demotionCount: 0,
    ...overrides,
  };
}

function insertTrace(
  db: Database,
  workerId: string,
  opts?: {
    outcome?: string;
    qualityComposite?: number;
    taskTypeSig?: string;
    tokensConsumed?: number;
    durationMs?: number;
  },
) {
  const id = `trace-${Math.random().toString(36).slice(2, 8)}`;
  db.run(
    `INSERT INTO execution_traces (
      id, task_id, timestamp, routing_level, approach, model_used,
      tokens_consumed, duration_ms, outcome, oracle_verdicts, affected_files,
      worker_id, quality_composite, task_type_signature
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      `task-${id}`,
      Date.now(),
      1,
      'test approach',
      'claude-sonnet',
      opts?.tokensConsumed ?? 1000,
      opts?.durationMs ?? 5000,
      opts?.outcome ?? 'success',
      '{}',
      '[]',
      workerId,
      opts?.qualityComposite ?? 0.8,
      opts?.taskTypeSig ?? 'refactor::.ts',
    ],
  );
}

describe('WorkerStore', () => {
  let db: Database;
  let store: WorkerStore;

  beforeEach(() => {
    db = createDb();
    store = new WorkerStore(db);
  });

  describe('CRUD', () => {
    test('insert and findById', () => {
      const profile = makeProfile();
      store.insert(profile);
      const found = store.findById(profile.id);
      expect(found).not.toBeNull();
      expect(found!.id).toBe(profile.id);
      expect(found!.config.modelId).toBe('claude-sonnet');
      expect(found!.config.temperature).toBe(0.7);
      expect(found!.status).toBe('probation');
      expect(found!.demotionCount).toBe(0);
    });

    test('insert ignores duplicate', () => {
      const profile = makeProfile();
      store.insert(profile);
      store.insert(makeProfile({ status: 'active' }));
      const found = store.findById(profile.id);
      expect(found!.status).toBe('probation'); // original preserved
    });

    test('findById returns null for unknown', () => {
      expect(store.findById('nonexistent')).toBeNull();
    });

    test('findByStatus returns matching profiles', () => {
      store.insert(makeProfile({ id: 'w1', status: 'probation' }));
      store.insert(makeProfile({ id: 'w2', status: 'active' }));
      store.insert(makeProfile({ id: 'w3', status: 'active' }));
      expect(store.findByStatus('active')).toHaveLength(2);
      expect(store.findByStatus('probation')).toHaveLength(1);
      expect(store.findByStatus('demoted')).toHaveLength(0);
    });

    test('findActive returns only active profiles', () => {
      store.insert(makeProfile({ id: 'w1', status: 'active' }));
      store.insert(makeProfile({ id: 'w2', status: 'probation' }));
      store.insert(makeProfile({ id: 'w3', status: 'demoted' }));
      expect(store.findActive()).toHaveLength(1);
      expect(store.findActive()[0]!.id).toBe('w1');
    });

    test('findAll returns all profiles', () => {
      store.insert(makeProfile({ id: 'w1' }));
      store.insert(makeProfile({ id: 'w2' }));
      store.insert(makeProfile({ id: 'w3' }));
      expect(store.findAll()).toHaveLength(3);
    });

    test('findByModelId filters by model', () => {
      store.insert(makeProfile({ id: 'w1', config: { modelId: 'claude-sonnet', temperature: 0.7 } }));
      store.insert(makeProfile({ id: 'w2', config: { modelId: 'claude-opus', temperature: 0.3 } }));
      expect(store.findByModelId('claude-sonnet')).toHaveLength(1);
      expect(store.findByModelId('claude-opus')).toHaveLength(1);
      expect(store.findByModelId('gpt-4')).toHaveLength(0);
    });

    test('count and countByStatus', () => {
      store.insert(makeProfile({ id: 'w1', status: 'active' }));
      store.insert(makeProfile({ id: 'w2', status: 'active' }));
      store.insert(makeProfile({ id: 'w3', status: 'probation' }));
      expect(store.count()).toBe(3);
      expect(store.countActive()).toBe(2);
      expect(store.countByStatus('probation')).toBe(1);
    });
  });

  describe('status transitions', () => {
    test('promote to active sets promoted_at', () => {
      store.insert(makeProfile({ id: 'w1', status: 'probation' }));
      store.updateStatus('w1', 'active');
      const found = store.findById('w1')!;
      expect(found.status).toBe('active');
      expect(found.promotedAt).toBeDefined();
    });

    test('demote increments demotion_count and sets reason', () => {
      store.insert(makeProfile({ id: 'w1', status: 'active' }));
      store.updateStatus('w1', 'demoted', 'quality drop');
      const found = store.findById('w1')!;
      expect(found.status).toBe('demoted');
      expect(found.demotionCount).toBe(1);
      expect(found.demotionReason).toBe('quality drop');
      expect(found.demotedAt).toBeDefined();
    });

    test('multiple demotions accumulate count', () => {
      store.insert(makeProfile({ id: 'w1', status: 'active' }));
      store.updateStatus('w1', 'demoted', 'first');
      store.reEnroll('w1');
      store.updateStatus('w1', 'active');
      store.updateStatus('w1', 'demoted', 'second');
      const found = store.findById('w1')!;
      expect(found.demotionCount).toBe(2);
    });

    test('retire sets permanent status', () => {
      store.insert(makeProfile({ id: 'w1', status: 'active' }));
      store.updateStatus('w1', 'retired', '3 demotions reached');
      const found = store.findById('w1')!;
      expect(found.status).toBe('retired');
      expect(found.demotionReason).toBe('3 demotions reached');
    });

    test('reEnroll resets to probation', () => {
      store.insert(makeProfile({ id: 'w1', status: 'active' }));
      store.updateStatus('w1', 'demoted', 'quality drop');
      store.reEnroll('w1');
      const found = store.findById('w1')!;
      expect(found.status).toBe('probation');
      expect(found.promotedAt).toBeUndefined();
      expect(found.demotedAt).toBeUndefined();
      expect(found.demotionReason).toBeUndefined();
      // demotion_count preserved
      expect(found.demotionCount).toBe(1);
    });
  });

  describe('stats computation from traces', () => {
    test('returns zero stats for worker with no traces', () => {
      store.insert(makeProfile({ id: 'w1' }));
      const stats = store.getStats('w1');
      expect(stats.totalTasks).toBe(0);
      expect(stats.successRate).toBe(0);
      expect(stats.avgQualityScore).toBe(0);
      expect(stats.lastActiveAt).toBe(0);
    });

    test('computes stats from execution_traces', () => {
      store.insert(makeProfile({ id: 'w1' }));
      insertTrace(db, 'w1', { outcome: 'success', qualityComposite: 0.9, tokensConsumed: 1000, durationMs: 5000 });
      insertTrace(db, 'w1', { outcome: 'success', qualityComposite: 0.7, tokensConsumed: 2000, durationMs: 3000 });
      insertTrace(db, 'w1', { outcome: 'failure', qualityComposite: 0.3, tokensConsumed: 500, durationMs: 1000 });

      store.invalidateCache('w1'); // force fresh computation
      const stats = store.getStats('w1');
      expect(stats.totalTasks).toBe(3);
      expect(stats.successRate).toBeCloseTo(2 / 3, 2);
      expect(stats.avgQualityScore).toBeCloseTo((0.9 + 0.7 + 0.3) / 3, 2);
      expect(stats.avgTokenCost).toBeCloseTo((1000 + 2000 + 500) / 3, 0);
      expect(stats.avgDurationMs).toBeCloseTo((5000 + 3000 + 1000) / 3, 0);
      expect(stats.lastActiveAt).toBeGreaterThan(0);
    });

    test('computes task type breakdown', () => {
      store.insert(makeProfile({ id: 'w1' }));
      insertTrace(db, 'w1', { taskTypeSig: 'refactor::.ts', outcome: 'success', qualityComposite: 0.8 });
      insertTrace(db, 'w1', { taskTypeSig: 'refactor::.ts', outcome: 'success', qualityComposite: 0.9 });
      insertTrace(db, 'w1', { taskTypeSig: 'fix::.ts', outcome: 'failure', qualityComposite: 0.3 });

      store.invalidateCache('w1');
      const stats = store.getStats('w1');
      expect(Object.keys(stats.taskTypeBreakdown)).toHaveLength(2);
      expect(stats.taskTypeBreakdown['refactor::.ts']!.count).toBe(2);
      expect(stats.taskTypeBreakdown['refactor::.ts']!.successRate).toBe(1.0);
      expect(stats.taskTypeBreakdown['fix::.ts']!.count).toBe(1);
      expect(stats.taskTypeBreakdown['fix::.ts']!.successRate).toBe(0);
    });

    test('stats are cached for 60s', () => {
      store.insert(makeProfile({ id: 'w1' }));
      insertTrace(db, 'w1', { outcome: 'success', qualityComposite: 0.8 });

      const stats1 = store.getStats('w1');
      expect(stats1.totalTasks).toBe(1);

      // Add another trace — cached result should be returned
      insertTrace(db, 'w1', { outcome: 'success', qualityComposite: 0.9 });
      const stats2 = store.getStats('w1');
      expect(stats2.totalTasks).toBe(1); // still cached

      // Invalidate and re-fetch
      store.invalidateCache('w1');
      const stats3 = store.getStats('w1');
      expect(stats3.totalTasks).toBe(2);
    });

    test('stats are isolated per worker', () => {
      store.insert(makeProfile({ id: 'w1' }));
      store.insert(makeProfile({ id: 'w2' }));
      insertTrace(db, 'w1', { outcome: 'success' });
      insertTrace(db, 'w1', { outcome: 'success' });
      insertTrace(db, 'w2', { outcome: 'failure' });

      const s1 = store.getStats('w1');
      const s2 = store.getStats('w2');
      expect(s1.totalTasks).toBe(2);
      expect(s1.successRate).toBe(1.0);
      expect(s2.totalTasks).toBe(1);
      expect(s2.successRate).toBe(0);
    });
  });

  describe('countDistinctWorkerIds', () => {
    test('counts distinct worker_ids in traces', () => {
      insertTrace(db, 'w1');
      insertTrace(db, 'w1');
      insertTrace(db, 'w2');
      insertTrace(db, 'w3');
      expect(store.countDistinctWorkerIds()).toBe(3);
    });

    test('returns 0 with no traces', () => {
      expect(store.countDistinctWorkerIds()).toBe(0);
    });
  });

  describe('getStatsSince', () => {
    test('returns stats only from traces after timestamp', () => {
      store.insert(makeProfile({ id: 'w1' }));
      const cutoff = Date.now();
      // Insert old trace (before cutoff)
      db.run(
        `INSERT INTO execution_traces (id, task_id, timestamp, routing_level, approach, model_used, tokens_consumed, duration_ms, outcome, oracle_verdicts, affected_files, worker_id, quality_composite)
         VALUES (?, ?, ?, 1, 'test', 'model', 1000, 5000, 'failure', '{}', '[]', ?, 0.3)`,
        ['trace-old', 'task-old', cutoff - 10000, 'w1'],
      );
      // Insert new traces (after cutoff)
      db.run(
        `INSERT INTO execution_traces (id, task_id, timestamp, routing_level, approach, model_used, tokens_consumed, duration_ms, outcome, oracle_verdicts, affected_files, worker_id, quality_composite)
         VALUES (?, ?, ?, 1, 'test', 'model', 1000, 5000, 'success', '{}', '[]', ?, 0.9)`,
        ['trace-new-1', 'task-new-1', cutoff + 1000, 'w1'],
      );
      db.run(
        `INSERT INTO execution_traces (id, task_id, timestamp, routing_level, approach, model_used, tokens_consumed, duration_ms, outcome, oracle_verdicts, affected_files, worker_id, quality_composite)
         VALUES (?, ?, ?, 1, 'test', 'model', 1000, 5000, 'success', '{}', '[]', ?, 0.8)`,
        ['trace-new-2', 'task-new-2', cutoff + 2000, 'w1'],
      );

      const stats = store.getStatsSince('w1', cutoff);
      expect(stats.totalTasks).toBe(2); // only new traces
      expect(stats.successRate).toBe(1.0);
      expect(stats.avgQualityScore).toBeCloseTo(0.85, 2);
    });

    test('returns zero stats when no traces after timestamp', () => {
      store.insert(makeProfile({ id: 'w1' }));
      insertTrace(db, 'w1', { outcome: 'success' });
      const futureTimestamp = Date.now() + 100000;
      const stats = store.getStatsSince('w1', futureTimestamp);
      expect(stats.totalTasks).toBe(0);
      expect(stats.successRate).toBe(0);
    });
  });

  describe('config serialization', () => {
    test('preserves toolAllowlist', () => {
      store.insert(
        makeProfile({
          id: 'w1',
          config: {
            modelId: 'claude-sonnet',
            temperature: 0.5,
            toolAllowlist: ['file_read', 'file_write'],
          },
        }),
      );
      const found = store.findById('w1')!;
      expect(found.config.toolAllowlist).toEqual(['file_read', 'file_write']);
    });

    test('handles null toolAllowlist', () => {
      store.insert(makeProfile({ id: 'w1' }));
      const found = store.findById('w1')!;
      expect(found.config.toolAllowlist).toBeUndefined();
    });

    test('preserves maxContextTokens', () => {
      store.insert(
        makeProfile({
          id: 'w1',
          config: {
            modelId: 'claude-opus',
            temperature: 0.3,
            maxContextTokens: 200_000,
          },
        }),
      );
      const found = store.findById('w1')!;
      expect(found.config.maxContextTokens).toBe(200_000);
    });
  });
});
