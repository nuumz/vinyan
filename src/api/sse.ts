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
  'task:stage_update',
  'task:approval_required',
  'task:retry_requested',
  // Pipeline timing
  'phase:timing',
  'trace:record',
  'grounding:checked',
  'degradation:triggered',
  // Worker / oracle
  'worker:dispatch',
  'worker:selected',
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
  'agent:tool_started',
  'agent:tool_executed',
  'agent:tool_denied',
  'agent:text_delta',
  'agent:thinking',
  'agent:contract_violation',
  'agent:plan_update',
  'llm:stream_delta',
  'agent:clarification_requested',
  // Capability-first observability — surfaces the orchestrator's routing,
  // synthesis, and knowledge-acquisition decisions so the chat UI can render
  // a chronological process timeline ("Routed to X", "Synthesized agent",
  // "Researched capability Y"). All events are read-only forwards from the
  // EventBus — no new reasoning happens at the SSE layer (A1, A3).
  'agent:routed',
  'agent:synthesized',
  'agent:synthesis-failed',
  'agent:capability-research',
  'agent:capability-research-failed',
  // Phase E: workflow plan approval gate (long-form goals pause for user OK
  // via `workflow:plan_ready` with `awaitingApproval: true`). Without these
  // on the wire, the chat UI can't render the inline approval prompt and the
  // workflow executor times out after `approvalTimeoutMs` (default 600s)
  // returning "Approval timed out after 600000ms" as the synthesized result.
  'workflow:plan_ready',
  'workflow:plan_approved',
  'workflow:plan_rejected',
  // Per-step workflow progress. Lets the chat UI mark which step is running
  // and surface fallback transitions in real time, without having to derive
  // the running step from `agent:plan_update` diffs alone.
  'workflow:step_start',
  'workflow:step_complete',
  'workflow:step_fallback',
  // Phase 0.5: surface guardrail signals through SSE so web/extension
  // clients see input-injection / bypass detections in real time.
  'guardrail:injection_detected',
  'guardrail:bypass_detected',
  // Knowledge surface — keep the operator console live for skills,
  // patterns, evolutionary rules, world-graph facts, sleep cycle.
  'skill:outcome',
  'evolution:rulesApplied',
  'evolution:rulePromoted',
  'evolution:ruleRetired',
  'sleep:cycleComplete',
  'graph:fact',
  // Session lifecycle (create/compact + metadata + archive/delete/restore).
  'session:created',
  'session:compacted',
  'session:updated',
  'session:archived',
  'session:unarchived',
  'session:deleted',
  'session:restored',
  'session:purged',
  // Memory review outcomes (approve/reject of proposals).
  'memory:approved',
  'memory:rejected',
];

interface SSEStreamOptions {
  /** Send heartbeat comments at this interval to keep connection alive. 0 = no heartbeat. */
  heartbeatIntervalMs?: number;
  /**
   * Safety-net cleanup after this many ms. Cleared when the stream
   * cancels normally (client disconnect) or auto-closes on
   * task:complete, so a healthy stream never leaves the timer
   * scheduled. 0 / undefined = no safety-net.
   */
  safetyTimeoutMs?: number;
  /**
   * Fired exactly once when the stream closes for any reason (client
   * cancel, auto-close on task:complete, safety-net, or external
   * cleanup()). Lets the API layer track open streams so it can
   * detach bus listeners deterministically during shutdown.
   */
  onClose?: () => void;
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
  let safetyTimer: ReturnType<typeof setTimeout> | null = null;
  let closed = false;
  const encoder = new TextEncoder();
  const isGlobal = !taskId;

  const cleanup = () => {
    if (closed) return;
    closed = true;
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
    if (safetyTimer) {
      clearTimeout(safetyTimer);
      safetyTimer = null;
    }
    for (const unsub of unsubscribers) unsub();
    try {
      controller?.close();
    } catch {
      /* already closed */
    }
    try {
      options?.onClose?.();
    } catch {
      /* never propagate user-callback errors into stream teardown */
    }
  };

  const stream = new ReadableStream({
    start(ctrl) {
      controller = ctrl;

      // Heartbeat to keep proxies/browsers from dropping idle connections.
      // Send one immediately so the client + proxy see bytes on the wire
      // before any server-side idle timeout can fire.
      const hbMs = options?.heartbeatIntervalMs;
      if (hbMs && hbMs > 0) {
        try {
          controller.enqueue(encoder.encode(`:heartbeat ${Date.now()}\n\n`));
        } catch {
          /* closed */
        }
        heartbeatTimer = setInterval(() => {
          if (closed) return;
          try {
            controller?.enqueue(encoder.encode(`:heartbeat ${Date.now()}\n\n`));
          } catch {
            /* closed */
          }
        }, hbMs);
        // Heartbeats must not keep the Node event loop alive on their own —
        // when the server shuts down, we want the process to be free to exit.
        (heartbeatTimer as { unref?: () => void }).unref?.();
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

            // Auto-close only for per-task streams. Funnel through
            // cleanup() so onClose fires and bus listeners detach.
            if (eventName === 'task:complete' && taskId) {
              cleanup();
            }
          } catch {
            // Stream may be closed — ignore
          }
        });
        unsubscribers.push(unsub);
      }

      // Safety-net: if neither task:complete nor client cancel arrives,
      // force cleanup after the configured bound. Cleared on cancel /
      // auto-close / explicit cleanup() so a healthy stream never leaves
      // the timer scheduled.
      const safetyMs = options?.safetyTimeoutMs;
      if (safetyMs && safetyMs > 0) {
        safetyTimer = setTimeout(() => {
          safetyTimer = null;
          cleanup();
        }, safetyMs);
        (safetyTimer as { unref?: () => void }).unref?.();
      }
    },
    cancel() {
      // Bun fires cancel() on client disconnect — route through cleanup
      // so bus listeners detach and onClose fires.
      cleanup();
    },
  });

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
  /**
   * Safety-net cleanup after this many ms. Cleared on stream cancel so
   * a healthy long-lived connection does not leave the timer scheduled.
   */
  safetyTimeoutMs?: number;
  /**
   * Maximum membership-set size. Long-lived session streams accumulate
   * task ids over time; capping with FIFO eviction prevents unbounded
   * growth. Default: 5000 (≈ months of normal session activity).
   */
  maxTrackedTaskIds?: number;
  /** See `SSEStreamOptions.onClose`. */
  onClose?: () => void;
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
  const maxTrackedTaskIds = options.maxTrackedTaskIds ?? 5000;
  const sessionTaskIds = new Set<string>();
  const unsubscribers: Array<() => void> = [];
  let controller: ReadableStreamDefaultController | null = null;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let safetyTimer: ReturnType<typeof setTimeout> | null = null;
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

  const cleanup = () => {
    if (closed) return;
    closed = true;
    for (const unsub of unsubscribers) unsub();
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
    if (safetyTimer) {
      clearTimeout(safetyTimer);
      safetyTimer = null;
    }
    sessionTaskIds.clear();
    try {
      controller?.close();
    } catch {
      /* already closed */
    }
    try {
      options.onClose?.();
    } catch {
      /* never propagate user-callback errors into stream teardown */
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
        // FIFO eviction — Set preserves insertion order; drop oldest
        // when we exceed the bound. Late events for evicted task ids
        // will simply be filtered out by the membership check.
        if (sessionTaskIds.size > maxTrackedTaskIds) {
          const oldest = sessionTaskIds.values().next().value;
          if (oldest !== undefined) sessionTaskIds.delete(oldest);
        }
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
        'agent:tool_started',
        'agent:tool_executed',
        'agent:text_delta',
        'llm:stream_delta',
        'agent:clarification_requested',
        'agent:plan_update',
        // Capability-first observability (see SSE_EVENTS comment above).
        'agent:routed',
        'agent:synthesized',
        'agent:synthesis-failed',
        'agent:capability-research',
        'agent:capability-research-failed',
        // Phase E: workflow approval gate — these all carry `taskId` so they
        // pass the membership filter built from `task:start` above.
        'workflow:plan_ready',
        'workflow:plan_approved',
        'workflow:plan_rejected',
      ];
      // Per-step workflow events do NOT carry `taskId` in their payload (only
      // `stepId`). Forward them unconditionally for the active session — when
      // multiple workflow tasks run concurrently in one session this is
      // imprecise, but the chat UI is single-task-per-session in practice and
      // dropping these would mean the plan checklist freezes mid-run.
      const unconditionalStepEvents: BusEventName[] = [
        'workflow:step_start',
        'workflow:step_complete',
        'workflow:step_fallback',
      ];
      for (const eventName of unconditionalStepEvents) {
        const unsub = bus.on(eventName, (payload: unknown) => {
          emit(eventName, payload);
        });
        unsubscribers.push(unsub);
      }

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
      // Heartbeats must not keep the Node event loop alive on their own.
      (heartbeatTimer as { unref?: () => void }).unref?.();

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

      // Safety-net cleanup. Cleared on cancel so a normal client
      // disconnect does not leave the timer scheduled.
      const safetyMs = options.safetyTimeoutMs;
      if (safetyMs && safetyMs > 0) {
        safetyTimer = setTimeout(() => {
          safetyTimer = null;
          cleanup();
        }, safetyMs);
        (safetyTimer as { unref?: () => void }).unref?.();
      }
    },
    cancel() {
      // Bun fires cancel() on client disconnect — route through cleanup
      // so bus listeners detach and onClose fires for the API tracker.
      cleanup();
    },
  });

  return { stream, cleanup };
}
