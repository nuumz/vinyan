/**
 * ProcessStateReconciler — treats SSE as a fast hint and the persisted
 * event history as the source of truth for UI process state.
 *
 * Background. Vinyan has missed UI-visible bus events more than once
 * (allowlist drift between `SSE_EVENTS` / `RECORDED_EVENTS` /
 * `createSessionSSEStream`'s membership filter). When SSE drops a
 * `workflow:human_input_needed`, the input card never appears; when it
 * drops a `workflow:delegate_completed`, the Sub-agents row stays at
 * PENDING forever. Network jitter, tab sleep, and zombie EventSource
 * connections produce the same result even when the allowlists are
 * correct.
 *
 * Strategy. The reducer that mutates UI state is fed both live SSE events
 * and replayed events from the durable history endpoints. This class is
 * the orchestration layer: it tracks the last cursor per session/task,
 * fetches deltas from the backend, dedupes by event id, and feeds them
 * through the same `applyEvent` reducer the UI uses live. Because every
 * UI-visible event now carries `taskId` (contract test enforces it) and
 * is recorded under `record: true` in the manifest, replay parity with
 * SSE is structural — not best-effort.
 *
 * This class is intentionally backend-agnostic — no DOM, no fetch, no
 * React. The hosting environment (a future React hook, the VS Code
 * extension, or a CLI tool) injects the fetchers and the reducer. Tests
 * exercise the orchestration logic directly.
 */
import type { PersistedTaskEvent } from '../db/task-event-store.ts';

export interface ReconcilerEnv {
  /**
   * Fetch persisted events for a task. `since` is a per-task `seq` cursor.
   * Implementations call `GET /api/v1/tasks/:id/event-history?since=<seq>`
   * (see {@link handleTaskEventHistory}).
   */
  fetchTaskHistory: (
    taskId: string,
    since: number | undefined,
  ) => Promise<{ events: PersistedTaskEvent[]; lastSeq: number }>;
  /**
   * Fetch persisted events for a session. `since` is the opaque `<ts>:<id>`
   * token from the previous response. Implementations call
   * `GET /api/v1/sessions/:id/event-history?since=<cursor>` (see
   * {@link handleSessionEventHistory}).
   */
  fetchSessionHistory: (
    sessionId: string,
    since: string | undefined,
  ) => Promise<{ events: PersistedTaskEvent[]; nextCursor?: string }>;
  /**
   * Reducer entry point. Replayed events go through the SAME reducer the
   * live SSE pipeline uses; the reducer must be idempotent (re-applying
   * an already-seen event is a no-op). Idempotency is enforced upstream
   * here too — see {@link Reconciler.seenIds} — so the reducer can rely
   * on never seeing the same `event.id` twice from this orchestrator.
   */
  applyEvent: (event: PersistedTaskEvent) => void;
  /**
   * Optional callback fired when a reconcile is in flight; UIs can show a
   * "syncing process…" indicator without blocking the chat surface.
   */
  onSyncing?: (state: { active: boolean; sessionId?: string; taskId?: string }) => void;
}

export interface ReconcilerOptions {
  /**
   * Bound on the in-memory `seenIds` set. Prevents unbounded growth in
   * long-lived sessions. When the cap is hit, oldest ids are evicted
   * FIFO; a re-fetched event whose id was evicted is harmless because
   * the reducer is idempotent on payload as well as id.
   */
  maxSeenIds?: number;
}

const DEFAULT_MAX_SEEN_IDS = 8_000;

/**
 * Logical "channel" for cursor tracking. Both flavors live in one map so
 * the same cursor is not stored twice for a session that also has a
 * focused task.
 */
type CursorKey = `task:${string}` | `session:${string}`;

/**
 * Pure orchestration. Holds:
 *   - the last fetched cursor per session/task,
 *   - a bounded set of seen event ids for dedupe,
 *   - an in-flight guard so concurrent reconcile calls collapse.
 *
 * No DOM, no setInterval, no fetch — the host environment owns those.
 */
export class ProcessStateReconciler {
  private readonly env: ReconcilerEnv;
  private readonly maxSeenIds: number;
  private readonly cursors = new Map<CursorKey, number | string>();
  private readonly seenIds = new Set<string>();
  private readonly inflight = new Map<CursorKey, Promise<number>>();

  constructor(env: ReconcilerEnv, options: ReconcilerOptions = {}) {
    this.env = env;
    this.maxSeenIds = Math.max(100, options.maxSeenIds ?? DEFAULT_MAX_SEEN_IDS);
  }

  /**
   * Record a live SSE event (with persisted id + cursor) so the next
   * reconcile knows where to start from. Call this from the SSE pipeline
   * BEFORE handing the event to the reducer; if the live event was already
   * applied via reconcile, the reducer never sees it twice.
   *
   * `event.id` is the same `<taskId>-<seq>` shape produced by the recorder,
   * so SSE-vs-replay dedupe collapses cleanly.
   */
  noteLiveEvent(event: PersistedTaskEvent): { duplicate: boolean } {
    const duplicate = this.seenIds.has(event.id);
    if (!duplicate) {
      this.recordSeen(event.id);
      // Advance the per-task cursor so a subsequent reconcile only fetches
      // strictly newer rows. Session cursor is best-effort: if the host
      // hasn't called `reconcileSession` yet, no key exists and the live
      // event simply marks `seenIds`.
      this.cursors.set(`task:${event.taskId}`, event.seq);
    }
    return { duplicate };
  }

  /**
   * Pull missed events for a session and feed them through `applyEvent`.
   * Concurrent calls for the same session collapse onto the in-flight
   * promise — the host can call this freely from `visibilitychange`,
   * SSE reconnect, and post-action hooks without coalescing logic.
   *
   * Returns the number of newly-applied events (excluding duplicates).
   */
  reconcileSession(sessionId: string): Promise<number> {
    const key: CursorKey = `session:${sessionId}`;
    const existing = this.inflight.get(key);
    if (existing) return existing;
    const work = this.runSessionReconcile(sessionId).finally(() => this.inflight.delete(key));
    this.inflight.set(key, work);
    return work;
  }

  /** Pull missed events for a single task. See {@link reconcileSession}. */
  reconcileTask(taskId: string): Promise<number> {
    const key: CursorKey = `task:${taskId}`;
    const existing = this.inflight.get(key);
    if (existing) return existing;
    const work = this.runTaskReconcile(taskId).finally(() => this.inflight.delete(key));
    this.inflight.set(key, work);
    return work;
  }

  /**
   * Drop cursor + dedupe state for a session. Intended for sign-out /
   * session-deleted events. Tasks for that session keep their cursors
   * unless the host calls {@link forgetTask} — they'll just be orphaned
   * and garbage-collected when the host drops its reference.
   */
  forgetSession(sessionId: string): void {
    this.cursors.delete(`session:${sessionId}`);
  }

  forgetTask(taskId: string): void {
    this.cursors.delete(`task:${taskId}`);
  }

  /** Test/inspection helper. */
  getCursor(scope: 'task' | 'session', key: string): number | string | undefined {
    return this.cursors.get(`${scope}:${key}` as CursorKey);
  }

  private async runSessionReconcile(sessionId: string): Promise<number> {
    this.env.onSyncing?.({ active: true, sessionId });
    let applied = 0;
    try {
      // Loop until the page is empty — multi-page replay covers long
      // sessions whose history exceeds the server's per-call cap.
      while (true) {
        const since = this.cursors.get(`session:${sessionId}`) as string | undefined;
        const page = await this.env.fetchSessionHistory(sessionId, since);
        applied += this.applyBatch(page.events);
        if (page.nextCursor) {
          this.cursors.set(`session:${sessionId}`, page.nextCursor);
        }
        if (page.events.length === 0 || !page.nextCursor) break;
      }
    } finally {
      this.env.onSyncing?.({ active: false, sessionId });
    }
    return applied;
  }

  private async runTaskReconcile(taskId: string): Promise<number> {
    this.env.onSyncing?.({ active: true, taskId });
    let applied = 0;
    try {
      while (true) {
        const cursor = this.cursors.get(`task:${taskId}`);
        const since = typeof cursor === 'number' ? cursor + 1 : undefined;
        const page = await this.env.fetchTaskHistory(taskId, since);
        applied += this.applyBatch(page.events);
        // `lastSeq` is the recorder's monotonic per-task counter — store
        // it so the next call asks for `since=lastSeq+1` (strict greater).
        if (page.events.length > 0) {
          this.cursors.set(`task:${taskId}`, page.lastSeq);
        }
        if (page.events.length === 0) break;
      }
    } finally {
      this.env.onSyncing?.({ active: false, taskId });
    }
    return applied;
  }

  private applyBatch(events: PersistedTaskEvent[]): number {
    let applied = 0;
    for (const event of events) {
      if (this.seenIds.has(event.id)) continue;
      this.recordSeen(event.id);
      // Track per-task cursor as we go so a partially-applied page
      // resumes from the right point if the reducer throws midway.
      this.cursors.set(`task:${event.taskId}`, event.seq);
      try {
        this.env.applyEvent(event);
      } catch {
        // Reducer errors must not stall reconciliation — skip the
        // offending event so subsequent ones still apply. The reducer
        // stays the source of truth for what state actually changes;
        // this orchestrator just guarantees delivery.
      }
      applied += 1;
    }
    return applied;
  }

  private recordSeen(id: string): void {
    if (this.seenIds.size >= this.maxSeenIds) {
      // FIFO eviction: Set preserves insertion order.
      const oldest = this.seenIds.values().next().value;
      if (oldest !== undefined) this.seenIds.delete(oldest);
    }
    this.seenIds.add(id);
  }
}
