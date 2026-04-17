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
import type { ConversationEntry, ExecutionStrategy, IntentResolution, TaskInput } from './types.ts';

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
   - Simple factual questions answerable in 1-3 sentences ("what is X", "how does Y work") → "conversational"
   - Meta-questions about system capabilities → "conversational"
   - NEVER "conversational" if the user asks to CREATE, WRITE, BUILD, or GENERATE anything (stories, essays, summaries, reports, poems, websites, apps, systems, diagrams)
   - NEVER "conversational" if the answer would require more than a short paragraph
   - "แต่งนิยาย", "เขียนเรื่อง", "write a story", "compose", "draft" → ALWAYS "agentic-workflow", NOT "conversational"
   - "ทำเว็บ", "ทำแอพ", "ทำระบบ", "สร้างเว็บ", "พัฒนาระบบ", "build a website/app", "develop X" → ALWAYS "agentic-workflow"
   - "สรุป", "วิเคราะห์", "summarize", "analyze", "research" → ALWAYS "agentic-workflow"
   - CRITICAL: Question FORM does not mean conversational INTENT. "สามารถทำ X ได้ไหม", "ช่วยทำ X ได้ไหม", "can you build X?", "could you create X?" — when X is a concrete deliverable (web, app, feature, document, artifact), this is a REQUEST TO DO X → "agentic-workflow".
   - CRITICAL: Short affirmative follow-ups ("ทำเลย", "เอาเลย", "ok", "go", "เริ่มเลย", "จัดไป", "ลุย") that confirm a previously proposed action → "agentic-workflow" with workflowPrompt reconstructed from the recent conversation. Use the "Recent conversation" context to recover what action was proposed.

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
}

const INTENT_TIMEOUT_MS = 8000;

export async function resolveIntent(
  input: TaskInput,
  deps: IntentResolverDeps,
): Promise<IntentResolution> {
  const provider = deps.registry.selectByTier('tool-uses') ?? deps.registry.selectByTier('fast') ?? deps.registry.selectByTier('balanced');
  if (!provider) {
    throw new Error('No LLM provider available for intent resolution');
  }

  const toolList = deps.availableTools?.join(', ') ?? 'shell_exec, file_read, file_write, file_edit, directory_list, search_grep, git_status, git_diff';

  const preferencesBlock = deps.userPreferences ? `\n${deps.userPreferences}` : '';
  const conversationBlock = formatConversationContext(deps.conversationHistory);
  const userPrompt = `User goal: "${input.goal}"
Task type: ${input.taskType}
Target files: ${input.targetFiles?.join(', ') || 'none'}
Constraints: ${input.constraints?.join(', ') || 'none'}
Current platform: ${process.platform}
Available tools: ${toolList}${preferencesBlock}${conversationBlock}`;

  const response = await withTimeout(
    provider.generate({
      systemPrompt: INTENT_SYSTEM_PROMPT,
      userPrompt,
      maxTokens: 500,
      temperature: 0,
    }),
    INTENT_TIMEOUT_MS,
  );

  let content = response.content.trim();

  let parsed: z.infer<typeof IntentResponseSchema>;
  try {
    parsed = parseIntentResponse(content);
    parsed.directToolCall = normalizeDirectToolCall(parsed.strategy, parsed.directToolCall);
  } catch (firstError) {
    // Fast-tier model returned malformed or semantically invalid structured output.
    // Retry once with balanced tier before giving up.
    const balancedProvider = deps.registry.selectByTier('balanced');
    if (balancedProvider && balancedProvider.id !== provider.id) {
      const retryResponse = await withTimeout(
        balancedProvider.generate({
          systemPrompt: INTENT_SYSTEM_PROMPT,
          userPrompt,
          maxTokens: 500,
          temperature: 0,
        }),
        INTENT_TIMEOUT_MS,
      );
      content = retryResponse.content.trim();
      parsed = parseIntentResponse(content);
      parsed.directToolCall = normalizeDirectToolCall(parsed.strategy, parsed.directToolCall);
    } else {
      throw firstError;
    }
  }

  // Trust-based escalation: when fast tier classifies a non-trivial goal as
  // "conversational" with low confidence, retry with a stronger tier. This
  // catches cases where fast models miss generative/follow-up intent (e.g.,
  // "สามารถทำเว็บได้ไหม" — question form, action intent).
  const isNonTrivial =
    input.goal.trim().length > 30 ||
    (deps.conversationHistory?.length ?? 0) > 0;
  const lowConfidenceConversational =
    parsed.strategy === 'conversational' &&
    (parsed.confidence ?? 0.8) < 0.75 &&
    isNonTrivial;
  if (lowConfidenceConversational) {
    const balancedProvider = deps.registry.selectByTier('balanced');
    if (balancedProvider && balancedProvider.id !== provider.id) {
      try {
        const retryResponse = await withTimeout(
          balancedProvider.generate({
            systemPrompt: INTENT_SYSTEM_PROMPT,
            userPrompt: `${userPrompt}\n\nNote: A previous classifier returned "conversational" with low confidence. Re-examine carefully — does the goal actually request action, generation, or analysis (in which case use "agentic-workflow" or "full-pipeline")?`,
            maxTokens: 500,
            temperature: 0,
          }),
          INTENT_TIMEOUT_MS,
        );
        const retryParsed = parseIntentResponse(retryResponse.content.trim());
        retryParsed.directToolCall = normalizeDirectToolCall(retryParsed.strategy, retryParsed.directToolCall);
        if (retryParsed.strategy !== 'conversational') {
          retryParsed.reasoning = `[escalated from low-confidence conversational] ${retryParsed.reasoning}`;
        }
        parsed = retryParsed;
      } catch {
        // Retry failed — keep original classification rather than fail
      }
    }
  }

  return {
    strategy: parsed.strategy,
    refinedGoal: parsed.refinedGoal,
    directToolCall: parsed.directToolCall,
    workflowPrompt: parsed.workflowPrompt,
    confidence: parsed.confidence ?? 0.8,
    reasoning: parsed.reasoning,
  };
}
