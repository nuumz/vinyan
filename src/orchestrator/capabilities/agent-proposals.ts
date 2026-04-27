/**
 * Persistent custom agent proposal mining.
 *
 * Phase 5 keeps online synthetic agents task-scoped. Repeated success only
 * creates a quarantined AgentProposal during sleep-cycle; activation stays a
 * later deterministic governance step.
 */
import { createHash } from 'node:crypto';
import { wilsonLowerBound } from '../../sleep-cycle/wilson.ts';
import type {
  AgentCapabilityOverrides,
  AgentProposal,
  CapabilityClaim,
  CapabilityRequirement,
  ExecutionTrace,
} from '../types.ts';

export interface AgentProposalMiningOptions {
  minObservations?: number;
  minSuccesses?: number;
  wilsonThreshold?: number;
  wilsonZ?: number;
  maxEvidenceTraceIds?: number;
  now?: number;
}

export interface AgentProposalMiningResult {
  groupsConsidered: number;
  proposals: AgentProposal[];
}

const DEFAULT_ALLOWED_TOOLS: readonly string[] = ['file_read', 'search_grep', 'directory_list'];
const DEFAULT_MIN_OBSERVATIONS = 10;
const DEFAULT_MIN_SUCCESSES = 8;
const DEFAULT_WILSON_THRESHOLD = 0.65;
const DEFAULT_MAX_EVIDENCE_TRACE_IDS = 50;

const STRICT_CAPABILITY_OVERRIDES: AgentCapabilityOverrides = {
  readAny: true,
  writeAny: false,
  network: false,
  shell: false,
};

interface ProposalGroup {
  taskTypeSignature: string;
  unmetCapabilityIds: string[];
  traces: ExecutionTrace[];
  requirementsById: Map<string, CapabilityRequirement>;
  sourceSyntheticAgentIds: Set<string>;
}

export function minePersistentAgentProposals(
  traces: readonly ExecutionTrace[],
  options: AgentProposalMiningOptions = {},
): AgentProposalMiningResult {
  const minObservations = options.minObservations ?? DEFAULT_MIN_OBSERVATIONS;
  const minSuccesses = options.minSuccesses ?? DEFAULT_MIN_SUCCESSES;
  const wilsonThreshold = options.wilsonThreshold ?? DEFAULT_WILSON_THRESHOLD;
  const wilsonZ = options.wilsonZ ?? 1.96;
  const maxEvidenceTraceIds = options.maxEvidenceTraceIds ?? DEFAULT_MAX_EVIDENCE_TRACE_IDS;
  const now = options.now ?? Date.now();

  const groups = groupSyntheticGapTraces(traces);
  const proposals: AgentProposal[] = [];

  for (const group of groups.values()) {
    const observationCount = group.traces.length;
    if (observationCount < minObservations) continue;

    const successfulTraces = group.traces.filter((trace) => trace.outcome === 'success');
    const successCount = successfulTraces.length;
    if (successCount < minSuccesses) continue;

    const lowerBound = wilsonLowerBound(successCount, observationCount, wilsonZ);
    if (lowerBound < wilsonThreshold) continue;

    proposals.push(
      buildProposal({
        group,
        successfulTraces,
        observationCount,
        successCount,
        wilsonLowerBound: lowerBound,
        maxEvidenceTraceIds,
        now,
      }),
    );
  }

  return { groupsConsidered: groups.size, proposals };
}

function groupSyntheticGapTraces(traces: readonly ExecutionTrace[]): Map<string, ProposalGroup> {
  const groups = new Map<string, ProposalGroup>();

  for (const trace of traces) {
    if (!trace.taskTypeSignature || !trace.syntheticAgentId?.startsWith('synthetic-')) continue;
    const unmetCapabilityIds = normalizeIds(trace.unmetCapabilityIds ?? []);
    if (unmetCapabilityIds.length === 0) continue;

    const key = makeGroupKey(trace.taskTypeSignature, unmetCapabilityIds);
    const group = groups.get(key) ?? {
      taskTypeSignature: trace.taskTypeSignature,
      unmetCapabilityIds,
      traces: [],
      requirementsById: new Map<string, CapabilityRequirement>(),
      sourceSyntheticAgentIds: new Set<string>(),
    };

    group.traces.push(trace);
    group.sourceSyntheticAgentIds.add(trace.syntheticAgentId);
    for (const requirement of trace.capabilityRequirements ?? []) {
      if (unmetCapabilityIds.includes(requirement.id) && !group.requirementsById.has(requirement.id)) {
        group.requirementsById.set(requirement.id, requirement);
      }
    }
    groups.set(key, group);
  }

  return groups;
}

function buildProposal(input: {
  group: ProposalGroup;
  successfulTraces: ExecutionTrace[];
  observationCount: number;
  successCount: number;
  wilsonLowerBound: number;
  maxEvidenceTraceIds: number;
  now: number;
}): AgentProposal {
  const { group, successfulTraces, observationCount, successCount, wilsonLowerBound, maxEvidenceTraceIds, now } = input;
  const proposalHash = shortHash(`${group.taskTypeSignature}::${group.unmetCapabilityIds.join('|')}`);
  const capabilityClaims = group.unmetCapabilityIds.map((id) =>
    capabilityClaimFromRequirement(id, group.requirementsById.get(id)),
  );
  const roles = [
    ...new Set(capabilityClaims.map((claim) => claim.role).filter((role): role is string => Boolean(role))),
  ];
  const evidenceTraceIds = successfulTraces.map((trace) => trace.id).slice(0, maxEvidenceTraceIds);

  return {
    id: `agent-proposal-${proposalHash}`,
    status: 'pending',
    suggestedAgentId: `custom-${proposalHash.slice(0, 8)}`,
    name: `Custom Agent ${proposalHash.slice(0, 8)}`,
    description: `Pending custom agent for ${group.unmetCapabilityIds.join(', ')} on ${group.taskTypeSignature}.`,
    taskTypeSignature: group.taskTypeSignature,
    unmetCapabilityIds: [...group.unmetCapabilityIds],
    capabilityClaims,
    roles,
    allowedTools: [...DEFAULT_ALLOWED_TOOLS],
    capabilityOverrides: { ...STRICT_CAPABILITY_OVERRIDES },
    sourceSyntheticAgentIds: [...group.sourceSyntheticAgentIds].sort(),
    evidenceTraceIds,
    observationCount,
    successCount,
    wilsonLowerBound,
    trustTier: 'low',
    provenance: 'sleep-cycle:synthetic-agent-success',
    rationale: `synthetic gap succeeded ${successCount}/${observationCount}; Wilson LB=${wilsonLowerBound.toFixed(3)}; capabilities=${group.unmetCapabilityIds.join(', ')}`,
    createdAt: now,
    updatedAt: now,
  };
}

function capabilityClaimFromRequirement(id: string, requirement?: CapabilityRequirement): CapabilityClaim {
  return {
    id,
    fileExtensions: requirement?.fileExtensions ? [...requirement.fileExtensions] : undefined,
    actionVerbs: requirement?.actionVerbs ? [...requirement.actionVerbs] : undefined,
    domains: requirement?.domains ? [...requirement.domains] : undefined,
    frameworkMarkers: requirement?.frameworkMarkers ? [...requirement.frameworkMarkers] : undefined,
    role: requirement?.role,
    evidence: 'synthesized',
    confidence: 0.5,
  };
}

function makeGroupKey(taskTypeSignature: string, unmetCapabilityIds: readonly string[]): string {
  return `${taskTypeSignature}\u241f${unmetCapabilityIds.join('|')}`;
}

function normalizeIds(ids: readonly string[]): string[] {
  return [...new Set(ids.filter(Boolean))].sort();
}

function shortHash(input: string): string {
  return createHash('sha256').update(input).digest('hex').slice(0, 12);
}
