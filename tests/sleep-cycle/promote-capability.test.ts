/**
 * Phase D — Capability claim promotion tests.
 *
 * Verifies `promoteCapabilityClaims()` groups traces by
 * (taskTypeSignature, agentId), gates by sample-size + per-capability count
 * + Wilson lower bound, and merges `evidence:'evolved'` claims with
 * statistically-grounded confidence onto stable agents via the registry's
 * `mergeCapabilityClaims` API. Behaviour-only — every test exercises the
 * function and asserts a runtime side-effect.
 */
import { describe, expect, test } from 'bun:test';
import { asPersonaId } from '../../src/core/agent-vocabulary.ts';
import { promoteCapabilityClaims } from '../../src/sleep-cycle/promotion.ts';
import type {
  AgentSpec,
  CapabilityClaim,
  CapabilityRequirement,
  ExecutionTrace,
  RoutingLevel,
} from '../../src/orchestrator/types.ts';
import type { AgentRegistry } from '../../src/orchestrator/agents/registry.ts';

// ── Test helpers ────────────────────────────────────────────────────────

function makeTrace(overrides: Partial<ExecutionTrace>): ExecutionTrace {
  return {
    id: `tr-${Math.random().toString(36).slice(2, 8)}`,
    taskId: `task-${Math.random().toString(36).slice(2, 8)}`,
    timestamp: 1000,
    routingLevel: 1 as RoutingLevel,
    approach: 'specialist-agent',
    oracleVerdicts: { ast: true, type: true },
    modelUsed: 'claude-haiku',
    tokensConsumed: 100,
    durationMs: 500,
    outcome: 'success',
    affectedFiles: [],
    ...overrides,
  };
}

function makeRequirement(
  id: string,
  overrides: Partial<CapabilityRequirement> = {},
): CapabilityRequirement {
  return {
    id,
    weight: 0.8,
    source: 'llm-extract',
    ...overrides,
  };
}

/**
 * Minimal in-memory registry stub satisfying the Pick<AgentRegistry, ...>
 * contract that `promoteCapabilityClaims` requires. Tracks merged claims
 * per agent so tests can assert outcome.
 */
function makeRegistryStub(seed: AgentSpec[]): {
  registry: Pick<AgentRegistry, 'getAgent' | 'mergeCapabilityClaims'>;
  agents: Map<string, AgentSpec>;
  mergeCalls: Array<{ agentId: string; claims: CapabilityClaim[] }>;
} {
  const agents = new Map<string, AgentSpec>();
  for (const a of seed) agents.set(a.id, { ...a });
  const mergeCalls: Array<{ agentId: string; claims: CapabilityClaim[] }> = [];
  return {
    agents,
    mergeCalls,
    registry: {
      getAgent(id: string): AgentSpec | null {
        return agents.get(id) ?? null;
      },
      mergeCapabilityClaims(agentId: string, claims: CapabilityClaim[]): boolean {
        const a = agents.get(agentId);
        if (!a) return false;
        mergeCalls.push({ agentId, claims });
        const merged = new Map<string, CapabilityClaim>();
        for (const e of a.capabilities ?? []) merged.set(e.id, e);
        for (const c of claims) merged.set(c.id, c);
        agents.set(agentId, { ...a, capabilities: [...merged.values()] });
        return true;
      },
    },
  };
}

const STABLE_AGENT: AgentSpec = {
  id: 'ts-coder',
  name: 'TS Coder',
  description: 'Stable specialist',
  capabilities: [{ id: 'code.refactor.ts', evidence: 'builtin', confidence: 0.9 }],
};

// ── Tests ───────────────────────────────────────────────────────────────

describe('promoteCapabilityClaims', () => {
  test('promotes a capability when ≥30 traces and Wilson LB ≥ threshold', () => {
    const stub = makeRegistryStub([STABLE_AGENT]);
    const reqs = [makeRequirement('code.review.ts', { weight: 0.9 })];

    const traces: ExecutionTrace[] = Array.from({ length: 30 }, () =>
      makeTrace({
        agentId: asPersonaId('ts-coder'),
        taskTypeSignature: 'review::ts',
        capabilityRequirements: reqs,
        outcome: 'success',
      }),
    );

    const result = promoteCapabilityClaims(traces, { agentRegistry: stub.registry });

    expect(result.groupsConsidered).toBe(1);
    expect(result.promotedCount).toBe(1);
    const promoted = result.entries.find((e) => e.promoted);
    expect(promoted).toBeDefined();
    expect(promoted!.capabilityId).toBe('code.review.ts');
    expect(promoted!.wilsonLowerBound).toBeGreaterThanOrEqual(0.6);

    // Side-effect: claim merged onto the agent.
    const updated = stub.agents.get('ts-coder')!;
    const newClaim = updated.capabilities?.find((c) => c.id === 'code.review.ts');
    expect(newClaim).toBeDefined();
    expect(newClaim!.evidence).toBe('evolved');
    expect(newClaim!.confidence).toBeCloseTo(promoted!.wilsonLowerBound, 6);
  });

  test('does NOT promote when group has <30 observations', () => {
    const stub = makeRegistryStub([STABLE_AGENT]);
    const reqs = [makeRequirement('code.review.ts')];

    const traces: ExecutionTrace[] = Array.from({ length: 29 }, () =>
      makeTrace({
        agentId: asPersonaId('ts-coder'),
        taskTypeSignature: 'review::ts',
        capabilityRequirements: reqs,
        outcome: 'success',
      }),
    );

    const result = promoteCapabilityClaims(traces, { agentRegistry: stub.registry });
    expect(result.promotedCount).toBe(0);
    // No merge should have fired.
    const updated = stub.agents.get('ts-coder')!;
    expect(updated.capabilities?.find((c) => c.id === 'code.review.ts')).toBeUndefined();
  });

  test('does NOT promote when Wilson LB falls below threshold (mixed outcomes)', () => {
    const stub = makeRegistryStub([STABLE_AGENT]);
    const reqs = [makeRequirement('code.review.ts')];

    // 30 traces, 50% pass — Wilson LB on 15/30 ≈ 0.32, below 0.6.
    const traces: ExecutionTrace[] = Array.from({ length: 30 }, (_, i) =>
      makeTrace({
        agentId: asPersonaId('ts-coder'),
        taskTypeSignature: 'review::ts',
        capabilityRequirements: reqs,
        outcome: i % 2 === 0 ? 'success' : 'failure',
      }),
    );

    const result = promoteCapabilityClaims(traces, { agentRegistry: stub.registry });
    const entry = result.entries.find((e) => e.capabilityId === 'code.review.ts')!;
    expect(entry.promoted).toBe(false);
    expect(entry.wilsonLowerBound).toBeLessThan(0.6);
    expect(stub.agents.get('ts-coder')!.capabilities?.find((c) => c.id === 'code.review.ts')).toBeUndefined();
  });

  test('does NOT promote a capability seen in <minPerCapability traces', () => {
    const stub = makeRegistryStub([STABLE_AGENT]);
    const common = [makeRequirement('code.refactor.ts')];
    const rare = [makeRequirement('code.refactor.ts'), makeRequirement('rare.cap')];

    // 30 traces total: 27 with the common requirement only (passes), 3 also tag 'rare.cap'.
    const traces: ExecutionTrace[] = [
      ...Array.from({ length: 27 }, () =>
        makeTrace({
          agentId: asPersonaId('ts-coder'),
          taskTypeSignature: 'refactor::ts',
          capabilityRequirements: common,
        }),
      ),
      ...Array.from({ length: 3 }, () =>
        makeTrace({
          agentId: asPersonaId('ts-coder'),
          taskTypeSignature: 'refactor::ts',
          capabilityRequirements: rare,
        }),
      ),
    ];

    const result = promoteCapabilityClaims(traces, { agentRegistry: stub.registry });
    const rareEntry = result.entries.find((e) => e.capabilityId === 'rare.cap')!;
    expect(rareEntry.promoted).toBe(false);
    expect(rareEntry.reason).toMatch(/per-capability observations 3 < 5/);
  });

  test('skips synthetic agents (id prefix synthetic-)', () => {
    const stub = makeRegistryStub([
      {
        id: 'synthetic-abc12345',
        name: 'Task Synth',
        description: 'task-scoped',
        capabilities: [],
      },
    ]);
    const reqs = [makeRequirement('research.web')];

    const traces: ExecutionTrace[] = Array.from({ length: 30 }, () =>
      makeTrace({
        agentId: asPersonaId('synthetic-abc12345'),
        taskTypeSignature: 'research::any',
        capabilityRequirements: reqs,
        outcome: 'success',
      }),
    );

    const result = promoteCapabilityClaims(traces, { agentRegistry: stub.registry });
    expect(result.groupsConsidered).toBe(0);
    expect(result.promotedCount).toBe(0);
    expect(stub.mergeCalls.length).toBe(0);
  });

  test('skips traces missing taskTypeSignature or agentId', () => {
    const stub = makeRegistryStub([STABLE_AGENT]);
    const reqs = [makeRequirement('code.review.ts')];

    const traces: ExecutionTrace[] = Array.from({ length: 30 }, () =>
      makeTrace({
        // Missing agentId — must be ignored even though taskTypeSignature exists.
        taskTypeSignature: 'review::ts',
        capabilityRequirements: reqs,
      }),
    );

    const result = promoteCapabilityClaims(traces, { agentRegistry: stub.registry });
    expect(result.groupsConsidered).toBe(0);
  });

  test('separates groups by (taskTypeSignature, agentId) — promotes per pair', () => {
    const tsCoder: AgentSpec = { ...STABLE_AGENT };
    const writer: AgentSpec = {
      id: 'writer',
      name: 'Writer',
      description: 'Stable',
      capabilities: [],
    };
    const stub = makeRegistryStub([tsCoder, writer]);

    const tsReqs = [makeRequirement('code.review.ts')];
    const writerReqs = [makeRequirement('writing.prose')];

    const traces: ExecutionTrace[] = [
      ...Array.from({ length: 30 }, () =>
        makeTrace({
          agentId: asPersonaId('ts-coder'),
          taskTypeSignature: 'review::ts',
          capabilityRequirements: tsReqs,
        }),
      ),
      ...Array.from({ length: 30 }, () =>
        makeTrace({
          agentId: asPersonaId('writer'),
          taskTypeSignature: 'write::md',
          capabilityRequirements: writerReqs,
        }),
      ),
    ];

    const result = promoteCapabilityClaims(traces, { agentRegistry: stub.registry });
    expect(result.groupsConsidered).toBe(2);
    expect(result.promotedCount).toBe(2);
    expect(stub.agents.get('ts-coder')!.capabilities?.some((c) => c.id === 'code.review.ts')).toBe(true);
    expect(stub.agents.get('writer')!.capabilities?.some((c) => c.id === 'writing.prose')).toBe(true);
  });

  test('emits evolution:capabilityPromoted event for each promoted claim', () => {
    const stub = makeRegistryStub([STABLE_AGENT]);
    const reqs = [makeRequirement('code.review.ts')];
    const traces: ExecutionTrace[] = Array.from({ length: 30 }, () =>
      makeTrace({
        agentId: asPersonaId('ts-coder'),
        taskTypeSignature: 'review::ts',
        capabilityRequirements: reqs,
      }),
    );

    const events: Array<{ event: string; payload: unknown }> = [];
    const busStub = {
      emit: (event: string, payload: unknown) => {
        events.push({ event, payload });
      },
    } as unknown as { emit: (event: string, payload: unknown) => void };

    promoteCapabilityClaims(traces, {
      agentRegistry: stub.registry,
      // biome-ignore lint/suspicious/noExplicitAny: bus stub is intentionally permissive
      bus: busStub as any,
    });

    const emitted = events.filter((e) => e.event === 'evolution:capabilityPromoted');
    expect(emitted.length).toBe(1);
    const payload = emitted[0]!.payload as {
      agentId: string;
      capabilityId: string;
      confidence: number;
      observationCount: number;
      taskTypeSignature: string;
    };
    expect(payload.agentId).toBe('ts-coder');
    expect(payload.capabilityId).toBe('code.review.ts');
    expect(payload.observationCount).toBe(30);
    expect(payload.taskTypeSignature).toBe('review::ts');
    expect(payload.confidence).toBeGreaterThanOrEqual(0.6);
  });

  test('idempotent — re-running with the same traces does not duplicate claims', () => {
    const stub = makeRegistryStub([STABLE_AGENT]);
    const reqs = [makeRequirement('code.review.ts')];
    const traces: ExecutionTrace[] = Array.from({ length: 30 }, () =>
      makeTrace({
        agentId: asPersonaId('ts-coder'),
        taskTypeSignature: 'review::ts',
        capabilityRequirements: reqs,
      }),
    );

    promoteCapabilityClaims(traces, { agentRegistry: stub.registry });
    promoteCapabilityClaims(traces, { agentRegistry: stub.registry });

    const claims = stub.agents.get('ts-coder')!.capabilities ?? [];
    const matches = claims.filter((c) => c.id === 'code.review.ts');
    expect(matches.length).toBe(1);
  });

  test('carries forward structured signals (verbs/extensions) onto the evolved claim', () => {
    const stub = makeRegistryStub([STABLE_AGENT]);
    const reqs = [
      makeRequirement('code.review.ts', {
        actionVerbs: ['review', 'analyze'],
        fileExtensions: ['.ts', '.tsx'],
        domains: ['code-mutation'],
      }),
    ];
    const traces: ExecutionTrace[] = Array.from({ length: 30 }, () =>
      makeTrace({
        agentId: asPersonaId('ts-coder'),
        taskTypeSignature: 'review::ts',
        capabilityRequirements: reqs,
      }),
    );

    promoteCapabilityClaims(traces, { agentRegistry: stub.registry });
    const claim = stub.agents.get('ts-coder')!.capabilities?.find((c) => c.id === 'code.review.ts')!;
    expect(claim.actionVerbs).toEqual(['review', 'analyze']);
    expect(claim.fileExtensions).toEqual(['.ts', '.tsx']);
    expect(claim.domains).toEqual(['code-mutation']);
  });
});
