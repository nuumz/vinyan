import { describe, expect, test } from 'bun:test';
import type { RejectedApproachRow } from '../../../src/db/rejected-approach-store.ts';
import type { AgentMemoryAPI } from '../../../src/orchestrator/agent-memory/agent-memory-api.ts';
import { buildHistoricalAdversaryContext } from '../../../src/orchestrator/critic/historical-adversary.ts';
import type { ExecutionTrace } from '../../../src/orchestrator/types.ts';

// ---------------------------------------------------------------------------
// Mock AgentMemoryAPI — minimal surface needed by buildHistoricalAdversaryContext
// ---------------------------------------------------------------------------

type RejectedSeed = Pick<RejectedApproachRow, 'approach' | 'failure_oracle' | 'created_at'>;
type TraceSeed = Pick<ExecutionTrace, 'outcome' | 'routingLevel'>;

interface MockAgentMemoryConfig {
  rejected?: RejectedSeed[];
  traces?: TraceSeed[];
  failedThrows?: Error;
  tracesThrows?: Error;
  recordCalls?: { failedTaskType?: string; failedFile?: string; failedLimit?: number; tracesLimit?: number };
}

function makeRejectedRow(seed: RejectedSeed, idx: number): RejectedApproachRow {
  return {
    id: idx,
    task_id: `task-${idx}`,
    task_type: 'code',
    file_target: null,
    file_hash: null,
    approach: seed.approach,
    oracle_verdict: 'fail',
    verdict_confidence: null,
    failure_oracle: seed.failure_oracle,
    routing_level: 2,
    source: 'task-end',
    created_at: seed.created_at,
    expires_at: null,
    action_verb: null,
  };
}

function makeTrace(seed: TraceSeed, idx: number): ExecutionTrace {
  return {
    id: `trace-${idx}`,
    taskId: `task-${idx}`,
    timestamp: seed.routingLevel * 1000,
    routingLevel: seed.routingLevel,
    approach: 'mock',
    oracleVerdicts: {},
    modelUsed: 'mock',
    tokensConsumed: 0,
    durationMs: 0,
    outcome: seed.outcome as ExecutionTrace['outcome'],
    affectedFiles: [],
  };
}

function makeMemory(cfg: MockAgentMemoryConfig = {}): AgentMemoryAPI {
  return {
    queryFacts: async () => [],
    queryFailedApproaches: async (taskType, opts) => {
      if (cfg.recordCalls) {
        cfg.recordCalls.failedTaskType = taskType;
        cfg.recordCalls.failedFile = opts?.file;
        cfg.recordCalls.failedLimit = opts?.limit;
      }
      if (cfg.failedThrows) throw cfg.failedThrows;
      return (cfg.rejected ?? []).map(makeRejectedRow);
    },
    queryRelatedSkills: async () => [],
    queryPriorTraces: async (_taskSig, opts) => {
      if (cfg.recordCalls) {
        cfg.recordCalls.tracesLimit = opts?.limit;
      }
      if (cfg.tracesThrows) throw cfg.tracesThrows;
      return (cfg.traces ?? []).map(makeTrace);
    },
    queryRules: async () => [],
    queryHistoricalProfile: async () => null,
    beginTask: () => {},
    endTask: () => {},
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('buildHistoricalAdversaryContext', () => {
  test('empty memory → returns empty fragment', async () => {
    const memory = makeMemory();
    const fragment = await buildHistoricalAdversaryContext(memory, { taskSignature: 'code:add-fn' });
    expect(fragment.priorFailedApproaches).toBeUndefined();
    expect(fragment.priorTraceSummary).toBeUndefined();
  });

  test('aggregates failed approaches by (approach, failureOracle) — sums occurrences', async () => {
    const memory = makeMemory({
      rejected: [
        { approach: 'agentic-workflow:llm-reasoning', failure_oracle: 'workflow-deadlock', created_at: 100 },
        { approach: 'agentic-workflow:llm-reasoning', failure_oracle: 'workflow-deadlock', created_at: 200 },
        { approach: 'agentic-workflow:llm-reasoning', failure_oracle: 'workflow-deadlock', created_at: 150 },
        { approach: 'direct-edit:single-file', failure_oracle: 'test-fail', created_at: 50 },
      ],
    });
    const fragment = await buildHistoricalAdversaryContext(memory, { taskSignature: 'code:edit' });

    expect(fragment.priorFailedApproaches).toBeDefined();
    const top = fragment.priorFailedApproaches?.[0];
    expect(top?.approach).toBe('agentic-workflow:llm-reasoning');
    expect(top?.failureOracle).toBe('workflow-deadlock');
    expect(top?.occurrences).toBe(3);
    expect(top?.lastSeenAt).toBe(200); // most recent timestamp wins

    const second = fragment.priorFailedApproaches?.[1];
    expect(second?.approach).toBe('direct-edit:single-file');
    expect(second?.occurrences).toBe(1);
  });

  test('skips rows without failure_oracle (no adversarial signal)', async () => {
    const memory = makeMemory({
      rejected: [
        { approach: 'a', failure_oracle: null, created_at: 100 },
        { approach: 'b', failure_oracle: 'lint', created_at: 200 },
      ],
    });
    const fragment = await buildHistoricalAdversaryContext(memory, { taskSignature: 'sig' });
    expect(fragment.priorFailedApproaches).toHaveLength(1);
    expect(fragment.priorFailedApproaches?.[0]?.approach).toBe('b');
  });

  test('summarizes prior traces with success/failure counts and modal escalation level', async () => {
    const memory = makeMemory({
      traces: [
        { outcome: 'success', routingLevel: 1 },
        { outcome: 'success', routingLevel: 2 },
        { outcome: 'failure', routingLevel: 2 },
        { outcome: 'timeout', routingLevel: 2 },
        { outcome: 'escalated', routingLevel: 3 },
        { outcome: 'partial', routingLevel: 2 }, // 'partial' counted in totalAttempts but neither success nor failure
      ],
    });
    const fragment = await buildHistoricalAdversaryContext(memory, { taskSignature: 's' });
    expect(fragment.priorTraceSummary).toBeDefined();
    expect(fragment.priorTraceSummary?.totalAttempts).toBe(6);
    expect(fragment.priorTraceSummary?.successCount).toBe(2);
    expect(fragment.priorTraceSummary?.failureCount).toBe(3);
    expect(fragment.priorTraceSummary?.mostCommonEscalation).toBe(2); // L2 has 4 traces
  });

  test('omits priorTraceSummary when no traces returned', async () => {
    const memory = makeMemory({
      rejected: [{ approach: 'x', failure_oracle: 'lint', created_at: 1 }],
      traces: [],
    });
    const fragment = await buildHistoricalAdversaryContext(memory, { taskSignature: 's' });
    expect(fragment.priorFailedApproaches).toBeDefined();
    expect(fragment.priorTraceSummary).toBeUndefined();
  });

  test('passes file target through to queryFailedApproaches', async () => {
    const recorded: MockAgentMemoryConfig['recordCalls'] = {};
    const memory = makeMemory({ recordCalls: recorded });
    await buildHistoricalAdversaryContext(memory, {
      taskSignature: 'sig',
      fileTarget: 'src/foo.ts',
    });
    expect(recorded.failedTaskType).toBe('sig');
    expect(recorded.failedFile).toBe('src/foo.ts');
  });

  test('omits file option when fileTarget is undefined (no narrowing)', async () => {
    const recorded: MockAgentMemoryConfig['recordCalls'] = {};
    const memory = makeMemory({ recordCalls: recorded });
    await buildHistoricalAdversaryContext(memory, { taskSignature: 'sig' });
    expect(recorded.failedFile).toBeUndefined();
  });

  test('honors custom failedLimit and traceLimit', async () => {
    const recorded: MockAgentMemoryConfig['recordCalls'] = {};
    const memory = makeMemory({ recordCalls: recorded });
    await buildHistoricalAdversaryContext(memory, {
      taskSignature: 'sig',
      failedLimit: 7,
      traceLimit: 11,
    });
    expect(recorded.failedLimit).toBe(7);
    expect(recorded.tracesLimit).toBe(11);
  });

  test('memory query failure → still returns empty fragment (degrades gracefully)', async () => {
    const memory = makeMemory({
      failedThrows: new Error('db down'),
      tracesThrows: new Error('db down'),
    });
    const fragment = await buildHistoricalAdversaryContext(memory, { taskSignature: 's' });
    expect(fragment.priorFailedApproaches).toBeUndefined();
    expect(fragment.priorTraceSummary).toBeUndefined();
  });

  test('partial failure: rejected query throws but traces succeed → still returns trace summary', async () => {
    const memory = makeMemory({
      failedThrows: new Error('rejected store down'),
      traces: [{ outcome: 'success', routingLevel: 1 }],
    });
    const fragment = await buildHistoricalAdversaryContext(memory, { taskSignature: 's' });
    expect(fragment.priorFailedApproaches).toBeUndefined();
    expect(fragment.priorTraceSummary?.totalAttempts).toBe(1);
    expect(fragment.priorTraceSummary?.successCount).toBe(1);
  });
});
