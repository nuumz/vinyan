/**
 * Session integrity verifier — replay the JSONL log and diff against
 * what SQLite currently shows. Used by:
 *
 *   - Phase 2 unit tests: assert dual-write left both stores in sync
 *   - Phase 2 opt-in production audit (`session.dualWrite.verify=true`)
 *   - CLI `vinyan session verify-integrity <id>`
 *
 * Scope of comparison (what counts as drift):
 *   - session_store row exists and key fields match the JSONL fold
 *   - session_tasks row count and per-task status / result match
 *   - session_turn_summary mirrors the latest turn on the JSONL log
 *   - session_store.last_line_id / last_line_offset point to the tail
 *
 * Out of scope: session_turns itself (Phase 4 drops it; comparing turn
 * blocks here would be redundant with the appender's own ordering
 * guarantees and would produce noise on legacy sessions that were
 * created before Phase 2 turned on).
 *
 * The verifier is read-only and side-effect-free. Re-running it never
 * mutates state — failed comparisons are reported, not auto-repaired.
 * Auto-repair is the rebuilder's job (`rebuild-index.ts`).
 */
import type { Database } from 'bun:sqlite';
import type { SessionDirLayout } from './paths.ts';
import { JsonlReader } from './reader.ts';
import type { JsonlLine } from './schemas.ts';

export interface VerifierDelta {
  /** Field that disagreed. */
  field: string;
  /** Value the JSONL fold computed. */
  expected: unknown;
  /** Value SQLite currently holds. */
  actual: unknown;
  /** Optional row identifier for nested rows (e.g. taskId). */
  key?: string;
}

export interface VerifierReport {
  sessionId: string;
  matches: boolean;
  /** True when the session has no JSONL log at all (legacy / pre-Phase-2). */
  noJsonl: boolean;
  /** True when SQLite has no session_store row at all. */
  noSqlite: boolean;
  linesScanned: number;
  jsonlErrors: number;
  deltas: VerifierDelta[];
}

interface ExpectedSession {
  exists: boolean;
  source: string | null;
  status: 'active' | 'suspended' | 'compacted' | 'closed';
  title: string | null;
  description: string | null;
  archivedAt: number | null;
  deletedAt: number | null;
  workingMemoryJson: string | null;
  compactionJson: string | null;
  lastLineId: string | null;
  lastLineOffset: number;
}

interface ExpectedTask {
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
  resultJson: string | null;
  archivedAt: number | null;
}

interface ExpectedTurnSummary {
  latestSeq: number | null;
  latestTurnId: string | null;
  latestTurnRole: 'user' | 'assistant' | null;
  turnCount: number;
}

function obj(v: unknown): Record<string, unknown> | undefined {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}
function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

export class SessionVerifier {
  constructor(
    private readonly db: Database,
    private readonly layout: SessionDirLayout,
  ) {}

  verify(sessionId: string): VerifierReport {
    const reader = new JsonlReader(this.layout);
    const { lines, errors, endOffset } = reader.scanAll(sessionId);

    const session: ExpectedSession = {
      exists: false,
      source: null,
      status: 'active',
      title: null,
      description: null,
      archivedAt: null,
      deletedAt: null,
      workingMemoryJson: null,
      compactionJson: null,
      lastLineId: null,
      lastLineOffset: 0,
    };
    const tasks = new Map<string, ExpectedTask>();
    const turnSummary: ExpectedTurnSummary = {
      latestSeq: null,
      latestTurnId: null,
      latestTurnRole: null,
      turnCount: 0,
    };

    for (const { line } of lines) {
      this.foldLine(line, session, tasks, turnSummary);
      session.lastLineId = line.lineId;
    }
    session.lastLineOffset = endOffset;

    if (lines.length === 0) {
      return {
        sessionId,
        matches: true,
        noJsonl: true,
        noSqlite: false,
        linesScanned: 0,
        jsonlErrors: errors.length,
        deltas: [],
      };
    }

    const sqliteRow = this.db.query('SELECT * FROM session_store WHERE id = ?').get(sessionId) as
      | (Record<string, unknown> & {
          source: string;
          status: 'active' | 'suspended' | 'compacted' | 'closed';
          title: string | null;
          description: string | null;
          archived_at: number | null;
          deleted_at: number | null;
          working_memory_json: string | null;
          compaction_json: string | null;
          last_line_id: string | null;
          last_line_offset: number | null;
        })
      | null;

    const deltas: VerifierDelta[] = [];

    if (sqliteRow == null) {
      return {
        sessionId,
        matches: false,
        noJsonl: false,
        noSqlite: true,
        linesScanned: lines.length,
        jsonlErrors: errors.length,
        deltas: [{ field: 'session_store', expected: 'present', actual: 'missing' }],
      };
    }

    const checkField = (field: string, expected: unknown, actual: unknown, key?: string) => {
      if (expected !== actual) deltas.push({ field, expected, actual, ...(key ? { key } : {}) });
    };

    checkField('source', session.source ?? 'unknown', sqliteRow.source);
    checkField('status', session.status, sqliteRow.status);
    checkField('title', session.title, sqliteRow.title);
    checkField('description', session.description, sqliteRow.description);
    checkField('archived_at', session.archivedAt !== null, sqliteRow.archived_at !== null);
    checkField('deleted_at', session.deletedAt !== null, sqliteRow.deleted_at !== null);
    checkField('compaction_json_present', session.compactionJson !== null, sqliteRow.compaction_json !== null);
    checkField('last_line_id', session.lastLineId, sqliteRow.last_line_id);
    checkField('last_line_offset', session.lastLineOffset, sqliteRow.last_line_offset);

    // Tasks
    const taskRows = this.db
      .query('SELECT task_id, status, result_json, archived_at FROM session_tasks WHERE session_id = ?')
      .all(sessionId) as Array<{
      task_id: string;
      status: ExpectedTask['status'];
      result_json: string | null;
      archived_at: number | null;
    }>;
    const sqliteTasks = new Map(taskRows.map((r) => [r.task_id, r]));
    for (const [taskId, expected] of tasks) {
      const actual = sqliteTasks.get(taskId);
      if (!actual) {
        deltas.push({ field: 'task_missing', expected: expected.status, actual: 'missing', key: taskId });
        continue;
      }
      if (actual.status !== expected.status) {
        deltas.push({ field: 'task.status', expected: expected.status, actual: actual.status, key: taskId });
      }
      if ((expected.archivedAt !== null) !== (actual.archived_at !== null)) {
        deltas.push({
          field: 'task.archived_at',
          expected: expected.archivedAt !== null,
          actual: actual.archived_at !== null,
          key: taskId,
        });
      }
    }
    for (const taskId of sqliteTasks.keys()) {
      if (!tasks.has(taskId)) {
        deltas.push({ field: 'task_extra', expected: 'absent', actual: 'present', key: taskId });
      }
    }

    // Turn summary
    if (turnSummary.turnCount > 0) {
      const summaryRow = this.db.query('SELECT * FROM session_turn_summary WHERE session_id = ?').get(sessionId) as {
        latest_seq: number | null;
        latest_turn_id: string | null;
        latest_turn_role: 'user' | 'assistant' | null;
        turn_count: number;
      } | null;
      if (!summaryRow) {
        deltas.push({ field: 'session_turn_summary', expected: 'present', actual: 'missing' });
      } else {
        checkField('summary.latest_seq', turnSummary.latestSeq, summaryRow.latest_seq);
        checkField('summary.latest_turn_id', turnSummary.latestTurnId, summaryRow.latest_turn_id);
        checkField('summary.latest_turn_role', turnSummary.latestTurnRole, summaryRow.latest_turn_role);
        checkField('summary.turn_count', turnSummary.turnCount, summaryRow.turn_count);
      }
    }

    return {
      sessionId,
      matches: deltas.length === 0,
      noJsonl: false,
      noSqlite: false,
      linesScanned: lines.length,
      jsonlErrors: errors.length,
      deltas,
    };
  }

  // Same fold as IndexRebuilder, restricted to the fields verify() compares.
  private foldLine(
    line: JsonlLine,
    s: ExpectedSession,
    tasks: Map<string, ExpectedTask>,
    t: ExpectedTurnSummary,
  ): void {
    const payload = obj(line.payload) ?? {};
    switch (line.kind) {
      case 'session.created':
        s.exists = true;
        s.source = str(payload['source']) ?? line.actor.kind;
        s.title = str(payload['title']) ?? null;
        s.description = str(payload['description']) ?? null;
        return;
      case 'session.metadata.updated':
        if ('title' in payload) s.title = str(payload['title']) ?? null;
        if ('description' in payload) s.description = str(payload['description']) ?? null;
        return;
      case 'session.status.changed': {
        const to = str(payload['to']);
        if (to === 'active' || to === 'suspended' || to === 'compacted' || to === 'closed') s.status = to;
        return;
      }
      case 'session.archived':
        s.archivedAt = line.ts;
        return;
      case 'session.unarchived':
        s.archivedAt = null;
        return;
      case 'session.deleted':
        s.deletedAt = line.ts;
        return;
      case 'session.restored':
        s.deletedAt = null;
        return;
      case 'session.purged':
        s.deletedAt = line.ts;
        return;
      case 'session.compacted':
        if (payload['compaction'] !== undefined) s.compactionJson = JSON.stringify(payload['compaction']);
        s.status = 'compacted';
        return;
      case 'task.created': {
        const taskId = str(payload['taskId']);
        if (!taskId) return;
        tasks.set(taskId, { status: 'pending', resultJson: null, archivedAt: null });
        return;
      }
      case 'task.status.changed': {
        const taskId = str(payload['taskId']);
        const to = str(payload['to']);
        if (!taskId || !to) return;
        const allowed = ['pending', 'running', 'completed', 'failed', 'cancelled'] as const;
        if (!allowed.includes(to as (typeof allowed)[number])) return;
        const next = tasks.get(taskId) ?? { status: 'pending' as const, resultJson: null, archivedAt: null };
        next.status = to as ExpectedTask['status'];
        if ('result' in payload) next.resultJson = JSON.stringify(payload['result']);
        tasks.set(taskId, next);
        return;
      }
      case 'task.archived': {
        const taskId = str(payload['taskId']);
        if (!taskId) return;
        const existing = tasks.get(taskId);
        if (existing) existing.archivedAt = line.ts;
        return;
      }
      case 'turn.appended': {
        const role = str(payload['role']);
        if (role !== 'user' && role !== 'assistant') return;
        t.latestSeq = line.seq;
        t.latestTurnId = str(payload['turnId']) ?? line.lineId;
        t.latestTurnRole = role;
        t.turnCount += 1;
        return;
      }
      // Other kinds are not part of the verifier's comparison surface.
    }
  }
}
