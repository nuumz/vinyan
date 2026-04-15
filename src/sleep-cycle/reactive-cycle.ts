/**
 * Reactive Micro-Cycle — Wave 5. Generates **probational** evolutionary rules
 * immediately when a failure cluster forms, bypassing the ≥100-trace data gate
 * that the full sleep cycle requires.
 *
 * A3: rule generation is a pure function over the cluster's trace metadata.
 *     No LLM in the rule-synthesis path.
 * A5: all rules emitted here are `status: 'probation'` with effectiveness=0
 *     and require the sleep cycle's standard backtester OR 3 successful
 *     applications (via RuleStore.incrementEffectiveness) to graduate.
 *
 * This module is standalone — it accepts trace summaries and returns
 * ProposedReactiveRule objects. Persistence is the caller's responsibility
 * (normally via RuleStore.insert with status='probation').
 *
 * Integration into the sleep-cycle runner is DEFERRED — callers can invoke
 * synthesizeReactiveRule directly when FailureClusterDetector fires.
 */
import type { EvolutionaryRule, ExecutionTrace } from '../orchestrator/types.ts';
import type { FailureCluster } from '../orchestrator/goal-satisfaction/failure-cluster-detector.ts';

export interface ReactiveTraceSummary {
  taskId: string;
  taskSignature: string;
  /** Which oracle(s) rejected the task (if any). */
  failureOracles: string[];
  /** Files that were touched (for filePattern extraction). */
  affectedFiles: string[];
  /** The approach string that failed. */
  approach?: string;
}

export interface ProposedReactiveRule {
  /** Condition — at least one must be present. */
  condition: {
    filePattern?: string;
    oracleName?: string;
    taskTypeSignature?: string;
  };
  /** Action the rule will enforce when matched. */
  action: 'escalate' | 'require-oracle' | 'prefer-model' | 'adjust-threshold';
  /** Structured parameters for the action. */
  parameters: Record<string, unknown>;
  /** A5: probation — never 'active'. Requires 3 successful applications to graduate. */
  status: 'probation';
  /** Trace IDs that motivated this rule (audit trail). */
  sourceTraceIds: string[];
  /** Human-readable rationale. */
  rationale: string;
}

/**
 * Synthesize a probational rule from a failure cluster.
 * Returns null if the cluster has no actionable pattern.
 */
export function synthesizeReactiveRule(
  cluster: FailureCluster,
  traces: ReactiveTraceSummary[],
): ProposedReactiveRule | null {
  if (traces.length < 2) return null;

  // Rule synthesis heuristics (all rule-based, A3):
  //
  // 1. If >=80% of traces failed on the same oracle → escalate rule.
  // 2. If all traces touch the same file (or glob pattern) → require-oracle rule.
  // 3. Otherwise → no actionable pattern, return null.

  const oracleCounts = new Map<string, number>();
  for (const t of traces) {
    for (const o of t.failureOracles) {
      oracleCounts.set(o, (oracleCounts.get(o) ?? 0) + 1);
    }
  }

  let dominantOracle: string | undefined;
  let maxCount = 0;
  for (const [oracle, count] of oracleCounts) {
    if (count > maxCount) {
      dominantOracle = oracle;
      maxCount = count;
    }
  }

  const dominantRatio = traces.length > 0 ? maxCount / traces.length : 0;

  if (dominantOracle && dominantRatio >= 0.8) {
    return {
      condition: {
        taskTypeSignature: cluster.taskSignature,
        oracleName: dominantOracle,
      },
      action: 'escalate',
      parameters: { toLevel: 2 },
      status: 'probation',
      sourceTraceIds: cluster.taskIds,
      rationale: `${maxCount}/${traces.length} failures on oracle "${dominantOracle}" for task signature "${cluster.taskSignature}"`,
    };
  }

  // File-pattern heuristic: if every trace touches a common file prefix.
  const filePattern = extractCommonFilePattern(traces);
  if (filePattern) {
    return {
      condition: {
        filePattern,
        taskTypeSignature: cluster.taskSignature,
      },
      action: 'require-oracle',
      parameters: { oracleName: 'test' },
      status: 'probation',
      sourceTraceIds: cluster.taskIds,
      rationale: `Failure cluster on "${filePattern}" — require test oracle to catch regressions`,
    };
  }

  return null;
}

/**
 * Convert a raw ExecutionTrace from TraceStore into a lightweight
 * ReactiveTraceSummary. Returns null for non-failure outcomes so callers
 * can filter in a single `.filter(Boolean)` pass.
 */
export function traceToReactiveSummary(trace: ExecutionTrace): ReactiveTraceSummary | null {
  if (trace.outcome !== 'failure') return null;
  const failureOracles: string[] = [];
  for (const [oracle, passed] of Object.entries(trace.oracleVerdicts)) {
    if (!passed) failureOracles.push(oracle);
  }
  return {
    taskId: trace.taskId,
    taskSignature: trace.taskTypeSignature ?? 'unknown',
    failureOracles,
    affectedFiles: trace.affectedFiles,
    approach: trace.approach,
  };
}

/**
 * Convert a ProposedReactiveRule into the persistence-ready EvolutionaryRule
 * shape expected by RuleStore.insert. taskTypeSignature (which isn't a
 * first-class condition field in EvolutionaryRule) is folded into parameters
 * for audit — the rule-matcher ignores it, which is intentional: reactive
 * rules are scoped by oracleName + filePattern, not by signature.
 */
export function reactiveRuleToEvolutionary(rule: ProposedReactiveRule): EvolutionaryRule {
  const condition: EvolutionaryRule['condition'] = {};
  if (rule.condition.oracleName) condition.oracleName = rule.condition.oracleName;
  if (rule.condition.filePattern) condition.filePattern = rule.condition.filePattern;

  const specificity = Object.values(condition).filter((v) => v !== undefined).length;

  return {
    id: `reactive-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    source: 'sleep-cycle',
    condition,
    action: rule.action,
    parameters: {
      ...rule.parameters,
      taskTypeSignature: rule.condition.taskTypeSignature,
      sourceTraceIds: rule.sourceTraceIds,
      rationale: rule.rationale,
    },
    status: 'probation',
    createdAt: Date.now(),
    effectiveness: 0,
    specificity,
  };
}

function extractCommonFilePattern(traces: ReactiveTraceSummary[]): string | null {
  if (traces.length === 0) return null;
  const allFiles = traces.flatMap((t) => t.affectedFiles);
  if (allFiles.length === 0) return null;

  // Find the longest common prefix across all files, bounded to directory granularity.
  let prefix = allFiles[0] ?? '';
  for (const file of allFiles) {
    while (prefix.length > 0 && !file.startsWith(prefix)) {
      const lastSlash = prefix.lastIndexOf('/');
      prefix = lastSlash > 0 ? prefix.slice(0, lastSlash) : '';
    }
    if (prefix.length === 0) break;
  }

  // Only accept a pattern that points at a directory (has at least one slash).
  if (!prefix.includes('/')) return null;
  return `${prefix}/*`;
}
