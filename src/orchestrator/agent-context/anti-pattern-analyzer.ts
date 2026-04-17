/**
 * Anti-Pattern Analyzer — extract causal failure patterns from traces.
 *
 * Unlike the ACL's simple "approach: failure reason" strings, this analyzer
 * correlates failures with oracle verdicts and prediction errors to build
 * causal explanations: WHY the approach failed, not just THAT it failed.
 *
 * Pure function — no LLM calls, deterministic (A3 compliant).
 *
 * Source of truth: Living Agent Soul plan, Phase 3
 */
import type { AntiPatternEntry } from './soul-schema.ts';
import { SOUL_SECTION_LIMITS } from './soul-schema.ts';

/** Minimal trace projection for anti-pattern analysis. */
export interface TraceForAntiPattern {
  outcome: 'success' | 'failure' | 'timeout' | 'escalated';
  approach: string;
  taskTypeSignature?: string;
  oracleVerdicts: Record<string, boolean>;
  failureReason?: string;
  predictionError?: { error: { composite: number } };
  affectedFiles: string[];
}

const MIN_FAILURE_COUNT = 2;

/** Analyze traces for causal anti-patterns. */
export function analyzeAntiPatterns(traces: TraceForAntiPattern[]): AntiPatternEntry[] {
  const failures = traces.filter((t) => t.outcome === 'failure' || t.outcome === 'escalated');
  if (failures.length < MIN_FAILURE_COUNT) return [];

  // Group failures by (approach + failed oracle) combination
  const failureGroups = new Map<string, {
    approach: string;
    oracle: string;
    count: number;
    reasons: string[];
    surprising: number; // count of high-prediction-error failures
    files: Set<string>;
  }>();

  for (const trace of failures) {
    const failedOracles = Object.entries(trace.oracleVerdicts)
      .filter(([, passed]) => !passed)
      .map(([name]) => name);

    // If no specific oracle failed, use the failure reason
    const oracleKey = failedOracles.length > 0 ? failedOracles.sort().join('+') : 'unknown';
    const approachKey = normalizeApproach(trace.approach);
    if (!approachKey) continue;

    const key = `${approachKey}::${oracleKey}`;
    const group = failureGroups.get(key) ?? {
      approach: trace.approach,
      oracle: oracleKey,
      count: 0,
      reasons: [],
      surprising: 0,
      files: new Set<string>(),
    };

    group.count++;
    if (trace.failureReason) group.reasons.push(trace.failureReason.slice(0, 100));
    if (trace.predictionError && Math.abs(trace.predictionError.error.composite) > 0.3) {
      group.surprising++;
    }
    for (const f of trace.affectedFiles) group.files.add(f);

    failureGroups.set(key, group);
  }

  // Convert to anti-pattern entries
  const entries: AntiPatternEntry[] = [];

  for (const group of failureGroups.values()) {
    if (group.count < MIN_FAILURE_COUNT) continue;

    // Build causal explanation
    const cause = buildCausalExplanation(group);

    entries.push({
      pattern: `${group.approach} (on ${[...group.files].slice(0, 2).join(', ') || 'various files'})`,
      cause,
      evidenceCount: group.count,
      oracleInvolved: group.oracle,
    });
  }

  return entries
    .sort((a, b) => b.evidenceCount - a.evidenceCount)
    .slice(0, SOUL_SECTION_LIMITS.antiPatterns);
}

function buildCausalExplanation(group: {
  oracle: string;
  count: number;
  reasons: string[];
  surprising: number;
}): string {
  const parts: string[] = [];

  parts.push(`${group.count} failures`);

  if (group.oracle !== 'unknown') {
    parts.push(`oracle: ${group.oracle}`);
  }

  // Find most common reason
  if (group.reasons.length > 0) {
    const reasonFreq = new Map<string, number>();
    for (const reason of group.reasons) {
      const key = reason.toLowerCase().slice(0, 50);
      reasonFreq.set(key, (reasonFreq.get(key) ?? 0) + 1);
    }
    const topReason = [...reasonFreq.entries()].sort((a, b) => b[1] - a[1])[0];
    if (topReason) parts.push(topReason[0]);
  }

  if (group.surprising > 0) {
    parts.push(`${group.surprising} were surprising (agent expected success)`);
  }

  return parts.join(', ');
}

function normalizeApproach(approach: string): string {
  if (!approach) return '';
  return approach.toLowerCase().trim().replace(/\s+/g, ' ').slice(0, 80);
}
