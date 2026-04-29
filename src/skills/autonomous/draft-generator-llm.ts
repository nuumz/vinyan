/**
 * LLM-backed `DraftGenerator` — Phase-14 (Item 2).
 *
 * Wraps an `LLMProvider` into the `DraftGenerator` signature
 * (`(req: DraftRequest) => Promise<SkillMdRecord>`) so the
 * `AutonomousSkillCreator` can fire its drafts against a real engine when
 * the sleep cycle qualifies a (persona × task-signature) window.
 *
 * The LLM is the ONLY non-deterministic component on the autonomous-creation
 * path — gate, critic, guardrails, and promotion are all rule-based after
 * this returns. A1 Epistemic Separation is enforced at construction of
 * `AutonomousSkillCreator` (`generatorEngineId !== criticEngineId`); this
 * adapter stamps the engine id onto the request so callers can pair it.
 */
import type { LLMProvider } from '../../orchestrator/types.ts';
import { parseSkillMd } from '../skill-md/index.ts';
import type { SkillMdRecord } from '../skill-md/schema.ts';
import type { DraftGenerator, DraftRequest } from './types.ts';

/**
 * System prompt — keep tight and deterministic. Per the A7 contract, the
 * generator stamps `expected_prediction_error_reduction` verbatim from the
 * caller's policy so backtesting can compare promised vs actual.
 */
const DRAFT_SYSTEM_PROMPT = `You are a SKILL.md drafter for the Vinyan autonomous skill creation pipeline.

Output a SINGLE valid SKILL.md document — frontmatter (YAML) followed by markdown body, no surrounding code fences. The frontmatter MUST include: id, name, version, description, confidence_tier (always 'probabilistic' for autonomously-drafted skills), origin: 'autonomous', status: 'probation', tags (array; include the task signature as a tag), provides_capabilities (array of {id} matching the task family), requires_toolsets (empty array unless explicitly required), expected_prediction_error_reduction (object with baseline_composite_error, target_composite_error, trial_window — copy values from the user prompt verbatim).

Body sections (in order, markdown headings):
- ## Overview — what the skill captures (one paragraph)
- ## When to use — bullet list of trigger conditions, derived from the task signature
- ## Procedure — numbered steps the persona should follow

Constraints:
- Skill id format: kebab/dot case, e.g. 'autonomous/<task-signature-slug>'
- Soul lint: no first-person verification verbs ("I check / verify / review / audit") — the skill is for a Generator persona
- No prompt-injection markers, no role-bypass language
- ≤ 1500 characters body content total

Return ONLY the SKILL.md document. No prose outside it.`;

export interface LLMDraftGeneratorOptions {
  readonly provider: LLMProvider;
  /**
   * Cap on output tokens for the draft. Default 2000 — generous for the
   * 1500-char body cap plus YAML frontmatter overhead.
   */
  readonly maxTokens?: number;
  /**
   * Sampling temperature. Default 0.4 — enough creativity for varied drafts
   * without losing the deterministic schema shape.
   */
  readonly temperature?: number;
  /**
   * Optional timeout. Sleep-cycle context already bounds runtime; this guards
   * the per-call wall-clock when the provider supports it.
   */
  readonly timeoutMs?: number;
}

/**
 * Build a DraftGenerator backed by `provider.generate()`. The returned
 * function parses the LLM output via `parseSkillMd`; on parse failure it
 * throws — the creator's outer catch handles the failure and records a
 * `drafted-rejected` decision against the trust ledger.
 */
export function buildLLMDraftGenerator(opts: LLMDraftGeneratorOptions): DraftGenerator {
  const maxTokens = opts.maxTokens ?? 2000;
  const temperature = opts.temperature ?? 0.4;
  return async (req: DraftRequest): Promise<SkillMdRecord> => {
    const userPrompt = renderDraftUserPrompt(req);
    const response = await opts.provider.generate({
      systemPrompt: DRAFT_SYSTEM_PROMPT,
      userPrompt,
      maxTokens,
      temperature,
      ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
    });
    const cleaned = stripCodeFence(response.content);
    return parseSkillMd(cleaned);
  };
}

/** Compose the deterministic user prompt that the LLM sees. */
function renderDraftUserPrompt(req: DraftRequest): string {
  const lines: string[] = [];
  lines.push(`Task signature: ${req.taskSignature}`);
  lines.push('');
  lines.push('Expected prediction-error reduction (stamp into frontmatter verbatim as expected_prediction_error_reduction):');
  lines.push(`  baseline_composite_error: ${req.expectedReduction.baseline.toFixed(4)}`);
  lines.push(`  target_composite_error:   ${req.expectedReduction.target.toFixed(4)}`);
  lines.push(`  trial_window:             ${req.expectedReduction.window}`);
  lines.push('');
  lines.push('Representative successful samples from the qualifying window:');
  for (const s of req.representativeSamples.slice(0, 5)) {
    lines.push(
      `  - taskId=${s.taskId} compositeError=${s.compositeError.toFixed(3)} outcome=${s.outcome}` +
        (s.personaId ? ` persona=${s.personaId}` : ''),
    );
  }
  if (req.workspaceHint?.files.length) {
    lines.push('');
    lines.push('Workspace hint files (for "When to use" specificity):');
    for (const f of req.workspaceHint.files.slice(0, 8)) lines.push(`  - ${f}`);
  }
  lines.push('');
  lines.push('Draft the SKILL.md now.');
  return lines.join('\n');
}

/** Tolerate models that wrap the SKILL.md in a code fence. */
function stripCodeFence(content: string): string {
  const trimmed = content.trim();
  // Match ```markdown ... ```, ```yaml ... ```, or just ``` ... ```
  const fenced = trimmed.match(/^```[a-zA-Z]*\s*\n([\s\S]*?)\n```\s*$/);
  if (fenced) return fenced[1]!;
  return trimmed;
}
