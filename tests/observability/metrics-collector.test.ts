import { describe, expect, test } from 'bun:test';
import { createBus } from '../../src/core/bus.ts';
import { MetricsCollector } from '../../src/observability/metrics.ts';

describe('MetricsCollector', () => {
  test('emitting guardrail:injection_detected increments counter', () => {
    const bus = createBus();
    const collector = new MetricsCollector();
    collector.attach(bus);

    bus.emit('guardrail:injection_detected', { field: 'goal', patterns: ['DROP TABLE'] });

    expect(collector.get('guardrail.injection')).toBe(1);
  });

  test('multiple events increment correct counters independently', () => {
    const bus = createBus();
    const collector = new MetricsCollector();
    collector.attach(bus);

    bus.emit('guardrail:injection_detected', { field: 'goal', patterns: [] });
    bus.emit('guardrail:injection_detected', { field: 'goal', patterns: [] });
    bus.emit('guardrail:bypass_detected', { field: 'goal', patterns: [] });
    bus.emit('circuit:open', { oracleName: 'ast', failureCount: 3 });

    expect(collector.get('guardrail.injection')).toBe(2);
    expect(collector.get('guardrail.bypass')).toBe(1);
    expect(collector.get('circuit.open')).toBe(1);
    expect(collector.get('decomposer.fallback')).toBe(0);
  });

  test('reset() clears all counters', () => {
    const bus = createBus();
    const collector = new MetricsCollector();
    collector.attach(bus);

    bus.emit('guardrail:injection_detected', { field: 'x', patterns: [] });
    bus.emit('circuit:open', { oracleName: 'dep', failureCount: 4 });
    collector.reset();

    expect(collector.get('guardrail.injection')).toBe(0);
    expect(collector.get('circuit.open')).toBe(0);
    expect(Object.keys(collector.getCounters())).toHaveLength(0);
  });

  test('getCounters() returns all accumulated counts', () => {
    const bus = createBus();
    const collector = new MetricsCollector();
    collector.attach(bus);

    bus.emit('oracle:contradiction', { taskId: 't1', passed: ['ast'], failed: ['type'] });
    bus.emit('decomposer:fallback', { taskId: 't1' });

    const counters = collector.getCounters();
    expect(counters['oracle.contradiction']).toBe(1);
    expect(counters['decomposer.fallback']).toBe(1);
  });

  test('detach stops counting', () => {
    const bus = createBus();
    const collector = new MetricsCollector();
    const detach = collector.attach(bus);

    bus.emit('guardrail:bypass_detected', { field: 'x', patterns: [] });
    detach();
    bus.emit('guardrail:bypass_detected', { field: 'x', patterns: [] });

    expect(collector.get('guardrail.bypass')).toBe(1);
  });
});
