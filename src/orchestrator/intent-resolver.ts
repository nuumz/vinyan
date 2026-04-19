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

const IntentResponseSchema = z.object({
  strategy: z.enum(['full-pipeline', 'direct-tool', 'conversational', 'agentic-workflow']),
  refinedGoal: z.string(),
  reasoning: z.string(),
  directToolCall: z.object({
    tool: z.string(),
    parameters: z.record(z.string(), z.unknown()),
  }).optional(),
  workflowPrompt: z.string().optional(),
  confidence: z.number().min(0).max(1).optional(),
  /** Multi-agent: id of specialist best-fit for this task. */
  agentId: z.string().optional(),
  agentSelectionReason: z.string().optional(),
});

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

function stripJsonFences(content: string): string {
  return content.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
}

function parseIntentResponse(content: string): z.infer<typeof IntentResponseSchema> {
  const parsed = IntentResponseSchema.parse(JSON.parse(stripJsonFences(content)));
  if (parsed.strategy === 'direct-tool' && !parsed.directToolCall) {
    throw new Error('Direct-tool strategy missing directToolCall');
  }
  return parsed;
}

function containsShellFallbackChain(command: string): boolean {
  return /\|\||&&|;|\r|\n|(?<!\|)\|(?!\|)/.test(command);
}

function normalizeDirectToolCall(
  strategy: z.infer<typeof IntentResponseSchema>['strategy'],
  directToolCall: z.infer<typeof IntentResponseSchema>['directToolCall'],
): z.infer<typeof IntentResponseSchema>['directToolCall'] {
  if (!directToolCall || strategy !== 'direct-tool') {
    return directToolCall;
  }

  const KNOWN_TOOLS = new Set([
    'shell_exec', 'file_read', 'file_write', 'file_edit',
    'directory_list', 'search_grep', 'git_status', 'git_diff',
    'search_semantic', 'http_get',
  ]);

  let normalizedCall = directToolCall;
  if (!KNOWN_TOOLS.has(normalizedCall.tool)) {
    const command = (normalizedCall.parameters.command as string)
      ?? normalizedCall.tool.replace(/_/g, ' ');
    normalizedCall = {
      tool: 'shell_exec',
      parameters: { ...normalizedCall.parameters, command },
    };
  }

  if (normalizedCall.tool !== 'shell_exec') {
    return normalizedCall;
  }

  const command = normalizedCall.parameters.command;
  if (typeof command !== 'string' || !command.trim()) {
    throw new Error('Direct-tool shell_exec command missing');
  }
  if (containsShellFallbackChain(command)) {
    throw new Error('Direct-tool shell_exec command must be a single platform-specific command');
  }

  return {
    ...normalizedCall,
    parameters: {
      ...normalizedCall.parameters,
      command: command.trim(),
    },
  };
}

// ---------------------------------------------------------------------------
// Timeout helper
// ---------------------------------------------------------------------------

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Intent resolution timeout')), ms);
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

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

export function fallbackStrategy(
  taskDomain: string,
  taskIntent: string,
  toolRequirement: string,
  /**
   * Oracle-verified comprehension (optional). When present AND marks this
   * turn as a clarification answer, the fallback PRESERVES the workflow
   * path (agentic-workflow) even if the literal reply text ("โรแมนติก")
   * would otherwise read as conversational/inquire. Without this, LLM
   * outage + clarification-answer would silently re-route the user's
   * creative task to a chat reply.
   */
  comprehension?: import('./comprehension/types.ts').ComprehendedTaskMessage,
): ExecutionStrategy {
  if (comprehension?.params.type === 'comprehension' && comprehension.params.data?.state.isClarificationAnswer) {
    // Stay in whichever workflow the prior task was already in. Without
    // richer state we default to agentic-workflow (the only strategy that
    // currently honors a multi-step creative/exploratory thread).
    return 'agentic-workflow';
  }
  if (taskDomain === 'conversational') return 'conversational';
  if (taskDomain === 'general-reasoning' && taskIntent === 'inquire') return 'conversational';
  if (taskIntent === 'execute' && toolRequirement === 'tool-needed' && taskDomain !== 'code-mutation') return 'direct-tool';
  // Creative/generative tasks (execute + no tools + general-reasoning) need agentic-workflow, not full-pipeline
  if (taskIntent === 'execute' && toolRequirement === 'none' && taskDomain === 'general-reasoning') return 'agentic-workflow';
  return 'full-pipeline';
}

// ---------------------------------------------------------------------------
// Deterministic candidate — primary path (tier 0.8, A5).
// Produces a candidate BEFORE any LLM call. When confidence is high and the
// signal is unambiguous, the LLM call is skipped entirely.
// ---------------------------------------------------------------------------

const FILE_TOKEN_REGEX = /\b[\w.\-/]+\.[A-Za-z0-9]{1,6}\b/;

/**
 * Rule-based strategy candidate from STU signals. Higher-tier than
 * fallbackStrategy because it includes confidence + ambiguity detection.
 */
export function mapUnderstandingToStrategy(
  understanding: SemanticTaskUnderstanding,
): { strategy: ExecutionStrategy; confidence: number; ambiguous: boolean } {
  const { taskDomain, taskIntent, toolRequirement, rawGoal, resolvedEntities, targetSymbol } =
    understanding;
  const strategy = fallbackStrategy(taskDomain, taskIntent, toolRequirement);

  // --- Ambiguity heuristics ---
  // Goal looks like it references a file but entity resolver found nothing.
  const hasFileToken = FILE_TOKEN_REGEX.test(rawGoal);
  const hasResolvedPaths = resolvedEntities.some((e) => e.resolvedPaths.length > 0);
  const missingReferent = hasFileToken && !hasResolvedPaths && !targetSymbol;

  // "execute" intent on non-code domain with no clear tool signal — could be
  // creative generation OR a direct action OR a research workflow.
  const creativeAmbiguity =
    taskDomain === 'general-reasoning' && taskIntent === 'execute' && toolRequirement === 'none';

  // code-reasoning + inquire could be either "explain this code" (conversational)
  // or "analyze blame for bug" (full-pipeline with tools).
  const codeInquiryAmbiguity = taskDomain === 'code-reasoning' && taskIntent === 'inquire';

  const ambiguous = missingReferent || creativeAmbiguity || codeInquiryAmbiguity;

  // --- Confidence tiers (A5 heuristic ≈ 0.8, lowered for ambiguity) ---
  let confidence: number;
  if (ambiguous) {
    confidence = 0.55;
  } else if (taskDomain === 'conversational') {
    confidence = 0.95; // unambiguous greeting
  } else if (taskDomain === 'code-mutation' && (understanding.targetSymbol || resolvedEntities.length > 0)) {
    confidence = 0.9; // code change with concrete target
  } else if (strategy === 'direct-tool') {
    confidence = 0.8; // tool-needed + non-code; needs tool resolution to fully form
  } else {
    confidence = 0.8;
  }

  return { strategy, confidence, ambiguous };
}

/**
 * Compose a deterministic candidate from STU + rule-based tool classifier.
 * Returns an `IntentResolution` skeleton with `reasoningSource='deterministic'`.
 *
 * When both classifyDirectTool and mapUnderstandingToStrategy agree on
 * direct-tool, the result carries a fully-formed `directToolCall` (resolved
 * via platform-aware resolveCommand).
 */
/**
 * Inspection/report verbs — tasks that need a TEXTUAL answer derived from
 * tool output, never fire-and-forget. Examples:
 *   - "ตรวจสอบการทำงานของ X" → report on X's status
 *   - "check git status"       → summarize working tree
 *   - "verify foo.ts compiles" → tell me the outcome
 *
 * These trigger `execute + tool-needed` in STU (the verb is imperative,
 * the task DOES need tools) but the intent is inquiry-with-tools. Route
 * them to `full-pipeline` so the oracle gate + DAG planner can marshal
 * multiple tools and produce a report.
 */
const INSPECTION_VERB_PATTERN =
  /(?:ตรวจสอบ|เช็ค|ดูสถานะ|ดูการทำงาน|รายงาน|สรุปสถานะ)|\b(?:check|inspect|verify|audit|diagnose|review|status|report)\b/i;

export function composeDeterministicCandidate(
  input: TaskInput,
  understanding: SemanticTaskUnderstanding,
): IntentResolution & { deterministicCandidate: IntentDeterministicCandidate } {
  const ruleStrategy = mapUnderstandingToStrategy(understanding);
  const directClass = classifyDirectTool(input.goal);
  const isInspection = INSPECTION_VERB_PATTERN.test(input.goal);

  // When the direct-tool rule fires with high confidence AND the rule-mapper
  // agrees the goal needs a tool, produce a composed candidate with a resolved
  // shell command. This is the highest-confidence deterministic path.
  //
  // Inspection verbs ("check", "ตรวจสอบ", "verify") are excluded: they read
  // as execute+tool-needed but want a textual report, not a side-effect.
  if (
    directClass &&
    directClass.confidence >= 0.85 &&
    !isInspection &&
    (ruleStrategy.strategy === 'direct-tool' || understanding.toolRequirement === 'tool-needed')
  ) {
    const command = resolveCommand(directClass, process.platform);
    if (command) {
      return {
        strategy: 'direct-tool',
        refinedGoal: input.goal,
        directToolCall: { tool: 'shell_exec', parameters: { command } },
        confidence: Math.min(directClass.confidence, ruleStrategy.ambiguous ? 0.75 : 0.9),
        reasoning: `Deterministic: classifyDirectTool matched (${directClass.type}, conf=${directClass.confidence}).`,
        reasoningSource: 'deterministic',
        type: 'known',
        deterministicCandidate: {
          strategy: 'direct-tool',
          confidence: Math.min(directClass.confidence, 0.9),
          source: 'composed',
          ambiguous: false,
        },
      };
    }
  }

  // Demotion path: rule said direct-tool but we could NOT resolve a concrete
  // shell command (classifyDirectTool missed, or resolveCommand returned
  // null). A direct-tool strategy without a directToolCall is semantically
  // invalid — there is nothing to execute. Route to full-pipeline instead,
  // flagged ambiguous so the LLM merge layer becomes the tiebreaker.
  //
  // This also catches inspection verbs that slipped through STU as
  // execute+tool-needed: "ตรวจสอบ X" wants a report, not fire-and-forget.
  if (ruleStrategy.strategy === 'direct-tool' || isInspection) {
    const reason = isInspection
      ? `STU ${understanding.taskDomain}/${understanding.taskIntent}/${understanding.toolRequirement} + inspection verb → full-pipeline (report expected, not fire-and-forget).`
      : `STU ${understanding.taskDomain}/${understanding.taskIntent}/${understanding.toolRequirement} → direct-tool rule fired but no shell command resolved; demoted to full-pipeline.`;
    return {
      strategy: 'full-pipeline',
      refinedGoal: input.goal,
      confidence: 0.55,
      reasoning: `Deterministic: ${reason}`,
      reasoningSource: 'deterministic',
      type: 'uncertain',
      deterministicCandidate: {
        strategy: 'full-pipeline',
        confidence: 0.55,
        source: 'mapUnderstandingToStrategy',
        ambiguous: true,
      },
    };
  }

  // Otherwise emit a skeleton from the rule-mapper alone. No directToolCall
  // or workflowPrompt yet — the LLM layer fills those in when invoked.
  return {
    strategy: ruleStrategy.strategy,
    refinedGoal: input.goal,
    confidence: ruleStrategy.confidence,
    reasoning: `Deterministic: STU ${understanding.taskDomain}/${understanding.taskIntent}/${understanding.toolRequirement} → ${ruleStrategy.strategy}${ruleStrategy.ambiguous ? ' (ambiguous)' : ''}.`,
    reasoningSource: 'deterministic',
    type: ruleStrategy.ambiguous ? 'uncertain' : 'known',
    deterministicCandidate: {
      strategy: ruleStrategy.strategy,
      confidence: ruleStrategy.confidence,
      source: 'mapUnderstandingToStrategy',
      ambiguous: ruleStrategy.ambiguous,
    },
  };
}

/**
 * Format a clarification request from uncertainty / contradiction signals.
 * Thai + English bilingual — matches the user's input language when detectable.
 */
function buildClarificationRequest(
  input: TaskInput,
  understanding: SemanticTaskUnderstanding,
  ruleStrategy: ExecutionStrategy,
  llmStrategy?: ExecutionStrategy,
): { request: string; options?: string[] } {
  const isThai = /[\u0E00-\u0E7F]/.test(input.goal);
  if (llmStrategy && llmStrategy !== ruleStrategy) {
    const request = isThai
      ? `Vinyan ยังตีความไม่ชัดเจน: กฎบอกว่าเป็น "${ruleStrategy}" แต่การวิเคราะห์ภาษาเห็นว่าน่าจะเป็น "${llmStrategy}" ช่วยอธิบายเพิ่มหน่อยได้ไหมว่าต้องการให้ทำอะไร`
      : `Vinyan is uncertain — rule-based routing says "${ruleStrategy}" but semantic analysis suggests "${llmStrategy}". Could you clarify what outcome you expect?`;
    return {
      request,
      options: [
        isThai ? `ดำเนินการแบบ ${ruleStrategy}` : `Proceed as ${ruleStrategy}`,
        isThai ? `ดำเนินการแบบ ${llmStrategy}` : `Proceed as ${llmStrategy}`,
      ],
    };
  }
  // Pure ambiguity — no LLM override, just a low-confidence rule.
  const domainHint = understanding.taskDomain;
  const request = isThai
    ? `ช่วยให้รายละเอียดเพิ่มเติมหน่อยได้ไหม — goal ของคุณตีความได้หลายแบบ (${domainHint})`
    : `Could you add more detail? The goal is ambiguous (${domainHint}).`;
  return { request };
}

// ---------------------------------------------------------------------------
// Conversation context formatter
// ---------------------------------------------------------------------------

function formatConversationContext(history?: ConversationEntry[]): string {
  if (!history?.length) return '';
  // Keep last 5 turns for context (enough for intent classification without bloating prompt)
  const recent = history.slice(-10); // 10 entries ≈ 5 user+assistant pairs
  const lines = recent.map(
    (e) => `[${e.role}]: ${e.content.length > 200 ? `${e.content.slice(0, 200)}...` : e.content}`,
  );
  return `\nRecent conversation:\n${lines.join('\n')}`;
}

/**
 * Render the specialist agent catalog for the classifier prompt.
 * When override is active, signal the LLM to keep that id.
 */
function formatAgentCatalog(
  agents: AgentSpec[] | undefined,
  overrideActive: boolean,
  overrideId?: string,
): string {
  if (!agents || agents.length === 0) return '';

  if (overrideActive && overrideId) {
    return `\nAgent override active: the user selected '${overrideId}'. Return that id in your response agentId field unchanged.`;
  }

  const lines: string[] = [];
  lines.push('Available specialist agents (pick the best-fit for this task):');
  for (const a of agents) {
    const hints: string[] = [];
    if (a.routingHints?.preferDomains) hints.push(`domains: ${a.routingHints.preferDomains.join(',')}`);
    if (a.routingHints?.preferExtensions) hints.push(`ext: ${a.routingHints.preferExtensions.join(',')}`);
    if (a.routingHints?.preferFrameworks) hints.push(`frameworks: ${a.routingHints.preferFrameworks.join(',')}`);
    const hintsStr = hints.length > 0 ? ` [${hints.join(' | ')}]` : '';
    lines.push(`  - ${a.id}: ${a.description}${hintsStr}`);
  }
  lines.push('Return the chosen agent id in the response `agentId` field, with a brief `agentSelectionReason`.');
  return `\n${lines.join('\n')}`;
}

// ---------------------------------------------------------------------------
// Agent-id resolution (shared between LLM path and heuristic short-circuit)
// ---------------------------------------------------------------------------

function resolveSelectedAgent(
  input: TaskInput,
  agents: AgentSpec[] | undefined,
  defaultAgentId: string | undefined,
  parsedAgent?: { agentId?: string; agentSelectionReason?: string },
  fallbackReason = 'registry default (no confident pick)',
): { agentId?: string; agentSelectionReason?: string } {
  if (!agents || agents.length === 0) return {};
  const known = new Set(agents.map((a) => a.id));
  if (input.agentId && known.has(input.agentId)) {
    return { agentId: input.agentId, agentSelectionReason: 'user override via --agent flag' };
  }
  if (parsedAgent?.agentId && known.has(parsedAgent.agentId)) {
    return {
      agentId: parsedAgent.agentId,
      agentSelectionReason: parsedAgent.agentSelectionReason ?? 'classifier selection',
    };
  }
  const fallback = defaultAgentId && known.has(defaultAgentId) ? defaultAgentId : agents[0]?.id;
  return { agentId: fallback, agentSelectionReason: fallbackReason };
}

// ---------------------------------------------------------------------------
// Main resolver
// ---------------------------------------------------------------------------

export interface IntentResolverDeps {
  registry: LLMProviderRegistry;
  availableTools?: string[];
  bus?: VinyanBus;
  /** Formatted user preferences string for prompt injection (from UserPreferenceStore). */
  userPreferences?: string;
  /** Recent conversation history for multi-turn context. */
  conversationHistory?: ConversationEntry[];
  /**
   * Multi-agent: roster of specialist agents. When provided, resolver picks
   * the best-fit agentId based on goal + task characteristics.
   */
  agents?: AgentSpec[];
  /** Default agent id used when resolver cannot confidently pick one. */
  defaultAgentId?: string;
  /**
   * Mines user interests / recent topics from TraceStore + SessionStore. When
   * provided, the resolver includes a "User context" block so the classifier
   * can reason about ambiguous goals against real past activity.
   */
  userInterestMiner?: UserInterestMiner;
  /** Session id for user-context mining (keyword extraction scoped to session). */
  sessionId?: string;
  /** Test hook for deterministic clock (cache TTL). */
  now?: () => number;
  /**
   * Pre-computed SemanticTaskUnderstanding. When supplied, the deterministic
   * path runs BEFORE the LLM (tier 0.8 candidate + ambiguity detection). When
   * absent, the resolver falls back to the pure-LLM path for backwards compat.
   */
  understanding?: SemanticTaskUnderstanding;
  /**
   * Oracle-verified conversation comprehension (pre-routing). When present:
   *  - `state.isClarificationAnswer=true` → resolver preserves the prior
   *    workflow (suppresses re-classification to conversational/direct-tool)
   *    by blending the signal into the cache key and the LLM user prompt.
   *  - `state.rootGoal` / `data.resolvedGoal` → appended to the prompt as
   *    grounding; classifier sees the user's real intent, not just the
   *    short reply text.
   *  - `state.hasAmbiguousReferents=true` without a resolved rootGoal →
   *    forces the resolver to treat the literal message as provisional
   *    (LLM advisory path even if deterministic would skip).
   */
  comprehension?: import('./comprehension/types.ts').ComprehendedTaskMessage;
}

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

/** Build the user prompt injected into the classifier LLM. */
function buildClassifierUserPrompt(
  input: TaskInput,
  deps: IntentResolverDeps,
  deterministic: ReturnType<typeof composeDeterministicCandidate> | null,
): string {
  const toolList =
    deps.availableTools?.join(', ') ??
    'shell_exec, file_read, file_write, file_edit, directory_list, search_grep, git_status, git_diff';
  const preferencesBlock = deps.userPreferences ? `\n${deps.userPreferences}` : '';
  const conversationBlock = formatConversationContext(deps.conversationHistory);
  const userContextBlock = deps.userInterestMiner
    ? formatUserContextForPrompt(deps.userInterestMiner.mine({ sessionId: deps.sessionId }))
    : '';
  const overrideActive = Boolean(input.agentId && deps.agents?.some((a) => a.id === input.agentId));
  const agentsBlock = formatAgentCatalog(deps.agents, overrideActive, input.agentId);
  const structuralBlock = `\n${renderStructuralFeatures(
    computeStructuralFeatures(input.goal, deps.conversationHistory),
  )}`;
  const deterministicBlock = deterministic
    ? `\nRule-based candidate (tier 0.8 — treat as grounding; override only with strong evidence): strategy=${deterministic.strategy}, confidence=${deterministic.confidence.toFixed(2)}${deterministic.deterministicCandidate.ambiguous ? ', AMBIGUOUS' : ''}. If the rule is already correct, confirm it — do not fabricate complexity.`
    : '';
  const comprehensionBlock = buildComprehensionBlock(deps.comprehension);

  // Strip orchestrator-internal prefixes — the intent classifier sees only
  // user intent, not JSON payloads / routing metadata that belong to other
  // pipeline stages.
  const userCs = userConstraintsOnly(input.constraints);

  return `User goal: "${input.goal}"
Task type: ${input.taskType}
Target files: ${input.targetFiles?.join(', ') || 'none'}
Constraints: ${userCs.length > 0 ? userCs.join(', ') : 'none'}
Current platform: ${process.platform}
Available tools: ${toolList}${structuralBlock}${deterministicBlock}${comprehensionBlock}${agentsBlock}${preferencesBlock}${userContextBlock}${conversationBlock}`;
}

/**
 * Render the oracle-verified conversation comprehension as a prompt block
 * the classifier can reason over. Keep it short and structured — the LLM
 * parses fields, not prose.
 *
 * The critical signal is `isClarificationAnswer=true`: when the user's
 * message is an answer to a pending question, the classifier MUST preserve
 * the prior workflow (do not re-route to conversational / direct-tool)
 * unless the user explicitly asks for a topic change.
 */
function buildComprehensionBlock(
  comprehension?: import('./comprehension/types.ts').ComprehendedTaskMessage,
): string {
  if (!comprehension || comprehension.params.type !== 'comprehension') return '';
  const data = comprehension.params.data;
  if (!data) return '';
  const s = data.state;
  const lines: string[] = [];
  lines.push('\nConversation comprehension (oracle-verified, tier='
    + comprehension.params.tier + '):');
  lines.push(`- isNewTopic: ${s.isNewTopic}`);
  lines.push(`- isClarificationAnswer: ${s.isClarificationAnswer}`);
  lines.push(`- isFollowUp: ${s.isFollowUp}`);
  lines.push(`- hasAmbiguousReferents: ${s.hasAmbiguousReferents}`);
  if (s.rootGoal) {
    const root = s.rootGoal.length > 160 ? `${s.rootGoal.slice(0, 157)}...` : s.rootGoal;
    lines.push(`- rootGoal: "${root}"`);
  }
  if (s.pendingQuestions.length > 0) {
    lines.push(`- pendingQuestions (${s.pendingQuestions.length}):`);
    for (const q of s.pendingQuestions.slice(0, 5)) lines.push(`    - ${q}`);
  }
  if (data.resolvedGoal && data.resolvedGoal !== data.literalGoal) {
    const resolved = data.resolvedGoal.length > 160
      ? `${data.resolvedGoal.slice(0, 157)}...` : data.resolvedGoal;
    lines.push(`- resolvedGoal (prefer over literal): "${resolved}"`);
  }
  if (s.isClarificationAnswer) {
    lines.push(
      '- ROUTING RULE: the user is answering a prior clarification. Preserve the existing workflow (stay in agentic-workflow / do NOT reclassify as conversational or direct-tool) unless the user explicitly asks to change topic.',
    );
  }
  return lines.join('\n');
}

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
