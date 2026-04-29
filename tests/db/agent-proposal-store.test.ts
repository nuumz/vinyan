import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { AGENT_PROPOSAL_SCHEMA_SQL } from '../../src/db/agent-proposal-schema.ts';
import { AgentProposalStore } from '../../src/db/agent-proposal-store.ts';
import type { AgentProposal } from '../../src/orchestrator/types.ts';

function makeStore(): AgentProposalStore {
  const db = new Database(':memory:');
  db.exec(AGENT_PROPOSAL_SCHEMA_SQL);
  return new AgentProposalStore(db);
}

function makeProposal(overrides: Partial<AgentProposal> = {}): AgentProposal {
  return {
    id: 'agent-proposal-abc123',
    status: 'pending',
    suggestedAgentId: 'custom-abc123',
    name: 'Custom Agent abc123',
    description: 'Pending custom agent for code.audit.jwt.',
    taskTypeSignature: 'audit::jwt',
    unmetCapabilityIds: ['code.audit.jwt'],
    capabilityClaims: [{ id: 'code.audit.jwt', evidence: 'synthesized', confidence: 0.5 }],
    roles: ['security-reviewer'],
    allowedTools: ['file_read', 'search_grep', 'directory_list'],
    capabilityOverrides: { readAny: true, writeAny: false, network: false, shell: false },
    sourceSyntheticAgentIds: ['synthetic-1'],
    evidenceTraceIds: ['trace-1'],
    observationCount: 10,
    successCount: 10,
    wilsonLowerBound: 0.72,
    trustTier: 'low',
    provenance: 'sleep-cycle:synthetic-agent-success',
    rationale: 'synthetic gap succeeded 10/10',
    createdAt: 1000,
    updatedAt: 1000,
    ...overrides,
  };
}

describe('AgentProposalStore', () => {
  test('creates and lists pending proposals', () => {
    const store = makeStore();

    const result = store.upsertPending(makeProposal());

    expect(result.created).toBe(true);
    expect(result.updated).toBe(false);
    expect(store.countByStatus('pending')).toBe(1);
    expect(store.listByStatus('pending')).toEqual([makeProposal()]);
  });

  test('updates existing pending evidence without changing createdAt', () => {
    const store = makeStore();
    store.upsertPending(makeProposal());

    const result = store.upsertPending(makeProposal({ evidenceTraceIds: ['trace-1', 'trace-2'], updatedAt: 2000 }));

    expect(result.created).toBe(false);
    expect(result.updated).toBe(true);
    const saved = store.findById('agent-proposal-abc123')!;
    expect(saved.createdAt).toBe(1000);
    expect(saved.updatedAt).toBe(2000);
    expect(saved.evidenceTraceIds).toEqual(['trace-1', 'trace-2']);
  });

  test('does not overwrite decided proposals', () => {
    const store = makeStore();
    store.upsertPending(makeProposal());
    expect(store.markDecided('agent-proposal-abc123', 'rejected', 'not useful', 3000)).toBe(true);

    const result = store.upsertPending(makeProposal({ evidenceTraceIds: ['trace-2'], updatedAt: 4000 }));

    expect(result.created).toBe(false);
    expect(result.updated).toBe(false);
    const saved = store.findById('agent-proposal-abc123')!;
    expect(saved.status).toBe('rejected');
    expect(saved.evidenceTraceIds).toEqual(['trace-1']);
    expect(saved.decidedAt).toBe(3000);
    expect(saved.decisionReason).toBe('not useful');
  });
});
