/**
 * Capability Model — per-worker capability vectors computed from traces.
 *
 * Not stored separately — computed on-demand from trace aggregates.
 * Wilson LB for confident scoring, negative capabilities for exclusion.
 *
 * Source of truth: design/implementation-plan.md §Phase 4.3
 */
import type { Database } from 'bun:sqlite';
import { fingerprintKey } from './task-fingerprint.ts';
import type { TaskFingerprint } from './types.ts';

export interface CapabilityScore {
  workerId: string;
  fingerprint: string; // fingerprint key
  total: number;
  successes: number;
  failures: number;
  capability: number | null; // Wilson LB, null if < minTraces
  negative: boolean; // true if Wilson LB of failures > threshold
  avgQuality: number;
}

export interface CapabilityModelConfig {
  db: Database;
  minTraces: number; // default: 5
  negativeCapabilityThreshold: number; // default: 0.6
}

/**
 * Wilson lower bound at α=0.05 (z=1.96).
 */
function wilsonLowerBound(successes: number, total: number): number {
  if (total === 0) return 0;
  const z = 1.96;
  const p = successes / total;
  const denominator = 1 + (z * z) / total;
  const centre = p + (z * z) / (2 * total);
  const spread = z * Math.sqrt((p * (1 - p) + (z * z) / (4 * total)) / total);
  return (centre - spread) / denominator;
}

export class CapabilityModel {
  private db: Database;
  private minTraces: number;
  private negativeThreshold: number;

  constructor(config: CapabilityModelConfig) {
    this.db = config.db;
    this.minTraces = config.minTraces;
    this.negativeThreshold = config.negativeCapabilityThreshold;
  }

  /**
   * Get capability score for a specific worker and task fingerprint.
   * Returns null capability if insufficient data (< minTraces).
   */
  getCapability(workerId: string, fingerprint: TaskFingerprint): CapabilityScore {
    const key = fingerprintKey(fingerprint);
    return this.getCapabilityByKey(workerId, key);
  }

  /**
   * Get capability score by fingerprint key string.
   */
  getCapabilityByKey(workerId: string, fingerprintKey: string): CapabilityScore {
    // Query traces matching this worker and fingerprint key pattern
    // The taskTypeSignature is a superset of fingerprint key — we match the prefix
    const row = this.db
      .prepare(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN outcome = 'success' THEN 1 ELSE 0 END) as successes,
        SUM(CASE WHEN outcome != 'success' THEN 1 ELSE 0 END) as failures,
        AVG(quality_composite) as avg_quality
      FROM execution_traces
      WHERE worker_id = ? AND task_type_signature LIKE ?
    `)
      .get(workerId, `${fingerprintKey}%`) as {
      total: number;
      successes: number;
      failures: number;
      avg_quality: number | null;
    };

    const total = row.total;
    const successes = row.successes;
    const failures = row.failures;

    // Cold-start: < minTraces → capability null (A2: "I don't know")
    const capability = total >= this.minTraces ? wilsonLowerBound(successes, total) : null;

    // Negative capability: Wilson LB of failure rate > threshold
    const negative = total >= this.minTraces ? wilsonLowerBound(failures, total) > this.negativeThreshold : false;

    return {
      workerId,
      fingerprint: fingerprintKey,
      total,
      successes,
      failures,
      capability,
      negative,
      avgQuality: row.avg_quality ?? 0,
    };
  }

  /**
   * Get all capability scores for a worker across all observed task types.
   */
  getWorkerCapabilities(workerId: string): CapabilityScore[] {
    const rows = this.db
      .prepare(`
      SELECT
        task_type_signature,
        COUNT(*) as total,
        SUM(CASE WHEN outcome = 'success' THEN 1 ELSE 0 END) as successes,
        SUM(CASE WHEN outcome != 'success' THEN 1 ELSE 0 END) as failures,
        AVG(quality_composite) as avg_quality
      FROM execution_traces
      WHERE worker_id = ? AND task_type_signature IS NOT NULL
      GROUP BY task_type_signature
    `)
      .all(workerId) as Array<{
      task_type_signature: string;
      total: number;
      successes: number;
      failures: number;
      avg_quality: number | null;
    }>;

    return rows.map((row) => {
      const capability = row.total >= this.minTraces ? wilsonLowerBound(row.successes, row.total) : null;
      const negative =
        row.total >= this.minTraces ? wilsonLowerBound(row.failures, row.total) > this.negativeThreshold : false;

      return {
        workerId,
        fingerprint: row.task_type_signature,
        total: row.total,
        successes: row.successes,
        failures: row.failures,
        capability,
        negative,
        avgQuality: row.avg_quality ?? 0,
      };
    });
  }

  /**
   * Check if a worker has a negative capability for any dimension of a fingerprint.
   * Returns true if the worker should be excluded.
   */
  hasNegativeCapability(workerId: string, fingerprint: TaskFingerprint): boolean {
    const score = this.getCapability(workerId, fingerprint);
    return score.negative;
  }

  /**
   * Get the maximum capability score across all workers for a fingerprint.
   * Used for fleet-level uncertainty detection (A2).
   */
  getMaxCapabilityForFingerprint(
    workerIds: string[],
    fingerprint: TaskFingerprint,
  ): { maxCapability: number; bestWorkerId: string | null } {
    let maxCapability = 0;
    let bestWorkerId: string | null = null;

    for (const workerId of workerIds) {
      const score = this.getCapability(workerId, fingerprint);
      if (score.capability !== null && score.capability > maxCapability) {
        maxCapability = score.capability;
        bestWorkerId = workerId;
      }
    }

    return { maxCapability, bestWorkerId };
  }
}
