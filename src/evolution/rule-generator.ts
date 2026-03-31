/**
 * Rule Generator — creates EvolutionaryRules from Sleep Cycle patterns.
 *
 * Anti-patterns → escalation rules (increase routing level)
 * Success patterns → preference rules (select winning model/approach)
 *
 * New rules enter probation status (10 sessions, logging-only).
 *
 * Source of truth: vinyan-tdd.md §2 (Evolution Engine), Phase 2.6
 */
import type { EvolutionaryRule, ExtractedPattern } from "../orchestrator/types.ts";

/** Default probation period in sessions before a rule can become active. */
const PROBATION_SESSIONS = 10;

/**
 * Generate an EvolutionaryRule from an ExtractedPattern.
 * Returns null if the pattern doesn't warrant a rule.
 */
export function generateRule(pattern: ExtractedPattern): EvolutionaryRule | null {
  if (pattern.type === "anti-pattern") {
    return generateEscalationRule(pattern);
  }
  if (pattern.type === "success-pattern") {
    return generatePreferenceRule(pattern);
  }
  if (pattern.type === "worker-performance") {
    return generateWorkerAssignmentRule(pattern);
  }
  return null;
}

/**
 * Generate multiple rules from a batch of patterns.
 */
export function generateRules(patterns: ExtractedPattern[]): EvolutionaryRule[] {
  const rules: EvolutionaryRule[] = [];
  for (const pattern of patterns) {
    const rule = generateRule(pattern);
    if (rule) rules.push(rule);
  }
  return rules;
}

// ── Internal generators ──────────────────────────────────────────────────

function generateEscalationRule(pattern: ExtractedPattern): EvolutionaryRule {
  // Anti-pattern: approach fails ≥80% → escalate to higher routing level
  const condition: EvolutionaryRule["condition"] = {};
  let specificity = 0;

  // Extract file pattern from task type signature (format: "goal::filePattern")
  const filePattern = extractFilePattern(pattern.taskTypeSignature);
  if (filePattern && filePattern !== "*") {
    condition.file_pattern = filePattern;
    specificity++;
  }

  // PH3.3: Multi-condition rules — populate when pattern has oracle/risk/model data
  if (pattern.oracleName) { condition.oracle_name = pattern.oracleName; specificity++; }
  if (pattern.riskAbove != null) { condition.risk_above = pattern.riskAbove; specificity++; }
  if (pattern.modelPattern) { condition.model_pattern = pattern.modelPattern; specificity++; }

  // PH3.3: Proportional toLevel — escalate one level above failure, capped at 3
  const toLevel = Math.min(3, (pattern.routingLevel ?? 1) + 1);

  return {
    id: `rule-esc-${pattern.id}`,
    source: "sleep-cycle",
    condition,
    action: "escalate",
    parameters: {
      toLevel,
      reason: `Anti-pattern detected: ${pattern.description}`,
      sourcePatternId: pattern.id,
      failingApproach: pattern.approach,
    },
    status: "probation",
    created_at: Date.now(),
    effectiveness: 0,
    specificity,
  };
}

function generatePreferenceRule(pattern: ExtractedPattern): EvolutionaryRule {
  // Success pattern: approach A outperforms B → prefer approach A
  const condition: EvolutionaryRule["condition"] = {};
  let specificity = 0;

  const filePattern = extractFilePattern(pattern.taskTypeSignature);
  if (filePattern && filePattern !== "*") {
    condition.file_pattern = filePattern;
    specificity++;
  }

  // PH3.3: Multi-condition rules
  if (pattern.oracleName) { condition.oracle_name = pattern.oracleName; specificity++; }
  if (pattern.riskAbove != null) { condition.risk_above = pattern.riskAbove; specificity++; }
  if (pattern.modelPattern) { condition.model_pattern = pattern.modelPattern; specificity++; }

  return {
    id: `rule-pref-${pattern.id}`,
    source: "sleep-cycle",
    condition,
    action: "prefer-model",
    parameters: {
      preferredApproach: pattern.approach,
      comparedApproach: pattern.comparedApproach,
      qualityDelta: pattern.qualityDelta,
      reason: `Success pattern: ${pattern.description}`,
      sourcePatternId: pattern.id,
    },
    status: "probation",
    created_at: Date.now(),
    effectiveness: 0,
    specificity,
  };
}

function generateWorkerAssignmentRule(pattern: ExtractedPattern): EvolutionaryRule | null {
  if (!pattern.workerId) return null;

  const condition: EvolutionaryRule["condition"] = {};
  let specificity = 0;

  // Worker-performance patterns use fingerprint-format signatures (e.g. "refactor::.ts::small")
  // — the last segment is a blast radius bucket, NOT a file pattern.
  // Use model_pattern matching instead of file_pattern for worker assignment rules.
  if (pattern.modelPattern) { condition.model_pattern = pattern.modelPattern; specificity++; }
  if (pattern.oracleName) { condition.oracle_name = pattern.oracleName; specificity++; }
  if (pattern.riskAbove != null) { condition.risk_above = pattern.riskAbove; specificity++; }

  return {
    id: `rule-assign-${pattern.id}`,
    source: "sleep-cycle",
    condition,
    action: "assign-worker",
    parameters: {
      workerId: pattern.workerId,
      comparedWorkerId: pattern.comparedWorkerId,
      qualityDelta: pattern.qualityDelta,
      taskTypeSignature: pattern.taskTypeSignature,
      reason: `Worker performance: ${pattern.description}`,
      sourcePatternId: pattern.id,
    },
    status: "probation",
    created_at: Date.now(),
    effectiveness: 0,
    specificity,
  };
}

/** Extract file pattern from task type signature ("goal::filePattern"). */
function extractFilePattern(taskTypeSignature: string): string | undefined {
  const parts = taskTypeSignature.split("::");
  return parts.length > 1 ? parts[parts.length - 1] : undefined;
}
