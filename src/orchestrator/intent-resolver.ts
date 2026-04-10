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
import type { ExecutionStrategy, IntentResolution, TaskInput } from './types.ts';

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
- workflowPrompt: (only if strategy="agentic-workflow") a detailed execution prompt for the downstream agent

Strategy rules:
- "conversational": greetings, questions, explanations, meta-questions about the system
- "direct-tool": single tool invocation — open app, run command, capture screenshot, check status
- "agentic-workflow": multi-step tasks needing planning — refactor+deploy, build+test+release, complex workflows
- "full-pipeline": code modification tasks with file targets, bug fixes, feature additions

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
  return 'full-pipeline';
}

// ---------------------------------------------------------------------------
// Main resolver
// ---------------------------------------------------------------------------

export interface IntentResolverDeps {
  registry: LLMProviderRegistry;
  availableTools?: string[];
  bus?: VinyanBus;
}

const INTENT_TIMEOUT_MS = 3000;

export async function resolveIntent(
  input: TaskInput,
  deps: IntentResolverDeps,
): Promise<IntentResolution> {
  const provider = deps.registry.selectByTier('fast') ?? deps.registry.selectByTier('balanced');
  if (!provider) {
    throw new Error('No LLM provider available for intent resolution');
  }

  const toolList = deps.availableTools?.join(', ') ?? 'shell_exec, file_read, file_write, file_edit, directory_list, search_grep, git_status, git_diff';

  const userPrompt = `User goal: "${input.goal}"
Task type: ${input.taskType}
Target files: ${input.targetFiles?.join(', ') || 'none'}
Constraints: ${input.constraints?.join(', ') || 'none'}
Available tools: ${toolList}`;

  const response = await withTimeout(
    provider.generate({
      systemPrompt: INTENT_SYSTEM_PROMPT,
      userPrompt,
      maxTokens: 500,
      temperature: 0,
    }),
    INTENT_TIMEOUT_MS,
  );

  const content = response.content.trim();

  // Strip markdown fences if present (defensive)
  const jsonStr = content.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
  const parsed = IntentResponseSchema.parse(JSON.parse(jsonStr));

  // Defensive: normalize hallucinated tool names to shell_exec
  let directToolCall = parsed.directToolCall;
  if (directToolCall && parsed.strategy === 'direct-tool') {
    const KNOWN_TOOLS = new Set([
      'shell_exec', 'file_read', 'file_write', 'file_edit',
      'directory_list', 'search_grep', 'git_status', 'git_diff',
      'search_semantic', 'http_get',
    ]);
    if (!KNOWN_TOOLS.has(directToolCall.tool)) {
      // LLM hallucinated a tool name — rewrite as shell_exec
      const command = (directToolCall.parameters.command as string)
        ?? directToolCall.tool.replace(/_/g, ' ');
      directToolCall = {
        tool: 'shell_exec',
        parameters: { ...directToolCall.parameters, command },
      };
    }
  }

  return {
    strategy: parsed.strategy,
    refinedGoal: parsed.refinedGoal,
    directToolCall,
    workflowPrompt: parsed.workflowPrompt,
    confidence: parsed.confidence ?? 0.8,
    reasoning: parsed.reasoning,
  };
}
