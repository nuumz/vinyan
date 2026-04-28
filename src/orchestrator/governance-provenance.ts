import type {
  ExecutionTrace,
  GovernanceEvidenceReference,
  GovernanceProvenance,
  RoutingDecision,
  TaskInput,
} from './types.ts';

export const ORCHESTRATOR_GOVERNANCE_POLICY_VERSION = 'orchestrator-governance:v1' as const;

export function deriveGovernanceTraceAudit(routing: RoutingDecision): Pick<ExecutionTrace, 'governanceProvenance'> {
  return routing.governanceProvenance ? { governanceProvenance: routing.governanceProvenance } : {};
}

export function applyRoutingGovernance<T extends ExecutionTrace>(trace: T, routing: RoutingDecision): T {
  if (!routing.governanceProvenance) return trace;
  return { ...trace, governanceProvenance: routing.governanceProvenance };
}

interface ShortCircuitProvenanceInput {
  input: TaskInput;
  decisionId: string;
  attributedTo: string;
  wasGeneratedBy: string;
  reason: string;
  evidence?: GovernanceEvidenceReference[];
}

export function buildShortCircuitProvenance(args: ShortCircuitProvenanceInput): GovernanceProvenance {
  const now = Date.now();
  return {
    decisionId: `${args.attributedTo}:${args.input.id}:${args.decisionId}`,
    policyVersion: ORCHESTRATOR_GOVERNANCE_POLICY_VERSION,
    attributedTo: args.attributedTo,
    wasGeneratedBy: args.wasGeneratedBy,
    wasDerivedFrom: [
      {
        kind: 'task-input',
        source: args.input.id,
        observedAt: now,
        summary: `taskType=${args.input.taskType}; source=${args.input.source}`,
      },
      ...(args.evidence ?? []),
    ],
    decidedAt: now,
    evidenceObservedAt: now,
    reason: args.reason,
  };
}
