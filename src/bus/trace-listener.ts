/**
 * Trace Telemetry Listener — subscribes to trace:record events and maintains running aggregates.
 *
 * Pure observer — does not modify core loop behavior (A3 compliance).
 * Provides runtime metrics for CLI summary and future dashboards.
 *
 * Source of truth: spec/tdd.md §1C.4
 */
import type { VinyanBus } from '../core/bus.ts';
import type { WorkerStore } from '../db/worker-store.ts';

export interface TraceTelemetry {
  totalTraces: number;
  successCount: number;
  failureCount: number;
  escalationCount: number;
  timeoutCount: number;
  avgQualityComposite: number;
  avgDurationMs: number;
  byRoutingLevel: Record<number, { total: number; success: number }>;
}

export function attachTraceListener(
  bus: VinyanBus,
  opts?: { workerStore?: WorkerStore },
): {
  getMetrics: () => TraceTelemetry;
  detach: () => void;
} {
  const metrics: TraceTelemetry = {
    totalTraces: 0,
    successCount: 0,
    failureCount: 0,
    escalationCount: 0,
    timeoutCount: 0,
    avgQualityComposite: 0,
    avgDurationMs: 0,
    byRoutingLevel: {},
  };

  let qualitySum = 0;
  let qualityCount = 0;
  let durationSum = 0;

  const detach = bus.on('trace:record', ({ trace }) => {
    metrics.totalTraces++;

    // Outcome counts
    switch (trace.outcome) {
      case 'success':
        metrics.successCount++;
        break;
      case 'failure':
        metrics.failureCount++;
        break;
      case 'escalated':
        metrics.escalationCount++;
        break;
      case 'timeout':
        metrics.timeoutCount++;
        break;
    }

    // Quality average (only when available)
    if (trace.qualityScore) {
      qualitySum += trace.qualityScore.composite;
      qualityCount++;
      metrics.avgQualityComposite = qualitySum / qualityCount;
    }

    // Duration average
    durationSum += trace.durationMs;
    metrics.avgDurationMs = durationSum / metrics.totalTraces;

    // Per routing level breakdown
    const level = trace.routingLevel;
    if (!metrics.byRoutingLevel[level]) {
      metrics.byRoutingLevel[level] = { total: 0, success: 0 };
    }
    metrics.byRoutingLevel[level].total++;
    if (trace.outcome === 'success') {
      metrics.byRoutingLevel[level].success++;
    }

    // Step 7 (F9): invalidate per-worker stats cache eagerly. The 60s TTL is
    // kept as safety net, but routing decisions that happen right after a
    // trace was persisted should see the fresh numbers — otherwise we can
    // keep dispatching to a worker whose success rate just cratered.
    if (opts?.workerStore && trace.workerId) {
      opts.workerStore.invalidateCache(trace.workerId);
    }
  });

  return {
    getMetrics: () => ({ ...metrics }),
    detach,
  };
}
