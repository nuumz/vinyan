/**
 * Cross-Task Analyzer — PH3.5 pattern mining across task type boundaries.
 *
 * Groups traces by shared attributes (model, routing level, blast radius bucket,
 * oracle verdict pattern) and identifies attribute combinations correlated with failure.
 * Generates multi-condition anti-patterns that single-task-type analysis would miss.
 *
 * Source of truth: design/implementation-plan.md §PH3.5
 */
import type { ExecutionTrace, ExtractedPattern } from "../orchestrator/types.ts";
import { wilsonLowerBound } from "./wilson.ts";

// ── Types ──────────────────────────────────────────────────────────────

export interface AttributeCombo {
  model?: string;
  routingLevel?: number;
  blastRadiusBucket?: string;
  oracleVerdictPattern?: string;
}

export interface CorrelationResult {
  combo: AttributeCombo;
  failRate: number;
  sampleSize: number;
  wilsonLB: number;
  sourceTraceIds: string[];
}

// ── Public API ─────────────────────────────────────────────────────────

/**
 * Find failure correlations across task types using 2-attribute combinations.
 * Returns at most `maxResults` correlations sorted by Wilson LB descending.
 */
export function findFailureCorrelations(
  traces: ExecutionTrace[],
  minSampleSize = 5,
  minWilsonLB = 0.6,
  maxResults = 10,
): CorrelationResult[] {
  // Build attribute tuples per trace
  const tuples = traces.map(t => ({
    trace: t,
    model: t.model_used,
    routingLevel: t.routingLevel,
    blastRadiusBucket: blastBucket(t.affected_files.length),
    oracleVerdictPattern: dominantFailedOracle(t.oracleVerdicts),
  }));

  // Generate all 2-attribute combination groups
  const attrKeys = ["model", "routingLevel", "blastRadiusBucket", "oracleVerdictPattern"] as const;
  const results: CorrelationResult[] = [];

  for (let i = 0; i < attrKeys.length; i++) {
    for (let j = i + 1; j < attrKeys.length; j++) {
      const keyA = attrKeys[i]!;
      const keyB = attrKeys[j]!;

      // Group traces by this 2-attribute combination
      const groups = new Map<string, typeof tuples>();
      for (const tuple of tuples) {
        const valA = tuple[keyA];
        const valB = tuple[keyB];
        if (valA == null || valB == null) continue;
        const groupKey = `${keyA}=${valA}|${keyB}=${valB}`;
        const group = groups.get(groupKey);
        if (group) group.push(tuple);
        else groups.set(groupKey, [tuple]);
      }

      for (const [, group] of groups) {
        if (group.length < minSampleSize) continue;

        const failures = group.filter(t =>
          t.trace.outcome === "failure" || t.trace.outcome === "timeout",
        ).length;
        const failRate = failures / group.length;
        if (failRate < 0.5) continue; // Minimum meaningful fail rate

        const lb = wilsonLowerBound(failures, group.length);
        if (lb < minWilsonLB) continue;

        const sample = group[0]!;
        const combo: AttributeCombo = {};
        combo[keyA] = sample[keyA] as never;
        combo[keyB] = sample[keyB] as never;

        results.push({
          combo,
          failRate,
          sampleSize: group.length,
          wilsonLB: lb,
          sourceTraceIds: group.map(t => t.trace.id),
        });
      }
    }
  }

  // Sort by Wilson LB descending, cap at maxResults
  results.sort((a, b) => b.wilsonLB - a.wilsonLB);
  return results.slice(0, maxResults);
}

/**
 * Convert a CorrelationResult to an ExtractedPattern for integration
 * with the existing rule generation pipeline.
 */
export function correlationToPattern(
  result: CorrelationResult,
  derivedFrom?: string,
): ExtractedPattern {
  const comboDesc = Object.entries(result.combo)
    .filter(([, v]) => v != null)
    .map(([k, v]) => `${k}=${v}`)
    .join(", ");

  return {
    id: `xp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    type: "anti-pattern",
    description: `Cross-task failure correlation: ${comboDesc} → ${(result.failRate * 100).toFixed(0)}% fail rate`,
    frequency: result.sampleSize,
    confidence: result.wilsonLB,
    taskTypeSignature: `cross::${comboDesc}`,
    sourceTraceIds: result.sourceTraceIds,
    createdAt: Date.now(),
    decayWeight: 1.0,
    routingLevel: result.combo.routingLevel,
    modelPattern: result.combo.model,
    derivedFrom,
  };
}

// ── Helpers ────────────────────────────────────────────────────────────

function blastBucket(fileCount: number): string {
  if (fileCount <= 1) return "single";
  if (fileCount <= 3) return "small";
  if (fileCount <= 10) return "medium";
  return "large";
}

function dominantFailedOracle(verdicts: Record<string, boolean>): string | undefined {
  for (const [name, passed] of Object.entries(verdicts)) {
    if (!passed) return name;
  }
  return undefined;
}
