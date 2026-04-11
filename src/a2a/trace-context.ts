/**
 * Distributed Tracing — W3C Trace Context compatible cross-instance tracing.
 *
 * Each A2A hop creates a child span. Trace context is embedded in every ECP
 * data part's `trace_context` field (schema defined in ecp-data-part.ts).
 *
 * trust_boundary_crossed = true when vinyan_instance_chain.length > 1.
 *
 * Source of truth: Plan Phase I1
 */

export interface ECPTraceSpan {
  trace_context: {
    trace_id: string;
    span_id: string;
    parent_span_id?: string;
    trace_flags: number;
    vinyan_correlation_id?: string;
    vinyan_confidence_at_entry?: number;
    vinyan_routing_level?: number;
    vinyan_instance_chain?: string[];
  };
  operation: string;
  start_time: number;
  end_time?: number;
  confidence_in: number;
  confidence_out?: number;
  cost?: { tokens_input: number; tokens_output: number; duration_ms: number; oracle_invocations: number };
  trust_boundary_crossed: boolean;
  events: Array<{ name: string; timestamp: number; attributes?: Record<string, unknown> }>;
}

export interface DistributedTracerConfig {
  instanceId: string;
}

function randomHex(bytes: number): string {
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  return [...arr].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export class DistributedTracer {
  private activeSpans = new Map<string, ECPTraceSpan>();

  constructor(private config: DistributedTracerConfig) {}

  startSpan(
    operation: string,
    options?: {
      parentSpanId?: string;
      traceId?: string;
      confidenceAtEntry?: number;
      routingLevel?: number;
      correlationId?: string;
    },
  ): ECPTraceSpan {
    const parentSpan = options?.parentSpanId ? this.activeSpans.get(options.parentSpanId) : undefined;
    const traceId = options?.traceId ?? parentSpan?.trace_context.trace_id ?? randomHex(16);
    const parentChain = parentSpan?.trace_context.vinyan_instance_chain ?? [];
    const instanceChain = parentChain.includes(this.config.instanceId)
      ? [...parentChain]
      : [...parentChain, this.config.instanceId];

    const span: ECPTraceSpan = {
      trace_context: {
        trace_id: traceId,
        span_id: randomHex(8),
        parent_span_id: options?.parentSpanId,
        trace_flags: 0x01, // sampled
        vinyan_correlation_id: options?.correlationId,
        vinyan_confidence_at_entry: options?.confidenceAtEntry,
        vinyan_routing_level: options?.routingLevel,
        vinyan_instance_chain: instanceChain,
      },
      operation,
      start_time: Date.now(),
      confidence_in: options?.confidenceAtEntry ?? 0,
      trust_boundary_crossed: instanceChain.length > 1,
      events: [],
    };

    this.activeSpans.set(span.trace_context.span_id, span);
    return span;
  }

  endSpan(spanId: string, options?: { confidenceOut?: number; cost?: ECPTraceSpan['cost'] }): ECPTraceSpan | null {
    const span = this.activeSpans.get(spanId);
    if (!span) return null;

    span.end_time = Date.now();
    span.confidence_out = options?.confidenceOut;
    span.cost = options?.cost;
    this.activeSpans.delete(spanId);
    return span;
  }

  addEvent(spanId: string, name: string, attributes?: Record<string, unknown>): void {
    const span = this.activeSpans.get(spanId);
    if (!span) return;
    span.events.push({ name, timestamp: Date.now(), attributes });
  }

  inject(span: ECPTraceSpan): Record<string, string> {
    const { trace_id, span_id, trace_flags } = span.trace_context;
    const flagsHex = trace_flags.toString(16).padStart(2, '0');
    const traceparent = `00-${trace_id}-${span_id}-${flagsHex}`;

    const stateEntries: string[] = [];
    if (span.trace_context.vinyan_correlation_id) {
      stateEntries.push(`cid=${span.trace_context.vinyan_correlation_id}`);
    }
    if (span.trace_context.vinyan_instance_chain?.length) {
      stateEntries.push(`chain=${span.trace_context.vinyan_instance_chain.join(',')}`);
    }
    const tracestate = stateEntries.length > 0 ? `vinyan=${stateEntries.join(';')}` : '';

    const headers: Record<string, string> = { traceparent };
    if (tracestate) headers.tracestate = tracestate;
    return headers;
  }

  extract(
    headers: Record<string, string | undefined>,
  ): { traceId: string; parentSpanId: string; traceFlags: number } | null {
    const traceparent = headers.traceparent;
    if (!traceparent) return null;

    // W3C traceparent format: {version}-{trace_id}-{parent_id}-{trace_flags}
    const parts = traceparent.split('-');
    if (parts.length !== 4) return null;

    const [version, traceId, parentSpanId, flagsHex] = parts as [string, string, string, string];
    if (version !== '00') return null;
    if (traceId.length !== 32 || parentSpanId.length !== 16) return null;

    const traceFlags = parseInt(flagsHex, 16);
    if (Number.isNaN(traceFlags)) return null;

    return { traceId, parentSpanId, traceFlags };
  }

  getActiveSpan(spanId: string): ECPTraceSpan | undefined {
    return this.activeSpans.get(spanId);
  }

  getActiveSpans(): ECPTraceSpan[] {
    return [...this.activeSpans.values()];
  }
}
