/**
 * Yinyan T5 — Per-task-type Thinking Calibration.
 *
 * The sleep-cycle calls `promoteThinkingBudgetTable()` after pattern mining
 * has finished. The calibrator:
 *
 *   1. Pulls per-(taskType, thinkingMode) success-rate aggregates from the
 *      trace store.
 *   2. Runs the per-task-type readiness gate on each task type — same
 *      thresholds the global `evaluateThinkingReadiness` enforces, just
 *      scoped to a single task signature.
 *   3. For each ready (taskType, mode) pair, proposes a recommended
 *      max-output-token budget derived from the mode's `baseBudget` and
 *      its observed success rate. Walk-forward: split the matching traces
 *      into K time windows; require the proposed budget's claim
 *      (mode beats baseline at this level) to hold in ≥ K-1 windows.
 *   4. Applies the P9 monotonicity guard: an existing entry is never
 *      decreased by more than `MAX_DECAY_PER_CYCLE` of its current value.
 *   5. Writes the merged budget table to `parameterStore.set(...)` —
 *      ledger-audited, bus-event-emitting (`adaptive-params:value_changed`).
 *
 * Pure rule-based — A3 deterministic governance, no LLM in the calibration
 * path. Same axiom contract as `promotePatternToCommonsense`.
 */
import type { ParameterStore } from '../orchestrator/adaptive-params/parameter-store.ts';
import {
  evaluateThinkingReadinessForTaskType,
  THINKING_READINESS_NONE_BUCKET,
} from '../orchestrator/thinking/thinking-readiness-gate.ts';
import type { ExecutionTrace } from '../orchestrator/types.ts';

// ── Public types ─────────────────────────────────────────────────────────

export interface PerTaskTypeStat {
  taskType: string;
  thinkingMode: string;
  total: number;
  successes: number;
  failures: number;
  successRate: number;
  avgQualityComposite: number | null;
}

export interface ThinkingBudgetPromotionOptions {
  /** Per-(taskType, mode) success-rate aggregates from `TraceStore`. */
  stats: PerTaskTypeStat[];
  /** Historical traces — used for walk-forward consistency check. */
  traces: ExecutionTrace[];
  /** Live parameter store — read current table + write merged updates. */
  parameterStore: ParameterStore;
  /** Walk-forward windows (default K=5). */
  walkForwardWindows?: number;
  /** Minimum windows that must pass (default K-1=4). */
  walkForwardPassThreshold?: number;
  /**
   * P9 monotonicity guard: maximum fraction by which an existing entry's
   * value may decrease in a single cycle. 0.5 means a budget can shrink
   * to at most 50% of its prior value per sleep-cycle. Default 0.5.
   */
  maxDecayPerCycle?: number;
  /**
   * Profile budgets — mode → baseline tokens. Comes from `PROFILE_DEFINITIONS`
   * in `thinking-compiler.ts`. Calibrator scales each mode's baseline by
   * the observed success rate.
   */
  profileBudgets: Readonly<Record<string, number>>;
}

export type ThinkingBudgetDecision =
  | { kind: 'promoted'; key: string; oldValue?: number; newValue: number; reason: string }
  | {
      kind: 'rejected';
      key: string;
      reason:
        | 'readiness-blocked'
        | 'walk-forward-failed'
        | 'monotonicity-violation'
        | 'no-baseline-budget'
        | 'no-baseline-mode';
      detail: string;
    };

export interface ThinkingBudgetPromotionResult {
  decisions: ThinkingBudgetDecision[];
  /** Was the merged table actually written? */
  applied: boolean;
  /** Final merged budget table — `{key: budget}`. */
  mergedTable: Readonly<Record<string, number>>;
}

const TABLE_KEY = 'thinking.budget_table';
const DEFAULT_K = 5;
const DEFAULT_PASS = 4;
const DEFAULT_DECAY = 0.5;

// ── Walk-forward (per-task-type, per-mode) ──────────────────────────────

/**
 * Walk-forward variant for thinking modes: split matching traces into K
 * time windows; require the mode's success rate to stay ≥ the pre-cycle
 * baseline rate in ≥ passThreshold windows. Mirrors
 * `walkForwardBacktest` from `promotion.ts` but keyed on
 * (taskTypeSignature, thinking_mode) rather than pattern type.
 */
export function walkForwardThinkingBudget(args: {
  taskType: string;
  mode: string;
  baselineMode: string;
  traces: ExecutionTrace[];
  k: number;
}): { passingWindows: number; total: number } {
  const matching = args.traces.filter((t) => t.taskTypeSignature === args.taskType);
  const minPerWindow = 3;
  if (matching.length < args.k * minPerWindow) {
    return { passingWindows: 0, total: args.k };
  }
  const sorted = [...matching].sort((a, b) => a.timestamp - b.timestamp);
  const windowSize = Math.floor(sorted.length / args.k);
  let passing = 0;
  for (let i = 0; i < args.k; i++) {
    const window = sorted.slice(i * windowSize, (i + 1) * windowSize);
    if (window.length < minPerWindow) continue;
    const modeRate = successRateInWindow(window, args.mode);
    const baselineRate = successRateInWindow(window, args.baselineMode);
    if (modeRate === null || baselineRate === null) continue;
    if (modeRate >= baselineRate) passing++;
  }
  return { passingWindows: passing, total: args.k };
}

function successRateInWindow(window: ExecutionTrace[], mode: string): number | null {
  const matchMode = mode === THINKING_READINESS_NONE_BUCKET ? null : mode;
  const matching = window.filter((t) => {
    if (matchMode === null) return t.thinkingMode == null;
    return t.thinkingMode === matchMode;
  });
  if (matching.length === 0) return null;
  const successes = matching.filter((t) => t.outcome === 'success').length;
  return successes / matching.length;
}

// ── Public entry point ──────────────────────────────────────────────────

export function promoteThinkingBudgetTable(opts: ThinkingBudgetPromotionOptions): ThinkingBudgetPromotionResult {
  const k = opts.walkForwardWindows ?? DEFAULT_K;
  const passThreshold = opts.walkForwardPassThreshold ?? DEFAULT_PASS;
  const maxDecay = opts.maxDecayPerCycle ?? DEFAULT_DECAY;

  const decisions: ThinkingBudgetDecision[] = [];
  const currentTable = { ...opts.parameterStore.getRecord(TABLE_KEY) };
  const merged: Record<string, number> = { ...currentTable };

  // Group stats by task type so the readiness gate can run per-type.
  const byTaskType = new Map<string, PerTaskTypeStat[]>();
  for (const s of opts.stats) {
    const bucket = byTaskType.get(s.taskType);
    if (bucket) bucket.push(s);
    else byTaskType.set(s.taskType, [s]);
  }

  for (const [taskType, stats] of byTaskType) {
    const verdict = evaluateThinkingReadinessForTaskType({ taskType, stats });
    if (verdict.status === 'blocked') {
      // One decision row per (taskType, *) pair so the audit trail tells
      // the operator why no entry was promoted for this type.
      decisions.push({
        kind: 'rejected',
        key: `${taskType}:*`,
        reason: 'readiness-blocked',
        detail: `${verdict.reason}: ${verdict.detail}`,
      });
      continue;
    }

    const baselineMode = verdict.baselineMode;
    const baselineBudget = opts.profileBudgets[baselineMode];

    // Iterate non-baseline, observed modes — the readiness gate already
    // verified at least one beats the baseline by the required delta.
    for (const stat of stats) {
      if (stat.thinkingMode === baselineMode) continue;
      if (stat.total === 0) continue;
      const key = `${taskType}:${stat.thinkingMode}`;
      const baseBudget = opts.profileBudgets[stat.thinkingMode];
      if (baseBudget === undefined) {
        decisions.push({
          kind: 'rejected',
          key,
          reason: 'no-baseline-budget',
          detail: `No profile budget defined for mode "${stat.thinkingMode}".`,
        });
        continue;
      }
      if (baselineBudget === undefined) {
        decisions.push({
          kind: 'rejected',
          key,
          reason: 'no-baseline-mode',
          detail: `Baseline mode "${baselineMode}" has no profile budget — cannot derive monotonic ceiling.`,
        });
        continue;
      }

      const wf = walkForwardThinkingBudget({
        taskType,
        mode: stat.thinkingMode,
        baselineMode,
        traces: opts.traces,
        k,
      });
      if (wf.passingWindows < passThreshold) {
        decisions.push({
          kind: 'rejected',
          key,
          reason: 'walk-forward-failed',
          detail: `walk-forward ${wf.passingWindows}/${wf.total} < ${passThreshold}/${k}`,
        });
        continue;
      }

      // Proposed budget: scale the profile baseline by the observed
      // success rate. Cap at the profile baseline (never inflate beyond
      // the architectural ceiling). Floor at 10% of profile baseline so a
      // genuinely-bad single observation cannot zero the budget.
      const proposed = clamp(Math.round(baseBudget * stat.successRate), Math.ceil(baseBudget * 0.1), baseBudget);

      // P9 monotonicity guard: never decrease an existing entry by more
      // than `maxDecay` per cycle. If proposed < current * (1-maxDecay),
      // clamp up to `current * (1-maxDecay)`.
      const current = currentTable[key];
      let nextValue = proposed;
      if (current !== undefined && proposed < current) {
        const floor = Math.ceil(current * (1 - maxDecay));
        if (proposed < floor) {
          nextValue = floor;
          decisions.push({
            kind: 'rejected',
            key,
            reason: 'monotonicity-violation',
            detail: `proposed ${proposed} < floor ${floor} (maxDecay=${maxDecay}); clamping to floor`,
          });
          // Continue to write the clamped value below — the rejection
          // tells the audit trail the proposal needed clamping, but the
          // write still happens at the legal floor.
        }
      }

      if (current === nextValue) continue; // no-op write — skip
      merged[key] = nextValue;
      decisions.push({
        kind: 'promoted',
        key,
        oldValue: current,
        newValue: nextValue,
        reason:
          `successRate=${stat.successRate.toFixed(3)} × baseline ${baseBudget} = ${proposed}` +
          (current !== undefined ? ` (was ${current})` : ' (new)'),
      });
    }
  }

  const tableChanged =
    Object.keys(merged).length !== Object.keys(currentTable).length ||
    Object.entries(merged).some(([k, v]) => currentTable[k] !== v);

  if (!tableChanged) {
    return { decisions, applied: false, mergedTable: merged };
  }

  const setResult = opts.parameterStore.set(
    TABLE_KEY,
    merged,
    `T5 calibrator promoted ${decisions.filter((d) => d.kind === 'promoted').length} entries`,
    'sleep-cycle-t5',
  );
  return {
    decisions,
    applied: setResult.ok,
    mergedTable: merged,
  };
}

function clamp(value: number, lo: number, hi: number): number {
  if (value < lo) return lo;
  if (value > hi) return hi;
  return value;
}
