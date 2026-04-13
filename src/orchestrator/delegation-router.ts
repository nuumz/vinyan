/**
 * DelegationRouter — decides whether a delegation request should be approved
 * and allocates budget for child tasks.
 *
 * Rules enforced:
 *   R1: Depth limit (delegationDepth < maxDelegationDepth)
 *   R2: Scope containment (child files ⊆ parent targetFiles)
 *   R4: Minimum viable budget
 *   R5: (extensible) Safety invariants placeholder
 *   R6: shell_exec always blocked in delegated tasks
 *
 * Axioms: A3 (deterministic governance), A6 (zero-trust execution)
 */
import type { AgentBudget, DelegationRequest } from './protocol.ts';
import type { RoutingDecision, TaskInput } from './types.ts';
import type { AgentBudgetTracker } from './worker/agent-budget.ts';

export interface DelegationDecision {
  allowed: boolean;
  reason: string;
  allocatedTokens: number; // 0 if denied
}

const MIN_VIABLE_DELEGATION_BUDGET = 1000;
const DEFAULT_DELEGATION_BUDGET = 8000;

/**
 * Phase 7c-1: tools that are strictly forbidden for read-only subagent types
 * (explore / plan). Any mutation or command-execution tool in this set causes
 * `canDelegate` to deny the request with a clear reason — guaranteeing that
 * read-only roles can never mutate the workspace even if the LLM asks nicely.
 */
const MUTATION_TOOLS: ReadonlySet<string> = new Set([
  'file_write',
  'file_edit',
  'file_patch',
  'file_delete',
  'shell_exec',
  'delegate_task', // no re-delegation from leaves
]);

export class DelegationRouter {
  canDelegate(request: DelegationRequest, budget: AgentBudgetTracker, parent: TaskInput): DelegationDecision {
    // R1: Depth check
    if (!budget.canDelegate()) {
      return { allowed: false, reason: 'Delegation depth limit reached or no delegation budget', allocatedTokens: 0 };
    }

    // R2: Scope containment — child target files must be subset of parent allowed paths.
    // Read-only subagents (explore/plan) are exempt: exploration naturally walks outside
    // the immediate scope (following imports, searching globally), and since they cannot
    // mutate anything, widening their view is safe. The parent is still in charge.
    const subagentType = request.subagentType ?? 'general-purpose';
    const isReadOnlyRole = subagentType === 'explore' || subagentType === 'plan';
    const parentPaths = parent.targetFiles ?? [];
    if (!isReadOnlyRole && parentPaths.length > 0) {
      const outOfScope = request.targetFiles.filter((f) => !parentPaths.some((p) => f.startsWith(p)));
      if (outOfScope.length > 0) {
        return {
          allowed: false,
          reason: `Target files out of parent scope: ${outOfScope.join(', ')}`,
          allocatedTokens: 0,
        };
      }
    }

    // R6: shell_exec ALWAYS blocked in delegation — capability creep prevention
    if (request.requiredTools?.includes('shell_exec')) {
      return { allowed: false, reason: 'shell_exec is not allowed in delegated tasks (R6)', allocatedTokens: 0 };
    }

    // R7 (Phase 7c-1): read-only subagent roles cannot request mutation tools.
    // Fail fast with a specific reason so the parent LLM learns to pick
    // general-purpose when it actually needs to change files.
    if (isReadOnlyRole && request.requiredTools?.some((t) => MUTATION_TOOLS.has(t))) {
      const forbidden = request.requiredTools.filter((t) => MUTATION_TOOLS.has(t));
      return {
        allowed: false,
        reason: `Subagent role '${subagentType}' is read-only; forbidden tools requested: ${forbidden.join(', ')}`,
        allocatedTokens: 0,
      };
    }

    // R4: Budget check — enough delegation tokens remaining?
    const remaining = budget.delegationRemaining;
    if (remaining < MIN_VIABLE_DELEGATION_BUDGET) {
      return {
        allowed: false,
        reason: `Insufficient delegation budget: ${remaining} < ${MIN_VIABLE_DELEGATION_BUDGET}`,
        allocatedTokens: 0,
      };
    }

    // R5: Safety invariants (extensible — see evolution/safety-invariants.ts)

    // Approved — calculate allocation (50% cap of remaining)
    const requested = request.requestedTokens ?? DEFAULT_DELEGATION_BUDGET;
    const allocatedTokens = Math.min(requested, remaining * 0.5);

    return { allowed: true, reason: 'Delegation approved', allocatedTokens: Math.round(allocatedTokens) };
  }
}

export function buildSubTaskInput(
  request: DelegationRequest,
  parent: TaskInput,
  _parentRouting: RoutingDecision,
  childBudget: AgentBudget,
): TaskInput {
  const subagentType = request.subagentType ?? 'general-purpose';
  // Read-only roles (explore/plan) always run as 'reasoning' tasks so the
  // prompt assembler routes them through the reasoning registry and skips
  // mutation-oriented perception fields.
  const isReadOnlyRole = subagentType === 'explore' || subagentType === 'plan';
  const taskType = isReadOnlyRole ? 'reasoning' : request.targetFiles?.length ? 'code' : 'reasoning';

  // Agent Conversation: propagate parent-provided context (e.g., resolved
  // clarifications from a prior delegation round) into the child's
  // constraints so the understanding pipeline sees them as first-class
  // grounding rather than free-form prose lost between turns.
  //
  // Shape: CONTEXT:<string>
  //  - When the parent answers a child clarification and re-delegates, it
  //    sets `request.context` to a summary like
  //      "Resolved clarifications: 'Which file?' => src/auth.ts; 'Keep alias?' => no"
  //  - The child's TaskUnderstanding pipeline sees this as a constraint and
  //    grounds its plan on it via agent-worker-entry's buildInitUserMessage.
  const contextConstraint: string | undefined = request.context
    ? `CONTEXT:${request.context}`
    : undefined;

  return {
    id: `${parent.id}-child-${Date.now()}`,
    source: parent.source,
    goal: request.goal,
    taskType,
    targetFiles: request.targetFiles,
    subagentType,
    budget: {
      maxTokens: childBudget.maxTokens,
      maxDurationMs: childBudget.maxDurationMs,
      maxRetries: 1, // children get 1 retry
    },
    ...(contextConstraint ? { constraints: [contextConstraint] } : {}),
  };
}
