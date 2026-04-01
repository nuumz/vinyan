import type { LLMProvider, LLMRequest, PerceptualHierarchy, TaskInput } from '../types.ts';
import type { CriticEngine, CriticResult, WorkerProposal } from './critic-engine.ts';

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
  ): Promise<CriticResult> {
    const systemPrompt = buildCriticSystemPrompt();
    const userPrompt = buildCriticUserPrompt(proposal, task, perception, acceptanceCriteria);

    const request: LLMRequest = {
      systemPrompt,
      userPrompt,
      maxTokens: 2048,
      temperature: 0.1,
    };

    let response;
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
You are an independent code reviewer in the Vinyan Epistemic Nervous System.
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

[RULES]
- Set "approved" to false if ANY critical aspect fails (logic_correctness or requirement_coverage).
- Set "approved" to true only if the proposal is safe to commit.
- Be concise in explanations — focus on actionable feedback.
- Respond ONLY with the JSON object, no markdown fences or other text.`;
}

function buildCriticUserPrompt(
  proposal: WorkerProposal,
  task: TaskInput,
  perception: PerceptualHierarchy,
  acceptanceCriteria?: string[],
): string {
  const sections: string[] = [];

  sections.push(`[TASK GOAL]\n${task.goal}`);

  if (acceptanceCriteria && acceptanceCriteria.length > 0) {
    const criteria = acceptanceCriteria.map((c, i) => `  ${i + 1}. ${c}`).join('\n');
    sections.push(`[ACCEPTANCE CRITERIA]\n${criteria}`);
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
