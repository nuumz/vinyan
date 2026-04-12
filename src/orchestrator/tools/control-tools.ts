/**
 * Control tools — attempt_completion, request_budget_extension, delegate_task,
 * plan_update. These are `toolKind: 'control'` tools intercepted by the agent
 * loop rather than executed as normal work.
 */

import type { PlanTodoInput } from '../types.ts';
import { makeResult } from './built-in-tools.ts';
import type { Tool, ToolDescriptor } from './tool-interface.ts';

export const attemptCompletion: Tool = {
  name: 'attempt_completion',
  description:
    'Signal task completion or uncertainty. Use status "done" when the task is complete, or "uncertain" when you cannot proceed.',
  minIsolationLevel: 0,
  category: 'control',
  sideEffect: false,
  descriptor(): ToolDescriptor {
    return {
      name: 'attempt_completion',
      description: this.description,
      inputSchema: {
        type: 'object',
        properties: {
          status: {
            type: 'string',
            description: "Use 'done' when the task is complete. Use 'uncertain' when blocked.",
            enum: ['done', 'uncertain'],
          },
          summary: { type: 'string', description: 'Brief summary of what was accomplished.' },
          uncertainties: {
            type: 'array',
            items: { type: 'string' },
            description: 'Reasons for uncertainty (required when status=uncertain).',
          },
          proposedContent: {
            type: 'string',
            description: 'Non-file output (answer, analysis, etc.).',
          },
        },
        required: ['status'],
      },
      category: 'control',
      sideEffect: false,
      minRoutingLevel: 0,
      toolKind: 'control',
    };
  },
  async execute(params) {
    // Control tool — the agent loop intercepts this before execution
    return makeResult((params.callId as string) ?? '', 'attempt_completion', {
      output: JSON.stringify({
        status: params.status,
        summary: params.summary,
        proposedContent: params.proposedContent,
      }),
    });
  },
};

export const requestBudgetExtension: Tool = {
  name: 'request_budget_extension',
  description: 'Request additional tokens from the orchestrator when budget is running low.',
  minIsolationLevel: 0,
  category: 'control',
  sideEffect: false,
  descriptor(): ToolDescriptor {
    return {
      name: 'request_budget_extension',
      description: this.description,
      inputSchema: {
        type: 'object',
        properties: {
          tokens: {
            type: 'number',
            description: 'Additional tokens requested (hint; actual grant may differ).',
          },
          reason: {
            type: 'string',
            description: 'Why more tokens are needed — what has been done and what remains.',
          },
        },
        required: ['tokens', 'reason'],
      },
      category: 'control',
      sideEffect: false,
      minRoutingLevel: 1,
      toolKind: 'control',
    };
  },
  async execute(params) {
    // Control tool — handled by agent loop budget tracker
    return makeResult((params.callId as string) ?? '', 'request_budget_extension', {
      output: JSON.stringify({ requested: params.tokens, reason: params.reason }),
    });
  },
};

export const delegateTask: Tool = {
  name: 'delegate_task',
  description:
    'Delegate a sub-task to a typed subagent. Use `subagentType` to pick the right role: ' +
    "'explore' for read-only codebase investigation, 'plan' for read-only implementation planning, " +
    "or 'general-purpose' for a bounded write-capable child task. Omitting subagentType defaults to " +
    "'general-purpose'. Explore and plan subagents are READ-ONLY and cannot mutate files or run " +
    'destructive commands — use them to survey or design before you delegate the actual change.',
  minIsolationLevel: 1,
  category: 'delegation',
  sideEffect: true,
  descriptor(): ToolDescriptor {
    return {
      name: 'delegate_task',
      description: this.description,
      inputSchema: {
        type: 'object',
        properties: {
          goal: { type: 'string', description: 'Natural language description of the sub-task' },
          subagentType: {
            type: 'string',
            description:
              "Subagent role. 'explore' = read-only codebase survey, 'plan' = read-only " +
              "implementation plan, 'general-purpose' = full write-capable bounded child. " +
              "Defaults to 'general-purpose' if omitted.",
            enum: ['explore', 'plan', 'general-purpose'],
          },
          targetFiles: { type: 'array', description: 'Files the sub-task is scoped to', items: { type: 'string' } },
          requiredTools: {
            type: 'array',
            description: 'Tools the sub-task needs (optional)',
            items: { type: 'string' },
          },
          context: { type: 'string', description: 'Additional context for the sub-task (optional)' },
          requestedTokens: { type: 'number', description: 'Token budget for the sub-task (optional)' },
        },
        required: ['goal', 'targetFiles'],
      },
      category: 'delegation',
      sideEffect: true,
      minRoutingLevel: 2,
      toolKind: 'control',
    };
  },
  async execute(params, context) {
    // Delegation tool — handled by agent loop via context.onDelegate
    if (!context.onDelegate) {
      return makeResult((params.callId as string) ?? '', 'delegate_task', {
        status: 'denied',
        error: 'Delegation not available at this routing level',
      });
    }
    return context.onDelegate(params as any);
  },
};

/**
 * Phase 7c-2: `plan_update` — Vinyan's equivalent of Claude Code's TodoWrite.
 * Installs a fresh snapshot of the session's todo plan on the orchestrator
 * side. The next turn's tool-result stream carries the plan back to the
 * worker as a `[PLAN]` block injected into the session-state reminder, so
 * the LLM stays anchored to its own plan without having to restate it.
 *
 * Semantics:
 *   - REPLACES the whole plan each call (no partial updates, no tombstones).
 *     Simpler than delta updates — the LLM rewrites the whole list every time
 *     it changes anything, mirroring TodoWrite's contract.
 *   - Exactly ONE item may be `in_progress` at a time (orchestrator enforces).
 *   - `content` / `activeForm` must be non-empty trimmed strings.
 *   - 50 items maximum — if the plan grows beyond that the agent is probably
 *     going too granular and should consolidate.
 */
export const planUpdate: Tool = {
  name: 'plan_update',
  description:
    'Install or replace the current session plan as an ordered list of todos. ' +
    'Exactly one item may have status "in_progress" at a time; the others must ' +
    'be "pending" or "completed". Use this tool to (a) break a complex task into ' +
    'concrete steps before starting, (b) mark steps completed as you finish them, ' +
    'and (c) add new steps you discover. The plan you install is echoed back in ' +
    "the next turn's [PLAN] block so you stay anchored — you do NOT need to " +
    'repeat the list in your own reasoning. Use sparingly: simple tasks need no plan.',
  minIsolationLevel: 0,
  category: 'control',
  sideEffect: false,
  descriptor(): ToolDescriptor {
    return {
      name: 'plan_update',
      description: this.description,
      inputSchema: {
        type: 'object',
        properties: {
          todos: {
            type: 'array',
            description:
              'Ordered list of todo items. Each item: { content, activeForm, status }. ' +
              'content = imperative ("Run tests"), activeForm = present-continuous ("Running tests"), ' +
              'status ∈ pending | in_progress | completed. At most ONE may be in_progress.',
            items: { type: 'object' },
          },
        },
        required: ['todos'],
      },
      category: 'control',
      sideEffect: false,
      minRoutingLevel: 1,
      toolKind: 'control',
    };
  },
  async execute(params, context) {
    // Control tool — handled by agent loop via context.onPlanUpdate.
    // If the callback isn't wired (e.g. structured worker mode, unit tests),
    // surface a denied status rather than silently accepting and discarding.
    if (!context.onPlanUpdate) {
      return makeResult((params.callId as string) ?? '', 'plan_update', {
        status: 'denied',
        error: 'plan_update is not available in this worker mode',
      });
    }
    const rawTodos = (params as { todos?: unknown }).todos;
    if (!Array.isArray(rawTodos)) {
      return makeResult((params.callId as string) ?? '', 'plan_update', {
        status: 'error',
        error: 'plan_update: `todos` must be an array',
      });
    }
    const result = context.onPlanUpdate(rawTodos as PlanTodoInput[]);
    if (!result.ok) {
      return makeResult((params.callId as string) ?? '', 'plan_update', {
        status: 'error',
        error: `plan_update rejected: ${result.error}`,
      });
    }
    return makeResult((params.callId as string) ?? '', 'plan_update', {
      output: `plan_update: installed ${result.count} todo(s)`,
    });
  },
};
