/**
 * WorkerGates — promotion & demotion gate logic for WorkerProfile.
 *
 * Ported from src/orchestrator/fleet/worker-lifecycle.ts so ProfileLifecycle
 * can drive the state machine generically. The original WorkerLifecycle
 * delegates to this module for gate decisions.
 *
 * Gates:
 *  - Promotion (probation → active):
 *      1. ≥ probationMinTasks observed
 *      2. Wilson LB of success rate > active-median
 *      3. avgQualityScore ≥ active-baseline (mean of active qualities)
 *      4. zero safety violations during probation
 *  - Demotion (active → demoted/retired):
 *      1. rolling window ≥ demotionWindowTasks observed
 *      2. EITHER successRate < active-median − 0.10
 *         OR avgQualityScore < active-median − 2·σ
 */

import type { WorkerStore } from '../../db/worker-store.ts';
import { wilsonLowerBound } from '../../sleep-cycle/wilson.ts';
import type { WorkerProfile } from '../types.ts';
import type { DemotionVerdict, LifecycleGates, PromotionVerdict } from './profile-lifecycle.ts';

export interface WorkerGatesConfig {
  store: WorkerStore;
  probationMinTasks: number;
  demotionWindowTasks: number;
  /** Counts safety violations per worker (driven by guardrail:violation events). */
  safetyViolationCount?: (workerId: string) => number;
}

export class WorkerGates implements LifecycleGates<WorkerProfile> {
  constructor(private readonly config: WorkerGatesConfig) {}

  shouldPromote(profile: WorkerProfile, fleet: readonly WorkerProfile[]): PromotionVerdict {
    const stats = this.config.store.getStats(profile.id);
    if (stats.totalTasks < this.config.probationMinTasks) {
      return {
        promote: false,
        reason: `insufficient tasks: ${stats.totalTasks}/${this.config.probationMinTasks}`,
      };
    }

    const activeMedian = medianSuccessRate(this.config.store, fleet);
    const successCount = Math.round(stats.successRate * stats.totalTasks);
    const wilsonLB = wilsonLowerBound(successCount, stats.totalTasks);
    if (wilsonLB <= activeMedian) {
      return {
        promote: false,
        reason: `Wilson LB ${wilsonLB.toFixed(3)} <= active median ${activeMedian.toFixed(3)}`,
      };
    }

    const baselineQuality = baselineQualityScore(this.config.store, fleet);
    if (stats.avgQualityScore < baselineQuality) {
      return {
        promote: false,
        reason: `quality ${stats.avgQualityScore.toFixed(3)} < baseline ${baselineQuality.toFixed(3)}`,
      };
    }

    const violations = this.config.safetyViolationCount?.(profile.id) ?? 0;
    if (violations > 0) {
      return { promote: false, reason: `${violations} safety violation(s) during probation` };
    }

    return { promote: true, reason: 'all promotion gates passed' };
  }

  shouldDemote(profile: WorkerProfile, fleet: readonly WorkerProfile[]): DemotionVerdict {
    const stats = this.config.store.getRecentStats(profile.id, this.config.demotionWindowTasks);
    if (stats.totalTasks < this.config.demotionWindowTasks) {
      return { demote: false, reason: 'window not yet full' };
    }

    const activeMedian = medianSuccessRate(this.config.store, fleet);
    if (stats.successRate < activeMedian - 0.1) {
      return {
        demote: true,
        reason: `success rate ${stats.successRate.toFixed(3)} < threshold ${(activeMedian - 0.1).toFixed(3)}`,
      };
    }

    const { median, stddev } = qualityMedianAndStddev(this.config.store, fleet);
    if (stats.avgQualityScore < median - 2 * stddev) {
      return {
        demote: true,
        reason: `quality ${stats.avgQualityScore.toFixed(3)} < threshold ${(median - 2 * stddev).toFixed(3)}`,
      };
    }

    return { demote: false, reason: 'within bounds' };
  }
}

function medianSuccessRate(store: WorkerStore, fleet: readonly WorkerProfile[]): number {
  if (fleet.length === 0) return 0;
  const rates = fleet.map((w) => store.getStats(w.id).successRate).sort((a, b) => a - b);
  const mid = Math.floor(rates.length / 2);
  return rates.length % 2 === 0 ? (rates[mid - 1]! + rates[mid]!) / 2 : rates[mid]!;
}

function baselineQualityScore(store: WorkerStore, fleet: readonly WorkerProfile[]): number {
  if (fleet.length === 0) return 0;
  const q = fleet.map((w) => store.getStats(w.id).avgQualityScore);
  return q.reduce((a, b) => a + b, 0) / q.length;
}

function qualityMedianAndStddev(
  store: WorkerStore,
  fleet: readonly WorkerProfile[],
): { median: number; stddev: number } {
  if (fleet.length === 0) return { median: 0, stddev: 0 };
  const q = fleet.map((w) => store.getStats(w.id).avgQualityScore).sort((a, b) => a - b);
  const mid = Math.floor(q.length / 2);
  const median = q.length % 2 === 0 ? (q[mid - 1]! + q[mid]!) / 2 : q[mid]!;
  const mean = q.reduce((a, b) => a + b, 0) / q.length;
  const variance = q.reduce((s, x) => s + (x - mean) ** 2, 0) / q.length;
  return { median, stddev: Math.sqrt(variance) };
}
