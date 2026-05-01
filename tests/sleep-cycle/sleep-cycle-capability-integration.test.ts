/**
 * Capability-First Phase D — sleep-cycle integration.
 *
 * Proves the runtime runner consumes persisted capability metadata and calls
 * promoteCapabilityClaims(), rather than only testing the pure promotion
 * function directly.
 */
import { Database } from 'bun:sqlite';
import { beforeEach, describe, expect, test } from 'bun:test';
import { asPersonaId } from '../../src/core/agent-vocabulary.ts';
import type { VinyanBus } from '../../src/core/bus.ts';
import { PATTERN_SCHEMA_SQL } from '../../src/db/pattern-schema.ts';
import { PatternStore } from '../../src/db/pattern-store.ts';
import { TRACE_SCHEMA_SQL } from '../../src/db/trace-schema.ts';
import { TraceStore } from '../../src/db/trace-store.ts';
import type { AgentRegistry } from '../../src/orchestrator/agents/registry.ts';
import type {
  AgentSpec,
  CapabilityClaim,
  CapabilityRequirement,
  ExecutionTrace,
} from '../../src/orchestrator/types.ts';
import { SleepCycleRunner } from '../../src/sleep-cycle/sleep-cycle.ts';

function makeStores() {
  const db = new Database(':memory:');
  db.exec(TRACE_SCHEMA_SQL);
  db.exec(PATTERN_SCHEMA_SQL);
  return {
    db,
    traceStore: new TraceStore(db),
    patternStore: new PatternStore(db),
  };
}

function makeRequirement(id: string): CapabilityRequirement {
  return {
    id,
    weight: 0.9,
    source: 'llm-extract',
    fileExtensions: ['.ts'],
    actionVerbs: ['review'],
    domains: ['code-review'],
  };
}

function makeTrace(overrides: Partial<ExecutionTrace>): ExecutionTrace {
  return {
    id: `tr-${Math.random().toString(36).slice(2, 8)}`,
    taskId: `task-${Math.random().toString(36).slice(2, 8)}`,
    timestamp: 1000,
    routingLevel: 1,
    taskTypeSignature: 'review::ts',
    approach: 'specialist-agent',
    oracleVerdicts: { ast: true, type: true },
    modelUsed: 'mock',
    tokensConsumed: 100,
    durationMs: 500,
    outcome: 'success',
    affectedFiles: ['src/review-target.ts'],
    ...overrides,
  };
}

function makeRegistryStub(seed: AgentSpec): {
  registry: Pick<AgentRegistry, 'getAgent' | 'mergeCapabilityClaims'>;
  getAgent(): AgentSpec;
  mergeCalls: Array<{ agentId: string; claims: CapabilityClaim[] }>;
} {
  let agent = { ...seed, capabilities: [...(seed.capabilities ?? [])] };
  const mergeCalls: Array<{ agentId: string; claims: CapabilityClaim[] }> = [];
  return {
    mergeCalls,
    getAgent: () => agent,
    registry: {
      getAgent(id: string): AgentSpec | null {
        return id === agent.id ? agent : null;
      },
      mergeCapabilityClaims(agentId: string, claims: CapabilityClaim[]): boolean {
        if (agentId !== agent.id) return false;
        mergeCalls.push({ agentId, claims });
        const merged = new Map<string, CapabilityClaim>();
        for (const existing of agent.capabilities ?? []) merged.set(existing.id, existing);
        for (const claim of claims) merged.set(claim.id, claim);
        agent = { ...agent, capabilities: [...merged.values()] };
        return true;
      },
    },
  };
}

function insertCapabilityPromotionWindow(traceStore: TraceStore): void {
  const reqs = [makeRequirement('code.review.ts')];
  for (let i = 0; i < 30; i++) {
    traceStore.insert(
      makeTrace({
        id: `cap-${i}`,
        sessionId: `s-${i % 5}`,
        timestamp: 1000 + i,
        agentId: asPersonaId('ts-coder'),
        taskTypeSignature: 'review::ts',
        capabilityRequirements: reqs,
        outcome: 'success',
      }),
    );
  }

  // Sleep-cycle data gate requires at least 5 distinct task types.
  for (let i = 0; i < 4; i++) {
    traceStore.insert(
      makeTrace({
        id: `filler-${i}`,
        sessionId: `filler-${i}`,
        timestamp: 2000 + i,
        taskTypeSignature: `filler-${i}::md`,
        agentId: undefined,
        capabilityRequirements: undefined,
      }),
    );
  }
}

let env: ReturnType<typeof makeStores>;

beforeEach(() => {
  env = makeStores();
});

describe('SleepCycleRunner — capability promotion integration', () => {
  test('does NOT promote capability claims when no agentRegistry is wired', async () => {
    insertCapabilityPromotionWindow(env.traceStore);

    const runner = new SleepCycleRunner({
      traceStore: env.traceStore,
      patternStore: env.patternStore,
      config: { minTracesForAnalysis: 30, patternMinFrequency: 5 },
    });

    const result = await runner.run();
    expect(result.capabilitiesPromoted).toBe(0);
  });

  test('promotes capability claims through SleepCycleRunner.run()', async () => {
    insertCapabilityPromotionWindow(env.traceStore);
    const stub = makeRegistryStub({
      id: 'ts-coder',
      name: 'TS Coder',
      description: 'Stable code specialist',
      capabilities: [{ id: 'code.refactor.ts', evidence: 'builtin', confidence: 0.9 }],
    });
    const events: Array<{ event: string; payload: unknown }> = [];
    const bus = {
      emit: (event: string, payload: unknown) => {
        events.push({ event, payload });
      },
    } as unknown as VinyanBus;

    const runner = new SleepCycleRunner({
      traceStore: env.traceStore,
      patternStore: env.patternStore,
      agentRegistry: stub.registry,
      bus,
      config: { minTracesForAnalysis: 30, patternMinFrequency: 5 },
    });

    const result = await runner.run();

    expect(result.capabilitiesPromoted).toBe(1);
    expect(stub.mergeCalls).toHaveLength(1);
    const promoted = stub.getAgent().capabilities?.find((claim) => claim.id === 'code.review.ts');
    expect(promoted).toBeDefined();
    expect(promoted!.evidence).toBe('evolved');
    expect(promoted!.fileExtensions).toEqual(['.ts']);
    expect(promoted!.actionVerbs).toEqual(['review']);

    const promotedEvents = events.filter((e) => e.event === 'evolution:capabilityPromoted');
    expect(promotedEvents).toHaveLength(1);
    const sleepEvent = events.find((e) => e.event === 'sleep:cycleComplete')?.payload as
      | { capabilitiesPromoted?: number }
      | undefined;
    expect(sleepEvent?.capabilitiesPromoted).toBe(1);
  });
});
