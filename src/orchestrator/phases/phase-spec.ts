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
 * The phase is enabled for code-mutation tasks at L1+:
 *   - TaskInput.constraints contains `SPEC_PHASE:on`, or
 *   - SemanticTaskUnderstanding.taskDomain === 'code-mutation' and routing.level >= 1.
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
import { applyRoutingGovernance } from '../governance-provenance.ts';
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
 * Rules:
 *   1. `SPEC_PHASE:off` always wins (kill switch).
 *   2. `SPEC_PHASE:on` enables the phase (variant chosen by selectSpecVariant).
 *   3. code-mutation tasks at L1+ run the code variant by default.
 *   4. code-reasoning / general-reasoning tasks at L2+ run the reasoning
 *      variant by default (Gap C, 2026-04-28). L0/L1 reasoning skips the
 *      phase to avoid the per-call latency tax — these tasks are typically
 *      direct lookups.
 *   5. conversational tasks never run the spec phase by default.
 */
export function shouldRunSpecPhase(
  input: TaskInput,
  understanding: SemanticTaskUnderstanding,
  routing: RoutingDecision,
): boolean {
  if (isSpecPhaseForceDisabled(input.constraints)) return false;
  if (isSpecPhaseForceEnabled(input.constraints)) return true;
  if (understanding.taskDomain === 'code-mutation' && routing.level >= 1) return true;
  if (
    (understanding.taskDomain === 'code-reasoning' || understanding.taskDomain === 'general-reasoning') &&
    routing.level >= 2
  ) {
    return true;
  }
  return false;
}

/**
 * Choose which spec variant to draft for a given task. Pure function so it
 * can be unit-tested independently of the LLM drafter.
 *
 * - `code-mutation` → 'code' (existing apiShape / dataContracts schema).
 * - everything else → 'reasoning' (deliverables / scope-boundaries schema).
 */
export function selectSpecVariant(understanding: SemanticTaskUnderstanding): 'code' | 'reasoning' {
  return understanding.taskDomain === 'code-mutation' ? 'code' : 'reasoning';
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
  const variant = selectSpecVariant(understanding);
  const promptPair =
    variant === 'reasoning'
      ? {
          system: buildSpecSystemPromptReasoning(),
          user: buildSpecUserPromptReasoning(input, understanding),
        }
      : {
          system: systemPrompt,
          user: userPrompt,
        };
  const response = await provider.generate({
    systemPrompt: promptPair.system,
    userPrompt: promptPair.user,
    maxTokens: Math.min(4096, Math.floor(input.budget.maxTokens / 4)),
    ...phaseCfg.sampling,
  });

  const parsed = parseSpecArtifactJSON(response.content);
  // The reasoning prompt instructs the LLM to set `variant: 'reasoning'`,
  // but defensively normalise so a forgetful LLM still parses through the
  // discriminated union (preprocess defaults missing variant to 'code',
  // which would mis-route).
  if (
    variant === 'reasoning' &&
    parsed &&
    typeof parsed === 'object' &&
    !('variant' in (parsed as Record<string, unknown>))
  ) {
    (parsed as Record<string, unknown>).variant = 'reasoning';
  }
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

// ── Reasoning-variant prompt builders (Gap C, 2026-04-28) ─────────────

function buildSpecSystemPromptReasoning(): string {
  return [
    'You are Spec Author for a reasoning / analysis / planning task — NOT a code-mutation task.',
    'You produce a single SpecArtifact JSON object that pins down EXACTLY what a "good answer" looks like BEFORE the answer is written.',
    '',
    'The artifact MUST conform to this shape:',
    '{',
    '  "version": "1",',
    '  "variant": "reasoning",',
    '  "summary": string (5-280 chars),',
    '  "acceptanceCriteria": Array<{ id, description, testable: boolean, oracle: "goal-alignment"|"critic"|"manual" }> (1-7 items),',
    '  "expectedDeliverables": Array<{ kind: "answer"|"plan"|"analysis"|"recommendation"|"comparison", audience: string, format: "prose"|"list"|"table"|"diagram-spec", minDepth?: "shallow"|"deep" }> (1-3 items),',
    '  "scopeBoundaries": { "outOfScope": string[] (0-5), "assumptions": string[] (0-5) },',
    '  "edgeCases": Array<{ id, scenario, expected, severity: "blocker"|"major"|"minor" }> (0-4),',
    '  "openQuestions": string[]',
    '}',
    '',
    'Rules:',
    '- Output ONLY the JSON object — no prose, no markdown fences, no commentary.',
    '- `variant` MUST be the literal string "reasoning".',
    '- Acceptance criteria for reasoning tasks are graded by goal-alignment (semantic), critic (subjective quality), or manual (human review). Mechanical oracles (ast/type/test/lint/dep) are NOT valid here.',
    '- Prefer 2-5 acceptance criteria; 7 is a hard ceiling — more usually means the task should be split.',
    '- `expectedDeliverables` describes WHAT the consumer expects to read. `audience` is mandatory (e.g. "engineer", "ops on-call", "executive").',
    '- `scopeBoundaries.outOfScope` is your topical guardrail — list things the answer MUST NOT pivot into. The downstream constraint pipeline turns these into `MUST: out-of-scope: …` rules.',
    '- `scopeBoundaries.assumptions` lists premises the answer takes for granted; downstream becomes `ASSUME: …` constraints.',
    '- Leave `openQuestions` populated when you lack information — do NOT invent acceptance criteria over uncertainty.',
  ].join('\n');
}

function buildSpecUserPromptReasoning(input: TaskInput, understanding: SemanticTaskUnderstanding): string {
  const lines: string[] = [];
  lines.push(`Goal: ${input.goal}`);
  if (understanding.semanticIntent?.goalSummary) {
    lines.push(`Summary: ${understanding.semanticIntent.goalSummary}`);
  }
  lines.push(`Task domain: ${understanding.taskDomain}`);
  if ((input.constraints ?? []).length > 0) {
    lines.push('Existing constraints:');
    for (const c of input.constraints ?? []) lines.push(`  - ${c}`);
  }
  if ((input.acceptanceCriteria ?? []).length > 0) {
    lines.push('Existing acceptance criteria (refine — do not drop):');
    for (const c of input.acceptanceCriteria ?? []) lines.push(`  - ${c}`);
  }
  lines.push('');
  lines.push('Produce the reasoning-variant SpecArtifact JSON now.');
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
  const trace: ExecutionTrace = applyRoutingGovernance({
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
  }, routing);
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
