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
import { lookupManifestEntry, RECORDED_EVENTS } from '../../api/event-manifest.ts';
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
  parentTaskId?: string;
  eventType: string;
  payload: unknown;
  ts: number;
}

const DEFAULT_BUFFER_LIMIT = 256;
const DEFAULT_FLUSH_MS = 250;
const DEFAULT_MAX_STRING = 8 * 1024;
/**
 * Bounded cache so a long-running orchestrator with many tasks can't grow
 * the sessionId map without limit. The cache is only used to backfill
 * `sessionId` on events that omit it — losing an old entry just degrades
 * those events back to `session_id=NULL`, which is a recoverable failure
 * not a correctness one.
 */
const SESSION_CACHE_LIMIT = 4096;
/**
 * Token-level / streaming events that are dropped first when the buffer
 * is full. Lifecycle events (task:*, workflow:*, agent:plan_update,
 * oracle:*, critic:*, skill:*, agent:routed/synthesized, etc.) carry
 * irreplaceable structural state — without them the historical-process
 * card can't reconstruct a plan checklist or sub-agent timeline. Stream
 * deltas can be lost without breaking replay because the final answer
 * is also stored on the assistant turn.
 */
const LOW_PRIORITY_EVENTS = new Set<string>([
  'llm:stream_delta',
  'agent:text_delta',
  'agent:thinking',
  'coding-cli:output_delta',
]);

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
  // taskId → sessionId cache. Many emitters (workflow-executor,
  // agent-loop sub-paths) don't include `sessionId` in every payload —
  // without backfill those rows persist as `session_id=NULL` and the
  // task-tree query at `/tasks/:id/event-history?includeDescendants=true`
  // (which filters by session_id) silently drops them. The first event
  // for a task is always `task:start` whose `input.sessionId` populates
  // the cache, so subsequent events for the same task get backfilled.
  const sessionByTask = new Map<string, string>();
  // Phase 2.6: taskId → parentTaskId cache mirroring the sessionByTask
  // pattern. Seeded by `task:start.input.parentTaskId` for sub-tasks
  // (root tasks have no parent). Subsequent events for the sub-task
  // inherit the parent id, populating the new `parent_task_id` column
  // that backs the O(index) `listChildTaskIds`.
  const parentByTask = new Map<string, string>();

  const flush = () => {
    if (buffer.length === 0) return;
    const batch = buffer;
    buffer = [];
    try {
      store.appendBatch(
        batch.map((e) => ({
          taskId: e.taskId,
          sessionId: e.sessionId,
          parentTaskId: e.parentTaskId,
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
        // Defense-in-depth: the manifest contract test asserts every
        // recordable event is task-scoped, but the test runs after the
        // merge — short-circuit here so a buggy `record: true` on a
        // session/global-scope entry can't silently fill the DB with
        // rows that have no taskId to query by.
        const manifestEntry = lookupManifestEntry(eventName);
        if (manifestEntry && manifestEntry.scope !== 'task') return;
        const ids = extractIds(rawPayload);
        if (!ids.taskId) return; // Skip events that can't be associated with a task.
        // Backfill sessionId from the per-task cache when payload omits
        // it. Cache is populated whenever an event arrives WITH sessionId
        // (typically `task:start`), so subsequent task-scoped events for
        // the same task inherit the right session_id even if the emitter
        // didn't include it. Without this, ~half the recorded events
        // land with session_id=NULL and the task-tree query filters them
        // out on read.
        let sessionId = ids.sessionId;
        if (sessionId) {
          // Bounded cache — evict oldest entry on overflow when adding a
          // new task. Map iteration order is insertion order, so the
          // first key is the oldest seen.
          if (sessionByTask.size >= SESSION_CACHE_LIMIT && !sessionByTask.has(ids.taskId)) {
            const oldest = sessionByTask.keys().next().value;
            if (oldest !== undefined) sessionByTask.delete(oldest);
          }
          sessionByTask.set(ids.taskId, sessionId);
        } else {
          sessionId = sessionByTask.get(ids.taskId);
        }
        // Phase 2.6: parentTaskId backfill — same LRU pattern as sessionId.
        let parentTaskId = ids.parentTaskId;
        if (parentTaskId) {
          if (parentByTask.size >= SESSION_CACHE_LIMIT && !parentByTask.has(ids.taskId)) {
            const oldest = parentByTask.keys().next().value;
            if (oldest !== undefined) parentByTask.delete(oldest);
          }
          parentByTask.set(ids.taskId, parentTaskId);
        } else {
          parentTaskId = parentByTask.get(ids.taskId);
        }
        const payload = truncatePayload(rawPayload, maxStringChars);
        if (buffer.length >= bufferLimit) {
          // Overflow: drop the oldest LOW-priority (token-level / streaming)
          // event first so lifecycle events survive. If the buffer is fully
          // saturated with high-priority events, fall back to oldest-first
          // FIFO drop — but in practice that only happens on pathologically
          // slow disks, since lifecycle events are sparse compared to stream
          // deltas.
          let evictIdx = -1;
          for (let i = 0; i < buffer.length; i++) {
            if (LOW_PRIORITY_EVENTS.has(buffer[i]!.eventType)) {
              evictIdx = i;
              break;
            }
          }
          if (evictIdx === -1) {
            buffer.shift();
          } else {
            buffer.splice(evictIdx, 1);
          }
          dropped += 1;
        }
        buffer.push({
          taskId: ids.taskId,
          sessionId,
          parentTaskId,
          eventType: eventName,
          payload,
          ts: Date.now(),
        });

        // Sub-task session pre-seed.
        //
        // Closes a race that surfaced as `[no activity captured]` on
        // multi-agent replay cards: when the parent workflow-executor
        // dispatches a delegate it calls `await executeTask(subInput)`,
        // and the inner orchestrator's first event for the sub-task is
        // not always `task:start`. If any sub-task event reaches the
        // recorder before the sub-task's own task:start populates the
        // cache (e.g. an agent-loop tool event from the persona's first
        // tick), that event has no `sessionId` in payload, the cache
        // lookup by sub-task id misses, and the row persists with
        // `session_id=NULL`. The replay endpoint
        // (`/tasks/:id/event-history?includeDescendants=true`) then
        // applies `AND session_id = ?` against the parent's session and
        // silently drops every sub-task event for that delegate —
        // showing a DONE row with no tool history and no output.
        //
        // Pre-seeding the sub-task → parent-session mapping the moment
        // `workflow:delegate_dispatched` is recorded means subsequent
        // sub-task events that omit sessionId still backfill correctly,
        // regardless of which inner-loop branch emits first. Honors the
        // existing LRU eviction so the cache cannot grow unbounded under
        // long-running orchestrators.
        if (eventName === 'workflow:delegate_dispatched' && sessionId) {
          const rawPayloadObj = rawPayload as Record<string, unknown> | null;
          const subTaskId =
            rawPayloadObj && typeof rawPayloadObj.subTaskId === 'string'
              ? (rawPayloadObj.subTaskId as string)
              : undefined;
          if (subTaskId && subTaskId.length > 0 && !sessionByTask.has(subTaskId)) {
            if (sessionByTask.size >= SESSION_CACHE_LIMIT) {
              const oldest = sessionByTask.keys().next().value;
              if (oldest !== undefined) sessionByTask.delete(oldest);
            }
            sessionByTask.set(subTaskId, sessionId);
          }
          // Phase 2.6: pre-seed parentByTask so the sub-task's first event
          // (which may arrive before its own task:start) lands with the
          // correct parent_task_id. Mirrors the sessionByTask seeding above.
          if (subTaskId && subTaskId.length > 0 && !parentByTask.has(subTaskId)) {
            if (parentByTask.size >= SESSION_CACHE_LIMIT) {
              const oldest = parentByTask.keys().next().value;
              if (oldest !== undefined) parentByTask.delete(oldest);
            }
            parentByTask.set(subTaskId, ids.taskId);
          }
        }
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

function extractIds(payload: unknown): { taskId?: string; sessionId?: string; parentTaskId?: string } {
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
  // Phase 2.6: surface parentTaskId for the parent_task_id column. Only
  // task:start carries it (on `input.parentTaskId`); subsequent events
  // for the same task inherit via the parentByTask cache populated at
  // recorder boundary. `parentTaskId` may also live at the top level
  // (workflow:delegate_dispatched payload threads parent's taskId on
  // `taskId` and the child's id on `subTaskId`; it's NOT what fills the
  // child's parent_task_id — the child's task:start does that via input).
  const parentTaskId =
    (typeof input?.parentTaskId === 'string' ? input.parentTaskId : undefined) ??
    (typeof p.parentTaskId === 'string' ? p.parentTaskId : undefined);
  return { taskId, sessionId, parentTaskId };
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
