/**
 * Book-integration Wave 2.3: termination sentinel tests.
 *
 * Covers the rule-based dormant state that kicks in when the sleep cycle
 * runs N times in a row without producing any observable signal.
 */
import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { PATTERN_SCHEMA_SQL } from '../../src/db/pattern-schema.ts';
import { PatternStore } from '../../src/db/pattern-store.ts';
import { TRACE_SCHEMA_SQL } from '../../src/db/trace-schema.ts';
import { TraceStore } from '../../src/db/trace-store.ts';
import type { ExecutionTrace } from '../../src/orchestrator/types.ts';
import { SleepCycleRunner } from '../../src/sleep-cycle/sleep-cycle.ts';

function makeStores() {
  const db = new Database(':memory:');
  db.exec(TRACE_SCHEMA_SQL);
  db.exec(PATTERN_SCHEMA_SQL);
  return { traceStore: new TraceStore(db), patternStore: new PatternStore(db) };
}

function makeTrace(overrides?: Partial<ExecutionTrace>): ExecutionTrace {
  return {
    id: `t-${Math.random().toString(36).slice(2)}`,
    taskId: 'task-1',
    timestamp: Date.now(),
    routingLevel: 1,
    taskTypeSignature: 'something::file.ts',
    approach: 'baseline',
    oracleVerdicts: { type: true },
    modelUsed: 'mock',
    tokensConsumed: 100,
    durationMs: 500,
    outcome: 'success',
    affectedFiles: ['file.ts'],
    ...overrides,
  };
}

// Need ≥5 distinct task_type signatures to clear the data gate plus
// traceCount ≥ minTracesForAnalysis. Spread traces across 5 task types.
function seedGateClearingTraces(traceStore: TraceStore, count: number): void {
  for (let i = 0; i < count; i++) {
    traceStore.insert(
      makeTrace({
        sessionId: `s-${i}`,
        taskTypeSignature: `sig-${i % 5}::file.ts`,
      }),
    );
  }
}

describe('SleepCycleRunner — termination sentinel (Wave 2.3)', () => {
  test('first no-op run does NOT skip by sentinel (below threshold)', async () => {
    const { traceStore, patternStore } = makeStores();
    seedGateClearingTraces(traceStore, 110);

    const runner = new SleepCycleRunner({
      traceStore,
      patternStore,
      // patternMinFrequency=500 ensures the 110 traces never produce a
      // pattern — every cycle is productive=false.
      config: { minTracesForAnalysis: 100, patternMinFrequency: 500, patternMinConfidence: 0.9 },
    });

    const result = await runner.run();
    expect(result.skippedBy).toBeUndefined();
  });

  test('dormant after N consecutive no-op cycles with stable trace count', async () => {
    const { traceStore, patternStore } = makeStores();
    seedGateClearingTraces(traceStore, 110);

    const runner = new SleepCycleRunner({
      traceStore,
      patternStore,
      config: { minTracesForAnalysis: 100, patternMinFrequency: 500, patternMinConfidence: 0.9 },
    });

    // Run enough cycles to trip the sentinel (default max = 5)
    for (let i = 0; i < 5; i++) {
      const r = await runner.run();
      expect(r.skippedBy).toBeUndefined();
    }

    // Sixth run should be short-circuited by the sentinel
    const dormant = await runner.run();
    expect(dormant.skippedBy).toBe('sentinel-dormant');
  });

  test('sentinel wakes up when trace count changes', async () => {
    const { traceStore, patternStore } = makeStores();
    seedGateClearingTraces(traceStore, 110);

    const runner = new SleepCycleRunner({
      traceStore,
      patternStore,
      config: { minTracesForAnalysis: 100, patternMinFrequency: 500, patternMinConfidence: 0.9 },
    });

    // Trip the sentinel
    for (let i = 0; i < 5; i++) await runner.run();
    const dormant = await runner.run();
    expect(dormant.skippedBy).toBe('sentinel-dormant');

    // Feed new evidence → trace count changes → next run must NOT be
    // short-circuited by the sentinel.
    for (let i = 0; i < 20; i++) {
      traceStore.insert(makeTrace({ sessionId: `s-new-${i}`, taskTypeSignature: `sig-${i % 5}::file.ts` }));
    }
    const awake = await runner.run();
    expect(awake.skippedBy).toBeUndefined();
  });

  test('data-gate skip is reported separately from sentinel-dormant', async () => {
    const { traceStore, patternStore } = makeStores();
    // Fewer traces than the gate → data-gate skip
    const runner = new SleepCycleRunner({ traceStore, patternStore });
    const result = await runner.run();
    expect(result.skippedBy).toBe('data-gate');
  });

  // ── Wave 5.4: sentinel constructor option ────────────────────────
  test('Wave 5.4: custom sentinelMaxNoopCycles trips sentinel faster', async () => {
    const { traceStore, patternStore } = makeStores();
    seedGateClearingTraces(traceStore, 110);

    const runner = new SleepCycleRunner({
      traceStore,
      patternStore,
      config: { minTracesForAnalysis: 100, patternMinFrequency: 500, patternMinConfidence: 0.9 },
      sentinelMaxNoopCycles: 2,
    });

    // With max=2, two consecutive no-op cycles is enough to trip the sentinel
    for (let i = 0; i < 2; i++) {
      const r = await runner.run();
      expect(r.skippedBy).toBeUndefined();
    }

    // Third run should be dormant
    const dormant = await runner.run();
    expect(dormant.skippedBy).toBe('sentinel-dormant');
  });

  test('Wave 5.4: default sentinelMaxNoopCycles still honors the 5-cycle contract', async () => {
    const { traceStore, patternStore } = makeStores();
    seedGateClearingTraces(traceStore, 110);

    // No sentinelMaxNoopCycles passed → default (5)
    const runner = new SleepCycleRunner({
      traceStore,
      patternStore,
      config: { minTracesForAnalysis: 100, patternMinFrequency: 500, patternMinConfidence: 0.9 },
    });

    // Two no-op cycles should NOT trip the default sentinel
    for (let i = 0; i < 2; i++) {
      const r = await runner.run();
      expect(r.skippedBy).toBeUndefined();
    }
    const third = await runner.run();
    expect(third.skippedBy).toBeUndefined();
  });
});
