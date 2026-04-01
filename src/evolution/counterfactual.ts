/**
 * Counterfactual Lite — PH3.6 retrospective routing analysis.
 *
 * Answers "what would have happened if we used a different routing level?"
 * without replaying tasks. Uses per-task-type quality averages at each level
 * as proxies for counterfactual outcomes.
 *
 * If routing UP consistently produces higher expected quality, generates
 * an adjust-threshold rule to preemptively route higher for that task type.
 *
 * Source of truth: design/implementation-plan.md §PH3.6
 */
import type { ExecutionTrace, EvolutionaryRule, RoutingLevel } from "../orchestrator/types.ts";
import { wilsonLowerBound } from "../sleep-cycle/wilson.ts";

// ── Types ──────────────────────────────────────────────────────────────

export interface CounterfactualResult {
  traceId: string;
  taskTypeSignature: string;
  actualLevel: RoutingLevel;
  actualQuality: number;
  counterfactualLevel: RoutingLevel;
  expectedQuality: number;
  delta: number; // expectedQuality - actualQuality (positive = routing up would help)
}

export interface CounterfactualSummary {
  taskTypeSignature: string;
  direction: "up" | "down" | "none";
  avgDelta: number;
  sampleSize: number;
  confidence: number; // Wilson LB of proportion with positive delta
  suggestedRule?: EvolutionaryRule;
}

// ── Public API ─────────────────────────────────────────────────────────

/**
 * Build a lookup of average quality per (taskType, routingLevel) from traces.
 */
export function buildQualityLookup(
  traces: ExecutionTrace[],
): Map<string, Map<number, { avgQuality: number; count: number }>> {
  const lookup = new Map<string, Map<number, { sum: number; count: number }>>();

  for (const t of traces) {
    const sig = t.task_type_signature ?? "unknown";
    const quality = t.qualityScore?.composite;
    if (quality == null) continue;

    let byLevel = lookup.get(sig);
    if (!byLevel) {
      byLevel = new Map();
      lookup.set(sig, byLevel);
    }

    const entry = byLevel.get(t.routingLevel);
    if (entry) {
      entry.sum += quality;
      entry.count++;
    } else {
      byLevel.set(t.routingLevel, { sum: quality, count: 1 });
    }
  }

  // Convert sum/count to avgQuality
  const result = new Map<string, Map<number, { avgQuality: number; count: number }>>();
  for (const [sig, byLevel] of lookup) {
    const levelMap = new Map<number, { avgQuality: number; count: number }>();
    for (const [level, { sum, count }] of byLevel) {
      levelMap.set(level, { avgQuality: sum / count, count });
    }
    result.set(sig, levelMap);
  }
  return result;
}

/**
 * Analyze counterfactual routing for each trace.
 * For each trace, computes "if routed one level higher, what quality would we expect?"
 */
export function analyzeCounterfactuals(
  traces: ExecutionTrace[],
  qualityLookup: Map<string, Map<number, { avgQuality: number; count: number }>>,
  minLevelDataPoints = 3,
): CounterfactualResult[] {
  const results: CounterfactualResult[] = [];

  for (const trace of traces) {
    const sig = trace.task_type_signature ?? "unknown";
    const actualQuality = trace.qualityScore?.composite;
    if (actualQuality == null) continue;
    if (trace.routingLevel >= 3) continue; // Already max level

    const counterfactualLevel = (trace.routingLevel + 1) as RoutingLevel;
    const byLevel = qualityLookup.get(sig);
    const cfData = byLevel?.get(counterfactualLevel);

    // Need enough data points at the counterfactual level
    if (!cfData || cfData.count < minLevelDataPoints) continue;

    results.push({
      traceId: trace.id,
      taskTypeSignature: sig,
      actualLevel: trace.routingLevel,
      actualQuality,
      counterfactualLevel,
      expectedQuality: cfData.avgQuality,
      delta: cfData.avgQuality - actualQuality,
    });
  }

  return results;
}

/**
 * Summarize counterfactual results by task type.
 * If routing UP consistently helps (Wilson LB > 0.15 on positive deltas),
 * generate an adjust-threshold rule.
 */
export function summarizeByTaskType(
  results: CounterfactualResult[],
  minSampleSize = 10,
  minWilsonLB = 0.15,
): CounterfactualSummary[] {
  // Group by task type
  const byType = new Map<string, CounterfactualResult[]>();
  for (const r of results) {
    const group = byType.get(r.taskTypeSignature);
    if (group) group.push(r);
    else byType.set(r.taskTypeSignature, [r]);
  }

  const summaries: CounterfactualSummary[] = [];

  for (const [taskSig, typeResults] of byType) {
    if (typeResults.length < minSampleSize) continue;

    const positiveDeltas = typeResults.filter(r => r.delta > 0).length;
    const avgDelta = typeResults.reduce((s, r) => s + r.delta, 0) / typeResults.length;
    const lb = wilsonLowerBound(positiveDeltas, typeResults.length);

    let direction: "up" | "down" | "none" = "none";
    let suggestedRule: EvolutionaryRule | undefined;

    if (lb >= minWilsonLB && avgDelta > 0) {
      direction = "up";
      // Generate adjust-threshold rule to route higher for this task type
      const filePattern = taskSig.split("::").pop() ?? "*";
      suggestedRule = {
        id: `cf-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
        source: "sleep-cycle",
        condition: { file_pattern: filePattern },
        action: "adjust-threshold",
        parameters: {
          riskThreshold: 0.3, // Lower threshold → routes higher more easily
          reason: `Counterfactual analysis: routing UP improves quality by ${(avgDelta * 100).toFixed(0)}% for ${taskSig}`,
          sourceAnalysis: "counterfactual",
        },
        status: "probation",
        created_at: Date.now(),
        effectiveness: 0,
        specificity: 1,
      };
    } else if (avgDelta < -0.1) {
      direction = "down";
    }

    summaries.push({
      taskTypeSignature: taskSig,
      direction,
      avgDelta,
      sampleSize: typeResults.length,
      confidence: lb,
      suggestedRule,
    });
  }

  return summaries;
}
