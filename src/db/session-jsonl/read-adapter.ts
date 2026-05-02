/**
 * Session read adapters — Phase 3 of the JSONL hybrid migration.
 *
 * Each `SessionReadAdapter` implementation answers the same set of
 * read queries from a different backing store:
 *
 *   - `SqliteReadAdapter` — delegates to `SessionStore`. Today's path.
 *   - `JsonlReadAdapter`  — folds `events.jsonl` into the same shapes.
 *
 * `SessionManager` owns both, picks via per-method config flags
 * (`session.readFromJsonl.<method>`), and falls back to SQLite when
 * (a) the JSONL adapter has no log for a session (legacy), or
 * (b) `session.readFromJsonl.fallbackToSqlite=true` is set as a
 *     debug-mode safety net.
 *
 * `getTurn(turnId)` is the only adapter method NOT keyed by sessionId.
 * The legacy SQLite path looks it up by global `turn_id` PK; the JSONL
 * path requires a sessionId hint and a per-session scan, so the
 * adapter takes both args. SessionManager keeps the `(turnId)`
 * signature on its public API by routing through `findTaskRowById` /
 * caller context to recover the session id when the JSONL adapter is
 * active.
 */

import { existsSync } from 'node:fs';
import type { ContentBlock, Turn, TurnTokenCount } from '../../orchestrator/types.ts';
import type { SessionStore, SessionTaskRow } from '../session-store.ts';
import { type SessionDirLayout, sessionFiles } from './paths.ts';
import { JsonlReader } from './reader.ts';
import type { JsonlLine } from './schemas.ts';

export interface SessionReadAdapter {
  /** True when this adapter has authoritative data for `sessionId`. */
  hasSession(sessionId: string): boolean;
  /** Newest-first ordering of all turns in chronological order. */
  getTurns(sessionId: string, limit?: number): Turn[];
  /** Tail window — newest N turns returned in chronological order. */
  getRecentTurns(sessionId: string, limit: number): Turn[];
  /** Single turn lookup. JSONL adapter requires sessionId hint. */
  getTurn(sessionId: string | undefined, turnId: string): Turn | undefined;
  /** Total turn count. */
  countTurns(sessionId: string): number;
  /** Latest stored working memory snapshot, JSON-serialized. */
  getSessionWorkingMemory(sessionId: string): string | null;
  /** Tasks attached to a session (any state). */
  listSessionTasks(sessionId: string): SessionTaskRow[];
}

// ── SQLite adapter ──────────────────────────────────────────────────────

export class SqliteReadAdapter implements SessionReadAdapter {
  constructor(private readonly store: SessionStore) {}

  hasSession(sessionId: string): boolean {
    // bun-sqlite returns `null` (not `undefined`) on a miss, so use a
    // null-tolerant check.
    return this.store.getSession(sessionId) != null;
  }

  getTurns(sessionId: string, limit?: number): Turn[] {
    return this.store.getTurns(sessionId, limit);
  }

  getRecentTurns(sessionId: string, limit: number): Turn[] {
    return this.store.getRecentTurns(sessionId, limit);
  }

  getTurn(_sessionId: string | undefined, turnId: string): Turn | undefined {
    return this.store.getTurn(turnId);
  }

  countTurns(sessionId: string): number {
    return this.store.countTurns(sessionId);
  }

  getSessionWorkingMemory(sessionId: string): string | null {
    return this.store.getSession(sessionId)?.working_memory_json ?? null;
  }

  listSessionTasks(sessionId: string): SessionTaskRow[] {
    return this.store.listSessionTasks(sessionId);
  }
}

// ── JSONL adapter ───────────────────────────────────────────────────────

interface JsonlReadAdapterOptions {
  layout: SessionDirLayout;
  /**
   * Optional fallback for queries the JSONL adapter cannot fully answer
   * itself — e.g. when the session has no JSONL log yet (`hasJsonl=false`)
   * or when a single-turn lookup needs the SQLite `(turn_id)` PK index.
   * SessionManager passes the SQLite adapter here.
   */
  fallback?: SessionReadAdapter;
}

interface FoldedTurn {
  turn: Turn;
  cancelled: boolean;
}

interface FoldedTask {
  taskId: string;
  status: SessionTaskRow['status'];
  taskInputJson: string;
  resultJson: string | null;
  createdAt: number;
  updatedAt: number;
  archivedAt: number | null;
}

interface FoldedSession {
  turns: Map<string, FoldedTurn>; // keyed by turnId for cancel/token updates
  turnOrder: string[]; // turnId order of insertion
  tasks: Map<string, FoldedTask>;
  workingMemoryJson: string | null;
}

function obj(v: unknown): Record<string, unknown> | undefined {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}
function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

export class JsonlReadAdapter implements SessionReadAdapter {
  private readonly reader: JsonlReader;
  private readonly fallback?: SessionReadAdapter;

  constructor(opts: JsonlReadAdapterOptions) {
    this.reader = new JsonlReader(opts.layout);
    this.fallback = opts.fallback;
    this.layout = opts.layout;
  }

  private readonly layout: SessionDirLayout;

  /** True when an `events.jsonl` exists for this session. */
  hasJsonl(sessionId: string): boolean {
    try {
      const files = sessionFiles(this.layout, sessionId);
      return existsSync(files.events);
    } catch {
      // Invalid sessionId char → no JSONL.
      return false;
    }
  }

  hasSession(sessionId: string): boolean {
    if (this.hasJsonl(sessionId)) return true;
    return this.fallback?.hasSession(sessionId) ?? false;
  }

  getTurns(sessionId: string, limit?: number): Turn[] {
    if (!this.hasJsonl(sessionId)) {
      return this.fallback?.getTurns(sessionId, limit) ?? [];
    }
    const folded = this.foldSession(sessionId);
    const ordered = folded.turnOrder.map((id) => folded.turns.get(id)!.turn);
    return limit != null ? ordered.slice(0, limit) : ordered;
  }

  getRecentTurns(sessionId: string, limit: number): Turn[] {
    if (!this.hasJsonl(sessionId)) {
      return this.fallback?.getRecentTurns(sessionId, limit) ?? [];
    }
    const folded = this.foldSession(sessionId);
    const ordered = folded.turnOrder.map((id) => folded.turns.get(id)!.turn);
    return ordered.slice(Math.max(0, ordered.length - limit));
  }

  getTurn(sessionId: string | undefined, turnId: string): Turn | undefined {
    // JSONL is per-session; without a session hint we delegate to the
    // SQLite fallback (which does a global PK lookup on session_turns).
    if (!sessionId) return this.fallback?.getTurn(undefined, turnId);
    if (!this.hasJsonl(sessionId)) {
      return this.fallback?.getTurn(sessionId, turnId);
    }
    const folded = this.foldSession(sessionId);
    return folded.turns.get(turnId)?.turn;
  }

  countTurns(sessionId: string): number {
    if (!this.hasJsonl(sessionId)) {
      return this.fallback?.countTurns(sessionId) ?? 0;
    }
    return this.foldSession(sessionId).turnOrder.length;
  }

  getSessionWorkingMemory(sessionId: string): string | null {
    if (!this.hasJsonl(sessionId)) {
      return this.fallback?.getSessionWorkingMemory(sessionId) ?? null;
    }
    const folded = this.foldSession(sessionId);
    if (folded.workingMemoryJson !== null) return folded.workingMemoryJson;
    // No working-memory.snapshot line in the log yet — fall back to the
    // SQLite cache column. Phase 4 stops persisting that column, but
    // until then it's the authoritative source for legacy state.
    return this.fallback?.getSessionWorkingMemory(sessionId) ?? null;
  }

  listSessionTasks(sessionId: string): SessionTaskRow[] {
    if (!this.hasJsonl(sessionId)) {
      return this.fallback?.listSessionTasks(sessionId) ?? [];
    }
    const folded = this.foldSession(sessionId);
    return [...folded.tasks.values()]
      .sort((a, b) => a.createdAt - b.createdAt)
      .map<SessionTaskRow>((t) => ({
        session_id: sessionId,
        task_id: t.taskId,
        task_input_json: t.taskInputJson,
        status: t.status,
        result_json: t.resultJson,
        created_at: t.createdAt,
        updated_at: t.updatedAt,
        archived_at: t.archivedAt,
      }));
  }

  // ── Internal fold ─────────────────────────────────────────────────────

  /**
   * Re-fold the JSONL log into a derived per-session state. Phase 3 does
   * a full scan on every call — same complexity profile as the rebuilder
   * but called from the read path. Phase 5 (segment manifest + snapshot
   * sidecar) caches this; Phase 3 ships correctness first.
   */
  private foldSession(sessionId: string): FoldedSession {
    const state: FoldedSession = {
      turns: new Map(),
      turnOrder: [],
      tasks: new Map(),
      workingMemoryJson: null,
    };
    for (const item of this.reader.scan(sessionId)) {
      if ('error' in item) continue;
      this.foldLine(sessionId, item.line, state);
    }
    return state;
  }

  private foldLine(sessionId: string, line: JsonlLine, s: FoldedSession): void {
    const payload = obj(line.payload) ?? {};
    switch (line.kind) {
      case 'turn.appended': {
        const role = str(payload['role']);
        if (role !== 'user' && role !== 'assistant') return;
        const turnId = str(payload['turnId']) ?? line.lineId;
        const blocks = (payload['blocks'] as ContentBlock[] | undefined) ?? [];
        const tokenCount = (payload['tokenCount'] as TurnTokenCount | undefined) ?? {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheCreation: 0,
        };
        const taskId = str(payload['taskId']);
        const turn: Turn = {
          id: turnId,
          sessionId,
          seq: line.seq,
          role,
          blocks,
          tokenCount,
          createdAt: line.ts,
          ...(taskId ? { taskId } : {}),
        };
        if (!s.turns.has(turnId)) s.turnOrder.push(turnId);
        s.turns.set(turnId, { turn, cancelled: false });
        return;
      }
      case 'turn.token-count.updated': {
        const turnId = str(payload['turnId']);
        const tokenCount = payload['tokenCount'] as TurnTokenCount | undefined;
        if (!turnId || !tokenCount) return;
        const existing = s.turns.get(turnId);
        if (existing) existing.turn = { ...existing.turn, tokenCount };
        return;
      }
      case 'turn.cancelled': {
        const turnId = str(payload['turnId']);
        if (!turnId) return;
        const existing = s.turns.get(turnId);
        if (existing) {
          existing.cancelled = true;
          existing.turn = { ...existing.turn, cancelledAt: line.ts };
          const partials = payload['partialBlocks'] as ContentBlock[] | undefined;
          if (partials) existing.turn = { ...existing.turn, blocks: partials };
        }
        return;
      }
      case 'task.created': {
        const taskId = str(payload['taskId']);
        if (!taskId) return;
        s.tasks.set(taskId, {
          taskId,
          status: 'pending',
          taskInputJson: JSON.stringify(payload['input'] ?? {}),
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
        const allowed: SessionTaskRow['status'][] = ['pending', 'running', 'completed', 'failed', 'cancelled'];
        if (!taskId || !to || !allowed.includes(to as SessionTaskRow['status'])) return;
        const existing = s.tasks.get(taskId) ?? {
          taskId,
          status: 'pending' as const,
          taskInputJson: '{}',
          resultJson: null,
          createdAt: line.ts,
          updatedAt: line.ts,
          archivedAt: null,
        };
        existing.status = to as SessionTaskRow['status'];
        existing.updatedAt = line.ts;
        if ('result' in payload) existing.resultJson = JSON.stringify(payload['result']);
        s.tasks.set(taskId, existing);
        return;
      }
      case 'task.archived': {
        const taskId = str(payload['taskId']);
        if (!taskId) return;
        const existing = s.tasks.get(taskId);
        if (existing) {
          existing.archivedAt = line.ts;
          existing.updatedAt = line.ts;
        }
        return;
      }
      case 'working-memory.snapshot': {
        if (payload['memory'] !== undefined) {
          s.workingMemoryJson = JSON.stringify(payload['memory']);
        }
        return;
      }
      // Other kinds (session.*) don't influence read-adapter output here.
    }
  }
}
