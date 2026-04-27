import { describe, expect, test } from 'bun:test';
import { minePersistentAgentProposals } from '../../../src/orchestrator/capabilities/agent-proposals.ts';
import type { CapabilityRequirement, ExecutionTrace } from '../../../src/orchestrator/types.ts';

function makeRequirement(id = 'code.audit.jwt'): CapabilityRequirement {
  return {
    id,
    weight: 0.9,
    source: 'llm-extract',
    fileExtensions: ['.ts'],
    actionVerbs: ['audit'],
    domains: ['security'],
    role: 'security-reviewer',
  };
}

function makeTrace(index: number, overrides: Partial<ExecutionTrace> = {}): ExecutionTrace {
  const syntheticAgentId = `synthetic-${index % 2}`;
  return {
    id: `trace-${index}`,
    taskId: `task-${index}`,
    sessionId: `session-${index}`,
    agentId: syntheticAgentId,
    timestamp: 1000 + index,
    routingLevel: 2,
    taskTypeSignature: 'audit::jwt',
    approach: 'synthetic-agent',
    oracleVerdicts: { ast: true, type: true },
    modelUsed: 'mock',
    tokensConsumed: 120,
    durationMs: 700,
    outcome: 'success',
    affectedFiles: ['src/auth/jwt.ts'],
    capabilityRequirements: [makeRequirement()],
    unmetCapabilityIds: ['code.audit.jwt'],
    syntheticAgentId,
    ...overrides,
  };
}

describe('minePersistentAgentProposals', () => {
  test('creates a low-trust pending proposal from repeated synthetic-agent success', () => {
    const traces = Array.from({ length: 10 }, (_, index) => makeTrace(index));

    const result = minePersistentAgentProposals(traces, { now: 1234 });

    expect(result.groupsConsidered).toBe(1);
    expect(result.proposals).toHaveLength(1);
    const proposal = result.proposals[0]!;
    expect(proposal.status).toBe('pending');
    expect(proposal.trustTier).toBe('low');
    expect(proposal.taskTypeSignature).toBe('audit::jwt');
    expect(proposal.unmetCapabilityIds).toEqual(['code.audit.jwt']);
    expect(proposal.capabilityClaims).toEqual([
      {
        id: 'code.audit.jwt',
        fileExtensions: ['.ts'],
        actionVerbs: ['audit'],
        domains: ['security'],
        frameworkMarkers: undefined,
        role: 'security-reviewer',
        evidence: 'synthesized',
        confidence: 0.5,
      },
    ]);
    expect(proposal.allowedTools).toEqual(['file_read', 'search_grep', 'directory_list']);
    expect(proposal.capabilityOverrides).toEqual({ readAny: true, writeAny: false, network: false, shell: false });
    expect(proposal.sourceSyntheticAgentIds).toEqual(['synthetic-0', 'synthetic-1']);
    expect(proposal.evidenceTraceIds).toHaveLength(10);
    expect(proposal.createdAt).toBe(1234);
    expect(proposal.updatedAt).toBe(1234);
  });

  test('abstains when repeated synthetic attempts are not statistically strong', () => {
    const traces = Array.from({ length: 10 }, (_, index) =>
      makeTrace(index, { outcome: index < 6 ? 'success' : 'failure' }),
    );

    const result = minePersistentAgentProposals(traces);

    expect(result.groupsConsidered).toBe(1);
    expect(result.proposals).toEqual([]);
  });

  test('ignores non-synthetic and already-met traces', () => {
    const traces = [
      makeTrace(1, { syntheticAgentId: undefined, agentId: 'ts-coder' }),
      makeTrace(2, { unmetCapabilityIds: [] }),
    ];

    const result = minePersistentAgentProposals(traces);

    expect(result.groupsConsidered).toBe(0);
    expect(result.proposals).toEqual([]);
  });
});
