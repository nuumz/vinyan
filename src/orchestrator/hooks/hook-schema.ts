/**
 * Phase 7d-1: Hook system — Zod schema for `.vinyan/hooks.json`.
 *
 * Vinyan's hook system is modeled after Claude Code's hooks: users declare
 * shell commands keyed by lifecycle event and matched against the tool name.
 * The orchestrator fires matching commands before/after each tool call, pipes
 * a JSON payload to stdin, and interprets the hook's exit code (and optional
 * JSON stdout) to decide whether the call is allowed, blocked, or warned.
 *
 * Phase 7d-1 MVP only ships tool-execution events:
 *   - `PreToolUse`  fires before every tool call and CAN block the call.
 *   - `PostToolUse` fires after every tool call and CAN attach warnings,
 *                   but cannot unwind the already-committed result.
 *
 * Future phases will add UserPromptSubmit, Stop, SessionStart, etc.
 */

import { z } from 'zod/v4';

/** Supported hook lifecycle events. */
export const HookEventSchema = z.enum(['PreToolUse', 'PostToolUse']);
export type HookEvent = z.infer<typeof HookEventSchema>;

/**
 * A single hook command. Phase 7d-1 only supports `type: 'command'` — shell
 * commands run via `sh -c`. Future types (`mcp`, `script`) may be added.
 */
const HookCommandSchema = z.object({
  /** Command kind. Always `'command'` in Phase 7d-1. */
  type: z.literal('command').default('command'),
  /** Shell command to execute. Run under `sh -c` in the workspace cwd. */
  command: z.string().min(1),
  /**
   * Per-hook timeout in ms. Hooks that run longer are killed with SIGKILL
   * and treated as a hard failure (blocks PreToolUse, warns PostToolUse).
   * Defaults to 5s — hooks should be fast gates, not long-running tasks.
   * Hard cap is 60s to prevent a runaway hook from stalling the agent.
   */
  timeout: z.number().int().positive().max(60_000).default(5_000),
});

/**
 * A matcher-to-commands mapping. The `matcher` is a regex string tested
 * against the tool name. An empty matcher matches every tool — convenient
 * for global audit hooks but should be used sparingly since it fires on
 * every single tool call.
 */
const HookMatcherSchema = z.object({
  /**
   * Regex pattern (string form) matched against the tool name. Empty string
   * or omitted field matches every tool. Invalid regex patterns are treated
   * as non-matching at dispatch time (fail-open) to keep a typo in the
   * config from wedging the entire agent loop.
   */
  matcher: z.string().default(''),
  hooks: z.array(HookCommandSchema).min(1),
});

/**
 * Root hook-config schema. All event arrays default to empty so a bare
 * `{}` file and a missing file are functionally equivalent.
 */
export const HookConfigSchema = z.object({
  hooks: z
    .object({
      PreToolUse: z.array(HookMatcherSchema).default([]),
      PostToolUse: z.array(HookMatcherSchema).default([]),
    })
    .default({ PreToolUse: [], PostToolUse: [] }),
});

export type HookConfig = z.infer<typeof HookConfigSchema>;
export type HookCommand = z.infer<typeof HookCommandSchema>;
export type HookMatcher = z.infer<typeof HookMatcherSchema>;

/** Empty hook config used as the default when no file is present. */
export const EMPTY_HOOK_CONFIG: HookConfig = HookConfigSchema.parse({});
