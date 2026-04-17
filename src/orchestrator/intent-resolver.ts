/**
 * Intent Resolver — LLM-powered semantic intent classification.
 *
 * Replaces regex-based classification with a fast LLM call that understands
 * the user's goal semantically, classifies the execution strategy, and
 * generates tailored workflow prompts.
 *
 * A3 compliance: This is a pre-routing advisory step. The LLM enriches
 * classification but doesn't override governance. Fallback to rule-based
 * classification (existing regex path) when LLM is unavailable.
 *
 * Source of truth: docs/spec/tdd.md §16 (Core Loop)
 */

import { z } from 'zod';
import type { VinyanBus } from '../core/bus.ts';
import type { LLMProviderRegistry } from './llm/provider-registry.ts';
import type {
  AgentSpec,
  ConversationEntry,
  ExecutionStrategy,
  IntentResolution,
  LLMProvider,
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

export interface StructuralFeatures {
  /** Goal length in characters after trim. */
  lengthChars: number;
  /** True when the goal ends with a punctuation or particle that marks it as a question. */
  endsWithQuestion: boolean;
  /** Number of the current turn in the session (1-indexed). */
  turnNumber: number;
}

const THAI_QUESTION_PARTICLE_REGEX = /(ไหม|มั้ย|หรือเปล่า|หรอ|รึเปล่า|หรือไม่)[\s.?？]*$/u;

export function computeStructuralFeatures(
  goal: string,
  history?: ConversationEntry[],
): StructuralFeatures {
  const trimmed = goal.trim();
  // Accept ASCII '?' and full-width '？' (U+FF1F, common in Thai/CJK IME input)
  // plus trailing Thai interrogative particles.
  const endsWithQuestion =
    trimmed.endsWith('?') ||
    trimmed.endsWith('？') ||
    THAI_QUESTION_PARTICLE_REGEX.test(trimmed);
  return {
    lengthChars: trimmed.length,
    endsWithQuestion,
    turnNumber: Math.floor((history?.length ?? 0) / 2) + 1,
  };
}

function renderStructuralFeatures(f: StructuralFeatures): string {
  return `Goal metadata (deterministic): length=${f.lengthChars} chars; ends with question marker: ${f.endsWithQuestion ? 'yes' : 'no'}; session turn: #${f.turnNumber}`;
}

// ---------------------------------------------------------------------------
// Session cache — skip re-classifying identical goals within a short TTL.
// Keyed by (sessionId, goal). Process-global; tests must call
// clearIntentResolverCache() between cases to avoid cross-contamination.
// ---------------------------------------------------------------------------

const INTENT_CACHE_TTL_MS = 30_000;
/**
 * Pruning threshold — eviction of expired entries runs only when the cache
 * reaches this size. Keeps the common (small-cache) path zero-overhead while
 * preventing unbounded growth in long-running processes.
 */
const INTENT_CACHE_PRUNE_THRESHOLD = 64;
/** Hard cap — when live entries exceed this after pruning, drop oldest first. */
const INTENT_CACHE_MAX_SIZE = 256;
const intentCache = new Map<string, { result: IntentResolution; expiresAt: number }>();

function buildCacheKey(goal: string, sessionId?: string): string {
  return `${sessionId ?? '__nosess__'}::${goal.trim().toLowerCase()}`;
}

/** Evict expired entries and enforce the hard size cap. */
function pruneIntentCache(now: number): void {
  if (intentCache.size < INTENT_CACHE_PRUNE_THRESHOLD) return;
  for (const [key, entry] of intentCache) {
    if (entry.expiresAt <= now) intentCache.delete(key);
  }
  // If every remaining entry is still live AND we blew past the hard cap,
  // drop the oldest (insertion-ordered) until we're back under the limit.
  if (intentCache.size > INTENT_CACHE_MAX_SIZE) {
    const overflow = intentCache.size - INTENT_CACHE_MAX_SIZE;
    let dropped = 0;
    for (const key of intentCache.keys()) {
      if (dropped >= overflow) break;
      intentCache.delete(key);
      dropped++;
    }
  }
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
): ExecutionStrategy {
  if (taskDomain === 'conversational') return 'conversational';
  if (taskDomain === 'general-reasoning' && taskIntent === 'inquire') return 'conversational';
  if (taskIntent === 'execute' && toolRequirement === 'tool-needed' && taskDomain !== 'code-mutation') return 'direct-tool';
  // Creative/generative tasks (execute + no tools + general-reasoning) need agentic-workflow, not full-pipeline
  if (taskIntent === 'execute' && toolRequirement === 'none' && taskDomain === 'general-reasoning') return 'agentic-workflow';
  return 'full-pipeline';
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

export async function resolveIntent(
  input: TaskInput,
  deps: IntentResolverDeps,
): Promise<IntentResolution> {
  const now = deps.now?.() ?? Date.now();

  // 0. Cache — skip re-classifying identical (session, goal) pairs within TTL.
  // Keeps latency + token cost predictable when a user repeats themselves
  // ("ok", "ทำเลย") or the TUI re-invokes resolution on the same input.
  const cacheKey = buildCacheKey(input.goal, deps.sessionId);
  const cached = intentCache.get(cacheKey);
  if (cached && cached.expiresAt > now) {
    return { ...cached.result, reasoningSource: 'cache' };
  }

  // 1. Provider selection — balanced first for accuracy.
  const primary = pickPrimaryProvider(deps.registry);
  if (!primary) {
    throw new Error('No LLM provider available for intent resolution');
  }

  // 2. Build user prompt. Structural features are deterministic metadata
  // (length, end-of-sentence marker, turn number) — NOT pattern matching;
  // they give the classifier useful signal without baking in keyword lists.
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

  const userPrompt = `User goal: "${input.goal}"
Task type: ${input.taskType}
Target files: ${input.targetFiles?.join(', ') || 'none'}
Constraints: ${input.constraints?.join(', ') || 'none'}
Current platform: ${process.platform}
Available tools: ${toolList}${structuralBlock}${agentsBlock}${preferencesBlock}${userContextBlock}${conversationBlock}`;

  // 3. Classify. One attempt at primary; on parse/semantic failure, one retry
  // with any alternate tier. No confidence-based escalation — balanced is
  // already our strongest default.
  let parsed: z.infer<typeof IntentResponseSchema>;
  try {
    parsed = await classifyOnce(primary, userPrompt);
  } catch (firstError) {
    const alternate = pickAlternateProvider(deps.registry, primary.id);
    if (!alternate) throw firstError;
    parsed = await classifyOnce(alternate, userPrompt);
  }

  // 4. Resolve specialist agent + cache the result + return.
  const { agentId, agentSelectionReason } = resolveSelectedAgent(
    input,
    deps.agents,
    deps.defaultAgentId,
    { agentId: parsed.agentId, agentSelectionReason: parsed.agentSelectionReason },
  );

  const result: IntentResolution = {
    strategy: parsed.strategy,
    refinedGoal: parsed.refinedGoal,
    directToolCall: parsed.directToolCall,
    workflowPrompt: parsed.workflowPrompt,
    confidence: parsed.confidence ?? 0.8,
    reasoning: parsed.reasoning,
    reasoningSource: 'llm',
    agentId,
    agentSelectionReason,
  };

  pruneIntentCache(now);
  intentCache.set(cacheKey, { result, expiresAt: now + INTENT_CACHE_TTL_MS });
  return result;
}
