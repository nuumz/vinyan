/**
 * Tool interfaces — types for the tool execution layer.
 * Source of truth: spec/tdd.md §18.1
 */
import type { Evidence } from "../../core/types.ts";
import type { IsolationLevel, RoutingLevel, ToolResult } from "../types.ts";

export type ToolCategory = "file_read" | "file_write" | "search" | "shell" | "vcs";

export interface Tool {
  name: string;
  description: string;
  minIsolationLevel: IsolationLevel;
  category: ToolCategory;
  /** Whether this tool has side effects (writes to disk, executes commands). */
  sideEffect: boolean;
  execute(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult>;
}

export interface ToolContext {
  routingLevel: RoutingLevel;
  allowedPaths: string[];
  workspace: string;
}

export interface ToolValidationResult {
  valid: boolean;
  reason?: string;
}
