/**
 * Session Manager — groups tasks under sessions with compaction.
 *
 * A3 compliance: compaction is rule-based extraction, not LLM-generated.
 * I16: Original JSONL audit trail is never deleted by compaction.
 *
 * Source of truth: spec/tdd.md §22.3, §22.4
 */
import type { SessionRow, SessionStore } from '../db/session-store.ts';
import type { TraceStore } from '../db/trace-store.ts';
import type { ConversationEntry, TaskInput, TaskResult } from '../orchestrator/types.ts';

export interface Session {
  id: string;
  source: string;
  status: SessionRow['status'];
  createdAt: number;
  taskCount: number;
}

export interface CompactionResult {
  sessionId: string;
  episodeSummary: string;
  keyFailures: string[];
  successfulPatterns: string[];
  statistics: {
    totalTasks: number;
    successRate: number;
    avgDurationMs: number;
    totalTokens: number;
  };
  compactedAt: number;
}

export class SessionManager {
  constructor(
    private sessionStore: SessionStore,
    _traceStore?: TraceStore,
  ) {}

  create(source: string): Session {
    const id = crypto.randomUUID();
    const now = Date.now();

    this.sessionStore.insertSession({
      id,
      source,
      created_at: now,
      status: 'active',
      working_memory_json: null,
      compaction_json: null,
      updated_at: now,
    });

    return { id, source, status: 'active', createdAt: now, taskCount: 0 };
  }

  listSessions(): Session[] {
    const active = this.sessionStore.listActiveSessions();
    const suspended = this.sessionStore.listSuspendedSessions();
    return [...active, ...suspended].map((row) => ({
      id: row.id,
      source: row.source,
      status: row.status as Session['status'],
      createdAt: row.created_at,
      taskCount: 0,
    }));
  }

  get(sessionId: string): Session | undefined {
    const row = this.sessionStore.getSession(sessionId);
    if (!row) return undefined;

    return {
      id: row.id,
      source: row.source,
      status: row.status,
      createdAt: row.created_at,
      taskCount: this.sessionStore.countSessionTasks(sessionId),
    };
  }

  addTask(sessionId: string, taskInput: TaskInput): void {
    this.sessionStore.insertTask({
      session_id: sessionId,
      task_id: taskInput.id,
      task_input_json: JSON.stringify(taskInput),
      status: 'pending',
      result_json: null,
      created_at: Date.now(),
    });
  }

  completeTask(sessionId: string, taskId: string, result: TaskResult): void {
    this.sessionStore.updateTaskStatus(
      sessionId,
      taskId,
      result.status === 'completed' ? 'completed' : 'failed',
      JSON.stringify(result),
    );
  }

  /**
   * Rule-based session compaction (A3-compliant — no LLM in this path).
   *
   * Extracts patterns from completed tasks without deleting audit data (I16).
   */
  compact(sessionId: string): CompactionResult {
    const tasks = this.sessionStore.listSessionTasks(sessionId);
    const completedTasks = tasks.filter((t) => t.status === 'completed' || t.status === 'failed');

    // Compute statistics
    let totalDurationMs = 0;
    let totalTokens = 0;
    let successes = 0;
    const failures: string[] = [];
    const patterns: string[] = [];

    for (const task of completedTasks) {
      if (task.result_json) {
        try {
          const result = JSON.parse(task.result_json) as TaskResult;
          totalDurationMs += result.trace?.durationMs ?? 0;
          totalTokens += result.trace?.tokensConsumed ?? 0;

          if (result.status === 'completed') {
            successes++;
            // Extract successful approach as pattern
            if (result.trace?.approach) {
              patterns.push(`${result.trace.taskTypeSignature}: ${result.trace.approach}`);
            }
          } else {
            if (result.escalationReason) failures.push(result.escalationReason);
            else if (result.trace?.failureReason) failures.push(result.trace.failureReason);
          }
        } catch {
          // Malformed result — skip
        }
      }
    }

    const totalTasks = completedTasks.length;
    const compactionResult: CompactionResult = {
      sessionId,
      episodeSummary: `Session with ${totalTasks} tasks: ${successes} succeeded, ${totalTasks - successes} failed`,
      keyFailures: [...new Set(failures)].slice(0, 10),
      successfulPatterns: [...new Set(patterns)].slice(0, 10),
      statistics: {
        totalTasks,
        successRate: totalTasks > 0 ? successes / totalTasks : 0,
        avgDurationMs: totalTasks > 0 ? totalDurationMs / totalTasks : 0,
        totalTokens,
      },
      compactedAt: Date.now(),
    };

    // Persist compaction result — additive only, never deletes audit trail (I16)
    this.sessionStore.updateSessionCompaction(sessionId, JSON.stringify(compactionResult));

    return compactionResult;
  }

  /**
   * Recover suspended sessions on startup.
   */
  recover(): Session[] {
    const suspended = this.sessionStore.listSuspendedSessions();
    return suspended.map((row) => ({
      id: row.id,
      source: row.source,
      status: row.status,
      createdAt: row.created_at,
      taskCount: this.sessionStore.countSessionTasks(row.id),
    }));
  }

  /**
   * Suspend all active sessions (for graceful shutdown).
   */
  suspendAll(): number {
    const active = this.sessionStore.listActiveSessions();
    for (const session of active) {
      this.sessionStore.updateSessionStatus(session.id, 'suspended');
    }
    return active.length;
  }

  // ── Conversation Methods (Conversation Agent Mode) ──────

  /** Record a user message in the conversation history. */
  recordUserTurn(sessionId: string, content: string): void {
    this.sessionStore.insertMessage({
      session_id: sessionId,
      task_id: null,
      role: 'user',
      content,
      thinking: null,
      tools_used: null,
      token_estimate: estimateTokens(content),
      created_at: Date.now(),
    });
  }

  /** Record an assistant response from a TaskResult. */
  recordAssistantTurn(sessionId: string, taskId: string, result: TaskResult): void {
    const content = result.answer ?? (result.mutations.map(m => `Modified ${m.file}`).join('\n') || '(no response)');
    const toolsUsed = result.trace?.approach ? [result.trace.approach] : undefined;

    this.sessionStore.insertMessage({
      session_id: sessionId,
      task_id: taskId,
      role: 'assistant',
      content,
      thinking: result.thinking ?? null,
      tools_used: toolsUsed ? JSON.stringify(toolsUsed) : null,
      token_estimate: estimateTokens(content) + estimateTokens(result.thinking ?? ''),
      created_at: Date.now(),
    });
  }

  /** Get conversation history within a token budget. */
  getConversationHistory(sessionId: string, maxTokens = 8000): ConversationEntry[] {
    const rows = this.sessionStore.getRecentMessages(sessionId, maxTokens);
    return rows
      .filter(r => r.role === 'user' || r.role === 'assistant')
      .map(r => ({
        role: r.role as 'user' | 'assistant',
        content: r.content,
        taskId: r.task_id ?? '',
        timestamp: r.created_at,
        thinking: r.thinking ?? undefined,
        toolsUsed: r.tools_used ? JSON.parse(r.tools_used) : undefined,
        tokenEstimate: r.token_estimate,
      }));
  }

  /** Get the number of conversation messages in a session. */
  getMessageCount(sessionId: string): number {
    return this.sessionStore.countMessages(sessionId);
  }

  /** Load working memory JSON from a session (for cross-turn learning). */
  getSessionWorkingMemory(sessionId: string): string | null {
    const session = this.sessionStore.getSession(sessionId);
    return session?.working_memory_json ?? null;
  }

  /** Persist a working memory snapshot to the session store. */
  saveSessionWorkingMemory(sessionId: string, memoryJson: string): void {
    this.sessionStore.updateSessionMemory(sessionId, memoryJson);
  }

  /**
   * Get conversation history with compaction for long conversations.
   * Keeps last `keepRecentTurns` turns verbatim, summarizes older turns
   * into a structured compact block (rule-based, A3-compliant — no LLM).
   */
  getConversationHistoryCompacted(
    sessionId: string,
    maxTokens = 8000,
    keepRecentTurns = 5,
  ): ConversationEntry[] {
    const allMessages = this.sessionStore.getMessages(sessionId);
    if (allMessages.length === 0) return [];

    const entries: ConversationEntry[] = allMessages
      .filter(r => r.role === 'user' || r.role === 'assistant')
      .map(r => ({
        role: r.role as 'user' | 'assistant',
        content: r.content,
        taskId: r.task_id ?? '',
        timestamp: r.created_at,
        thinking: r.thinking ?? undefined,
        toolsUsed: r.tools_used ? JSON.parse(r.tools_used) : undefined,
        tokenEstimate: r.token_estimate,
      }));

    // Count turns (a turn = one user + one assistant message pair)
    const turnPairs = Math.ceil(entries.length / 2);
    if (turnPairs <= keepRecentTurns) {
      // Short enough — return as-is with token budget enforcement
      return this.enforceTokenBudget(entries, maxTokens);
    }

    // Compact older turns into a structured summary
    const recentStartIdx = Math.max(0, entries.length - keepRecentTurns * 2);
    const olderEntries = entries.slice(0, recentStartIdx);
    const recentEntries = entries.slice(recentStartIdx);

    // Build rule-based compact summary from older turns
    const topics = new Map<string, number>();
    const filesDiscussed = new Set<string>();
    for (const entry of olderEntries) {
      // Extract file references (common patterns)
      const fileRefs = entry.content.match(/[\w\-./]+\.(ts|js|py|java|tsx|jsx|md|json|yaml|yml)/g);
      if (fileRefs) {
        for (const f of fileRefs) filesDiscussed.add(f);
      }
      // Count user messages as topic indicators
      if (entry.role === 'user') {
        const firstLine = entry.content.split('\n')[0]?.slice(0, 80) ?? '';
        const topic = firstLine || '(empty)';
        topics.set(topic, (topics.get(topic) ?? 0) + 1);
      }
    }

    const topicSummary = [...topics.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([topic, count]) => `${count > 1 ? `${count}x ` : ''}${topic}`)
      .join('; ');

    const compactContent = [
      `[SESSION CONTEXT: ${olderEntries.length} prior messages, ${turnPairs - keepRecentTurns} turns compacted]`,
      topicSummary ? `Topics: ${topicSummary}` : null,
      filesDiscussed.size > 0 ? `Files discussed: ${[...filesDiscussed].slice(0, 10).join(', ')}` : null,
    ].filter(Boolean).join('\n');

    const compactEntry: ConversationEntry = {
      role: 'assistant',
      content: compactContent,
      taskId: 'compaction',
      timestamp: olderEntries[0]?.timestamp ?? Date.now(),
      tokenEstimate: estimateTokens(compactContent),
    };

    return this.enforceTokenBudget([compactEntry, ...recentEntries], maxTokens);
  }

  /** Trim entries to fit within token budget, removing oldest first. */
  private enforceTokenBudget(entries: ConversationEntry[], maxTokens: number): ConversationEntry[] {
    let totalTokens = entries.reduce((sum, e) => sum + e.tokenEstimate, 0);
    const result = [...entries];
    while (totalTokens > maxTokens && result.length > 1) {
      const removed = result.shift()!;
      totalTokens -= removed.tokenEstimate;
    }
    return result;
  }
}

/** Rough token estimation: ~3.5 chars per token for mixed content. */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3.5);
}
