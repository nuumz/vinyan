/**
 * Control tools (Phase 6) — attempt_completion, request_budget_extension, delegate_task.
 */

import type { Tool, ToolDescriptor } from './tool-interface.ts';
import { makeResult } from './built-in-tools.ts';

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
    };
  },
  async execute(params) {
    // Control tool — the agent loop intercepts this before execution
    return makeResult((params.callId as string) ?? '', 'attempt_completion', {
      output: JSON.stringify({ status: params.status, summary: params.summary, proposedContent: params.proposedContent }),
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
    'Delegate a sub-task to a child worker. The child runs through the full pipeline with bounded scope.',
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
          targetFiles: { type: 'array', description: 'Files the sub-task is scoped to' },
          requiredTools: { type: 'array', description: 'Tools the sub-task needs (optional)' },
          context: { type: 'string', description: 'Additional context for the sub-task (optional)' },
          requestedTokens: { type: 'number', description: 'Token budget for the sub-task (optional)' },
        },
        required: ['goal', 'targetFiles'],
      },
      category: 'delegation',
      sideEffect: true,
      minRoutingLevel: 2,
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
