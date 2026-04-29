/**
 * TaskEventRecorder — durable accumulator that mirrors the SSE event firehose
 * into the `task_events` table. Subscribes once to the bus and batches writes
 * so historical replay (after page reload, scrollback into past turns) can
 * reconstruct the per-turn process timeline that the UI shows live today.
 *
 * Design constraints:
 *   - Allow-list is derived from the single event delivery manifest
 *     (`src/api/event-manifest.ts`); SSE forwarding and durable
 *     recording stay in sync because they read the same source. No
 *     shadow/economy/sleep events bloat the DB unless flagged
 *     `record: true` in the manifest.
 *   - Append-only, write-behind. The bus must NOT block on DB pressure — we
 *     buffer in memory and flush on a timer or buffer-full trigger.
 *   - Bounded buffer. If the writer falls behind (DB on slow disk, sleep
 *     cycle holding a write lock), oldest in-buffer events are dropped FIFO
 *     and a counter is bumped — never throw, never crash the bus.
 *   - taskId is required for persistence (the contract test enforces
 *     that every recordable event declares it on its payload). Events
 *     missing taskId are dropped defensively; the manifest scope flag
 *     is what keeps non-task events out of the recordable set.
 *
 * Wired in `src/orchestrator/factory.ts` alongside `attachAuditListener`.
 * Returns a `detach()` function that flushes the buffer and unsubscribes.
 */
import { RECORDED_EVENTS } from '../../api/event-manifest.ts';
import type { VinyanBus } from '../../core/bus.ts';
import type { TaskEventStore } from '../../db/task-event-store.ts';

// `RECORDED_EVENTS` is generated from the single delivery manifest in
// `src/api/event-manifest.ts`. To make a new event historically replayable,
// add `record: true` to its row there. The contract test will fail if a
// recordable event lacks `taskId` in its declared payload — without that
// the recorder skips persistence (see extractIds + the !ids.taskId guard).
export { RECORDED_EVENTS };

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
