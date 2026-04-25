/**
 * Brainstorm Phase — optional pre-Perceive ideation step.
 *
 * Runs when the Ideation Classifier detects a goal that benefits from
 * exploring N candidate approaches BEFORE spending Perceive / Spec budget.
 * Produces an IdeationResult, asks the human to pick one, and injects the
 * chosen approach into TaskInput.constraints so downstream phases see it.
 *
 * Axiom alignment:
 *   - A1: drafters + critic + integrator are distinct roles; in "fast" mode
 *         (no Room dispatcher), spec generation and downstream generation are
 *         separate LLM calls with different prompts.
 *   - A2: when the LLM cannot decide, it may emit fewer candidates with
 *         higher openQuestions — we do NOT fake diversity.
 *   - A3: the classifier is a pure regex function; routing is deterministic.
 */

import { randomUUID } from 'node:crypto';
import type {
  ExecutionTrace,
  RoutingDecision,
  SemanticTaskUnderstanding,
  TaskInput,
  TaskResult,
} from '../types.ts';
import { MAX_BRAINSTORM_DRAFTERS } from '../intent/ideation-classifier.ts';
import {
  ideationToConstraint,
  type IdeationCandidate,
  type IdeationResult,
  IdeationResultSchema,
} from '../intent/ideation-types.ts';
import type { PhaseContext, PhaseContinue, PhaseReturn } from './types.ts';
import { Phase } from './types.ts';

export interface BrainstormResult {
  ideation?: IdeationResult;
  enhancedInput?: TaskInput;
  skipped: boolean;
  reason: string;
}

export interface IdeationDrafter {
  draft(input: TaskInput, routing: RoutingDecision): Promise<IdeationResult>;
}

export interface BrainstormPhaseOptions {
  drafter?: IdeationDrafter;
  /** Approval risk score — passed to ApprovalGate. Default 0.2. */
  approvalRiskScore?: number;
  /** When true, auto-select the highest-ranked candidate without ApprovalGate.
   *  Used by tests and by config flag `brainstormPhase.autoSelect`. */
  autoSelectTopCandidate?: boolean;
}

export const BRAINSTORM_PHASE_CONSTRAINTS = {
  enable: 'BRAINSTORM_PHASE:on',
  disable: 'BRAINSTORM_PHASE:off',
} as const;

function isForceEnabled(constraints?: readonly string[]): boolean {
  return (constraints ?? []).includes(BRAINSTORM_PHASE_CONSTRAINTS.enable);
}

function isForceDisabled(constraints?: readonly string[]): boolean {
  return (constraints ?? []).includes(BRAINSTORM_PHASE_CONSTRAINTS.disable);
}

/**
 * Decide whether the Brainstorm phase should run.
 *
 * Rules (Phase A — regression-safe opt-in default):
 *   1. `BRAINSTORM_PHASE:off` always wins.
 *   2. `BRAINSTORM_PHASE:on` enables.
 *   3. Otherwise → disabled.
 *
 * Phase B (follow-up): flip the default to enable when
 * `classifyIdeation(goal).isIdeation` or `taskIntent === 'ideate'`.
 * Keeping the `understanding` parameter here so that flip is a
 * one-line change inside this function.
 */
export function shouldRunBrainstormPhase(
  input: TaskInput,
  _understanding: SemanticTaskUnderstanding,
): boolean {
  if (isForceDisabled(input.constraints)) return false;
  if (isForceEnabled(input.constraints)) return true;
  return false;
}

/**
 * Default LLM-backed ideation drafter. Single structured-output call that
 * emits a full IdeationResult with 2..N candidates. The critic/integrator
 * role separation is collapsed into one prompt for the fast-mode fallback;
 * when Room infrastructure is used, the full A1 separation applies.
 */
async function draftIdeationViaLLM(
  ctx: PhaseContext,
  input: TaskInput,
  routing: RoutingDecision,
): Promise<IdeationResult> {
  const registry = ctx.deps.llmRegistry;
  if (!registry) {
    throw new Error('Brainstorm phase requires an LLMProviderRegistry — none wired into OrchestratorDeps.');
  }
  const provider = registry.selectForRoutingLevel(routing.level) ?? registry.selectByTier('balanced');
  if (!provider) {
    throw new Error('Brainstorm phase: no LLM provider available.');
  }

  const response = await provider.generate({
    systemPrompt: buildBrainstormSystemPrompt(),
    userPrompt: buildBrainstormUserPrompt(input),
    maxTokens: Math.min(2048, Math.floor(input.budget.maxTokens / 6)),
    temperature: 0.7,
  });

  const parsed = parseBrainstormJSON(response.content);
  return IdeationResultSchema.parse(parsed);
}

function buildBrainstormSystemPrompt(): string {
  return [
    'You are an ideation committee that produces diverse candidate approaches for a user goal.',
    `Emit 2 to ${MAX_BRAINSTORM_DRAFTERS} distinct candidates covering meaningfully different strategies (not paraphrases of one idea).`,
    '',
    'Output a single JSON object conforming to IdeationResult:',
    '{',
    '  "candidates": Array<{ id, title, approach, rationale, riskNotes: string[], estComplexity: "trivial"|"small"|"medium"|"large"|"unknown", score: 0..1 }>,',
    '  "rankedIds": string[] (same length as candidates, best first),',
    '  "convergenceScore": 0..1  // top score - second score, clamped',
    '}',
    '',
    'Rules:',
    '- Output ONLY the JSON object — no prose, no markdown fences.',
    '- Candidates must be substantively different (different technology, different trade-offs, different scope).',
    '- Flag riskNotes honestly — a candidate with no risks is almost certainly mis-analyzed.',
    "- Use estComplexity=\"unknown\" when you cannot estimate; do NOT guess.",
    '- Do NOT populate `approvedCandidateId`; the user picks later.',
  ].join('\n');
}

function buildBrainstormUserPrompt(input: TaskInput): string {
  const lines: string[] = [];
  lines.push(`Goal: ${input.goal}`);
  if ((input.constraints ?? []).length > 0) {
    lines.push(`Constraints:`);
    for (const c of input.constraints ?? []) lines.push(`  - ${c}`);
  }
  lines.push('');
  lines.push(`Produce up to ${MAX_BRAINSTORM_DRAFTERS} ranked candidates now.`);
  return lines.join('\n');
}

export function parseBrainstormJSON(content: string): unknown {
  const trimmed = content.trim();
  const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  const body = fenceMatch ? fenceMatch[1]!.trim() : trimmed;
  const firstBrace = body.indexOf('{');
  const lastBrace = body.lastIndexOf('}');
  if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) {
    throw new Error('Brainstorm drafter returned no JSON object.');
  }
  return JSON.parse(body.slice(firstBrace, lastBrace + 1));
}

/**
 * Execute the Brainstorm phase. Returns skipped=true when disabled; returns
 * an input-required TaskResult when the user rejects the ideation set.
 */
export async function executeBrainstormPhase(
  ctx: PhaseContext,
  routing: RoutingDecision,
  understanding: SemanticTaskUnderstanding,
  options: BrainstormPhaseOptions = {},
): Promise<PhaseContinue<BrainstormResult> | PhaseReturn> {
  const { input, deps } = ctx;

  if (!shouldRunBrainstormPhase(input, understanding)) {
    return Phase.continue({ skipped: true, reason: 'gated-off' });
  }

  const startedAt = Date.now();
  let ideation: IdeationResult;
  try {
    ideation = options.drafter
      ? await options.drafter.draft(input, routing)
      : await draftIdeationViaLLM(ctx, input, routing);
  } catch (err) {
    deps.bus?.emit('brainstorm:drafting_failed', {
      taskId: input.id,
      reason: err instanceof Error ? err.message : String(err),
      durationMs: Date.now() - startedAt,
    });
    return Phase.continue({ skipped: true, reason: 'drafting-failed' });
  }

  deps.bus?.emit('brainstorm:drafted', {
    taskId: input.id,
    candidateCount: ideation.candidates.length,
    convergenceScore: ideation.convergenceScore,
    durationMs: Date.now() - startedAt,
  });

  // ── Candidate selection ────────────────────────────────────────────
  // Decision tree:
  //   - ApprovalGate present and not autoSelect → request human pick.
  //   - autoSelect OR no ApprovalGate → take top-ranked candidate.
  //   - Approval rejected → input-required.
  let approvedCandidateId: string | undefined;
  const topCandidateId = ideation.rankedIds[0] ?? ideation.candidates[0]?.id;

  if (options.autoSelectTopCandidate || !deps.approvalGate) {
    approvedCandidateId = topCandidateId;
  } else {
    const decision = await deps.approvalGate.requestApproval(
      input.id,
      options.approvalRiskScore ?? 0.2,
      `Approve brainstorm candidate: ${describeTopCandidate(ideation)}`,
    );
    if (decision === 'rejected') {
      deps.bus?.emit('brainstorm:rejected', { taskId: input.id, reason: 'user-rejected' });
      return Phase.return(buildRejectedResult(input, ideation, routing, startedAt));
    }
    approvedCandidateId = topCandidateId;
  }

  const approvedIdeation: IdeationResult = {
    ...ideation,
    approvedCandidateId,
  };

  deps.bus?.emit('brainstorm:approved', {
    taskId: input.id,
    approvedCandidateId,
    convergenceScore: approvedIdeation.convergenceScore,
  });

  const enhancedInput = projectIdeationIntoInput(input, approvedIdeation);
  return Phase.continue({
    ideation: approvedIdeation,
    enhancedInput,
    skipped: false,
    reason: 'approved',
  });
}

/** Shallow-clone the input and append the chosen candidate as a constraint. */
export function projectIdeationIntoInput(input: TaskInput, ideation: IdeationResult): TaskInput {
  const constraint = ideationToConstraint(ideation);
  if (!constraint) return input;
  const existing = input.constraints ?? [];
  if (existing.includes(constraint)) return input;
  return { ...input, constraints: [...existing, constraint] };
}

function describeTopCandidate(ideation: IdeationResult): string {
  const topId = ideation.rankedIds[0] ?? ideation.candidates[0]?.id;
  const top = ideation.candidates.find((c) => c.id === topId);
  if (!top) return '(no candidates)';
  return `${top.title} (score=${top.score.toFixed(2)})`;
}

function buildRejectedResult(
  input: TaskInput,
  ideation: IdeationResult,
  routing: RoutingDecision,
  startedAt: number,
): TaskResult {
  const trace: ExecutionTrace = {
    id: `trace-${input.id}-brainstorm-rejected-${randomUUID().slice(0, 8)}`,
    taskId: input.id,
    sessionId: input.sessionId,
    workerId: 'orchestrator',
    timestamp: Date.now(),
    routingLevel: routing.level,
    approach: 'brainstorm-rejected',
    approachDescription: `Human rejected all ${ideation.candidates.length} drafted candidates`,
    oracleVerdicts: { brainstorm: false },
    modelUsed: 'orchestrator',
    tokensConsumed: 0,
    durationMs: Date.now() - startedAt,
    outcome: 'success',
    affectedFiles: [],
  };
  return {
    id: input.id,
    status: 'input-required',
    mutations: [],
    trace,
    clarificationNeeded: [
      'None of the drafted approaches were approved. Please refine the goal or specify a preferred direction.',
      ...ideation.candidates.slice(0, 3).map((c) => `Rejected option: ${c.title}`),
    ],
  };
}

/** Derived selector candidates — useful for CLI/TUI rendering. */
export function formatCandidatesForDisplay(ideation: IdeationResult): Array<{
  id: string;
  title: string;
  complexity: IdeationCandidate['estComplexity'];
  score: number;
  riskCount: number;
}> {
  const byId = new Map(ideation.candidates.map((c) => [c.id, c]));
  return ideation.rankedIds
    .map((id) => byId.get(id))
    .filter((c): c is IdeationCandidate => c != null)
    .map((c) => ({
      id: c.id,
      title: c.title,
      complexity: c.estComplexity,
      score: c.score,
      riskCount: c.riskNotes.length,
    }));
}
