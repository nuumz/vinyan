/**
 * Phase 0 gate + measurement-event regression tests.
 *
 * Covers three layers:
 *   1. `evaluateThinkingPhase0Gate` — pure function over a stats snapshot.
 *   2. `TraceStore.getSuccessRateByThinkingMode` — SQL aggregation contract.
 *   3. `TraceCollectorImpl` → `thinking:policy-evaluated` event emission.
 *
 * These three layers compose end-to-end: the trace collector produces the
 * raw events + persists rows, the trace store rolls them up by mode, the
 * gate decides ready/blocked. Each layer is tested in isolation so that a
 * regression in one piece localises clearly.
 *
 * Source of truth: docs/design/extensible-thinking-system-design.md §9
 */
import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createBus } from '../../../src/core/bus.ts';
import { TRACE_SCHEMA_SQL } from '../../../src/db/trace-schema.ts';
import { TraceStore } from '../../../src/db/trace-store.ts';
import { TraceCollectorImpl } from '../../../src/orchestrator/trace-collector.ts';
import {
  evaluateThinkingPhase0Gate,
  PHASE0_MIN_TRACES,
  PHASE0_NONE_BUCKET,
  type ThinkingModeStats,
} from '../../../src/orchestrator/thinking/phase0-gate.ts';
import type { ExecutionTrace } from '../../../src/orchestrator/types.ts';

function makeTrace(overrides: Partial<ExecutionTrace> = {}): ExecutionTrace {
  return {
    id: `trace-${Math.random().toString(36).slice(2, 10)}`,
    taskId: `task-${Math.random().toString(36).slice(2, 10)}`,
    timestamp: Date.now(),
    routingLevel: 2,
    approach: 'direct-edit',
    oracleVerdicts: { ast: true, type: true },
    modelUsed: 'claude-sonnet',
    tokensConsumed: 1200,
    durationMs: 5000,
    outcome: 'success',
    affectedFiles: ['src/foo.ts'],
    ...overrides,
  };
}

function statsRow(overrides: Partial<ThinkingModeStats> & { thinkingMode: string }): ThinkingModeStats {
  return {
    total: 50,
    successes: 30,
    failures: 20,
    successRate: 0.6,
    avgQualityComposite: 0.7,
    ...overrides,
  };
}

// ── Layer 1: pure gate ──────────────────────────────────────────────

describe('evaluateThinkingPhase0Gate (pure)', () => {
  test('blocks below volume threshold', () => {
    const verdict = evaluateThinkingPhase0Gate([
      statsRow({ thinkingMode: PHASE0_NONE_BUCKET, total: 30, successes: 15, failures: 15, successRate: 0.5 }),
      statsRow({ thinkingMode: 'adaptive:medium', total: 30, successes: 22, failures: 8, successRate: 22 / 30 }),
    ]);
    expect(verdict.status).toBe('blocked');
    if (verdict.status === 'blocked') {
      expect(verdict.reason).toBe('insufficient-volume');
      expect(verdict.detail).toContain(`${PHASE0_MIN_TRACES}`);
    }
  });

  test('blocks when no thinking modes have been measured', () => {
    const verdict = evaluateThinkingPhase0Gate([
      statsRow({ thinkingMode: PHASE0_NONE_BUCKET, total: 150, successes: 100, failures: 50, successRate: 100 / 150 }),
    ]);
    expect(verdict.status).toBe('blocked');
    if (verdict.status === 'blocked') {
      expect(verdict.reason).toBe('no-thinking-modes-observed');
    }
  });

  test('blocks when no baseline (none) exists', () => {
    const verdict = evaluateThinkingPhase0Gate([
      statsRow({ thinkingMode: 'adaptive:medium', total: 150, successes: 120, failures: 30, successRate: 0.8 }),
    ]);
    expect(verdict.status).toBe('blocked');
    if (verdict.status === 'blocked') {
      expect(verdict.reason).toBe('no-baseline-observed');
    }
  });

  test('blocks when delta is below the 5% threshold', () => {
    const verdict = evaluateThinkingPhase0Gate([
      statsRow({ thinkingMode: PHASE0_NONE_BUCKET, total: 60, successes: 36, failures: 24, successRate: 0.6 }),
      statsRow({ thinkingMode: 'adaptive:medium', total: 60, successes: 38, failures: 22, successRate: 38 / 60 }),
    ]);
    expect(verdict.status).toBe('blocked');
    if (verdict.status === 'blocked') {
      expect(verdict.reason).toBe('success-rate-delta-too-small');
    }
  });

  test('blocks when quality regresses past the cap even if success delta is fine', () => {
    const verdict = evaluateThinkingPhase0Gate([
      statsRow({
        thinkingMode: PHASE0_NONE_BUCKET,
        total: 60,
        successes: 30,
        failures: 30,
        successRate: 0.5,
        avgQualityComposite: 0.85,
      }),
      statsRow({
        thinkingMode: 'adaptive:medium',
        total: 60,
        successes: 42,
        failures: 18,
        successRate: 0.7,
        avgQualityComposite: 0.6, // -0.25 vs baseline → triggers regression cap
      }),
    ]);
    expect(verdict.status).toBe('blocked');
    if (verdict.status === 'blocked') {
      expect(verdict.reason).toBe('quality-regression-detected');
    }
  });

  test('ready when delta is above threshold and quality holds', () => {
    const verdict = evaluateThinkingPhase0Gate([
      statsRow({
        thinkingMode: PHASE0_NONE_BUCKET,
        total: 60,
        successes: 30,
        failures: 30,
        successRate: 0.5,
        avgQualityComposite: 0.7,
      }),
      statsRow({
        thinkingMode: 'adaptive:medium',
        total: 60,
        successes: 42,
        failures: 18,
        successRate: 0.7,
        avgQualityComposite: 0.72,
      }),
    ]);
    expect(verdict.status).toBe('ready');
    if (verdict.status === 'ready') {
      expect(verdict.bestMode).toBe('adaptive:medium');
      expect(verdict.baselineMode).toBe(PHASE0_NONE_BUCKET);
      expect(verdict.successRateDelta).toBeCloseTo(0.2, 5);
      expect(verdict.qualityCompositeDelta).toBeCloseTo(0.02, 5);
    }
  });

  test('best-mode tie-break is permutation invariant (A3)', () => {
    // Two thinking modes tied on success rate and quality — the verdict
    // must depend on mode name, not iteration order.
    const a = statsRow({
      thinkingMode: 'adaptive:high',
      total: 60,
      successes: 42,
      failures: 18,
      successRate: 0.7,
      avgQualityComposite: 0.7,
    });
    const b = statsRow({
      thinkingMode: 'adaptive:medium',
      total: 60,
      successes: 42,
      failures: 18,
      successRate: 0.7,
      avgQualityComposite: 0.7,
    });
    const baseline = statsRow({
      thinkingMode: PHASE0_NONE_BUCKET,
      total: 60,
      successes: 30,
      failures: 30,
      successRate: 0.5,
      avgQualityComposite: 0.7,
    });
    const v1 = evaluateThinkingPhase0Gate([baseline, a, b]);
    const v2 = evaluateThinkingPhase0Gate([baseline, b, a]);
    expect(v1.status).toBe('ready');
    expect(v2.status).toBe('ready');
    if (v1.status === 'ready' && v2.status === 'ready') {
      expect(v1.bestMode).toBe(v2.bestMode);
      // Alphabetical tiebreak → 'adaptive:high' < 'adaptive:medium'.
      expect(v1.bestMode).toBe('adaptive:high');
    }
  });
});

// ── Layer 2: TraceStore aggregation ─────────────────────────────────

describe('TraceStore.getSuccessRateByThinkingMode', () => {
  let db: Database;
  let store: TraceStore;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec('PRAGMA journal_mode = WAL');
    db.exec(TRACE_SCHEMA_SQL);
    store = new TraceStore(db);
  });

  afterEach(() => {
    db.close();
  });

  test('buckets NULL thinking_mode under the (none) sentinel', () => {
    store.insert(makeTrace({ outcome: 'success' })); // no thinkingMode → (none)
    store.insert(makeTrace({ outcome: 'failure' }));
    const rows = store.getSuccessRateByThinkingMode();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.thinkingMode).toBe(PHASE0_NONE_BUCKET);
    expect(rows[0]!.total).toBe(2);
    expect(rows[0]!.successes).toBe(1);
    expect(rows[0]!.failures).toBe(1);
    expect(rows[0]!.successRate).toBeCloseTo(0.5, 5);
  });

  test('separates rows by mode and computes per-mode success rate', () => {
    for (let i = 0; i < 4; i++) store.insert(makeTrace({ thinkingMode: 'adaptive:medium', outcome: 'success' }));
    store.insert(makeTrace({ thinkingMode: 'adaptive:medium', outcome: 'failure' }));
    store.insert(makeTrace({ outcome: 'success' }));
    store.insert(makeTrace({ outcome: 'failure' }));
    const rows = store.getSuccessRateByThinkingMode();
    const byMode = Object.fromEntries(rows.map((r) => [r.thinkingMode, r]));
    expect(byMode[PHASE0_NONE_BUCKET]!.successRate).toBeCloseTo(0.5, 5);
    expect(byMode['adaptive:medium']!.successRate).toBeCloseTo(0.8, 5);
  });

  test('end-to-end gate ready over real rows', () => {
    // 60 baseline @ 50% success, 60 medium @ 70% success — clears the gate
    for (let i = 0; i < 30; i++) store.insert(makeTrace({ outcome: 'success' }));
    for (let i = 0; i < 30; i++) store.insert(makeTrace({ outcome: 'failure' }));
    for (let i = 0; i < 42; i++) store.insert(makeTrace({ thinkingMode: 'adaptive:medium', outcome: 'success' }));
    for (let i = 0; i < 18; i++) store.insert(makeTrace({ thinkingMode: 'adaptive:medium', outcome: 'failure' }));

    const verdict = evaluateThinkingPhase0Gate(store.getSuccessRateByThinkingMode());
    expect(verdict.status).toBe('ready');
    if (verdict.status === 'ready') {
      expect(verdict.bestMode).toBe('adaptive:medium');
      expect(verdict.successRateDelta).toBeCloseTo(0.2, 5);
    }
  });
});

// ── Layer 3: TraceCollector emits the event ─────────────────────────

describe('TraceCollectorImpl emits thinking:policy-evaluated', () => {
  test('emits a flat measurement payload after each record() call', async () => {
    const bus = createBus();
    const events: Array<{
      taskId: string;
      thinkingMode: string | null;
      outcome: string;
      qualityComposite: number | null;
      oracleCompositeScore: number | null;
    }> = [];
    bus.on('thinking:policy-evaluated', (e) => events.push(e));

    const collector = new TraceCollectorImpl(undefined, undefined, bus);
    await collector.record(
      makeTrace({
        taskId: 'task-A',
        thinkingMode: 'adaptive:medium',
        thinkingTokensUsed: 250,
        outcome: 'success',
        oracleVerdicts: { ast: true, type: true, dep: false },
      }),
    );
    await collector.record(
      makeTrace({
        taskId: 'task-B',
        thinkingMode: undefined,
        outcome: 'failure',
      }),
    );

    expect(events).toHaveLength(2);
    expect(events[0]!.taskId).toBe('task-A');
    expect(events[0]!.thinkingMode).toBe('adaptive:medium');
    expect(events[0]!.outcome).toBe('success');
    // Two oracles passed, one failed → 2/3.
    expect(events[0]!.oracleCompositeScore).toBeCloseTo(2 / 3, 5);

    expect(events[1]!.taskId).toBe('task-B');
    expect(events[1]!.thinkingMode).toBeNull();
    expect(events[1]!.outcome).toBe('failure');
  });

  test('does not throw when bus is absent (backward compat)', async () => {
    const collector = new TraceCollectorImpl();
    await expect(collector.record(makeTrace())).resolves.toBeUndefined();
  });
});
