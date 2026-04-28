import { describe, expect, test } from 'bun:test';
import { createBus } from '../../src/core/bus.ts';
import {
  attachDegradationEventBridge,
  classifyWorkerFailure,
  DEGRADATION_POLICY_VERSION,
  decideDegradation,
} from '../../src/orchestrator/degradation-strategy.ts';
import { TraceCollectorImpl } from '../../src/orchestrator/trace-collector.ts';
import type { ExecutionTrace, RoutingDecision } from '../../src/orchestrator/types.ts';

function makeRouting(): RoutingDecision {
  return {
    level: 2,
    model: 'mock-provider',
    budgetTokens: 10_000,
    latencyBudgetMs: 30_000,
  };
}

function makeTrace(): ExecutionTrace {
  return {
    id: 'trace-1',
    taskId: 'task-1',
    timestamp: Date.now(),
    routingLevel: 1,
    approach: 'fixture',
    oracleVerdicts: {},
    modelUsed: 'mock-provider',
    tokensConsumed: 0,
    durationMs: 1,
    outcome: 'success',
    affectedFiles: [],
  };
}

describe('degradation strategy', () => {
  test('trace-store write failure is fail-closed by policy', () => {
    const decision = decideDegradation({
      failureType: 'trace-store-write-failure',
      component: 'trace-store',
      reason: 'disk full',
      sourceEvent: 'trace:write_failed',
      taskId: 'task-1',
      occurredAt: 123,
    });

    expect(decision.action).toBe('fail-closed');
    expect(decision.capabilityImpact).toBe('blocked');
    expect(decision.retryable).toBe(false);
    expect(decision.severity).toBe('critical');
    expect(decision.policyVersion).toBe(DEGRADATION_POLICY_VERSION);
    expect(decision.occurredAt).toBe(123);
  });

  test('bridge maps circuit breaker opens to oracle-unavailable degradation events', () => {
    const bus = createBus();
    const events: Array<ReturnType<typeof decideDegradation>> = [];
    const bridge = attachDegradationEventBridge(bus);
    bus.on('degradation:triggered', (event) => events.push(event));

    bus.emit('circuit:open', { oracleName: 'ast', failureCount: 3 });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      failureType: 'oracle-unavailable',
      component: 'oracle:ast',
      action: 'fallback',
      sourceEvent: 'circuit:open',
    });
    bridge.detach();
  });

  test('worker error classification separates rate limits from provider failures', () => {
    expect(classifyWorkerFailure('429 Too Many Requests')).toBe('rate-limit');
    expect(classifyWorkerFailure('provider connection reset')).toBe('llm-provider-failure');
  });

  test('trace collector emits trace write failure and bridge normalizes it', async () => {
    const bus = createBus();
    const events: Array<ReturnType<typeof decideDegradation>> = [];
    const bridge = attachDegradationEventBridge(bus);
    bus.on('degradation:triggered', (event) => events.push(event));

    const throwingStore = {
      insert: () => {
        throw new Error('disk full');
      },
    };
    const collector = new TraceCollectorImpl(undefined, throwingStore as never, bus);

    await collector.record(makeTrace());

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      taskId: 'task-1',
      failureType: 'trace-store-write-failure',
      action: 'fail-closed',
      component: 'trace-store',
      sourceEvent: 'trace:write_failed',
    });
    bridge.detach();
  });

  test('bridge detach stops emitting normalized degradation events', () => {
    const bus = createBus();
    const events: Array<ReturnType<typeof decideDegradation>> = [];
    const bridge = attachDegradationEventBridge(bus);
    bus.on('degradation:triggered', (event) => events.push(event));
    bridge.detach();

    bus.emit('worker:error', { taskId: 'task-1', error: 'provider down', routing: makeRouting() });

    expect(events).toHaveLength(0);
  });
});
