/**
 * Tool Validator — 4-check validation pipeline for tool calls.
 *
 * 1. Isolation level check
 * 2. Path permission check
 * 3. Shell command allowlist
 * 4. Bypass pattern detection
 *
 * Source of truth: vinyan-tdd.md §18.1
 */
import { resolve, isAbsolute } from "path";
import { containsBypassAttempt } from "../../guardrails/index.ts";
import type { ToolCall, IsolationLevel } from "../types.ts";
import type { Tool, ToolContext, ToolValidationResult } from "./tool-interface.ts";

const SHELL_ALLOWLIST = new Set([
  "tsc", "bun", "eslint", "prettier", "git", "node", "python",
  "cat", "head", "tail", "wc", "grep", "find", "ruff",
]);

const DANGEROUS_SHELL_CHARS = /[;|&`$(){}><\n\\]/;

export function validateToolCall(
  call: ToolCall,
  tool: Tool,
  context: ToolContext,
): ToolValidationResult {
  // 1. Isolation level check
  if (context.routingLevel < tool.minIsolationLevel) {
    return { valid: false, reason: `Tool '${tool.name}' requires isolation level ${tool.minIsolationLevel}, current routing level is ${context.routingLevel}` };
  }

  // 2. Path permission check (for file tools)
  if (tool.category === "file_read" || tool.category === "file_write") {
    const filePath = call.parameters.file_path as string | undefined
      ?? call.parameters.path as string | undefined;
    if (filePath) {
      // Reject absolute paths — agent must use workspace-relative paths
      if (isAbsolute(filePath)) {
        return { valid: false, reason: `Absolute path '${filePath}' is not allowed` };
      }
      const absPath = resolve(context.workspace, filePath);
      // Workspace containment — catches ../ traversal
      if (!absPath.startsWith(context.workspace + "/") && absPath !== context.workspace) {
        return { valid: false, reason: `Path '${filePath}' escapes workspace` };
      }
      if (context.allowedPaths.length > 0) {
        const allowed = context.allowedPaths.some(p => {
          const absAllowed = resolve(context.workspace, p);
          return absPath.startsWith(absAllowed);
        });
        if (!allowed) {
          return { valid: false, reason: `Path '${filePath}' is outside allowed paths` };
        }
      } else if (tool.category === "file_write") {
        // No allowedPaths + write tool → deny (zero-trust)
        return { valid: false, reason: `Write to '${filePath}' denied: no allowed paths configured` };
      }
    }
  }

  // 3. Shell command allowlist + metacharacter check
  if (tool.name === "shell_exec") {
    const command = call.parameters.command as string | undefined;
    if (command) {
      const firstWord = command.trim().split(/\s+/)[0]!;
      if (!SHELL_ALLOWLIST.has(firstWord)) {
        return { valid: false, reason: `Shell command '${firstWord}' is not in allowlist` };
      }
      if (DANGEROUS_SHELL_CHARS.test(command)) {
        return { valid: false, reason: `Shell command contains dangerous metacharacter` };
      }
    }
  }

  // 4. Bypass pattern detection
  const bypass = containsBypassAttempt(call.parameters);
  if (bypass.detected) {
    return { valid: false, reason: `Bypass attempt detected: ${bypass.patterns.join(", ")}` };
  }

  return { valid: true };
}
