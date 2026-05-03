/**
 * TaskEventStore — append-only persistence for curated bus events per task.
 *
 * Powers historical replay of the per-turn process timeline (thinking, plan,
 * tool calls, oracle verdicts, routing/synthesis decisions, capability
 * research) after page reload. Read API is keyed by `taskId` with optional
 * `since` cursor for incremental pagination.
 *
 * Write path is always append-only and ordered via a per-task `seq` counter
 * tracked in-process (single-writer assumption inside one orchestrator).
 *
 * Payload is stored verbatim as JSON — no transformation here. Truncation
 * (oversized `result`/`thinking` strings) is the recorder's responsibility.
 */
import type { Database } from 'bun:sqlite';

export interface PersistedTaskEvent {
  id: string;
  taskId: string;
  sessionId?: string;
  seq: number;
  eventType: string;
  payload: unknown;
  ts: number;
}

interface TaskEventRow {
  id: string;
  task_id: string;
  session_id: string | null;
  seq: number;
  event_type: string;
  payload_json: string;
  ts: number;
}

export interface AppendOptions {
  taskId: string;
  sessionId?: string;
  /**
   * Phase 2.6: parent task id for sub-task events. Persisted in the new
   * `parent_task_id` column added by migration 039 so `listChildTaskIds`
   * is an O(index) lookup instead of a payload-parse scan. Optional —
   * root tasks omit it; the recorder fills it via the parentByTask cache
   * seeded from `task:start.input.parentTaskId`.
   */
  parentTaskId?: string;
  eventType: string;
  payload: unknown;
  ts: number;
}

export interface ListOptions {
  /** Inclusive lower bound on `seq`. Use `lastSeq + 1` for incremental polling. */
  since?: number;
  /** Hard cap on returned rows (default 1000). */
  limit?: number;
}

/**
 * Cursor for session-scoped pagination. `seq` is per-task, so events from
 * different tasks within one session must be ordered by `(ts, id)` instead.
 * `id` breaks ties when multiple events share `ts` (1ms granularity).
 *
 * Wire format is the opaque string `<ts>:<id>` returned in `nextCursor`;
 * clients pass it back as `since`. The store treats `since` as a strict
 * lower bound — i.e. only events strictly newer than the cursor are
 * returned, so polling never re-emits a row.
 */
export interface SessionListOptions {
  /** Opaque cursor token returned by a previous call (`<ts>:<id>`). */
  since?: string;
  /** Hard cap on returned rows (default 1000, max 5000). */
  limit?: number;
}

export interface SessionEventPage {
  events: PersistedTaskEvent[];
  /** Opaque cursor — pass back as `since` to fetch the next page. */
  nextCursor?: string;
}

/**
 * Multi-task query for the "process replay with descendants" path. Lets the
 * task event-history endpoint return a parent's events merged with all
 * sub-agent events spawned by it, so the chat UI can populate per-agent
 * expandable rows without an N+1 fetch dance.
 *
 * Pagination contract matches {@link SessionListOptions} (`<ts>:<id>` strict-
 * greater) since per-task `seq` is not meaningful across taskIds.
 *
 * `rootSessionId` is an optional defense-in-depth filter — when provided,
 * only events whose `session_id` matches the root task's session are
 * returned, even if the resolver accidentally pulled in a stale subTaskId.
 */
export interface TreeListOptions {
  /** Tasks to include — resolver caps this at TREE_TASKID_CAP. */
  taskIds: string[];
  /** When set, restrict to this session_id (defense-in-depth). */
  rootSessionId?: string;
  /** Opaque cursor token (`<ts>:<id>`). */
  since?: string;
  /** Hard cap on returned rows (default 1000, max 5000). */
  limit?: number;
}

export interface TreeEventPage {
  events: PersistedTaskEvent[];
  /** Opaque cursor — pass back as `since` to fetch the next page. */
  nextCursor?: string;
}

/**
 * Defensive cap on the number of taskIds resolved into a single tree query.
 * Prevents a runaway delegation graph (or accidental cycle detected late)
 * from producing a multi-thousand-placeholder IN-list. The handler reports
 * `truncated: true` when it has to stop discovery early.
 */
export const TREE_TASKID_CAP = 64;

export class TaskEventStore {
  private db: Database;
  private insertStmt;
  private listStmt;
  private listSinceStmt;
  private listSessionStmt;
  private listSessionSinceStmt;
  /** Per-task monotonic seq counter, hydrated lazily from MAX(seq). */
  private seqByTask = new Map<string, number>();

  constructor(db: Database) {
    this.db = db;
    this.insertStmt = db.prepare(
      `INSERT INTO task_events (id, task_id, session_id, parent_task_id, seq, event_type, payload_json, ts)
       VALUES ($id, $task_id, $session_id, $parent_task_id, $seq, $event_type, $payload_json, $ts)`,
    );
    this.listStmt = db.prepare(
      `SELECT id, task_id, session_id, seq, event_type, payload_json, ts
         FROM task_events
        WHERE task_id = $task_id
        ORDER BY seq ASC
        LIMIT $limit`,
    );
    this.listSinceStmt = db.prepare(
      `SELECT id, task_id, session_id, seq, event_type, payload_json, ts
         FROM task_events
        WHERE task_id = $task_id AND seq >= $since
        ORDER BY seq ASC
        LIMIT $limit`,
    );
    // Session-scoped ordering: rely on `(session_id, ts)` index +
    // tie-break by `id` so the cursor is stable when multiple events
    // share `ts`. `id` is `<taskId>-<seq>` so ordering by `id` lexically
    // is monotonic-per-task; across tasks the tie-break is arbitrary but
    // *deterministic*, which is what cursor pagination needs.
    this.listSessionStmt = db.prepare(
      `SELECT id, task_id, session_id, seq, event_type, payload_json, ts
         FROM task_events
        WHERE session_id = $session_id
        ORDER BY ts ASC, id ASC
        LIMIT $limit`,
    );
    this.listSessionSinceStmt = db.prepare(
      `SELECT id, task_id, session_id, seq, event_type, payload_json, ts
         FROM task_events
        WHERE session_id = $session_id
          AND (ts > $since_ts OR (ts = $since_ts AND id > $since_id))
        ORDER BY ts ASC, id ASC
        LIMIT $limit`,
    );
  }

  private nextSeq(taskId: string): number {
    const cached = this.seqByTask.get(taskId);
    if (cached !== undefined) {
      const next = cached + 1;
      this.seqByTask.set(taskId, next);
      return next;
    }
    // First write for this task in-process — hydrate from DB.
    const row = this.db
      .query<{ max: number | null }, [string]>('SELECT MAX(seq) AS max FROM task_events WHERE task_id = ?')
      .get(taskId);
    const start = row?.max ?? 0;
    const next = start + 1;
    this.seqByTask.set(taskId, next);
    return next;
  }

  /** Append a single event. Used in tests; recorder uses {@link appendBatch}. */
  append(opts: AppendOptions): PersistedTaskEvent {
    const seq = this.nextSeq(opts.taskId);
    const id = `${opts.taskId}-${seq}`;
    const payloadJson = stableStringify(opts.payload);
    this.insertStmt.run({
      $id: id,
      $task_id: opts.taskId,
      $session_id: opts.sessionId ?? null,
      $parent_task_id: opts.parentTaskId ?? null,
      $seq: seq,
      $event_type: opts.eventType,
      $payload_json: payloadJson,
      $ts: opts.ts,
    });
    return {
      id,
      taskId: opts.taskId,
      sessionId: opts.sessionId,
      seq,
      eventType: opts.eventType,
      payload: opts.payload,
      ts: opts.ts,
    };
  }

  /** Append a batch in a single transaction — preferred for the recorder. */
  appendBatch(events: AppendOptions[]): number {
    if (events.length === 0) return 0;
    const tx = this.db.transaction((items: AppendOptions[]) => {
      for (const e of items) this.append(e);
    });
    tx(events);
    return events.length;
  }

  /** Return all events for a task in seq order (optionally since a cursor). */
  listForTask(taskId: string, opts: ListOptions = {}): PersistedTaskEvent[] {
    const limit = Math.max(1, Math.min(opts.limit ?? 1000, 5000));
    const rows = (
      opts.since !== undefined
        ? this.listSinceStmt.all({ $task_id: taskId, $since: opts.since, $limit: limit })
        : this.listStmt.all({ $task_id: taskId, $limit: limit })
    ) as TaskEventRow[];
    return rows.map(rowToEvent);
  }

  /**
   * Return events for a session ordered by `(ts, id)` across every task in
   * the session. Powers `GET /api/v1/sessions/:id/event-history` — used by
   * the client-side reconciler to recover process state after SSE drops or
   * a reconnect, without having to know every active taskId in advance.
   *
   * Cursor format is opaque (`<ts>:<id>`). Clients should treat it as a
   * pass-through token; pass back the `nextCursor` from the previous
   * response as `since` for incremental polling.
   */
  listForSession(sessionId: string, opts: SessionListOptions = {}): SessionEventPage {
    const limit = Math.max(1, Math.min(opts.limit ?? 1000, 5000));
    let rows: TaskEventRow[];
    if (opts.since) {
      const parsed = parseSessionCursor(opts.since);
      if (!parsed) {
        // Invalid cursor — treat as "from beginning" rather than error,
        // so a client that lost cursor state can still recover.
        rows = this.listSessionStmt.all({ $session_id: sessionId, $limit: limit }) as TaskEventRow[];
      } else {
        rows = this.listSessionSinceStmt.all({
          $session_id: sessionId,
          $since_ts: parsed.ts,
          $since_id: parsed.id,
          $limit: limit,
        }) as TaskEventRow[];
      }
    } else {
      rows = this.listSessionStmt.all({ $session_id: sessionId, $limit: limit }) as TaskEventRow[];
    }
    const events = rows.map(rowToEvent);
    const last = events[events.length - 1];
    return {
      events,
      nextCursor: last ? `${last.ts}:${last.id}` : undefined,
    };
  }

  /**
   * Return the immediate sub-task IDs dispatched by `taskId`, in dispatch
   * order. Reads from this task's persisted `workflow:delegate_dispatched`
   * events — the workflow executor records `subTaskId` in those payloads,
   * so this is the authoritative tree edge index without any new column.
   *
   * Used by the tree resolver in {@link handleTaskEventHistory} when the
   * client asks for descendant events. Duplicates are removed.
   */
  listChildTaskIds(taskId: string): string[] {
    // Phase 2.6: primary read is the structured `parent_task_id` column
    // added by migration 039 + populated by the recorder going forward.
    // The legacy `json_extract(payload, '$.subTaskId')` path stays as a
    // one-version fallback, UNIONed in to catch:
    //   (a) rows whose parent_task_id was not backfilled because the
    //       migration ran in a chunk window that skipped them, or
    //   (b) tests that bypass the recorder and insert raw rows without
    //       populating the column.
    // This fallback is intentionally temporary — the tail commit of the
    // same PR removes it once the migration's reach has been verified
    // against operator data. Until then, parity is preserved by UNION.
    const rows = this.db
      .query<{ child_task_id: string }, [string, string]>(
        `SELECT DISTINCT child_task_id FROM (
            SELECT task_id AS child_task_id
              FROM task_events
             WHERE parent_task_id = ?1
          UNION
            SELECT json_extract(payload_json, '$.subTaskId') AS child_task_id
              FROM task_events
             WHERE task_id = ?2
               AND event_type = 'workflow:delegate_dispatched'
               AND json_extract(payload_json, '$.subTaskId') IS NOT NULL
         )
         ORDER BY child_task_id`,
      )
      .all(taskId, taskId);
    return rows.map((r) => r.child_task_id);
  }

  /**
   * Return the `session_id` for a task, derived from any persisted event.
   * Used as the root for the defense-in-depth session filter on tree
   * queries. Returns `undefined` when no events exist (or the row's
   * session_id was null) — the caller treats that as "no guard".
   */
  lookupSessionId(taskId: string): string | undefined {
    const row = this.db
      .query<{ session_id: string | null }, [string]>(
        `SELECT session_id FROM task_events
          WHERE task_id = ? AND session_id IS NOT NULL
          ORDER BY seq ASC LIMIT 1`,
      )
      .get(taskId);
    return row?.session_id ?? undefined;
  }

  /**
   * Return events across multiple taskIds (the resolved descendant tree),
   * ordered by `(ts, id)` and paginated via the same opaque cursor format
   * as {@link listForSession}.
   *
   * Bun's prepared-statement cache is keyed on SQL text, so a varying
   * IN-list size means we rebuild the query each call. The IN-list is
   * already capped at {@link TREE_TASKID_CAP}, so the per-call parse cost
   * is bounded and the request fanout is small.
   */
  listForTaskTree(_rootTaskId: string, opts: TreeListOptions): TreeEventPage {
    const limit = Math.max(1, Math.min(opts.limit ?? 1000, 5000));
    if (opts.taskIds.length === 0) {
      return { events: [], nextCursor: undefined };
    }
    const ids = opts.taskIds.slice(0, TREE_TASKID_CAP);
    const placeholders = ids.map(() => '?').join(', ');
    const sessionGuard = opts.rootSessionId ? ' AND session_id = ?' : '';

    const cursor = opts.since ? parseSessionCursor(opts.since) : undefined;
    let sql: string;
    let params: (string | number)[];
    if (cursor) {
      sql = `SELECT id, task_id, session_id, seq, event_type, payload_json, ts
               FROM task_events
              WHERE task_id IN (${placeholders})${sessionGuard}
                AND (ts > ? OR (ts = ? AND id > ?))
              ORDER BY ts ASC, id ASC
              LIMIT ?`;
      params = [...ids, ...(opts.rootSessionId ? [opts.rootSessionId] : []), cursor.ts, cursor.ts, cursor.id, limit];
    } else {
      sql = `SELECT id, task_id, session_id, seq, event_type, payload_json, ts
               FROM task_events
              WHERE task_id IN (${placeholders})${sessionGuard}
              ORDER BY ts ASC, id ASC
              LIMIT ?`;
      params = [...ids, ...(opts.rootSessionId ? [opts.rootSessionId] : []), limit];
    }
    const rows = this.db.query<TaskEventRow, (string | number)[]>(sql).all(...params);
    const events = rows.map(rowToEvent);
    const last = events[events.length - 1];
    // Match `listForSession`'s cursor contract — emit a cursor whenever
    // there are rows; the empty-page response signals end-of-stream.
    return {
      events,
      nextCursor: last ? `${last.ts}:${last.id}` : undefined,
    };
  }

  /** Drop in-memory seq cache entries for a task — used by tests. */
  forgetTask(taskId: string): void {
    this.seqByTask.delete(taskId);
  }

  /**
   * Return the subset of `taskIds` that have an UNRESOLVED workflow gate
   * of the given pair. A gate is considered open when the recorded count
   * of `_needed` events exceeds the count of matching `_provided` events.
   *
   * Used by the operations console list endpoint so the row-level
   * "needs action" signal reflects the actual gate state — not a heuristic
   * derived from `result.status === 'partial'`, which over-fires on
   * already-resolved partial results.
   */
  listOpenGates(taskIds: string[], needed: string, provided: string): Set<string> {
    if (taskIds.length === 0) return new Set();
    const ids = taskIds.slice(0, 500);
    const placeholders = ids.map(() => '?').join(',');
    const rows = this.db
      .query<{ task_id: string; need_count: number; prov_count: number }, (string | number)[]>(
        `SELECT task_id,
                SUM(CASE WHEN event_type = ? THEN 1 ELSE 0 END) AS need_count,
                SUM(CASE WHEN event_type = ? THEN 1 ELSE 0 END) AS prov_count
           FROM task_events
          WHERE task_id IN (${placeholders})
            AND event_type IN (?, ?)
          GROUP BY task_id`,
      )
      .all(needed, provided, ...ids, needed, provided);
    const open = new Set<string>();
    for (const r of rows) {
      if ((r.need_count ?? 0) > (r.prov_count ?? 0)) open.add(r.task_id);
    }
    return open;
  }
}

function parseSessionCursor(token: string): { ts: number; id: string } | undefined {
  const idx = token.indexOf(':');
  if (idx <= 0 || idx === token.length - 1) return undefined;
  const tsStr = token.slice(0, idx);
  const id = token.slice(idx + 1);
  const ts = Number.parseInt(tsStr, 10);
  if (!Number.isFinite(ts) || ts < 0) return undefined;
  return { ts, id };
}

function rowToEvent(row: TaskEventRow): PersistedTaskEvent {
  let payload: unknown = null;
  try {
    payload = JSON.parse(row.payload_json);
  } catch {
    payload = { _parseError: true, raw: row.payload_json };
  }
  return {
    id: row.id,
    taskId: row.task_id,
    sessionId: row.session_id ?? undefined,
    seq: row.seq,
    eventType: row.event_type,
    payload,
    ts: row.ts,
  };
}

/**
 * Deterministic JSON stringify with cycle/error fallback. Pure stable order
 * is not required for replay correctness (we sort by seq, not JSON content),
 * but a try/catch guarantees the recorder never throws on circular refs.
 */
function stableStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return JSON.stringify({ _serializeError: true });
  }
}
