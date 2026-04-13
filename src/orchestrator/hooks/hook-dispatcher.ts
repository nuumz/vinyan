/**
 * Phase 7d-1: Hook dispatcher — matches hook configs against a tool call
 * and runs all matching commands in order. Used by the agent loop to
 * implement the PreToolUse and PostToolUse lifecycle events.
 *
 * Contract:
 *   - PreToolUse: if any hook exits non-zero or returns `{decision: "block"}`
 *     in its JSON stdout, the tool call is blocked. The dispatcher short-
 *     circuits on the first blocker and the agent loop turns the call into
 *     a `denied` ToolResult.
 *   - PostToolUse: hooks observe the result but cannot unwind it. Non-zero
 *     exits are collected as warnings that the caller attaches to the tool
 *     result's output so the LLM can react.
 *
 * Matching is fail-open: an invalid regex pattern logs nothing and just
 * doesn't match anything, so a typo in a matcher can't wedge the agent.
 */

import { executeHook, type HookExecutionResult } from './hook-executor.ts';
import type { HookConfig, HookMatcher } from './hook-schema.ts';

export interface PreToolUsePayload {
  event: 'PreToolUse';
  tool_name: string;
  tool_input: Record<string, unknown>;
}

export interface PostToolUsePayload {
  event: 'PostToolUse';
  tool_name: string;
  tool_input: Record<string, unknown>;
  tool_output: string;
  tool_status: 'success' | 'error' | 'denied';
}

export interface HookInvocation {
  command: string;
  result: HookExecutionResult;
}

export interface PreToolUseResult {
  blocked: boolean;
  reason?: string;
  /** All hook executions that ran, in config order. Empty on no match. */
  invocations: HookInvocation[];
}

export interface PostToolUseResult {
  warnings: string[];
  invocations: HookInvocation[];
}

export interface DispatchOptions {
  cwd: string;
}

/**
 * Return the subset of matchers whose pattern matches the given tool name.
 * Empty matcher string matches every tool. Invalid regex patterns are
 * silently skipped (fail-open) to avoid crashing the agent loop on a typo.
 */
function matchHooks(matchers: HookMatcher[], toolName: string): HookMatcher[] {
  const hits: HookMatcher[] = [];
  for (const m of matchers) {
    if (!m.matcher) {
      hits.push(m);
      continue;
    }
    try {
      const rx = new RegExp(m.matcher);
      if (rx.test(toolName)) hits.push(m);
    } catch {
      // Silently skip invalid regex — the config loader already accepted the
      // string, so the dispatcher is best-effort at the match step.
    }
  }
  return hits;
}

/**
 * Derive a human-readable reason from a hook result. Prefers the JSON
 * `message` field (explicit), then stderr (useful for logs), then a
 * generic fallback.
 */
function reasonFrom(invocation: HookInvocation): string {
  const r = invocation.result;
  if (r.message) return r.message;
  if (r.timedOut) return `Hook timed out: ${invocation.command}`;
  const stderr = r.stderr.trim();
  if (stderr) return stderr.slice(0, 500);
  return `Hook exited ${r.exitCode}: ${invocation.command}`;
}

/**
 * Fire PreToolUse hooks for a tool call. Returns `{ blocked: true, reason }`
 * on the first hook that asks to block (non-zero exit OR `decision=block`),
 * otherwise `{ blocked: false }`. Subsequent hooks after a blocker are NOT
 * executed — the short-circuit mirrors `set -e` semantics so expensive
 * post-gate hooks (linters, auditors) don't run after an early rejection.
 */
export async function dispatchPreToolUse(
  config: HookConfig,
  payload: PreToolUsePayload,
  options: DispatchOptions,
): Promise<PreToolUseResult> {
  const matchers = matchHooks(config.hooks.PreToolUse, payload.tool_name);
  const invocations: HookInvocation[] = [];

  for (const matcher of matchers) {
    for (const hook of matcher.hooks) {
      const result = await executeHook(hook.command, payload, {
        timeoutMs: hook.timeout,
        cwd: options.cwd,
      });
      const invocation: HookInvocation = { command: hook.command, result };
      invocations.push(invocation);

      // Decision precedence: explicit JSON `decision` > exit code.
      const explicitAllow = result.decision === 'allow';
      const explicitBlock = result.decision === 'block';
      const implicitBlock = result.exitCode !== 0;
      if (explicitBlock || (implicitBlock && !explicitAllow)) {
        return {
          blocked: true,
          reason: reasonFrom(invocation),
          invocations,
        };
      }
    }
  }

  return { blocked: false, invocations };
}

/**
 * Fire PostToolUse hooks for a tool call. Collects warnings for every hook
 * that exits non-zero or returns `decision=block`; PostToolUse cannot undo
 * an already-executed tool, so warnings are attached to the tool result
 * instead of blocking.
 */
export async function dispatchPostToolUse(
  config: HookConfig,
  payload: PostToolUsePayload,
  options: DispatchOptions,
): Promise<PostToolUseResult> {
  const matchers = matchHooks(config.hooks.PostToolUse, payload.tool_name);
  const invocations: HookInvocation[] = [];
  const warnings: string[] = [];

  for (const matcher of matchers) {
    for (const hook of matcher.hooks) {
      const result = await executeHook(hook.command, payload, {
        timeoutMs: hook.timeout,
        cwd: options.cwd,
      });
      const invocation: HookInvocation = { command: hook.command, result };
      invocations.push(invocation);

      const explicitAllow = result.decision === 'allow';
      const explicitBlock = result.decision === 'block';
      const implicitBlock = result.exitCode !== 0;
      if (explicitBlock || (implicitBlock && !explicitAllow)) {
        warnings.push(reasonFrom(invocation));
      }
    }
  }

  return { warnings, invocations };
}
