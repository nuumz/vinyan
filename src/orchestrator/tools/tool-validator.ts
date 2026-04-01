/**
 * Tool Validator — 4-check validation pipeline for tool calls.
 *
 * 1. Isolation level check
 * 2. Path permission check
 * 3. Shell command allowlist
 * 4. Bypass pattern detection
 *
 * Source of truth: spec/tdd.md §18.1
 */
import { isAbsolute, resolve } from 'path';
import { containsBypassAttempt } from '../../guardrails/index.ts';
import type { IsolationLevel, ToolCall } from '../types.ts';
import type { Tool, ToolContext, ToolValidationResult } from './tool-interface.ts';

const SHELL_ALLOWLIST = new Set([
  'tsc',
  'bun',
  'eslint',
  'prettier',
  'git',
  'cat',
  'head',
  'tail',
  'wc',
  'grep',
  'find',
  'ruff',
]);

/**
 * Interpreters that can execute arbitrary files.
 * These are NOT in SHELL_ALLOWLIST — a worker cannot run `python script.py` or `node file.js`.
 * Only safe sub-commands are allowed via INTERPRETER_SAFE_PATTERNS.
 */
const INTERPRETER_SAFE_PATTERNS: Record<string, RegExp> = {
  bun: /^bun\s+(test|run\s+(test|lint|check|build|typecheck))\b/,
  node: /^node\s+--version$/,
  python: /^python\s+--version$/,
};

const DANGEROUS_SHELL_CHARS = /[;|&`$(){}><\n\\]/;

/** Git subcommands that are destructive or have external side effects. */
const DANGEROUS_GIT_SUBCOMMANDS = new Set(['push', 'reset', 'clean', 'remote']);

/** Dangerous flags for specific git subcommands. */
const DANGEROUS_GIT_FLAGS = new Set(['--force', '-f', '--hard', '--mirror']);

/** Arguments to reject for runtime executables that can run arbitrary code. */
const RUNTIME_DANGEROUS_ARGS = new Set(['--eval', '-e', 'eval']);

export function validateToolCall(call: ToolCall, tool: Tool, context: ToolContext): ToolValidationResult {
  // 1. Isolation level check
  if (context.routingLevel < tool.minIsolationLevel) {
    return {
      valid: false,
      reason: `Tool '${tool.name}' requires isolation level ${tool.minIsolationLevel}, current routing level is ${context.routingLevel}`,
    };
  }

  // 2. Path permission check (for file and search tools)
  if (tool.category === 'file_read' || tool.category === 'file_write' || tool.category === 'search') {
    const filePath = (call.parameters.file_path as string | undefined) ?? (call.parameters.path as string | undefined);
    if (filePath) {
      // Reject absolute paths — agent must use workspace-relative paths
      if (isAbsolute(filePath)) {
        return { valid: false, reason: `Absolute path '${filePath}' is not allowed` };
      }
      const absPath = resolve(context.workspace, filePath);
      // Workspace containment — catches ../ traversal
      if (!absPath.startsWith(context.workspace + '/') && absPath !== context.workspace) {
        return { valid: false, reason: `Path '${filePath}' escapes workspace` };
      }
      if (context.allowedPaths.length > 0) {
        const allowed = context.allowedPaths.some((p) => {
          const absAllowed = resolve(context.workspace, p);
          return absPath.startsWith(absAllowed);
        });
        if (!allowed) {
          return { valid: false, reason: `Path '${filePath}' is outside allowed paths` };
        }
      } else if (tool.category === 'file_write') {
        // No allowedPaths + write tool → deny (zero-trust)
        return { valid: false, reason: `Write to '${filePath}' denied: no allowed paths configured` };
      }
    }
  }

  // 3. Shell command allowlist + metacharacter + subcommand check
  if (tool.name === 'shell_exec') {
    const command = call.parameters.command as string | undefined;
    if (command) {
      const trimmed = command.trim();
      const words = trimmed.split(/\s+/);
      const firstWord = words[0]!;

      // 3a. Check interpreters first — only safe patterns allowed
      const safePattern = INTERPRETER_SAFE_PATTERNS[firstWord];
      if (safePattern) {
        if (!safePattern.test(trimmed)) {
          return { valid: false, reason: `'${firstWord}' is only allowed with safe sub-commands (e.g., 'bun test')` };
        }
        // Safe pattern matched — still check metacharacters
        if (DANGEROUS_SHELL_CHARS.test(trimmed)) {
          return { valid: false, reason: `Shell command contains dangerous metacharacter` };
        }
        return { valid: true };
      }

      // 3b. General allowlist check
      if (!SHELL_ALLOWLIST.has(firstWord)) {
        return { valid: false, reason: `Shell command '${firstWord}' is not in allowlist` };
      }
      if (DANGEROUS_SHELL_CHARS.test(command)) {
        return { valid: false, reason: `Shell command contains dangerous metacharacter` };
      }
      // Git subcommand validation — block destructive operations
      if (firstWord === 'git' && words.length > 1) {
        const subcommand = words[1]!;
        if (DANGEROUS_GIT_SUBCOMMANDS.has(subcommand)) {
          const hasDangerousFlag = words.slice(2).some((w) => DANGEROUS_GIT_FLAGS.has(w));
          if (subcommand === 'push' || subcommand === 'remote' || hasDangerousFlag) {
            return { valid: false, reason: `Dangerous git operation: 'git ${words.slice(1).join(' ')}'` };
          }
        }
      }
    }
  }

  // 4. Bypass pattern detection
  const bypass = containsBypassAttempt(call.parameters);
  if (bypass.detected) {
    return { valid: false, reason: `Bypass attempt detected: ${bypass.patterns.join(', ')}` };
  }

  return { valid: true };
}
