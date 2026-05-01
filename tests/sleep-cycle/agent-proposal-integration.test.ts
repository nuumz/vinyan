import { Database } from 'bun:sqlite';
import { beforeEach, describe, expect, test } from 'bun:test';
import { asPersonaId } from '../../src/core/agent-vocabulary.ts';
import type { VinyanBus } from '../../src/core/bus.ts';
import { AGENT_PROPOSAL_SCHEMA_SQL } from '../../src/db/agent-proposal-schema.ts';
import { AgentProposalStore } from '../../src/db/agent-proposal-store.ts';
import { PATTERN_SCHEMA_SQL } from '../../src/db/pattern-schema.ts';
import { PatternStore } from '../../src/db/pattern-store.ts';
import { TRACE_SCHEMA_SQL } from '../../src/db/trace-schema.ts';
import { TraceStore } from '../../src/db/trace-store.ts';
import type { CapabilityRequirement, ExecutionTrace } from '../../src/orchestrator/types.ts';
import { SleepCycleRunner } from '../../src/sleep-cycle/sleep-cycle.ts';

function makeStores() {
  const db = new Database(':memory:');
  db.exec(TRACE_SCHEMA_SQL);
  db.exec(PATTERN_SCHEMA_SQL);
  db.exec(AGENT_PROPOSAL_SCHEMA_SQL);
  return {
    traceStore: new TraceStore(db),
    patternStore: new PatternStore(db),
    agentProposalStore: new AgentProposalStore(db),
  };
}

function makeRequirement(): CapabilityRequirement {
  return {
    id: 'code.audit.jwt',
    weight: 0.9,
    source: 'llm-extract',
    fileExtensions: ['.ts'],
    actionVerbs: ['audit'],
    domains: ['security'],
    role: 'security-reviewer',
  };
}

function makeTrace(overrides: Partial<ExecutionTrace>): ExecutionTrace {
  return {
    id: `trace-${Math.random().toString(36).slice(2, 8)}`,
    taskId: `task-${Math.random().toString(36).slice(2, 8)}`,
    timestamp: 1000,
    routingLevel: 2,
    taskTypeSignature: 'audit::jwt',
    approach: 'synthetic-agent',
    oracleVerdicts: { ast: true, type: true },
    modelUsed: 'mock',
    tokensConsumed: 100,
    durationMs: 500,
    outcome: 'success',
    affectedFiles: ['src/auth/jwt.ts'],
    ...overrides,
  };
}

function insertSyntheticSuccessWindow(traceStore: TraceStore): void {
  const reqs = [makeRequirement()];
  for (let index = 0; index < 10; index++) {
    const syntheticAgentId = `synthetic-${index % 2}`;
    traceStore.insert(
      makeTrace({
        id: `synthetic-success-${index}`,
        taskId: `synthetic-task-${index}`,
        sessionId: `synthetic-session-${index}`,
        timestamp: 1000 + index,
        agentId: asPersonaId(syntheticAgentId),
        syntheticAgentId,
        capabilityRequirements: reqs,
        unmetCapabilityIds: ['code.audit.jwt'],
      }),
    );
  }

  for (let index = 0; index < 4; index++) {
    traceStore.insert(
      makeTrace({
        id: `filler-${index}`,
        taskId: `filler-task-${index}`,
        sessionId: `filler-session-${index}`,
        timestamp: 2000 + index,
        taskTypeSignature: `filler-${index}::md`,
        agentId: undefined,
        syntheticAgentId: undefined,
        capabilityRequirements: undefined,
        unmetCapabilityIds: undefined,
      }),
    );
  }
}

let env: ReturnType<typeof makeStores>;

beforeEach(() => {
  env = makeStores();
});

describe('SleepCycleRunner — persistent agent proposal integration', () => {
  test('stores pending custom-agent proposals through SleepCycleRunner.run()', async () => {
    insertSyntheticSuccessWindow(env.traceStore);
    const events: Array<{ event: string; payload: unknown }> = [];
    const bus = {
      emit: (event: string, payload: unknown) => {
        events.push({ event, payload });
      },
    } as unknown as VinyanBus;

    const runner = new SleepCycleRunner({
      traceStore: env.traceStore,
      patternStore: env.patternStore,
      agentProposalStore: env.agentProposalStore,
      bus,
      config: { minTracesForAnalysis: 10, patternMinFrequency: 5 },
    });

    const result = await runner.run();

    expect(result.agentProposalsCreated).toBe(1);
    const proposals = env.agentProposalStore.listByStatus('pending');
    expect(proposals).toHaveLength(1);
    expect(proposals[0]!.status).toBe('pending');
    expect(proposals[0]!.trustTier).toBe('low');
    expect(proposals[0]!.capabilityOverrides).toEqual({ readAny: true, writeAny: false, network: false, shell: false });

    const createdEvents = events.filter((entry) => entry.event === 'evolution:agentProposalCreated');
    expect(createdEvents).toHaveLength(1);
    const sleepEvent = events.find((entry) => entry.event === 'sleep:cycleComplete')?.payload as
      | { agentProposalsCreated?: number }
      | undefined;
    expect(sleepEvent?.agentProposalsCreated).toBe(1);
  });

  test('reports zero proposals when no proposal store is wired', async () => {
    insertSyntheticSuccessWindow(env.traceStore);

    const runner = new SleepCycleRunner({
      traceStore: env.traceStore,
      patternStore: env.patternStore,
      config: { minTracesForAnalysis: 10, patternMinFrequency: 5 },
    });

    const result = await runner.run();

    expect(result.agentProposalsCreated).toBe(0);
    expect(env.agentProposalStore.countByStatus('pending')).toBe(0);
  });
});
