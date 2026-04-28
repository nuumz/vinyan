import { createHash } from 'node:crypto';
import type { Fact } from '../core/types.ts';
import { buildShortCircuitProvenance } from './governance-provenance.ts';
import type {
  ExecutionTrace,
  GoalGroundingAction,
  GoalGroundingCheck,
  GoalGroundingPhase,
  GovernanceEvidenceReference,
  GovernanceProvenance,
  RoutingDecision,
  SemanticTaskUnderstanding,
  TaskInput,
} from './types.ts';

export const GOAL_GROUNDING_POLICY_VERSION = 'goal-time-grounding:v1' as const;

const HIGH_RISK_SCORE = 0.6;
const LONG_RUNNING_BUDGET_MS = 120_000;
const ELAPSED_CHECK_THRESHOLD_MS = 30_000;
const FRESHNESS_CONFIDENCE_FLOOR = 0.35;

interface WorldGraphReader {
  queryFacts(target: string): Fact[];
}

interface GoalGroundingInput {
  input: TaskInput;
  understanding: SemanticTaskUnderstanding;
  routing: RoutingDecision;
  phase: GoalGroundingPhase;
  startedAt: number;
  rootGoal?: string;
  worldGraph?: WorldGraphReader;
  now?: number;
}

export function shouldRunGoalGrounding(args: Pick<GoalGroundingInput, 'input' | 'routing' | 'startedAt' | 'now'>): boolean {
  const elapsedMs = (args.now ?? Date.now()) - args.startedAt;
  return (
    args.routing.level >= 2 ||
    (args.routing.riskScore ?? 0) >= HIGH_RISK_SCORE ||
    args.input.budget.maxDurationMs >= LONG_RUNNING_BUDGET_MS ||
    elapsedMs >= ELAPSED_CHECK_THRESHOLD_MS
  );
}

export function evaluateGoalGrounding(args: GoalGroundingInput): GoalGroundingCheck | undefined {
  if (!shouldRunGoalGrounding(args)) return undefined;

  const now = args.now ?? Date.now();
  const rootGoalSource = args.rootGoal ?? (args.understanding.rawGoal || args.input.goal);
  const rootGoal = normalizeGoal(stripReplanDirective(rootGoalSource));
  const currentGoal = normalizeGoal(stripReplanDirective(args.input.goal));
  const goalDrift = hasGoalDrift(rootGoal, currentGoal);
  const targets = collectGroundingTargets(args.input, args.understanding);
  const facts = args.worldGraph ? queryFacts(args.worldGraph, targets) : [];
  const staleFacts = facts.filter((fact) => isStaleForGrounding(fact, now));
  const minFactConfidence = facts.length > 0 ? Math.min(...facts.map((fact) => fact.confidence)) : undefined;
  const freshnessDowngraded = staleFacts.length > 0;
  const action = decideAction(goalDrift, freshnessDowngraded);

  return {
    taskId: args.input.id,
    phase: args.phase,
    routingLevel: args.routing.level,
    policyVersion: GOAL_GROUNDING_POLICY_VERSION,
    checkedAt: now,
    action,
    reason: formatReason(action, goalDrift, freshnessDowngraded, staleFacts.length),
    rootGoalHash: hashGoal(rootGoal),
    currentGoalHash: hashGoal(currentGoal),
    goalDrift,
    freshnessDowngraded,
    factCount: facts.length,
    staleFactCount: staleFacts.length,
    minFactConfidence,
    evidence: buildEvidence(args.input, targets, staleFacts),
  };
}

export function buildGoalGroundingClarificationQuestions(check: GoalGroundingCheck): string[] {
  return [
    `A10 goal grounding detected possible goal drift during ${check.phase}: ${check.reason}. Should I continue with the current execution goal, or re-ground to the original intent?`,
  ];
}

export function buildGoalGroundingProvenance(input: TaskInput, check: GoalGroundingCheck): GovernanceProvenance {
  return buildShortCircuitProvenance({
    input,
    decisionId: `goal-grounding-${check.action}`,
    attributedTo: 'goalGroundingPolicy',
    wasGeneratedBy: 'evaluateGoalGrounding',
    reason: check.reason,
    evidence: [
      {
        kind: 'other',
        source: 'goal-grounding-check',
        observedAt: check.checkedAt,
        summary: `phase=${check.phase}; action=${check.action}; goalDrift=${check.goalDrift}; freshnessDowngraded=${check.freshnessDowngraded}`,
      },
      ...check.evidence,
    ],
  });
}

export function applyGoalGroundingConfidenceDowngrade<T extends ExecutionTrace>(
  trace: T,
  checks: readonly GoalGroundingCheck[],
): T {
  const downgrade = [...checks].reverse().find((check) => check.action === 'downgrade-confidence');
  if (!downgrade) return trace;

  const downgradedConfidence = Math.min(
    trace.confidenceDecision?.confidence ?? trace.pipelineConfidence?.composite ?? 1,
    downgrade.minFactConfidence ?? FRESHNESS_CONFIDENCE_FLOOR,
  );
  if (trace.pipelineConfidence) {
    trace.pipelineConfidence = {
      ...trace.pipelineConfidence,
      composite: Math.min(trace.pipelineConfidence.composite, downgradedConfidence),
      formula: `${trace.pipelineConfidence.formula}; A10=min(goalGrounding=${formatNumber(downgradedConfidence)})`,
    };
  }
  trace.confidenceDecision = {
    action: trace.confidenceDecision && trace.confidenceDecision.action !== 'allow' ? trace.confidenceDecision.action : 're-verify',
    confidence: downgradedConfidence,
    reason: `A10 grounding downgrade: ${downgrade.reason}`,
  };
  return trace;
}

function decideAction(goalDrift: boolean, freshnessDowngraded: boolean): GoalGroundingAction {
  if (goalDrift) return 'request-clarification';
  if (freshnessDowngraded) return 'downgrade-confidence';
  return 'continue';
}

function formatReason(
  action: GoalGroundingAction,
  goalDrift: boolean,
  freshnessDowngraded: boolean,
  staleFactCount: number,
): string {
  if (action === 'request-clarification') return 'Current execution goal diverged from the root intent';
  if (action === 'downgrade-confidence') {
    return `Temporal grounding found ${staleFactCount} stale or low-confidence fact(s)`;
  }
  if (goalDrift || freshnessDowngraded) return 'Grounding check observed non-blocking drift signals';
  return 'Goal and temporal evidence remain grounded';
}

function buildEvidence(
  input: TaskInput,
  targets: string[],
  staleFacts: Fact[],
): GovernanceEvidenceReference[] {
  return [
    {
      kind: 'task-input',
      source: input.id,
      summary: `taskType=${input.taskType}; source=${input.source}`,
    },
    ...targets.slice(0, 8).map((target) => ({
      kind: 'file' as const,
      source: target,
      summary: 'grounding target',
    })),
    ...staleFacts.slice(0, 8).map((fact) => ({
      kind: 'other' as const,
      source: fact.id,
      contentHash: fact.fileHash,
      observedAt: fact.verifiedAt,
      summary: `fact=${fact.target}; confidence=${formatNumber(fact.confidence)}; validUntil=${fact.validUntil ?? 'none'}`,
    })),
  ];
}

function collectGroundingTargets(input: TaskInput, understanding: SemanticTaskUnderstanding): string[] {
  const resolvedPaths = understanding.resolvedEntities.flatMap((entity) => entity.resolvedPaths);
  return Array.from(new Set([...(input.targetFiles ?? []), ...resolvedPaths].filter((target) => target.length > 0)));
}

function queryFacts(worldGraph: WorldGraphReader, targets: string[]): Fact[] {
  const seen = new Set<string>();
  const facts: Fact[] = [];
  for (const target of targets) {
    for (const fact of worldGraph.queryFacts(target)) {
      if (seen.has(fact.id)) continue;
      seen.add(fact.id);
      facts.push(fact);
    }
  }
  return facts;
}

function isStaleForGrounding(fact: Fact, now: number): boolean {
  return (fact.validUntil !== undefined && fact.validUntil <= now) || fact.confidence < FRESHNESS_CONFIDENCE_FLOOR;
}

function hasGoalDrift(rootGoal: string, currentGoal: string): boolean {
  if (!rootGoal || !currentGoal) return false;
  if (rootGoal === currentGoal) return false;
  // Containment fast-path: a refinement (current ⊆ root or root ⊆ current) is
  // not drift — it is the same intent at a different specificity level.
  if (rootGoal.includes(currentGoal) || currentGoal.includes(rootGoal)) return false;
  // Token-Jaccard drift detection: when the goals share insufficient content
  // vocabulary, treat as drift. Rule-based (A3 safe) — no LLM in the path.
  // Returns 1.0 when either side has no content tokens, so we never flag a
  // "drift" purely because we couldn't extract enough vocabulary.
  return tokenJaccard(rootGoal, currentGoal) < GOAL_DRIFT_OVERLAP_THRESHOLD;
}

/**
 * A10 broader grounding (2026-04-28): replaces the earlier substring-only
 * check. Threshold deliberately conservative — drift triggers a clarification
 * pause, so over-flagging is more disruptive than missing subtle drift.
 *
 * Tunable via const (no runtime knob yet); revisit if dashboards show
 * pause noise.
 */
const GOAL_DRIFT_OVERLAP_THRESHOLD = 0.3;

/** Common English stopwords stripped before Jaccard scoring. Kept small +
 *  literal — large stopword lists tend to drop content tokens like "user". */
const GOAL_TOKEN_STOPWORDS = new Set([
  'the',
  'a',
  'an',
  'to',
  'for',
  'of',
  'in',
  'on',
  'at',
  'with',
  'and',
  'or',
  'is',
  'are',
  'be',
  'that',
  'this',
  'it',
  'as',
  'by',
  'from',
  'into',
  'when',
  'then',
]);

function tokenizeGoal(goal: string): string[] {
  return goal
    .split(/[^a-z0-9]+/i)
    .map((token) => token.toLowerCase())
    .filter((token) => token.length >= 3 && !GOAL_TOKEN_STOPWORDS.has(token));
}

function tokenJaccard(a: string, b: string): number {
  const ta = new Set(tokenizeGoal(a));
  const tb = new Set(tokenizeGoal(b));
  if (ta.size === 0 || tb.size === 0) return 1;
  let intersection = 0;
  for (const token of ta) {
    if (tb.has(token)) intersection++;
  }
  const union = ta.size + tb.size - intersection;
  return union === 0 ? 1 : intersection / union;
}

function stripReplanDirective(goal: string): string {
  return goal.split('\n\n[REPLAN ')[0] ?? goal;
}

function normalizeGoal(goal: string): string {
  return goal.trim().toLowerCase().replace(/\s+/g, ' ');
}

function hashGoal(goal: string): string {
  return `sha256:${createHash('sha256').update(goal).digest('hex')}`;
}

function formatNumber(value: number): string {
  return Number.isFinite(value) ? value.toFixed(3) : String(value);
}