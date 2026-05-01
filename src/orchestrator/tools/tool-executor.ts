/**
 * Tool Executor — validates and executes proposed tool calls.
 *
 * Iterates proposed ToolCall[], validates each against the 4-check pipeline,
 * executes allowed calls, and collects ToolResult[].
 *
 * Source of truth: spec/tdd.md §18.1, §18.4
 */
import { createHash } from 'crypto';
import { checkCapability } from '../../core/capability-token.ts';
import type { Evidence } from '../../core/types.ts';
import type { ToolCall, ToolResult } from '../types.ts';
import { BUILT_IN_TOOLS } from './built-in-tools.ts';
import type { CommandApprovalGate } from './command-approval-gate.ts';
import type { Tool, ToolContext } from './tool-interface.ts';
import { validateToolCall } from './tool-validator.ts';

export class ToolExecutor {
  private tools: Map<string, Tool>;
  private commandApprovalGate?: CommandApprovalGate;

  constructor(additionalTools?: Map<string, Tool>, commandApprovalGate?: CommandApprovalGate) {
    this.tools = new Map(BUILT_IN_TOOLS);
    if (additionalTools) {
      for (const [name, tool] of additionalTools) {
        this.tools.set(name, tool);
      }
    }
    this.commandApprovalGate = commandApprovalGate;
  }

  async executeProposedTools(calls: ToolCall[], context: ToolContext): Promise<ToolResult[]> {
    const results: ToolResult[] = [];

    for (const call of calls) {
      const startTime = performance.now();
      const tool = this.tools.get(call.tool);

      if (!tool) {
        results.push({
          callId: call.id,
          tool: call.tool,
          status: 'denied',
          error: `Unknown tool: ${call.tool}`,
          durationMs: 0,
        });
        continue;
      }

      // R4 — runtime capability check. When a token is present (this is
      // a delegated sub-task), enforce subagentType / allowedTools /
      // forbiddenTools / allowedPaths BEFORE the tool's own validator
      // runs. Top-level tasks pass no token and the check is a pass-
      // through (returns ok: true with tokenId: null).
      //
      // Failsafe (A6): if the context says this is a delegated task
      // (parentTaskId present) but no capabilityToken is wired, fail
      // closed. buildSubTaskInput always issues a token, so this only
      // triggers when a future code path constructs a sub-TaskInput
      // bypassing the router — never silently grant full access.
      if (context.parentTaskId !== undefined && !context.capabilityToken) {
        results.push({
          callId: call.id,
          tool: call.tool,
          status: 'denied',
          error: `capability_token: token_missing — delegated task ${context.parentTaskId} lacks a capability token; refusing tool "${call.tool}"`,
          durationMs: 0,
        });
        continue;
      }
      const targetPath = typeof call.parameters.path === 'string' ? call.parameters.path : undefined;
      const capCheck = checkCapability({
        token: context.capabilityToken,
        toolName: call.tool,
        ...(targetPath !== undefined ? { targetPath } : {}),
      });
      if (!capCheck.ok) {
        results.push({
          callId: call.id,
          tool: call.tool,
          status: 'denied',
          error: `capability_token: ${capCheck.reason} — ${capCheck.detail}`,
          durationMs: 0,
        });
        continue;
      }

      const validation = validateToolCall(call, tool, context);
      if (!validation.valid) {
        // If the command can be user-approved, ask before denying
        if (validation.canApprove && this.commandApprovalGate) {
          const command = (call.parameters.command as string) ?? '';
          const decision = await this.commandApprovalGate.requestApproval(command, validation.reason ?? 'Unknown');
          if (decision === 'approved') {
            // User approved — execute the tool bypassing allowlist
            const result = await tool.execute({ ...call.parameters, callId: call.id }, context);
            result.callId = call.id;
            result.durationMs = Math.round(performance.now() - startTime);
            results.push(result);
            continue;
          }
        }
        results.push({
          callId: call.id,
          tool: call.tool,
          status: 'denied',
          error: validation.reason,
          durationMs: 0,
        });
        continue;
      }

      const result = await tool.execute({ ...call.parameters, callId: call.id }, context);
      result.callId = call.id;
      result.durationMs = Math.round(performance.now() - startTime);
      results.push(result);
    }

    return results;
  }

  /** Partition tool calls into read-only and mutating (side-effect) groups. */
  partitionBySideEffect(calls: ToolCall[]): { readOnly: ToolCall[]; mutating: ToolCall[] } {
    const readOnly: ToolCall[] = [];
    const mutating: ToolCall[] = [];
    for (const call of calls) {
      const tool = this.tools.get(call.tool);
      if (tool?.sideEffect === false) {
        readOnly.push(call);
      } else {
        // Unknown tools or side-effect tools go to mutating (conservative)
        mutating.push(call);
      }
    }
    return { readOnly, mutating };
  }

  getToolNames(): string[] {
    return Array.from(this.tools.keys());
  }

  /**
   * Phase 7e: register a tool after construction. Used by the factory
   * to merge MCP-discovered tools into the executor once the MCP client
   * pool has finished `initialize()` — MCP connection is async and we
   * don't want to block orchestrator startup on remote servers.
   */
  registerTool(name: string, tool: Tool): void {
    this.tools.set(name, tool);
  }
}

/** Convert a ToolResult to ECP Evidence with content hash (TDD §18.4). */
export function toolResultToEvidence(result: ToolResult, call: ToolCall): Evidence {
  const raw = typeof result.output === 'string' ? result.output : JSON.stringify(result.output ?? '');
  return {
    file: result.evidence?.file ?? (call.parameters.file_path as string) ?? (call.parameters.path as string) ?? '',
    line: result.evidence?.line ?? 0,
    snippet: raw.slice(0, 200),
    contentHash: result.evidence?.contentHash ?? createHash('sha256').update(raw).digest('hex'),
  };
}
