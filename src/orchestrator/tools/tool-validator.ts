/**
 * Tool Validator — 4-check validation pipeline for tool calls.
 *
 * 1. Isolation level check
 * 2. Path permission check
 * 3. Shell command policy (centralized in shell-policy.ts)
 * 4. Bypass pattern detection
 *
 * Source of truth: spec/tdd.md §18.1
 */
import { isAbsolute, resolve } from 'path';
import { containsBypassAttempt } from '../../guardrails/index.ts';
import type { ToolCall } from '../types.ts';
import { parseShellCommand } from './shell-command-parser.ts';
import { evaluateCommand } from './shell-policy.ts';
import type { Tool, ToolContext, ToolValidationResult } from './tool-interface.ts';

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
      if (!absPath.startsWith(`${context.workspace}/`) && absPath !== context.workspace) {
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

  // 3. Shell command policy (centralized in shell-policy.ts)
  if (tool.name === 'shell_exec') {
    const command = call.parameters.command as string | undefined;
    if (command) {
      const parsed = parseShellCommand(command);
      const policy = evaluateCommand(parsed);
      if (!policy.allowed) {
        return { valid: false, reason: policy.reason ?? `Shell command '${parsed.executable}' denied`, canApprove: policy.canApprove };
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
