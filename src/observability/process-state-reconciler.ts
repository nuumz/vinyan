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
 *
 * Safety nets (review follow-up):
 *   - Reconcile loops cap at `maxPagesPerReconcile` pages so a buggy
 *     server returning the same `nextCursor` can't hang the host.
 *   - The cursor map is bounded (`maxCursors`) — long-lived sessions
 *     with high task churn won't leak.
 *   - Each fetch can be capped by `fetchTimeoutMs`; on timeout the
 *     cycle terminates with `truncated: true` rather than hanging.
 *   - When events were applied, an `onReplayed` callback fires once
 *     per reconcile call — host wires it to `bus.emit('reconciler:replayed', …)`
 *     for dashboards.
 */
import type { PersistedTaskEvent } from '../db/task-event-store.ts';

export interface ReplayedInfo {
  scope: 'task' | 'session';
  scopeId: string;
  appliedCount: number;
  durationMs: number;
  /**
   * True when the reconcile cycle terminated early — page cap reached,
   * fetch timed out, or fetch rejected. Host should treat the cycle as
   * incomplete and may retry.
   */
  truncated: boolean;
}

export interface ReconcilerEnv {
  /**
   * Fetch persisted events for a task. `since` is a per-task `seq` cursor.
   * Implementations call `GET /api/v1/tasks/:id/event-history?since=<seq>`
   * (see `handleTaskEventHistory`).
   */
  fetchTaskHistory: (
    taskId: string,
    since: number | undefined,
  ) => Promise<{ events: PersistedTaskEvent[]; lastSeq: number }>;
  /**
   * Fetch persisted events for a session. `since` is the opaque `<ts>:<id>`
   * token from the previous response. Implementations call
   * `GET /api/v1/sessions/:id/event-history?since=<cursor>` (see
   * `handleSessionEventHistory`).
   */
  fetchSessionHistory: (
    sessionId: string,
    since: string | undefined,
  ) => Promise<{ events: PersistedTaskEvent[]; nextCursor?: string }>;
  /**
   * Reducer entry point. Replayed events go through the SAME reducer the
   * live SSE pipeline uses; the reducer must be idempotent (re-applying
   * an already-seen event is a no-op). Idempotency is enforced upstream
   * here too — see `seenIds` — so the reducer can rely on never seeing
   * the same `event.id` twice from this orchestrator.
   */
  applyEvent: (event: PersistedTaskEvent) => void;
  /**
   * Optional callback fired when a reconcile is in flight; UIs can show a
   * "syncing process…" indicator without blocking the chat surface.
   */
  onSyncing?: (state: { active: boolean; sessionId?: string; taskId?: string }) => void;
  /**
   * Optional callback fired ONCE per reconcile cycle, after the loop
   * completes (or terminates early). Host wires this to
   * `bus.emit('reconciler:replayed', info)` so dashboards / metrics see
   * how often SSE is dropping events. Not invoked for live `ingestLive`
   * paths — only for backend-history-driven reconciles.
   */
  onReplayed?: (info: ReplayedInfo) => void;
}

export interface ReconcilerOptions {
  /**
   * Bound on the in-memory `seenIds` set. Prevents unbounded growth in
   * long-lived sessions. When the cap is hit, oldest ids are evicted
   * FIFO; a re-fetched event whose id was evicted is harmless because
   * the reducer is idempotent on payload as well as id.
   */
  maxSeenIds?: number;
  /**
   * Bound on the cursor tracking map. One entry per task or session
   * the reconciler has touched. Without this cap, long-lived hosts
   * with high task churn would leak slowly. Default: 1000.
   */
  maxCursors?: number;
  /**
   * Hard cap on the number of pages a single reconcile call will fetch
   * before giving up. Defends against a server that returns the same
   * `nextCursor` repeatedly with `events.length > 0` — without this
   * the inner loop hangs. Default: 100 (≈100k events at 1k/page).
   */
  maxPagesPerReconcile?: number;
  /**
   * Per-fetch timeout in ms. When set, each `fetchTaskHistory` /
   * `fetchSessionHistory` call is wrapped in `Promise.race` against
   * this deadline; on timeout, the cycle terminates with
   * `truncated: true`. Default: undefined (no timeout — host owns it).
   */
  fetchTimeoutMs?: number;
}

const DEFAULT_MAX_SEEN_IDS = 8_000;
const DEFAULT_MAX_CURSORS = 1_000;
const DEFAULT_MAX_PAGES = 100;

/**
 * Logical "channel" for cursor tracking. Both flavors live in one map so
 * the same cursor is not stored twice for a session that also has a
 * focused task.
 */
type CursorKey = `task:${string}` | `session:${string}`;

/**
 * Pure orchestration. Holds:
 *   - the last fetched cursor per session/task (bounded LRU),
 *   - a bounded set of seen event ids for dedupe,
 *   - an in-flight guard so concurrent reconcile calls collapse.
 *
 * No DOM, no setInterval, no fetch — the host environment owns those.
 */
export class ProcessStateReconciler {
  private readonly env: ReconcilerEnv;
  private readonly maxSeenIds: number;
  private readonly maxCursors: number;
  private readonly maxPages: number;
  private readonly fetchTimeoutMs: number | undefined;
  private readonly cursors = new Map<CursorKey, number | string>();
  private readonly seenIds = new Set<string>();
  private readonly inflight = new Map<CursorKey, Promise<number>>();

  constructor(env: ReconcilerEnv, options: ReconcilerOptions = {}) {
    this.env = env;
    this.maxSeenIds = Math.max(100, options.maxSeenIds ?? DEFAULT_MAX_SEEN_IDS);
    this.maxCursors = Math.max(50, options.maxCursors ?? DEFAULT_MAX_CURSORS);
    this.maxPages = Math.max(1, options.maxPagesPerReconcile ?? DEFAULT_MAX_PAGES);
    this.fetchTimeoutMs = options.fetchTimeoutMs;
  }

  /**
   * Record AND apply a live SSE event in one step. Returns whether the
   * event was applied or skipped as a duplicate.
   *
   * The host SSE pipeline calls this for every incoming live event
   * BEFORE forwarding to its own reducer pipeline — but it doesn't need
   * to. `ingestLive` already invokes `applyEvent` on the reconciler's
   * env, so the host can replace its live-side reducer dispatch with
   * `reconciler.ingestLive(event)` and get dedupe + reducer dispatch
   * in one call.
   *
   * `event.id` is the same `<taskId>-<seq>` shape produced by the
   * recorder, so SSE-vs-replay dedupe collapses cleanly.
   */
  ingestLive(event: PersistedTaskEvent): { applied: boolean } {
    if (this.seenIds.has(event.id)) return { applied: false };
    this.recordSeen(event.id);
    // Advance the per-task cursor so a subsequent reconcile only fetches
    // strictly newer rows. Session cursor stays best-effort: if the host
    // hasn't called `reconcileSession` yet, no key exists and the live
    // event simply marks `seenIds`.
    this.setCursor(`task:${event.taskId}`, event.seq);
    try {
      this.env.applyEvent(event);
    } catch {
      // Reducer error must not crash the SSE pipeline — same fail-soft
      // contract as `applyBatch`. The event is still marked seen so a
      // subsequent reconcile won't re-apply.
    }
    return { applied: true };
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
   * and garbage-collected when the host drops its reference (or the
   * cursor LRU evicts them).
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

  /** Test/inspection helper — number of cursor entries currently held. */
  cursorCount(): number {
    return this.cursors.size;
  }

  private async runSessionReconcile(sessionId: string): Promise<number> {
    this.env.onSyncing?.({ active: true, sessionId });
    const startedAt = Date.now();
    let applied = 0;
    let truncated = false;
    try {
      for (let pages = 0; pages < this.maxPages; pages += 1) {
        const since = this.cursors.get(`session:${sessionId}`) as string | undefined;
        const fetched = await this.runFetch(() => this.env.fetchSessionHistory(sessionId, since));
        if (fetched === 'timeout') {
          truncated = true;
          break;
        }
        applied += this.applyBatch(fetched.events);
        if (fetched.nextCursor) {
          this.setCursor(`session:${sessionId}`, fetched.nextCursor);
        }
        if (fetched.events.length === 0 || !fetched.nextCursor) break;
        // Page cap will be hit on the next iteration if `pages + 1 ===
        // maxPages` — flag truncated so the host knows the cycle is
        // incomplete.
        if (pages + 1 === this.maxPages) truncated = true;
      }
    } finally {
      this.env.onSyncing?.({ active: false, sessionId });
      this.env.onReplayed?.({
        scope: 'session',
        scopeId: sessionId,
        appliedCount: applied,
        durationMs: Date.now() - startedAt,
        truncated,
      });
    }
    return applied;
  }

  private async runTaskReconcile(taskId: string): Promise<number> {
    this.env.onSyncing?.({ active: true, taskId });
    const startedAt = Date.now();
    let applied = 0;
    let truncated = false;
    try {
      for (let pages = 0; pages < this.maxPages; pages += 1) {
        const cursor = this.cursors.get(`task:${taskId}`);
        const since = typeof cursor === 'number' ? cursor + 1 : undefined;
        const fetched = await this.runFetch(() => this.env.fetchTaskHistory(taskId, since));
        if (fetched === 'timeout') {
          truncated = true;
          break;
        }
        applied += this.applyBatch(fetched.events);
        // `lastSeq` is the recorder's monotonic per-task counter — store
        // it so the next call asks for `since=lastSeq+1` (strict greater).
        if (fetched.events.length > 0) {
          this.setCursor(`task:${taskId}`, fetched.lastSeq);
        }
        if (fetched.events.length === 0) break;
        if (pages + 1 === this.maxPages) truncated = true;
      }
    } finally {
      this.env.onSyncing?.({ active: false, taskId });
      this.env.onReplayed?.({
        scope: 'task',
        scopeId: taskId,
        appliedCount: applied,
        durationMs: Date.now() - startedAt,
        truncated,
      });
    }
    return applied;
  }

  /**
   * Wrap a fetch call in the configured timeout (when set). Returns
   * `'timeout'` instead of rejecting so the caller can break the loop
   * cleanly and emit `truncated: true`. Rejected fetches also map to
   * `'timeout'` for the same reason — the host should retry on the
   * next reconcile call rather than crash this one.
   */
  private async runFetch<T>(call: () => Promise<T>): Promise<T | 'timeout'> {
    const fetchPromise = (async () => call())().catch(() => 'timeout' as const);
    if (this.fetchTimeoutMs === undefined) return fetchPromise;
    const timeoutPromise = new Promise<'timeout'>((resolve) => {
      const t = setTimeout(() => resolve('timeout'), this.fetchTimeoutMs);
      // Heartbeat-style: do not pin the host event loop on this timer.
      (t as unknown as { unref?: () => void }).unref?.();
    });
    return Promise.race([fetchPromise, timeoutPromise]);
  }

  private applyBatch(events: PersistedTaskEvent[]): number {
    let applied = 0;
    for (const event of events) {
      if (this.seenIds.has(event.id)) continue;
      this.recordSeen(event.id);
      // Track per-task cursor as we go so a partially-applied page
      // resumes from the right point if the reducer throws midway.
      this.setCursor(`task:${event.taskId}`, event.seq);
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

  private setCursor(key: CursorKey, value: number | string): void {
    if (!this.cursors.has(key) && this.cursors.size >= this.maxCursors) {
      // FIFO eviction by Map insertion order. An evicted task cursor
      // means the next reconcile for that task starts from `since=undefined`
      // (i.e. from the beginning); seenIds dedupe still suppresses
      // already-applied events as long as their id is still in the set.
      const oldest = this.cursors.keys().next().value;
      if (oldest !== undefined) this.cursors.delete(oldest);
    }
    this.cursors.set(key, value);
  }
}
