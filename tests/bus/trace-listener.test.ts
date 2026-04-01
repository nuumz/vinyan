import { describe, expect, test } from 'bun:test';
import { attachTraceListener } from '../../src/bus/trace-listener.ts';
import { createBus } from '../../src/core/bus.ts';
import type { ExecutionTrace } from '../../src/orchestrator/types.ts';

function makeTrace(overrides?: Partial<ExecutionTrace>): ExecutionTrace {
  return {
    id: 'trace-1',
    taskId: 'task-1',
    timestamp: Date.now(),
    routingLevel: 1,
    approach: 'test approach',
    oracleVerdicts: { type: true },
    model_used: 'mock/test',
    tokens_consumed: 100,
    durationMs: 500,
    outcome: 'success',
    affected_files: ['a.ts'],
    ...overrides,
  };
}

describe('attachTraceListener', () => {
  test('counts outcomes correctly', () => {
    const bus = createBus();
    const { getMetrics } = attachTraceListener(bus);

    bus.emit('trace:record', { trace: makeTrace({ outcome: 'success' }) });
    bus.emit('trace:record', { trace: makeTrace({ outcome: 'failure' }) });
    bus.emit('trace:record', { trace: makeTrace({ outcome: 'timeout' }) });
    bus.emit('trace:record', { trace: makeTrace({ outcome: 'escalated' }) });
    bus.emit('trace:record', { trace: makeTrace({ outcome: 'failure' }) });

    const m = getMetrics();
    expect(m.totalTraces).toBe(5);
    expect(m.successCount).toBe(1);
    expect(m.failureCount).toBe(2);
    expect(m.timeoutCount).toBe(1);
    expect(m.escalationCount).toBe(1);
  });

  test('computes running average of qualityScore composite', () => {
    const bus = createBus();
    const { getMetrics } = attachTraceListener(bus);

    bus.emit('trace:record', {
      trace: makeTrace({
        qualityScore: {
          architecturalCompliance: 1,
          efficiency: 1,
          composite: 0.8,
          dimensionsAvailable: 2,
          phase: 'phase0',
        },
      }),
    });
    bus.emit('trace:record', {
      trace: makeTrace({
        qualityScore: {
          architecturalCompliance: 0.5,
          efficiency: 0.5,
          composite: 0.4,
          dimensionsAvailable: 2,
          phase: 'phase0',
        },
      }),
    });

    expect(getMetrics().avgQualityComposite).toBeCloseTo(0.6, 5);
  });

  test('skips quality average when qualityScore is absent', () => {
    const bus = createBus();
    const { getMetrics } = attachTraceListener(bus);

    bus.emit('trace:record', { trace: makeTrace() }); // no qualityScore
    expect(getMetrics().avgQualityComposite).toBe(0);
  });

  test('tracks per routing level breakdown', () => {
    const bus = createBus();
    const { getMetrics } = attachTraceListener(bus);

    bus.emit('trace:record', { trace: makeTrace({ routingLevel: 0, outcome: 'success' }) });
    bus.emit('trace:record', { trace: makeTrace({ routingLevel: 1, outcome: 'failure' }) });
    bus.emit('trace:record', { trace: makeTrace({ routingLevel: 1, outcome: 'success' }) });

    const m = getMetrics();
    expect(m.byRoutingLevel[0]).toEqual({ total: 1, success: 1 });
    expect(m.byRoutingLevel[1]).toEqual({ total: 2, success: 1 });
  });

  test('computes average duration', () => {
    const bus = createBus();
    const { getMetrics } = attachTraceListener(bus);

    bus.emit('trace:record', { trace: makeTrace({ durationMs: 100 }) });
    bus.emit('trace:record', { trace: makeTrace({ durationMs: 300 }) });

    expect(getMetrics().avgDurationMs).toBeCloseTo(200, 5);
  });

  test('detach stops accumulation', () => {
    const bus = createBus();
    const { getMetrics, detach } = attachTraceListener(bus);

    bus.emit('trace:record', { trace: makeTrace() });
    expect(getMetrics().totalTraces).toBe(1);

    detach();
    bus.emit('trace:record', { trace: makeTrace() });
    expect(getMetrics().totalTraces).toBe(1); // not incremented
  });
});
