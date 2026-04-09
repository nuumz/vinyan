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
import type { DelegationRequest } from './protocol.ts';
import type { AgentBudgetTracker } from './worker/agent-budget.ts';
import type { AgentBudget } from './protocol.ts';
import type { TaskInput, RoutingDecision } from './types.ts';

export interface DelegationDecision {
  allowed: boolean;
  reason: string;
  allocatedTokens: number; // 0 if denied
}

const MIN_VIABLE_DELEGATION_BUDGET = 1000;
const DEFAULT_DELEGATION_BUDGET = 8000;

export class DelegationRouter {
  canDelegate(
    request: DelegationRequest,
    budget: AgentBudgetTracker,
    parent: TaskInput,
  ): DelegationDecision {
    // R1: Depth check
    if (!budget.canDelegate()) {
      return { allowed: false, reason: 'Delegation depth limit reached or no delegation budget', allocatedTokens: 0 };
    }

    // R2: Scope containment — child target files must be subset of parent allowed paths
    const parentPaths = parent.targetFiles ?? [];
    if (parentPaths.length > 0) {
      const outOfScope = request.targetFiles.filter(f => !parentPaths.some(p => f.startsWith(p)));
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
  return {
    id: `${parent.id}-child-${Date.now()}`,
    source: parent.source,
    goal: request.goal,
    taskType: request.targetFiles?.length ? 'code' : 'reasoning',
    targetFiles: request.targetFiles,
    budget: {
      maxTokens: childBudget.maxTokens,
      maxDurationMs: childBudget.maxDurationMs,
      maxRetries: 1, // children get 1 retry
    },
  };
}
