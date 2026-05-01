/**
 * M4.5 — End-to-end integration test for sleep-cycle commonsense promotion.
 *
 * Verifies that when a CommonSenseRegistry is wired into SleepCycleRunner:
 *   - mined patterns get promoted to commonsense rules
 *   - promotion count surfaces in SleepCycleResult.commonsensePromoted
 *   - promotion count contributes to the termination sentinel's "productive" check
 *
 * When NO registry is wired:
 *   - commonsensePromoted is always 0 (M4.5 hookup is opt-in)
 */
import { Database } from 'bun:sqlite';
import { migration001 } from '../../src/db/migrations/001_initial_schema.ts';
import { beforeEach, describe, expect, test } from 'bun:test';
import { PATTERN_SCHEMA_SQL } from '../../src/db/pattern-schema.ts';
import { PatternStore } from '../../src/db/pattern-store.ts';
import { TRACE_SCHEMA_SQL } from '../../src/db/trace-schema.ts';
import { TraceStore } from '../../src/db/trace-store.ts';
import { CommonSenseRegistry } from '../../src/oracle/commonsense/registry.ts';
import { SleepCycleRunner } from '../../src/sleep-cycle/sleep-cycle.ts';
import type { ExecutionTrace } from '../../src/orchestrator/types.ts';

function makeStores() {
  const db = new Database(':memory:');
  db.exec(TRACE_SCHEMA_SQL);
  db.exec(PATTERN_SCHEMA_SQL);
  db.exec(`CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY, description TEXT NOT NULL, applied_at INTEGER NOT NULL);`);
  migration001.up(db);
  return {
    db,
    traceStore: new TraceStore(db),
    patternStore: new PatternStore(db),
    commonsenseRegistry: new CommonSenseRegistry(db),
  };
}

function makeTrace(overrides: Partial<ExecutionTrace>): ExecutionTrace {
  return {
    id: `t-${Math.random().toString(36).slice(2, 8)}`,
    taskId: `task-${Math.random().toString(36).slice(2, 6)}`,
    timestamp: Date.now() + Math.random(),
    routingLevel: 1,
    taskTypeSignature: 'delete::ts::large-blast',
    approach: 'rm -rf tests/',
    oracleVerdicts: { ast: false },
    modelUsed: 'mock',
    tokensConsumed: 100,
    durationMs: 500,
    outcome: 'failure',
    affectedFiles: ['tests/foo.ts'],
    ...overrides,
  };
}

function insertFailingTraces(
  traceStore: TraceStore,
  count: number,
  approach: string,
  taskTypeSignature: string,
): void {
  for (let i = 0; i < count; i++) {
    traceStore.insert(
      makeTrace({
        id: `t-${approach}-${i}-${Math.random().toString(36).slice(2, 6)}`,
        sessionId: `s-${i % 5}`,
        timestamp: 1000 + i,
        approach,
        taskTypeSignature,
        outcome: 'failure',
      }),
    );
  }
}

let env: ReturnType<typeof makeStores>;

beforeEach(() => {
  env = makeStores();
});

describe('SleepCycleRunner — M4.5 commonsense integration', () => {
  test('does NOT promote when no commonsenseRegistry is wired', async () => {
    insertFailingTraces(env.traceStore, 80, 'rm -rf tests/', 'delete::ts::large-blast');
    insertFailingTraces(env.traceStore, 20, 'safe-edit', 'delete::ts::large-blast');
    // distinct signatures for sleep-cycle data gate
    for (let i = 0; i < 6; i++) {
      env.traceStore.insert(
        makeTrace({
          taskTypeSignature: `noop-${i}::md::single`,
          outcome: 'success',
          approach: 'noop',
        }),
      );
    }

    const runner = new SleepCycleRunner({
      traceStore: env.traceStore,
      patternStore: env.patternStore,
      config: { minTracesForAnalysis: 100, patternMinFrequency: 5 },
      // commonsenseRegistry intentionally omitted
    });

    const result = await runner.run();
    expect(result.commonsensePromoted).toBe(0);
    // Registry stays empty
    expect(env.commonsenseRegistry.count()).toBe(0);
  });

  test('promotes anti-patterns when registry is wired', async () => {
    insertFailingTraces(env.traceStore, 80, 'rm -rf tests/', 'delete::ts::large-blast');
    insertFailingTraces(env.traceStore, 20, 'safe-edit', 'delete::ts::large-blast');
    for (let i = 0; i < 6; i++) {
      env.traceStore.insert(
        makeTrace({
          taskTypeSignature: `noop-${i}::md::single`,
          outcome: 'success',
          approach: 'noop',
        }),
      );
    }

    const runner = new SleepCycleRunner({
      traceStore: env.traceStore,
      patternStore: env.patternStore,
      commonsenseRegistry: env.commonsenseRegistry,
      config: { minTracesForAnalysis: 100, patternMinFrequency: 5 },
    });

    const result = await runner.run();
    // Verify the cycle found anti-patterns first (sanity check)
    expect(result.antiPatterns).toBeGreaterThan(0);
    // M4.5: at least one was promoted to a commonsense rule
    expect(result.commonsensePromoted).toBeGreaterThan(0);
    // Registry now contains the promoted rule
    expect(env.commonsenseRegistry.count()).toBeGreaterThan(0);
    // Promoted rules carry the right source tag
    expect(env.commonsenseRegistry.countBySource('promoted-from-pattern')).toBeGreaterThan(0);
  });

  test('setCommonsenseRegistry post-construction wiring also works', async () => {
    insertFailingTraces(env.traceStore, 80, 'rm -rf tests/', 'delete::ts::large-blast');
    insertFailingTraces(env.traceStore, 20, 'safe-edit', 'delete::ts::large-blast');
    for (let i = 0; i < 6; i++) {
      env.traceStore.insert(
        makeTrace({
          taskTypeSignature: `noop-${i}::md::single`,
          outcome: 'success',
          approach: 'noop',
        }),
      );
    }

    const runner = new SleepCycleRunner({
      traceStore: env.traceStore,
      patternStore: env.patternStore,
      config: { minTracesForAnalysis: 100, patternMinFrequency: 5 },
    });
    runner.setCommonsenseRegistry(env.commonsenseRegistry);

    const result = await runner.run();
    expect(result.commonsensePromoted).toBeGreaterThan(0);
  });

  test('SleepCycleResult.commonsensePromoted is always 0 on data-gate skip', async () => {
    // Only 10 traces — below default 100 minimum
    insertFailingTraces(env.traceStore, 10, 'rm -rf', 'delete::ts::large-blast');

    const runner = new SleepCycleRunner({
      traceStore: env.traceStore,
      patternStore: env.patternStore,
      commonsenseRegistry: env.commonsenseRegistry,
    });

    const result = await runner.run();
    expect(result.skippedBy).toBe('data-gate');
    expect(result.commonsensePromoted).toBe(0);
  });
});
