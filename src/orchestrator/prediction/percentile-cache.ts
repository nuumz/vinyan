import type { PredictionDistribution } from './forward-predictor-types.ts';

const ZERO_DIST: Readonly<PredictionDistribution> = { lo: 0, mid: 0, hi: 0 };

/**
 * In-memory cache for blast/quality percentile distributions.
 * Replaces per-query SQL with periodic recompute on new outcomes.
 */
export class PercentileCache {
  private readonly cache = new Map<string, PredictionDistribution>();
  private readonly values = new Map<string, number[]>();
  private readonly updateCounters = new Map<string, number>();
  private readonly recomputeEvery: number;

  constructor(recomputeEvery = 10) {
    this.recomputeEvery = recomputeEvery;
  }

  /** Load known values for a task type (e.g. from SQLite at boot). */
  loadAll(taskType: string, blastValues: readonly number[]): void {
    const sorted = [...blastValues].sort((a, b) => a - b);
    this.values.set(taskType, sorted);
    this.updateCounters.set(taskType, 0);
    this.recompute(taskType);
  }

  /** Pure Map.get — returns zeros if task type is unknown. */
  getPercentiles(taskType: string): Readonly<PredictionDistribution> {
    return this.cache.get(taskType) ?? ZERO_DIST;
  }

  /** Append a new outcome value. Triggers recompute every N values. */
  recordValue(taskType: string, blastRadius: number): void {
    let arr = this.values.get(taskType);
    if (!arr) {
      arr = [];
      this.values.set(taskType, arr);
    }
    arr.push(blastRadius);

    const count = (this.updateCounters.get(taskType) ?? 0) + 1;
    this.updateCounters.set(taskType, count);

    if (count % this.recomputeEvery === 0) {
      this.recompute(taskType);
    }
  }

  get taskTypeCount(): number {
    return this.cache.size;
  }

  clear(): void {
    this.cache.clear();
    this.values.clear();
    this.updateCounters.clear();
  }

  private recompute(taskType: string): void {
    const vals = this.values.get(taskType);
    if (!vals || vals.length === 0) {
      this.cache.set(taskType, { ...ZERO_DIST });
      return;
    }
    vals.sort((a, b) => a - b);
    const n = vals.length;
    const p = (pct: number): number => {
      const idx = Math.min(Math.floor(pct * n), n - 1);
      return vals[idx] ?? 0;
    };
    this.cache.set(taskType, { lo: p(0.1), mid: p(0.5), hi: p(0.9) });
  }
}
