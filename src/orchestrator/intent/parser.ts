/**
 * Intent-response parser + helpers.
 *
 * Extracted from `src/orchestrator/intent-resolver.ts` (plan commit D3).
 *
 * Responsibilities:
 *   - strip markdown code fences from LLM JSON output
 *   - parse + validate against IntentResponseSchema
 *   - normalize direct-tool calls (fall back to shell_exec, reject fallback
 *     chains like `cmd1 || cmd2 && cmd3`)
 *   - race-against-timeout helper for LLM calls
 *
 * Everything in this module is pure (no I/O, no module-level state) so
 * tests can exercise the parser without spinning up the orchestrator.
 */

import { z } from 'zod';

// Mirror of the IntentResponseSchema owned by intent-resolver.ts. Kept as a
// named export so downstream code can validate without re-declaring.
//
// Capability vocabulary (capabilityRequirements[].id) is intentionally a
// free-form string here. The agent-router silently scores unknown ids as 0,
// so an invented id is harmless — it falls back to needs-llm. This keeps the
// schema decoupled from the in-tree builtin agent ids and lets users register
// custom agents via vinyan.json without recompiling the parser.
const CapabilityRequirementResponseSchema = z.object({
  id: z.string().min(1),
  weight: z.number().min(0).max(1),
  fileExtensions: z.array(z.string()).optional(),
  actionVerbs: z.array(z.string()).optional(),
  domains: z.array(z.string()).optional(),
  frameworkMarkers: z.array(z.string()).optional(),
  role: z.string().optional(),
});

export const IntentResponseSchema = z.object({
  strategy: z.enum(['full-pipeline', 'direct-tool', 'conversational', 'agentic-workflow']),
  refinedGoal: z.string(),
  reasoning: z.string(),
  directToolCall: z
    .object({
      tool: z.string(),
      parameters: z.record(z.string(), z.unknown()),
    })
    .optional(),
  workflowPrompt: z.string().optional(),
  confidence: z.number().min(0).max(1).optional(),
  /** Multi-agent: id of specialist best-fit for this task. */
  agentId: z.string().optional(),
  agentSelectionReason: z.string().optional(),
  /**
   * Structured capability requirements the LLM extracted from the goal.
   * Forwarded to AgentRouter.route() as `source: 'llm-extract'`. Replaces
   * the legacy `matchCreativeSpecialist` regex — the LLM is now the
   * generator (A1) and the deterministic capability router is the verifier.
   */
  capabilityRequirements: z.array(CapabilityRequirementResponseSchema).optional(),
});

export type IntentResponse = z.infer<typeof IntentResponseSchema>;

/**
 * Strip markdown code fences that some LLMs wrap their JSON output in.
 * Accepts ```json and plain ``` on either end; case-insensitive.
 */
export function stripJsonFences(content: string): string {
  return content.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
}

/**
 * Parse + validate an LLM intent response. Throws on malformed JSON,
 * schema violations, or direct-tool responses missing directToolCall.
 */
export function parseIntentResponse(content: string): IntentResponse {
  const parsed = IntentResponseSchema.parse(JSON.parse(stripJsonFences(content)));
  if (parsed.strategy === 'direct-tool' && !parsed.directToolCall) {
    throw new Error('Direct-tool strategy missing directToolCall');
  }
  return parsed;
}

/**
 * True when the command text contains a shell fallback chain (`||`, `&&`, `;`,
 * newline, or single `|`). Used to reject multi-command direct-tool calls —
 * the classifier must return a single atomic command so downstream tooling
 * can enforce allow-lists precisely.
 *
 * The lone-pipe lookaround (`(?<!\|)\|(?!\|)`) matches `|` that isn't part of
 * `||`, which would catch things like `grep foo | head` — intentional, because
 * pipes are also fallback-like for our purposes (separate processes).
 */
export function containsShellFallbackChain(command: string): boolean {
  return /\|\||&&|;|\r|\n|(?<!\|)\|(?!\|)/.test(command);
}

const KNOWN_TOOLS = new Set([
  'shell_exec',
  'file_read',
  'file_write',
  'file_edit',
  'directory_list',
  'search_grep',
  'git_status',
  'git_diff',
  'search_semantic',
  'http_get',
]);

/**
 * Normalize a direct-tool call:
 *   - unknown tool names fall back to `shell_exec` with the tool name (and
 *     any existing `command` parameter) as the command text
 *   - `shell_exec` commands are trimmed + validated against fallback chains
 *   - non-`shell_exec` known tools pass through unchanged
 *
 * Returns the call unchanged when `strategy !== 'direct-tool'` or the call
 * is absent — callers don't need to branch on strategy themselves.
 */
export function normalizeDirectToolCall(
  strategy: IntentResponse['strategy'],
  directToolCall: IntentResponse['directToolCall'],
): IntentResponse['directToolCall'] {
  if (!directToolCall || strategy !== 'direct-tool') {
    return directToolCall;
  }

  let normalizedCall = directToolCall;
  if (!KNOWN_TOOLS.has(normalizedCall.tool)) {
    const command =
      (normalizedCall.parameters.command as string) ??
      normalizedCall.tool.replace(/_/g, ' ');
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
    throw new Error(
      'Direct-tool shell_exec command must be a single platform-specific command',
    );
  }

  return {
    ...normalizedCall,
    parameters: {
      ...normalizedCall.parameters,
      command: command.trim(),
    },
  };
}

/**
 * Race a promise against a timeout. Rejects with "Intent resolution timeout"
 * if the promise doesn't settle within `ms` milliseconds. Clears the timer
 * on either outcome so long-lived processes don't leak timers.
 */
export function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('Intent resolution timeout')),
      ms,
    );
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}
