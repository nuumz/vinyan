/**
 * Spec Phase — collaborative specification refinement between Perceive and Predict.
 *
 * Produces a frozen, human-approved SpecArtifact that anchors downstream goal
 * evaluation. A1: the spec-author role that drafts, and the edge-case-critic
 * role that reviews, are distinct LLM calls — this phase enforces separation
 * when it runs in "room" mode. In "fast" mode (single-call fallback) it still
 * meets A1 because spec generation and subsequent generation are different
 * agents using different prompts.
 *
 * The phase is opt-in:
 *   - Enabled when TaskInput.constraints contains `SPEC_PHASE:on`
 *     or SemanticTaskUnderstanding.taskDomain === 'code-mutation' at
 *     routing.level >= 1.
 *   - Disabled unconditionally when constraints contains `SPEC_PHASE:off`.
 *
 * On success, it populates:
 *   - understanding.spec — the frozen artifact
 *   - enhancedInput.acceptanceCriteria — projected from spec.acceptanceCriteria
 *   - enhancedInput.constraints — projected from spec.edgeCases
 *
 * On rejection (approval denied), it returns an input-required TaskResult.
 */

import { randomUUID } from 'node:crypto';
import { resolvePhaseConfig } from '../llm/per-phase-config.ts';
import {
  type SpecArtifact,
  SpecArtifactSchema,
  specToAcceptanceCriteriaList,
  specToConstraintsList,
} from '../spec/spec-artifact.ts';
import type { ExecutionTrace, RoutingDecision, SemanticTaskUnderstanding, TaskInput, TaskResult } from '../types.ts';
import type { PhaseContext, PhaseContinue, PhaseReturn } from './types.ts';
import { Phase } from './types.ts';

export interface SpecResult {
  /** The approved spec (may be undefined if the phase was disabled/bypassed). */
  spec?: SpecArtifact;
  /** Enhanced input with acceptanceCriteria + constraints projected from spec.
   *  Present only when a spec was produced AND approved. */
  enhancedInput?: TaskInput;
  /** Whether the phase ran at all. `skipped=true` means the caller keeps
   *  existing understanding and input unchanged. */
  skipped: boolean;
  /** Machine-readable reason (for observability / test assertions). */
  reason: string;
}

/** Optional override that lets tests inject a deterministic spec producer. */
export interface SpecDrafter {
  draft(input: TaskInput, understanding: SemanticTaskUnderstanding, routing: RoutingDecision): Promise<SpecArtifact>;
}

export interface SpecPhaseOptions {
  /** When set, used instead of the default LLM-backed drafter. Useful for tests. */
  drafter?: SpecDrafter;
  /** Approval risk score — passed to ApprovalGate. Default 0.35. */
  approvalRiskScore?: number;
}

/** Constraint flags recognised by the Spec phase. */
export const SPEC_PHASE_CONSTRAINTS = {
  enable: 'SPEC_PHASE:on',
  disable: 'SPEC_PHASE:off',
} as const;

export function isSpecPhaseForceEnabled(constraints?: readonly string[]): boolean {
  return (constraints ?? []).includes(SPEC_PHASE_CONSTRAINTS.enable);
}

export function isSpecPhaseForceDisabled(constraints?: readonly string[]): boolean {
  return (constraints ?? []).includes(SPEC_PHASE_CONSTRAINTS.disable);
}

/**
 * Decide whether the Spec phase should run for the given input + routing.
 *
 * Rules (Phase A — regression-safe opt-in default):
 *   1. `SPEC_PHASE:off` always wins (kill switch).
 *   2. `SPEC_PHASE:on` enables the phase.
 *   3. Otherwise → disabled.
 *
 * Phase B (follow-up after smoke tests): flip the default to
 * `routing.level >= 1 AND taskDomain === 'code-mutation'`.
 * The `routing` + `understanding` parameters stay in the signature so
 * that change is a single-rule edit, not a signature break.
 */
export function shouldRunSpecPhase(
  input: TaskInput,
  _understanding: SemanticTaskUnderstanding,
  _routing: RoutingDecision,
): boolean {
  if (isSpecPhaseForceDisabled(input.constraints)) return false;
  if (isSpecPhaseForceEnabled(input.constraints)) return true;
  return false;
}

/**
 * Default LLM-backed drafter. Uses an LLM provider at the 'balanced' tier to
 * produce a SpecArtifact-shaped JSON output, then validates it with Zod.
 *
 * When no LLM registry is available (e.g. in tests without stubs), this
 * function throws — callers should gate on `deps.llmRegistry` presence or
 * inject a SpecDrafter via SpecPhaseOptions.
 */
async function draftSpecViaLLM(
  ctx: PhaseContext,
  input: TaskInput,
  understanding: SemanticTaskUnderstanding,
  routing: RoutingDecision,
): Promise<SpecArtifact> {
  const registry = ctx.deps.llmRegistry;
  if (!registry) {
    throw new Error('Spec phase requires an LLMProviderRegistry — none wired into OrchestratorDeps.');
  }
  const provider = registry.selectForRoutingLevel(routing.level) ?? registry.selectByTier('balanced');
  if (!provider) {
    throw new Error('Spec phase: no LLM provider available for structured spec drafting.');
  }

  const systemPrompt = buildSpecSystemPrompt();
  const userPrompt = buildSpecUserPrompt(input, understanding);

  // G3 per-phase sampling: spec drafting is structured + deterministic, so the
  // baseline temperature is low. Operators can dial it via vinyan.json
  // `orchestrator.llm.phases.spec`. Default unchanged from the previous
  // hardcoded 0.2.
  const phaseCfg = resolvePhaseConfig('spec', routing, { temperature: 0.2 });
  const response = await provider.generate({
    systemPrompt,
    userPrompt,
    maxTokens: Math.min(4096, Math.floor(input.budget.maxTokens / 4)),
    ...phaseCfg.sampling,
  });

  const parsed = parseSpecArtifactJSON(response.content);
  return SpecArtifactSchema.parse(parsed);
}

function buildSpecSystemPrompt(): string {
  return [
    'You are Spec Author, a planning specialist for a deterministic code-mutation pipeline.',
    'You produce a single SpecArtifact JSON object that pins down EXACTLY what "done" means for a task BEFORE any code is written.',
    '',
    'The artifact must conform to this shape:',
    '{',
    '  "version": "1",',
    '  "summary": string (5-280 chars),',
    '  "acceptanceCriteria": Array<{ id, description, testable: boolean, oracle: "ast"|"type"|"test"|"lint"|"dep"|"goal-alignment"|"critic"|"manual" }> (1-20 items),',
    '  "apiShape": Array<{ name, kind: "function"|"class"|"endpoint"|"event"|"type", inputs, outputs, invariants }>,',
    '  "dataContracts": Array<{ name, schema, notes? }>,',
    '  "edgeCases": Array<{ id, scenario, expected, severity: "blocker"|"major"|"minor" }>,',
    '  "openQuestions": string[]',
    '}',
    '',
    'Rules:',
    '- Output ONLY the JSON object — no prose, no markdown fences, no commentary.',
    '- Every criterion must be concrete enough that an oracle can verify it mechanically when testable=true.',
    '- Prefer 3-7 acceptance criteria. Fewer than 3 usually means the spec is vague; more than 7 means you should split the task.',
    '- Prefer 0-4 edge cases at severity "blocker" — edge cases that MUST be handled correctly for the feature to be safe to ship.',
    '- Leave openQuestions populated when you lack information — do NOT invent acceptance criteria over uncertainty.',
  ].join('\n');
}

function buildSpecUserPrompt(input: TaskInput, understanding: SemanticTaskUnderstanding): string {
  const lines: string[] = [];
  lines.push(`Goal: ${input.goal}`);
  if (understanding.semanticIntent?.goalSummary) {
    lines.push(`Summary: ${understanding.semanticIntent.goalSummary}`);
  }
  if (understanding.resolvedEntities.length > 0) {
    const paths = understanding.resolvedEntities.flatMap((e) => e.resolvedPaths).filter(Boolean);
    if (paths.length) lines.push(`Relevant files: ${paths.slice(0, 10).join(', ')}`);
  }
  if ((input.constraints ?? []).length > 0) {
    lines.push(`Existing constraints:`);
    for (const c of input.constraints ?? []) lines.push(`  - ${c}`);
  }
  if ((input.acceptanceCriteria ?? []).length > 0) {
    lines.push(`Existing acceptance criteria (refine — do not drop):`);
    for (const c of input.acceptanceCriteria ?? []) lines.push(`  - ${c}`);
  }
  if (understanding.ideation?.approvedCandidateId) {
    const chosen = understanding.ideation.candidates.find((c) => c.id === understanding.ideation?.approvedCandidateId);
    if (chosen) {
      lines.push(`User-approved approach: ${chosen.title} — ${chosen.approach}`);
    }
  }
  lines.push('');
  lines.push('Produce the SpecArtifact JSON now.');
  return lines.join('\n');
}

/**
 * Parse the LLM's content field into an object. Tolerates a single leading
 * prose line before a JSON block, and strips ```json fences. Throws on
 * unparseable content — caller surfaces the error through the phase trace.
 */
export function parseSpecArtifactJSON(content: string): unknown {
  const trimmed = content.trim();
  const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  const body = fenceMatch ? fenceMatch[1]!.trim() : trimmed;
  // Some providers emit `Here is the JSON:\n{...}` — slice from the first `{`.
  const firstBrace = body.indexOf('{');
  const lastBrace = body.lastIndexOf('}');
  if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) {
    throw new Error('Spec drafter returned no JSON object.');
  }
  return JSON.parse(body.slice(firstBrace, lastBrace + 1));
}

/**
 * Execute the Spec phase.
 *
 * Responsibility:
 *   1. Gate the phase (see shouldRunSpecPhase).
 *   2. Draft a SpecArtifact (via injected drafter or default LLM call).
 *   3. Request human approval (when approvalGate is wired).
 *   4. Project criteria + edge cases into an enhancedInput.
 *   5. Return PhaseContinue({ spec, enhancedInput }) or PhaseReturn(input-required).
 *
 * Errors in drafting degrade to `skipped=true` so the pipeline still runs —
 * the spec phase is additive, not load-bearing.
 */
export async function executeSpecPhase(
  ctx: PhaseContext,
  routing: RoutingDecision,
  understanding: SemanticTaskUnderstanding,
  options: SpecPhaseOptions = {},
): Promise<PhaseContinue<SpecResult> | PhaseReturn> {
  const { input, deps } = ctx;

  if (!shouldRunSpecPhase(input, understanding, routing)) {
    return Phase.continue({ skipped: true, reason: 'gated-off' });
  }

  const startedAt = Date.now();
  let spec: SpecArtifact;
  try {
    spec = options.drafter
      ? await options.drafter.draft(input, understanding, routing)
      : await draftSpecViaLLM(ctx, input, understanding, routing);
  } catch (err) {
    deps.bus?.emit('spec:drafting_failed', {
      taskId: input.id,
      reason: err instanceof Error ? err.message : String(err),
      durationMs: Date.now() - startedAt,
    });
    // Degraded: skip the phase; downstream keeps working with raw goal.
    return Phase.continue({ skipped: true, reason: 'drafting-failed' });
  }

  deps.bus?.emit('spec:drafted', {
    taskId: input.id,
    criteriaCount: spec.acceptanceCriteria.length,
    edgeCaseCount: spec.edgeCases.length,
    openQuestionCount: spec.openQuestions.length,
    durationMs: Date.now() - startedAt,
  });

  // ── Human approval (A6) ──────────────────────────────────────────
  if (deps.approvalGate) {
    const decision = await deps.approvalGate.requestApproval(
      input.id,
      options.approvalRiskScore ?? 0.35,
      `Spec approval: ${spec.summary}`,
    );
    if (decision === 'rejected') {
      deps.bus?.emit('spec:rejected', { taskId: input.id, reason: 'user-rejected' });
      return Phase.return(buildSpecRejectedResult(input, spec, routing, startedAt));
    }
  }

  // Mark approval — timestamps let downstream phases tell an approved spec
  // from one that bypassed the gate (e.g. in tests without ApprovalGate).
  const approvedSpec: SpecArtifact = {
    ...spec,
    approvedBy: spec.approvedBy ?? (deps.approvalGate ? 'human' : 'auto'),
    approvedAt: spec.approvedAt ?? Date.now(),
  };

  deps.bus?.emit('spec:approved', {
    taskId: input.id,
    approvedBy: approvedSpec.approvedBy ?? 'unknown',
    criteriaCount: approvedSpec.acceptanceCriteria.length,
  });

  const enhancedInput = projectSpecIntoInput(input, approvedSpec);
  return Phase.continue({ spec: approvedSpec, enhancedInput, skipped: false, reason: 'approved' });
}

/**
 * Merge SpecArtifact-derived acceptance criteria and constraints into a
 * shallow clone of the input. Existing user-supplied values are preserved
 * and appended to — the spec augments, never overwrites.
 */
export function projectSpecIntoInput(input: TaskInput, spec: SpecArtifact): TaskInput {
  const specCriteria = specToAcceptanceCriteriaList(spec);
  const specConstraints = specToConstraintsList(spec);

  const mergedCriteria = dedupeStrings([...(input.acceptanceCriteria ?? []), ...specCriteria]);
  const mergedConstraints = dedupeStrings([...(input.constraints ?? []), ...specConstraints]);

  return {
    ...input,
    acceptanceCriteria: mergedCriteria.length > 0 ? mergedCriteria : input.acceptanceCriteria,
    constraints: mergedConstraints.length > 0 ? mergedConstraints : input.constraints,
  };
}

function dedupeStrings(items: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const s of items) {
    const trimmed = s.trim();
    if (trimmed.length === 0) continue;
    if (seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

function buildSpecRejectedResult(
  input: TaskInput,
  spec: SpecArtifact,
  routing: RoutingDecision,
  startedAt: number,
): TaskResult {
  const trace: ExecutionTrace = {
    id: `trace-${input.id}-spec-rejected-${randomUUID().slice(0, 8)}`,
    taskId: input.id,
    sessionId: input.sessionId,
    workerId: 'orchestrator',
    timestamp: Date.now(),
    routingLevel: routing.level,
    approach: 'spec-rejected',
    approachDescription: `Human rejected drafted spec: ${spec.summary}`,
    oracleVerdicts: { spec: false },
    modelUsed: 'orchestrator',
    tokensConsumed: 0,
    durationMs: Date.now() - startedAt,
    outcome: 'success',
    affectedFiles: input.targetFiles ?? [],
  };
  return {
    id: input.id,
    status: 'input-required',
    mutations: [],
    trace,
    clarificationNeeded: [
      'The drafted specification was rejected. Please refine the goal or answer the open questions and retry.',
      ...spec.openQuestions.slice(0, 5),
    ],
  };
}
