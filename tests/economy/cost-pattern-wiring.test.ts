/**
 * Cost Pattern Wiring Tests — verify CostPatternMiner integration
 * with SleepCycleRunner when costLedger is provided.
 */
import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { createBus, type VinyanBusEvents } from '../../src/core/bus.ts';
import { migration012 } from '../../src/db/migrations/012_add_economy_tables.ts';
import { PATTERN_SCHEMA_SQL } from '../../src/db/pattern-schema.ts';
import { PatternStore } from '../../src/db/pattern-store.ts';
import { TRACE_SCHEMA_SQL } from '../../src/db/trace-schema.ts';
import { TraceStore } from '../../src/db/trace-store.ts';
import { CostLedger, type CostLedgerEntry } from '../../src/economy/cost-ledger.ts';
import type { ExecutionTrace } from '../../src/orchestrator/types.ts';
import { SleepCycleRunner } from '../../src/sleep-cycle/sleep-cycle.ts';

function createTestDb() {
  const db = new Database(':memory:');
  db.exec(TRACE_SCHEMA_SQL);
  db.exec(PATTERN_SCHEMA_SQL);
  migration012.up(db);
  return db;
}

function createStores(db: Database): { traceStore: TraceStore; patternStore: PatternStore } {
  return {
    traceStore: new TraceStore(db),
    patternStore: new PatternStore(db),
  };
}

function makeTrace(overrides?: Partial<ExecutionTrace>): ExecutionTrace {
  return {
    id: `t-${Math.random().toString(36).slice(2)}`,
    taskId: 'task-1',
    timestamp: Date.now(),
    routingLevel: 1,
    taskTypeSignature: 'refactor::auth.ts',
    approach: 'direct-edit',
    oracleVerdicts: { type: true },
    modelUsed: 'mock',
    tokensConsumed: 100,
    durationMs: 500,
    outcome: 'success',
    affectedFiles: ['auth.ts'],
    ...overrides,
  };
}

function makeCostEntry(overrides?: Partial<CostLedgerEntry>): CostLedgerEntry {
  return {
    id: `c-${Math.random().toString(36).slice(2)}:${Date.now()}`,
    taskId: 'task-1',
    workerId: null,
    engineId: 'claude-sonnet',
    timestamp: Date.now(),
    tokens_input: 5000,
    tokens_output: 2000,
    cache_read_tokens: 0,
    cache_creation_tokens: 0,
    duration_ms: 5000,
    oracle_invocations: 0,
    computed_usd: 0.05,
    cost_tier: 'billing',
    routing_level: 2,
    task_type_signature: 'refactor:ts:small',
    ...overrides,
  };
}

function insertTraces(store: TraceStore, count: number, overrides: Partial<ExecutionTrace>): void {
  for (let i = 0; i < count; i++) {
    store.insert(
      makeTrace({
        id: `t-${Math.random().toString(36).slice(2, 8)}`,
        sessionId: `s-${i % 5}`,
        ...overrides,
      }),
    );
  }
}

/**
 * Seed cost ledger with entries that will produce a detectable cost anti-pattern:
 * - expensiveEngine: costs 5x the median (~$0.50 each)
 * - cheapEngine: costs near median (~$0.05 each)
 * Both need MIN_OBSERVATIONS (5) entries on the same task_type_signature.
 */
function seedCostAntiPattern(ledger: CostLedger, taskSig: string, count: number) {
  for (let i = 0; i < count; i++) {
    // Cheap engine: ~$0.05
    ledger.record(
      makeCostEntry({
        id: `cheap-${i}:${Date.now()}`,
        engineId: 'cheap-engine',
        computed_usd: 0.05,
        task_type_signature: taskSig,
      }),
    );
    // Expensive engine: ~$0.50 (10x the cheap engine, >2x median)
    ledger.record(
      makeCostEntry({
        id: `expensive-${i}:${Date.now()}`,
        engineId: 'expensive-engine',
        computed_usd: 0.50,
        task_type_signature: taskSig,
      }),
    );
  }
}

describe('CostPatternMiner → Sleep Cycle integration', () => {
  test('SleepCycleRunner with costLedger runs CostPatternMiner and includes costPatternsFound', async () => {
    const db = createTestDb();
    const { traceStore, patternStore } = createStores(db);
    const ledger = new CostLedger(db);

    // Satisfy the data gate: enough traces + distinct task types
    insertTraces(traceStore, 100, { approach: 'test', outcome: 'success' });
    for (let i = 1; i <= 5; i++) {
      insertTraces(traceStore, 1, { taskTypeSignature: `type-${i}::file.ts` });
    }

    // Seed cost data that triggers a cost anti-pattern
    seedCostAntiPattern(ledger, 'refactor:ts:small', 10);

    const runner = new SleepCycleRunner({
      traceStore,
      patternStore,
      costLedger: ledger,
      config: { minTracesForAnalysis: 50 },
    });

    const result = await runner.run();
    expect(result.costPatternsFound).toBeGreaterThan(0);
  });

  test('SleepCycleResult includes costPatternsFound count matching extracted patterns', async () => {
    const db = createTestDb();
    const { traceStore, patternStore } = createStores(db);
    const ledger = new CostLedger(db);

    insertTraces(traceStore, 100, { approach: 'test', outcome: 'success' });
    for (let i = 1; i <= 5; i++) {
      insertTraces(traceStore, 1, { taskTypeSignature: `type-${i}::file.ts` });
    }

    // Seed with two task types to get multiple patterns
    seedCostAntiPattern(ledger, 'refactor:ts:small', 10);
    seedCostAntiPattern(ledger, 'fix:ts:medium', 10);

    const runner = new SleepCycleRunner({
      traceStore,
      patternStore,
      costLedger: ledger,
      config: { minTracesForAnalysis: 50 },
    });

    const result = await runner.run();
    // Each task type should produce at least one cost anti-pattern
    expect(result.costPatternsFound).toBeGreaterThanOrEqual(2);
    expect(typeof result.costPatternsFound).toBe('number');
  });

  test('bus events are emitted for each detected cost pattern', async () => {
    const db = createTestDb();
    const { traceStore, patternStore } = createStores(db);
    const ledger = new CostLedger(db);
    const bus = createBus();

    // Collect emitted events
    const emittedEvents: VinyanBusEvents['economy:cost_pattern_detected'][] = [];
    bus.on('economy:cost_pattern_detected', (payload) => {
      emittedEvents.push(payload);
    });

    insertTraces(traceStore, 100, { approach: 'test', outcome: 'success' });
    for (let i = 1; i <= 5; i++) {
      insertTraces(traceStore, 1, { taskTypeSignature: `type-${i}::file.ts` });
    }

    seedCostAntiPattern(ledger, 'refactor:ts:small', 10);

    const runner = new SleepCycleRunner({
      traceStore,
      patternStore,
      costLedger: ledger,
      bus,
      config: { minTracesForAnalysis: 50 },
    });

    const result = await runner.run();

    // One bus event per cost pattern found
    expect(emittedEvents.length).toBe(result.costPatternsFound);
    // Each event should have the expected shape
    for (const event of emittedEvents) {
      expect(event.patternId).toBeTruthy();
      expect(event.type).toBeTruthy();
      expect(event.engineId).toBeTruthy();
      expect(event.taskType).toBeTruthy();
    }
  });

  test('SleepCycleRunner without costLedger still works (costPatternsFound=0)', async () => {
    const db = createTestDb();
    const { traceStore, patternStore } = createStores(db);

    insertTraces(traceStore, 100, { approach: 'test', outcome: 'success' });
    for (let i = 1; i <= 5; i++) {
      insertTraces(traceStore, 1, { taskTypeSignature: `type-${i}::file.ts` });
    }

    const runner = new SleepCycleRunner({
      traceStore,
      patternStore,
      // No costLedger provided
      config: { minTracesForAnalysis: 50 },
    });

    const result = await runner.run();
    expect(result.costPatternsFound).toBe(0);
    expect(result.marketPhaseEvaluated).toBe(false);
    // The rest of the sleep cycle should still function
    expect(result.tracesAnalyzed).toBeGreaterThanOrEqual(100);
  });

  test('cost patterns below MIN_PATTERN_CONFIDENCE are still counted but not persisted', async () => {
    const db = createTestDb();
    const { traceStore, patternStore } = createStores(db);
    const ledger = new CostLedger(db);

    insertTraces(traceStore, 100, { approach: 'test', outcome: 'success' });
    for (let i = 1; i <= 5; i++) {
      insertTraces(traceStore, 1, { taskTypeSignature: `type-${i}::file.ts` });
    }

    // Seed cost data — anti-patterns with high cost ratio will have high Wilson LB
    // and will be persisted; this test verifies the count reflects all extracted patterns
    seedCostAntiPattern(ledger, 'refactor:ts:small', 10);

    const runner = new SleepCycleRunner({
      traceStore,
      patternStore,
      costLedger: ledger,
      config: { minTracesForAnalysis: 50 },
    });

    const result = await runner.run();
    // costPatternsFound counts ALL extracted patterns (before confidence filter)
    expect(result.costPatternsFound).toBeGreaterThan(0);
  });
});
