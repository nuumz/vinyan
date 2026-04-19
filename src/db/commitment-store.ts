/**
 * CommitmentStore — SQLite persistence for the commitment ledger.
 *
 * Schema from migration 032. The store is a thin CRUD layer; the
 * `CommitmentLedger` in `src/orchestrator/ecosystem/commitment-ledger.ts`
 * owns the semantics (create on bid-accept, resolve on verdict, A7 signal).
 */

import type { Database, Statement } from 'bun:sqlite';

export type CommitmentResolution = 'delivered' | 'failed' | 'transferred';

export interface Commitment {
  readonly commitmentId: string;
  readonly engineId: string;
  readonly taskId: string;
  readonly deliverableHash: string;
  readonly deadlineAt: number;
  readonly acceptedAt: number;
  readonly resolvedAt: number | null;
  readonly resolutionKind: CommitmentResolution | null;
  readonly resolutionEvidence: string | null;
}

export interface CreateCommitmentParams {
  commitmentId: string;
  engineId: string;
  taskId: string;
  deliverableHash: string;
  deadlineAt: number;
  acceptedAt: number;
}

export interface ResolveCommitmentParams {
  commitmentId: string;
  kind: CommitmentResolution;
  evidence: string;
  resolvedAt: number;
}

interface Row {
  commitment_id: string;
  engine_id: string;
  task_id: string;
  deliverable_hash: string;
  deadline_at: number;
  accepted_at: number;
  resolved_at: number | null;
  resolution_kind: CommitmentResolution | null;
  resolution_evidence: string | null;
}

export class CommitmentStore {
  private readonly sInsert: Statement;
  private readonly sGet: Statement;
  private readonly sResolve: Statement;
  private readonly sFindOpenByTask: Statement;
  private readonly sFindOpenByEngine: Statement;
  private readonly sFindByTask: Statement;
  private readonly sFindExpired: Statement;

  constructor(db: Database) {
    this.sInsert = db.prepare(`
      INSERT INTO commitments
        (commitment_id, engine_id, task_id, deliverable_hash, deadline_at, accepted_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    this.sGet = db.prepare('SELECT * FROM commitments WHERE commitment_id = ?');
    this.sResolve = db.prepare(`
      UPDATE commitments
         SET resolved_at = ?, resolution_kind = ?, resolution_evidence = ?
       WHERE commitment_id = ? AND resolved_at IS NULL
    `);
    this.sFindOpenByTask = db.prepare(
      'SELECT * FROM commitments WHERE task_id = ? AND resolved_at IS NULL ORDER BY accepted_at',
    );
    this.sFindOpenByEngine = db.prepare(
      'SELECT * FROM commitments WHERE engine_id = ? AND resolved_at IS NULL ORDER BY accepted_at',
    );
    this.sFindByTask = db.prepare(
      'SELECT * FROM commitments WHERE task_id = ? ORDER BY accepted_at',
    );
    this.sFindExpired = db.prepare(
      'SELECT * FROM commitments WHERE resolved_at IS NULL AND deadline_at < ? ORDER BY deadline_at',
    );
  }

  create(params: CreateCommitmentParams): void {
    this.sInsert.run(
      params.commitmentId,
      params.engineId,
      params.taskId,
      params.deliverableHash,
      params.deadlineAt,
      params.acceptedAt,
    );
  }

  get(commitmentId: string): Commitment | null {
    const row = this.sGet.get(commitmentId) as Row | null;
    return row ? this.map(row) : null;
  }

  /** Returns true if the row was updated (false = already resolved / not found). */
  resolve(params: ResolveCommitmentParams): boolean {
    const res = this.sResolve.run(
      params.resolvedAt,
      params.kind,
      params.evidence,
      params.commitmentId,
    ) as { changes: number };
    return res.changes > 0;
  }

  findOpenByTask(taskId: string): readonly Commitment[] {
    return (this.sFindOpenByTask.all(taskId) as Row[]).map(this.map);
  }

  findOpenByEngine(engineId: string): readonly Commitment[] {
    return (this.sFindOpenByEngine.all(engineId) as Row[]).map(this.map);
  }

  findByTask(taskId: string): readonly Commitment[] {
    return (this.sFindByTask.all(taskId) as Row[]).map(this.map);
  }

  findExpired(now: number): readonly Commitment[] {
    return (this.sFindExpired.all(now) as Row[]).map(this.map);
  }

  private map(row: Row): Commitment {
    return {
      commitmentId: row.commitment_id,
      engineId: row.engine_id,
      taskId: row.task_id,
      deliverableHash: row.deliverable_hash,
      deadlineAt: row.deadline_at,
      acceptedAt: row.accepted_at,
      resolvedAt: row.resolved_at,
      resolutionKind: row.resolution_kind,
      resolutionEvidence: row.resolution_evidence,
    };
  }
}
