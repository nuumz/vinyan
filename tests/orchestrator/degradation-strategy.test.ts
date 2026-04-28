import { describe, expect, test } from 'bun:test';
import { createBus } from '../../src/core/bus.ts';
import {
  attachDegradationEventBridge,
  classifyToolFailure,
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

  test('tool failure classification separates timeout from generic tool failure', () => {
    expect(classifyToolFailure('timeout')).toBe('tool-timeout');
    expect(classifyToolFailure('exit-code')).toBe('tool-failure');
  });

  test('bridge maps classified tool failures to degradation events', () => {
    const bus = createBus();
    const events: Array<ReturnType<typeof decideDegradation>> = [];
    const bridge = attachDegradationEventBridge(bus);
    bus.on('degradation:triggered', (event) => events.push(event));

    bus.emit('tool:failure_classified', {
      taskId: 'task-1',
      type: 'exit-code',
      recoverable: true,
      error: 'command exited 1',
    });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      taskId: 'task-1',
      failureType: 'tool-failure',
      action: 'retry',
      component: 'tool-runtime',
      sourceEvent: 'tool:failure_classified',
    });
    bridge.detach();
  });

  test('bridge maps drafting failures to provider degradation events', () => {
    const bus = createBus();
    const events: Array<ReturnType<typeof decideDegradation>> = [];
    const bridge = attachDegradationEventBridge(bus);
    bus.on('degradation:triggered', (event) => events.push(event));

    bus.emit('spec:drafting_failed', { taskId: 'task-1', reason: 'provider returned invalid JSON', durationMs: 200 });
    bus.emit('brainstorm:drafting_failed', { taskId: 'task-2', reason: 'provider timeout', durationMs: 300 });

    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      taskId: 'task-1',
      failureType: 'llm-provider-failure',
      component: 'spec-refinement',
      sourceEvent: 'spec:drafting_failed',
    });
    expect(events[1]).toMatchObject({
      taskId: 'task-2',
      failureType: 'llm-provider-failure',
      component: 'brainstorm',
      sourceEvent: 'brainstorm:drafting_failed',
    });
    bridge.detach();
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

  // A9 broader failure-class coverage (2026-04-28): events that previously
  // emitted but were never normalized into the degradation contract.
  describe('broader failure-class bridges', () => {
    test('shadow:failed → oracle-unavailable on shadow-runner', () => {
      const bus = createBus();
      const events: Array<ReturnType<typeof decideDegradation>> = [];
      const bridge = attachDegradationEventBridge(bus);
      bus.on('degradation:triggered', (event) => events.push(event));

      bus.emit('shadow:failed', {
        job: {
          id: 'shadow-1',
          taskId: 'task-shadow',
          status: 'failed',
          enqueuedAt: 1,
          retryCount: 1,
          maxRetries: 1,
        },
        error: 'sandbox crashed',
      });

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        taskId: 'task-shadow',
        failureType: 'oracle-unavailable',
        component: 'shadow-runner',
        sourceEvent: 'shadow:failed',
        action: 'fallback',
      });
      expect(events[0]?.reason).toContain('shadow-1');
      bridge.detach();
    });

    test('tool:remediation_failed → tool-failure on tool-remediation', () => {
      const bus = createBus();
      const events: Array<ReturnType<typeof decideDegradation>> = [];
      const bridge = attachDegradationEventBridge(bus);
      bus.on('degradation:triggered', (event) => events.push(event));

      bus.emit('tool:remediation_failed', {
        taskId: 'task-rem',
        reason: 'no recoverable strategy',
      });

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        taskId: 'task-rem',
        failureType: 'tool-failure',
        component: 'tool-remediation',
        sourceEvent: 'tool:remediation_failed',
      });
      bridge.detach();
    });

    test('testgen:error and selfmodel:calibration_error → llm-provider-failure', () => {
      const bus = createBus();
      const events: Array<ReturnType<typeof decideDegradation>> = [];
      const bridge = attachDegradationEventBridge(bus);
      bus.on('degradation:triggered', (event) => events.push(event));

      bus.emit('testgen:error', { taskId: 'task-tg', error: 'invalid JSON from provider' });
      bus.emit('selfmodel:calibration_error', { taskId: 'task-sm', error: 'rate limited' });

      expect(events).toHaveLength(2);
      expect(events[0]).toMatchObject({
        taskId: 'task-tg',
        failureType: 'llm-provider-failure',
        component: 'test-generator',
        sourceEvent: 'testgen:error',
      });
      expect(events[1]).toMatchObject({
        taskId: 'task-sm',
        failureType: 'llm-provider-failure',
        component: 'self-model-calibration',
        sourceEvent: 'selfmodel:calibration_error',
      });
      bridge.detach();
    });

    test('agent:synthesis-failed → llm-provider-failure with synthesis component id', () => {
      const bus = createBus();
      const events: Array<ReturnType<typeof decideDegradation>> = [];
      const bridge = attachDegradationEventBridge(bus);
      bus.on('degradation:triggered', (event) => events.push(event));

      bus.emit('agent:synthesis-failed', {
        taskId: 'task-syn',
        suggestedId: 'synthetic-abc12345',
        reason: 'register collision',
      });

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        taskId: 'task-syn',
        failureType: 'llm-provider-failure',
        component: 'agent-synthesis:synthetic-abc12345',
        sourceEvent: 'agent:synthesis-failed',
      });
      bridge.detach();
    });
  });
});
