/**
 * SessionProcessProjectionService — Phase 2.7.
 *
 * Read-path aggregator for `/api/v1/sessions/:sid/process-state`. Joins
 * `session_store` (lifecycle, metadata) with `session_tasks` (membership)
 * and surfaces a per-task summary tier. The UI navigates the entity
 * hierarchy from this surface; per-task drill-downs hit the existing
 * task-scoped `TaskProcessProjectionService`.
 *
 * Why a separate service: `TaskProcessProjectionService` is task-scoped
 * by design (its event scan is `WHERE task_id = ?`). Folding session-
 * level state into the task projection would invert the dependency
 * (UI components built around task ids would need session injection).
 *
 * Audit rollup: this projection does NOT walk every child task's audit
 * log on each call (that would be O(tasks × events)). Instead it
 * aggregates lifecycle counts; consumers that need per-task audit fetch
 * `task-process-state` per task. A future enhancement can add a denorm
 * `session_audit_summary` row updated incrementally if the per-call cost
 * becomes a problem.
 *
 * KNOWN READ-SIDE GAPS (Phase 2.7 — explicitly deferred per the user
 * directive "do NOT add a session_events store in this pass"):
 *
 * TODO(audit-redesign/session-history): transition history is not
 *   surfaced. The projection reads `session_store` snapshot rows; an
 *   archive→unarchive→archive cycle leaves only the final state
 *   visible, and the `session:archived` / `session:unarchived` events
 *   themselves are not persisted (manifest record:false today). To
 *   recover full lifecycle history, either (a) add a `session_events`
 *   table + dispatch in task-event-recorder for scope:'session', or
 *   (b) fold session.* JSONL lines via `SessionStore`'s JSONL adapter
 *   into this projection on read. Fix when an operator complaint or
 *   audit-replay requirement actually surfaces the gap.
 *
 * TODO(audit-redesign/session-restored-marker): a restored session is
 *   indistinguishable from a never-deleted session at the snapshot
 *   level. Add a `restoredAt` column or surface it via JSONL fold.
 *   Same persistence-store decision as above.
 *
 * TODO(audit-redesign/session-compaction-detail): `lifecycleState ===
 *   'compacted'` is binary — no compaction timestamp, no count of
 *   compacted turns, no compaction policy version. Compaction records
 *   exist in JSONL today; surface them when the UI's Sessions page
 *   needs the details.
 *
 * TODO(audit-redesign/session-tombstone-discovery): a purged session
 *   is unreachable via this projection (build returns null). Operators
 *   investigating a deleted session must consult the JSONL tombstone
 *   directory directly. Add a tombstone-aware list endpoint when
 *   support engineering needs replay of purged sessions.
 *
 * TODO(audit-redesign/session-updated-fields-history): updateMetadata
 *   bus event surfaces WHICH fields changed (`fields: ['title']`); the
 *   projection only shows current title/description. Add a fields-
 *   change log if the audit UI ever needs "title was 'X', then 'Y'".
 */
import type { SessionRow, SessionStore, SessionTaskRow } from '../../db/session-store.ts';

export interface SessionProcessLifecycle {
  sessionId: string;
  source: string;
  status: string;
  createdAt: number;
  updatedAt: number;
  archivedAt: number | null;
  deletedAt: number | null;
  title: string | null;
  description: string | null;
  /** Derived per `deriveLifecycleState` semantics — never re-derived in the UI. */
  lifecycleState: 'active' | 'suspended' | 'compacted' | 'closed' | 'archived' | 'trashed';
}

export interface SessionProcessTaskSummary {
  taskId: string;
  status: SessionTaskRow['status'];
  createdAt: number;
  updatedAt: number | null;
  archivedAt: number | null;
}

export interface SessionProcessAuditCounts {
  /** Total tasks recorded under this session (regardless of status). */
  totalTasks: number;
  pendingTasks: number;
  runningTasks: number;
  completedTasks: number;
  failedTasks: number;
  cancelledTasks: number;
  archivedTasks: number;
}

export interface SessionProcessProjection {
  lifecycle: SessionProcessLifecycle;
  tasks: SessionProcessTaskSummary[];
  audit: SessionProcessAuditCounts;
}

export interface SessionProcessProjectionDeps {
  sessionStore: SessionStore;
  /** Hard cap on returned task summaries (default 500). Older tasks paged separately if needed. */
  maxTasks?: number;
}

const DEFAULT_MAX_TASKS = 500;

function deriveLifecycleState(row: SessionRow): SessionProcessLifecycle['lifecycleState'] {
  if (row.deleted_at !== null) return 'trashed';
  if (row.archived_at !== null) return 'archived';
  // session_store.status is the underlying CHECK-enum (`active|suspended|compacted|closed`).
  return (row.status ?? 'active') as SessionProcessLifecycle['lifecycleState'];
}

export class SessionProcessProjectionService {
  constructor(private readonly deps: SessionProcessProjectionDeps) {}

  /** Returns null when the session row is unknown. */
  build(sessionId: string): SessionProcessProjection | null {
    const row = this.deps.sessionStore.getSession(sessionId);
    if (!row) return null;

    const limit = this.deps.maxTasks ?? DEFAULT_MAX_TASKS;
    const taskRows = this.deps.sessionStore.listSessionTasks(sessionId).slice(0, limit);

    const lifecycle: SessionProcessLifecycle = {
      sessionId: row.id,
      source: row.source,
      status: row.status,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      archivedAt: row.archived_at ?? null,
      deletedAt: row.deleted_at ?? null,
      title: row.title ?? null,
      description: row.description ?? null,
      lifecycleState: deriveLifecycleState(row),
    };

    const tasks: SessionProcessTaskSummary[] = taskRows.map((t) => ({
      taskId: t.task_id,
      status: t.status,
      createdAt: t.created_at,
      updatedAt: t.updated_at ?? null,
      archivedAt: t.archived_at ?? null,
    }));

    const audit: SessionProcessAuditCounts = {
      totalTasks: tasks.length,
      pendingTasks: tasks.filter((t) => t.status === 'pending').length,
      runningTasks: tasks.filter((t) => t.status === 'running').length,
      completedTasks: tasks.filter((t) => t.status === 'completed').length,
      failedTasks: tasks.filter((t) => t.status === 'failed').length,
      cancelledTasks: tasks.filter((t) => t.status === 'cancelled').length,
      archivedTasks: tasks.filter((t) => t.archivedAt !== null).length,
    };

    return { lifecycle, tasks, audit };
  }
}
