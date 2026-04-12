import type { IsolationLevel, PlanTodoInput, RoutingLevel, ToolResult } from '../types.ts';

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
  onDelegate?: (req: {
    goal: string;
    targetFiles: string[];
    requiredTools?: string[];
    context?: string;
    requestedTokens?: number;
    /** Phase 7c-1: typed subagent (explore/plan/general-purpose). */
    subagentType?: 'explore' | 'plan' | 'general-purpose';
  }) => Promise<ToolResult>;
  /**
   * Phase 7c-2: plan_update hook. The agent loop binds this to its
   * `SessionProgress.recordPlanUpdate` so the control tool can install a new
   * snapshot of the session plan without needing orchestrator state passed
   * through the tool executor. Returns a validation error message if the
   * plan was rejected (e.g. two items in_progress), or null on success.
   */
  onPlanUpdate?: (todos: PlanTodoInput[]) => { ok: true; count: number } | { ok: false; error: string };
}

export interface ToolValidationResult {
  valid: boolean;
  reason?: string;
  /** If true, user can interactively approve this denied tool call. */
  canApprove?: boolean;
}
