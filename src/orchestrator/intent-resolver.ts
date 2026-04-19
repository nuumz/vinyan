/**
 * Intent Resolver — deterministic-first, LLM-advisory, tier-merged.
 *
 * Pipeline (§task-routing-spec.md v3 + axioms A3/A5):
 *   [A] cache lookup (understandingFingerprint | session+goal)
 *   [B] deterministic candidate    — classifyDirectTool + mapUnderstandingToStrategy (tier 0.8)
 *   [C] LLM advisory               — skipped when [B] confidence ≥ 0.85 AND !ambiguous
 *   [D] verify + merge             — agree / LLM-enrichment / A5 tier-winner / uncertain
 *   [E] cache write + bus emit
 *
 * A3: governance stays deterministic — LLM output is advisory and merged under
 * A5 tier order. A5: deterministic (tier 0.8) wins over LLM (tier 0.4) on disagreement.
 *
 * Source of truth: docs/spec/tdd.md §16 (Core Loop), docs/foundation/task-routing-spec.md
 */

import { z } from 'zod';
import type { VinyanBus } from '../core/bus.ts';
import { LRUTTLCache } from './intent/cache.ts';
import {
  computeStructuralFeatures,
  renderStructuralFeatures,
  type StructuralFeatures,
} from './intent/features.ts';
import {
  buildClarificationRequest,
  formatAgentCatalog,
  formatConversationContext,
  resolveSelectedAgent,
} from './intent/formatters.ts';
import {
  buildClassifierUserPrompt,
  buildComprehensionBlock,
} from './intent/prompt.ts';
import {
  composeDeterministicCandidate,
  fallbackStrategy,
  mapUnderstandingToStrategy,
} from './intent/strategy.ts';
import type { IntentResolverDeps } from './intent/types.ts';
import {
  containsShellFallbackChain,
  IntentResponseSchema,
  normalizeDirectToolCall,
  parseIntentResponse,
  stripJsonFences,
  withTimeout,
} from './intent/parser.ts';
import type { LLMProviderRegistry } from './llm/provider-registry.ts';
import { classifyDirectTool, resolveCommand } from './tools/direct-tool-resolver.ts';
import { userConstraintsOnly } from './constraints/pipeline-constraints.ts';
import type {
  AgentSpec,
  ConversationEntry,
  ExecutionStrategy,
  IntentDeterministicCandidate,
  IntentResolution,
  IntentResolutionType,
  LLMProvider,
  SemanticTaskUnderstanding,
  TaskInput,
} from './types.ts';
import {
  formatUserContextForPrompt,
  type UserInterestMiner,
} from './user-context/user-interest-miner.ts';

// ---------------------------------------------------------------------------
// Zod schema for LLM response parsing
// ---------------------------------------------------------------------------

// Commit D3: IntentResponseSchema moved to `src/orchestrator/intent/parser.ts`
// and re-imported above. Kept as a pure-type alias for legacy call sites.

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------

const INTENT_SYSTEM_PROMPT = `You are an intent classifier for Vinyan, a task orchestrator.
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

// Commit D3: stripJsonFences / parseIntentResponse / containsShellFallbackChain
// / normalizeDirectToolCall / withTimeout moved to
// `src/orchestrator/intent/parser.ts` and imported at the top of this file.

// ---------------------------------------------------------------------------
// Structural features — deterministic metadata fed into the classifier prompt.
// We do NOT pattern-match semantic intent here (that's the LLM's job). We only
// compute signals that are unambiguous: length, end-punctuation, turn number.
// The classifier uses these alongside the goal text itself.
// ---------------------------------------------------------------------------

// Commit D2: StructuralFeatures + computeStructuralFeatures +
// renderStructuralFeatures moved to `src/orchestrator/intent/features.ts`
// — re-exported here to preserve the public surface area while call sites
// migrate.
export { computeStructuralFeatures, type StructuralFeatures };

// ---------------------------------------------------------------------------
// Session cache — skip re-classifying identical goals within a short TTL.
// Keyed by (sessionId, goal). Process-global; tests must call
// clearIntentResolverCache() between cases to avoid cross-contamination.
// ---------------------------------------------------------------------------

const INTENT_CACHE_TTL_MS = 30_000;
const INTENT_CACHE_PRUNE_THRESHOLD = 64;
const INTENT_CACHE_MAX_SIZE = 256;

// Commit D1: extracted LRU+TTL cache (src/orchestrator/intent/cache.ts) —
// same semantics as the prior inline Map + pruneIntentCache, now reusable
// and independently unit-tested.
const intentCache = new LRUTTLCache<IntentResolution>({
  ttlMs: INTENT_CACHE_TTL_MS,
  pruneThreshold: INTENT_CACHE_PRUNE_THRESHOLD,
  maxSize: INTENT_CACHE_MAX_SIZE,
});

function buildCacheKey(
  goal: string,
  sessionId?: string,
  understanding?: SemanticTaskUnderstanding,
  comprehension?: import('./comprehension/types.ts').ComprehendedTaskMessage,
): string {
  // When comprehension is available, bind the cache entry to its inputHash
  // (A4: content-addressed). Conversation state changes (new user turn,
  // pending-clarification flip) → comprehension inputHash changes → stale
  // cache auto-invalidates. This fixes the prior footgun where the same
  // `(session+goal)` across turns would reuse an intent that predated the
  // new context.
  if (comprehension?.params.inputHash) {
    return `cmp::${comprehension.params.inputHash}`;
  }
  // Prefer the content-addressed understandingFingerprint when available — it
  // invalidates automatically when the goal OR resolved paths OR task signature
  // change, giving us a stable cross-task key that survives minor goal edits
  // in the same session.
  if (understanding?.understandingFingerprint) {
    return `fp::${understanding.understandingFingerprint}`;
  }
  return `${sessionId ?? '__nosess__'}::${goal.trim().toLowerCase()}`;
}

/** Test-only: reset the module-level cache so each test starts clean. */
export function clearIntentResolverCache(): void {
  intentCache.clear();
}

/** Test-only: introspect cache size (for eviction assertions). */
export function intentResolverCacheSize(): number {
  return intentCache.size;
}

// ---------------------------------------------------------------------------
// Fallback: map existing regex-based classification to ExecutionStrategy
// ---------------------------------------------------------------------------

// Commit D5: fallbackStrategy / mapUnderstandingToStrategy /
// composeDeterministicCandidate moved to `src/orchestrator/intent/strategy.ts`
// and imported at the top of this file. Re-exported for backward compat.
export { composeDeterministicCandidate, fallbackStrategy, mapUnderstandingToStrategy };

// Commit D4: buildClarificationRequest / formatConversationContext /
// formatAgentCatalog / resolveSelectedAgent moved to
// `src/orchestrator/intent/formatters.ts` and imported at the top.

// ---------------------------------------------------------------------------
// Main resolver
// ---------------------------------------------------------------------------

// Commit D6: IntentResolverDeps moved to `src/orchestrator/intent/types.ts`
// and imported at the top. Re-exported for legacy call sites.
export type { IntentResolverDeps };

const INTENT_TIMEOUT_MS = 8000;

/**
 * Provider-tier preference for intent resolution.
 *
 * Rationale (see plan `vinyan-agent-intent-replicated-kite.md`): intent calls
 * run once per task, so the marginal cost of using the `balanced` tier is
 * negligible compared to the accuracy win over `fast`/`tool-uses`. A regex
 * pre-filter used to paper over `fast` misclassification — it was brittle
 * and keyword-bound, so it was removed in favour of a stronger default tier
 * plus canonical few-shot examples in the system prompt.
 */
const TIER_PREFERENCE = ['balanced', 'tool-uses', 'fast'] as const;

function pickPrimaryProvider(registry: LLMProviderRegistry): LLMProvider | null {
  for (const tier of TIER_PREFERENCE) {
    const p = registry.selectByTier(tier);
    if (p) return p;
  }
  return null;
}

function pickAlternateProvider(
  registry: LLMProviderRegistry,
  excludeId: string,
): LLMProvider | null {
  for (const tier of TIER_PREFERENCE) {
    const p = registry.selectByTier(tier);
    if (p && p.id !== excludeId) return p;
  }
  return null;
}

async function classifyOnce(
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

/**
 * Threshold at which a deterministic candidate is trusted enough to bypass
 * the LLM entirely. Below this, we consult the LLM as an advisor.
 */
const DETERMINISTIC_SKIP_THRESHOLD = 0.85;

/** Low-confidence watermark from the LLM — below this we flag the resolution uncertain. */
const LLM_UNCERTAIN_THRESHOLD = 0.5;

/**
 * Strategy pairs where rule vs. LLM disagreement is merely refinement (not
 * contradiction). Rule says X, LLM says Y — we accept Y because it carries
 * strictly more information (e.g. full-pipeline vs agentic-workflow with a
 * concrete workflowPrompt).
 */
function isLLMRefinement(rule: ExecutionStrategy, llm: ExecutionStrategy): boolean {
  if (rule === llm) return true;
  if (rule === 'full-pipeline' && llm === 'agentic-workflow') return true; // wider scope = richer
  if (rule === 'agentic-workflow' && llm === 'full-pipeline') return true; // narrower scope = focused
  if (rule === 'conversational' && llm === 'agentic-workflow') return true; // deliverable upgrade
  return false;
}

/**
 * A5-safe merge — deterministic (tier 0.8) wins over LLM (tier 0.4) on true
 * contradictions; refinements are accepted; agreements are recorded as known.
 */
function mergeDeterministicAndLLM(
  input: TaskInput,
  understanding: SemanticTaskUnderstanding,
  det: IntentResolution & { deterministicCandidate: IntentDeterministicCandidate },
  llm: z.infer<typeof IntentResponseSchema>,
  bus: VinyanBus | undefined,
  taskId: string,
): { resolution: IntentResolution; type: IntentResolutionType } {
  const llmConfidence = llm.confidence ?? 0.8;

  // Case 1: LLM is low-confidence → uncertain. Keep deterministic strategy.
  if (llmConfidence < LLM_UNCERTAIN_THRESHOLD) {
    const { request, options } = buildClarificationRequest(input, understanding, det.strategy);
    bus?.emit('intent:uncertain', {
      taskId,
      reason: `LLM confidence ${llmConfidence.toFixed(2)} below threshold ${LLM_UNCERTAIN_THRESHOLD}`,
      clarificationRequest: request,
    });
    return {
      resolution: {
        ...det,
        reasoning: `${det.reasoning} LLM uncertain (${llmConfidence.toFixed(2)}).`,
        reasoningSource: 'merged',
        clarificationRequest: request,
        clarificationOptions: options,
      },
      type: 'uncertain',
    };
  }

  // A5 carve-out: when rule said 'direct-tool' but never resolved a concrete
  // `directToolCall`, the rule has NO artifact — just an opinion. A5's
  // tier-0.8 trust applies to deterministic FACTS, not unresolved hunches.
  // Treat LLM disagreement as refinement (LLM fills the gap) instead of
  // contradiction. Prevents the user from being asked to tiebreak between
  // a hollow rule and an informed LLM pick.
  if (
    det.strategy === 'direct-tool' &&
    !det.directToolCall &&
    llm.strategy !== 'direct-tool'
  ) {
    const mergedStrategy = llm.strategy;
    const mergedConfidence = Math.max(det.confidence, llmConfidence);
    return {
      resolution: {
        strategy: mergedStrategy,
        refinedGoal: llm.refinedGoal,
        directToolCall: llm.directToolCall,
        workflowPrompt: llm.workflowPrompt,
        confidence: mergedConfidence,
        reasoning: `A5 carve-out: rule=direct-tool had no resolved command (hollow); LLM=${llm.strategy} accepted as refinement. ${llm.reasoning}`,
        reasoningSource: 'merged',
        deterministicCandidate: det.deterministicCandidate,
      },
      type: 'known',
    };
  }

  // Case 2: Contradiction — rule and LLM disagree and LLM isn't a pure refinement.
  // A5: rule wins (tier 0.8 > tier 0.4). Emit event, surface clarification.
  if (!isLLMRefinement(det.strategy, llm.strategy)) {
    const { request, options } = buildClarificationRequest(
      input,
      understanding,
      det.strategy,
      llm.strategy,
    );
    bus?.emit('intent:contradiction', {
      taskId,
      ruleStrategy: det.strategy,
      llmStrategy: llm.strategy,
      ruleConfidence: det.confidence,
      llmConfidence,
      winner: det.strategy,
    });
    return {
      resolution: {
        ...det,
        // A5: rule strategy survives, but we still carry LLM reasoning for audit.
        reasoning: `A5 contradiction: rule=${det.strategy} (${det.confidence.toFixed(2)}) vs llm=${llm.strategy} (${llmConfidence.toFixed(2)}). Rule wins.`,
        reasoningSource: 'merged',
        clarificationRequest: request,
        clarificationOptions: options,
      },
      type: 'contradictory',
    };
  }

  // Case 3: Agreement or LLM refinement — accept LLM's richer payload.
  // Confidence = max of the two (they agree), but never below the deterministic floor.
  const mergedStrategy = llm.strategy;
  const mergedConfidence = Math.max(det.confidence, llmConfidence);
  return {
    resolution: {
      strategy: mergedStrategy,
      refinedGoal: llm.refinedGoal,
      directToolCall: llm.directToolCall ?? det.directToolCall,
      workflowPrompt: llm.workflowPrompt,
      confidence: mergedConfidence,
      reasoning: llm.reasoning,
      reasoningSource: 'merged',
      deterministicCandidate: det.deterministicCandidate,
    },
    type: 'known',
  };
}

/** [B.skip] Finalize + emit a pure-deterministic resolution (no LLM consulted). */
function finalizeDeterministicSkip(
  input: TaskInput,
  deterministic: ReturnType<typeof composeDeterministicCandidate>,
  deps: IntentResolverDeps,
  cacheKey: string,
  now: number,
): IntentResolution {
  const { agentId, agentSelectionReason } = resolveSelectedAgent(
    input,
    deps.agents,
    deps.defaultAgentId,
    undefined,
    'deterministic skip (no LLM consulted)',
  );
  const result: IntentResolution = {
    ...deterministic,
    agentId,
    agentSelectionReason,
    type: 'known',
  };
  intentCache.set(cacheKey, result, now);
  intentCache.prune(now);
  deps.bus?.emit('intent:resolved', {
    taskId: input.id,
    strategy: result.strategy,
    confidence: result.confidence,
    reasoning: result.reasoning,
    type: 'known',
    source: 'deterministic',
  });
  return result;
}

/** [C.no-llm] Return the deterministic candidate when no LLM provider is registered. */
function finalizeDeterministicOnly(
  input: TaskInput,
  understanding: SemanticTaskUnderstanding,
  deterministic: ReturnType<typeof composeDeterministicCandidate>,
  deps: IntentResolverDeps,
  cacheKey: string,
  now: number,
): IntentResolution {
  const { agentId, agentSelectionReason } = resolveSelectedAgent(
    input,
    deps.agents,
    deps.defaultAgentId,
    undefined,
    'deterministic-only (no LLM available)',
  );
  const detType: IntentResolutionType = deterministic.deterministicCandidate.ambiguous ? 'uncertain' : 'known';
  const clarif =
    detType === 'uncertain' ? buildClarificationRequest(input, understanding, deterministic.strategy) : undefined;
  const result: IntentResolution = {
    ...deterministic,
    agentId,
    agentSelectionReason,
    type: detType,
    clarificationRequest: clarif?.request,
    clarificationOptions: clarif?.options,
  };
  intentCache.set(cacheKey, result, now);
  intentCache.prune(now);
  deps.bus?.emit('intent:resolved', {
    taskId: input.id,
    strategy: result.strategy,
    confidence: result.confidence,
    reasoning: result.reasoning,
    type: detType,
    source: 'deterministic',
  });
  if (detType === 'uncertain' && clarif) {
    deps.bus?.emit('intent:uncertain', {
      taskId: input.id,
      reason: 'Deterministic rule flagged ambiguity; no LLM available to advise.',
      clarificationRequest: clarif.request,
    });
  }
  return result;
}

// Commit D6: buildClassifierUserPrompt / buildComprehensionBlock moved to
// `src/orchestrator/intent/prompt.ts` and imported at the top of this file.

/** Primary + alternate-tier classification call. */
async function classifyWithFallback(
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

export async function resolveIntent(
  input: TaskInput,
  deps: IntentResolverDeps,
): Promise<IntentResolution> {
  const now = deps.now?.() ?? Date.now();
  const understanding = deps.understanding;

  // [A] Cache — prefer comprehension.inputHash (A4 content-addressed) →
  // understandingFingerprint → (session, goal) as a last resort.
  const cacheKey = buildCacheKey(
    input.goal,
    deps.sessionId,
    understanding,
    deps.comprehension,
  );
  const cached = intentCache.get(cacheKey, now);
  if (cached) {
    deps.bus?.emit('intent:cache_hit', { taskId: input.id, cacheKey });
    return { ...cached, reasoningSource: 'cache' };
  }

  // [B] Deterministic candidate (tier 0.8). Null when caller supplied no STU.
  const deterministic = understanding ? composeDeterministicCandidate(input, understanding) : null;

  // [B.skip] High-confidence deterministic → bypass LLM entirely.
  // Exception: when this turn is a clarification answer, the user's reply
  // may contradict the deterministic candidate (which was computed on the
  // original, ambiguous goal). Defer to the LLM so it can honor the reply
  // via the ROUTING RULE emitted in the classifier prompt.
  const isClarificationAnswer =
    deps.comprehension?.params.data?.state.isClarificationAnswer === true;
  if (
    deterministic &&
    deterministic.confidence >= DETERMINISTIC_SKIP_THRESHOLD &&
    !deterministic.deterministicCandidate.ambiguous &&
    !isClarificationAnswer
  ) {
    return finalizeDeterministicSkip(input, deterministic, deps, cacheKey, now);
  }

  // [C] LLM advisory. When no provider is registered, fall back to deterministic
  // or surface the legacy error (preserves backwards compatibility).
  const primary = pickPrimaryProvider(deps.registry);
  if (!primary) {
    if (deterministic && understanding) {
      return finalizeDeterministicOnly(input, understanding, deterministic, deps, cacheKey, now);
    }
    throw new Error('No LLM provider available for intent resolution');
  }

  const userPrompt = buildClassifierUserPrompt(input, deps, deterministic);
  const parsed = await classifyWithFallback(deps.registry, primary, userPrompt);

  // [D] Verify + merge. Rule + LLM → known / uncertain / contradictory.
  let mergeResult: { resolution: IntentResolution; type: IntentResolutionType } =
    deterministic && understanding
      ? mergeDeterministicAndLLM(input, understanding, deterministic, parsed, deps.bus, input.id)
      : {
          resolution: {
            strategy: parsed.strategy,
            refinedGoal: parsed.refinedGoal,
            directToolCall: parsed.directToolCall,
            workflowPrompt: parsed.workflowPrompt,
            confidence: parsed.confidence ?? 0.8,
            reasoning: parsed.reasoning,
            reasoningSource: 'llm',
          },
          type: 'known',
        };

  // [D.2] Clarification-answer bypass. When the comprehender flagged this
  // turn as an answer to a prior clarification, the user has JUST disambiguated
  // — surfacing another `uncertain` / `contradictory` verdict re-shows the same
  // clarification UI and traps the session in a loop. Trust the LLM strategy
  // (it received an explicit ROUTING RULE instructing it to honor the user's
  // reply) and promote the result to `known`. Deterministic still contributed
  // via the prompt; this only gates the verdict emission, not the generation.
  if (
    (mergeResult.type === 'contradictory' || mergeResult.type === 'uncertain') &&
    isClarificationAnswer
  ) {
    const bypassedType = mergeResult.type;
    mergeResult = {
      resolution: {
        strategy: parsed.strategy,
        refinedGoal: parsed.refinedGoal,
        directToolCall: parsed.directToolCall,
        workflowPrompt: parsed.workflowPrompt,
        confidence: parsed.confidence ?? 0.8,
        reasoning:
          `${parsed.reasoning ?? ''} [clarification-answer: bypassed ${bypassedType} gate, user already disambiguated]`.trim(),
        reasoningSource: 'merged',
      },
      type: 'known',
    };
  }

  const { agentId, agentSelectionReason } = resolveSelectedAgent(
    input,
    deps.agents,
    deps.defaultAgentId,
    { agentId: parsed.agentId, agentSelectionReason: parsed.agentSelectionReason },
  );

  const result: IntentResolution = {
    ...mergeResult.resolution,
    type: mergeResult.type,
    agentId,
    agentSelectionReason,
  };

  // [E] Cache write + bus emit.
  intentCache.set(cacheKey, result, now);
  intentCache.prune(now);
  deps.bus?.emit('intent:resolved', {
    taskId: input.id,
    strategy: result.strategy,
    confidence: result.confidence,
    reasoning: result.reasoning,
    type: result.type ?? 'known',
    source: result.reasoningSource ?? 'llm',
  });
  return result;
}
