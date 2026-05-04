/**
 * Extensible Thinking Phase 0 — A/B readiness gate.
 *
 * Pure function over a `getSuccessRateByThinkingMode()` snapshot. Reports
 * whether enough traces exist (and whether the data shows a measurable
 * delta) to unblock Phase 1a. Importantly this is NOT a routing decision —
 * it does NOT change which thinking mode any given task gets. It is purely
 * an observational gate that downstream tooling (sleep cycle, dashboards,
 * Phase 1a opt-in flag) can query to know "do we have enough signal yet?"
 *
 * Source of truth: docs/design/extensible-thinking-system-design.md §9
 *   - Required volume: ≥100 traces total before Phase 1a is unblocked.
 *   - Success criterion: the best non-disabled mode must beat the
 *     disabled/(none) baseline by ≥0.05 absolute success-rate AND must
 *     not regress the quality composite by more than 0.05.
 *   - Decision is reversible — re-running the gate on fresh data will
 *     swing it back to "blocked" if signal degrades.
 *
 * The function returns `ThinkingReadinessVerdict` rather than a boolean so callers
 * can show an exact reason in dashboards and tests.
 */

export interface ThinkingModeStats {
  thinkingMode: string;
  total: number;
  successes: number;
  failures: number;
  successRate: number;
  avgQualityComposite: number | null;
}

export type ThinkingReadinessVerdict =
  | {
      status: 'blocked';
      reason:
        | 'insufficient-volume'
        | 'no-thinking-modes-observed'
        | 'no-baseline-observed'
        | 'success-rate-delta-too-small'
        | 'quality-regression-detected';
      detail: string;
      stats: ThinkingModeStats[];
    }
  | {
      status: 'ready';
      bestMode: string;
      baselineMode: string;
      successRateDelta: number;
      qualityCompositeDelta: number | null;
      stats: ThinkingModeStats[];
    };

/**
 * Constants are exported so tests and operator dashboards can show the
 * thresholds the gate was evaluated against. They intentionally match
 * the doc — change here when the doc changes, not before.
 */
export const THINKING_READINESS_MIN_TRACES = 100;
export const THINKING_READINESS_MIN_SUCCESS_DELTA = 0.05;
export const THINKING_READINESS_MAX_QUALITY_REGRESSION = 0.05;
/** Sentinel used by `getSuccessRateByThinkingMode` for NULL `thinking_mode`. */
export const THINKING_READINESS_NONE_BUCKET = '(none)';

export function evaluateThinkingReadiness(stats: ThinkingModeStats[]): ThinkingReadinessVerdict {
  const total = stats.reduce((acc, s) => acc + s.total, 0);
  if (total < THINKING_READINESS_MIN_TRACES) {
    return {
      status: 'blocked',
      reason: 'insufficient-volume',
      detail: `Have ${total} traces, need ${THINKING_READINESS_MIN_TRACES} before Phase 1a is unblocked.`,
      stats,
    };
  }

  const baseline = stats.find((s) => s.thinkingMode === THINKING_READINESS_NONE_BUCKET);
  const others = stats.filter((s) => s.thinkingMode !== THINKING_READINESS_NONE_BUCKET && s.total > 0);

  if (others.length === 0) {
    return {
      status: 'blocked',
      reason: 'no-thinking-modes-observed',
      detail: 'All traces are in the (none) bucket — no thinking modes have been measured yet.',
      stats,
    };
  }
  if (!baseline || baseline.total === 0) {
    return {
      status: 'blocked',
      reason: 'no-baseline-observed',
      detail: 'No baseline (none) traces exist to compare against — need at least some thinking-disabled runs.',
      stats,
    };
  }

  // Pick the strongest non-disabled mode as the candidate. If two modes
  // tie on success rate, prefer the one with the higher quality composite,
  // and finally tie-break by alphabetical mode name so the verdict is
  // permutation-invariant for the same input.
  const sorted = [...others].sort((a, b) => {
    if (b.successRate !== a.successRate) return b.successRate - a.successRate;
    const aq = a.avgQualityComposite ?? -Infinity;
    const bq = b.avgQualityComposite ?? -Infinity;
    if (bq !== aq) return bq - aq;
    return a.thinkingMode < b.thinkingMode ? -1 : a.thinkingMode > b.thinkingMode ? 1 : 0;
  });
  const best = sorted[0]!;

  const successDelta = best.successRate - baseline.successRate;
  if (successDelta < THINKING_READINESS_MIN_SUCCESS_DELTA) {
    return {
      status: 'blocked',
      reason: 'success-rate-delta-too-small',
      detail:
        `Best mode "${best.thinkingMode}" beats baseline by only ` +
        `${(successDelta * 100).toFixed(1)}% — need at least ` +
        `${(THINKING_READINESS_MIN_SUCCESS_DELTA * 100).toFixed(1)}%.`,
      stats,
    };
  }

  let qualityDelta: number | null = null;
  if (baseline.avgQualityComposite != null && best.avgQualityComposite != null) {
    qualityDelta = best.avgQualityComposite - baseline.avgQualityComposite;
    if (qualityDelta < -THINKING_READINESS_MAX_QUALITY_REGRESSION) {
      return {
        status: 'blocked',
        reason: 'quality-regression-detected',
        detail:
          `Best mode "${best.thinkingMode}" gains success rate but its average ` +
          `quality composite is ${qualityDelta.toFixed(3)} below baseline — ` +
          `regression cap is ${THINKING_READINESS_MAX_QUALITY_REGRESSION}.`,
        stats,
      };
    }
  }

  return {
    status: 'ready',
    bestMode: best.thinkingMode,
    baselineMode: baseline.thinkingMode,
    successRateDelta: successDelta,
    qualityCompositeDelta: qualityDelta,
    stats,
  };
}

// ── T5: Per-task-type readiness gate ────────────────────────────────────

/**
 * T5 (Yinyan per-task-type calibration) — same gate, evaluated for ONE
 * task-type signature in isolation. The calibrator passes only that
 * type's `(thinkingMode, total, ...)` rows in `stats` and inspects the
 * result before considering a budget-table mutation for that type.
 *
 * Crucially this re-uses the same constants (`MIN_TRACES`, `MIN_SUCCESS_DELTA`,
 * `MAX_QUALITY_REGRESSION`) so a per-type unlock has the same statistical
 * rigor as the global unlock — just scoped tighter. The verdict shape is
 * identical to `ThinkingReadinessVerdict`, so existing dashboards consume
 * either flavor unchanged.
 */
export interface PerTaskTypeReadinessInput {
  taskType: string;
  stats: ThinkingModeStats[];
}

export type PerTaskTypeReadinessVerdict = ThinkingReadinessVerdict & { taskType: string };

export function evaluateThinkingReadinessForTaskType(input: PerTaskTypeReadinessInput): PerTaskTypeReadinessVerdict {
  const inner = evaluateThinkingReadiness(input.stats);
  return { ...inner, taskType: input.taskType } as PerTaskTypeReadinessVerdict;
}

/**
 * Aggregate per-task-type verdicts into a single map keyed by taskType.
 * Helper for the calibrator + dashboards — does NOT change the global
 * `evaluateThinkingReadiness()` semantics.
 *
 * Input is the flat shape returned by
 * `TraceStore.getSuccessRateByThinkingModePerTaskType()`. Output preserves
 * insertion order via Map<> so consumers can iterate deterministically.
 */
export function evaluateAllTaskTypes(
  rows: Array<ThinkingModeStats & { taskType: string }>,
): Map<string, PerTaskTypeReadinessVerdict> {
  const grouped = new Map<string, ThinkingModeStats[]>();
  for (const row of rows) {
    const bucket = grouped.get(row.taskType);
    const stat: ThinkingModeStats = {
      thinkingMode: row.thinkingMode,
      total: row.total,
      successes: row.successes,
      failures: row.failures,
      successRate: row.successRate,
      avgQualityComposite: row.avgQualityComposite,
    };
    if (bucket) bucket.push(stat);
    else grouped.set(row.taskType, [stat]);
  }
  const out = new Map<string, PerTaskTypeReadinessVerdict>();
  for (const [taskType, stats] of grouped) {
    out.set(taskType, evaluateThinkingReadinessForTaskType({ taskType, stats }));
  }
  return out;
}
