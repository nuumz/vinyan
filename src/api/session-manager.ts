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
import type {
  ContentBlock,
  ConversationEntry,
  TaskInput,
  TaskResult,
  Turn,
  TurnTokenCount,
} from '../orchestrator/types.ts';
import { classifyTurn, type TurnImportance } from './turn-importance.ts';

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

  /** Accessor for direct DB queries (e.g. keyword extraction for user-context mining). */
  getSessionStore(): SessionStore {
    return this.sessionStore;
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
   * Plan commit A (A5): dual-writes to both `session_messages` (legacy flat
   * path, consumed by ConversationEntry readers) and `session_turns`
   * (Anthropic-native ContentBlock[] path). A7 will drop the legacy write.
   */
  recordUserTurn(sessionId: string, content: string): void {
    const now = Date.now();
    this.sessionStore.insertMessage({
      session_id: sessionId,
      task_id: null,
      role: 'user',
      content,
      thinking: null,
      tools_used: null,
      token_estimate: estimateTokens(content),
      created_at: now,
    });
    // A5: mirror to session_turns as a single text block. No tool_use blocks
    // from pure user input — user turns arrive as text regardless of LLM shape.
    this.sessionStore.appendTurn({
      id: crypto.randomUUID(),
      sessionId,
      role: 'user',
      blocks: [{ type: 'text', text: content }],
      tokenCount: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
      createdAt: now,
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
    const toolsUsed = result.trace?.approach ? [result.trace.approach] : undefined;
    const now = Date.now();

    this.sessionStore.insertMessage({
      session_id: sessionId,
      task_id: taskId,
      role: 'assistant',
      content,
      thinking: result.thinking ?? null,
      tools_used: toolsUsed ? JSON.stringify(toolsUsed) : null,
      token_estimate: estimateTokens(content) + estimateTokens(result.thinking ?? ''),
      created_at: now,
    });

    // A5: mirror to session_turns. Each mutation becomes a tool_use block so
    // the Turn-model consumer preserves the structural information that the
    // legacy flat content string discards. Text content + thinking are kept
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
    this.sessionStore.appendTurn({
      id: crypto.randomUUID(),
      sessionId,
      role: 'assistant',
      blocks: blocks.length > 0 ? blocks : [{ type: 'text', text: content }],
      tokenCount,
      taskId,
      createdAt: now,
    });
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
    const messages = this.sessionStore.getMessages(sessionId);
    if (messages.length === 0) return [];

    const last = messages[messages.length - 1]!;
    // If the last message is a user turn, any clarification has already been answered.
    if (last.role === 'user') return [];
    if (last.role !== 'assistant') return [];
    return parseInputRequiredBlock(last.content);
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
    const messages = this.sessionStore.getMessages(sessionId);
    if (messages.length === 0) return null;

    let i = messages.length - 1;
    while (i >= 0) {
      const m = messages[i]!;
      if (m.role === 'user') {
        const prev = i > 0 ? messages[i - 1] : null;
        const isClarificationReply = prev?.role === 'assistant' && prev.content.includes('[INPUT-REQUIRED]');
        if (!isClarificationReply) return m.content;
        // skip this reply and the clarification that triggered it
        i -= 2;
        continue;
      }
      i -= 1;
    }
    return null;
  }

  /** Get conversation history within a token budget. */
  getConversationHistory(sessionId: string, maxTokens = 8000): ConversationEntry[] {
    const rows = this.sessionStore.getRecentMessages(sessionId, maxTokens);
    return rows
      .filter((r) => r.role === 'user' || r.role === 'assistant')
      .map((r) => ({
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

  /**
   * Get conversation history with compaction for long conversations.
   * Keeps last `keepRecentTurns` turns verbatim, summarizes older turns
   * into a structured compact block (rule-based, A3-compliant — no LLM).
   *
   * Phase 1 (long-session memory):
   *  - Header includes `M of N messages compacted, K recent turn-pairs
   *    verbatim` so the agent knows exactly how much was summarised.
   *  - Older `decision|clarification` turns are interleaved verbatim as
   *    `→ [Turn K, importance] role: firstLine(content, 200)` lines,
   *    classified by the duck-typed `classifyTurn` helper.
   *  - `enforceTokenBudget` runs with per-entry weights (priority turns
   *    count at 0.5×, capped at 40% of maxTokens) so high-signal turns
   *    survive longer under tight budgets.
   *  - When entries are dropped, a small synthetic `[DROPPED BY BUDGET]`
   *    entry is inserted at the front (after the summary, before recent)
   *    so the agent sees the gap instead of silently losing turns.
   */
  getConversationHistoryCompacted(sessionId: string, maxTokens = 8000, keepRecentTurns = 5): ConversationEntry[] {
    const allMessages = this.sessionStore.getMessages(sessionId);
    if (allMessages.length === 0) return [];

    const entries: ConversationEntry[] = allMessages
      .filter((r) => r.role === 'user' || r.role === 'assistant')
      .map((r) => ({
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
      const budgeted = this.enforceTokenBudget(entries, maxTokens);
      return this.prependDropMarker(budgeted.entries, budgeted.dropped, budgeted.droppedTokens);
    }

    // Compact older turns into a structured summary
    const recentStartIdx = Math.max(0, entries.length - keepRecentTurns * 2);
    const olderEntries = entries.slice(0, recentStartIdx);
    const recentEntries = entries.slice(recentStartIdx);

    // Build rule-based compact summary from older turns
    const topics = new Map<string, number>();
    const filesDiscussed = new Set<string>();
    // Agent Conversation: track open vs resolved clarification questions
    // across compaction. A question is "resolved" when a user message follows
    // the [INPUT-REQUIRED] assistant turn that raised it.
    const openClarifications: string[] = [];
    const resolvedClarifications: Array<{ question: string; answer: string }> = [];

    // Phase 1: collect inline key-decision / clarification lines while
    // walking older entries. `precededByInputRequired` lets the classifier
    // mark user replies to IR blocks as decisions without re-running regex.
    type DecisionLine = { turnIdx: number; importance: TurnImportance; role: string; excerpt: string };
    const decisionLines: DecisionLine[] = [];
    // Per-entry weights for enforceTokenBudget (priority → 0.5×).
    const weights = new Map<ConversationEntry, number>();
    let precededByIR = false;

    for (let i = 0; i < olderEntries.length; i++) {
      const entry = olderEntries[i]!;
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
      // Detect [INPUT-REQUIRED] blocks and pair them with any following user turn
      let isIRAssistant = false;
      if (entry.role === 'assistant') {
        const questions = parseInputRequiredBlock(entry.content);
        if (questions.length > 0) {
          isIRAssistant = true;
          const next = olderEntries[i + 1];
          if (next && next.role === 'user') {
            const answer = next.content.split('\n')[0]?.slice(0, 120) ?? '';
            for (const q of questions) {
              resolvedClarifications.push({ question: q, answer });
            }
          } else {
            for (const q of questions) openClarifications.push(q);
          }
        }
      }

      // Classify the turn for inline interleave + weight assignment.
      const importance = classifyTurn(entry, { precededByInputRequired: precededByIR });
      if (importance === 'decision' || importance === 'clarification') {
        const excerpt = firstLineSnippet(entry.content, 200);
        decisionLines.push({ turnIdx: i, importance, role: entry.role, excerpt });
        weights.set(entry, 0.5);
      }

      // Carry the hint forward: the *next* entry only sees it when the
      // current entry is an assistant [INPUT-REQUIRED] block. Decision /
      // clarification hints don't chain beyond one turn.
      precededByIR = isIRAssistant;
    }

    const topicSummary = [...topics.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 15)
      .map(([topic, count]) => `${count > 1 ? `${count}x ` : ''}${topic}`)
      .join('; ');

    const clarificationLines: string[] = [];
    if (resolvedClarifications.length > 0) {
      const sample = resolvedClarifications
        .slice(0, 10)
        .map((r) => `Q: ${r.question} → A: ${r.answer}`)
        .join('; ');
      clarificationLines.push(`Resolved clarifications: ${sample}`);
    }
    if (openClarifications.length > 0) {
      clarificationLines.push(`Open clarifications (awaiting user): ${openClarifications.slice(0, 10).join('; ')}`);
    }

    // Inline key-decision block — ordered by original turn index.
    const inlineDecisionLines = decisionLines
      .sort((a, b) => a.turnIdx - b.turnIdx)
      .map((d) => `→ [Turn ${d.turnIdx + 1}, ${d.importance}] ${d.role}: ${d.excerpt}`);

    const totalMessages = entries.length;
    const compactedMessages = olderEntries.length;
    const compactContent = [
      `[SESSION CONTEXT: ${compactedMessages} of ${totalMessages} total messages compacted, ${keepRecentTurns} recent turn-pairs verbatim]`,
      topicSummary ? `Topics: ${topicSummary}` : null,
      filesDiscussed.size > 0 ? `Files discussed: ${[...filesDiscussed].slice(0, 25).join(', ')}` : null,
      ...clarificationLines,
      ...inlineDecisionLines,
    ]
      .filter(Boolean)
      .join('\n');

    const compactEntry: ConversationEntry = {
      role: 'assistant',
      content: compactContent,
      taskId: 'compaction',
      timestamp: olderEntries[0]?.timestamp ?? Date.now(),
      tokenEstimate: estimateTokens(compactContent),
    };

    const budgeted = this.enforceTokenBudget([compactEntry, ...recentEntries], maxTokens, weights);
    return this.prependDropMarker(budgeted.entries, budgeted.dropped, budgeted.droppedTokens);
  }

  /**
   * Build a small `[DROPPED BY BUDGET]` synthetic entry and insert it just
   * after the summary (if one is present) so the agent sees the gap.
   * Idempotent no-op when `dropped === 0`.
   *
   * Return type stays `ConversationEntry[]` per plan: callers don't care
   * that a marker was injected — it's just another entry with tiny token
   * weight that survives reliably.
   */
  private prependDropMarker(entries: ConversationEntry[], dropped: number, droppedTokens: number): ConversationEntry[] {
    if (dropped <= 0) return entries;
    const marker: ConversationEntry = {
      role: 'assistant',
      content: `[DROPPED BY BUDGET: ${dropped} turn(s) not shown (oldest first, ~${droppedTokens} tokens)]`,
      taskId: 'compaction',
      timestamp: entries[0]?.timestamp ?? Date.now(),
      tokenEstimate: 30,
    };
    // If the first entry is the session-context summary (taskId === 'compaction'
    // and content starts with `[SESSION CONTEXT`), drop the marker *after* it
    // so ordering is: summary → drop-marker → recent verbatim.
    const first = entries[0];
    if (first && first.taskId === 'compaction' && first.content.startsWith('[SESSION CONTEXT')) {
      return [first, marker, ...entries.slice(1)];
    }
    return [marker, ...entries];
  }

  /**
   * Trim entries to fit within token budget, removing oldest first.
   *
   * Phase 1: supports per-entry weights so priority turns (decisions,
   * clarifications) count fractionally against the budget and thus survive
   * longer. Priority-entry raw token sum is capped at 40% of `maxTokens`;
   * if exceeded, the priority weights are scaled pro-rata back toward 1.0
   * so heavy priority turns don't crowd out normal context.
   *
   * Returns the surviving entries plus accounting for a drop marker.
   */
  private enforceTokenBudget(
    entries: ConversationEntry[],
    maxTokens: number,
    weights?: Map<ConversationEntry, number>,
  ): { entries: ConversationEntry[]; dropped: number; droppedTokens: number } {
    const PRIORITY_CAP_FRACTION = 0.4;
    const priorityCap = maxTokens * PRIORITY_CAP_FRACTION;

    // Per-entry weight resolver — default 1.0, priority entries 0.5, but
    // scaled pro-rata toward 1.0 if priority raw sum exceeds the cap.
    let priorityScale = 1;
    if (weights && weights.size > 0) {
      let prioRaw = 0;
      for (const e of entries) {
        if (weights.has(e)) prioRaw += e.tokenEstimate;
      }
      if (prioRaw > priorityCap) {
        // Pro-rata scaling: choose w' in [0.5, 1] so that
        //   prioRaw * w' === priorityCap.
        // Clamped to [0.5, 1] — we never inflate priority weight above
        // baseline, never compress below the 0.5 baseline discount.
        const target = priorityCap / prioRaw;
        priorityScale = Math.min(1, Math.max(0.5, target * 2));
      }
    }
    const weightOf = (e: ConversationEntry): number => {
      const base = weights?.get(e);
      if (base === undefined) return 1;
      // priorityScale rescales the *discount* from 0.5 toward 1.0 when the
      // priority cap would otherwise be blown out.
      return base + (1 - base) * (1 - priorityScale);
    };

    let weightedTokens = entries.reduce((sum, e) => sum + e.tokenEstimate * weightOf(e), 0);
    const result = [...entries];
    let dropped = 0;
    let droppedTokens = 0;
    while (weightedTokens > maxTokens && result.length > 1) {
      const removed = result.shift()!;
      weightedTokens -= removed.tokenEstimate * weightOf(removed);
      dropped++;
      droppedTokens += removed.tokenEstimate;
    }
    return { entries: result, dropped, droppedTokens };
  }
}

/** Rough token estimation: ~3.5 chars per token for mixed content. */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3.5);
}

/**
 * Phase 1: extract the first non-empty line of `content`, truncated to at
 * most `maxChars` characters with a `…` suffix when clipped. Used by the
 * session-manager inline KEY-DECISION interleave so a verbatim excerpt
 * survives without swelling the summary block.
 */
function firstLineSnippet(content: string, maxChars: number): string {
  const lines = content.split('\n');
  let line = '';
  for (const l of lines) {
    const trimmed = l.trim();
    if (trimmed.length > 0) {
      line = trimmed;
      break;
    }
  }
  if (line.length <= maxChars) return line;
  return `${line.slice(0, maxChars)}…`;
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
