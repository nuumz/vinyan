/**
 * Session Manager — groups tasks under sessions with compaction.
 *
 * A3 compliance: compaction is rule-based extraction, not LLM-generated.
 * I16: Original JSONL audit trail is never deleted by compaction.
 *
 * Source of truth: spec/tdd.md §22.3, §22.4
 */

import type { AppendResult, JsonlAppender } from '../db/session-jsonl/appender.ts';
import type { IndexRebuilder } from '../db/session-jsonl/rebuild-index.ts';
import type { Actor, Kind } from '../db/session-jsonl/schemas.ts';
import type {
  ListSessionsOptions,
  ListSessionTasksOptions,
  SessionMetadataPatch,
  SessionRow,
  SessionRowWithCount,
  SessionStore,
  SessionTaskRow,
} from '../db/session-store.ts';
import type { TraceStore } from '../db/trace-store.ts';
import type { ContextRetriever } from '../memory/retrieval.ts';
import type { ContentBlock, TaskInput, TaskResult, Turn, TurnTokenCount } from '../orchestrator/types.ts';
import type { UserMdObserver } from '../orchestrator/user-context/observer.ts';

/** Cap a JSON-serialized blocks payload for the turn_summary preview column. */
const BLOCKS_PREVIEW_LIMIT = 4096;

function blocksPreviewOf(blocks: ContentBlock[]): string {
  const json = JSON.stringify(blocks);
  return json.length > BLOCKS_PREVIEW_LIMIT ? json.slice(0, BLOCKS_PREVIEW_LIMIT) : json;
}

/**
 * Map a `TaskInput.source` string to a JSONL `actor.kind`. Most sources
 * fold into `'cli'` / `'api'`; gateways and ACP fold into `'system'`
 * since the line is created by the orchestrator boundary, not by an
 * end-user persona within the actor taxonomy.
 */
function actorKindForSource(source: string): Actor['kind'] {
  if (source === 'cli') return 'cli';
  if (source === 'api') return 'api';
  return 'system';
}
// Merge note: `classifyTurn` / `TurnImportance` from `./turn-importance.ts`
// were consumed by the Phase 1 priority-weighted compaction. A7 moved
// compaction to `src/memory/summary-ladder.ts`, so these imports are
// dropped here. The classifier itself remains available for future
// summary-ladder upgrades.

/**
 * Lifecycle state — the visibility/storage stage of the session.
 * Priority (highest first): trashed > archived > compacted > suspended > active.
 *
 * The raw `status` column carries only the lifecycle bookkeeping enum
 * (`active|suspended|compacted|closed`) and the `archived_at`/`deleted_at`
 * timestamps live in separate columns. Consumers (UI, CLI) want a single
 * dominant label per session, so we derive it once at the boundary instead
 * of asking every renderer to combine three fields.
 */
export type SessionLifecycleState = 'active' | 'suspended' | 'compacted' | 'closed' | 'archived' | 'trashed';

/**
 * Activity state — what the session is "doing" right now.
 *  - 'in-progress'   : at least one task is pending or running
 *  - 'waiting-input' : agent finished a turn with an [INPUT-REQUIRED] block
 *                      and has not yet received the user's reply. This is
 *                      the operator-attention signal the dashboard needs
 *                      most — without it the only way to spot a stalled
 *                      clarification is to open every session.
 *  - 'idle'          : has finished tasks but nothing in flight
 *  - 'empty'         : no tasks recorded yet
 *
 * Priority when multiple apply: in-progress > waiting-input > idle/empty.
 * `in-progress` wins because a live task means the agent is still working;
 * a stale [INPUT-REQUIRED] from an earlier turn is no longer the dominant
 * state.
 */
export type SessionActivityState = 'in-progress' | 'waiting-input' | 'idle' | 'empty';

export interface Session {
  id: string;
  source: string;
  status: SessionRow['status'];
  createdAt: number;
  updatedAt: number;
  taskCount: number;
  /** Subset of taskCount — tasks in 'pending' or 'running' state. */
  runningTaskCount: number;
  title: string | null;
  description: string | null;
  archivedAt: number | null;
  deletedAt: number | null;
  /** Derived single-label lifecycle state (see SessionLifecycleState doc). */
  lifecycleState: SessionLifecycleState;
  /** Derived activity state (see SessionActivityState doc). */
  activityState: SessionActivityState;
}

/**
 * Result envelope for lifecycle transitions. `applied=true` means the row
 * actually changed; `applied=false` means the action was rejected — `reason`
 * distinguishes a missing session from a state-conflict (e.g. trashing an
 * already-trashed session). HTTP handlers map `not_found` → 404 and
 * `invalid_state` → 409, and bus events fire only on real transitions.
 */
export interface LifecycleResult {
  applied: boolean;
  session: Session | null;
  reason?: 'not_found' | 'invalid_state';
}

export interface CreateSessionOptions {
  title?: string | null;
  description?: string | null;
}

export interface CompactionResult {
  sessionId: string;
  episodeSummary: string;
  keyFailures: string[];
  successfulPatterns: string[];
  statistics: {
    totalTasks: number;
    successRate: number;
    avgDurationMs: number;
    totalTokens: number;
  };
  compactedAt: number;
}

export class SessionManager {
  /**
   * Plan commit E4: optional ContextRetriever. When wired, every appended
   * Turn is indexed into sqlite-vec so core-loop.perceive (E5) can surface
   * semantic matches in addition to recency + pins. Fire-and-forget: the
   * retriever's indexTurn logs warnings but never raises, so a failing
   * embedding call cannot cascade into a lost conversation turn.
   *
   * Phase 2 hybrid storage: optional JsonlAppender + IndexRebuilder.
   * When both are wired (production via `serve.ts` / `chat.ts` when
   * `session.dualWrite.enabled=true`), every public mutator first
   * appends a JSONL line then writes SQLite. JSONL is the source of
   * truth; SQLite is dual-written. Tests that omit them get the
   * legacy SQLite-only path unchanged.
   */
  constructor(
    private sessionStore: SessionStore,
    private traceStore?: TraceStore,
    private retriever?: ContextRetriever,
    private jsonlAppender?: JsonlAppender,
    private indexRebuilder?: IndexRebuilder,
  ) {}

  /**
   * Wire JSONL hybrid layer post-construction. Mirrors the existing
   * late-bind pattern (`attachTraceStore`, `setUserMdObserver`) — the
   * factory order in `cli/serve.ts` already constructs SessionManager
   * before some of its collaborators are available.
   */
  attachJsonlLayer(appender: JsonlAppender, rebuilder: IndexRebuilder): void {
    this.jsonlAppender = appender;
    this.indexRebuilder = rebuilder;
  }

  /** True when dual-write is wired. Used by tests + verifier. */
  hasJsonlLayer(): boolean {
    return this.jsonlAppender !== undefined;
  }

  // ── JSONL hybrid helpers ────────────────────────────────────────────────

  /**
   * Append a JSONL line for `kind` if dual-write is wired. Returns the
   * appender result (incl. byte offset) so the caller can update the
   * SQLite cursor. Returns undefined when dual-write is off.
   *
   * Throws on JSONL write failure — by design (JSONL is source of
   * truth; if we can't durably record the event we must NOT touch
   * SQLite or the two stores would silently diverge).
   */
  private appendJsonl(sessionId: string, kind: Kind, payload: unknown, actor: Actor): AppendResult | undefined {
    if (!this.jsonlAppender) return undefined;
    return this.jsonlAppender.appendSync(sessionId, { kind, payload, actor });
  }

  /** Record `last_line_id` / `last_line_offset` on the session row. */
  private applyJsonlCursor(sessionId: string, result: AppendResult | undefined): void {
    if (!result) return;
    try {
      this.sessionStore.updateLastLineCursor(sessionId, result.line.lineId, result.byteOffset + result.byteLength);
    } catch (err) {
      // JSONL is committed; index update failed. Schedule async rebuild
      // to catch the cursor up. Do not throw — JSONL is canonical.
      this.scheduleIndexRebuild(sessionId, err);
    }
  }

  /**
   * Schedule an async index rebuild after a SQLite write failed
   * post-JSONL-commit. Best-effort: logs and moves on if the
   * rebuilder is missing or itself errors.
   */
  private scheduleIndexRebuild(sessionId: string, cause: unknown): void {
    console.warn(`[vinyan] session ${sessionId} index drift after JSONL append; scheduling rebuild`, cause);
    if (!this.indexRebuilder) return;
    Promise.resolve().then(() => {
      try {
        this.indexRebuilder?.rebuildSessionIndex(sessionId);
      } catch (err) {
        console.error(`[vinyan] async rebuild failed for ${sessionId}: ${String(err)}`);
      }
    });
  }

  /**
   * P3 USER.md dialectic hook. Optional — the factory-wiring coordinator pass
   * installs this after SessionManager is constructed (see
   * `src/orchestrator/user-context/wiring.ts`). When set, `recordUserTurn`
   * feeds each user turn through the observer so deltas are ledgered for the
   * rolling dialectic rule. Never required; its absence degrades silently.
   */
  private userMdObserver?: UserMdObserver;

  /** Accessor for direct DB queries (e.g. keyword extraction for user-context mining). */
  getSessionStore(): SessionStore {
    return this.sessionStore;
  }

  /**
   * Late-bind the TraceStore. The factory wires it AFTER SessionManager is
   * constructed (the order is `sessionStore → sessionManager → orchestrator
   * → traceStore`). Without this, `getConversationHistoryDetailed` silently
   * skips the `traceSummary` block and the chat UI loses model / agent /
   * routing-level chips on every historical message.
   */
  attachTraceStore(traceStore: TraceStore): void {
    this.traceStore = traceStore;
  }

  /** Plan commit E4: accessor so core-loop can pull the retriever without re-plumbing. */
  getContextRetriever(): ContextRetriever | undefined {
    return this.retriever;
  }

  /**
   * Factory-wiring hook for the P3 USER.md dialectic. Called once after
   * construction by the coordinator pass (intentionally NOT a constructor
   * parameter so the factory can stay lean). Passing `undefined` clears it.
   */
  setUserMdObserver(observer: UserMdObserver | undefined): void {
    this.userMdObserver = observer;
  }

  create(source: string, options: CreateSessionOptions = {}): Session {
    const id = crypto.randomUUID();
    const now = Date.now();
    const title = normalizeMetadata(options.title);
    const description = normalizeMetadata(options.description);

    // JSONL append first — JSONL is source of truth in Phase 2+.
    const jsonl = this.appendJsonl(
      id,
      'session.created',
      { source, title, description },
      { kind: actorKindForSource(source) },
    );

    this.sessionStore.insertSession({
      id,
      source,
      created_at: now,
      status: 'active',
      working_memory_json: null,
      compaction_json: null,
      updated_at: now,
      title,
      description,
      archived_at: null,
      deleted_at: null,
    });
    this.applyJsonlCursor(id, jsonl);

    return rowToSession(
      {
        id,
        source,
        created_at: now,
        status: 'active',
        working_memory_json: null,
        compaction_json: null,
        updated_at: now,
        title,
        description,
        archived_at: null,
        deleted_at: null,
      },
      0,
      0,
      null,
    );
  }

  listSessions(options: ListSessionsOptions = {}): Session[] {
    const rows = this.sessionStore.listSessions(options);
    return rows.map(rowWithCountToSession);
  }

  /**
   * Read a session row by id WITHOUT applying the visibility filter — the
   * UI needs to be able to navigate to archived/trashed sessions to
   * unarchive or restore them. Callers that should hide deleted sessions
   * must check `deletedAt` themselves.
   */
  get(sessionId: string): Session | undefined {
    const row = this.sessionStore.getSession(sessionId);
    if (!row) return undefined;
    const latest = this.sessionStore.getLatestTurnRoleAndBlocks(sessionId);
    return rowToSession(
      row,
      this.sessionStore.countSessionTasks(sessionId),
      this.sessionStore.countRunningTasks(sessionId),
      latest ? { role: latest.role, blocksJson: latest.blocks_json } : null,
    );
  }

  /**
   * Patch operator-supplied metadata. Pass `null` to clear a field; pass
   * `undefined` (omit) to leave it unchanged. Returns the updated session
   * or `undefined` when no row matched.
   */
  updateMetadata(sessionId: string, patch: SessionMetadataPatch): Session | undefined {
    const normalized: SessionMetadataPatch = {};
    if (patch.title !== undefined) normalized.title = normalizeMetadata(patch.title);
    if (patch.description !== undefined) normalized.description = normalizeMetadata(patch.description);
    if (Object.keys(normalized).length === 0) return this.get(sessionId);
    // Probe existence first so we don't write a JSONL line for a missing session.
    if (!this.sessionStore.getSession(sessionId)) return undefined;
    const jsonl = this.appendJsonl(sessionId, 'session.metadata.updated', normalized, { kind: 'user' });
    const ok = this.sessionStore.updateSessionMetadata(sessionId, normalized);
    if (!ok) return undefined;
    this.applyJsonlCursor(sessionId, jsonl);
    return this.get(sessionId);
  }

  /**
   * Archive flow: only valid from "active" (no archived_at, no deleted_at).
   * The `applied` flag distinguishes "actually moved to archive" from "no-op
   * because already archived/trashed" so HTTP can return the right status
   * code and the bus only emits on real transitions.
   */
  archive(sessionId: string): LifecycleResult {
    const before = this.sessionStore.getSession(sessionId);
    if (!before) return { applied: false, session: null, reason: 'not_found' };
    if (before.archived_at !== null || before.deleted_at !== null) {
      return { applied: false, session: this.get(sessionId)!, reason: 'invalid_state' };
    }
    const jsonl = this.appendJsonl(sessionId, 'session.archived', {}, { kind: 'user' });
    const ok = this.sessionStore.archiveSession(sessionId);
    this.applyJsonlCursor(sessionId, jsonl);
    return { applied: ok, session: this.get(sessionId)! };
  }

  /** Unarchive: valid only from "archived" (archived_at set, not trashed). */
  unarchive(sessionId: string): LifecycleResult {
    const before = this.sessionStore.getSession(sessionId);
    if (!before) return { applied: false, session: null, reason: 'not_found' };
    if (before.archived_at === null || before.deleted_at !== null) {
      return { applied: false, session: this.get(sessionId)!, reason: 'invalid_state' };
    }
    const jsonl = this.appendJsonl(sessionId, 'session.unarchived', {}, { kind: 'user' });
    const ok = this.sessionStore.unarchiveSession(sessionId);
    this.applyJsonlCursor(sessionId, jsonl);
    return { applied: ok, session: this.get(sessionId)! };
  }

  /** Soft-delete — audit trail (turns/tasks/traces) is preserved (I16). */
  softDelete(sessionId: string): LifecycleResult {
    const before = this.sessionStore.getSession(sessionId);
    if (!before) return { applied: false, session: null, reason: 'not_found' };
    if (before.deleted_at !== null) {
      return { applied: false, session: this.get(sessionId)!, reason: 'invalid_state' };
    }
    const jsonl = this.appendJsonl(sessionId, 'session.deleted', {}, { kind: 'user' });
    const ok = this.sessionStore.softDeleteSession(sessionId);
    this.applyJsonlCursor(sessionId, jsonl);
    return { applied: ok, session: this.get(sessionId)! };
  }

  /** Restore from Trash: valid only when the row is currently trashed. */
  restore(sessionId: string): LifecycleResult {
    const before = this.sessionStore.getSession(sessionId);
    if (!before) return { applied: false, session: null, reason: 'not_found' };
    if (before.deleted_at === null) {
      return { applied: false, session: this.get(sessionId)!, reason: 'invalid_state' };
    }
    const jsonl = this.appendJsonl(sessionId, 'session.restored', {}, { kind: 'user' });
    const ok = this.sessionStore.restoreSession(sessionId);
    this.applyJsonlCursor(sessionId, jsonl);
    return { applied: ok, session: this.get(sessionId)! };
  }

  /**
   * Permanent removal — rejects unless the session is already trashed
   * (`deletedAt` is set). Two-step flow (soft → hard) is intentional: the
   * UI's "Trash" tab is the recoverable holding area; "permanently delete"
   * lives there as a separate action to prevent one-click data loss.
   *
   * Returns `applied=true` when the row is gone. `session` is null on
   * success (nothing left to surface). I16 audit trail caveat: traces and
   * turn embeddings tied to this session also disappear — this is the
   * point of hard delete; if you need durability use archive instead.
   */
  hardDelete(sessionId: string): LifecycleResult {
    const before = this.sessionStore.getSession(sessionId);
    if (!before) return { applied: false, session: null, reason: 'not_found' };
    if (before.deleted_at === null) {
      return { applied: false, session: this.get(sessionId)!, reason: 'invalid_state' };
    }
    // session.purged carries the policy so a future tombstone GC can
    // distinguish a tombstone-rooted purge from a true `purge` policy.
    // `policy` reflects current config; the actual fs-side handling
    // (move-to-tombstone vs rm -rf) is Phase 5 hardening.
    this.appendJsonl(sessionId, 'session.purged', { policy: 'tombstone' }, { kind: 'user' });
    const ok = this.sessionStore.hardDeleteSession(sessionId);
    // No applyJsonlCursor: the row is gone, the cursor update would
    // either no-op or violate FK once the session_store row is deleted.
    return { applied: ok, session: null };
  }

  /**
   * Empty Trash — hard-delete every currently-trashed session in one call.
   *
   * Each row is removed via `hardDeleteSession`, so each session keeps its
   * own transactional cleanup of tasks/turns/embeddings. We deliberately
   * do NOT wrap the loop in a single outer transaction: a malformed row
   * deep in the batch should not roll back the rows that already deleted
   * cleanly, and the operator can rerun the call to retry stragglers.
   *
   * Returns the ids that actually disappeared so HTTP can fan out one
   * `session:purged` bus event per session — UI subscribers (Sessions
   * list, Trash badge) get a precise removal stream rather than a single
   * "trash emptied" broadcast they'd have to interpret.
   */
  emptyTrash(): { deleted: number; sessionIds: string[] } {
    const ids = this.sessionStore.listTrashedSessionIds();
    const removed: string[] = [];
    for (const id of ids) {
      if (this.sessionStore.hardDeleteSession(id)) removed.push(id);
    }
    return { deleted: removed.length, sessionIds: removed };
  }

  addTask(sessionId: string, taskInput: TaskInput): void {
    const now = Date.now();
    const jsonl = this.appendJsonl(
      sessionId,
      'task.created',
      { taskId: taskInput.id, input: taskInput },
      { kind: 'orchestrator' },
    );
    this.sessionStore.insertTask({
      session_id: sessionId,
      task_id: taskInput.id,
      task_input_json: JSON.stringify(taskInput),
      status: 'pending',
      result_json: null,
      created_at: now,
      updated_at: now,
      archived_at: null,
    });
    this.applyJsonlCursor(sessionId, jsonl);
  }

  completeTask(sessionId: string, taskId: string, result: TaskResult): void {
    // Agent Conversation: an `input-required` turn is NOT a failure —
    // the agent finished its work for this turn and is waiting for the user.
    // Store it as 'completed' in session_tasks (the full result JSON still
    // carries status='input-required' in result_json for downstream readers).
    // The session_tasks CHECK constraint does not allow 'input-required', so
    // we map at this boundary.
    const dbStatus = result.status === 'completed' || result.status === 'input-required' ? 'completed' : 'failed';
    const prior = this.sessionStore.getTask(sessionId, taskId);
    const jsonl = this.appendJsonl(
      sessionId,
      'task.status.changed',
      { taskId, from: prior?.status ?? 'pending', to: dbStatus, result },
      { kind: 'orchestrator' },
    );
    this.sessionStore.updateTaskStatus(sessionId, taskId, dbStatus, JSON.stringify(result));
    this.applyJsonlCursor(sessionId, jsonl);
  }

  /**
   * Persist a `cancelled` row (operations console / DELETE /tasks/:id).
   *
   * Distinct from `completeTask` so callers don't have to fabricate a fake
   * `TaskResult` envelope for a row that was killed before finishing. The
   * caller still owns emitting `task:cancelled` on the bus — recording an
   * event is not this method's responsibility.
   */
  cancelTask(sessionId: string, taskId: string, reason?: string): boolean {
    const existing = this.sessionStore.getTask(sessionId, taskId);
    if (!existing) return false;
    // Idempotent: cancelling a row that already terminated is a no-op so
    // the operator can hit Cancel on a stale row without poisoning state.
    if (existing.status !== 'pending' && existing.status !== 'running') return false;
    const reasonText = reason ?? 'Cancelled by operator';
    const cancelledResultObj = {
      id: taskId,
      status: 'failed' as const,
      mutations: [],
      cancelled: true,
      cancelReason: reasonText,
      cancelledAt: Date.now(),
    };
    const jsonl = this.appendJsonl(
      sessionId,
      'task.status.changed',
      { taskId, from: existing.status, to: 'cancelled', result: cancelledResultObj },
      { kind: 'orchestrator' },
    );
    this.sessionStore.updateTaskStatus(sessionId, taskId, 'cancelled', JSON.stringify(cancelledResultObj));
    this.applyJsonlCursor(sessionId, jsonl);
    return true;
  }

  /** Archive a task row (soft-hide; audit trail preserved). */
  archiveTask(taskId: string): boolean {
    // archiveTaskRow only takes a task id, but JSONL is keyed per session.
    // Look up the session to log the line; bail before the SQLite call if
    // the task is unknown so we don't write an orphan line.
    const taskRow = this.sessionStore.findTaskRowById(taskId);
    if (!taskRow) return false;
    const jsonl = this.appendJsonl(taskRow.session_id, 'task.archived', { taskId }, { kind: 'user' });
    const ok = this.sessionStore.archiveTaskRow(taskId);
    if (ok) this.applyJsonlCursor(taskRow.session_id, jsonl);
    return ok;
  }

  /** Restore an archived task row. */
  unarchiveTask(taskId: string): boolean {
    return this.sessionStore.unarchiveTaskRow(taskId);
  }

  /**
   * Rule-based session compaction (A3-compliant — no LLM in this path).
   *
   * Extracts patterns from completed tasks without deleting audit data (I16).
   */
  compact(sessionId: string): CompactionResult {
    const tasks = this.sessionStore.listSessionTasks(sessionId);
    const completedTasks = tasks.filter((t) => t.status === 'completed' || t.status === 'failed');

    // Compute statistics
    let totalDurationMs = 0;
    let totalTokens = 0;
    let successes = 0;
    const failures: string[] = [];
    const patterns: string[] = [];

    for (const task of completedTasks) {
      if (task.result_json) {
        try {
          const result = JSON.parse(task.result_json) as TaskResult;
          totalDurationMs += result.trace?.durationMs ?? 0;
          totalTokens += result.trace?.tokensConsumed ?? 0;

          if (result.status === 'completed') {
            successes++;
            // Extract successful approach as pattern
            if (result.trace?.approach) {
              patterns.push(`${result.trace.taskTypeSignature}: ${result.trace.approach}`);
            }
          } else {
            if (result.escalationReason) failures.push(result.escalationReason);
            else if (result.trace?.failureReason) failures.push(result.trace.failureReason);
          }
        } catch {
          // Malformed result — skip
        }
      }
    }

    const totalTasks = completedTasks.length;
    const compactionResult: CompactionResult = {
      sessionId,
      episodeSummary: `Session with ${totalTasks} tasks: ${successes} succeeded, ${totalTasks - successes} failed`,
      keyFailures: [...new Set(failures)].slice(0, 10),
      successfulPatterns: [...new Set(patterns)].slice(0, 10),
      statistics: {
        totalTasks,
        successRate: totalTasks > 0 ? successes / totalTasks : 0,
        avgDurationMs: totalTasks > 0 ? totalDurationMs / totalTasks : 0,
        totalTokens,
      },
      compactedAt: Date.now(),
    };

    // Persist compaction result — additive only, never deletes audit trail (I16)
    const jsonl = this.appendJsonl(
      sessionId,
      'session.compacted',
      { taskCount: totalTasks, compaction: compactionResult },
      { kind: 'system' },
    );
    this.sessionStore.updateSessionCompaction(sessionId, JSON.stringify(compactionResult));
    this.applyJsonlCursor(sessionId, jsonl);

    return compactionResult;
  }

  /** List recent tasks across all sessions (newest first). */
  listAllTasks(
    limit = 100,
  ): Array<{ taskId: string; sessionId: string; status: string; goal?: string; result?: TaskResult }> {
    const rows = this.sessionStore.listRecentTasks(limit);
    return rows.map((row) => projectTaskRow(row));
  }

  /**
   * Filtered task list for the operations console. Returns matched rows
   * along with the unfiltered total (so the UI can paginate) and a per-
   * status counts breakdown for the summary strip.
   *
   * Unlike `listAllTasks`, the projected status PRESERVES the original
   * `TaskResult.status` (`escalated`, `uncertain`, `partial`, `input-
   * required`) instead of collapsing everything non-completed to `failed`.
   * The DB row's CHECK constraint can only hold a small enum, but the
   * console needs the richer status to render the right badge.
   */
  listTasksFiltered(opts: ListSessionTasksOptions = {}): {
    tasks: Array<{
      taskId: string;
      sessionId: string;
      status: string;
      dbStatus: SessionTaskRow['status'];
      goal?: string;
      result?: TaskResult;
      taskInput?: TaskInput;
      createdAt: number;
      updatedAt: number;
      archivedAt: number | null;
    }>;
    total: number;
  } {
    const { rows, total } = this.sessionStore.listTasksFiltered(opts);
    return {
      tasks: rows.map((row) => {
        const projection = projectTaskRow(row);
        let taskInput: TaskInput | undefined;
        try {
          taskInput = JSON.parse(row.task_input_json) as TaskInput;
        } catch {
          /* best effort */
        }
        return {
          taskId: projection.taskId,
          sessionId: projection.sessionId,
          status: projection.status,
          dbStatus: row.status,
          goal: projection.goal,
          result: projection.result,
          taskInput,
          createdAt: row.created_at,
          updatedAt: row.updated_at ?? row.created_at,
          archivedAt: row.archived_at,
        };
      }),
      total,
    };
  }

  /** Aggregate counts by db-status for the summary strip. */
  countTasksByStatus(): Record<string, number> {
    return this.sessionStore.countTasksByStatus();
  }

  /**
   * Rich detail for one task — used by the operations console drawer.
   * Reads the session_tasks row plus the matching trace summary if a
   * trace store is wired. Returns `null` when the task is not tracked
   * in any session (in-memory async tasks fall back to the API server's
   * own `asyncResults` map).
   */
  getTaskDetail(taskId: string): {
    taskId: string;
    sessionId: string;
    status: string;
    dbStatus: SessionTaskRow['status'];
    goal?: string;
    taskInput?: TaskInput;
    result?: TaskResult;
    createdAt: number;
    updatedAt: number;
    archivedAt: number | null;
  } | null {
    const row = this.sessionStore.findTaskRowById(taskId);
    if (!row) return null;
    const projection = projectTaskRow(row);
    let taskInput: TaskInput | undefined;
    try {
      taskInput = JSON.parse(row.task_input_json) as TaskInput;
    } catch {
      /* best effort */
    }
    return {
      taskId: projection.taskId,
      sessionId: projection.sessionId,
      status: projection.status,
      dbStatus: row.status,
      goal: projection.goal,
      taskInput,
      result: projection.result,
      createdAt: row.created_at,
      updatedAt: row.updated_at ?? row.created_at,
      archivedAt: row.archived_at,
    };
  }

  /**
   * Look up a session-tracked task by id and return the original `TaskInput`
   * along with `sessionId` and the recorded `TaskResult` (if completed).
   *
   * Used by the manual-retry endpoint so it can spawn a sibling task that
   * preserves session, goal, target files, and constraints from the parent.
   * Returns `null` if the task isn't tracked (in-memory async tasks fall
   * back to the caller's own bookkeeping).
   */
  getTaskById(taskId: string): { sessionId: string; status: string; input: TaskInput; result?: TaskResult } | null {
    const rows = this.sessionStore.listRecentTasks(500);
    const row = rows.find((r) => r.task_id === taskId);
    if (!row) return null;
    let input: TaskInput;
    try {
      input = JSON.parse(row.task_input_json) as TaskInput;
    } catch {
      return null;
    }
    let result: TaskResult | undefined;
    if (row.result_json) {
      try {
        result = JSON.parse(row.result_json) as TaskResult;
      } catch {
        /* best effort */
      }
    }
    return { sessionId: row.session_id, status: row.status, input, result };
  }

  /**
   * Recover suspended sessions on startup — reactivates them so they can accept new messages.
   */
  recover(): Session[] {
    const suspended = this.sessionStore.listSuspendedSessions();
    for (const row of suspended) {
      this.sessionStore.updateSessionStatus(row.id, 'active');
    }
    return suspended.map((row) => {
      const latest = this.sessionStore.getLatestTurnRoleAndBlocks(row.id);
      return rowToSession(
        { ...row, status: 'active' },
        this.sessionStore.countSessionTasks(row.id),
        this.sessionStore.countRunningTasks(row.id),
        latest ? { role: latest.role, blocksJson: latest.blocks_json } : null,
      );
    });
  }

  /**
   * Sweep tasks that were in `pending` / `running` when the server last
   * exited. Each in-memory `inFlightTasks` Map is reset on restart, but the
   * `session_tasks` row stays at its last persisted status — so without
   * this sweep, the row is effectively orphaned: the chat shows the user
   * message with no agent reply, the Sessions list reports a phantom
   * `runningTaskCount`, and `countRunningTasks` keeps counting the dead row
   * forever.
   *
   * For each orphan we synthesize a `failed` TaskResult, transition the
   * row via `completeTask`, AND record an assistant turn explaining the
   * interruption so the chat history is coherent. The sweep is idempotent
   * by query: `listPendingTasks()` only returns rows in pending/running
   * state, so a recovered orphan (now `failed`) won't be picked up again.
   *
   * MUST run during cli/serve.ts startup — after the orchestrator has
   * initialised the DB but BEFORE the API listener accepts traffic, so
   * incoming clients never see the half-state.
   */
  recoverOrphanedTasks(): { recovered: number; sessions: string[] } {
    const orphaned = this.sessionStore.listPendingTasks();
    if (orphaned.length === 0) return { recovered: 0, sessions: [] };

    const touchedSessions = new Set<string>();
    let recovered = 0;
    for (const row of orphaned) {
      try {
        const taskInput = JSON.parse(row.task_input_json) as TaskInput;
        const interruptionReason = 'Task interrupted by server restart — no completion event was recorded.';
        const syntheticResult: TaskResult = {
          id: row.task_id,
          status: 'failed',
          mutations: [],
          trace: {
            id: `trace-${row.task_id}-orphan-recovery`,
            taskId: row.task_id,
            sessionId: row.session_id,
            workerId: 'recovery',
            timestamp: Date.now(),
            routingLevel: 0,
            approach: 'orphan-recovery',
            oracleVerdicts: {},
            modelUsed: 'none',
            tokensConsumed: 0,
            durationMs: Math.max(0, Date.now() - row.created_at),
            outcome: 'failure',
            failureReason: interruptionReason,
            affectedFiles: taskInput.targetFiles ?? [],
          },
          escalationReason: interruptionReason,
          answer: interruptionReason,
        };
        this.completeTask(row.session_id, row.task_id, syntheticResult);
        this.recordAssistantTurn(row.session_id, row.task_id, syntheticResult);
        // Overwrite any partial pre-restart trace so the chat's agent chip
        // reads `recovery` instead of whichever phase was mid-flight when
        // the process died (e.g. `comprehension-phase`). Without this, the
        // user sees "agent: comprehension-phase" labelling a "Task
        // interrupted by server restart" message — incoherent. Best-effort.
        if (this.traceStore) {
          try {
            this.traceStore.insert(syntheticResult.trace);
          } catch (err) {
            console.warn(`[vinyan] recoverOrphanedTasks: traceStore.insert failed for ${row.task_id}: ${String(err)}`);
          }
        }
        touchedSessions.add(row.session_id);
        recovered += 1;
      } catch (err) {
        // Don't let one corrupt row block the whole sweep — at minimum
        // mark it failed so listPendingTasks won't keep returning it.
        console.warn(`[vinyan] recoverOrphanedTasks: failed to recover ${row.task_id}: ${String(err)}`);
        try {
          this.sessionStore.updateTaskStatus(row.session_id, row.task_id, 'failed');
        } catch {
          /* swallow secondary failure */
        }
      }
    }
    return { recovered, sessions: [...touchedSessions] };
  }

  /**
   * Suspend all active sessions (for graceful shutdown).
   */
  suspendAll(): number {
    const active = this.sessionStore.listActiveSessions();
    for (const session of active) {
      this.sessionStore.updateSessionStatus(session.id, 'suspended');
    }
    return active.length;
  }

  // ── Conversation Methods (Conversation Agent Mode) ──────

  /**
   * Record a user message in the conversation history.
   *
   * A7: session_messages legacy write removed. Turn-only persistence now.
   */
  recordUserTurn(sessionId: string, content: string): void {
    const now = Date.now();
    const turnId = crypto.randomUUID();
    const blocks: ContentBlock[] = [{ type: 'text', text: content }];
    const tokenCount: TurnTokenCount = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 };

    // JSONL append first so JSONL is canonical even if SQLite throws.
    const jsonl = this.appendJsonl(
      sessionId,
      'turn.appended',
      { turnId, role: 'user', blocks, tokenCount },
      { kind: 'user' },
    );

    const persisted = this.sessionStore.appendTurn({
      id: turnId,
      sessionId,
      role: 'user',
      blocks,
      tokenCount,
      createdAt: now,
      seq: jsonl?.line.seq,
    });
    if (jsonl) {
      this.sessionStore.upsertTurnSummary(sessionId, {
        latestSeq: jsonl.line.seq,
        latestTurnId: turnId,
        latestTurnRole: 'user',
        latestBlocksPreview: blocksPreviewOf(blocks),
        turnCountDelta: 1,
        updatedAt: now,
      });
    }
    this.applyJsonlCursor(sessionId, jsonl);
    // E4: fire-and-forget semantic index. Retriever.indexTurn is best-effort —
    // it logs on failure (dimension mismatch, sqlite-vec unavailable, network
    // error from embedding provider) but does NOT raise. A failed index
    // degrades to recency-only retrieval; the conversation turn itself is
    // already persisted above.
    this.indexTurnAsync(persisted);
    // P3 USER.md dialectic: ledger observed-vs-predicted delta per section.
    // Best-effort — never blocks turn processing (A3).
    const observer = this.userMdObserver;
    if (observer) {
      try {
        observer.observeTurn({ turnId: persisted.id, userText: content, ts: now });
      } catch (err) {
        console.warn(`[vinyan] SessionManager.userMdObserver.observeTurn failed: ${String(err)}`);
      }
    }
  }

  /**
   * E4 helper: index a turn into the retriever in the background. Extracted
   * so both record* paths share a single error-handling site and unit tests
   * can assert "exactly one indexTurn call per record call".
   */
  private indexTurnAsync(turn: Turn): void {
    const retriever = this.retriever;
    if (!retriever) return;
    // Detach: Promise chain runs after the current event-loop tick.
    Promise.resolve()
      .then(() => retriever.indexTurn(turn))
      .catch((err) => {
        console.warn(`[vinyan] SessionManager.indexTurnAsync failed: ${String(err)}`);
      });
  }

  /** Record an assistant response from a TaskResult. */
  recordAssistantTurn(sessionId: string, taskId: string, result: TaskResult): void {
    // Agent Conversation: for input-required turns, store clarification
    // questions in a structured [INPUT-REQUIRED] block so compaction and
    // next-turn grounding can parse them with pure text matching (A3).
    let content: string;
    if (result.status === 'input-required' && result.clarificationNeeded && result.clarificationNeeded.length > 0) {
      const questionLines = result.clarificationNeeded.map((q) => `- ${q}`).join('\n');
      const preamble = result.answer ? `${result.answer}\n\n` : '';
      content = `${preamble}[INPUT-REQUIRED]\n${questionLines}`;
    } else {
      // Fallback chain for the bubble body:
      //   1. agent-provided answer (reasoning/Q&A output, timeout explanation, …)
      //   2. mutation summary (file-change tasks)
      //   3. trace-derived synopsis for failures that carry neither
      //   4. last-resort placeholder — only reached when we have nothing at all
      const mutationSummary = result.mutations.map((m) => `Modified ${m.file}`).join('\n');
      let fallback = '(no response)';
      if (result.status === 'failed' || result.status === 'escalated') {
        const reason = result.trace?.failureReason ?? result.escalationReason;
        const approach = result.trace?.approach;
        if (reason || approach) {
          fallback = `Task did not complete (${result.status}${approach ? `, ${approach}` : ''})${reason ? `: ${reason}` : '.'}`;
        }
      }
      content = result.answer ?? (mutationSummary || fallback);
    }
    const now = Date.now();

    // A7: session_messages legacy write removed. Turn-only persistence.
    // Each mutation becomes a tool_use block so the Turn-model consumer
    // preserves structural information. Text content + thinking are kept
    // as distinct blocks (Anthropic-native order: thinking → text).
    const blocks: ContentBlock[] = [];
    if (result.thinking && result.thinking.trim().length > 0) {
      blocks.push({ type: 'thinking', thinking: result.thinking });
    }
    if (content.trim().length > 0) {
      blocks.push({ type: 'text', text: content });
    }
    for (const mutation of result.mutations) {
      blocks.push({
        type: 'tool_use',
        id: `mut-${taskId}-${mutation.file}`,
        name: 'write_file',
        input: { path: mutation.file, diff: mutation.diff },
      });
    }
    const tokenCount: TurnTokenCount = {
      input: 0,
      output: result.trace?.tokensConsumed ?? 0,
      cacheRead: 0,
      cacheCreation: 0,
    };
    const turnId = crypto.randomUUID();
    const finalBlocks = blocks.length > 0 ? blocks : [{ type: 'text' as const, text: content }];

    const jsonl = this.appendJsonl(
      sessionId,
      'turn.appended',
      { turnId, role: 'assistant', blocks: finalBlocks, tokenCount, taskId },
      { kind: 'agent' },
    );

    const persisted = this.sessionStore.appendTurn({
      id: turnId,
      sessionId,
      role: 'assistant',
      blocks: finalBlocks,
      tokenCount,
      taskId,
      createdAt: now,
      seq: jsonl?.line.seq,
    });
    if (jsonl) {
      this.sessionStore.upsertTurnSummary(sessionId, {
        latestSeq: jsonl.line.seq,
        latestTurnId: turnId,
        latestTurnRole: 'assistant',
        latestBlocksPreview: blocksPreviewOf(finalBlocks),
        turnCountDelta: 1,
        updatedAt: now,
      });
    }
    this.applyJsonlCursor(sessionId, jsonl);
    // E4: semantic index. Same fire-and-forget contract as recordUserTurn.
    this.indexTurnAsync(persisted);
  }

  /**
   * Agent Conversation: extract pending clarification questions from the
   * latest assistant message, if that message is an [INPUT-REQUIRED] block
   * AND no subsequent user message has been recorded yet.
   *
   * Returns an empty array when:
   *  - No session exists
   *  - The latest message is not an assistant [INPUT-REQUIRED]
   *  - The user has already answered (there is a user message after it)
   *
   * Pure text matching — A3 compliant, no LLM.
   */
  getPendingClarifications(sessionId: string): string[] {
    // A7: Turn-model lookup. Extract [INPUT-REQUIRED] questions from the
    // latest assistant turn's text blocks.
    const turns = this.sessionStore.getTurns(sessionId);
    if (turns.length === 0) return [];

    const last = turns[turns.length - 1]!;
    // Already answered → user turn appears after the clarification.
    if (last.role === 'user') return [];
    const text = last.blocks
      .filter((b): b is Extract<typeof b, { type: 'text' }> => b.type === 'text')
      .map((b) => b.text)
      .join('\n');
    return parseInputRequiredBlock(text);
  }

  /**
   * Agent Conversation: find the goal text of the "root" user task that the
   * current pending clarifications are attached to. Walks the message history
   * backward: every [assistant-[INPUT-REQUIRED], user-reply] pair is a
   * clarification round answering the same underlying task, so we skip past
   * it and return the most recent user message that was NOT itself a
   * clarification reply.
   *
   * Returns null when no root user goal can be located (empty session or
   * malformed history).
   *
   * Used by POST /sessions/:id/messages to preserve the original task goal
   * when the user's reply would otherwise overwrite it — without this, the
   * next task's goal becomes the clarification answer instead of the task.
   *
   * Pure text matching — A3 compliant, no LLM.
   */
  getOriginalTaskGoal(sessionId: string): string | null {
    // A7: Turn-model. Walk backward skipping [assistant-[INPUT-REQUIRED],
    // user-reply] clarification pairs to find the last non-clarification
    // user turn.
    const turns = this.sessionStore.getTurns(sessionId);
    if (turns.length === 0) return null;

    const turnText = (t: import('../orchestrator/types.ts').Turn): string =>
      t.blocks
        .filter((b): b is Extract<typeof b, { type: 'text' }> => b.type === 'text')
        .map((b) => b.text)
        .join('\n');

    let i = turns.length - 1;
    while (i >= 0) {
      const t = turns[i]!;
      if (t.role === 'user') {
        const prev = i > 0 ? turns[i - 1] : null;
        const isClarificationReply = prev?.role === 'assistant' && turnText(prev).includes('[INPUT-REQUIRED]');
        if (!isClarificationReply) return turnText(t);
        // skip this reply and the clarification that triggered it
        i -= 2;
        continue;
      }
      i -= 1;
    }
    return null;
  }

  /** Get the number of conversation turns in a session. */
  getMessageCount(sessionId: string): number {
    return this.sessionStore.countTurns(sessionId);
  }

  /**
   * Plan commit A (A5): Turn-model history for core-loop + workers.
   *
   * Returns the newest-N turns from `session_turns` in chronological order,
   * trimmed by a token-like budget (uses block text length as proxy since
   * Turn rows carry cache-tier counts, not prompt-token estimates).
   */
  getTurnsHistory(sessionId: string, maxTurns = 20): Turn[] {
    return this.sessionStore.getRecentTurns(sessionId, maxTurns);
  }

  /** Load working memory JSON from a session (for cross-turn learning). */
  getSessionWorkingMemory(sessionId: string): string | null {
    const session = this.sessionStore.getSession(sessionId);
    return session?.working_memory_json ?? null;
  }

  /** Persist a working memory snapshot to the session store. */
  saveSessionWorkingMemory(sessionId: string, memoryJson: string): void {
    this.sessionStore.updateSessionMemory(sessionId, memoryJson);
  }

  // A7: getConversationHistoryCompacted + enforceTokenBudget removed.
  // The ContextRetriever's summary ladder (src/memory/summary-ladder.ts)
  // supersedes the compaction logic that used to live here. Callers that
  // needed compacted history now flow through ContextRetriever.retrieve()
  // and receive a ContextBundle with recent + semantic + pins + summary.

  /**
   * A7: backward-compat text view of the session history for display-only
   * consumers (CLI chat renderer, TUI, server API /messages endpoint).
   *
   * Flattens each Turn's visible text blocks and returns a lightweight
   * `{role, content, taskId, timestamp}[]` shape. tool_use / tool_result
   * blocks are dropped — callers needing structural data should consume
   * `getTurnsHistory` directly and walk `Turn.blocks`.
   *
   * Merge note: the Phase 1 long-session compaction
   * (`getConversationHistoryCompacted` + priority-weighted budget +
   * inline KEY-DECISION lines + `[DROPPED BY BUDGET]` marker) is now the
   * responsibility of `src/memory/summary-ladder.ts` via
   * `ContextRetriever.retrieve`. The Phase 1 priority-weight and
   * drop-marker ideas can be ported onto that module in a follow-up
   * without re-introducing a ConversationEntry dependency here.
   */
  getConversationHistoryText(
    sessionId: string,
    maxTurns = 1000,
  ): Array<{
    role: 'user' | 'assistant';
    content: string;
    taskId: string;
    timestamp: number;
  }> {
    const turns = this.sessionStore.getRecentTurns(sessionId, maxTurns);
    return turns.map((t) => ({
      role: t.role,
      content: t.blocks
        .filter((b): b is Extract<typeof b, { type: 'text' }> => b.type === 'text')
        .map((b) => b.text)
        .join('\n'),
      taskId: t.taskId ?? '',
      timestamp: t.createdAt,
    }));
  }

  /**
   * Detailed counterpart to `getConversationHistoryText`. Returns the same
   * `{role, content, taskId, timestamp}` triple PLUS:
   *   - `thinking`:      concatenated text of all `thinking` blocks (LLM
   *                      extended thinking output) for this turn.
   *   - `toolsUsed`:     compact summary of every `tool_use` block — name +
   *                      truncated input — so the chat UI can render a
   *                      "tools called" chip without re-fetching the trace.
   *   - `traceSummary`:  selected fields from the matching ExecutionTrace
   *                      (model, routing level, duration, tokens, oracle
   *                      verdicts) when a TraceStore is wired.
   *
   * Powers `GET /api/v1/sessions/:id/messages` — the historical-process
   * card on the frontend reads these fields directly. Loss-free w.r.t. the
   * legacy text view: callers that only need text can ignore the extras.
   */
  getConversationHistoryDetailed(
    sessionId: string,
    maxTurns = 1000,
  ): Array<{
    role: 'user' | 'assistant';
    content: string;
    taskId: string;
    timestamp: number;
    thinking?: string;
    toolsUsed?: Array<{ id: string; name: string; inputPreview: string }>;
    traceSummary?: {
      routingLevel: number;
      modelUsed: string;
      durationMs: number;
      tokensConsumed: number;
      outcome: string;
      approach?: string;
      oracleVerdictCount: number;
      affectedFiles: string[];
      /**
       * Worker / agent that ran this turn (e.g. `'developer'`, `'assistant'`,
       * `'workflow-executor'`). Lets the chat UI show "Answered by: <agent>"
       * on each historical message — without it, the user has to open Trace
       * to find out which specialist responded.
       */
      workerId?: string;
    };
  }> {
    const turns = this.sessionStore.getRecentTurns(sessionId, maxTurns);
    return turns.map((t) => {
      const textParts: string[] = [];
      const thinkingParts: string[] = [];
      const tools: Array<{ id: string; name: string; inputPreview: string }> = [];
      for (const b of t.blocks) {
        if (b.type === 'text') textParts.push(b.text);
        else if (b.type === 'thinking') thinkingParts.push(b.thinking);
        else if (b.type === 'tool_use') {
          tools.push({
            id: b.id,
            name: b.name,
            inputPreview: previewToolInput(b.input),
          });
        }
      }
      const taskId = t.taskId ?? '';
      let traceSummary: ReturnType<typeof toTraceSummary> | undefined;
      if (taskId && this.traceStore) {
        try {
          const trace = this.traceStore.findByTaskId(taskId);
          if (trace) traceSummary = toTraceSummary(trace);
        } catch (err) {
          // Best-effort: a corrupted trace row must not break listing the
          // conversation. Log and continue without traceSummary.
          console.warn('[vinyan] traceStore.findByTaskId failed:', err);
        }
      }
      return {
        role: t.role,
        content: textParts.join('\n'),
        taskId,
        timestamp: t.createdAt,
        ...(thinkingParts.length > 0 ? { thinking: thinkingParts.join('\n') } : {}),
        ...(tools.length > 0 ? { toolsUsed: tools } : {}),
        ...(traceSummary ? { traceSummary } : {}),
      };
    });
  }
}

/** Truncate a tool input for compact transport in /messages payloads. */
function previewToolInput(input: unknown, maxChars = 240): string {
  let str: string;
  try {
    str = typeof input === 'string' ? input : JSON.stringify(input);
  } catch {
    return '[unserializable]';
  }
  if (str.length <= maxChars) return str;
  return `${str.slice(0, maxChars)}…`;
}

/** Project an ExecutionTrace into the slim summary shape used by the chat UI. */
function toTraceSummary(trace: import('../orchestrator/types.ts').ExecutionTrace): {
  routingLevel: number;
  modelUsed: string;
  durationMs: number;
  tokensConsumed: number;
  outcome: string;
  approach?: string;
  oracleVerdictCount: number;
  affectedFiles: string[];
  workerId?: string;
} {
  return {
    routingLevel: trace.routingLevel,
    modelUsed: trace.modelUsed,
    durationMs: trace.durationMs,
    tokensConsumed: trace.tokensConsumed,
    outcome: trace.outcome,
    approach: trace.approach,
    oracleVerdictCount: Array.isArray(trace.oracleVerdicts) ? trace.oracleVerdicts.length : 0,
    affectedFiles: trace.affectedFiles ?? [],
    ...(trace.workerId ? { workerId: trace.workerId } : {}),
  };
}

/**
 * Project a raw `session_tasks` row into the shape the API surface
 * exposes. Preserves the underlying `TaskResult.status` when present so
 * the operations console can show `escalated` / `uncertain` / `partial`
 * / `input-required` instead of seeing every non-`completed` row as
 * `failed`. Falls back to the db-level lifecycle status when no result
 * envelope has been written yet (still pending or still running).
 */
function projectTaskRow(row: SessionTaskRow): {
  taskId: string;
  sessionId: string;
  status: string;
  goal?: string;
  result?: TaskResult;
} {
  let goal: string | undefined;
  try {
    const input = JSON.parse(row.task_input_json) as { goal?: unknown };
    if (typeof input.goal === 'string') goal = input.goal;
  } catch {
    /* best effort */
  }
  let result: TaskResult | undefined;
  if (row.result_json) {
    try {
      result = JSON.parse(row.result_json) as TaskResult;
    } catch {
      /* best effort */
    }
  }
  let status: string;
  if (row.status === 'cancelled') {
    status = 'cancelled';
  } else if (result?.status) {
    // Honour the rich result status (`escalated`, `uncertain`, `partial`,
    // `input-required`) — collapsing here loses operator visibility.
    status = result.status;
  } else {
    status = row.status;
  }
  return { taskId: row.task_id, sessionId: row.session_id, status, goal, result };
}

function normalizeMetadata(value: string | null | undefined): string | null {
  if (value === undefined || value === null) return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

/**
 * Optional latest-turn snapshot used to detect 'waiting-input'. Pass
 * `null` when the session has no turns yet, or `undefined` when the
 * caller has not loaded turn data (the activity classifier degrades to
 * the task-count heuristic in that case).
 */
interface LatestTurnSnapshot {
  role: 'user' | 'assistant';
  blocksJson: string;
}

function rowToSession(
  row: SessionRow,
  taskCount: number,
  runningTaskCount: number,
  latestTurn: LatestTurnSnapshot | null,
): Session {
  return {
    id: row.id,
    source: row.source,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    taskCount,
    runningTaskCount,
    title: row.title,
    description: row.description,
    archivedAt: row.archived_at,
    deletedAt: row.deleted_at,
    lifecycleState: deriveLifecycleState(row),
    activityState: deriveActivityState(taskCount, runningTaskCount, latestTurn),
  };
}

function rowWithCountToSession(row: SessionRowWithCount): Session {
  const latestTurn: LatestTurnSnapshot | null =
    row.latest_turn_role !== null && row.latest_turn_blocks !== null
      ? { role: row.latest_turn_role, blocksJson: row.latest_turn_blocks }
      : null;
  return rowToSession(row, row.task_count, row.running_task_count, latestTurn);
}

/**
 * Lifecycle priority: deleted_at trumps archived_at trumps the lifecycle
 * `status` column. Trashed/archived sessions can hold any value in `status`
 * (e.g. a session can be 'compacted' AND archived) but the dominant label
 * for the operator is "this row is in the Trash" or "this row is archived",
 * so we surface those first.
 */
function deriveLifecycleState(row: SessionRow): SessionLifecycleState {
  if (row.deleted_at !== null) return 'trashed';
  if (row.archived_at !== null) return 'archived';
  return row.status;
}

function deriveActivityState(
  taskCount: number,
  runningTaskCount: number,
  latestTurn: LatestTurnSnapshot | null,
): SessionActivityState {
  // Live work wins — a stale [INPUT-REQUIRED] from a previous turn is no
  // longer the operator's primary concern when a fresh task is running.
  if (runningTaskCount > 0) return 'in-progress';
  if (latestTurn && latestTurn.role === 'assistant' && hasInputRequiredBlock(latestTurn.blocksJson)) {
    return 'waiting-input';
  }
  if (taskCount === 0) return 'empty';
  return 'idle';
}

/**
 * Cheap text scan over a turn's blocks JSON for the `[INPUT-REQUIRED]`
 * sentinel. We avoid a full JSON.parse here so listSessions can call this
 * once per row without inflating the latency budget — `recordAssistantTurn`
 * always writes the marker as a literal substring inside a `text` block, so
 * a substring check is sound (false positives would only occur if a tool
 * input echoed the sentinel verbatim, which is not a real-world scenario).
 */
function hasInputRequiredBlock(blocksJson: string): boolean {
  return blocksJson.includes('[INPUT-REQUIRED]');
}

/**
 * Agent Conversation: parse an assistant message `content` and return the
 * list of clarification questions if it contains an [INPUT-REQUIRED] block.
 * Format (written by `recordAssistantTurn`):
 *
 *   [optional preamble]
 *
 *   [INPUT-REQUIRED]
 *   - question 1
 *   - question 2
 *
 * Returns [] when the tag is absent. Pure string matching — A3 compliant.
 */
export function parseInputRequiredBlock(content: string): string[] {
  const tagIdx = content.indexOf('[INPUT-REQUIRED]');
  if (tagIdx === -1) return [];
  const body = content.slice(tagIdx + '[INPUT-REQUIRED]'.length);
  const questions: string[] = [];
  for (const line of body.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith('- ')) {
      const q = trimmed.slice(2).trim();
      if (q) questions.push(q);
    } else if (trimmed.length > 0 && questions.length > 0) {
      // Stop parsing at first non-bullet non-empty line after bullets began.
      // Keeps this simple and deterministic.
      break;
    }
  }
  return questions;
}
