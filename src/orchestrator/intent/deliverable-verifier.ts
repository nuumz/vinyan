/**
 * Deliverable verifier — narrow second-stage LLM call that asks a single
 * focused question: "Would the user-acceptable answer to this goal contain
 * a publishable artifact?"
 *
 * Embodies Axiom A1 (epistemic separation): this is a SEPARATE LLM call
 * from the primary intent classifier — different prompt, smaller token
 * budget, lower-tier provider preference. Generation (primary) and
 * verification (this module) cannot collude because they run in different
 * inference contexts.
 *
 * Design choice: a binary verifier outperforms re-running the multi-class
 * classifier because the question is structurally simpler. A "yes/no on
 * deliverable" is much easier for an LLM than "pick one of four
 * orchestration strategies"; the success rate of narrow questions is
 * empirically higher even on weaker tiers, so we run the verifier on the
 * `fast` tier by preference and save the marginal cost.
 */

import { z } from 'zod';
import type { LLMProviderRegistry } from '../llm/provider-registry.ts';
import type { LLMProvider } from '../types.ts';
import { withTimeout } from './parser.ts';

export const DeliverableVerdictSchema = z.object({
  isDeliverable: z.boolean(),
  /** Best-fit artifact label, e.g. "novel-chapter", "report", "code-module". Free-form. */
  artifactKind: z.string().optional(),
  /** Estimated section/chapter count when the user named one. Optional grounding. */
  estimatedSections: z.number().int().min(0).optional(),
  /** One-sentence justification (English, terse) — surfaces in bus events. */
  reason: z.string(),
});

export type DeliverableVerdict = z.infer<typeof DeliverableVerdictSchema>;

/** Wall-clock cap for the verifier call. Smaller than the primary classifier (8s). */
export const VERIFIER_TIMEOUT_MS = 5000;
/** Token budget — verifier replies are tiny JSON objects. */
export const VERIFIER_MAX_TOKENS = 200;
/** Tier preference for the verifier. `fast` is intentionally first — cheaper than primary. */
export const VERIFIER_TIER_PREFERENCE: ReadonlyArray<LLMProvider['tier']> = ['fast', 'tool-uses', 'balanced'];

const VERIFIER_SYSTEM_PROMPT = `You verify whether a user goal requires producing a publishable artifact.

A "publishable artifact" is any output the user would copy, paste, or publish:
  - prose ≥3 paragraphs (story chapter, article, essay, blog post)
  - multi-section reports or specifications
  - multi-chapter or multi-scene creative writing
  - runnable code modules or full file contents
  - slide decks, outlines, structured plans

NOT publishable artifacts:
  - greetings, small talk, thanks
  - single-sentence factual answers
  - short Q&A or definitions ("what is X")
  - meta-questions about your capabilities
  - acknowledgments, confirmations

Reply ONLY with valid JSON, no markdown fences:
{
  "isDeliverable": true|false,
  "artifactKind": "<short label, e.g. novel-chapter, report, code-module>",
  "estimatedSections": <integer if the user named a count, otherwise omit>,
  "reason": "<one-sentence justification>"
}`;

/**
 * Pick the cheapest available provider for the verifier. Falls back through
 * the tier ordering; returns `null` only when the registry is empty.
 */
export function pickVerifierProvider(registry: LLMProviderRegistry): LLMProvider | null {
  for (const tier of VERIFIER_TIER_PREFERENCE) {
    const p = registry.selectByTier(tier);
    if (p) return p;
  }
  return null;
}

/**
 * Strip markdown fences then parse + validate. Throws on malformed JSON or
 * schema violation; the caller (intent-resolver) catches and treats failure
 * as "do not override" — the original verdict survives.
 */
function parseVerifierResponse(content: string): DeliverableVerdict {
  const stripped = content.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  return DeliverableVerdictSchema.parse(JSON.parse(stripped));
}

/**
 * Run the verifier against the user goal. The primary classifier's reasoning
 * is passed as additional grounding so the verifier can disagree with
 * specific claims rather than re-deriving from scratch.
 */
export async function verifyDeliverable(
  registry: LLMProviderRegistry,
  goal: string,
  primaryReasoning: string,
): Promise<DeliverableVerdict> {
  const provider = pickVerifierProvider(registry);
  if (!provider) throw new Error('No LLM provider available for deliverable verifier');

  const userPrompt = `User goal: "${goal}"

Primary classifier said: "${primaryReasoning ?? '(no reasoning provided)'}"

Verify: would a user-acceptable answer to this goal contain a publishable artifact as defined? Reply JSON only.`;

  const response = await withTimeout(
    provider.generate({
      systemPrompt: VERIFIER_SYSTEM_PROMPT,
      userPrompt,
      maxTokens: VERIFIER_MAX_TOKENS,
      temperature: 0,
    }),
    VERIFIER_TIMEOUT_MS,
  );

  return parseVerifierResponse(response.content);
}

/**
 * Build a workflow prompt for downstream agentic-workflow execution when the
 * verifier overrides a conversational verdict. Deterministic — does NOT call
 * the LLM (A3: governance synthesis stays rule-based).
 *
 * The prompt mentions the artifact kind and estimated section count when the
 * verifier supplied them, so the workflow planner has structural grounding
 * without re-asking the user.
 */
export function synthesizeWorkflowPromptFromGoal(
  goal: string,
  verdict: Pick<DeliverableVerdict, 'artifactKind' | 'estimatedSections'>,
): string {
  const trimmedGoal = goal.trim();
  const parts: string[] = [`Original user request: ${trimmedGoal}`];
  if (verdict.artifactKind) {
    parts.push(`Expected artifact: ${verdict.artifactKind}.`);
  }
  if (typeof verdict.estimatedSections === 'number' && verdict.estimatedSections > 0) {
    parts.push(`Approximate scope: ${verdict.estimatedSections} section(s) / chapter(s).`);
  }
  parts.push(
    'Produce the deliverable directly — the orchestrator already verified this is not a chat reply. Match the user\'s language and tone. If domain-critical context is missing (audience, format, length cap), surface a single concise clarification instead of guessing.',
  );
  return parts.join('\n');
}
