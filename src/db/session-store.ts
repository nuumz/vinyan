/**
 * Session Store — CRUD for API sessions, session tasks, and conversation messages.
 *
 * Follows WorkerStore pattern: SQLite-backed, Zod-validated at boundaries.
 * Source of truth: spec/tdd.md §22.5
 */
import type { Database } from 'bun:sqlite';

export interface SessionRow {
  id: string;
  source: string;
  created_at: number;
  status: 'active' | 'suspended' | 'compacted' | 'closed';
  working_memory_json: string | null;
  compaction_json: string | null;
  updated_at: number;
}

export interface SessionTaskRow {
  session_id: string;
  task_id: string;
  task_input_json: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
  result_json: string | null;
  created_at: number;
}

export interface SessionMessageRow {
  id: number;
  session_id: string;
  task_id: string | null;
  role: 'user' | 'assistant' | 'system';
  content: string;
  thinking: string | null;
  tools_used: string | null;
  token_estimate: number;
  created_at: number;
}

export class SessionStore {
  constructor(private db: Database) {}

  insertSession(session: SessionRow): void {
    this.db.run(
      `INSERT INTO session_store (id, source, created_at, status, working_memory_json, compaction_json, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        session.id,
        session.source,
        session.created_at,
        session.status,
        session.working_memory_json,
        session.compaction_json,
        session.updated_at,
      ],
    );
  }

  getSession(id: string): SessionRow | undefined {
    return this.db.query('SELECT * FROM session_store WHERE id = ?').get(id) as SessionRow | undefined;
  }

  updateSessionStatus(id: string, status: SessionRow['status']): void {
    this.db.run('UPDATE session_store SET status = ?, updated_at = ? WHERE id = ?', [status, Date.now(), id]);
  }

  updateSessionCompaction(id: string, compactionJson: string): void {
    this.db.run("UPDATE session_store SET compaction_json = ?, status = 'compacted', updated_at = ? WHERE id = ?", [
      compactionJson,
      Date.now(),
      id,
    ]);
  }

  updateSessionMemory(id: string, memoryJson: string): void {
    this.db.run('UPDATE session_store SET working_memory_json = ?, updated_at = ? WHERE id = ?', [
      memoryJson,
      Date.now(),
      id,
    ]);
  }

  listActiveSessions(): SessionRow[] {
    return this.db
      .query("SELECT * FROM session_store WHERE status = 'active' ORDER BY created_at DESC")
      .all() as SessionRow[];
  }

  listSuspendedSessions(): SessionRow[] {
    return this.db
      .query("SELECT * FROM session_store WHERE status = 'suspended' ORDER BY created_at DESC")
      .all() as SessionRow[];
  }

  // ── Session Tasks ───────────────────────────────────────

  insertTask(task: SessionTaskRow): void {
    this.db.run(
      `INSERT INTO session_tasks (session_id, task_id, task_input_json, status, result_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [task.session_id, task.task_id, task.task_input_json, task.status, task.result_json, task.created_at],
    );
  }

  getTask(sessionId: string, taskId: string): SessionTaskRow | undefined {
    return this.db.query('SELECT * FROM session_tasks WHERE session_id = ? AND task_id = ?').get(sessionId, taskId) as
      | SessionTaskRow
      | undefined;
  }

  updateTaskStatus(sessionId: string, taskId: string, status: SessionTaskRow['status'], resultJson?: string): void {
    this.db.run('UPDATE session_tasks SET status = ?, result_json = ? WHERE session_id = ? AND task_id = ?', [
      status,
      resultJson ?? null,
      sessionId,
      taskId,
    ]);
  }

  listSessionTasks(sessionId: string): SessionTaskRow[] {
    return this.db
      .query('SELECT * FROM session_tasks WHERE session_id = ? ORDER BY created_at ASC')
      .all(sessionId) as SessionTaskRow[];
  }

  countSessionTasks(sessionId: string): number {
    const row = this.db.query('SELECT COUNT(*) as count FROM session_tasks WHERE session_id = ?').get(sessionId) as {
      count: number;
    };
    return row.count;
  }

  listPendingTasks(): SessionTaskRow[] {
    return this.db
      .query("SELECT * FROM session_tasks WHERE status IN ('pending', 'running') ORDER BY created_at ASC")
      .all() as SessionTaskRow[];
  }

  // ── Session Messages (Conversation Agent Mode) ──────────

  insertMessage(msg: Omit<SessionMessageRow, 'id'>): void {
    this.db.run(
      `INSERT INTO session_messages (session_id, task_id, role, content, thinking, tools_used, token_estimate, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [msg.session_id, msg.task_id, msg.role, msg.content, msg.thinking, msg.tools_used, msg.token_estimate, msg.created_at],
    );
  }

  getMessages(sessionId: string, limit?: number): SessionMessageRow[] {
    if (limit != null) {
      return this.db
        .query('SELECT * FROM session_messages WHERE session_id = ? ORDER BY created_at ASC LIMIT ?')
        .all(sessionId, limit) as SessionMessageRow[];
    }
    return this.db
      .query('SELECT * FROM session_messages WHERE session_id = ? ORDER BY created_at ASC')
      .all(sessionId) as SessionMessageRow[];
  }

  countMessages(sessionId: string): number {
    const row = this.db.query('SELECT COUNT(*) as count FROM session_messages WHERE session_id = ?').get(sessionId) as { count: number };
    return row.count;
  }

  /**
   * Get recent messages within a token budget (newest first, reversed to chronological order).
   * Walks backward from newest until token budget is exhausted.
   */
  getRecentMessages(sessionId: string, maxTokens: number): SessionMessageRow[] {
    const all = this.db
      .query('SELECT * FROM session_messages WHERE session_id = ? ORDER BY created_at DESC')
      .all(sessionId) as SessionMessageRow[];

    const result: SessionMessageRow[] = [];
    let tokens = 0;
    for (const msg of all) {
      tokens += msg.token_estimate;
      if (tokens > maxTokens && result.length > 0) break;
      result.push(msg);
    }
    return result.reverse(); // chronological order
  }
}
