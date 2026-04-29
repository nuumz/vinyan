/**
 * TaskEventRecorder — durable accumulator that mirrors the SSE event firehose
 * into the `task_events` table. Subscribes once to the bus and batches writes
 * so historical replay (after page reload, scrollback into past turns) can
 * reconstruct the per-turn process timeline that the UI shows live today.
 *
 * Design constraints:
 *   - Allow-list curated to match `SSE_EVENTS` (`src/api/sse.ts`). No internal
 *     shadow/economy/sleep events that would bloat the DB without UI value.
 *   - Append-only, write-behind. The bus must NOT block on DB pressure — we
 *     buffer in memory and flush on a timer or buffer-full trigger.
 *   - Bounded buffer. If the writer falls behind (DB on slow disk, sleep
 *     cycle holding a write lock), oldest in-buffer events are dropped FIFO
 *     and a counter is bumped — never throw, never crash the bus.
 *   - taskId/sessionId extraction mirrors `createSessionSSEStream`'s logic so
 *     events without a `taskId` (e.g. `workflow:step_*`) flow through with
 *     `taskId='__session'` style keys for session-scoped events; recorder
 *     skips persistence for events missing both ids (defensive).
 *
 * Wired in `src/orchestrator/factory.ts` alongside `attachAuditListener`.
 * Returns a `detach()` function that flushes the buffer and unsubscribes.
 */
import type { BusEventName, VinyanBus } from '../../core/bus.ts';
import type { TaskEventStore } from '../../db/task-event-store.ts';

/** Curated list of bus events worth persisting for historical UI replay. */
export const RECORDED_EVENTS: BusEventName[] = [
  // Pipeline timing
  'phase:timing',
  // Worker / oracle / critic / shadow
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
  // Agent Conversation: per-turn observability surfaced live in the UI
  'agent:turn_complete',
  'agent:tool_started',
  'agent:tool_executed',
  'agent:tool_denied',
  'agent:text_delta',
  'agent:thinking',
  'agent:contract_violation',
  'agent:plan_update',
  'agent:clarification_requested',
  'llm:stream_delta',
  // Capability-first observability — process timeline cards
  'agent:routed',
  'agent:synthesized',
  'agent:synthesis-failed',
  'agent:capability-research',
  'agent:capability-research-failed',
  // Workflow gate + step transitions
  'workflow:plan_ready',
  'workflow:plan_approved',
  'workflow:plan_rejected',
  'workflow:step_start',
  'workflow:step_complete',
  'workflow:step_fallback',
  // Multi-agent UI surface — needed so AgentTimelineCard can replay
  // per-sub-agent dispatch + completion (incl. agentId + outputPreview)
  // when the user opens an old session. Without persistence these events
  // are live-only and the historical card has no way to reconstruct the
  // per-agent answers.
  'workflow:delegate_dispatched',
  'workflow:delegate_completed',
  'workflow:delegate_timeout',
  // Synthesis safety-net observability — persisted as raw timeline annotations
  // so operators can audit quiet failure recoveries (LLM output compressed and
  // overridden; planner output sanitized) in the per-task history. The
  // historical card renders them as generic annotations, not distinct UI cards.
  'workflow:synthesizer_compression_detected',
  'workflow:planner_validation_warning',
  // Task lifecycle (escalation/timeout — useful for diagnostics, terminal
  // task:complete is intentionally excluded: it carries the full TaskResult
  // which we already persist in execution_traces).
  // `task:start` IS persisted because the historical Process card needs
  // the routing decision (level + model + agentId) to render the same
  // "Routed to X" / "L2 · model" chips that the live bubble shows. Without
  // it, replay of past tasks loses provenance metadata. The reducer already
  // upserts duplicate task:start emits (preliminary `model:'pending'` →
  // refined full-pipeline) so persisting both is safe.
  'task:start',
  'task:escalate',
  'task:timeout',
  'task:stage_update',
];

export interface TaskEventRecorderOptions {
  /** Max in-memory buffer size before forced flush + FIFO drop on overflow. */
  bufferLimit?: number;
  /** Idle flush interval in ms. */
  flushIntervalMs?: number;
  /** Truncate string fields longer than this in payload before persisting. */
  maxStringChars?: number;
}

interface BufferedEvent {
  taskId: string;
  sessionId?: string;
  eventType: string;
  payload: unknown;
  ts: number;
}

const DEFAULT_BUFFER_LIMIT = 256;
const DEFAULT_FLUSH_MS = 250;
const DEFAULT_MAX_STRING = 8 * 1024;

export interface TaskEventRecorderHandle {
  detach: () => void;
  /** Flush the buffer synchronously (test/shutdown helper). */
  flush: () => void;
  /** Number of events dropped due to buffer overflow since attach. */
  droppedCount: () => number;
}

export function attachTaskEventRecorder(
  bus: VinyanBus,
  store: TaskEventStore,
  opts: TaskEventRecorderOptions = {},
): TaskEventRecorderHandle {
  const bufferLimit = opts.bufferLimit ?? DEFAULT_BUFFER_LIMIT;
  const flushIntervalMs = opts.flushIntervalMs ?? DEFAULT_FLUSH_MS;
  const maxStringChars = opts.maxStringChars ?? DEFAULT_MAX_STRING;

  let buffer: BufferedEvent[] = [];
  let dropped = 0;
  let timer: ReturnType<typeof setInterval> | null = null;
  const detachers: Array<() => void> = [];

  const flush = () => {
    if (buffer.length === 0) return;
    const batch = buffer;
    buffer = [];
    try {
      store.appendBatch(
        batch.map((e) => ({
          taskId: e.taskId,
          sessionId: e.sessionId,
          eventType: e.eventType,
          payload: e.payload,
          ts: e.ts,
        })),
      );
    } catch (err) {
      // Persistence is best-effort. Log and drop — never re-buffer indefinitely.
      console.warn('[task-event-recorder] flush failed (best-effort):', err);
    }
  };

  for (const eventName of RECORDED_EVENTS) {
    detachers.push(
      bus.on(eventName, (rawPayload: unknown) => {
        const ids = extractIds(rawPayload);
        if (!ids.taskId) return; // Skip events that can't be associated with a task.
        const payload = truncatePayload(rawPayload, maxStringChars);
        if (buffer.length >= bufferLimit) {
          // Overflow: drop the oldest buffered event so newer signal is preserved.
          buffer.shift();
          dropped += 1;
        }
        buffer.push({
          taskId: ids.taskId,
          sessionId: ids.sessionId,
          eventType: eventName,
          payload,
          ts: Date.now(),
        });
      }),
    );
  }

  timer = setInterval(flush, flushIntervalMs);
  // Don't keep the event loop alive on the recorder timer alone.
  (timer as unknown as { unref?: () => void }).unref?.();

  return {
    detach: () => {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      flush();
      for (const d of detachers) d();
    },
    flush,
    droppedCount: () => dropped,
  };
}

function extractIds(payload: unknown): { taskId?: string; sessionId?: string } {
  if (!payload || typeof payload !== 'object') return {};
  const p = payload as Record<string, unknown>;
  const taskIdDirect = typeof p.taskId === 'string' ? p.taskId : undefined;
  const input = p.input as Record<string, unknown> | undefined;
  const result = p.result as Record<string, unknown> | undefined;
  const trace = result?.trace as Record<string, unknown> | undefined;
  const taskId =
    taskIdDirect ??
    (typeof input?.id === 'string' ? input.id : undefined) ??
    (typeof result?.id === 'string' ? result.id : undefined) ??
    (typeof trace?.taskId === 'string' ? trace.taskId : undefined);
  const sessionId =
    (typeof p.sessionId === 'string' ? p.sessionId : undefined) ??
    (typeof input?.sessionId === 'string' ? input.sessionId : undefined);
  return { taskId, sessionId };
}

/**
 * Defensive truncation — `agent:plan_update` snapshots and `agent:thinking`
 * rationales can run multi-KB. Cap individual string fields at the recorder
 * boundary so a runaway LLM transcript can't bloat the DB. Only top-level and
 * one-level-nested string fields are truncated; the structure is preserved.
 */
function truncatePayload(value: unknown, maxStringChars: number): unknown {
  if (typeof value === 'string') return truncateString(value, maxStringChars);
  if (!value || typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    return value.map((v) => (typeof v === 'string' ? truncateString(v, maxStringChars) : v));
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v === 'string') {
      out[k] = truncateString(v, maxStringChars);
    } else if (Array.isArray(v)) {
      out[k] = v.map((item) => (typeof item === 'string' ? truncateString(item, maxStringChars) : item));
    } else {
      out[k] = v;
    }
  }
  return out;
}

function truncateString(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max)}…[truncated ${s.length - max} chars]`;
}
