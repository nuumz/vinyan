/**
 * Control tools — attempt_completion, request_budget_extension, delegate_task,
 * consult_peer, plan_update. These are `toolKind: 'control'` tools intercepted
 * by the agent loop rather than executed as normal work.
 *
 * Note: previously imported `makeResult` from `./built-in-tools.ts`, which
 * created a circular dependency (built-in-tools imports this file for
 * BUILT_IN_TOOLS registration). The circular was latent in production
 * because nothing imports control-tools directly, but tests that DO import
 * control-tools (e.g., tests/orchestrator/consult-peer.test.ts) hit the
 * ESM temporal-dead-zone path and crash. Inlining the 5-line helper here
 * breaks the cycle without changing any semantics.
 */

import type { PlanTodoInput, ToolResult } from '../types.ts';
import type { Tool, ToolDescriptor } from './tool-interface.ts';

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
    'Signal task completion or uncertainty. Use status "done" when the task is complete, or "uncertain" when you cannot proceed. Set needsUserInput=true when the uncertainty is about what the USER wants (phrase each uncertainty as a question to the user); leave needsUserInput=false/absent when the uncertainty is about a missing code fact that a retry or higher routing level could resolve. When marking status="done" you MUST include a selfAssessment with grade A or B per the [ACCOUNTABILITY CONTRACT]; grade C work is not done and must be reported via status="uncertain".',
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
          selfAssessment: {
            type: 'object',
            description:
              'Required for status="done": your honest grading of the result against the [ACCOUNTABILITY CONTRACT]. Grade C work MUST be reported via status="uncertain", not "done" — the orchestrator will reject a "done" with grade C.',
            properties: {
              grade: {
                type: 'string',
                enum: ['A', 'B', 'C'],
                description:
                  "A = all criteria addressed with verification evidence. B = core goal achieved with documented minor caveats. C = critical flaw (missing criterion, failed verification, scope drift, hidden uncertainty) — DO NOT use grade C with status='done'.",
              },
              acceptanceCriteriaSatisfied: {
                type: 'array',
                items: { type: 'string' },
                description:
                  'List the acceptance criteria you believe are satisfied with one short evidence pointer each.',
              },
              gaps: {
                type: 'array',
                items: { type: 'string' },
                description:
                  'Honest list of remaining gaps, caveats, or unverified claims. Empty array only when truly Grade A.',
              },
            },
            required: ['grade'],
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
        // Agent Conversation: needsUserInput disambiguates a code-fact
        // uncertainty (agent expects retry/escalate) from a user-intent
        // uncertainty (agent expects the orchestrator to ask the user).
        needsUserInput: params.needsUserInput,
        selfAssessment: params.selfAssessment,
      }),
    });
  },
};

export const requestBudgetExtension: Tool = {
  name: 'request_budget_extension',
  description: `Ask the orchestrator for additional tokens when the existing budget will not cover the remaining work.

Usage:
- Call this BEFORE you hit [BUDGET WARNING], not after. Include what has been done, what remains, and why more tokens are actually required — the orchestrator uses reason to decide.
- The tokens argument is a hint; the actual grant may be lower, zero, or denied. Keep working with whatever you end up with.
- There is a maxExtensionRequests cap per task. Do NOT spam — one well-justified request is far more likely to be granted than three vague ones.
- If the extension is denied, call attempt_completion with what you have rather than thrashing.`,
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
    return context.onConsult(
      params as unknown as {
        question: string;
        context?: string;
        requestedTokens?: number;
      },
    );
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
