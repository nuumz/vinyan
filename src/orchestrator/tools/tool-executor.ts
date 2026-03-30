/**
 * Tool Executor — validates and executes proposed tool calls.
 *
 * Iterates proposed ToolCall[], validates each against the 4-check pipeline,
 * executes allowed calls, and collects ToolResult[].
 *
 * Source of truth: vinyan-tdd.md §18.1, §18.4
 */
import { createHash } from "crypto";
import type { Evidence } from "../../core/types.ts";
import type { ToolCall, ToolResult } from "../types.ts";
import type { Tool, ToolContext } from "./tool-interface.ts";
import { validateToolCall } from "./tool-validator.ts";
import { BUILT_IN_TOOLS } from "./built-in-tools.ts";

export class ToolExecutor {
  private tools: Map<string, Tool>;

  constructor(additionalTools?: Map<string, Tool>) {
    this.tools = new Map(BUILT_IN_TOOLS);
    if (additionalTools) {
      for (const [name, tool] of additionalTools) {
        this.tools.set(name, tool);
      }
    }
  }

  async executeProposedTools(
    calls: ToolCall[],
    context: ToolContext,
  ): Promise<ToolResult[]> {
    const results: ToolResult[] = [];

    for (const call of calls) {
      const startTime = performance.now();
      const tool = this.tools.get(call.tool);

      if (!tool) {
        results.push({
          callId: call.id,
          tool: call.tool,
          status: "denied",
          error: `Unknown tool: ${call.tool}`,
          duration_ms: 0,
        });
        continue;
      }

      const validation = validateToolCall(call, tool, context);
      if (!validation.valid) {
        results.push({
          callId: call.id,
          tool: call.tool,
          status: "denied",
          error: validation.reason,
          duration_ms: 0,
        });
        continue;
      }

      const result = await tool.execute(
        { ...call.parameters, _callId: call.id },
        context,
      );
      result.callId = call.id;
      result.duration_ms = Math.round(performance.now() - startTime);
      results.push(result);
    }

    return results;
  }

  getToolNames(): string[] {
    return Array.from(this.tools.keys());
  }
}

/** Convert a ToolResult to ECP Evidence with content hash (TDD §18.4). */
export function toolResultToEvidence(result: ToolResult, call: ToolCall): Evidence {
  const raw = typeof result.output === "string" ? result.output : JSON.stringify(result.output ?? "");
  return {
    file: result.evidence?.file ?? (call.parameters.file_path as string) ?? (call.parameters.path as string) ?? "",
    line: result.evidence?.line ?? 0,
    snippet: raw.slice(0, 200),
    contentHash: result.evidence?.contentHash ?? createHash("sha256").update(raw).digest("hex"),
  };
}
