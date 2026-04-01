/**
 * Fleet Evaluator — metrics for fleet governance health.
 *
 * Gini coefficient, capability coverage, worker utilization.
 * Used by observability and sleep cycle for convergence detection.
 *
 * Source of truth: design/implementation-plan.md §Phase 4.5
 */

import type { VinyanBus } from '../core/bus.ts';
import type { WorkerStore } from '../db/worker-store.ts';
import type { CapabilityModel } from './capability-model.ts';

export interface FleetMetrics {
  activeWorkers: number;
  probationWorkers: number;
  demotedWorkers: number;
  retiredWorkers: number;
  diversityScore: number; // Gini coefficient of task allocation (0=equal, 1=monoculture)
  capabilityCoverage: number; // fraction of task types with ≥1 worker capability > 0.5
  avgWorkerSpecialization: number; // average variance of per-worker capability across task types
  workerUtilization: Record<string, number>; // workerId → fraction of total tasks
}

/**
 * Compute Gini coefficient from a distribution.
 * 0 = perfect equality, 1 = perfect inequality.
 */
export function giniCoefficient(values: number[]): number {
  if (values.length <= 1) return 0;
  const total = values.reduce((a, b) => a + b, 0);
  if (total === 0) return 0;

  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  let numerator = 0;
  for (let i = 0; i < n; i++) {
    numerator += (2 * (i + 1) - n - 1) * sorted[i]!;
  }
  return Math.max(0, Math.min(1, numerator / (n * total)));
}

/**
 * Evaluate fleet health metrics.
 */
export function evaluateFleet(workerStore: WorkerStore, capabilityModel?: CapabilityModel): FleetMetrics {
  const active = workerStore.findActive();
  const probation = workerStore.findByStatus('probation');
  const demoted = workerStore.findByStatus('demoted');
  const retired = workerStore.findByStatus('retired');

  // Worker utilization — fraction of total tasks per worker
  const allWorkers = [...active, ...probation, ...demoted, ...retired];
  const utilization: Record<string, number> = {};
  let totalTasks = 0;

  for (const w of allWorkers) {
    const stats = workerStore.getStats(w.id);
    utilization[w.id] = stats.totalTasks;
    totalTasks += stats.totalTasks;
  }

  // Normalize to fractions
  if (totalTasks > 0) {
    for (const id of Object.keys(utilization)) {
      utilization[id] = utilization[id]! / totalTasks;
    }
  }

  // Gini coefficient of active worker task counts
  const activeTaskCounts = active.map((w) => workerStore.getStats(w.id).totalTasks);
  const diversityScore = giniCoefficient(activeTaskCounts);

  // Capability coverage — fraction of task types with good coverage
  let capabilityCoverage = 0;
  let avgSpecialization = 0;

  if (capabilityModel && active.length > 0) {
    const allCapabilities = active.map((w) => capabilityModel.getWorkerCapabilities(w.id));
    const allTaskTypes = new Set<string>();
    for (const caps of allCapabilities) {
      for (const c of caps) allTaskTypes.add(c.fingerprint);
    }

    if (allTaskTypes.size > 0) {
      let covered = 0;
      for (const taskType of allTaskTypes) {
        const hasCoverage = allCapabilities.some((caps) =>
          caps.some((c) => c.fingerprint === taskType && c.capability !== null && c.capability > 0.5),
        );
        if (hasCoverage) covered++;
      }
      capabilityCoverage = covered / allTaskTypes.size;
    }

    // Average specialization (variance of capabilities per worker)
    if (allCapabilities.length > 0) {
      let totalVariance = 0;
      let workerCount = 0;
      for (const caps of allCapabilities) {
        const scores = caps.filter((c) => c.capability !== null).map((c) => c.capability!);
        if (scores.length >= 2) {
          const mean = scores.reduce((a, b) => a + b, 0) / scores.length;
          const variance = scores.reduce((sum, s) => sum + (s - mean) ** 2, 0) / scores.length;
          totalVariance += variance;
          workerCount++;
        }
      }
      avgSpecialization = workerCount > 0 ? totalVariance / workerCount : 0;
    }
  }

  return {
    activeWorkers: active.length,
    probationWorkers: probation.length,
    demotedWorkers: demoted.length,
    retiredWorkers: retired.length,
    diversityScore,
    capabilityCoverage,
    avgWorkerSpecialization: avgSpecialization,
    workerUtilization: utilization,
  };
}

/** Convergence warning threshold — Gini above this indicates monoculture risk. */
const CONVERGENCE_GINI_THRESHOLD = 0.7;

/**
 * Check fleet diversity and emit convergence warning if Gini exceeds threshold.
 * Call after task completion or during sleep cycle.
 */
export function checkFleetConvergence(
  workerStore: WorkerStore,
  bus: VinyanBus,
  capabilityModel?: CapabilityModel,
): FleetMetrics {
  const metrics = evaluateFleet(workerStore, capabilityModel);

  if (metrics.diversityScore > CONVERGENCE_GINI_THRESHOLD && metrics.activeWorkers > 1) {
    // Find dominant worker (highest utilization)
    let dominantWorkerId = '';
    let maxAllocation = 0;
    for (const [id, allocation] of Object.entries(metrics.workerUtilization)) {
      if (allocation > maxAllocation) {
        maxAllocation = allocation;
        dominantWorkerId = id;
      }
    }

    bus.emit('fleet:convergence_warning', {
      giniScore: metrics.diversityScore,
      dominantWorkerId,
      allocation: maxAllocation,
    });
  }

  return metrics;
}
