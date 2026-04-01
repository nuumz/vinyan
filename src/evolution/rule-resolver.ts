/**
 * Rule Conflict Resolver — 3-step deterministic resolution (A3 compliance).
 *
 * When multiple rules trigger on overlapping conditions:
 * 1. Action type separation: different actions → both apply (no conflict)
 * 2. Specificity wins: more condition fields = higher priority; tie-break by effectiveness
 * 3. Safety floor: unresolvable conflict → stricter action wins
 *
 * Deterministic for same input — required by A3.
 *
 * Source of truth: spec/tdd.md §2 (Evolution Engine), Phase 2.6
 */
import type { EvolutionaryRule } from "../orchestrator/types.ts";

/**
 * Resolve conflicts among triggered rules.
 * Returns the winning rules (one per action type, or the stricter one on conflict).
 */
export function resolveRuleConflicts(rules: EvolutionaryRule[]): EvolutionaryRule[] {
  if (rules.length <= 1) return rules;

  // Step 1: Group by action type
  const byAction = new Map<string, EvolutionaryRule[]>();
  for (const rule of rules) {
    const group = byAction.get(rule.action) ?? [];
    group.push(rule);
    byAction.set(rule.action, group);
  }

  // Step 2: For each action type, pick the winner
  const winners: EvolutionaryRule[] = [];
  for (const [action, group] of byAction) {
    if (group.length === 1) {
      winners.push(group[0]!);
      continue;
    }

    // Sort by specificity (desc), then effectiveness (desc)
    const sorted = [...group].sort((a, b) => {
      if (b.specificity !== a.specificity) return b.specificity - a.specificity;
      if (b.effectiveness !== a.effectiveness) return b.effectiveness - a.effectiveness;
      // Step 3: Safety floor — stricter action wins on tie
      return stricterAction(b) - stricterAction(a);
    });

    winners.push(sorted[0]!);
  }

  return winners;
}

/**
 * Determine the strictness level of a rule for safety floor resolution.
 * Higher = stricter (preferred on tie).
 */
function stricterAction(rule: EvolutionaryRule): number {
  // Escalation is stricter than preference
  switch (rule.action) {
    case "escalate": {
      const level = (rule.parameters.toLevel as number) ?? 1;
      return 100 + level; // Higher escalation level = stricter
    }
    case "require-oracle":
      return 80;
    case "adjust-threshold":
      return 60;
    case "assign-worker":
      return 50;
    case "prefer-model":
      return 40;
    default:
      return 0;
  }
}
