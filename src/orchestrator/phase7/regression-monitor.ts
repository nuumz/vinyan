/**
 * Phase 7 — Silent regression monitor.
 *
 * Watches success rates per task type over a rolling window. Fires
 * `phase7:silent_regression` when the most recent window's success rate
 * drops by more than a configurable threshold relative to the
 * established baseline. "Silent" because the orchestrator pipeline is
 * still returning successful-looking traces (no crashes, no oracle
 * blocks) — the regression is detectable only by watching the trend
 * over time.
 *
 * Stateful: holds a per-task-type rolling window of outcomes plus a
 * baseline that is computed once enough observations exist.
 *
 * Source of truth: docs/design/ecp-v2-system-design.md §12 (anomaly
 * detection for silent regressions).
 */
import type { VinyanBus } from '../../core/bus.ts';

/** Recent outcomes window size — tail of the most recent observations. */
export const REGRESSION_RECENT_WINDOW = 30;
/** Baseline window size — observations older than `recent` go here. */
export const REGRESSION_BASELINE_MIN = 30;
/** Min total observations before a regression check is meaningful. */
export const REGRESSION_MIN_OBSERVATIONS = REGRESSION_RECENT_WINDOW + REGRESSION_BASELINE_MIN;
/** Drop in success rate (recent − baseline) that fires the alert. */
export const REGRESSION_DROP_THRESHOLD = 0.10;
/**
 * Cool-down between alerts for the same task type to avoid spamming the
 * bus when a regression persists. Phase 7 dashboards re-derive state
 * on demand, so they don't need a tight stream.
 */
export const REGRESSION_COOLDOWN_MS = 60_000;

export interface RegressionObservation {
  taskTypeSignature: string;
  succeeded: boolean;
  /** Optional override for testing / replay. Defaults to `Date.now()`. */
  observedAt?: number;
}

export interface RegressionVerdict {
  taskTypeSignature: string;
  recentRate: number;
  baselineRate: number;
  drop: number;
  observations: number;
  alerted: boolean;
}

interface RegressionWindow {
  outcomes: boolean[]; // tail of last (recent + baseline) observations
  totalObservations: number;
  lastAlertAt: number;
}

export class RegressionMonitor {
  private readonly windows = new Map<string, RegressionWindow>();
  private readonly bus?: VinyanBus;

  constructor(options?: { bus?: VinyanBus }) {
    this.bus = options?.bus;
  }

  /**
   * Record one task outcome and check for regression. Returns the
   * verdict including whether an alert was fired this call. Idempotent
   * with respect to the cool-down — a repeated regression within
   * `REGRESSION_COOLDOWN_MS` will return `alerted: false` even though
   * the drop is still above threshold (the previous alert covers it).
   */
  record(observation: RegressionObservation): RegressionVerdict {
    const w = this.windows.get(observation.taskTypeSignature) ?? {
      outcomes: [],
      totalObservations: 0,
      lastAlertAt: 0,
    };
    w.outcomes.push(observation.succeeded);
    w.totalObservations++;
    // Trim to the maximum window we'll ever read from. This bounds
    // memory at REGRESSION_RECENT_WINDOW + REGRESSION_BASELINE_MIN per
    // task type — small enough that we don't need a separate eviction
    // pass even with thousands of distinct task types.
    const maxKeep = REGRESSION_RECENT_WINDOW + REGRESSION_BASELINE_MIN;
    if (w.outcomes.length > maxKeep) {
      w.outcomes.splice(0, w.outcomes.length - maxKeep);
    }
    this.windows.set(observation.taskTypeSignature, w);

    const verdict = this.evaluate(observation.taskTypeSignature, w, observation.observedAt ?? Date.now());

    if (verdict.alerted && this.bus) {
      this.bus.emit('phase7:silent_regression', {
        taskTypeSignature: observation.taskTypeSignature,
        recentSuccessRate: verdict.recentRate,
        baselineSuccessRate: verdict.baselineRate,
        drop: verdict.drop,
        observations: verdict.observations,
      });
    }
    return verdict;
  }

  /** Snapshot of every task type's current window — for dashboards / tests. */
  snapshot(): RegressionVerdict[] {
    const now = Date.now();
    return Array.from(this.windows.entries()).map(([sig, w]) => this.evaluate(sig, w, now));
  }

  /** Reset state for one task type — used by drift recovery. */
  reset(taskTypeSignature: string): void {
    this.windows.delete(taskTypeSignature);
  }

  private evaluate(taskTypeSignature: string, w: RegressionWindow, now: number): RegressionVerdict {
    const totalKept = w.outcomes.length;
    if (w.totalObservations < REGRESSION_MIN_OBSERVATIONS || totalKept < REGRESSION_MIN_OBSERVATIONS) {
      return {
        taskTypeSignature,
        recentRate: 0,
        baselineRate: 0,
        drop: 0,
        observations: w.totalObservations,
        alerted: false,
      };
    }

    const recentSlice = w.outcomes.slice(-REGRESSION_RECENT_WINDOW);
    const baselineSlice = w.outcomes.slice(0, totalKept - REGRESSION_RECENT_WINDOW);
    const recentRate = successRate(recentSlice);
    const baselineRate = successRate(baselineSlice);
    const drop = baselineRate - recentRate;

    const cooledDown = now - w.lastAlertAt > REGRESSION_COOLDOWN_MS;
    const shouldAlert = drop > REGRESSION_DROP_THRESHOLD && cooledDown;
    if (shouldAlert) {
      w.lastAlertAt = now;
    }
    return {
      taskTypeSignature,
      recentRate,
      baselineRate,
      drop,
      observations: w.totalObservations,
      alerted: shouldAlert,
    };
  }
}

function successRate(outcomes: boolean[]): number {
  if (outcomes.length === 0) return 0;
  let count = 0;
  for (const o of outcomes) if (o) count++;
  return count / outcomes.length;
}
