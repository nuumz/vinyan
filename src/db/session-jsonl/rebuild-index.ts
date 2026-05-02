/**
 * IndexRebuilder — fold a session's JSONL stream into the SQLite
 * derived index in a single transaction.
 *
 * Used by:
 *   - `vinyan session rebuild-index <id|--all>` (Phase 1 CLI)
 *   - Phase 2 async-repair when a SQLite write fails after the JSONL
 *     append succeeds (JSONL is authoritative; index catches up)
 *   - Phase 5 startup recovery scan
 *
 * Payload extraction is intentionally tolerant. Phase 1 leaves payload
 * shapes as `z.unknown()` so Phase 2 can tighten per-kind without a
 * lockstep schema rewrite. The rebuilder reads payload fields via
 * narrow accessors that return `undefined` on shape mismatch — a
 * malformed line never breaks the rebuild for the rest (A9).
 */
import type { Database } from 'bun:sqlite';
import type { SessionDirLayout } from './paths.ts';
import { JsonlReader } from './reader.ts';
import type { JsonlLine } from './schemas.ts';

export interface RebuildReport {
  sessionId: string;
  linesRead: number;
  errors: number;
  /** Byte offset of the next free position in events.jsonl. */
  endOffset: number;
  lastLineId: string | null;
  durationMs: number;
}

interface SessionAccum {
  exists: boolean;
  source: string | null;
  status: 'active' | 'suspended' | 'compacted' | 'closed';
  title: string | null;
  description: string | null;
  archivedAt: number | null;
  deletedAt: number | null;
  workingMemoryJson: string | null;
  compactionJson: string | null;
  createdAt: number | null;
  updatedAt: number;
  lastLineId: string | null;
  lastLineOffset: number;
}

interface TaskAccum {
  taskInputJson: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
  resultJson: string | null;
  createdAt: number;
  updatedAt: number;
  archivedAt: number | null;
}

interface TurnSummaryAccum {
  latestSeq: number | null;
  latestTurnId: string | null;
  latestTurnRole: 'user' | 'assistant' | null;
  latestBlocksPreview: string | null;
  turnCount: number;
  updatedAt: number;
}

/** Cap a JSON-serialized blocks payload for the preview column. */
const BLOCKS_PREVIEW_LIMIT = 4096;

function obj(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function blocksPreview(value: unknown): string | null {
  if (value === undefined) return null;
  const json = JSON.stringify(value);
  return json.length > BLOCKS_PREVIEW_LIMIT ? json.slice(0, BLOCKS_PREVIEW_LIMIT) : json;
}

export class IndexRebuilder {
  constructor(
    private readonly db: Database,
    private readonly layout: SessionDirLayout,
  ) {}

  /**
   * Rebuild the SQLite index for one session from its JSONL log.
   * Single transaction — either the full rebuild lands or none does.
   */
  rebuildSessionIndex(sessionId: string): RebuildReport {
    const startedAt = Date.now();
    const reader = new JsonlReader(this.layout);
    const { lines, errors, endOffset } = reader.scanAll(sessionId);

    const session: SessionAccum = {
      exists: false,
      source: null,
      status: 'active',
      title: null,
      description: null,
      archivedAt: null,
      deletedAt: null,
      workingMemoryJson: null,
      compactionJson: null,
      createdAt: null,
      updatedAt: 0,
      lastLineId: null,
      lastLineOffset: 0,
    };
    const tasks = new Map<string, TaskAccum>();
    const turnSummary: TurnSummaryAccum = {
      latestSeq: null,
      latestTurnId: null,
      latestTurnRole: null,
      latestBlocksPreview: null,
      turnCount: 0,
      updatedAt: 0,
    };

    for (const { line } of lines) {
      this.foldLine(line, session, tasks, turnSummary);
      session.lastLineId = line.lineId;
    }
    session.lastLineOffset = endOffset;

    const tx = this.db.transaction(() => {
      const hasSessionRow = this.applySession(sessionId, session);
      // Tasks and turn summary FK to session_store; skip them when we
      // could not authoritatively place a session_store row (orphan
      // JSONL with no `session.created` line).
      if (hasSessionRow) {
        this.applyTasks(sessionId, tasks);
        this.applyTurnSummary(sessionId, turnSummary);
      }
    });
    tx();

    return {
      sessionId,
      linesRead: lines.length,
      errors: errors.length,
      endOffset,
      lastLineId: session.lastLineId,
      durationMs: Date.now() - startedAt,
    };
  }

  rebuildAll(): RebuildReport[] {
    const rows = this.db.query('SELECT id FROM session_store').all() as Array<{ id: string }>;
    return rows.map((r) => this.rebuildSessionIndex(r.id));
  }

  // ── Fold ──────────────────────────────────────────────────────────────

  private foldLine(line: JsonlLine, s: SessionAccum, tasks: Map<string, TaskAccum>, t: TurnSummaryAccum): void {
    const payload = obj(line.payload) ?? {};
    s.updatedAt = Math.max(s.updatedAt, line.ts);

    switch (line.kind) {
      case 'session.created': {
        s.exists = true;
        s.source = str(payload['source']) ?? line.actor.kind;
        s.title = str(payload['title']) ?? null;
        s.description = str(payload['description']) ?? null;
        s.createdAt = line.ts;
        return;
      }
      case 'session.metadata.updated': {
        if ('title' in payload) s.title = str(payload['title']) ?? null;
        if ('description' in payload) s.description = str(payload['description']) ?? null;
        return;
      }
      case 'session.status.changed': {
        const to = str(payload['to']);
        if (to === 'active' || to === 'suspended' || to === 'compacted' || to === 'closed') {
          s.status = to;
        }
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
      case 'session.compacted': {
        const compaction = payload['compaction'];
        if (compaction !== undefined) s.compactionJson = JSON.stringify(compaction);
        s.status = 'compacted';
        return;
      }
      case 'task.created': {
        const taskId = str(payload['taskId']);
        if (!taskId) return;
        tasks.set(taskId, {
          taskInputJson: JSON.stringify(payload['input'] ?? {}),
          status: 'pending',
          resultJson: null,
          createdAt: line.ts,
          updatedAt: line.ts,
          archivedAt: null,
        });
        return;
      }
      case 'task.status.changed': {
        const taskId = str(payload['taskId']);
        const to = str(payload['to']);
        if (!taskId || !to) return;
        const existing = tasks.get(taskId);
        const allowed = ['pending', 'running', 'completed', 'failed', 'cancelled'] as const;
        if (!allowed.includes(to as (typeof allowed)[number])) return;
        const next: TaskAccum = existing ?? {
          taskInputJson: '{}',
          status: 'pending',
          resultJson: null,
          createdAt: line.ts,
          updatedAt: line.ts,
          archivedAt: null,
        };
        next.status = to as TaskAccum['status'];
        next.updatedAt = line.ts;
        if ('result' in payload) next.resultJson = JSON.stringify(payload['result']);
        tasks.set(taskId, next);
        return;
      }
      case 'task.archived': {
        const taskId = str(payload['taskId']);
        if (!taskId) return;
        const existing = tasks.get(taskId);
        if (!existing) return;
        existing.archivedAt = line.ts;
        existing.updatedAt = line.ts;
        return;
      }
      case 'turn.appended': {
        const role = str(payload['role']);
        if (role !== 'user' && role !== 'assistant') return;
        t.latestSeq = line.seq;
        t.latestTurnId = str(payload['turnId']) ?? line.lineId;
        t.latestTurnRole = role;
        t.latestBlocksPreview = blocksPreview(payload['blocks']);
        t.turnCount += 1;
        t.updatedAt = line.ts;
        return;
      }
      case 'turn.token-count.updated':
      case 'turn.cancelled':
        t.updatedAt = line.ts;
        return;
      case 'working-memory.snapshot': {
        const memory = payload['memory'];
        if (memory !== undefined) s.workingMemoryJson = JSON.stringify(memory);
        return;
      }
    }
  }

  // ── Apply ─────────────────────────────────────────────────────────────

  private applySession(sessionId: string, s: SessionAccum): boolean {
    // bun:sqlite `.get()` returns `null` (not `undefined`) on a miss.
    const existing = this.db.query('SELECT id FROM session_store WHERE id = ?').get(sessionId) as { id: string } | null;
    if (!s.exists && s.createdAt === null) {
      // No `session.created` line — nothing to upsert. The session
      // either never existed or its creation happened before logging
      // started; either way the index has nothing authoritative.
      // Existing rows are left alone so partial JSONL streams cannot
      // delete prior state.
      return existing != null;
    }
    const createdAt = s.createdAt ?? Date.now();
    const updatedAt = s.updatedAt || createdAt;
    if (existing != null) {
      this.db.run(
        `UPDATE session_store
            SET source = ?, status = ?, working_memory_json = ?, compaction_json = ?,
                updated_at = ?, title = ?, description = ?,
                archived_at = ?, deleted_at = ?,
                last_line_id = ?, last_line_offset = ?
          WHERE id = ?`,
        [
          s.source ?? 'unknown',
          s.status,
          s.workingMemoryJson,
          s.compactionJson,
          updatedAt,
          s.title,
          s.description,
          s.archivedAt,
          s.deletedAt,
          s.lastLineId,
          s.lastLineOffset,
          sessionId,
        ],
      );
    } else {
      this.db.run(
        `INSERT INTO session_store
            (id, source, created_at, status, working_memory_json, compaction_json,
             updated_at, title, description, archived_at, deleted_at,
             last_line_id, last_line_offset)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          sessionId,
          s.source ?? 'unknown',
          createdAt,
          s.status,
          s.workingMemoryJson,
          s.compactionJson,
          updatedAt,
          s.title,
          s.description,
          s.archivedAt,
          s.deletedAt,
          s.lastLineId,
          s.lastLineOffset,
        ],
      );
    }
    return true;
  }

  private applyTasks(sessionId: string, tasks: Map<string, TaskAccum>): void {
    // Reset is intentional: rebuild = authoritative replay. Phase 4
    // will lift this to keep ledger semantics consistent across DROP
    // session_turns, but for now we want a clean slate per rebuild.
    this.db.run('DELETE FROM session_tasks WHERE session_id = ?', [sessionId]);
    for (const [taskId, t] of tasks) {
      this.db.run(
        `INSERT INTO session_tasks
            (session_id, task_id, task_input_json, status, result_json, created_at, updated_at, archived_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [sessionId, taskId, t.taskInputJson, t.status, t.resultJson, t.createdAt, t.updatedAt, t.archivedAt],
      );
    }
  }

  private applyTurnSummary(sessionId: string, t: TurnSummaryAccum): void {
    if (t.turnCount === 0 && t.latestTurnId === null) {
      this.db.run('DELETE FROM session_turn_summary WHERE session_id = ?', [sessionId]);
      return;
    }
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
          turn_count = excluded.turn_count,
          updated_at = excluded.updated_at`,
      [
        sessionId,
        t.latestSeq,
        t.latestTurnId,
        t.latestTurnRole,
        t.latestBlocksPreview,
        t.turnCount,
        t.updatedAt || Date.now(),
      ],
    );
  }
}
