import { createHash } from 'node:crypto';
import type { Fact } from '../core/types.ts';
import type {
  ExecutionTrace,
  GoalGroundingAction,
  GoalGroundingCheck,
  GoalGroundingPhase,
  GovernanceEvidenceReference,
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
  worldGraph?: WorldGraphReader;
  now?: number;
}

export function shouldRunGoalGrounding(args: Pick<GoalGroundingInput, 'input' | 'routing' | 'startedAt'>): boolean {
  const elapsedMs = Date.now() - args.startedAt;
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
  const rootGoal = normalizeGoal(stripReplanDirective(args.understanding.rawGoal || args.input.goal));
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
  return !rootGoal.includes(currentGoal) && !currentGoal.includes(rootGoal);
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