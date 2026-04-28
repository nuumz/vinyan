/**
 * Session Store — CRUD for API sessions, session tasks, and conversation messages.
 *
 * Follows WorkerStore pattern: SQLite-backed, Zod-validated at boundaries.
 * Source of truth: spec/tdd.md §22.5
 */
import type { Database } from 'bun:sqlite';
import type { ContentBlock, Turn, TurnTokenCount } from '../orchestrator/types.ts';

export interface SessionRow {
  id: string;
  source: string;
  created_at: number;
  status: 'active' | 'suspended' | 'compacted' | 'closed';
  working_memory_json: string | null;
  compaction_json: string | null;
  updated_at: number;
  /** Operator-supplied human-friendly title (added by migration 014). */
  title: string | null;
  /** Operator-supplied longer description / context (added by migration 014). */
  description: string | null;
  /** Epoch-ms; non-null means archived (hidden from default list). */
  archived_at: number | null;
  /** Epoch-ms; non-null means soft-deleted (Trash). */
  deleted_at: number | null;
}

/** Visibility filter for `listSessions` — driven by archive/delete columns. */
export type SessionListState = 'active' | 'archived' | 'deleted' | 'all';

export interface ListSessionsOptions {
  state?: SessionListState;
  /** Case-insensitive substring match against id, source, title, description. */
  search?: string;
  limit?: number;
  offset?: number;
}

export interface SessionRowWithCount extends SessionRow {
  task_count: number;
  /** Tasks currently in 'pending' or 'running' state — drives the in-progress badge. */
  running_task_count: number;
  /**
   * Role of the most recent turn in the session, joined inline so the
   * activityState 'waiting-input' badge can be computed without an N+1
   * fanout per row. NULL when the session has no turns yet.
   */
  latest_turn_role: 'user' | 'assistant' | null;
  /**
   * Blocks JSON of the most recent turn — same row as `latest_turn_role`.
   * Carried verbatim so the activity classifier can scan for the
   * `[INPUT-REQUIRED]` sentinel without re-querying the turns table.
   */
  latest_turn_blocks: string | null;
}

export interface SessionMetadataPatch {
  title?: string | null;
  description?: string | null;
}

export interface SessionTaskRow {
  session_id: string;
  task_id: string;
  task_input_json: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
  result_json: string | null;
  created_at: number;
}

// A7: SessionMessageRow removed. session_messages table is dropped by
// migration 037 and has no readers after the Turn-model migration lands.

/** Raw SQLite row shape for session_turns — blocks/token_count are JSON strings. */
export interface SessionTurnRow {
  id: string;
  session_id: string;
  seq: number;
  role: 'user' | 'assistant';
  blocks_json: string;
  cancelled_at: number | null;
  token_count_json: string;
  task_id: string | null;
  created_at: number;
}

export class SessionStore {
  constructor(private db: Database) {}

  insertSession(session: SessionRow): void {
    this.db.run(
      `INSERT INTO session_store (id, source, created_at, status, working_memory_json, compaction_json, updated_at, title, description, archived_at, deleted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        session.id,
        session.source,
        session.created_at,
        session.status,
        session.working_memory_json,
        session.compaction_json,
        session.updated_at,
        session.title,
        session.description,
        session.archived_at,
        session.deleted_at,
      ],
    );
  }

  getSession(id: string): SessionRow | undefined {
    return this.db.query('SELECT * FROM session_store WHERE id = ?').get(id) as SessionRow | undefined;
  }

  /**
   * Lifecycle bookkeeping only — used by suspend-all-on-shutdown and
   * recover-on-startup. Intentionally does NOT touch `updated_at`: a server
   * bounce is not user activity, and bumping it here resets every active
   * session's "Updated" timestamp on every restart.
   */
  updateSessionStatus(id: string, status: SessionRow['status']): void {
    this.db.run('UPDATE session_store SET status = ? WHERE id = ?', [status, id]);
  }

  updateSessionCompaction(id: string, compactionJson: string): void {
    this.db.run("UPDATE session_store SET compaction_json = ?, status = 'compacted', updated_at = ? WHERE id = ?", [
      compactionJson,
      Date.now(),
      id,
    ]);
  }

  updateSessionMemory(id: string, memoryJson: string): void {
    this.db.run('UPDATE session_store SET working_memory_json = ?, updated_at = ? WHERE id = ?', [
      memoryJson,
      Date.now(),
      id,
    ]);
  }

  listActiveSessions(): SessionRow[] {
    return this.db
      .query(
        "SELECT * FROM session_store WHERE status = 'active' AND archived_at IS NULL AND deleted_at IS NULL ORDER BY created_at DESC",
      )
      .all() as SessionRow[];
  }

  listSuspendedSessions(): SessionRow[] {
    return this.db
      .query(
        "SELECT * FROM session_store WHERE status = 'suspended' AND archived_at IS NULL AND deleted_at IS NULL ORDER BY created_at DESC",
      )
      .all() as SessionRow[];
  }

  /**
   * Filtered list with task counts joined in a single query. The visibility
   * filter (`state`) maps onto the archived_at / deleted_at columns so the
   * existing lifecycle `status` (active/suspended/compacted/closed) stays
   * untouched and the SQLite CHECK constraint on it is preserved.
   */
  listSessions(options: ListSessionsOptions = {}): SessionRowWithCount[] {
    const { state = 'active', search, limit, offset } = options;
    const where: string[] = [];
    const params: (string | number)[] = [];

    if (state === 'active') {
      where.push('s.deleted_at IS NULL', 's.archived_at IS NULL');
    } else if (state === 'archived') {
      where.push('s.deleted_at IS NULL', 's.archived_at IS NOT NULL');
    } else if (state === 'deleted') {
      where.push('s.deleted_at IS NOT NULL');
    }
    // 'all' adds no visibility filter.

    if (search && search.trim().length > 0) {
      const like = `%${search.trim().toLowerCase()}%`;
      where.push(
        '(LOWER(s.id) LIKE ? OR LOWER(COALESCE(s.title, \'\')) LIKE ? OR LOWER(COALESCE(s.description, \'\')) LIKE ? OR LOWER(s.source) LIKE ?)',
      );
      params.push(like, like, like, like);
    }

    const whereClause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
    const limitClause = typeof limit === 'number' && limit > 0 ? ` LIMIT ${Math.floor(limit)}` : '';
    const offsetClause = typeof offset === 'number' && offset > 0 ? ` OFFSET ${Math.floor(offset)}` : '';

    return this.db
      .query(
        `SELECT s.*,
                COALESCE(t.cnt, 0) AS task_count,
                COALESCE(t.running_cnt, 0) AS running_task_count,
                lt.role AS latest_turn_role,
                lt.blocks_json AS latest_turn_blocks
         FROM session_store s
         LEFT JOIN (
           SELECT session_id,
                  COUNT(*) AS cnt,
                  SUM(CASE WHEN status IN ('pending','running') THEN 1 ELSE 0 END) AS running_cnt
           FROM session_tasks GROUP BY session_id
         ) t ON t.session_id = s.id
         LEFT JOIN (
           SELECT session_id, role, blocks_json,
                  ROW_NUMBER() OVER (PARTITION BY session_id ORDER BY seq DESC) AS rn
           FROM session_turns
         ) lt ON lt.session_id = s.id AND lt.rn = 1
         ${whereClause}
         ORDER BY s.updated_at DESC, s.created_at DESC${limitClause}${offsetClause}`,
      )
      .all(...params) as SessionRowWithCount[];
  }

  /**
   * Latest turn's role + blocks for a single session — used by `get()` to
   * derive the same `waiting-input` activity state that `listSessions`
   * computes via window function. NULL when there are no turns.
   */
  getLatestTurnRoleAndBlocks(
    sessionId: string,
  ): { role: 'user' | 'assistant'; blocks_json: string } | undefined {
    return this.db
      .query(
        'SELECT role, blocks_json FROM session_turns WHERE session_id = ? ORDER BY seq DESC LIMIT 1',
      )
      .get(sessionId) as { role: 'user' | 'assistant'; blocks_json: string } | undefined;
  }

  /** Count tasks currently in 'pending' or 'running' state for a single session. */
  countRunningTasks(sessionId: string): number {
    const row = this.db
      .query(
        "SELECT COUNT(*) AS count FROM session_tasks WHERE session_id = ? AND status IN ('pending','running')",
      )
      .get(sessionId) as { count: number };
    return row.count;
  }

  updateSessionMetadata(id: string, patch: SessionMetadataPatch): boolean {
    const sets: string[] = [];
    const params: (string | number | null)[] = [];
    if (patch.title !== undefined) {
      sets.push('title = ?');
      params.push(patch.title);
    }
    if (patch.description !== undefined) {
      sets.push('description = ?');
      params.push(patch.description);
    }
    if (sets.length === 0) return false;
    sets.push('updated_at = ?');
    params.push(Date.now());
    params.push(id);
    const res = this.db.run(
      `UPDATE session_store SET ${sets.join(', ')} WHERE id = ?`,
      params,
    );
    return res.changes > 0;
  }

  archiveSession(id: string): boolean {
    const now = Date.now();
    const res = this.db.run(
      'UPDATE session_store SET archived_at = ?, updated_at = ? WHERE id = ? AND archived_at IS NULL AND deleted_at IS NULL',
      [now, now, id],
    );
    return res.changes > 0;
  }

  unarchiveSession(id: string): boolean {
    const now = Date.now();
    const res = this.db.run(
      'UPDATE session_store SET archived_at = NULL, updated_at = ? WHERE id = ? AND archived_at IS NOT NULL AND deleted_at IS NULL',
      [now, id],
    );
    return res.changes > 0;
  }

  softDeleteSession(id: string): boolean {
    const now = Date.now();
    const res = this.db.run(
      'UPDATE session_store SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL',
      [now, now, id],
    );
    return res.changes > 0;
  }

  restoreSession(id: string): boolean {
    const now = Date.now();
    const res = this.db.run(
      'UPDATE session_store SET deleted_at = NULL, updated_at = ? WHERE id = ? AND deleted_at IS NOT NULL',
      [now, id],
    );
    return res.changes > 0;
  }

  /**
   * Permanent removal — caller MUST verify the row is already trashed
   * (`deleted_at IS NOT NULL`) before calling this; the DELETE itself is
   * gated by that condition for defense-in-depth.
   *
   * Foreign keys (session_tasks, session_turns) on session_store are NOT
   * declared `ON DELETE CASCADE`, so we delete child rows explicitly. The
   * `turn_embedding_meta` table cascades from `session_turns(id)`, which
   * picks up its rows automatically. The `turn_embeddings` virtual table
   * (sqlite-vec) carries no FK — we best-effort delete its rows by id
   * before dropping the turns. Wrapped in a single transaction so a
   * failure between steps cannot leave half-deleted state.
   */
  /**
   * List ids of every trashed session — drives the "Empty Trash" bulk
   * action. Read-only; the caller decides whether to hard-delete the
   * entire batch or a slice of it.
   */
  listTrashedSessionIds(): string[] {
    const rows = this.db
      .query('SELECT id FROM session_store WHERE deleted_at IS NOT NULL ORDER BY deleted_at ASC')
      .all() as Array<{ id: string }>;
    return rows.map((r) => r.id);
  }

  hardDeleteSession(id: string): boolean {
    const turnIds = this.db
      .query('SELECT id FROM session_turns WHERE session_id = ?')
      .all(id) as Array<{ id: string }>;

    const tx = this.db.transaction(() => {
      // Best-effort sqlite-vec cleanup. The virtual table only exists when
      // the sqlite-vec extension is loaded; on machines without it the
      // table is absent and we silently skip.
      if (turnIds.length > 0) {
        try {
          const placeholders = turnIds.map(() => '?').join(',');
          this.db.run(
            `DELETE FROM turn_embeddings WHERE turn_id IN (${placeholders})`,
            turnIds.map((r) => r.id),
          );
        } catch {
          /* turn_embeddings virtual table not present — skip */
        }
      }
      this.db.run('DELETE FROM session_turns WHERE session_id = ?', [id]);
      this.db.run('DELETE FROM session_tasks WHERE session_id = ?', [id]);
      const res = this.db.run(
        'DELETE FROM session_store WHERE id = ? AND deleted_at IS NOT NULL',
        [id],
      );
      return res.changes > 0;
    });

    return tx() as boolean;
  }

  // ── Session Tasks ───────────────────────────────────────

  /**
   * Touch the parent session's `updated_at` to the given timestamp.
   *
   * Real activity (a new task, a new turn, a task transitioning to
   * completed/failed) needs to bubble the session up the recency-sorted
   * list. Lifecycle bookkeeping (suspend/recover) intentionally avoids
   * touching this — see `updateSessionStatus`. Callers pass the same
   * timestamp they used for the child row so the parent and child stay
   * synchronized in test assertions.
   */
  private touchSessionUpdatedAt(sessionId: string, ts: number): void {
    this.db.run('UPDATE session_store SET updated_at = ? WHERE id = ?', [ts, sessionId]);
  }

  insertTask(task: SessionTaskRow): void {
    this.db.run(
      `INSERT INTO session_tasks (session_id, task_id, task_input_json, status, result_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [task.session_id, task.task_id, task.task_input_json, task.status, task.result_json, task.created_at],
    );
    this.touchSessionUpdatedAt(task.session_id, task.created_at);
  }

  getTask(sessionId: string, taskId: string): SessionTaskRow | undefined {
    return this.db.query('SELECT * FROM session_tasks WHERE session_id = ? AND task_id = ?').get(sessionId, taskId) as
      | SessionTaskRow
      | undefined;
  }

  updateTaskStatus(sessionId: string, taskId: string, status: SessionTaskRow['status'], resultJson?: string): void {
    this.db.run('UPDATE session_tasks SET status = ?, result_json = ? WHERE session_id = ? AND task_id = ?', [
      status,
      resultJson ?? null,
      sessionId,
      taskId,
    ]);
    // A task transitioning state (running → completed / failed / cancelled)
    // is meaningful activity — the session should rise on the recency list
    // even if the next caller never explicitly bumps `updated_at`.
    this.touchSessionUpdatedAt(sessionId, Date.now());
  }

  listSessionTasks(sessionId: string): SessionTaskRow[] {
    return this.db
      .query('SELECT * FROM session_tasks WHERE session_id = ? ORDER BY created_at ASC')
      .all(sessionId) as SessionTaskRow[];
  }

  countSessionTasks(sessionId: string): number {
    const row = this.db.query('SELECT COUNT(*) as count FROM session_tasks WHERE session_id = ?').get(sessionId) as {
      count: number;
    };
    return row.count;
  }

  listPendingTasks(): SessionTaskRow[] {
    return this.db
      .query("SELECT * FROM session_tasks WHERE status IN ('pending', 'running') ORDER BY created_at ASC")
      .all() as SessionTaskRow[];
  }

  listRecentTasks(limit = 100): SessionTaskRow[] {
    return this.db
      .query('SELECT * FROM session_tasks ORDER BY created_at DESC LIMIT ?')
      .all(limit) as SessionTaskRow[];
  }

  // A7: session_messages methods removed. The session_turns methods below
  // are the sole conversation-persistence path. Migration 037 drops the
  // underlying session_messages table.

  // ── Session Turns (Turn model — plan commit A) ──────────

  /**
   * Append a turn to the session. `seq` is computed from current row count so
   * callers do not need to track ordinals.
   *
   * Note: this does not enforce in-flight uniqueness under concurrent writes
   * within a single session. The current orchestrator model is single-writer
   * per session (one active task at a time), so the UNIQUE(session_id, seq)
   * index is sufficient.
   */
  appendTurn(turn: Omit<Turn, 'seq'> & { seq?: number }): Turn {
    const seq =
      turn.seq ??
      ((this.db
        .query('SELECT COALESCE(MAX(seq), -1) + 1 AS next FROM session_turns WHERE session_id = ?')
        .get(turn.sessionId) as { next: number }).next);

    const row: SessionTurnRow = {
      id: turn.id,
      session_id: turn.sessionId,
      seq,
      role: turn.role,
      blocks_json: JSON.stringify(turn.blocks),
      cancelled_at: turn.cancelledAt ?? null,
      token_count_json: JSON.stringify(turn.tokenCount),
      task_id: turn.taskId ?? null,
      created_at: turn.createdAt,
    };

    this.db.run(
      `INSERT INTO session_turns (id, session_id, seq, role, blocks_json, cancelled_at, token_count_json, task_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        row.id,
        row.session_id,
        row.seq,
        row.role,
        row.blocks_json,
        row.cancelled_at,
        row.token_count_json,
        row.task_id,
        row.created_at,
      ],
    );
    // Conversation turn = real activity. Bubble the session up.
    this.touchSessionUpdatedAt(row.session_id, row.created_at);

    return { ...turn, seq };
  }

  getTurns(sessionId: string, limit?: number): Turn[] {
    const rows =
      limit != null
        ? (this.db
            .query('SELECT * FROM session_turns WHERE session_id = ? ORDER BY seq ASC LIMIT ?')
            .all(sessionId, limit) as SessionTurnRow[])
        : (this.db
            .query('SELECT * FROM session_turns WHERE session_id = ? ORDER BY seq ASC')
            .all(sessionId) as SessionTurnRow[]);
    return rows.map(rowToTurn);
  }

  /** Tail window — newest N turns in chronological order. */
  getRecentTurns(sessionId: string, limit: number): Turn[] {
    const rows = this.db
      .query('SELECT * FROM session_turns WHERE session_id = ? ORDER BY seq DESC LIMIT ?')
      .all(sessionId, limit) as SessionTurnRow[];
    return rows.reverse().map(rowToTurn);
  }

  countTurns(sessionId: string): number {
    const row = this.db
      .query('SELECT COUNT(*) as count FROM session_turns WHERE session_id = ?')
      .get(sessionId) as { count: number };
    return row.count;
  }

  getTurn(turnId: string): Turn | undefined {
    const row = this.db.query('SELECT * FROM session_turns WHERE id = ?').get(turnId) as
      | SessionTurnRow
      | undefined;
    return row ? rowToTurn(row) : undefined;
  }

  /**
   * Mark a turn as cancelled by the user (plan commit C). Persists the partial
   * blocks that were streamed before cancel so the next turn can reference the
   * aborted state. Safe to call on an already-cancelled turn (no-op beyond
   * overwriting the timestamp).
   */
  markCancelled(turnId: string, cancelledAt: number, partialBlocks?: ContentBlock[]): void {
    if (partialBlocks != null) {
      this.db.run('UPDATE session_turns SET cancelled_at = ?, blocks_json = ? WHERE id = ?', [
        cancelledAt,
        JSON.stringify(partialBlocks),
        turnId,
      ]);
    } else {
      this.db.run('UPDATE session_turns SET cancelled_at = ? WHERE id = ?', [cancelledAt, turnId]);
    }
  }

  /**
   * Update token accounting for a turn after the LLM response arrives. Split
   * from `appendTurn` because input turns are persisted before the response
   * resolves cacheRead / cacheCreation counts.
   */
  updateTurnTokenCount(turnId: string, tokenCount: TurnTokenCount): void {
    this.db.run('UPDATE session_turns SET token_count_json = ? WHERE id = ?', [
      JSON.stringify(tokenCount),
      turnId,
    ]);
  }
}

function rowToTurn(row: SessionTurnRow): Turn {
  return {
    id: row.id,
    sessionId: row.session_id,
    seq: row.seq,
    role: row.role,
    blocks: JSON.parse(row.blocks_json) as ContentBlock[],
    cancelledAt: row.cancelled_at ?? undefined,
    tokenCount: JSON.parse(row.token_count_json) as TurnTokenCount,
    taskId: row.task_id ?? undefined,
    createdAt: row.created_at,
  };
}
