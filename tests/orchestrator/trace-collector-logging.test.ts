import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import type { TraceStore } from '../../src/db/trace-store.ts';
import { TraceCollectorImpl, TracePersistenceError } from '../../src/orchestrator/trace-collector.ts';
import type { ExecutionTrace } from '../../src/orchestrator/types.ts';

function makeTrace(overrides: Partial<ExecutionTrace> = {}): ExecutionTrace {
  return {
    id: 'trace-001',
    taskId: 'task-001',
    timestamp: Date.now(),
    routingLevel: 1,
    approach: 'direct-edit',
    oracleVerdicts: {},
    modelUsed: 'claude-haiku',
    tokensConsumed: 100,
    durationMs: 500,
    outcome: 'success',
    affectedFiles: [],
    ...overrides,
  };
}

/** Minimal TraceStore stub — only insert is exercised by TraceCollectorImpl. */
function makeThrowingStore(error: Error): TraceStore {
  return {
    insert: () => {
      throw error;
    },
  } as unknown as TraceStore;
}

describe('TraceCollectorImpl error logging (WU5)', () => {
  let warnSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  test('logs warning when TraceStore.insert throws', async () => {
    const insertError = new Error('DB locked');
    const collector = new TraceCollectorImpl(undefined, makeThrowingStore(insertError));

    await collector.record(makeTrace());

    expect(warnSpy).toHaveBeenCalledTimes(1);
    const [msg, err] = warnSpy.mock.calls[0]!;
    expect(msg).toBe('[vinyan] Trace INSERT failed:');
    expect(err).toBe(insertError);
  });

  test('record() does not throw even when store throws (best-effort)', async () => {
    const collector = new TraceCollectorImpl(undefined, makeThrowingStore(new Error('disk full')));
    await expect(collector.record(makeTrace())).resolves.toBeUndefined();
  });

  test('record() fails closed when governance provenance cannot be persisted', async () => {
    const trace = makeTrace({
      governanceProvenance: {
        decisionId: 'risk-router:t-1:L1',
        policyVersion: 'risk-router:v1',
        attributedTo: 'riskRouter',
        wasGeneratedBy: 'RiskRouterImpl.assessInitialLevel',
        wasDerivedFrom: [],
        decidedAt: 123,
        reason: 'governed routing decision',
      },
    });
    const collector = new TraceCollectorImpl(undefined, makeThrowingStore(new Error('disk full')));

    await expect(collector.record(trace)).rejects.toBeInstanceOf(TracePersistenceError);
    expect(collector.getLatestTrace()).toBe(trace);
  });

  test('trace is still kept in memory even when SQLite insert fails', async () => {
    const collector = new TraceCollectorImpl(undefined, makeThrowingStore(new Error('write error')));
    const trace = makeTrace({ id: 'trace-999' });

    await collector.record(trace);

    expect(collector.getTraceCount()).toBe(1);
    expect(collector.getLatestTrace()?.id).toBe('trace-999');
  });

  test('no warning when store is absent (no TraceStore injected)', async () => {
    const collector = new TraceCollectorImpl();
    await collector.record(makeTrace());
    expect(warnSpy).not.toHaveBeenCalled();
  });
});

describe('TraceCollectorImpl parent linkage (delegation observability)', () => {
  test('record() auto-fills parentTaskId from registry when builder did not set it', async () => {
    const collector = new TraceCollectorImpl();
    collector.registerParent('child-1', 'parent-1');
    await collector.record(makeTrace({ id: 'trace-child-1', taskId: 'child-1' }));
    expect(collector.getLatestTrace()?.parentTaskId).toBe('parent-1');
  });

  test('record() preserves parentTaskId when the builder set one explicitly (override wins)', async () => {
    const collector = new TraceCollectorImpl();
    collector.registerParent('child-2', 'wrong-parent');
    await collector.record(makeTrace({ id: 'trace-child-2', taskId: 'child-2', parentTaskId: 'real-parent' }));
    expect(collector.getLatestTrace()?.parentTaskId).toBe('real-parent');
  });

  test('clearParent() removes the registry entry — subsequent records do not get the linkage', async () => {
    const collector = new TraceCollectorImpl();
    collector.registerParent('child-3', 'parent-3');
    collector.clearParent('child-3');
    await collector.record(makeTrace({ id: 'trace-child-3', taskId: 'child-3' }));
    expect(collector.getLatestTrace()?.parentTaskId).toBeUndefined();
  });

  test('top-level tasks (no parent registered) record without parentTaskId — no leakage from prior tasks', async () => {
    const collector = new TraceCollectorImpl();
    collector.registerParent('child-X', 'parent-X');
    await collector.record(makeTrace({ id: 'trace-child-X', taskId: 'child-X' }));
    collector.clearParent('child-X');
    await collector.record(makeTrace({ id: 'trace-top', taskId: 'top-level-task' }));
    // Last recorded trace should NOT have leaked parentTaskId from the
    // prior child task's registration.
    expect(collector.getLatestTrace()?.parentTaskId).toBeUndefined();
  });
});
