/**
 * CodingCliStore — SQLite persistence for the external coding CLI subsystem.
 *
 * - `coding_cli_sessions` is upsert-on-update.
 * - `coding_cli_events` is append-only with per-session seq counters.
 * - `coding_cli_approvals` is one row per permission request (insert) with
 *   later UPDATE when the human/timeout resolution lands.
 * - `coding_cli_decisions` is append-only.
 */
import type { Database } from 'bun:sqlite';
import type {
  CodingCliCapabilities,
  CodingCliProviderId,
  CodingCliResult,
  CodingCliSessionRecord,
  CodingCliSessionState,
} from '../orchestrator/external-coding-cli/types.ts';

interface SessionRow {
  id: string;
  task_id: string;
  session_id: string | null;
  provider_id: string;
  binary_path: string;
  binary_version: string | null;
  capabilities_json: string;
  cwd: string;
  pid: number | null;
  state: string;
  started_at: number;
  updated_at: number;
  ended_at: number | null;
  last_output_at: number | null;
  last_hook_at: number | null;
  transcript_path: string | null;
  event_log_path: string | null;
  files_changed_json: string;
  commands_requested_json: string;
  final_result_json: string | null;
  raw_meta_json: string;
}

interface EventRow {
  id: string;
  coding_cli_session_id: string;
  task_id: string;
  seq: number;
  event_type: string;
  payload_json: string;
  ts: number;
}

interface ApprovalRow {
  id: string;
  coding_cli_session_id: string;
  task_id: string;
  request_id: string;
  command: string;
  reason: string;
  policy_decision: string;
  human_decision: string | null;
  decided_by: string | null;
  decided_at: number | null;
  requested_at: number;
  raw_json: string;
}

interface DecisionRow {
  id: string;
  coding_cli_session_id: string;
  task_id: string;
  decision: string;
  rationale: string;
  alternatives_json: string;
  ts: number;
}

export class CodingCliStore {
  private readonly db: Database;
  private readonly upsertSession;
  private readonly insertEvent;
  private readonly insertApproval;
  private readonly updateApproval;
  private readonly insertDecision;
  private readonly seqBySession = new Map<string, number>();

  constructor(db: Database) {
    this.db = db;
    this.upsertSession = db.prepare(
      `INSERT INTO coding_cli_sessions (
        id, task_id, session_id, provider_id, binary_path, binary_version,
        capabilities_json, cwd, pid, state, started_at, updated_at, ended_at,
        last_output_at, last_hook_at, transcript_path, event_log_path,
        files_changed_json, commands_requested_json, final_result_json,
        raw_meta_json
      ) VALUES (
        $id, $task_id, $session_id, $provider_id, $binary_path, $binary_version,
        $capabilities_json, $cwd, $pid, $state, $started_at, $updated_at, $ended_at,
        $last_output_at, $last_hook_at, $transcript_path, $event_log_path,
        $files_changed_json, $commands_requested_json, $final_result_json,
        $raw_meta_json
      )
      ON CONFLICT(id) DO UPDATE SET
        session_id = excluded.session_id,
        binary_path = excluded.binary_path,
        binary_version = excluded.binary_version,
        capabilities_json = excluded.capabilities_json,
        pid = excluded.pid,
        state = excluded.state,
        updated_at = excluded.updated_at,
        ended_at = excluded.ended_at,
        last_output_at = excluded.last_output_at,
        last_hook_at = excluded.last_hook_at,
        transcript_path = excluded.transcript_path,
        event_log_path = excluded.event_log_path,
        files_changed_json = excluded.files_changed_json,
        commands_requested_json = excluded.commands_requested_json,
        final_result_json = excluded.final_result_json,
        raw_meta_json = excluded.raw_meta_json`,
    );
    this.insertEvent = db.prepare(
      `INSERT INTO coding_cli_events (id, coding_cli_session_id, task_id, seq, event_type, payload_json, ts)
       VALUES ($id, $coding_cli_session_id, $task_id, $seq, $event_type, $payload_json, $ts)`,
    );
    this.insertApproval = db.prepare(
      `INSERT INTO coding_cli_approvals (
        id, coding_cli_session_id, task_id, request_id, command, reason,
        policy_decision, human_decision, decided_by, decided_at, requested_at, raw_json
      ) VALUES (
        $id, $coding_cli_session_id, $task_id, $request_id, $command, $reason,
        $policy_decision, $human_decision, $decided_by, $decided_at, $requested_at, $raw_json
      )`,
    );
    this.updateApproval = db.prepare(
      `UPDATE coding_cli_approvals SET human_decision = $human_decision, decided_by = $decided_by, decided_at = $decided_at
       WHERE coding_cli_session_id = $coding_cli_session_id AND request_id = $request_id`,
    );
    this.insertDecision = db.prepare(
      `INSERT INTO coding_cli_decisions (id, coding_cli_session_id, task_id, decision, rationale, alternatives_json, ts)
       VALUES ($id, $coding_cli_session_id, $task_id, $decision, $rationale, $alternatives_json, $ts)`,
    );
  }

  insert(record: CodingCliSessionRecord): void {
    this.upsertSession.run(this.toRowParams(record));
  }

  update(record: CodingCliSessionRecord): void {
    this.upsertSession.run(this.toRowParams(record));
  }

  list(): CodingCliSessionRecord[] {
    const rows = this.db.query<SessionRow, []>(`SELECT * FROM coding_cli_sessions ORDER BY started_at DESC`).all();
    return rows.map(rowToSession);
  }

  get(id: string): CodingCliSessionRecord | null {
    const row = this.db
      .query<SessionRow, [string]>(`SELECT * FROM coding_cli_sessions WHERE id = ?`)
      .get(id);
    return row ? rowToSession(row) : null;
  }

  getByTaskId(taskId: string): CodingCliSessionRecord[] {
    const rows = this.db
      .query<SessionRow, [string]>(
        `SELECT * FROM coding_cli_sessions WHERE task_id = ? ORDER BY started_at DESC`,
      )
      .all(taskId);
    return rows.map(rowToSession);
  }

  appendEvent(sessionId: string, eventType: string, payload: unknown, ts: number): void {
    const seq = this.nextSeq(sessionId);
    const id = `${sessionId}-${seq}`;
    let payloadJson: string;
    try {
      payloadJson = JSON.stringify(payload);
    } catch {
      payloadJson = JSON.stringify({ _serializeError: true });
    }
    const taskIdRow = this.db
      .query<{ task_id: string }, [string]>(`SELECT task_id FROM coding_cli_sessions WHERE id = ?`)
      .get(sessionId);
    const taskId = taskIdRow?.task_id ?? sessionId;
    this.insertEvent.run({
      $id: id,
      $coding_cli_session_id: sessionId,
      $task_id: taskId,
      $seq: seq,
      $event_type: eventType,
      $payload_json: payloadJson,
      $ts: ts,
    });
  }

  listEvents(sessionId: string, opts: { since?: number; limit?: number } = {}): EventRow[] {
    const limit = Math.max(1, Math.min(opts.limit ?? 1000, 5000));
    if (opts.since !== undefined) {
      return this.db
        .query<EventRow, [string, number, number]>(
          `SELECT * FROM coding_cli_events
            WHERE coding_cli_session_id = ? AND seq >= ?
            ORDER BY seq ASC LIMIT ?`,
        )
        .all(sessionId, opts.since, limit);
    }
    return this.db
      .query<EventRow, [string, number]>(
        `SELECT * FROM coding_cli_events WHERE coding_cli_session_id = ? ORDER BY seq ASC LIMIT ?`,
      )
      .all(sessionId, limit);
  }

  recordApproval(record: {
    id: string;
    sessionId: string;
    taskId: string;
    requestId: string;
    command: string;
    reason: string;
    policyDecision: string;
    humanDecision: string | null;
    decidedBy: string | null;
    decidedAt: number | null;
    requestedAt: number;
    rawJson: string;
  }): void {
    this.insertApproval.run({
      $id: record.id,
      $coding_cli_session_id: record.sessionId,
      $task_id: record.taskId,
      $request_id: record.requestId,
      $command: record.command,
      $reason: record.reason,
      $policy_decision: record.policyDecision,
      $human_decision: record.humanDecision,
      $decided_by: record.decidedBy,
      $decided_at: record.decidedAt,
      $requested_at: record.requestedAt,
      $raw_json: record.rawJson,
    });
  }

  resolveApproval(sessionId: string, requestId: string, humanDecision: string, decidedBy: string, decidedAt: number): void {
    this.updateApproval.run({
      $coding_cli_session_id: sessionId,
      $request_id: requestId,
      $human_decision: humanDecision,
      $decided_by: decidedBy,
      $decided_at: decidedAt,
    });
  }

  listApprovals(sessionId: string): ApprovalRow[] {
    return this.db
      .query<ApprovalRow, [string]>(
        `SELECT * FROM coding_cli_approvals WHERE coding_cli_session_id = ? ORDER BY requested_at ASC`,
      )
      .all(sessionId);
  }

  recordDecision(record: {
    id: string;
    sessionId: string;
    taskId: string;
    decision: string;
    rationale: string;
    alternativesJson: string;
    ts: number;
  }): void {
    this.insertDecision.run({
      $id: record.id,
      $coding_cli_session_id: record.sessionId,
      $task_id: record.taskId,
      $decision: record.decision,
      $rationale: record.rationale,
      $alternatives_json: record.alternativesJson,
      $ts: record.ts,
    });
  }

  listDecisions(sessionId: string): DecisionRow[] {
    return this.db
      .query<DecisionRow, [string]>(
        `SELECT * FROM coding_cli_decisions WHERE coding_cli_session_id = ? ORDER BY ts ASC`,
      )
      .all(sessionId);
  }

  private nextSeq(sessionId: string): number {
    const cached = this.seqBySession.get(sessionId);
    if (cached !== undefined) {
      const next = cached + 1;
      this.seqBySession.set(sessionId, next);
      return next;
    }
    const row = this.db
      .query<{ max: number | null }, [string]>(
        `SELECT MAX(seq) AS max FROM coding_cli_events WHERE coding_cli_session_id = ?`,
      )
      .get(sessionId);
    const next = (row?.max ?? 0) + 1;
    this.seqBySession.set(sessionId, next);
    return next;
  }

  private toRowParams(record: CodingCliSessionRecord) {
    return {
      $id: record.id,
      $task_id: record.taskId,
      $session_id: record.sessionId,
      $provider_id: record.providerId,
      $binary_path: record.binaryPath,
      $binary_version: record.binaryVersion,
      $capabilities_json: JSON.stringify(record.capabilities),
      $cwd: record.cwd,
      $pid: record.pid,
      $state: record.state,
      $started_at: record.startedAt,
      $updated_at: record.updatedAt,
      $ended_at: record.endedAt,
      $last_output_at: record.lastOutputAt,
      $last_hook_at: record.lastHookAt,
      $transcript_path: record.transcriptPath,
      $event_log_path: record.eventLogPath,
      $files_changed_json: JSON.stringify(record.filesChanged),
      $commands_requested_json: JSON.stringify(record.commandsRequested),
      $final_result_json: record.finalResult ? JSON.stringify(record.finalResult) : null,
      $raw_meta_json: JSON.stringify(record.rawMeta),
    };
  }
}

function rowToSession(row: SessionRow): CodingCliSessionRecord {
  return {
    id: row.id,
    taskId: row.task_id,
    sessionId: row.session_id,
    providerId: row.provider_id as CodingCliProviderId,
    binaryPath: row.binary_path,
    binaryVersion: row.binary_version,
    capabilities: safeJsonParse<CodingCliCapabilities>(row.capabilities_json, {} as CodingCliCapabilities),
    cwd: row.cwd,
    pid: row.pid,
    state: row.state as CodingCliSessionState,
    startedAt: row.started_at,
    updatedAt: row.updated_at,
    endedAt: row.ended_at,
    lastOutputAt: row.last_output_at,
    lastHookAt: row.last_hook_at,
    transcriptPath: row.transcript_path,
    eventLogPath: row.event_log_path,
    filesChanged: safeJsonParse<string[]>(row.files_changed_json, []),
    commandsRequested: safeJsonParse<string[]>(row.commands_requested_json, []),
    finalResult: row.final_result_json ? safeJsonParse<CodingCliResult | null>(row.final_result_json, null) : null,
    rawMeta: safeJsonParse<Record<string, unknown>>(row.raw_meta_json, {}),
  };
}

function safeJsonParse<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}
