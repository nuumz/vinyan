import type { LLMProvider, LLMRequest, PerceptualHierarchy, TaskInput } from '../types.ts';
import type { CriticContext, CriticEngine, CriticResult, WorkerProposal } from './critic-engine.ts';

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export class LLMCriticImpl implements CriticEngine {
  constructor(private readonly provider: LLMProvider) {}

  async review(
    proposal: WorkerProposal,
    task: TaskInput,
    perception: PerceptualHierarchy,
    acceptanceCriteria?: string[],
    // Wave 5.1: accepted by the baseline; consumed by debate-mode wrapper.
    // Slice 4: now also consumed here to render the [PRIOR ITERATION RESULT]
    // block when the outer loop has already evaluated a previous attempt.
    context?: CriticContext,
  ): Promise<CriticResult> {
    const systemPrompt = buildCriticSystemPrompt();
    const userPrompt = buildCriticUserPrompt(proposal, task, perception, acceptanceCriteria, context);

    const request: LLMRequest = {
      systemPrompt,
      userPrompt,
      maxTokens: 2048,
      temperature: 0.1,
    };

    // Wave 5.1 lint hygiene: explicit type annotation so biome's
    // `noImplicitAnyLet` doesn't flag this pre-existing pattern now
    // that the file is being touched.
    let response: import('../types.ts').LLMResponse;
    try {
      response = await this.provider.generate(request);
    } catch {
      return failClosedResult();
    }

    const tokensUsed = response.tokensUsed;
    const parsed = parseCriticResponse(response.content);
    if (!parsed) {
      return failClosedResult(tokensUsed);
    }

    // A5: Confidence = count of passed aspects / total aspects (NOT LLM self-assessment)
    const passedCount = parsed.aspects.filter((a) => a.passed).length;
    const confidence = parsed.aspects.length > 0 ? passedCount / parsed.aspects.length : 0.3;

    return {
      approved: parsed.approved,
      confidence,
      aspects: parsed.aspects,
      reason: parsed.reason,
      verdicts: {},
      tokensUsed,
    };
  }
}

// ---------------------------------------------------------------------------
// Prompt construction
// ---------------------------------------------------------------------------

function buildCriticSystemPrompt(): string {
  return `[ROLE]
You are an independent code reviewer in Vinyan, an autonomous orchestrator powered by Epistemic Orchestration.
You did NOT generate this code. Your role is to evaluate proposals made by a separate worker.
You must be objective and thorough — do NOT rubber-stamp proposals.

[OUTPUT FORMAT]
Respond with a single JSON object matching this exact structure:
{
  "approved": boolean,
  "aspects": [
    { "name": "requirement_coverage", "passed": boolean, "explanation": "brief note" },
    { "name": "logic_correctness", "passed": boolean, "explanation": "brief note" },
    { "name": "side_effects", "passed": boolean, "explanation": "brief note" },
    { "name": "completeness", "passed": boolean, "explanation": "brief note" },
    { "name": "consistency", "passed": boolean, "explanation": "brief note" }
  ],
  "reason": "brief overall assessment"
}

[RUBRIC]
- requirement_coverage: Do the mutations address all aspects of the stated goal?
- logic_correctness: Is the logic sound? Are there off-by-one errors, null derefs, or logic gaps?
- side_effects: Could these changes break existing functionality outside the target scope?
- completeness: Are there missing edge cases, error handling, or incomplete implementations?
- consistency: Are the changes consistent with the existing codebase patterns and conventions?

[ACCOUNTABILITY RUBRIC]
- Grade A: all Definition of Done criteria are addressed, verification evidence exists, and no critical uncertainty remains.
- Grade B: core goal is achieved with minor disclosed caveats that do not violate constraints.
- Grade C: any missing criterion, failed/absent verification, scope drift, hidden uncertainty, or unsafe side effect.
- Reject Grade C proposals. Requirement coverage and logic correctness failures are always Grade C.
- Do not treat the generator's confidence or explanation as evidence; use proposed mutations, task criteria, and context.

[RULES]
- Set "approved" to false if ANY critical aspect fails (logic_correctness or requirement_coverage).
- Set "approved" to true only if the proposal is safe to commit.
- Be concise in explanations — focus on actionable feedback.
- Anti-sycophancy: do NOT be agreeable for the sake of agreement. When a [HISTORICAL EVIDENCE] block lists prior failures, surface the strongest counter-evidence FIRST and require an explicit defense of why this attempt is different — otherwise reject.
- Respond ONLY with the JSON object, no markdown fences or other text.`;
}

function buildCriticUserPrompt(
  proposal: WorkerProposal,
  task: TaskInput,
  perception: PerceptualHierarchy,
  acceptanceCriteria?: string[],
  context?: CriticContext,
): string {
  const sections: string[] = [];

  sections.push(`[TASK GOAL]\n${task.goal}`);

  if (acceptanceCriteria && acceptanceCriteria.length > 0) {
    const criteria = acceptanceCriteria.map((c, i) => `  ${i + 1}. ${c}`).join('\n');
    sections.push(`[ACCEPTANCE CRITERIA]\n${criteria}`);
  }

  // Slice 4: surface the previous iteration's deterministic verdict so the
  // reviewer is anchored on what was already wrong. Only emitted when the
  // outer loop has actually evaluated a prior attempt (iteration ≥ 2).
  if (context?.priorAccountabilityGrade) {
    const blockerLine =
      context.priorBlockerCategories && context.priorBlockerCategories.length > 0
        ? `\nBlocker categories: ${context.priorBlockerCategories.join(', ')}`
        : '';
    sections.push(
      `[PRIOR ITERATION RESULT]\nDeterministic accountability grade: ${context.priorAccountabilityGrade}${blockerLine}\nIf this proposal does not address those blockers, it CANNOT be Grade A or B. Reject if the same failure pattern is repeated.`,
    );
  }

  // Slice 4 follow-up: when the worker was overconfident on the previous
  // iteration, prime the critic to scrutinize self-graded A's more harshly.
  // Underconfidence is logged as observability but does NOT relax the bar —
  // the critic should never be told "the worker is too humble, be lenient".
  if (context?.priorPredictionError && context.priorPredictionError.direction === 'overconfident') {
    const { selfGrade, deterministicGrade, magnitude } = context.priorPredictionError;
    sections.push(
      `[CALIBRATION WARNING]\nOn the previous iteration, the worker self-graded ${selfGrade} but the deterministic evaluator awarded ${deterministicGrade} (${magnitude} overconfidence). Treat the worker's current self-assessment as suspect: require concrete evidence (passing oracles, satisfied acceptance criteria) before accepting any self-claim of Grade A.`,
    );
  }

  // C1: historical adversary — render aggregated prior failures + base-rate
  // outcome counts so the reviewer can pressure-test against past attempts.
  // Only emitted when the orchestrator opts in by populating the context
  // (off-by-default — does not change behavior for existing callers).
  const historicalSection = renderHistoricalEvidence(context);
  if (historicalSection) {
    sections.push(historicalSection);
  }

  const mutationSummary = proposal.mutations.map((m) => `--- ${m.file} ---\n${m.content}`).join('\n\n');
  sections.push(`[PROPOSED MUTATIONS]\n${mutationSummary}`);

  if (proposal.approach) {
    sections.push(`[APPROACH]\n${proposal.approach}`);
  }

  sections.push(`[CONTEXT]
Target: ${perception.taskTarget.file} — ${perception.taskTarget.description}
Blast radius: ${perception.dependencyCone.transitiveBlastRadius} files`);

  return sections.join('\n\n');
}

// ---------------------------------------------------------------------------
// C1: historical-evidence renderer
// ---------------------------------------------------------------------------

/**
 * Cap per-section size to keep the critic prompt bounded. The critic budget
 * is 2048 output tokens (response) + free-form input — but blowing the input
 * with adversarial history would push out the proposed mutations, so we cap.
 */
const HISTORICAL_FAILED_APPROACHES_CAP = 5;
const HISTORICAL_APPROACH_LABEL_CAP = 120;

function renderHistoricalEvidence(context: CriticContext | undefined): string | null {
  if (!context) return null;
  const failures = context.priorFailedApproaches ?? [];
  const summary = context.priorTraceSummary;
  if (failures.length === 0 && !summary) return null;

  const lines: string[] = ['[HISTORICAL EVIDENCE — pressure-test against past attempts]'];

  if (failures.length > 0) {
    const top = [...failures].sort((a, b) => b.occurrences - a.occurrences).slice(0, HISTORICAL_FAILED_APPROACHES_CAP);
    lines.push('Recent failed approaches for this task signature (highest occurrence first):');
    for (const f of top) {
      const label = truncate(f.approach, HISTORICAL_APPROACH_LABEL_CAP);
      const noun = f.occurrences === 1 ? 'time' : 'times';
      lines.push(`  - "${label}" → failed at "${f.failureOracle}" (${f.occurrences} ${noun})`);
    }
  }

  if (summary && summary.totalAttempts > 0) {
    const escalation =
      typeof summary.mostCommonEscalation === 'number' ? `, modal escalation L${summary.mostCommonEscalation}` : '';
    lines.push(
      `Base rate: ${summary.successCount}/${summary.totalAttempts} succeeded` +
        ` (${summary.failureCount} failed${escalation}).`,
    );
  }

  lines.push(
    'If this proposal repeats any approach above, you MUST flag it explicitly and require evidence of why this attempt is different — otherwise reject.',
  );

  return lines.join('\n');
}

function truncate(s: string, cap: number): string {
  if (s.length <= cap) return s;
  return `${s.slice(0, cap - 1)}…`;
}

// ---------------------------------------------------------------------------
// Response parsing
// ---------------------------------------------------------------------------

interface ParsedCriticResponse {
  approved: boolean;
  aspects: Array<{ name: string; passed: boolean; explanation: string }>;
  reason?: string;
}

function parseCriticResponse(content: string): ParsedCriticResponse | null {
  try {
    let jsonStr = content.trim();
    const fenceMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fenceMatch) {
      jsonStr = fenceMatch[1]?.trim() ?? jsonStr;
    }

    const parsed = JSON.parse(jsonStr);
    if (typeof parsed.approved !== 'boolean') return null;
    if (!Array.isArray(parsed.aspects)) return null;

    const aspects: Array<{ name: string; passed: boolean; explanation: string }> = [];
    for (const aspect of parsed.aspects) {
      if (typeof aspect.name !== 'string' || typeof aspect.passed !== 'boolean') return null;
      aspects.push({
        name: aspect.name,
        passed: aspect.passed,
        explanation: typeof aspect.explanation === 'string' ? aspect.explanation : '',
      });
    }

    return {
      approved: parsed.approved,
      aspects,
      reason: typeof parsed.reason === 'string' ? parsed.reason : undefined,
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Fail-closed fallback (A2: "I don't know" is a valid state, not approval)
// ---------------------------------------------------------------------------

const RUBRIC_ASPECTS = [
  'requirement_coverage',
  'logic_correctness',
  'side_effects',
  'completeness',
  'consistency',
] as const;

function failClosedResult(tokensUsed = { input: 0, output: 0 }): CriticResult {
  return {
    approved: false,
    confidence: 0.3,
    aspects: RUBRIC_ASPECTS.map((name) => ({ name, passed: false, explanation: 'critic unavailable — fail-closed' })),
    reason: 'Critic response could not be parsed — fail-closed per A2 (uncertainty is not approval)',
    verdicts: {},
    tokensUsed,
  };
}
