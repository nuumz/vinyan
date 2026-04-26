/**
 * handleRoutingExplain — library-level tests against in-memory providers.
 */

import { describe, expect, test } from 'bun:test';
import {
  handleRoutingExplain,
  type OracleVerdictProvider,
  type RoutingRecord,
  type RoutingTraceProvider,
} from '../../src/api/routing-explain-endpoint.ts';
import type { OracleVerdict } from '../../src/core/types.ts';

function makeRecord(taskId: string, overrides: Partial<RoutingRecord> = {}): RoutingRecord {
  return {
    taskId,
    decision: {
      level: 2,
      model: 'claude-sonnet',
      budgetTokens: 50000,
      latencyBudgetMs: 90000,
    },
    factors: {
      blastRadius: 20,
      dependencyDepth: 4,
      testCoverage: 0.6,
      fileVolatility: 8,
      irreversibility: 0.3,
      hasSecurityImplication: false,
      environmentType: 'development',
    },
    ...overrides,
  };
}

function makeProvider(records: Record<string, RoutingRecord>): RoutingTraceProvider {
  return {
    getRoutingRecord(taskId: string) {
      return records[taskId] ?? null;
    },
  };
}

describe('handleRoutingExplain', () => {
  test('found task → 200 + explanation body', async () => {
    const provider = makeProvider({ 'task-1': makeRecord('task-1') });
    const result = await handleRoutingExplain({ taskId: 'task-1' }, { traceStore: provider });
    expect(result.status).toBe(200);
    if (result.status === 200) {
      expect(result.body.taskId).toBe('task-1');
      expect(result.body.level).toBe(2);
      expect(result.body.summary).toContain('L2');
    }
  });

  test('not found → 404 with error message', async () => {
    const provider = makeProvider({});
    const result = await handleRoutingExplain({ taskId: 'missing' }, { traceStore: provider });
    expect(result.status).toBe(404);
    if (result.status === 404) {
      expect(result.body.error).toContain('missing');
    }
  });

  test('empty taskId → 404', async () => {
    const provider = makeProvider({});
    const result = await handleRoutingExplain({ taskId: '' }, { traceStore: provider });
    expect(result.status).toBe(404);
  });

  test('verdicts from oracleAccuracyStore are merged when record has none', async () => {
    const provider = makeProvider({ 'task-x': makeRecord('task-x') });
    const verdict: OracleVerdict = {
      verified: true,
      type: 'known',
      confidence: 0.9,
      evidence: [],
      fileHashes: {},
      durationMs: 1,
      oracleName: 'ast',
    };
    const oracleStore: OracleVerdictProvider = {
      getVerdictsForTask() {
        return [verdict];
      },
    };
    const result = await handleRoutingExplain(
      { taskId: 'task-x' },
      { traceStore: provider, oracleAccuracyStore: oracleStore },
    );
    expect(result.status).toBe(200);
    if (result.status === 200) {
      expect(result.body.oraclesActual).toBeDefined();
      expect(result.body.oraclesActual?.[0]?.name).toBe('ast');
    }
  });

  test('async provider returning a Promise resolves correctly', async () => {
    const provider: RoutingTraceProvider = {
      async getRoutingRecord(taskId: string) {
        await new Promise((r) => setTimeout(r, 1));
        return makeRecord(taskId);
      },
    };
    const result = await handleRoutingExplain({ taskId: 't-async' }, { traceStore: provider });
    expect(result.status).toBe(200);
    if (result.status === 200) {
      expect(result.body.taskId).toBe('t-async');
    }
  });
});
