import type { IsolationLevel, RoutingLevel, ToolResult } from '../types.ts';

export type ToolCategory = 'file_read' | 'file_write' | 'search' | 'shell' | 'vcs' | 'delegation' | 'control';

export type ToolKind = 'executable' | 'control';

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
  /** Whether this tool executes real work or is an orchestrator control signal. */
  toolKind: ToolKind;
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
  /**
   * Agent Conversation — consult_peer (PR #7): lightweight second-opinion
   * callback wired by agent-loop.ts at L1+ when an LLM provider registry
   * is available. Distinct from `onDelegate`: does NOT spawn a full child
   * pipeline, just a single cross-model LLM call with a capped budget.
   */
  onConsult?: (req: { question: string; context?: string; requestedTokens?: number }) => Promise<ToolResult>;
}

export interface ToolValidationResult {
  valid: boolean;
  reason?: string;
  /** If true, user can interactively approve this denied tool call. */
  canApprove?: boolean;
}
