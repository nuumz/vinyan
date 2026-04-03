/**
 * PerfMeasure — µs-level instrumentation for Vinyan hot paths.
 *
 * Uses Bun.nanoseconds() for high-resolution timing.
 * Conditional: only active when VINYAN_PERF=1 environment variable is set.
 *
 * Design: DC-3 (µs Boundary) — measure decision path latency to enforce
 * sub-µs/µs budgets on hot-path operations.
 */

export interface PerfEntry {
  name: string;
  durationNs: number;
  budgetNs: number;
  exceeded: boolean;
}

export interface PerfReport {
  entries: PerfEntry[];
  p50Ns: number;
  p99Ns: number;
  maxNs: number;
  count: number;
}

/** Whether perf measurement is enabled (VINYAN_PERF=1). */
const PERF_ENABLED = process.env.VINYAN_PERF === '1';

/** Collected entries per metric name. */
const metrics = new Map<string, number[]>();

/** Warnings emitted for budget violations. */
const warnings: PerfEntry[] = [];

/**
 * Measure a synchronous hot-path function.
 *
 * @param name Metric name (e.g. 'queryFacts', 'tierSelect')
 * @param budgetUs Budget in microseconds — logs warning if exceeded
 * @param fn The function to measure
 * @returns The return value of fn
 */
export function measureHot<R>(name: string, budgetUs: number, fn: () => R): R {
  if (!PERF_ENABLED) return fn();

  const startNs = Bun.nanoseconds();
  const result = fn();
  const endNs = Bun.nanoseconds();
  const durationNs = endNs - startNs;
  const budgetNs = budgetUs * 1000;

  // Record
  let entries = metrics.get(name);
  if (!entries) {
    entries = [];
    metrics.set(name, entries);
  }
  entries.push(durationNs);

  // Check budget
  if (durationNs > budgetNs) {
    const entry: PerfEntry = { name, durationNs, budgetNs, exceeded: true };
    warnings.push(entry);
    console.warn(
      `[perf] ${name}: ${(durationNs / 1000).toFixed(1)}µs exceeds budget ${budgetUs}µs`,
    );
  }

  return result;
}

/**
 * Get a performance report for a specific metric.
 *
 * @param name Metric name
 * @returns Report with p50, p99, max, count — or undefined if no data
 */
export function getReport(name: string): PerfReport | undefined {
  const entries = metrics.get(name);
  if (!entries || entries.length === 0) return undefined;

  const sorted = [...entries].sort((a, b) => a - b);
  const count = sorted.length;

  return {
    entries: sorted.map((ns) => ({
      name,
      durationNs: ns,
      budgetNs: 0,
      exceeded: false,
    })),
    p50Ns: sorted[Math.floor(count * 0.5)]!,
    p99Ns: sorted[Math.floor(count * 0.99)]!,
    maxNs: sorted[count - 1]!,
    count,
  };
}

/** Get all budget violation warnings. */
export function getWarnings(): readonly PerfEntry[] {
  return warnings;
}

/** Reset all collected metrics and warnings. */
export function resetMetrics(): void {
  metrics.clear();
  warnings.length = 0;
}

/** Check if perf measurement is enabled. */
export function isPerfEnabled(): boolean {
  return PERF_ENABLED;
}
