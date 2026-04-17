/**
 * Strategy Miner — extract winning approach patterns from traces.
 *
 * Groups successful traces by task type signature, identifies consistent
 * approach patterns, and scores them with Wilson LB confidence.
 *
 * Pure function — no LLM calls, deterministic (A3 compliant).
 *
 * Source of truth: Living Agent Soul plan, Phase 3
 */
import { wilsonLowerBound } from '../../sleep-cycle/wilson.ts';
import type { StrategyEntry } from './soul-schema.ts';
import { SOUL_SECTION_LIMITS } from './soul-schema.ts';

/** Minimal trace projection for strategy mining. */
export interface TraceForStrategy {
  outcome: 'success' | 'failure' | 'timeout' | 'escalated';
  taskTypeSignature?: string;
  approach: string;
  approachDescription?: string;
  timestamp: number;
}

const MIN_OBSERVATIONS = 3;
const MIN_CONFIDENCE = 0.5;

/** Mine winning strategies from agent traces. */
export function mineStrategies(traces: TraceForStrategy[]): StrategyEntry[] {
  if (traces.length < MIN_OBSERVATIONS) return [];

  // Group by task type signature
  const byTaskType = new Map<string, TraceForStrategy[]>();
  for (const trace of traces) {
    if (!trace.taskTypeSignature) continue;
    const group = byTaskType.get(trace.taskTypeSignature) ?? [];
    group.push(trace);
    byTaskType.set(trace.taskTypeSignature, group);
  }

  const strategies: StrategyEntry[] = [];

  for (const [taskSig, taskTraces] of byTaskType) {
    if (taskTraces.length < MIN_OBSERVATIONS) continue;

    // Group by approach within this task type
    const byApproach = new Map<string, { successes: number; total: number; lastSuccess: number; description: string }>();

    for (const trace of taskTraces) {
      const key = normalizeApproach(trace.approach);
      if (!key) continue;

      const stats = byApproach.get(key) ?? { successes: 0, total: 0, lastSuccess: 0, description: '' };
      stats.total++;
      if (trace.outcome === 'success') {
        stats.successes++;
        stats.lastSuccess = Math.max(stats.lastSuccess, trace.timestamp);
        // Prefer detailed description when available
        if (trace.approachDescription && trace.approachDescription.length > stats.description.length) {
          stats.description = trace.approachDescription;
        }
      }
      byApproach.set(key, stats);
    }

    // Find the best approach for this task type
    let bestApproach: string | null = null;
    let bestConfidence = 0;
    let bestStats: (typeof byApproach extends Map<string, infer V> ? V : never) | null = null;

    for (const [approach, stats] of byApproach) {
      if (stats.total < MIN_OBSERVATIONS) continue;
      const confidence = wilsonLowerBound(stats.successes, stats.total);
      if (confidence > bestConfidence && confidence >= MIN_CONFIDENCE) {
        bestConfidence = confidence;
        bestApproach = approach;
        bestStats = stats;
      }
    }

    if (bestApproach && bestStats) {
      strategies.push({
        taskPattern: taskSig,
        strategy: bestStats.description || bestApproach,
        evidenceCount: bestStats.successes,
        lastSuccess: bestStats.lastSuccess,
      });
    }
  }

  return strategies
    .sort((a, b) => b.evidenceCount - a.evidenceCount)
    .slice(0, SOUL_SECTION_LIMITS.winningStrategies);
}

/** Normalize approach text for grouping. */
function normalizeApproach(approach: string): string {
  if (!approach) return '';
  return approach.toLowerCase().trim().replace(/\s+/g, ' ').slice(0, 100);
}
