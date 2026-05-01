/**
 * ApprovalLedgerStore — DB-backed audit trail for human-in-the-loop
 * approvals (R5).
 *
 * Backs `approval_ledger` (migration 033). Every `requestApproval()` on
 * the orchestrator's ApprovalGate writes a `pending` row here BEFORE the
 * `task:approval_required` event fires; every resolution, timeout, or
 * shutdown updates the row before the awaiting promise settles.
 *
 * Restart durability: when the orchestrator restarts, pending rows from
 * the prior process remain visible via `listPending()` so operators /
 * doctor can see "orphaned pending approval" rather than silently
 * dropping them. The store does NOT auto-resolve those rows — that
 * decision belongs to a human.
 *
 * Axioms upheld:
 *   A3 — every state transition is rule-based; invalid transitions
 *        return a typed error result, never throw silently.
 *   A6 — the ledger never auto-approves; only auto-rejects on timeout
 *        / shutdown / supersede paths, which require an explicit caller.
 *   A8 — every row carries actor + reason + timestamp; replay is
 *        possible from disk alone.
 */
import { createHash, randomBytes } from 'node:crypto';
import type { Database, Statement } from 'bun:sqlite';

export type ApprovalStatus =
  | 'pending'
  | 'approved'
  | 'rejected'
  | 'timed_out'
  | 'shutdown_rejected'
  | 'superseded';

export type ApprovalSource = 'human' | 'timeout' | 'shutdown' | 'system';

export interface ApprovalLedgerRecord {
  readonly id: string;
  readonly taskId: string;
  readonly approvalKey: string;
  readonly status: ApprovalStatus;
  readonly riskScore: number;
  readonly reason: string;
  readonly requestedAt: number;
  readonly resolvedAt: number | null;
  readonly resolvedBy: string | null;
  readonly decision: string | null;
  readonly source: ApprovalSource;
  readonly profile: string | null;
  readonly sessionId: string | null;
  readonly retryOfTaskId: string | null;
  readonly provenance: Readonly<Record<string, unknown>> | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface CreatePendingInput {
  readonly taskId: string;
  /** Logical key under task; default `'default'` so single-approval flows just work. */
  readonly approvalKey?: string;
  readonly riskScore: number;
  readonly reason: string;
  readonly profile?: string;
  readonly sessionId?: string;
  readonly retryOfTaskId?: string;
  readonly provenance?: Readonly<Record<string, unknown>>;
  /** Test/clock injection. */
  readonly now?: number;
  /** Pre-computed id (deterministic test). Otherwise random. */
  readonly id?: string;
}

export interface ResolveInput {
  readonly taskId: string;
  readonly approvalKey?: string;
  readonly status: Exclude<ApprovalStatus, 'pending' | 'superseded'>;
  readonly source: ApprovalSource;
  readonly resolvedBy?: string;
  readonly decision?: string;
  readonly now?: number;
}

export type CreatePendingResult =
  | { readonly ok: true; readonly record: ApprovalLedgerRecord }
  | { readonly ok: false; readonly reason: 'duplicate_pending' | 'db_error'; readonly detail: string };

export type ResolveResult =
  | { readonly ok: true; readonly record: ApprovalLedgerRecord }
  | { readonly ok: false; readonly reason: 'no_pending' | 'invalid_state' | 'db_error'; readonly detail: string };

interface Row {
  id: string;
  task_id: string;
  approval_key: string;
  status: ApprovalStatus;
  risk_score: number;
  reason: string;
  requested_at: number;
  resolved_at: number | null;
  resolved_by: string | null;
  decision: string | null;
  source: ApprovalSource;
  profile: string | null;
  session_id: string | null;
  retry_of_task_id: string | null;
  provenance_json: string | null;
  created_at: number;
  updated_at: number;
}

export interface ApprovalLedgerStoreOptions {
  /** Test injection for deterministic clock. */
  readonly clock?: () => number;
  /** Test injection for deterministic id generator. */
  readonly idGenerator?: () => string;
}

export class ApprovalLedgerStore {
  private readonly db: Database;
  private readonly clock: () => number;
  private readonly idGenerator: () => string;
  private readonly insertStmt: Statement;
  private readonly findOpenStmt: Statement;
  private readonly findByIdStmt: Statement;
  private readonly findByTaskStmt: Statement;
  private readonly listPendingStmt: Statement;
  private readonly resolveStmt: Statement;
  private readonly listShutdownTargetsStmt: Statement;

  constructor(db: Database, opts: ApprovalLedgerStoreOptions = {}) {
    this.db = db;
    this.clock = opts.clock ?? Date.now;
    this.idGenerator =
      opts.idGenerator ??
      (() => {
        // Random + clock-derived; collision-free across processes for
        // human-in-the-loop scale (millions of approvals over years).
        const r = randomBytes(8).toString('hex');
        return `apl-${Date.now().toString(36)}-${r}`;
      });

    this.insertStmt = db.prepare(
      `INSERT INTO approval_ledger
         (id, task_id, approval_key, status, risk_score, reason, requested_at,
          resolved_at, resolved_by, decision, source, profile, session_id,
          retry_of_task_id, provenance_json, created_at, updated_at)
       VALUES (?, ?, ?, 'pending', ?, ?, ?, NULL, NULL, NULL, 'system', ?, ?, ?, ?, ?, ?)`,
    );
    this.findOpenStmt = db.prepare(
      `SELECT * FROM approval_ledger
        WHERE task_id = ? AND approval_key = ? AND status = 'pending'
        LIMIT 1`,
    );
    this.findByIdStmt = db.prepare(`SELECT * FROM approval_ledger WHERE id = ?`);
    this.findByTaskStmt = db.prepare(
      `SELECT * FROM approval_ledger WHERE task_id = ? ORDER BY requested_at DESC`,
    );
    this.listPendingStmt = db.prepare(
      `SELECT * FROM approval_ledger WHERE status = 'pending' ORDER BY requested_at ASC LIMIT ?`,
    );
    this.resolveStmt = db.prepare(
      `UPDATE approval_ledger
          SET status = ?,
              resolved_at = ?,
              resolved_by = ?,
              decision = ?,
              source = ?,
              updated_at = ?
        WHERE id = ? AND status = 'pending'`,
    );
    this.listShutdownTargetsStmt = db.prepare(
      `SELECT id FROM approval_ledger WHERE status = 'pending'`,
    );
  }

  /**
   * Create a `pending` row for a new approval request. Returns the row.
   * Returns `duplicate_pending` if another `pending` row already exists
   * for the (taskId, approvalKey) tuple — caller should resolve or
   * supersede the existing one before re-requesting.
   */
  createPending(input: CreatePendingInput): CreatePendingResult {
    const now = input.now ?? this.clock();
    const approvalKey = input.approvalKey ?? 'default';
    const id = input.id ?? this.idGenerator();
    const provenanceJson = input.provenance ? JSON.stringify(input.provenance) : null;

    const existing = this.findOpenStmt.get(input.taskId, approvalKey) as Row | undefined;
    if (existing) {
      return {
        ok: false,
        reason: 'duplicate_pending',
        detail: `pending approval already exists (id=${existing.id}) for taskId=${input.taskId} key=${approvalKey}`,
      };
    }

    try {
      this.insertStmt.run(
        id,
        input.taskId,
        approvalKey,
        input.riskScore,
        input.reason,
        now,
        input.profile ?? null,
        input.sessionId ?? null,
        input.retryOfTaskId ?? null,
        provenanceJson,
        now,
        now,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Partial unique index (status='pending') may throw despite the
      // pre-check on race; surface as duplicate.
      if (msg.includes('UNIQUE constraint') || msg.includes('idx_approval_ledger_pending_unique')) {
        return { ok: false, reason: 'duplicate_pending', detail: msg };
      }
      return { ok: false, reason: 'db_error', detail: msg };
    }

    const row = this.findByIdStmt.get(id) as Row | undefined;
    if (!row) {
      return { ok: false, reason: 'db_error', detail: 'inserted row not found on read-back' };
    }
    return { ok: true, record: rowToRecord(row) };
  }

  /**
   * Resolve a pending approval. Returns the updated record or a typed
   * error when no matching pending row exists (idempotent: a second
   * resolve with the same args is a no-op + `no_pending`).
   */
  resolve(input: ResolveInput): ResolveResult {
    const approvalKey = input.approvalKey ?? 'default';
    const existing = this.findOpenStmt.get(input.taskId, approvalKey) as Row | undefined;
    if (!existing) {
      return {
        ok: false,
        reason: 'no_pending',
        detail: `no pending approval for taskId=${input.taskId} key=${approvalKey}`,
      };
    }
    const now = input.now ?? this.clock();
    try {
      this.resolveStmt.run(
        input.status,
        now,
        input.resolvedBy ?? null,
        input.decision ?? null,
        input.source,
        now,
        existing.id,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, reason: 'db_error', detail: msg };
    }
    const after = this.findByIdStmt.get(existing.id) as Row | undefined;
    if (!after) {
      return { ok: false, reason: 'db_error', detail: 'updated row not found on read-back' };
    }
    return { ok: true, record: rowToRecord(after) };
  }

  /**
   * Reject every currently-pending approval with status='timed_out'.
   * Convenience for ApprovalGate's per-request timeout path; same
   * effect as resolve(...) but parameterless.
   */
  timeout(taskId: string, approvalKey?: string): ResolveResult {
    return this.resolve({
      taskId,
      ...(approvalKey !== undefined ? { approvalKey } : {}),
      status: 'timed_out',
      source: 'timeout',
      decision: 'rejected',
    });
  }

  /**
   * Reject every currently-pending row with status='shutdown_rejected'.
   * Returns the count of rows transitioned. Used by ApprovalGate.clear()
   * during graceful orchestrator shutdown so the next process boot does
   * not see ghost pending rows from a prior crash.
   */
  shutdownRejectOpen(now?: number): number {
    const ts = now ?? this.clock();
    const targets = this.listShutdownTargetsStmt.all() as Array<{ id: string }>;
    if (targets.length === 0) return 0;
    const update = this.db.prepare(
      `UPDATE approval_ledger
          SET status = 'shutdown_rejected',
              resolved_at = ?,
              source = 'shutdown',
              decision = 'rejected',
              updated_at = ?
        WHERE id = ? AND status = 'pending'`,
    );
    let count = 0;
    for (const { id } of targets) {
      update.run(ts, ts, id);
      count++;
    }
    return count;
  }

  /**
   * Mark a parent task's pending approvals as `superseded` because a
   * retry / child task is taking over. `system` source attribution.
   * Returns the count of rows transitioned.
   */
  markSupersededForRetry(parentTaskId: string, childTaskId: string, now?: number): number {
    const ts = now ?? this.clock();
    const targets = this.db
      .prepare(`SELECT id FROM approval_ledger WHERE task_id = ? AND status = 'pending'`)
      .all(parentTaskId) as Array<{ id: string }>;
    if (targets.length === 0) return 0;
    const update = this.db.prepare(
      `UPDATE approval_ledger
          SET status = 'superseded',
              resolved_at = ?,
              source = 'system',
              decision = 'superseded',
              resolved_by = ?,
              updated_at = ?
        WHERE id = ? AND status = 'pending'`,
    );
    let count = 0;
    for (const { id } of targets) {
      update.run(ts, `retry:${childTaskId}`, ts, id);
      count++;
    }
    return count;
  }

  // ── reads ────────────────────────────────────────────────────────────

  listPending(limit = 200): readonly ApprovalLedgerRecord[] {
    const rows = this.listPendingStmt.all(limit) as Row[];
    return rows.map(rowToRecord);
  }

  findByTask(taskId: string): readonly ApprovalLedgerRecord[] {
    const rows = this.findByTaskStmt.all(taskId) as Row[];
    return rows.map(rowToRecord);
  }

  findOpenByTask(taskId: string, approvalKey = 'default'): ApprovalLedgerRecord | null {
    const row = this.findOpenStmt.get(taskId, approvalKey) as Row | undefined;
    return row ? rowToRecord(row) : null;
  }

  findById(id: string): ApprovalLedgerRecord | null {
    const row = this.findByIdStmt.get(id) as Row | undefined;
    return row ? rowToRecord(row) : null;
  }
}

function rowToRecord(row: Row): ApprovalLedgerRecord {
  return {
    id: row.id,
    taskId: row.task_id,
    approvalKey: row.approval_key,
    status: row.status,
    riskScore: row.risk_score,
    reason: row.reason,
    requestedAt: row.requested_at,
    resolvedAt: row.resolved_at,
    resolvedBy: row.resolved_by,
    decision: row.decision,
    source: row.source,
    profile: row.profile,
    sessionId: row.session_id,
    retryOfTaskId: row.retry_of_task_id,
    provenance: row.provenance_json ? safeJsonParseObject(row.provenance_json) : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function safeJsonParseObject(text: string): Readonly<Record<string, unknown>> | null {
  try {
    const parsed = JSON.parse(text) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    /* fall through */
  }
  return null;
}

/** Stable derivation of a deterministic approval id from inputs (test helper). */
export function deriveStableApprovalId(taskId: string, approvalKey: string, requestedAt: number): string {
  const hash = createHash('sha256').update(`${taskId}|${approvalKey}|${requestedAt}`).digest('hex');
  return `apl-${hash.slice(0, 16)}`;
}
