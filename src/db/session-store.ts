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
  /** Last time the row's status mutated; backfilled from created_at by mig 027. */
  updated_at: number | null;
  /** Soft-hide marker for the operations console (NULL = active, non-NULL = archived). */
  archived_at: number | null;
}

/**
 * Filter shape for the Tasks operations console list query. Mirrors the
 * `GET /api/v1/tasks` query string — see `handleListTasks`. Every field is
 * optional and AND-combined.
 */
export interface ListSessionTasksOptions {
  /** Visibility filter — defaults to 'active' (archived_at IS NULL). */
  visibility?: 'active' | 'archived' | 'all';
  /** Restrict to one or more session_tasks rows by db status. */
  statuses?: Array<SessionTaskRow['status']>;
  sessionId?: string;
  /**
   * Substring search against task_id, session_id, and the goal embedded in
   * task_input_json (LIKE on the raw JSON works here because we always
   * write `goal` as `"goal":"…"`). Case-insensitive.
   */
  search?: string;
  /** Inclusive lower/upper bounds on `created_at` (epoch ms). */
  from?: number;
  to?: number;
  limit?: number;
  offset?: number;
  /** Sort order — newest-first by default. */
  sort?: 'created-desc' | 'created-asc' | 'updated-desc' | 'updated-asc';
  /**
   * Search backend.
   *  - `'like'` (default) — cheap substring match on task_id/session_id/json.
   *    Matches the legacy operator-console behaviour.
   *  - `'fts'`            — `session_tasks_fts` MATCH (mig 028). Multi-token
   *    AND queries, BM25-ranked. Falls back to LIKE if the virtual table is
   *    not present (e.g. unmigrated DB).
   *
   * Ignored when `search` is empty.
   */
  searchMode?: 'like' | 'fts';
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

  // ── JSONL hybrid index helpers (Phase 2) ────────────────────────────────

  /**
   * Record where the per-session JSONL writer left off. Called after
   * every successful `JsonlAppender.appendSync` so a crash recovery
   * scan on next startup can compare `last_line_offset` against the
   * actual `events.jsonl` size and partial-rebuild any drift.
   *
   * Migration 036 added the columns. They stay nullable so legacy
   * sessions (created before Phase 2) coexist with hybrid ones.
   */
  updateLastLineCursor(sessionId: string, lastLineId: string, lastLineOffset: number): boolean {
    const res = this.db.run('UPDATE session_store SET last_line_id = ?, last_line_offset = ? WHERE id = ?', [
      lastLineId,
      lastLineOffset,
      sessionId,
    ]);
    return res.changes > 0;
  }

  /**
   * Upsert the denormalized "latest turn" row driving the activity-state
   * badge in `listSessions`. Replaces the per-query window function in
   * `listSessions()` once Phase 3 reads from the index instead of
   * `session_turns`.
   *
   * Phase 2 keeps both representations in sync — `appendTurn` writes
   * `session_turns` AND callers also `upsertTurnSummary` here. The
   * verifier compares the two; once stable, Phase 4 drops `session_turns`.
   */
  upsertTurnSummary(
    sessionId: string,
    summary: {
      latestSeq: number;
      latestTurnId: string;
      latestTurnRole: 'user' | 'assistant';
      latestBlocksPreview: string | null;
      turnCountDelta: number;
      updatedAt: number;
    },
  ): void {
    this.db.run(
      `INSERT INTO session_turn_summary
          (session_id, latest_seq, latest_turn_id, latest_turn_role, latest_turn_blocks_preview,
           turn_count, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(session_id) DO UPDATE SET
          latest_seq = excluded.latest_seq,
          latest_turn_id = excluded.latest_turn_id,
          latest_turn_role = excluded.latest_turn_role,
          latest_turn_blocks_preview = excluded.latest_turn_blocks_preview,
          turn_count = session_turn_summary.turn_count + ?,
          updated_at = excluded.updated_at`,
      [
        sessionId,
        summary.latestSeq,
        summary.latestTurnId,
        summary.latestTurnRole,
        summary.latestBlocksPreview,
        summary.turnCountDelta, // initial insert: count = delta
        summary.updatedAt,
        summary.turnCountDelta, // upsert: count += delta
      ],
    );
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
        "(LOWER(s.id) LIKE ? OR LOWER(COALESCE(s.title, '')) LIKE ? OR LOWER(COALESCE(s.description, '')) LIKE ? OR LOWER(s.source) LIKE ?)",
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
   * Phase 3 variant of `listSessions` — `LEFT JOIN session_turn_summary`
   * instead of running a `ROW_NUMBER OVER (PARTITION BY)` window over
   * `session_turns`. The denormalized table is maintained by the JSONL
   * dual-write path (`upsertTurnSummary`); legacy sessions that predate
   * Phase 2 simply return NULL for the latest_turn_* fields, mirroring
   * an empty session — acceptable degradation per A9 and indistinguishable
   * to the activity-state classifier.
   *
   * `latest_turn_blocks_preview` is capped at 4KB (vs the legacy
   * `blocks_json` which carried the full payload). The preview is
   * sufficient for `[INPUT-REQUIRED]` sentinel detection — the only
   * consumer of the field in `listSessions` projection.
   *
   * Run `backfillTurnSummary()` to populate legacy rows from
   * `session_turns`. Idempotent.
   */
  listSessionsViaIndex(options: ListSessionsOptions = {}): SessionRowWithCount[] {
    const { state = 'active', search, limit, offset } = options;
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (state === 'active') {
      where.push('s.archived_at IS NULL', 's.deleted_at IS NULL');
    } else if (state === 'archived') {
      where.push('s.archived_at IS NOT NULL', 's.deleted_at IS NULL');
    } else if (state === 'deleted') {
      where.push('s.deleted_at IS NOT NULL');
    }
    if (search && search.trim().length > 0) {
      const like = `%${search.trim().toLowerCase()}%`;
      where.push(
        "(LOWER(s.id) LIKE ? OR LOWER(COALESCE(s.title, '')) LIKE ? OR LOWER(COALESCE(s.description, '')) LIKE ? OR LOWER(s.source) LIKE ?)",
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
                sts.latest_turn_role,
                sts.latest_turn_blocks_preview AS latest_turn_blocks
         FROM session_store s
         LEFT JOIN (
           SELECT session_id,
                  COUNT(*) AS cnt,
                  SUM(CASE WHEN status IN ('pending','running') THEN 1 ELSE 0 END) AS running_cnt
           FROM session_tasks GROUP BY session_id
         ) t ON t.session_id = s.id
         LEFT JOIN session_turn_summary sts ON sts.session_id = s.id
         ${whereClause}
         ORDER BY s.updated_at DESC, s.created_at DESC${limitClause}${offsetClause}`,
      )
      .all(...params) as SessionRowWithCount[];
  }

  /**
   * One-shot helper: populate `session_turn_summary` for sessions that
   * predate Phase 2 dual-write (no upsert ever fired for them). Idempotent
   * — only writes for sessions missing a summary row AND with at least
   * one `session_turns` row to read from. Returns the number of summary
   * rows inserted.
   *
   * Required before flipping `session.readFromJsonl.listSessions=true` so
   * legacy sessions still surface the right activity-state badge.
   */
  backfillTurnSummary(): number {
    const result = this.db.run(
      `INSERT INTO session_turn_summary
          (session_id, latest_seq, latest_turn_id, latest_turn_role,
           latest_turn_blocks_preview, turn_count, updated_at)
       SELECT
         t.session_id,
         t.seq,
         t.id,
         t.role,
         CASE WHEN length(t.blocks_json) > 4096 THEN substr(t.blocks_json, 1, 4096) ELSE t.blocks_json END,
         (SELECT COUNT(*) FROM session_turns x WHERE x.session_id = t.session_id),
         t.created_at
       FROM session_turns t
       WHERE t.seq = (SELECT MAX(seq) FROM session_turns t2 WHERE t2.session_id = t.session_id)
         AND NOT EXISTS (
           SELECT 1 FROM session_turn_summary sts WHERE sts.session_id = t.session_id
         )`,
    );
    return result.changes;
  }

  /**
   * Latest turn's role + blocks for a single session — used by `get()` to
   * derive the same `waiting-input` activity state that `listSessions`
   * computes via window function. NULL when there are no turns.
   */
  getLatestTurnRoleAndBlocks(sessionId: string): { role: 'user' | 'assistant'; blocks_json: string } | undefined {
    return this.db
      .query('SELECT role, blocks_json FROM session_turns WHERE session_id = ? ORDER BY seq DESC LIMIT 1')
      .get(sessionId) as { role: 'user' | 'assistant'; blocks_json: string } | undefined;
  }

  /** Count tasks currently in 'pending' or 'running' state for a single session. */
  countRunningTasks(sessionId: string): number {
    const row = this.db
      .query("SELECT COUNT(*) AS count FROM session_tasks WHERE session_id = ? AND status IN ('pending','running')")
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
    const res = this.db.run(`UPDATE session_store SET ${sets.join(', ')} WHERE id = ?`, params);
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
    const turnIds = this.db.query('SELECT id FROM session_turns WHERE session_id = ?').all(id) as Array<{ id: string }>;

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
      const res = this.db.run('DELETE FROM session_store WHERE id = ? AND deleted_at IS NOT NULL', [id]);
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
      `INSERT INTO session_tasks (session_id, task_id, task_input_json, status, result_json, created_at, updated_at, archived_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        task.session_id,
        task.task_id,
        task.task_input_json,
        task.status,
        task.result_json,
        task.created_at,
        task.updated_at ?? task.created_at,
        task.archived_at ?? null,
      ],
    );
    this.touchSessionUpdatedAt(task.session_id, task.created_at);
  }

  getTask(sessionId: string, taskId: string): SessionTaskRow | undefined {
    return this.db.query('SELECT * FROM session_tasks WHERE session_id = ? AND task_id = ?').get(sessionId, taskId) as
      | SessionTaskRow
      | undefined;
  }

  updateTaskStatus(sessionId: string, taskId: string, status: SessionTaskRow['status'], resultJson?: string): void {
    const now = Date.now();
    this.db.run(
      'UPDATE session_tasks SET status = ?, result_json = ?, updated_at = ? WHERE session_id = ? AND task_id = ?',
      [status, resultJson ?? null, now, sessionId, taskId],
    );
    // A task transitioning state (running → completed / failed / cancelled)
    // is meaningful activity — the session should rise on the recency list
    // even if the next caller never explicitly bumps `updated_at`.
    this.touchSessionUpdatedAt(sessionId, now);
  }

  /** Operations console — soft-hide a task row without losing audit data. */
  archiveTaskRow(taskId: string): boolean {
    const now = Date.now();
    const res = this.db.run(
      'UPDATE session_tasks SET archived_at = ?, updated_at = ? WHERE task_id = ? AND archived_at IS NULL',
      [now, now, taskId],
    );
    return res.changes > 0;
  }

  unarchiveTaskRow(taskId: string): boolean {
    const now = Date.now();
    const res = this.db.run(
      'UPDATE session_tasks SET archived_at = NULL, updated_at = ? WHERE task_id = ? AND archived_at IS NOT NULL',
      [now, taskId],
    );
    return res.changes > 0;
  }

  /** Cross-session direct lookup by task id — single row or undefined. */
  findTaskRowById(taskId: string): SessionTaskRow | undefined {
    return this.db.query('SELECT * FROM session_tasks WHERE task_id = ? LIMIT 1').get(taskId) as
      | SessionTaskRow
      | undefined;
  }

  /**
   * Probe whether `session_tasks_fts` is present (mig 028 ran). Cheap;
   * the `sqlite_master` query is a single index lookup. Cached on the
   * instance because the answer cannot change for the life of the DB
   * handle and the fast-path `listTasksFiltered` calls hit it on every
   * search.
   */
  private fts5AvailableCache: boolean | undefined;
  fts5Available(): boolean {
    if (this.fts5AvailableCache !== undefined) return this.fts5AvailableCache;
    try {
      const row = this.db
        .query("SELECT name FROM sqlite_master WHERE type='table' AND name='session_tasks_fts'")
        .get() as { name?: string } | undefined;
      this.fts5AvailableCache = !!row?.name;
    } catch {
      this.fts5AvailableCache = false;
    }
    return this.fts5AvailableCache;
  }

  /**
   * Filtered task list — backs the Tasks operations console
   * (`GET /api/v1/tasks`). Returns matching rows + total ignoring
   * limit/offset so the UI can render a real paginator.
   *
   * When `searchMode === 'fts'` and `search` is non-empty, the search
   * runs against `session_tasks_fts` (mig 028) for multi-token AND
   * queries. Falls back to LIKE when the FTS5 virtual table is not
   * present (e.g. a fresh DB before the migration runs in tests).
   */
  listTasksFiltered(opts: ListSessionTasksOptions = {}): { rows: SessionTaskRow[]; total: number } {
    const {
      visibility = 'active',
      statuses,
      sessionId,
      search,
      from,
      to,
      limit,
      offset,
      sort = 'created-desc',
      searchMode = 'like',
    } = opts;
    const where: string[] = [];
    const params: (string | number)[] = [];

    if (visibility === 'active') where.push('archived_at IS NULL');
    else if (visibility === 'archived') where.push('archived_at IS NOT NULL');
    // 'all' adds no clause.

    if (statuses && statuses.length > 0) {
      const placeholders = statuses.map(() => '?').join(',');
      where.push(`status IN (${placeholders})`);
      params.push(...statuses);
    }
    if (sessionId) {
      where.push('session_id = ?');
      params.push(sessionId);
    }
    if (typeof from === 'number') {
      where.push('created_at >= ?');
      params.push(from);
    }
    if (typeof to === 'number') {
      where.push('created_at <= ?');
      params.push(to);
    }
    const trimmedSearch = search?.trim() ?? '';
    if (trimmedSearch.length > 0 && searchMode === 'fts' && this.fts5Available()) {
      const ftsQuery = sanitizeFts5Query(trimmedSearch);
      if (ftsQuery.length > 0) {
        // Restrict to the (task_id, session_id) pairs that match FTS5.
        // Subquery is faster than IN(...) on a list because the FTS5
        // virtual table can produce a stream of matching task_ids.
        where.push('task_id IN (SELECT task_id FROM session_tasks_fts WHERE session_tasks_fts MATCH ?)');
        params.push(ftsQuery);
      } else {
        // Sanitiser stripped the query down to nothing — degrade to LIKE
        // so the operator still gets predictable behaviour instead of
        // an empty result.
        const like = `%${trimmedSearch.toLowerCase()}%`;
        where.push('(LOWER(task_id) LIKE ? OR LOWER(session_id) LIKE ? OR LOWER(task_input_json) LIKE ?)');
        params.push(like, like, like);
      }
    } else if (trimmedSearch.length > 0) {
      const like = `%${trimmedSearch.toLowerCase()}%`;
      where.push('(LOWER(task_id) LIKE ? OR LOWER(session_id) LIKE ? OR LOWER(task_input_json) LIKE ?)');
      params.push(like, like, like);
    }

    const whereClause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
    const orderClause = (() => {
      switch (sort) {
        case 'created-asc':
          return 'ORDER BY created_at ASC';
        case 'updated-desc':
          return 'ORDER BY COALESCE(updated_at, created_at) DESC';
        case 'updated-asc':
          return 'ORDER BY COALESCE(updated_at, created_at) ASC';
        default:
          return 'ORDER BY created_at DESC';
      }
    })();
    const limitClause = typeof limit === 'number' && limit > 0 ? ` LIMIT ${Math.floor(limit)}` : '';
    const offsetClause = typeof offset === 'number' && offset > 0 ? ` OFFSET ${Math.floor(offset)}` : '';

    const rows = this.db
      .query(`SELECT * FROM session_tasks ${whereClause} ${orderClause}${limitClause}${offsetClause}`)
      .all(...params) as SessionTaskRow[];

    const totalRow = this.db.query(`SELECT COUNT(*) as count FROM session_tasks ${whereClause}`).get(...params) as {
      count: number;
    };

    return { rows, total: totalRow.count };
  }

  /**
   * Aggregate counts grouped by db status, ignoring archive filter so the
   * console's "Archived" tab can show its own row count without a second
   * round-trip. Returns an empty record when no rows.
   */
  countTasksByStatus(): Record<string, number> {
    const rows = this.db
      .query(
        'SELECT status, archived_at IS NULL AS active, COUNT(*) AS count FROM session_tasks GROUP BY status, archived_at IS NULL',
      )
      .all() as Array<{ status: string; active: number; count: number }>;
    const out: Record<string, number> = {};
    for (const r of rows) {
      const key = r.active ? r.status : `archived:${r.status}`;
      out[key] = (out[key] ?? 0) + r.count;
    }
    return out;
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
    return this.db.query('SELECT * FROM session_tasks ORDER BY created_at DESC LIMIT ?').all(limit) as SessionTaskRow[];
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
      (
        this.db
          .query('SELECT COALESCE(MAX(seq), -1) + 1 AS next FROM session_turns WHERE session_id = ?')
          .get(turn.sessionId) as { next: number }
      ).next;

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
    const row = this.db.query('SELECT COUNT(*) as count FROM session_turns WHERE session_id = ?').get(sessionId) as {
      count: number;
    };
    return row.count;
  }

  getTurn(turnId: string): Turn | undefined {
    const row = this.db.query('SELECT * FROM session_turns WHERE id = ?').get(turnId) as SessionTurnRow | undefined;
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
    this.db.run('UPDATE session_turns SET token_count_json = ? WHERE id = ?', [JSON.stringify(tokenCount), turnId]);
  }
}

/**
 * Reduce a free-form operator query to a safe FTS5 MATCH expression.
 *
 * FTS5 syntax pitfalls we defuse:
 *   - bare hyphen tokens (`task-id-foo`) — FTS5 treats `-` as NOT, so
 *     wrap any token containing `-`/`/`/`:` in quotes to make it
 *     literal.
 *   - dangling boolean operators (`partial AND`, `OR fail`) — strip
 *     trailing operators that would error out as syntax.
 *   - unmatched quotes — any odd-count `"` becomes a parse error;
 *     drop them entirely and fall back to bare-token AND semantics.
 *   - empty result — caller should LIKE-fall-back rather than match
 *     every row.
 *
 * The output is an FTS5 MATCH expression with implicit AND between
 * tokens (FTS5's default), which gives the operator console the
 * "all words must appear" semantics they expect.
 */
export function sanitizeFts5Query(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return '';
  // If quotes are unbalanced, drop them all and let the tokenizer split
  // on whitespace. Even-count quotes are passed through.
  const quoteCount = (trimmed.match(/"/g) ?? []).length;
  const quotedSafe = quoteCount % 2 === 0 ? trimmed : trimmed.replace(/"/g, '');
  const tokens = quotedSafe.split(/\s+/).filter((t) => t.length > 0);
  const cleaned: string[] = [];
  for (const tok of tokens) {
    const upper = tok.toUpperCase();
    // Strip lone boolean operators. They are only valid between terms.
    if (upper === 'AND' || upper === 'OR' || upper === 'NOT') continue;
    // Tokens with FTS5-special punctuation must be quoted to avoid
    // being interpreted as operators or column qualifiers.
    if (/[-/:()]/.test(tok)) {
      cleaned.push(`"${tok.replace(/"/g, '')}"`);
    } else {
      cleaned.push(tok);
    }
  }
  return cleaned.join(' ');
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
