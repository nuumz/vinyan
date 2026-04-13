/**
 * Control tools (Phase 6) — attempt_completion, request_budget_extension,
 * delegate_task, consult_peer.
 *
 * Note: previously imported `makeResult` from `./built-in-tools.ts`, which
 * created a circular dependency (built-in-tools imports this file for
 * BUILT_IN_TOOLS registration). The circular was latent in production
 * because nothing imports control-tools directly, but new tests that do
 * hit the ESM temporal-dead-zone path. Inlining the helper here breaks
 * the cycle without changing any semantics — it's a 5-line utility.
 */

import type { Tool, ToolDescriptor } from './tool-interface.ts';
import type { ToolResult } from '../types.ts';

function makeResult(callId: string, tool: string, partial: Partial<ToolResult>): ToolResult {
  return {
    callId,
    tool,
    status: 'success',
    durationMs: 0,
    ...partial,
  };
}

export const attemptCompletion: Tool = {
  name: 'attempt_completion',
  description:
    'Signal task completion or uncertainty. Use status "done" when the task is complete, or "uncertain" when you cannot proceed. Set needsUserInput=true when the uncertainty is about what the USER wants (phrase each uncertainty as a question to the user); leave needsUserInput=false/absent when the uncertainty is about a missing code fact that a retry or higher routing level could resolve.',
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
            description:
              "Reasons for uncertainty (required when status=uncertain). When needsUserInput=true, each entry MUST be phrased as a question directed at the user (e.g., 'Which file should I modify — auth.ts or auth-v2.ts?').",
          },
          needsUserInput: {
            type: 'boolean',
            description:
              "Set to true ONLY when status='uncertain' AND the uncertainty is about user intent (what they want), not about code facts. When true, the orchestrator will NOT retry or escalate — it will surface your `uncertainties` as clarification questions to the user and wait for the next user turn. Use this for ambiguous goals, missing preferences, or choices the user must make. Default false.",
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
        needsUserInput: params.needsUserInput,
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

export const consultPeer: Tool = {
  name: 'consult_peer',
  description:
    'Request a structured second opinion from a DIFFERENT reasoning engine on a specific question. Use when you need a sanity check on a design decision, semantic correctness, or a subtle trade-off — without paying the full cost of delegating a sub-task. The peer runs as a single LLM call (not an agentic loop), returns structured advice capped at heuristic-tier confidence (0.7), and is ADVISORY only — do NOT blindly follow the opinion when your own evidence is stronger. Limited to 3 consultations per session.',
  minIsolationLevel: 0,
  category: 'control',
  sideEffect: false,
  descriptor(): ToolDescriptor {
    return {
      name: 'consult_peer',
      description: this.description,
      inputSchema: {
        type: 'object',
        properties: {
          question: {
            type: 'string',
            description:
              'The specific question you want a second opinion on. Be precise — the peer does not have access to your full conversation history, tools, or perception.',
          },
          context: {
            type: 'string',
            description:
              'Minimal context the peer needs to answer (e.g., the relevant code snippet, your current hypothesis, the trade-off you are weighing). Keep it short — this is a focused consultation, not a full handoff.',
          },
          requestedTokens: {
            type: 'number',
            description:
              'Hint for how many tokens the peer response can use (optional). Capped by the server regardless of the requested value.',
          },
        },
        required: ['question'],
      },
      category: 'control',
      sideEffect: false,
      // Available at L1+: L0 does not use the agent loop; L1 is the
      // lowest level where a worker has tools and can benefit from a
      // lightweight second opinion.
      minRoutingLevel: 1,
      toolKind: 'control',
    };
  },
  async execute(params, context) {
    // Control tool — the agent loop intercepts this via context.onConsult
    if (!context.onConsult) {
      return makeResult((params.callId as string) ?? '', 'consult_peer', {
        status: 'denied',
        error: 'Peer consultation not available in this context',
      });
    }
    return context.onConsult(params as unknown as {
      question: string;
      context?: string;
      requestedTokens?: number;
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
