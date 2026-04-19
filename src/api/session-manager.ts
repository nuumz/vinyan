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
import type { ContextRetriever } from '../memory/retrieval.ts';
import type {
  ContentBlock,
  TaskInput,
  TaskResult,
  Turn,
  TurnTokenCount,
} from '../orchestrator/types.ts';
// Merge note: `classifyTurn` / `TurnImportance` from `./turn-importance.ts`
// were consumed by the Phase 1 priority-weighted compaction. A7 moved
// compaction to `src/memory/summary-ladder.ts`, so these imports are
// dropped here. The classifier itself remains available for future
// summary-ladder upgrades.

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
  /**
   * Plan commit E4: optional ContextRetriever. When wired, every appended
   * Turn is indexed into sqlite-vec so core-loop.perceive (E5) can surface
   * semantic matches in addition to recency + pins. Fire-and-forget: the
   * retriever's indexTurn logs warnings but never raises, so a failing
   * embedding call cannot cascade into a lost conversation turn.
   */
  constructor(
    private sessionStore: SessionStore,
    _traceStore?: TraceStore,
    private retriever?: ContextRetriever,
  ) {}

  /** Accessor for direct DB queries (e.g. keyword extraction for user-context mining). */
  getSessionStore(): SessionStore {
    return this.sessionStore;
  }

  /** Plan commit E4: accessor so core-loop can pull the retriever without re-plumbing. */
  getContextRetriever(): ContextRetriever | undefined {
    return this.retriever;
  }

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
    // Agent Conversation: an `input-required` turn is NOT a failure —
    // the agent finished its work for this turn and is waiting for the user.
    // Store it as 'completed' in session_tasks (the full result JSON still
    // carries status='input-required' in result_json for downstream readers).
    // The session_tasks CHECK constraint does not allow 'input-required', so
    // we map at this boundary.
    const dbStatus = result.status === 'completed' || result.status === 'input-required' ? 'completed' : 'failed';
    this.sessionStore.updateTaskStatus(sessionId, taskId, dbStatus, JSON.stringify(result));
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

  /** List recent tasks across all sessions (newest first). */
  listAllTasks(
    limit = 100,
  ): Array<{ taskId: string; sessionId: string; status: string; goal?: string; result?: TaskResult }> {
    const rows = this.sessionStore.listRecentTasks(limit);
    return rows.map((row) => {
      let goal: string | undefined;
      try {
        const input = JSON.parse(row.task_input_json);
        goal = input.goal;
      } catch {
        /* best effort */
      }

      let result: TaskResult | undefined;
      if (row.result_json) {
        try {
          result = JSON.parse(row.result_json);
        } catch {
          /* best effort */
        }
      }

      return {
        taskId: row.task_id,
        sessionId: row.session_id,
        status: row.status,
        goal,
        result,
      };
    });
  }

  /**
   * Recover suspended sessions on startup — reactivates them so they can accept new messages.
   */
  recover(): Session[] {
    const suspended = this.sessionStore.listSuspendedSessions();
    for (const row of suspended) {
      this.sessionStore.updateSessionStatus(row.id, 'active');
    }
    return suspended.map((row) => ({
      id: row.id,
      source: row.source,
      status: 'active' as const,
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

  /**
   * Record a user message in the conversation history.
   *
   * A7: session_messages legacy write removed. Turn-only persistence now.
   */
  recordUserTurn(sessionId: string, content: string): void {
    const now = Date.now();
    const persisted = this.sessionStore.appendTurn({
      id: crypto.randomUUID(),
      sessionId,
      role: 'user',
      blocks: [{ type: 'text', text: content }],
      tokenCount: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
      createdAt: now,
    });
    // E4: fire-and-forget semantic index. Retriever.indexTurn is best-effort —
    // it logs on failure (dimension mismatch, sqlite-vec unavailable, network
    // error from embedding provider) but does NOT raise. A failed index
    // degrades to recency-only retrieval; the conversation turn itself is
    // already persisted above.
    this.indexTurnAsync(persisted);
  }

  /**
   * E4 helper: index a turn into the retriever in the background. Extracted
   * so both record* paths share a single error-handling site and unit tests
   * can assert "exactly one indexTurn call per record call".
   */
  private indexTurnAsync(turn: Turn): void {
    const retriever = this.retriever;
    if (!retriever) return;
    // Detach: Promise chain runs after the current event-loop tick.
    Promise.resolve()
      .then(() => retriever.indexTurn(turn))
      .catch((err) => {
        console.warn(`[vinyan] SessionManager.indexTurnAsync failed: ${String(err)}`);
      });
  }

  /** Record an assistant response from a TaskResult. */
  recordAssistantTurn(sessionId: string, taskId: string, result: TaskResult): void {
    // Agent Conversation: for input-required turns, store clarification
    // questions in a structured [INPUT-REQUIRED] block so compaction and
    // next-turn grounding can parse them with pure text matching (A3).
    let content: string;
    if (result.status === 'input-required' && result.clarificationNeeded && result.clarificationNeeded.length > 0) {
      const questionLines = result.clarificationNeeded.map((q) => `- ${q}`).join('\n');
      const preamble = result.answer ? `${result.answer}\n\n` : '';
      content = `${preamble}[INPUT-REQUIRED]\n${questionLines}`;
    } else {
      // Fallback chain for the bubble body:
      //   1. agent-provided answer (reasoning/Q&A output, timeout explanation, …)
      //   2. mutation summary (file-change tasks)
      //   3. trace-derived synopsis for failures that carry neither
      //   4. last-resort placeholder — only reached when we have nothing at all
      const mutationSummary = result.mutations.map((m) => `Modified ${m.file}`).join('\n');
      let fallback = '(no response)';
      if (result.status === 'failed' || result.status === 'escalated') {
        const reason = result.trace?.failureReason ?? result.escalationReason;
        const approach = result.trace?.approach;
        if (reason || approach) {
          fallback = `Task did not complete (${result.status}${approach ? `, ${approach}` : ''})${reason ? `: ${reason}` : '.'}`;
        }
      }
      content = result.answer ?? (mutationSummary || fallback);
    }
    const now = Date.now();

    // A7: session_messages legacy write removed. Turn-only persistence.
    // Each mutation becomes a tool_use block so the Turn-model consumer
    // preserves structural information. Text content + thinking are kept
    // as distinct blocks (Anthropic-native order: thinking → text).
    const blocks: ContentBlock[] = [];
    if (result.thinking && result.thinking.trim().length > 0) {
      blocks.push({ type: 'thinking', thinking: result.thinking });
    }
    if (content.trim().length > 0) {
      blocks.push({ type: 'text', text: content });
    }
    for (const mutation of result.mutations) {
      blocks.push({
        type: 'tool_use',
        id: `mut-${taskId}-${mutation.file}`,
        name: 'write_file',
        input: { path: mutation.file, diff: mutation.diff },
      });
    }
    const tokenCount: TurnTokenCount = {
      input: 0,
      output: result.trace?.tokensConsumed ?? 0,
      cacheRead: 0,
      cacheCreation: 0,
    };
    const persisted = this.sessionStore.appendTurn({
      id: crypto.randomUUID(),
      sessionId,
      role: 'assistant',
      blocks: blocks.length > 0 ? blocks : [{ type: 'text', text: content }],
      tokenCount,
      taskId,
      createdAt: now,
    });
    // E4: semantic index. Same fire-and-forget contract as recordUserTurn.
    this.indexTurnAsync(persisted);
  }

  /**
   * Agent Conversation: extract pending clarification questions from the
   * latest assistant message, if that message is an [INPUT-REQUIRED] block
   * AND no subsequent user message has been recorded yet.
   *
   * Returns an empty array when:
   *  - No session exists
   *  - The latest message is not an assistant [INPUT-REQUIRED]
   *  - The user has already answered (there is a user message after it)
   *
   * Pure text matching — A3 compliant, no LLM.
   */
  getPendingClarifications(sessionId: string): string[] {
    // A7: Turn-model lookup. Extract [INPUT-REQUIRED] questions from the
    // latest assistant turn's text blocks.
    const turns = this.sessionStore.getTurns(sessionId);
    if (turns.length === 0) return [];

    const last = turns[turns.length - 1]!;
    // Already answered → user turn appears after the clarification.
    if (last.role === 'user') return [];
    const text = last.blocks
      .filter((b): b is Extract<typeof b, { type: 'text' }> => b.type === 'text')
      .map((b) => b.text)
      .join('\n');
    return parseInputRequiredBlock(text);
  }

  /**
   * Agent Conversation: find the goal text of the "root" user task that the
   * current pending clarifications are attached to. Walks the message history
   * backward: every [assistant-[INPUT-REQUIRED], user-reply] pair is a
   * clarification round answering the same underlying task, so we skip past
   * it and return the most recent user message that was NOT itself a
   * clarification reply.
   *
   * Returns null when no root user goal can be located (empty session or
   * malformed history).
   *
   * Used by POST /sessions/:id/messages to preserve the original task goal
   * when the user's reply would otherwise overwrite it — without this, the
   * next task's goal becomes the clarification answer instead of the task.
   *
   * Pure text matching — A3 compliant, no LLM.
   */
  getOriginalTaskGoal(sessionId: string): string | null {
    // A7: Turn-model. Walk backward skipping [assistant-[INPUT-REQUIRED],
    // user-reply] clarification pairs to find the last non-clarification
    // user turn.
    const turns = this.sessionStore.getTurns(sessionId);
    if (turns.length === 0) return null;

    const turnText = (t: import('../orchestrator/types.ts').Turn): string =>
      t.blocks
        .filter((b): b is Extract<typeof b, { type: 'text' }> => b.type === 'text')
        .map((b) => b.text)
        .join('\n');

    let i = turns.length - 1;
    while (i >= 0) {
      const t = turns[i]!;
      if (t.role === 'user') {
        const prev = i > 0 ? turns[i - 1] : null;
        const isClarificationReply =
          prev?.role === 'assistant' && turnText(prev).includes('[INPUT-REQUIRED]');
        if (!isClarificationReply) return turnText(t);
        // skip this reply and the clarification that triggered it
        i -= 2;
        continue;
      }
      i -= 1;
    }
    return null;
  }

  /** Get the number of conversation turns in a session. */
  getMessageCount(sessionId: string): number {
    return this.sessionStore.countTurns(sessionId);
  }

  /**
   * Plan commit A (A5): Turn-model history for core-loop + workers.
   *
   * Returns the newest-N turns from `session_turns` in chronological order,
   * trimmed by a token-like budget (uses block text length as proxy since
   * Turn rows carry cache-tier counts, not prompt-token estimates).
   */
  getTurnsHistory(sessionId: string, maxTurns = 20): Turn[] {
    return this.sessionStore.getRecentTurns(sessionId, maxTurns);
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

  // A7: getConversationHistoryCompacted + enforceTokenBudget removed.
  // The ContextRetriever's summary ladder (src/memory/summary-ladder.ts)
  // supersedes the compaction logic that used to live here. Callers that
  // needed compacted history now flow through ContextRetriever.retrieve()
  // and receive a ContextBundle with recent + semantic + pins + summary.

  /**
   * A7: backward-compat text view of the session history for display-only
   * consumers (CLI chat renderer, TUI, server API /messages endpoint).
   *
   * Flattens each Turn's visible text blocks and returns a lightweight
   * `{role, content, taskId, timestamp}[]` shape. tool_use / tool_result
   * blocks are dropped — callers needing structural data should consume
   * `getTurnsHistory` directly and walk `Turn.blocks`.
   *
   * Merge note: the Phase 1 long-session compaction
   * (`getConversationHistoryCompacted` + priority-weighted budget +
   * inline KEY-DECISION lines + `[DROPPED BY BUDGET]` marker) is now the
   * responsibility of `src/memory/summary-ladder.ts` via
   * `ContextRetriever.retrieve`. The Phase 1 priority-weight and
   * drop-marker ideas can be ported onto that module in a follow-up
   * without re-introducing a ConversationEntry dependency here.
   */
  getConversationHistoryText(sessionId: string, maxTurns = 1000): Array<{
    role: 'user' | 'assistant';
    content: string;
    taskId: string;
    timestamp: number;
  }> {
    const turns = this.sessionStore.getRecentTurns(sessionId, maxTurns);
    return turns.map((t) => ({
      role: t.role,
      content: t.blocks
        .filter((b): b is Extract<typeof b, { type: 'text' }> => b.type === 'text')
        .map((b) => b.text)
        .join('\n'),
      taskId: t.taskId ?? '',
      timestamp: t.createdAt,
    }));
  }
}

/**
 * Agent Conversation: parse an assistant message `content` and return the
 * list of clarification questions if it contains an [INPUT-REQUIRED] block.
 * Format (written by `recordAssistantTurn`):
 *
 *   [optional preamble]
 *
 *   [INPUT-REQUIRED]
 *   - question 1
 *   - question 2
 *
 * Returns [] when the tag is absent. Pure string matching — A3 compliant.
 */
export function parseInputRequiredBlock(content: string): string[] {
  const tagIdx = content.indexOf('[INPUT-REQUIRED]');
  if (tagIdx === -1) return [];
  const body = content.slice(tagIdx + '[INPUT-REQUIRED]'.length);
  const questions: string[] = [];
  for (const line of body.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith('- ')) {
      const q = trimmed.slice(2).trim();
      if (q) questions.push(q);
    } else if (trimmed.length > 0 && questions.length > 0) {
      // Stop parsing at first non-bullet non-empty line after bullets began.
      // Keeps this simple and deterministic.
      break;
    }
  }
  return questions;
}
