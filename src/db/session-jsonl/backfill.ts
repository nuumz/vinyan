/**
 * Phase 4 backfill — synthesize `events.jsonl` from existing SQLite
 * data so a session retains its conversation history through
 * migration 037 (which drops `session_turns`).
 *
 * For each eligible session we replay the SQLite tables in causal
 * order:
 *
 *   1. `session.created`   ← session_store row
 *   2. `task.created` + `task.status.changed` per session_tasks row
 *   3. `turn.appended` per session_turns row, in seq order
 *   4. `working-memory.snapshot` from session_store.working_memory_json
 *   5. `session.compacted` from session_store.compaction_json
 *
 * Idempotent: if `events.jsonl` already has any line for a session,
 * we skip — the dual-write path or a previous backfill already wrote
 * authoritative state. The CLI can be re-run safely.
 *
 * Filter: `--since=<duration>` (default = no filter / all sessions).
 * Sessions with `updated_at` older than the cutoff are skipped per
 * the user policy chosen at plan time ("discard old sessions"); their
 * turn history is forfeited when migration 037 runs.
 */
import type { Database } from 'bun:sqlite';
import { existsSync, statSync } from 'node:fs';
import type { JsonlAppender } from './appender.ts';
import { type SessionDirLayout, sessionFiles } from './paths.ts';
import type { Actor, Kind } from './schemas.ts';

export interface BackfillOptions {
  /** ms — only backfill sessions with updated_at >= now() - sinceMs. Omit for no filter. */
  sinceMs?: number;
  /** When true, compute counts but do not write any JSONL line. */
  dryRun?: boolean;
}

export interface BackfillReport {
  /** Total sessions visited (before any skip). */
  scanned: number;
  /** Sessions actually backfilled this run (had no JSONL or empty). */
  backfilled: number;
  /** Sessions skipped because they already have a non-empty events.jsonl. */
  skippedExisting: number;
  /** Sessions skipped because they fell outside the `--since` window. */
  skippedTooOld: number;
  /** Total JSONL lines written across all sessions (0 in dry-run). */
  linesWritten: number;
  /** Per-session breakdown for traceability. */
  perSession: Array<{
    sessionId: string;
    status: 'backfilled' | 'skipped-existing' | 'skipped-too-old';
    linesWritten: number;
  }>;
}

interface SessionRowReadShape {
  id: string;
  source: string;
  status: string;
  created_at: number;
  updated_at: number;
  title: string | null;
  description: string | null;
  archived_at: number | null;
  deleted_at: number | null;
  working_memory_json: string | null;
  compaction_json: string | null;
}

interface TaskRowReadShape {
  task_id: string;
  task_input_json: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
  result_json: string | null;
  created_at: number;
  updated_at: number | null;
  archived_at: number | null;
}

interface TurnRowReadShape {
  id: string;
  seq: number;
  role: 'user' | 'assistant';
  blocks_json: string;
  cancelled_at: number | null;
  token_count_json: string;
  task_id: string | null;
  created_at: number;
}

/**
 * Map session.source to a default actor.kind for synthesized lines.
 * Older sessions only stored `source` (cli/api/gateway-*); we mirror
 * that into actor.kind because the original actor identity isn't
 * recoverable.
 */
function defaultActor(source: string): Actor {
  if (source === 'cli') return { kind: 'cli' };
  if (source === 'api') return { kind: 'api' };
  return { kind: 'system' };
}

function userActor(source: string): Actor {
  // For user turns we record actor.kind='user' regardless of source —
  // the boundary that originally captured the message classified it
  // as a user message; preserving that here keeps the JSONL fold
  // consistent with the dual-write path.
  return { kind: 'user', id: source };
}

export function backfillSessions(
  db: Database,
  layout: SessionDirLayout,
  appender: JsonlAppender,
  opts: BackfillOptions = {},
): BackfillReport {
  const { sinceMs, dryRun = false } = opts;
  const cutoff = sinceMs !== undefined ? Date.now() - sinceMs : null;

  const sessionRows = db
    .query(
      `SELECT id, source, status, created_at, updated_at, title, description,
              archived_at, deleted_at, working_memory_json, compaction_json
       FROM session_store
       ORDER BY created_at ASC`,
    )
    .all() as SessionRowReadShape[];

  const report: BackfillReport = {
    scanned: sessionRows.length,
    backfilled: 0,
    skippedExisting: 0,
    skippedTooOld: 0,
    linesWritten: 0,
    perSession: [],
  };

  for (const session of sessionRows) {
    if (cutoff !== null && session.updated_at < cutoff) {
      report.skippedTooOld += 1;
      report.perSession.push({ sessionId: session.id, status: 'skipped-too-old', linesWritten: 0 });
      continue;
    }

    const files = sessionFiles(layout, session.id);
    if (existsSync(files.events) && statSync(files.events).size > 0) {
      report.skippedExisting += 1;
      report.perSession.push({ sessionId: session.id, status: 'skipped-existing', linesWritten: 0 });
      continue;
    }

    let linesWrittenForSession = 0;
    const append = (kind: Kind, payload: unknown, actor: Actor): void => {
      if (dryRun) {
        linesWrittenForSession += 1;
        return;
      }
      appender.appendSync(session.id, { kind, payload, actor });
      linesWrittenForSession += 1;
    };

    // 1. session.created
    append(
      'session.created',
      { source: session.source, title: session.title, description: session.description },
      defaultActor(session.source),
    );
    if (session.archived_at !== null) {
      append('session.archived', {}, { kind: 'user' });
    }
    if (session.deleted_at !== null) {
      append('session.deleted', {}, { kind: 'user' });
    }

    // 2. tasks
    const tasks = db
      .query(
        `SELECT task_id, task_input_json, status, result_json, created_at, updated_at, archived_at
         FROM session_tasks WHERE session_id = ? ORDER BY created_at ASC`,
      )
      .all(session.id) as TaskRowReadShape[];
    for (const task of tasks) {
      let input: unknown = {};
      try {
        input = JSON.parse(task.task_input_json);
      } catch {
        /* keep as empty object */
      }
      append('task.created', { taskId: task.task_id, input }, { kind: 'orchestrator' });
      if (task.status !== 'pending') {
        let resultObj: unknown = null;
        if (task.result_json) {
          try {
            resultObj = JSON.parse(task.result_json);
          } catch {
            /* swallow */
          }
        }
        append(
          'task.status.changed',
          { taskId: task.task_id, from: 'pending', to: task.status, result: resultObj },
          { kind: 'orchestrator' },
        );
      }
      if (task.archived_at !== null) {
        append('task.archived', { taskId: task.task_id }, { kind: 'user' });
      }
    }

    // 3. turns (only when session_turns still exists — i.e., pre-mig 037)
    const turnsTableExists =
      db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='session_turns'").get() != null;
    if (turnsTableExists) {
      const turns = db
        .query(
          `SELECT id, seq, role, blocks_json, cancelled_at, token_count_json, task_id, created_at
           FROM session_turns WHERE session_id = ? ORDER BY seq ASC`,
        )
        .all(session.id) as TurnRowReadShape[];
      for (const turn of turns) {
        let blocks: unknown = [];
        let tokenCount: unknown = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 };
        try {
          blocks = JSON.parse(turn.blocks_json);
        } catch {
          /* swallow */
        }
        try {
          tokenCount = JSON.parse(turn.token_count_json);
        } catch {
          /* swallow */
        }
        const payload: Record<string, unknown> = {
          turnId: turn.id,
          role: turn.role,
          blocks,
          tokenCount,
        };
        if (turn.task_id) payload['taskId'] = turn.task_id;
        const actor = turn.role === 'user' ? userActor(session.source) : { kind: 'agent' as const };
        append('turn.appended', payload, actor);
        if (turn.cancelled_at !== null) {
          append('turn.cancelled', { turnId: turn.id }, actor);
        }
      }
    }

    // 4. working-memory.snapshot
    if (session.working_memory_json) {
      let memory: unknown = null;
      try {
        memory = JSON.parse(session.working_memory_json);
      } catch {
        /* swallow */
      }
      if (memory !== null) {
        append('working-memory.snapshot', { memory }, { kind: 'system' });
      }
    }

    // 5. session.compacted (if present)
    if (session.compaction_json) {
      let compaction: unknown = null;
      try {
        compaction = JSON.parse(session.compaction_json);
      } catch {
        /* swallow */
      }
      if (compaction !== null) {
        append('session.compacted', { taskCount: tasks.length, compaction }, { kind: 'system' });
      }
    }

    report.backfilled += 1;
    report.linesWritten += linesWrittenForSession;
    report.perSession.push({ sessionId: session.id, status: 'backfilled', linesWritten: linesWrittenForSession });
  }

  return report;
}

/** Parse a `--since` value like `30d`, `48h`, `45m` → milliseconds. */
export function parseDuration(input: string): number | undefined {
  const match = /^(\d+)([dhms])$/.exec(input.trim());
  if (!match) return undefined;
  const [, valueStr, unit] = match;
  const value = Number(valueStr);
  switch (unit) {
    case 'd':
      return value * 24 * 60 * 60 * 1000;
    case 'h':
      return value * 60 * 60 * 1000;
    case 'm':
      return value * 60 * 1000;
    case 's':
      return value * 1000;
    default:
      return undefined;
  }
}
