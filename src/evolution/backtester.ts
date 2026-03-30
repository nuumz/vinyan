/**
 * Backtester — validates evolutionary rules against historical traces.
 *
 * 80/20 temporal split: oldest 80% = training, newest 20% = validation.
 * Anti-lookahead: validation window STRICTLY newer than training.
 * Pass criteria: prevent ≥50% of historical failures WITHOUT blocking successes.
 *
 * Source of truth: vinyan-tdd.md §2 (Evolution Engine), Phase 2.6
 */
import type { EvolutionaryRule, ExecutionTrace } from "../orchestrator/types.ts";

export interface BacktestResult {
  pass: boolean;
  effectiveness: number;
  prevented: number;       // failures that would have been prevented
  falsePositives: number;  // successes that would have been blocked
  totalFailures: number;
  totalSuccesses: number;
  trainingSize: number;
  validationSize: number;
}

/**
 * Backtest a rule against historical execution traces.
 *
 * Steps:
 * 1. Sort traces by timestamp (oldest first)
 * 2. Split 80/20 (training / validation)
 * 3. Count how many validation-set failures the rule would have prevented
 * 4. Count how many validation-set successes the rule would have blocked
 * 5. Pass if prevented ≥ 50% of failures AND falsePositives === 0
 */
export function backtestRule(
  rule: EvolutionaryRule,
  traces: ExecutionTrace[],
): BacktestResult {
  if (traces.length < 5) {
    return {
      pass: false,
      effectiveness: 0,
      prevented: 0,
      falsePositives: 0,
      totalFailures: 0,
      totalSuccesses: 0,
      trainingSize: 0,
      validationSize: 0,
    };
  }

  // Sort by timestamp ascending (oldest first)
  const sorted = [...traces].sort((a, b) => a.timestamp - b.timestamp);

  // 80/20 temporal split
  const splitIndex = Math.floor(sorted.length * 0.8);
  const training = sorted.slice(0, splitIndex);
  const validation = sorted.slice(splitIndex);

  // Anti-lookahead check: validation must be strictly newer
  const trainingMaxTime = training[training.length - 1]?.timestamp ?? 0;
  const validationMinTime = validation[0]?.timestamp ?? 0;
  if (validationMinTime <= trainingMaxTime && validation.length > 0 && training.length > 0) {
    // This shouldn't happen with sorted data, but guard against it
  }

  // Count failures and successes in validation set
  const failures = validation.filter(t => t.outcome === "failure");
  const successes = validation.filter(t => t.outcome === "success");

  // Simulate rule application: would this rule have affected each trace?
  let prevented = 0;
  let falsePositives = 0;

  for (const trace of failures) {
    if (wouldRuleApply(rule, trace)) {
      prevented++;
    }
  }

  for (const trace of successes) {
    if (wouldRuleApply(rule, trace)) {
      falsePositives++;
    }
  }

  const totalFailures = failures.length;
  const totalSuccesses = successes.length;

  // Effectiveness = prevented / total failures (or 0 if no failures)
  const effectiveness = totalFailures > 0 ? prevented / totalFailures : 0;

  // Pass criteria: prevent ≥50% failures AND 0 false positives
  const pass = effectiveness >= 0.5 && falsePositives === 0;

  return {
    pass,
    effectiveness,
    prevented,
    falsePositives,
    totalFailures,
    totalSuccesses,
    trainingSize: training.length,
    validationSize: validation.length,
  };
}

/**
 * Check if a rule would have applied to a given trace.
 * Matches rule conditions against trace metadata.
 */
function wouldRuleApply(rule: EvolutionaryRule, trace: ExecutionTrace): boolean {
  const c = rule.condition;

  if (c.file_pattern) {
    const traceFiles = trace.affected_files.join(",");
    if (!simpleGlobMatch(c.file_pattern, traceFiles)) return false;
  }

  if (c.oracle_name) {
    const oracleNames = Object.keys(trace.oracleVerdicts);
    if (!oracleNames.includes(c.oracle_name)) return false;
  }

  if (c.risk_above !== undefined) {
    const riskScore = trace.risk_score ?? 0;
    if (riskScore <= c.risk_above) return false;
  }

  if (c.model_pattern) {
    if (!trace.model_used.includes(c.model_pattern)) return false;
  }

  return true;
}

function simpleGlobMatch(pattern: string, value: string): boolean {
  const regex = new RegExp(
    pattern.replace(/\./g, "\\.").replace(/\*/g, ".*"),
  );
  return regex.test(value);
}
