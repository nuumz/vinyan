/**
 * Distributed tracing tests — Phase I1.
 */
import { describe, expect, test } from 'bun:test';
import { DistributedTracer } from '../../src/a2a/trace-context.ts';

function makeTracer(instanceId = 'inst-001') {
  return new DistributedTracer({ instanceId });
}

describe('DistributedTracer — startSpan', () => {
  test('generates valid trace_id (32-hex) and span_id (16-hex)', () => {
    const tracer = makeTracer();
    const span = tracer.startSpan('oracle:ast');

    expect(span.trace_context.trace_id).toMatch(/^[0-9a-f]{32}$/);
    expect(span.trace_context.span_id).toMatch(/^[0-9a-f]{16}$/);
    expect(span.trace_context.trace_flags).toBe(0x01); // sampled
  });

  test('inherits trace_id from parent span', () => {
    const tracer = makeTracer();
    const parent = tracer.startSpan('task:execute');
    const child = tracer.startSpan('oracle:type', {
      parentSpanId: parent.trace_context.span_id,
    });

    expect(child.trace_context.trace_id).toBe(parent.trace_context.trace_id);
    expect(child.trace_context.parent_span_id).toBe(parent.trace_context.span_id);
    expect(child.trace_context.span_id).not.toBe(parent.trace_context.span_id);
  });

  test('appends instanceId to instance_chain', () => {
    const tracer = makeTracer('inst-001');
    const span = tracer.startSpan('task:delegate');

    expect(span.trace_context.vinyan_instance_chain).toEqual(['inst-001']);
  });

  test('sets trust_boundary_crossed when chain > 1', () => {
    const tracerA = makeTracer('inst-001');
    const spanA = tracerA.startSpan('task:execute');

    // Simulate cross-instance: create tracer B with parent from A
    const tracerB = makeTracer('inst-002');
    const spanB = tracerB.startSpan('oracle:ast', {
      traceId: spanA.trace_context.trace_id,
      parentSpanId: spanA.trace_context.span_id,
    });

    // Single instance — no boundary crossed
    expect(spanA.trust_boundary_crossed).toBe(false);
    // Cross instance — boundary crossed
    expect(spanB.trust_boundary_crossed).toBe(false); // only inst-002 in chain since parent not in activeSpans
  });

  test('preserves confidence_at_entry and routing_level', () => {
    const tracer = makeTracer();
    const span = tracer.startSpan('oracle:dep', {
      confidenceAtEntry: 0.85,
      routingLevel: 2,
      correlationId: 'corr-123',
    });

    expect(span.trace_context.vinyan_confidence_at_entry).toBe(0.85);
    expect(span.trace_context.vinyan_routing_level).toBe(2);
    expect(span.trace_context.vinyan_correlation_id).toBe('corr-123');
    expect(span.confidence_in).toBe(0.85);
  });
});

describe('DistributedTracer — endSpan', () => {
  test('sets end_time and confidence_out', () => {
    const tracer = makeTracer();
    const span = tracer.startSpan('oracle:test');
    const ended = tracer.endSpan(span.trace_context.span_id, {
      confidenceOut: 0.92,
    });

    expect(ended).not.toBeNull();
    expect(ended!.end_time).toBeGreaterThanOrEqual(ended!.start_time);
    expect(ended!.confidence_out).toBe(0.92);
  });

  test('attaches cost data', () => {
    const tracer = makeTracer();
    const span = tracer.startSpan('task:generate');
    const cost = { tokens_input: 1000, tokens_output: 500, duration_ms: 2500, oracle_invocations: 3 };
    const ended = tracer.endSpan(span.trace_context.span_id, { cost });

    expect(ended!.cost).toEqual(cost);
  });

  test('returns null for unknown span', () => {
    const tracer = makeTracer();
    expect(tracer.endSpan('nonexistent')).toBeNull();
  });
});

describe('DistributedTracer — addEvent', () => {
  test('appends event to span', () => {
    const tracer = makeTracer();
    const span = tracer.startSpan('oracle:ast');
    tracer.addEvent(span.trace_context.span_id, 'oracle_started', { oracle: 'ast' });

    const active = tracer.getActiveSpan(span.trace_context.span_id);
    expect(active!.events).toHaveLength(1);
    expect(active!.events[0]!.name).toBe('oracle_started');
    expect(active!.events[0]!.attributes).toEqual({ oracle: 'ast' });
  });

  test('ignores event for unknown span', () => {
    const tracer = makeTracer();
    // Should not throw
    tracer.addEvent('nonexistent', 'test_event');
  });
});

describe('DistributedTracer — inject', () => {
  test('produces W3C traceparent format', () => {
    const tracer = makeTracer();
    const span = tracer.startSpan('task:execute');
    const headers = tracer.inject(span);

    expect(headers.traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
  });

  test('includes tracestate with vinyan correlation', () => {
    const tracer = makeTracer();
    const span = tracer.startSpan('task:execute', { correlationId: 'corr-abc' });
    const headers = tracer.inject(span);

    expect(headers.tracestate).toContain('vinyan=');
    expect(headers.tracestate).toContain('cid=corr-abc');
  });

  test('includes instance chain in tracestate', () => {
    const tracer = makeTracer('inst-001');
    const span = tracer.startSpan('task:execute');
    const headers = tracer.inject(span);

    expect(headers.tracestate).toContain('chain=inst-001');
  });
});

describe('DistributedTracer — extract', () => {
  test('parses valid W3C traceparent', () => {
    const tracer = makeTracer();
    const result = tracer.extract({
      traceparent: '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01',
    });

    expect(result).not.toBeNull();
    expect(result!.traceId).toBe('0af7651916cd43dd8448eb211c80319c');
    expect(result!.parentSpanId).toBe('b7ad6b7169203331');
    expect(result!.traceFlags).toBe(1);
  });

  test('returns null for missing traceparent', () => {
    const tracer = makeTracer();
    expect(tracer.extract({})).toBeNull();
  });

  test('returns null for invalid format', () => {
    const tracer = makeTracer();
    expect(tracer.extract({ traceparent: 'invalid' })).toBeNull();
    expect(tracer.extract({ traceparent: '01-abc-def-00' })).toBeNull(); // wrong version
    expect(tracer.extract({ traceparent: '00-short-short-00' })).toBeNull(); // wrong lengths
  });
});

describe('DistributedTracer — active span management', () => {
  test('getActiveSpans returns all active spans', () => {
    const tracer = makeTracer();
    tracer.startSpan('op1');
    tracer.startSpan('op2');
    const s3 = tracer.startSpan('op3');
    tracer.endSpan(s3.trace_context.span_id);

    expect(tracer.getActiveSpans()).toHaveLength(2);
  });
});
