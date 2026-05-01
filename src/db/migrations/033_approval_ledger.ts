/**
 * Migration 033 — Approval ledger.
 *
 * R5: durable record of every human-in-the-loop approval event. Today
 * `ApprovalGate` is in-memory only — pending approvals die with the
 * process and retry loops cannot reconstruct prior approval state. This
 * table strengthens A8 (traceable accountability) by making every
 * approval request, resolution, timeout, shutdown-reject, and retry
 * supersede replayable from disk.
 *
 * Status vocabulary:
 *   pending           — request emitted, awaiting resolution
 *   approved          — human accepted
 *   rejected          — human rejected
 *   timed_out         — auto-rejected by gate timer
 *   shutdown_rejected — auto-rejected during process shutdown
 *   superseded        — replaced by a retry/child approval (no human action)
 *
 * Source vocabulary:
 *   human    — explicit API/TUI resolve
 *   timeout  — gate timer fired
 *   shutdown — orchestrator clear() during teardown
 *   system   — programmatic supersede / cleanup
 *
 * Uniqueness:
 *   At most one row with status='pending' per (task_id, approval_key).
 *   Enforced via partial unique index. Enforcement is also re-validated
 *   in the store's createPending (defense in depth across SQLite versions).
 *
 * Indexes:
 *   task_id, status, requested_at, (profile, status), (session_id, status).
 */
import type { Database } from 'bun:sqlite';
import type { Migration } from './migration-runner.ts';

export const migration033: Migration = {
  version: 33,
  description: 'approval_ledger — durable approval lifecycle (R5)',
  up(db: Database) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS approval_ledger (
        id                 TEXT PRIMARY KEY,
        task_id            TEXT NOT NULL,
        approval_key       TEXT NOT NULL,
        status             TEXT NOT NULL
                             CHECK(status IN ('pending','approved','rejected','timed_out','shutdown_rejected','superseded')),
        risk_score         REAL NOT NULL,
        reason             TEXT NOT NULL,
        requested_at       INTEGER NOT NULL,
        resolved_at        INTEGER,
        resolved_by        TEXT,
        decision           TEXT,
        source             TEXT NOT NULL
                             CHECK(source IN ('human','timeout','shutdown','system')),
        profile            TEXT,
        session_id         TEXT,
        retry_of_task_id   TEXT,
        provenance_json    TEXT,
        created_at         INTEGER NOT NULL,
        updated_at         INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_approval_ledger_task ON approval_ledger(task_id);
      CREATE INDEX IF NOT EXISTS idx_approval_ledger_status ON approval_ledger(status);
      CREATE INDEX IF NOT EXISTS idx_approval_ledger_requested ON approval_ledger(requested_at);
      CREATE INDEX IF NOT EXISTS idx_approval_ledger_profile_status
        ON approval_ledger(profile, status);
      CREATE INDEX IF NOT EXISTS idx_approval_ledger_session_status
        ON approval_ledger(session_id, status);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_approval_ledger_pending_unique
        ON approval_ledger(task_id, approval_key)
        WHERE status = 'pending';
    `);
  },
};
