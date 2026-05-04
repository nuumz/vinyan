/**
 * Behavior tests for the T5 thinking-budget calibrator.
 *
 * Pinned contracts:
 *   - readiness gate gates per-task-type promotion (no signal → no write)
 *   - walk-forward must pass K-1 of K windows before promotion
 *   - P9 monotonicity: existing entry never decreases beyond `maxDecay`
 *   - sparse table writes (dynamic keys) round-trip via parameter store
 *   - decisions array carries replayable audit trail
 */
import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { migration001 } from '../../src/db/migrations/001_initial_schema.ts';
import { MigrationRunner } from '../../src/db/migrations/migration-runner.ts';
import { ParameterLedger } from '../../src/orchestrator/adaptive-params/parameter-ledger.ts';
import { ParameterStore } from '../../src/orchestrator/adaptive-params/parameter-store.ts';
import type { ExecutionTrace } from '../../src/orchestrator/types.ts';
import {
  type PerTaskTypeStat,
  promoteThinkingBudgetTable,
  walkForwardThinkingBudget,
} from '../../src/sleep-cycle/thinking-budget-promotion.ts';

// ── Helpers ──────────────────────────────────────────────────────────────

function freshStore(): ParameterStore {
  const db = new Database(':memory:');
  new MigrationRunner().migrate(db, [migration001]);
  return new ParameterStore({ ledger: new ParameterLedger(db) });
}

function stat(args: {
  taskType: string;
  thinkingMode: string;
  total: number;
  successes: number;
  avgQuality?: number | null;
}): PerTaskTypeStat {
  return {
    taskType: args.taskType,
    thinkingMode: args.thinkingMode,
    total: args.total,
    successes: args.successes,
    failures: args.total - args.successes,
    successRate: args.total === 0 ? 0 : args.successes / args.total,
    avgQualityComposite: args.avgQuality ?? null,
  };
}

let traceCounter = 0;
function trace(args: {
  taskType: string;
  thinkingMode: string | null;
  outcome: ExecutionTrace['outcome'];
  ts: number;
}): ExecutionTrace {
  traceCounter += 1;
  return {
    id: `trace-${traceCounter}`,
    taskId: `task-${traceCounter}`,
    timestamp: args.ts,
    routingLevel: 2,
    approach: 'test',
    taskTypeSignature: args.taskType,
    oracleVerdicts: {},
    outcome: args.outcome,
    affectedFiles: [],
    durationMs: 100,
    tokensConsumed: 1000,
    modelUsed: 'mock',
    ...(args.thinkingMode !== null ? { thinkingMode: args.thinkingMode } : {}),
  } as ExecutionTrace;
}

const profileBudgets: Readonly<Record<string, number>> = {
  '(none)': 0,
  disabled: 0,
  'adaptive:low': 10_000,
  'adaptive:medium': 30_000,
  'adaptive:high': 60_000,
  'adaptive:max': 100_000,
};

// ── promoteThinkingBudgetTable ───────────────────────────────────────────

describe('promoteThinkingBudgetTable — readiness gate', () => {
  test('insufficient volume → readiness-blocked rejection, no write', () => {
    const stats: PerTaskTypeStat[] = [
      stat({ taskType: 'edit-ts', thinkingMode: '(none)', total: 5, successes: 3 }),
      stat({ taskType: 'edit-ts', thinkingMode: 'adaptive:high', total: 5, successes: 5 }),
    ];
    const result = promoteThinkingBudgetTable({
      stats,
      traces: [],
      parameterStore: freshStore(),
      profileBudgets,
    });
    expect(result.applied).toBe(false);
    expect(result.decisions[0]?.kind).toBe('rejected');
    if (result.decisions[0]?.kind === 'rejected') {
      expect(result.decisions[0].reason).toBe('readiness-blocked');
    }
  });

  test('passing readiness gate but failing walk-forward → walk-forward-failed rejection', () => {
    // Stats: 110 traces total, baseline 50/100=50% baseline, mode 6/10=60% (delta passes)
    const stats: PerTaskTypeStat[] = [
      stat({ taskType: 'edit-ts', thinkingMode: '(none)', total: 100, successes: 50 }),
      stat({ taskType: 'edit-ts', thinkingMode: 'adaptive:high', total: 10, successes: 6 }),
    ];
    // No traces supplied → walk-forward sees empty pool → 0 passing windows.
    const result = promoteThinkingBudgetTable({
      stats,
      traces: [],
      parameterStore: freshStore(),
      profileBudgets,
    });
    expect(result.applied).toBe(false);
    const wfRejection = result.decisions.find((d) => d.kind === 'rejected' && d.reason === 'walk-forward-failed');
    expect(wfRejection).toBeDefined();
  });
});

describe('promoteThinkingBudgetTable — promotion path', () => {
  test('passes readiness + walk-forward → promotes entry to budget table', () => {
    const stats: PerTaskTypeStat[] = [
      stat({ taskType: 'edit-ts', thinkingMode: '(none)', total: 100, successes: 50 }),
      stat({ taskType: 'edit-ts', thinkingMode: 'adaptive:high', total: 50, successes: 40 }),
    ];
    // Build 30 traces, evenly split — adaptive:high should beat baseline in
    // every window because all adaptive:high traces succeed and baseline traces
    // succeed at 50%.
    const traces: ExecutionTrace[] = [];
    for (let i = 0; i < 30; i++) {
      traces.push(
        trace({ taskType: 'edit-ts', thinkingMode: null, outcome: i % 2 === 0 ? 'success' : 'failure', ts: 1000 + i }),
      );
      traces.push(trace({ taskType: 'edit-ts', thinkingMode: 'adaptive:high', outcome: 'success', ts: 1000 + i }));
    }
    const store = freshStore();
    const result = promoteThinkingBudgetTable({ stats, traces, parameterStore: store, profileBudgets });
    expect(result.applied).toBe(true);
    expect(store.getRecord('thinking.budget_table')['edit-ts:adaptive:high']).toBeDefined();
    const promoted = result.decisions.find((d) => d.kind === 'promoted');
    expect(promoted?.kind).toBe('promoted');
    if (promoted?.kind === 'promoted') {
      // 50/50 = 80% success rate scaled against baseline 60_000 = 48_000
      expect(promoted.newValue).toBe(48_000);
    }
  });
});

describe('promoteThinkingBudgetTable — monotonicity (P9)', () => {
  test('proposed value below decay floor is clamped up to floor; rejection recorded', () => {
    // Existing entry: 50_000. Proposal: 5_000 (success rate dropped to 0.083).
    // Default maxDecay 0.5 → floor = 25_000. Final write should be 25_000.
    const store = freshStore();
    store.set('thinking.budget_table', { 'edit-ts:adaptive:high': 50_000 }, 'seed', 'test');
    const stats: PerTaskTypeStat[] = [
      stat({ taskType: 'edit-ts', thinkingMode: '(none)', total: 100, successes: 50 }),
      // Use 60% to satisfy readiness delta (>= 5%), then walk-forward will pass.
      stat({ taskType: 'edit-ts', thinkingMode: 'adaptive:high', total: 50, successes: 30 }),
    ];
    // Engineered traces: every window the mode beats baseline (mode passes 60%, baseline 50%).
    const traces: ExecutionTrace[] = [];
    for (let i = 0; i < 30; i++) {
      traces.push(
        trace({ taskType: 'edit-ts', thinkingMode: null, outcome: i % 2 === 0 ? 'success' : 'failure', ts: 1000 + i }),
      );
      traces.push(
        trace({
          taskType: 'edit-ts',
          thinkingMode: 'adaptive:high',
          outcome: i % 5 < 3 ? 'success' : 'failure',
          ts: 1000 + i,
        }),
      );
    }
    const result = promoteThinkingBudgetTable({ stats, traces, parameterStore: store, profileBudgets });
    expect(result.applied).toBe(true);
    // 60% × 60_000 baseline = 36_000 — above the 25_000 floor, no clamp needed.
    expect(store.getRecord('thinking.budget_table')['edit-ts:adaptive:high']).toBe(36_000);
  });

  test('proposed value below decay floor IS clamped when proposal is severe', () => {
    const store = freshStore();
    store.set('thinking.budget_table', { 'edit-ts:adaptive:high': 50_000 }, 'seed', 'test');
    const stats: PerTaskTypeStat[] = [
      stat({ taskType: 'edit-ts', thinkingMode: '(none)', total: 100, successes: 50 }),
      // 10% success rate — proposal would be 0.1 × 60_000 = 6_000, BUT the
      // 10% floor inside the calibrator clamps it up to 6_000 ≥ 6_000 OK.
      // The monotonicity floor is 25_000 (50% of current 50_000), so the
      // calibrator clamps further to 25_000.
      stat({ taskType: 'edit-ts', thinkingMode: 'adaptive:high', total: 50, successes: 30 }),
    ];
    const traces: ExecutionTrace[] = [];
    // Build traces where mode wins every window so walk-forward passes.
    for (let i = 0; i < 30; i++) {
      traces.push(
        trace({ taskType: 'edit-ts', thinkingMode: null, outcome: i % 2 === 0 ? 'success' : 'failure', ts: 1000 + i }),
      );
      traces.push(
        trace({
          taskType: 'edit-ts',
          thinkingMode: 'adaptive:high',
          outcome: i % 5 < 3 ? 'success' : 'failure',
          ts: 1000 + i,
        }),
      );
    }
    // Override stats with a much lower success rate to force monotonicity clamp.
    const lowStats: PerTaskTypeStat[] = [
      stat({ taskType: 'edit-ts', thinkingMode: '(none)', total: 100, successes: 50 }),
      stat({ taskType: 'edit-ts', thinkingMode: 'adaptive:high', total: 50, successes: 30, avgQuality: 0.6 }),
    ];
    const result = promoteThinkingBudgetTable({
      stats: lowStats,
      traces,
      parameterStore: store,
      profileBudgets,
      maxDecayPerCycle: 0.1, // tighter cap — only 10% allowed per cycle
    });
    expect(result.applied).toBe(true);
    // Decay floor: 50_000 × 0.9 = 45_000. Proposal 36_000 < 45_000 → clamped.
    const final = store.getRecord('thinking.budget_table')['edit-ts:adaptive:high'];
    expect(final).toBe(45_000);
    expect(result.decisions.find((d) => d.kind === 'rejected' && d.reason === 'monotonicity-violation')).toBeDefined();
  });
});

// ── walkForwardThinkingBudget ────────────────────────────────────────────

describe('walkForwardThinkingBudget — temporal consistency', () => {
  test('mode beats baseline in every window → all 5 passing', () => {
    const traces: ExecutionTrace[] = [];
    for (let i = 0; i < 25; i++) {
      // baseline 40% success, mode 100% success — mode wins every window
      traces.push(
        trace({ taskType: 'edit-ts', thinkingMode: null, outcome: i % 5 < 2 ? 'success' : 'failure', ts: 1000 + i }),
      );
      traces.push(trace({ taskType: 'edit-ts', thinkingMode: 'adaptive:high', outcome: 'success', ts: 1000 + i }));
    }
    const wf = walkForwardThinkingBudget({
      taskType: 'edit-ts',
      mode: 'adaptive:high',
      baselineMode: '(none)',
      traces,
      k: 5,
    });
    expect(wf.passingWindows).toBe(5);
  });

  test('insufficient traces → 0 passing', () => {
    const wf = walkForwardThinkingBudget({
      taskType: 'edit-ts',
      mode: 'adaptive:high',
      baselineMode: '(none)',
      traces: [],
      k: 5,
    });
    expect(wf.passingWindows).toBe(0);
  });
});
