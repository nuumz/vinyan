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
import type { LLMProviderRegistry } from '../llm/provider-registry.ts';
import type { LLMProvider } from '../types.ts';
import { type IntentResponseSchema, normalizeDirectToolCall, parseIntentResponse, withTimeout } from './parser.ts';

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

1. DELIVERABLE TEST — Apply FIRST. Overrides every other test.
   Ask one question: "Would the user-acceptable answer be a publishable ARTIFACT — story chapter, full article, report, code module, slide deck, multi-paragraph prose ≥3 paragraphs, or anything the user would copy/paste/publish?"
   If YES → "agentic-workflow". STOP. Do not consider conversational.
   - Politeness words ("ช่วย", "could you", "please") DO NOT make a deliverable conversational.
   - Question form ("can you write X?", "ช่วยเขียน X ได้ไหม") does NOT make a deliverable conversational when X is a concrete artifact.
   - Quantity quantifiers ("สัก 2 บท", "5 chapters", "a long report") are unambiguous deliverable signals.
   - Short affirmative follow-ups ("ทำเลย", "เอาเลย", "ok", "go", "เริ่มเลย", "จัดไป", "ลุย") that confirm a previously proposed deliverable → "agentic-workflow" with workflowPrompt reconstructed from the conversation.
   - Watch for noun collisions: a word like "เว็บตูน" / "novel" can appear in non-writing tasks ("ทำให้เว็บตูนโหลดเร็วขึ้น" = performance optimization). The deliverable test is about what the ANSWER would look like, not what nouns appear in the goal.

2. CONVERSATIONAL test — Apply only if the deliverable test said NO.
   - Greetings, small talk ("สวัสดี", "hello", "ขอบคุณ") → "conversational"
   - Pure factual questions answerable in 1-3 sentences ("what is X", "นิยายเว็บตูนคืออะไร") → "conversational"
   - Meta-questions about system capabilities → "conversational"
   - If you cannot fit a complete, satisfying answer in one short paragraph, this is NOT conversational — go back to rule 1.

3. DIRECT-TOOL test — Is the action itself the ENTIRE goal?
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

4. FULL-PIPELINE test — Is this a focused code change?
   - Has explicit file targets AND involves code modification → "full-pipeline"
   - Bug fix, implement feature, refactor specific module → "full-pipeline"
   - If it requires multi-file coordination OR exploration first → "agentic-workflow" instead

5. AGENTIC-WORKFLOW (default for complex) — Everything else that requires action:
   - Multi-step tasks, research, analysis, synthesis
   - Creative generation: stories, essays, poems, scripts, long-form content
   - Tasks requiring exploration before action
   - Tasks spanning multiple files without clear targets
   - Any task where the output is substantial text (more than a short paragraph)

6. USER PREFERENCE OVERRIDE — When the user prompt includes "User app preferences":
   - If user asks for a CATEGORY (e.g., "แอพ mail", "email app", "browser") and a preference exists → ALWAYS use the preferred app
   - Generate the directToolCall command for the PREFERRED app, not the platform default
   - Example: if user prefers "gmail" for "mail", then "เปิดแอพ mail" → open Gmail's URL, NOT "open -a Mail"
   - If user names a SPECIFIC app ("เปิด Outlook"), respect that even if preference says something else

workflowPrompt guidelines (for "agentic-workflow" ONLY):
- Write it as if briefing a smart colleague who just walked into the room
- Include: what to accomplish, the goal/output, the concrete process steps, what information is missing (if any), and what success looks like
- Be specific about outputs expected (e.g., "produce a bullet-point summary", "list all files matching X")
- Do NOT include generic platitudes like "be careful" — give actionable steps
- Internal role names are routing hints only. Do NOT write workflow prompts that tell the downstream agent to tell the user to contact, wait for, hand off to, or ask a named internal agent/role. The user-facing answer should explain the work and either ask necessary clarifying questions or produce the deliverable.
- Creative writing rule: for novel/book/webtoon/story tasks, "write" means author prose, not code. The downstream workflow may use creative capabilities internally (brief/plot/structure/draft/edit/critique), but do not expose internal role names as the answer. Do NOT assign ts-coder, system-designer, test-coder, or software roles unless the user explicitly asks for software/code.

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

/**
 * Phase B — workflow-shape extraction addendum.
 *
 * Appended to the base prompt ONLY when the caller has determined the goal
 * is a creative-deliverable + the candidate strategy is `agentic-workflow`.
 * Casual prompts (chat / lookup / fix-bug / direct-tool) skip this addendum
 * so they pay no extra latency or token cost.
 *
 * The addendum asks the LLM to populate FIVE additional optional fields.
 * The schema accepts them as optional, so a model that ignores the addendum
 * still produces a valid `IntentResponse`.
 */
export const WORKFLOW_SHAPE_EXTRACTION_ADDENDUM = `
─── ADDITIONAL EXTRACTION (creative agentic-workflow goals only) ───

When strategy="agentic-workflow" AND the goal is a creative deliverable
(video / music / story / poster / pitch / lesson / brand asset / etc.),
ALSO populate these optional fields in the JSON response:

- workflowShape: one of
    "single"           — one LLM call is enough (a tweet, a tagline, a one-liner)
    "parallel"         — N agents work in parallel from different angles, no shared transcript
    "debate-iterative" — N agents share transcript, take multiple rebuttal rounds (refining contested claims)
    "pipeline-staged"  — sequential dependency: research → outline → draft → polish

  Pick "single" by default unless the goal explicitly invites multiple
  perspectives (debate / compare / brainstorm) or staged refinement
  (research → outline → draft). DO NOT default to multi-agent shapes
  for simple deliverables — overhead doesn't pay off.

- shapeReason: one short sentence justifying the workflowShape choice.

- primaryRolesNeeded: array of capability requirements for each agent slot,
  ONLY when workflowShape is "parallel" / "debate-iterative" / "pipeline-staged".
  Each entry has the same shape as the top-level capabilityRequirements
  array (id, weight, fileExtensions, actionVerbs, domains, frameworkMarkers,
  role). Each entry describes ONE primary slot — list as many as the
  shape needs. Empty / omitted for "single" shape.

- clarificationFocus: array subset of
    ["genre", "audience", "tone", "length", "platform", "specialist"]
  Listing ONLY the slots the user has NOT already supplied in the prompt.
  Empty array means the prompt already gives enough context — skip
  clarification entirely. Omit the field if you are unsure (the gate
  defaults to all five questions).

- specialistTarget: stable slug of a downstream generator the user named
  or implied — examples: "runway-gen-4.5", "suno-v5", "midjourney-v7",
  "manual-edit-spec". When the user said "I'll edit it in CapCut", set
  "manual-edit-spec". When the user said "for Suno", set "suno-v5". Omit
  if no specialist is mentioned or implied.

ABSENCE rule: if you are not confident, OMIT the field. The orchestrator
treats absent fields as "use defaults" and degrades gracefully. Do NOT
hallucinate a primaryRolesNeeded array on a single-shot goal just because
the addendum was injected.
`;

/**
 * Assemble the intent system prompt, optionally appending the workflow-shape
 * extraction addendum. Pure string composition — no I/O. Lives next to the
 * base prompt so future extractions land here as additional addenda.
 */
export function buildIntentSystemPrompt(opts: { extractWorkflowShape?: boolean } = {}): string {
  if (opts.extractWorkflowShape) {
    return `${INTENT_SYSTEM_PROMPT}\n${WORKFLOW_SHAPE_EXTRACTION_ADDENDUM}`;
  }
  return INTENT_SYSTEM_PROMPT;
}

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
export function pickAlternateProvider(registry: LLMProviderRegistry, excludeId: string): LLMProvider | null {
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
 *
 * `opts.extractWorkflowShape=true` opts in to the Phase B workflow-shape
 * extraction addendum. Callers (intent-resolver) gate this on
 * `inferCreativeDomain(goal) !== 'generic'` so casual prompts pay nothing.
 * Increases `maxTokens` modestly to leave room for the additional fields.
 */
export async function classifyOnce(
  provider: LLMProvider,
  userPrompt: string,
  opts: { extractWorkflowShape?: boolean } = {},
): Promise<z.infer<typeof IntentResponseSchema>> {
  const systemPrompt = buildIntentSystemPrompt(opts);
  const response = await withTimeout(
    provider.generate({
      systemPrompt,
      userPrompt,
      // Bump headroom modestly when the addendum is in play — the
      // base 500 was tight for a clean JSON response with five extra
      // optional fields populated.
      maxTokens: opts.extractWorkflowShape ? 800 : 500,
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
  opts: { extractWorkflowShape?: boolean } = {},
): Promise<z.infer<typeof IntentResponseSchema>> {
  try {
    return await classifyOnce(primary, userPrompt, opts);
  } catch (firstError) {
    const alternate = pickAlternateProvider(registry, primary.id);
    if (!alternate) throw firstError;
    return classifyOnce(alternate, userPrompt, opts);
  }
}
