/**
 * Safety Invariants — 6 immutable constraints on evolution.
 *
 * Evolution Engine CAN modify: oracle configs, risk thresholds, worker configs, routing models.
 * Evolution Engine CANNOT violate these 6 invariants:
 *
 * 1. Human escalation triggers cannot be disabled
 * 2. Security policies cannot be relaxed
 * 3. Budget hard limits cannot be increased
 * 4. Test requirements cannot be waived
 * 5. Rollback capability cannot be disabled
 * 6. Routing hard floor cannot be lowered
 *
 * Source of truth: spec/tdd.md §2 (Evolution Engine), Phase 2.6
 */
import type { EvolutionaryRule } from '../orchestrator/types.ts';

export interface SafetyCheckResult {
  safe: boolean;
  violations: string[];
}

/**
 * Check if an evolutionary rule violates any immutable safety invariant.
 */
export function checkSafetyInvariants(rule: EvolutionaryRule): SafetyCheckResult {
  const violations: string[] = [];

  // Invariant 1: Human escalation triggers cannot be disabled
  if (rule.action === 'adjust-threshold' && rule.parameters.disableHumanEscalation) {
    violations.push('I1: Cannot disable human escalation triggers');
  }

  // Invariant 2: Security policies cannot be relaxed
  if (rule.action === 'adjust-threshold' && rule.parameters.relaxSecurity) {
    violations.push('I2: Cannot relax security policies');
  }
  if (rule.action === 'require-oracle' && rule.parameters.disable === true) {
    violations.push('I2: Cannot disable required security oracles');
  }

  // Invariant 3: Budget hard limits cannot be increased beyond ceiling
  if (rule.action === 'adjust-threshold') {
    const maxTokens = rule.parameters.maxTokens as number | undefined;
    const maxDuration = rule.parameters.maxDurationMs as number | undefined;
    if (maxTokens !== undefined && maxTokens > BUDGET_CEILING.maxTokens) {
      violations.push(`I3: maxTokens ${maxTokens} exceeds ceiling ${BUDGET_CEILING.maxTokens}`);
    }
    if (maxDuration !== undefined && maxDuration > BUDGET_CEILING.maxDurationMs) {
      violations.push(`I3: maxDurationMs ${maxDuration} exceeds ceiling ${BUDGET_CEILING.maxDurationMs}`);
    }
  }

  // Invariant 4: Test requirements cannot be waived
  if (rule.action === 'adjust-threshold' && rule.parameters.skipTests === true) {
    violations.push('I4: Cannot waive test requirements');
  }
  if (rule.action === 'require-oracle' && rule.parameters.oracleName === 'test' && rule.parameters.disable === true) {
    violations.push('I4: Cannot disable test oracle');
  }

  // Invariant 5: Rollback capability cannot be disabled
  if (rule.action === 'adjust-threshold' && rule.parameters.disableRollback === true) {
    violations.push('I5: Cannot disable rollback capability');
  }

  // Invariant 6: Routing hard floor cannot be lowered
  if (rule.action === 'escalate') {
    const toLevel = rule.parameters.toLevel as number | undefined;
    if (toLevel !== undefined && toLevel < 0) {
      violations.push('I6: Cannot set routing level below 0');
    }
  }
  // Multi-file changes cannot be routed to L0
  if (rule.action === 'adjust-threshold' && rule.parameters.forceL0ForMultiFile === true) {
    violations.push('I6: Cannot route multi-file changes to L0');
  }
  // Risk threshold cannot be set below safety floor
  if (rule.action === 'adjust-threshold') {
    const riskThreshold = rule.parameters.riskThreshold as number | undefined;
    if (riskThreshold !== undefined && riskThreshold < RISK_THRESHOLD_FLOOR) {
      violations.push(`I6: riskThreshold ${riskThreshold} below safety floor ${RISK_THRESHOLD_FLOOR}`);
    }
  }

  // Invariant 7: Model allowlist — prevent routing to arbitrary/external models
  if (rule.action === 'prefer-model') {
    const preferredModel = rule.parameters.preferredModel;
    if (typeof preferredModel === 'string') {
      const allowedByPrefix = MODEL_ALLOWLIST_PREFIXES.some((p) => preferredModel.startsWith(p));
      const allowedByExplicit = OPENROUTER_MODEL_ALLOWLIST.has(preferredModel);
      if (!allowedByPrefix && !allowedByExplicit) {
        violations.push(`I7: preferredModel '${preferredModel}' does not match any allowed model`);
      }
    }
  }

  // ── Phase 4 Fleet Governance Invariants ──────────────────────────────

  // Invariant 8: Cannot demote last active worker (fleet collapse protection)
  // Fail-safe: if activeWorkerCount is omitted, block the demotion (conservative default)
  if (rule.action === 'assign-worker' && rule.parameters.forceDemote === true) {
    const remainingActive = rule.parameters.activeWorkerCount as number | undefined;
    if (remainingActive === undefined || remainingActive <= 1) {
      violations.push('I8: Cannot demote last active worker — would cause fleet collapse');
    }
  }

  // Invariant 9: Oracle verification bypass prohibition
  if (rule.action === 'assign-worker' && rule.parameters.skipOracles === true) {
    violations.push('I9: assign-worker rules cannot bypass oracle verification');
  }

  // Invariant 10: Probation workers cannot commit
  if (rule.action === 'assign-worker') {
    const workerStatus = rule.parameters.workerStatus;
    if (workerStatus === 'probation' && rule.parameters.allowCommit === true) {
      violations.push('I10: Probation workers cannot commit — output is shadow-only');
    }
  }

  // Invariant 11: Worker diversity floor — no single worker can receive > 70% of tasks
  if (rule.action === 'assign-worker') {
    const exclusiveAllocation = rule.parameters.exclusiveAllocation as number | undefined;
    if (exclusiveAllocation !== undefined && exclusiveAllocation > WORKER_DIVERSITY_CAP) {
      violations.push(`I11: exclusiveAllocation ${exclusiveAllocation} exceeds diversity cap ${WORKER_DIVERSITY_CAP}`);
    }
  }

  // Invariant 12: Capability promotion is offline-only.
  // The online core loop may see historical EvolutionaryRule rows, but it
  // must not mutate agent capability claims during task routing. The sleep
  // cycle promotes via promoteCapabilityClaims() using persisted traces.
  if (rule.action === 'promote-capability') {
    violations.push('I12: promote-capability is sleep-cycle-only; online rule execution cannot mutate agents');
  }

  return {
    safe: violations.length === 0,
    violations,
  };
}

/**
 * Check a batch of rules against safety invariants.
 * Returns only the safe rules and a list of all violations.
 */
export function filterSafeRules(rules: EvolutionaryRule[]): {
  safe: EvolutionaryRule[];
  violations: Array<{ ruleId: string; violations: string[] }>;
} {
  const safe: EvolutionaryRule[] = [];
  const allViolations: Array<{ ruleId: string; violations: string[] }> = [];

  for (const rule of rules) {
    const result = checkSafetyInvariants(rule);
    if (result.safe) {
      safe.push(rule);
    } else {
      allViolations.push({ ruleId: rule.id, violations: result.violations });
    }
  }

  return { safe, violations: allViolations };
}

// ── Budget ceiling — hard limits that evolution cannot exceed ─────────────

const BUDGET_CEILING = {
  maxTokens: 500_000,
  maxDurationMs: 600_000, // 10 minutes
} as const;

/** Minimum risk threshold — prevents routing everything to L0 (no oracles). */
const RISK_THRESHOLD_FLOOR = 0.05;

/** Allowed model name prefixes for prefer-model rules. */
const MODEL_ALLOWLIST_PREFIXES = ['claude-', 'gpt-', 'gemini-', 'mock/'];

/**
 * Explicit OpenRouter model allowlist — only curated, safety-trained models.
 * Generic "openrouter/" prefix was removed to prevent routing to arbitrary/uncensored models.
 */
const OPENROUTER_MODEL_ALLOWLIST = new Set([
  'openrouter/anthropic/claude-3.5-sonnet',
  'openrouter/anthropic/claude-3-opus',
  'openrouter/openai/gpt-4o',
  'openrouter/google/gemini-pro',
]);

/** I11: Maximum allocation for a single worker (Phase 4 fleet diversity). */
const WORKER_DIVERSITY_CAP = 0.7;
