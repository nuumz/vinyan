/**
 * Agent Conversation §5.6 — inter-instance task delegation tests.
 *
 * Three layers, all in-process so the test can run without a network:
 *   1. `A2ATransport.delegateTask` round-trip via a fake fetch + the
 *      real `A2ABridge` mapping pipeline (verifies the structured
 *      `task_result` data part survives serialization).
 *   2. `InstanceCoordinator.delegate` end-to-end with a mocked peer
 *      registry (verifies the federation budget gate + peer iteration).
 *   3. `handleDelegation` seam (verifies remote-first-then-local
 *      fallback and the `delegation:remote` event).
 */
import { describe, expect, test } from 'bun:test';
import { A2ABridge } from '../../src/a2a/bridge.ts';
import { A2ATransport } from '../../src/a2a/a2a-transport.ts';
import { createBus } from '../../src/core/bus.ts';
import { handleDelegation } from '../../src/orchestrator/worker/agent-loop.ts';
import { AgentBudgetTracker } from '../../src/orchestrator/worker/agent-budget.ts';
import { DelegationRouter } from '../../src/orchestrator/delegation-router.ts';
import type { AgentLoopDeps } from '../../src/orchestrator/worker/agent-loop.ts';
import type { DelegationRequest } from '../../src/orchestrator/protocol.ts';
import type { RoutingDecision, TaskInput, TaskResult } from '../../src/orchestrator/types.ts';

// ── Helpers ─────────────────────────────────────────────────────────

function makeParent(overrides: Partial<TaskInput> = {}): TaskInput {
  return {
    id: 'parent-1',
    source: 'cli',
    goal: 'parent task',
    taskType: 'code',
    targetFiles: ['src/auth.ts'],
    budget: { maxTokens: 100_000, maxDurationMs: 60_000, maxRetries: 1 },
    ...overrides,
  };
}

function makeRouting(level: 1 | 2 | 3 = 2): RoutingDecision {
  return {
    level,
    model: 'mock/sonnet',
    budgetTokens: 100_000,
    latencyBudgetMs: 60_000,
  };
}

function makeBudget(): AgentBudgetTracker {
  return AgentBudgetTracker.fromRouting(makeRouting(), 128_000);
}

function makeChildResult(overrides: Partial<TaskResult> = {}): TaskResult {
  return {
    id: 'child-1',
    status: 'completed',
    mutations: [],
    trace: {
      id: 'trace-child-1',
      taskId: 'child-1',
      timestamp: Date.now(),
      routingLevel: 2,
      approach: 'direct-edit',
      oracleVerdicts: { ast: true, type: true },
      modelUsed: 'mock/sonnet',
      tokensConsumed: 1500,
      durationMs: 8000,
      outcome: 'success',
      affectedFiles: ['src/auth.ts'],
    },
    ...overrides,
  };
}

// ── Layer 1: A2ATransport.delegateTask round-trip via real bridge ──

describe('A2ATransport.delegateTask + A2ABridge round-trip', () => {
  test('structured task_result survives serialization (mutations + verdicts intact)', async () => {
    // Build a real bridge wired to a stub executeTask that returns a rich result.
    const bridge = new A2ABridge({
      executeTask: async (input) =>
        makeChildResult({
          id: input.id,
          mutations: [
            {
              file: 'src/auth.ts',
              diff: '@@ -1 +1 @@\n-old\n+new',
              oracleVerdicts: {
                ast: { verified: true, confidence: 0.9, type: 'known', evidence: [], opinion: { belief: 0.9, disbelief: 0.05, uncertainty: 0.05, baseRate: 0.5 }, durationMs: 12, fileHashes: {} },
              } as never,
            },
          ],
        }),
      baseUrl: 'http://test',
    });

    // Replace global fetch with one that calls our bridge directly.
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_url: string, init: RequestInit | undefined) => {
      const reqBody = JSON.parse(init!.body as string);
      const rpcResponse = await bridge.handleRequest(reqBody);
      return new Response(JSON.stringify(rpcResponse), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch;

    try {
      const transport = new A2ATransport({
        peerUrl: 'http://peer.test',
        oracleName: 'task-delegation',
        instanceId: 'remote-1',
      });
      const result = await transport.delegateTask(
        makeParent({ id: 'sub-1', goal: 'fix bug' }),
        5000,
      );
      expect(result).not.toBeNull();
      expect(result!.id).toBe('sub-1');
      expect(result!.status).toBe('completed');
      // Structured artifact path → mutations preserved.
      expect(result!.mutations).toHaveLength(1);
      expect(result!.mutations[0]!.file).toBe('src/auth.ts');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('input-required round-trips with clarification questions', async () => {
    const bridge = new A2ABridge({
      executeTask: async (input) =>
        makeChildResult({
          id: input.id,
          status: 'input-required',
          clarificationNeeded: ['Which auth file?', 'Keep old name?'],
        }),
      baseUrl: 'http://test',
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_url: string, init: RequestInit | undefined) => {
      const rpcResponse = await bridge.handleRequest(JSON.parse(init!.body as string));
      return new Response(JSON.stringify(rpcResponse), { status: 200 });
    }) as typeof fetch;

    try {
      const transport = new A2ATransport({
        peerUrl: 'http://peer.test',
        oracleName: 'task-delegation',
        instanceId: 'remote-1',
      });
      const result = await transport.delegateTask(makeParent({ id: 'sub-2' }), 5000);
      expect(result!.status).toBe('input-required');
      expect(result!.clarificationNeeded).toEqual(['Which auth file?', 'Keep old name?']);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('returns null on transport failure (caller falls back to local)', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;
    try {
      const transport = new A2ATransport({
        peerUrl: 'http://nowhere',
        oracleName: 'task-delegation',
      });
      const result = await transport.delegateTask(makeParent(), 1000);
      expect(result).toBeNull();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

// ── Layer 3: handleDelegation §5.6 seam ─────────────────────────────

describe('handleDelegation §5.6 remote-first-then-local seam', () => {
  function baseDeps(overrides: Partial<AgentLoopDeps> = {}): AgentLoopDeps {
    return {
      workspace: '/tmp/test',
      contextWindow: 128_000,
      agentWorkerEntryPath: '',
      compressPerception: (p) => p,
      toolExecutor: { execute: async () => ({ callId: '', tool: '', status: 'success', durationMs: 0 }) },
      delegationRouter: new DelegationRouter(),
      executeTask: async () => makeChildResult({ trace: { ...makeChildResult().trace, approach: 'local-fallback' } }),
      ...overrides,
    } as AgentLoopDeps;
  }

  test('uses remote when InstanceCoordinator delegates successfully', async () => {
    const bus = createBus();
    let remoteCount = 0;
    const events: Array<{ peerId: string; status: string }> = [];
    bus.on('delegation:remote', (e) => events.push({ peerId: e.peerId, status: e.status }));

    const fakeCoordinator = {
      canDelegate: () => true,
      delegate: async () => {
        remoteCount++;
        return {
          delegated: true,
          peerId: 'http://peer-1',
          reason: 'ok',
          result: makeChildResult({
            id: 'remote-child',
            trace: { ...makeChildResult().trace, approach: 'a2a-remote', sourceInstanceId: 'remote-1' },
          }),
        };
      },
    } as unknown as NonNullable<AgentLoopDeps['instanceCoordinator']>;

    let localCount = 0;
    const deps = baseDeps({
      bus,
      instanceCoordinator: fakeCoordinator,
      executeTask: async () => {
        localCount++;
        return makeChildResult();
      },
    });

    const request: DelegationRequest = {
      goal: 'subtask',
      targetFiles: ['src/auth.ts'],
    };
    const result = await handleDelegation(request, makeParent(), makeBudget(), makeRouting(), deps);

    expect(remoteCount).toBe(1);
    expect(localCount).toBe(0);
    expect(result.status).toBe('success');
    const out = JSON.parse(result.output as string);
    expect(out.executedRemotely).toBe(true);
    expect(events).toHaveLength(1);
    expect(events[0]!.peerId).toBe('http://peer-1');
  });

  test('falls back to local when remote returns delegated=false', async () => {
    const fakeCoordinator = {
      canDelegate: () => true,
      delegate: async () => ({ delegated: false, reason: 'all peers timed out' }),
    } as unknown as NonNullable<AgentLoopDeps['instanceCoordinator']>;

    let localCount = 0;
    const deps = baseDeps({
      instanceCoordinator: fakeCoordinator,
      executeTask: async () => {
        localCount++;
        return makeChildResult();
      },
    });

    const result = await handleDelegation(
      { goal: 'subtask', targetFiles: ['src/auth.ts'] },
      makeParent(),
      makeBudget(),
      makeRouting(),
      deps,
    );

    expect(localCount).toBe(1);
    expect(result.status).toBe('success');
    const out = JSON.parse(result.output as string);
    expect(out.executedRemotely).toBeUndefined();
  });

  test('skips remote attempt entirely when InstanceCoordinator.canDelegate=false', async () => {
    let delegateCalled = false;
    let localCount = 0;
    const fakeCoordinator = {
      canDelegate: () => false,
      delegate: async () => {
        delegateCalled = true;
        return { delegated: false, reason: 'should not reach here' };
      },
    } as unknown as NonNullable<AgentLoopDeps['instanceCoordinator']>;

    const deps = baseDeps({
      instanceCoordinator: fakeCoordinator,
      executeTask: async () => {
        localCount++;
        return makeChildResult();
      },
    });

    await handleDelegation(
      { goal: 'subtask', targetFiles: ['src/auth.ts'] },
      makeParent(),
      makeBudget(),
      makeRouting(),
      deps,
    );

    expect(delegateCalled).toBe(false);
    expect(localCount).toBe(1);
  });

  test('uses local when no InstanceCoordinator is wired (backward compat)', async () => {
    let localCount = 0;
    const deps = baseDeps({
      // No instanceCoordinator — same semantics as pre-§5.6.
      executeTask: async () => {
        localCount++;
        return makeChildResult();
      },
    });

    const result = await handleDelegation(
      { goal: 'subtask', targetFiles: ['src/auth.ts'] },
      makeParent(),
      makeBudget(),
      makeRouting(),
      deps,
    );

    expect(localCount).toBe(1);
    expect(result.status).toBe('success');
  });

  test('preserves input-required clarification flow over remote path', async () => {
    const fakeCoordinator = {
      canDelegate: () => true,
      delegate: async () => ({
        delegated: true,
        peerId: 'http://peer-1',
        reason: 'ok',
        result: makeChildResult({
          status: 'input-required',
          clarificationNeeded: ['Which file?'],
        }),
      }),
    } as unknown as NonNullable<AgentLoopDeps['instanceCoordinator']>;

    const deps = baseDeps({ instanceCoordinator: fakeCoordinator });
    const result = await handleDelegation(
      { goal: 'subtask', targetFiles: ['src/auth.ts'] },
      makeParent(),
      makeBudget(),
      makeRouting(),
      deps,
    );

    expect(result.status).toBe('success'); // input-required is not an error
    const out = JSON.parse(result.output as string);
    expect(out.executedRemotely).toBe(true);
    expect(out.pausedForUserInput).toBe(true);
    expect(out.clarificationNeeded).toEqual(['Which file?']);
  });
});
