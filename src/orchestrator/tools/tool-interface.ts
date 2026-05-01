import type { IsolationLevel, PlanTodoInput, RoutingLevel, ToolResult } from '../types.ts';

export type ToolCategory = 'file_read' | 'file_write' | 'search' | 'shell' | 'vcs' | 'delegation' | 'control';

export type ToolKind = 'executable' | 'control';

export interface ToolSchemaProperty {
  type: string;
  description: string;
  enum?: string[];
  items?: { type: string };
  properties?: Record<string, ToolSchemaProperty>;
  required?: string[];
}

export interface ToolDescriptor {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, ToolSchemaProperty>;
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
  /**
   * Phase-11: id of the surrounding TaskInput. When present, side-channel
   * tools (e.g. `skill_view`) can attribute usage signals back to the task
   * via the bus. Optional because not every executor has a task scope —
   * direct CLI tool calls and tests run without one.
   */
  taskId?: string;
  /**
   * R4 fail-closed input. When this task is delegated (i.e. has a
   * `parentTaskId`), tool-executor refuses tool calls if no
   * `capabilityToken` is present — silent grant of full access on a
   * delegated path is forbidden. Top-level tasks leave this undefined
   * and the failsafe is inert.
   */
  parentTaskId?: string;
  /**
   * R4 — runtime capability token issued by `delegation-router` when the
   * task is a delegated sub-task. When present, the executor consults
   * `checkCapability(...)` before running mutation-class tools so the
   * subagentType contract is enforced at runtime, not just at
   * delegation validation time. Top-level (non-delegated) tasks omit
   * this — caller owns the policy. See `src/core/capability-token.ts`.
   */
  capabilityToken?: import('../../core/capability-token.ts').CapabilityToken;
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
   * Agent Conversation — consult_peer (PR #7): lightweight second-opinion
   * callback wired by agent-loop.ts at L1+ when an LLM provider registry
   * is available. Distinct from `onDelegate`: does NOT spawn a full child
   * pipeline, just a single cross-model LLM call with a capped budget.
   */
  onConsult?: (req: {
    question: string;
    context?: string;
    requestedTokens?: number;
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
