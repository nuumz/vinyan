/**
 * SSE — Server-Sent Events for real-time task progress streaming.
 *
 * Subscribes to EventBus, filters by taskId or sessionId, writes
 * text/event-stream format.
 *
 * Two flavors:
 *   - `createSSEStream(bus, taskId?)` — single-task stream, auto-closes
 *     on task:complete. Used by the per-task endpoint and by
 *     POST /sessions/:id/messages with `stream: true`.
 *   - `createSessionSSEStream(bus, sessionId, options?)` — long-lived
 *     session-scoped stream that emits events for ALL tasks that run
 *     under the session, across multiple turns. Does NOT auto-close
 *     on task:complete (the session may host more tasks). Sends
 *     periodic heartbeat comments so clients can detect broken
 *     connections.
 *
 * Source of truth: spec/tdd.md §22.2 (GET /api/v1/tasks/:id/events),
 * docs/design/agent-conversation.md → "Long-lived session-scoped SSE".
 */
import type { BusEventName, VinyanBus } from '../core/bus.ts';

/** Events to forward via SSE (non-sensitive, progress-related). */
const SSE_EVENTS: BusEventName[] = [
  // Task lifecycle
  'task:start',
  'task:complete',
  'task:escalate',
  'task:timeout',
  // Pipeline timing
  'phase:timing',
  'trace:record',
  // Worker / oracle
  'worker:dispatch',
  'worker:complete',
  'worker:error',
  'oracle:verdict',
  'critic:verdict',
  'shadow:complete',
  'skill:match',
  'skill:miss',
  'tools:executed',
  // Agent Conversation: per-turn observability for web/mobile streams
  'agent:session_start',
  'agent:session_end',
  'agent:turn_complete',
  'agent:tool_executed',
  'agent:clarification_requested',
];

interface SSEStreamOptions {
  /** Send heartbeat comments at this interval to keep connection alive. 0 = no heartbeat. */
  heartbeatIntervalMs?: number;
}

/**
 * Create an SSE ReadableStream.
 * - With taskId: per-task stream, auto-closes on task:complete, uses named events.
 * - Without taskId: global stream, stays open, uses data-only format (for EventSource.onmessage).
 */
export function createSSEStream(
  bus: VinyanBus,
  taskId?: string,
  options?: SSEStreamOptions,
): { stream: ReadableStream; cleanup: () => void } {
  const unsubscribers: Array<() => void> = [];
  let controller: ReadableStreamDefaultController | null = null;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let closed = false;
  const encoder = new TextEncoder();
  const isGlobal = !taskId;

  const stream = new ReadableStream({
    start(ctrl) {
      controller = ctrl;

      // Heartbeat to keep proxies/browsers from dropping idle connections
      const hbMs = options?.heartbeatIntervalMs;
      if (hbMs && hbMs > 0) {
        heartbeatTimer = setInterval(() => {
          if (closed) return;
          try {
            controller?.enqueue(encoder.encode(`:heartbeat ${Date.now()}\n\n`));
          } catch { /* closed */ }
        }, hbMs);
      }

      for (const eventName of SSE_EVENTS) {
        const unsub = bus.on(eventName, (payload: unknown) => {
          if (closed) return;
          // Filter by taskId if the payload has one
          const p = payload as Record<string, unknown>;
          const eventTaskId =
            p.taskId ??
            (p.input as Record<string, unknown> | undefined)?.id ??
            (p.result as Record<string, unknown> | undefined)?.id;
          if (eventTaskId && taskId && eventTaskId !== taskId) return;

          try {
            const data = JSON.stringify({ event: eventName, payload, ts: Date.now() });
            if (isGlobal) {
              // Global stream: data-only so EventSource.onmessage receives it
              controller?.enqueue(encoder.encode(`data: ${data}\n\n`));
            } else {
              // Per-task stream: named events
              controller?.enqueue(encoder.encode(`event: ${eventName}\ndata: ${data}\n\n`));
            }

            // Auto-close only for per-task streams
            if (eventName === 'task:complete' && taskId) {
              closed = true;
              if (heartbeatTimer) clearInterval(heartbeatTimer);
              controller?.close();
            }
          } catch {
            // Stream may be closed — ignore
          }
        });
        unsubscribers.push(unsub);
      }
    },
    cancel() {
      closed = true;
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      for (const unsub of unsubscribers) unsub();
    },
  });

  const cleanup = () => {
    closed = true;
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    for (const unsub of unsubscribers) unsub();
    try {
      controller?.close();
    } catch {
      /* already closed */
    }
  };

  return { stream, cleanup };
}

// ── Long-lived session-scoped stream (PR #10) ──────────────────────

export interface SessionSSEOptions {
  /**
   * How often to emit a heartbeat comment line (`:heartbeat\n\n`) so
   * clients can detect broken connections even while no events flow.
   * Default: 30 seconds. Heartbeats are SSE comments (ignored by the
   * EventSource parser) so they do not produce `onmessage` events
   * on the client.
   */
  heartbeatIntervalMs?: number;
}

/**
 * Create a long-lived SSE stream scoped to a session id. Unlike
 * `createSSEStream`, this does NOT auto-close on a single
 * `task:complete` — the session may host more tasks across multiple
 * turns, and the client wants to see all of them over one connection.
 *
 * Session membership:
 *   - Every `task:start` event carries `payload.input.sessionId` (set
 *     by the API layer when POSTing `/messages`). If it matches the
 *     requested sessionId, we add the task id to an in-memory
 *     membership set and forward the event.
 *   - All subsequent per-task events (task:complete, phase:timing,
 *     agent:turn_complete, agent:tool_executed, agent:clarification_requested,
 *     trace:record, etc.) are filtered by taskId membership in that
 *     set.
 *   - Tasks from OTHER sessions are dropped.
 *
 * The stream stays open until the client disconnects OR the caller
 * invokes `cleanup()`. Heartbeat comments fire on a configurable
 * interval (default 30 seconds).
 *
 * A6 note: SSE is advisory, not a governance surface. Streaming events
 * to a client does not bypass any axioms — the events are observable
 * by construction (they flow through the same bus that the orchestrator
 * uses internally).
 */
export function createSessionSSEStream(
  bus: VinyanBus,
  sessionId: string,
  options: SessionSSEOptions = {},
): { stream: ReadableStream; cleanup: () => void } {
  const heartbeatIntervalMs = options.heartbeatIntervalMs ?? 30_000;
  const sessionTaskIds = new Set<string>();
  const unsubscribers: Array<() => void> = [];
  let controller: ReadableStreamDefaultController | null = null;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let closed = false;

  const encoder = new TextEncoder();
  const emit = (eventName: string, payload: unknown) => {
    if (closed) return;
    try {
      const data = JSON.stringify({ event: eventName, payload, ts: Date.now() });
      controller?.enqueue(encoder.encode(`event: ${eventName}\ndata: ${data}\n\n`));
    } catch {
      // Stream may be closed — ignore
    }
  };

  const stream = new ReadableStream({
    start(ctrl) {
      controller = ctrl;

      // Subscribe to task:start separately because this is the
      // membership-tracking gate — we learn which task ids belong
      // to our session from this event's payload.input.sessionId.
      const unsubStart = bus.on('task:start', (payload: unknown) => {
        const p = payload as Record<string, unknown>;
        const inputObj = p.input as Record<string, unknown> | undefined;
        const taskId = inputObj?.id as string | undefined;
        const incomingSessionId = inputObj?.sessionId as string | undefined;
        if (!taskId || incomingSessionId !== sessionId) return;
        sessionTaskIds.add(taskId);
        emit('task:start', payload);
      });
      unsubscribers.push(unsubStart);

      // Subscribe to all remaining session-relevant events. Each is
      // filtered by taskId membership in the set we built from
      // task:start above. We intentionally skip 'task:start' in this
      // list to avoid double-emitting it.
      const membershipFilteredEvents: BusEventName[] = [
        'task:complete',
        'task:escalate',
        'task:timeout',
        'phase:timing',
        'trace:record',
        'worker:dispatch',
        'worker:complete',
        'worker:error',
        'oracle:verdict',
        'critic:verdict',
        'shadow:complete',
        'skill:match',
        'skill:miss',
        'tools:executed',
        'agent:session_start',
        'agent:session_end',
        'agent:turn_complete',
        'agent:tool_executed',
        'agent:clarification_requested',
      ];

      for (const eventName of membershipFilteredEvents) {
        const unsub = bus.on(eventName, (payload: unknown) => {
          const p = payload as Record<string, unknown>;
          // Extract taskId from common payload shapes (matches
          // createSSEStream's extraction logic).
          const eventTaskId =
            (p.taskId as string | undefined) ??
            ((p.input as Record<string, unknown> | undefined)?.id as string | undefined) ??
            ((p.result as Record<string, unknown> | undefined)?.id as string | undefined);
          if (!eventTaskId || !sessionTaskIds.has(eventTaskId)) return;
          emit(eventName, payload);
          // Do NOT close on task:complete — a session may host more
          // tasks across turns. The stream closes only when the
          // client disconnects or cleanup() is called.
        });
        unsubscribers.push(unsub);
      }

      // Heartbeat comments keep idle connections alive and give clients
      // a reliable "connection is healthy" signal when no real events
      // are flowing between turns. SSE comment lines start with `:` and
      // are ignored by the EventSource API, so they do not fire
      // `onmessage` handlers.
      heartbeatTimer = setInterval(() => {
        if (closed) return;
        try {
          controller?.enqueue(encoder.encode(`: heartbeat ${Date.now()}\n\n`));
        } catch {
          // Stream may be closed — clear the timer.
          if (heartbeatTimer) {
            clearInterval(heartbeatTimer);
            heartbeatTimer = null;
          }
        }
      }, heartbeatIntervalMs);

      // Emit an initial `session:stream_open` event so clients know
      // the subscription is live before any task events arrive.
      try {
        controller.enqueue(
          encoder.encode(
            `event: session:stream_open\ndata: ${JSON.stringify({
              event: 'session:stream_open',
              payload: { sessionId, heartbeatIntervalMs },
              ts: Date.now(),
            })}\n\n`,
          ),
        );
      } catch {
        /* ignore */
      }
    },
    cancel() {
      closed = true;
      for (const unsub of unsubscribers) unsub();
      if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
      }
    },
  });

  const cleanup = () => {
    closed = true;
    for (const unsub of unsubscribers) unsub();
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
    try {
      controller?.close();
    } catch {
      /* already closed */
    }
  };

  return { stream, cleanup };
}
