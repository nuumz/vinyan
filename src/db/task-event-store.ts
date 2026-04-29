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

export class TaskEventStore {
  private db: Database;
  private insertStmt;
  private listStmt;
  private listSinceStmt;
  /** Per-task monotonic seq counter, hydrated lazily from MAX(seq). */
  private seqByTask = new Map<string, number>();

  constructor(db: Database) {
    this.db = db;
    this.insertStmt = db.prepare(
      `INSERT INTO task_events (id, task_id, session_id, seq, event_type, payload_json, ts)
       VALUES ($id, $task_id, $session_id, $seq, $event_type, $payload_json, $ts)`,
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

  /** Drop in-memory seq cache entries for a task — used by tests. */
  forgetTask(taskId: string): void {
    this.seqByTask.delete(taskId);
  }
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
