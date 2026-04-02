import type { IsolationLevel, RoutingLevel, ToolResult } from '../types.ts';

export type ToolCategory = 'file_read' | 'file_write' | 'search' | 'shell' | 'vcs' | 'delegation' | 'control';

export interface ToolDescriptor {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description: string; enum?: string[]; items?: { type: string } }>;
    required: string[];
  };
  category: ToolCategory;
  sideEffect: boolean;
  minRoutingLevel: RoutingLevel;
}

export interface Tool {
  name: string;
  description: string;
  minIsolationLevel: IsolationLevel;
  category: ToolCategory;
  /** Whether this tool has side effects (writes to disk, executes commands). */
  sideEffect: boolean;
  /** Returns the tool descriptor for LLM tool manifests. */
  descriptor(): ToolDescriptor;
  execute(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult>;
}

export interface ToolContext {
  routingLevel: RoutingLevel;
  allowedPaths: string[];
  workspace: string;
  overlayDir?: string;
  onDelegate?: (req: { goal: string; targetFiles: string[]; requiredTools?: string[]; context?: string; requestedTokens?: number }) => Promise<ToolResult>;
}

export interface ToolValidationResult {
  valid: boolean;
  reason?: string;
}
