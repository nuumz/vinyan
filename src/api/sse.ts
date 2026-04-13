/**
 * SSE — Server-Sent Events for real-time task progress streaming.
 *
 * Subscribes to EventBus, filters by taskId, writes text/event-stream format.
 * Source of truth: spec/tdd.md §22.2 (GET /api/v1/tasks/:id/events)
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

/**
 * Create an SSE ReadableStream for a specific task.
 */
export function createSSEStream(bus: VinyanBus, taskId?: string): { stream: ReadableStream; cleanup: () => void } {
  const unsubscribers: Array<() => void> = [];
  let controller: ReadableStreamDefaultController | null = null;

  const stream = new ReadableStream({
    start(ctrl) {
      controller = ctrl;

      for (const eventName of SSE_EVENTS) {
        const unsub = bus.on(eventName, (payload: unknown) => {
          // Filter by taskId if the payload has one
          const p = payload as Record<string, unknown>;
          const eventTaskId =
            p.taskId ??
            (p.input as Record<string, unknown> | undefined)?.id ??
            (p.result as Record<string, unknown> | undefined)?.id;
          if (eventTaskId && eventTaskId !== taskId) return;

          try {
            const data = JSON.stringify({ event: eventName, payload, ts: Date.now() });
            controller?.enqueue(new TextEncoder().encode(`event: ${eventName}\ndata: ${data}\n\n`));

            // Auto-close on task completion
            if (eventName === 'task:complete') {
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
      for (const unsub of unsubscribers) unsub();
    },
  });

  const cleanup = () => {
    for (const unsub of unsubscribers) unsub();
    try {
      controller?.close();
    } catch {
      /* already closed */
    }
  };

  return { stream, cleanup };
}
