/**
 * LLM client for the intent resolver — system prompt, provider picker,
 * and single-shot + fallback classification.
 *
 * Extracted from `src/orchestrator/intent-resolver.ts` (plan commit D8).
 *
 * Responsibilities:
 *   - hold the canonical intent-classifier system prompt (few-shot examples
 *     + CRITICAL discrimination rules + USER PREFERENCE OVERRIDE spec)
 *   - pick the primary provider by tier preference (balanced → tool-uses → fast)
 *   - race a single classifier call against a timeout
 *   - on failure, retry once with an alternate provider
 *
 * Pure surface — no cache mutation, no bus emit. Those stay in the
 * main resolver so tier concerns don't leak here.
 */

import type { z } from 'zod';
import type { LLMProvider } from '../types.ts';
import type { LLMProviderRegistry } from '../llm/provider-registry.ts';
import {
  IntentResponseSchema,
  normalizeDirectToolCall,
  parseIntentResponse,
  withTimeout,
} from './parser.ts';

/**
 * Canonical intent-classifier system prompt. Contains:
 *   - JSON response contract
 *   - Strategy definitions + CRITICAL discrimination rules
 *   - Tool allowlist the parser will accept
 *   - Canonical few-shot examples covering keyword-collision edge cases
 *   - USER PREFERENCE OVERRIDE spec
 *
 * Changes here must keep the examples aligned with `normalizeDirectToolCall`'s
 * KNOWN_TOOLS set (see parser.ts) — the prompt documents what the parser
 * will accept, not the other way around.
 */
export const INTENT_SYSTEM_PROMPT = `You are an intent classifier for Vinyan, a task orchestrator.
Given a user's goal, determine the execution strategy.

Respond as JSON with these fields:
- strategy: one of "full-pipeline" | "direct-tool" | "conversational" | "agentic-workflow"
- refinedGoal: restate the goal clearly and precisely (in the same language as the user)
- reasoning: brief explanation of your classification (1 sentence, English)
- directToolCall: (only if strategy="direct-tool") { "tool": "<tool_name>", "parameters": {...} }
- workflowPrompt: (only if strategy="agentic-workflow") a detailed, step-by-step execution prompt for the downstream agent

Strategy definitions:
- "conversational": SHORT greetings, simple factual Q&A answerable in 1-3 sentences, meta-questions about capabilities. The response is brief and needs no planning or generation effort.
- "direct-tool": a SINGLE fire-and-forget action with no expected textual output — the action itself IS the result. Examples: open an app, run a server, launch a URL.
- "agentic-workflow": tasks requiring generation, planning, research, or synthesis — creative writing (stories, poems, essays), summarization, analysis, multi-step tasks, refactor+deploy, build+test+release. If the answer requires more than 3 sentences of original content, this is likely agentic-workflow.
- "full-pipeline": code modification tasks with clear file targets — bug fixes, feature additions, refactoring.

CRITICAL discrimination rules (apply IN THIS ORDER before choosing a strategy):

1. CONVERSATIONAL test — Is this a SHORT, simple exchange?
   - Greetings, small talk ("สวัสดี", "hello", "ขอบคุณ") → "conversational"
   - Simple factual questions answerable in 1-3 sentences ("what is X", "how does Y work", "นิยายเว็บตูนคืออะไร") → "conversational"
   - Meta-questions about system capabilities → "conversational"
   - DELIVERABLE META-RULE: If the answer would be a copy/paste/publishable ARTIFACT (novel chapter, full article, script, deck, application, website, report, summary) — regardless of the verb the user chose or whether they phrased it as a question — it is ALWAYS "agentic-workflow". A 1–3 sentence answer is NOT a deliverable; anything longer likely is.
   - Semantic test (not keyword match): ask yourself "would a complete, satisfying answer fit in one short paragraph?" If NO → "agentic-workflow".
   - Question FORM ≠ conversational INTENT. "ช่วยทำ X ได้ไหม", "can you build X?" — when X is a concrete deliverable, treat as REQUEST TO DO X → "agentic-workflow".
   - Short affirmative follow-ups ("ทำเลย", "เอาเลย", "ok", "go", "เริ่มเลย", "จัดไป", "ลุย") that confirm a previously proposed action → "agentic-workflow" with workflowPrompt reconstructed from the recent conversation.
   - Watch for noun collisions: a word like "เว็บตูน" / "novel" can appear in non-writing tasks ("ทำให้เว็บตูนโหลดเร็วขึ้น" = performance optimization, NOT authoring). Read the verb + object semantically, not keywords in isolation.

2. DIRECT-TOOL test — Is the action itself the ENTIRE goal?
   - "direct-tool" is ONLY correct when the user needs NO textual response. The side-effect IS the result.
   - If the user wants an ANSWER, SUMMARY, LIST, or REPORT → NEVER "direct-tool"
   - Words like "summarize", "list", "find all", "analyze", "report", "สรุป", "หา", "ค้นหา", "รวบรวม", "วิเคราะห์" → NEVER "direct-tool"
   - Asking about a file's content → NOT "direct-tool" (reading is not opening)
   - If strategy="direct-tool", you MUST include directToolCall with an executable tool invocation
   - Emit exactly ONE platform-appropriate command. Never chain alternatives with ||, &&, ;, |, or multi-line shell scripts
   - The current platform is provided in the user prompt. Choose the command for THAT platform only
   - For web services / SaaS products that are normally opened in a browser, prefer opening the canonical URL instead of inventing a local app name
   - Even if the user says "app" / "แอพ", if the target is primarily a web service, open its canonical URL instead of trying to launch a nonexistent desktop app
   - Example: "open Gmail" → shell_exec with a browser/open command for Gmail's web URL, NOT "open -a gmail" and NOT cross-platform fallback chains
   - Only use a native app launch when the target is clearly a desktop app

3. FULL-PIPELINE test — Is this a focused code change?
   - Has explicit file targets AND involves code modification → "full-pipeline"
   - Bug fix, implement feature, refactor specific module → "full-pipeline"
   - If it requires multi-file coordination OR exploration first → "agentic-workflow" instead

4. AGENTIC-WORKFLOW (default for complex) — Everything else that requires action:
   - Multi-step tasks, research, analysis, synthesis
   - Creative generation: stories, essays, poems, scripts, long-form content
   - Tasks requiring exploration before action
   - Tasks spanning multiple files without clear targets
   - Any task where the output is substantial text (more than a short paragraph)

5. USER PREFERENCE OVERRIDE — When the user prompt includes "User app preferences":
   - If user asks for a CATEGORY (e.g., "แอพ mail", "email app", "browser") and a preference exists → ALWAYS use the preferred app
   - Generate the directToolCall command for the PREFERRED app, not the platform default
   - Example: if user prefers "gmail" for "mail", then "เปิดแอพ mail" → open Gmail's URL, NOT "open -a Mail"
   - If user names a SPECIFIC app ("เปิด Outlook"), respect that even if preference says something else

workflowPrompt guidelines (for "agentic-workflow" ONLY):
- Write it as if briefing a smart colleague who just walked into the room
- Include: what to accomplish, what approach to take, what success looks like
- Be specific about outputs expected (e.g., "produce a bullet-point summary", "list all files matching X")
- Do NOT include generic platitudes like "be careful" — give actionable steps

Available tools (use ONLY these exact names — do NOT invent tool names):
- shell_exec: Execute ANY shell command (open apps, run scripts, system commands). Parameters: { "command": "..." }
- file_read: Read file contents. Parameters: { "file_path": "..." }
- file_write: Write/create a file. Parameters: { "file_path": "...", "content": "..." }
- file_edit: Edit a file with search/replace. Parameters: { "file_path": "...", "old_text": "...", "new_text": "..." }
- directory_list: List directory contents. Parameters: { "path": "..." }
- search_grep: Search file contents. Parameters: { "pattern": "...", "path": "..." }
- git_status: Show git status. Parameters: {}
- git_diff: Show git diff. Parameters: {}
- search_semantic: Semantic code search. Parameters: { "query": "..." }
- http_get: HTTP GET request. Parameters: { "url": "..." }

IMPORTANT: For opening apps, running system commands, or any OS interaction, use shell_exec with the appropriate command.

## Canonical Examples (study these — they cover cases that trip up naive keyword matching)

1. GOAL: "อยากให้ช่วยเขียนนิยายลงขายในเว็บตูนสักเรื่อง"
   STRATEGY: agentic-workflow
   WHY: Multi-chapter creative deliverable. The answer is a publishable artifact, not a chat reply.

2. GOAL: "สวัสดีครับ"
   STRATEGY: conversational
   WHY: Greeting; 1-sentence friendly reply.

3. GOAL: "นิยายเว็บตูนคืออะไร"
   STRATEGY: conversational
   WHY: Informational question — user wants a definition, not a novel. Mentioning "นิยาย" does NOT mean "write one".

4. GOAL: "fix type error in src/foo.ts"
   STRATEGY: full-pipeline
   WHY: Code modification with an explicit file target.

5. GOAL: "เปิดแอพ Gmail ให้หน่อย"
   STRATEGY: direct-tool
   WHY: Single fire-and-forget OS action; the side-effect IS the result.

6. GOAL: "แปลนิยายเรื่องนี้เป็นอังกฤษ"
   STRATEGY: agentic-workflow
   WHY: Multi-chapter text transformation (translation). Output is long even though the user is not "authoring" from scratch.

7. GOAL: "ทำให้เว็บตูนโหลดเร็วขึ้น"
   STRATEGY: full-pipeline (with targetFiles) OR agentic-workflow (without)
   WHY: Performance optimization in a codebase. "เว็บตูน" here names the PRODUCT being optimized, NOT a writing task. Verb+object semantics beats keyword matching.

8. GOAL: "ช่วยคิดพล็อตนิยายหน่อย"
   STRATEGY: agentic-workflow
   WHY: Creative ideation — the user wants a structured plot outline. The verb is "คิด" not "เขียน", but the deliverable is still long-form.

Respond ONLY with valid JSON, no markdown fences.`;

/** Single-call timeout before the resolver falls back to an alternate provider. */
export const INTENT_TIMEOUT_MS = 8000;

/**
 * Provider-tier preference for intent resolution.
 *
 * Intent calls run once per task, so the marginal cost of `balanced` is
 * negligible compared to the accuracy win over `fast`/`tool-uses`. A regex
 * pre-filter used to paper over `fast` misclassification — it was brittle
 * and keyword-bound, so it was removed in favour of a stronger default tier
 * plus the canonical few-shot examples above.
 */
export const TIER_PREFERENCE = ['balanced', 'tool-uses', 'fast'] as const;

/** Pick the best-available provider following TIER_PREFERENCE. */
export function pickPrimaryProvider(registry: LLMProviderRegistry): LLMProvider | null {
  for (const tier of TIER_PREFERENCE) {
    const p = registry.selectByTier(tier);
    if (p) return p;
  }
  return null;
}

/** Pick a provider other than `excludeId` for the classify-again retry. */
export function pickAlternateProvider(
  registry: LLMProviderRegistry,
  excludeId: string,
): LLMProvider | null {
  for (const tier of TIER_PREFERENCE) {
    const p = registry.selectByTier(tier);
    if (p && p.id !== excludeId) return p;
  }
  return null;
}

/**
 * Single classify call. Parses + normalizes the response; throws on timeout,
 * malformed JSON, or an invalid direct-tool payload so `classifyWithFallback`
 * can retry with a different provider.
 */
export async function classifyOnce(
  provider: LLMProvider,
  userPrompt: string,
): Promise<z.infer<typeof IntentResponseSchema>> {
  const response = await withTimeout(
    provider.generate({
      systemPrompt: INTENT_SYSTEM_PROMPT,
      userPrompt,
      maxTokens: 500,
      temperature: 0,
    }),
    INTENT_TIMEOUT_MS,
  );
  const parsed = parseIntentResponse(response.content.trim());
  parsed.directToolCall = normalizeDirectToolCall(parsed.strategy, parsed.directToolCall);
  return parsed;
}

/** Primary + alternate-tier classification call. */
export async function classifyWithFallback(
  registry: LLMProviderRegistry,
  primary: LLMProvider,
  userPrompt: string,
): Promise<z.infer<typeof IntentResponseSchema>> {
  try {
    return await classifyOnce(primary, userPrompt);
  } catch (firstError) {
    const alternate = pickAlternateProvider(registry, primary.id);
    if (!alternate) throw firstError;
    return classifyOnce(alternate, userPrompt);
  }
}
