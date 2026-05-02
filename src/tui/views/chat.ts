/**
 * Chat view (PR #11) — read-only Agent Conversation viewer for the TUI.
 *
 * Renders the most recently active session's conversation history in a
 * two-pane layout:
 *   - Left pane: list of recent sessions (id, status, message count)
 *   - Right pane: conversation messages for the active session, with
 *                 a prominent banner if the session is paused on
 *                 input-required (pendingClarifications non-empty)
 *
 * V1 is read-only. Interactive input is a separate concern (deferred to
 * a follow-up PR — would require wiring keystroke capture, sending via
 * orchestrator.executeTask, and threading sessionId state through the
 * input action reducer). For interactive chat, users should still run
 * `vinyan chat` from a separate terminal.
 *
 * Data flow (see src/tui/data/source.ts:refreshChatState):
 *   - DataSource subscribes to task:start and task:complete events
 *   - On task:start, captures `payload.input.sessionId` as the active
 *     session id (so the chat view follows whatever conversation is
 *     currently in progress)
 *   - On task:complete, refreshes conversation history + pending
 *     clarifications from SessionManager
 *   - On TUI start, pre-populates the session list once
 *
 * Best-effort: the view shows a friendly placeholder when SessionManager
 * is not exposed on the orchestrator (e.g., when the TUI is launched
 * with a config that didn't pass `sessionManager` into createOrchestrator).
 */
import type { ClarificationQuestion } from '../../core/clarification.ts';
import { ANSI, bold, color, dim, padEnd, panel, sideBySide, truncate } from '../renderer.ts';
import type { ChatMessageEntry, ChatSessionSummary, TUIState } from '../types.ts';

/** Two-pane layout (sessions list + conversation), used by getMaxPanels(). */
export const CHAT_PANEL_COUNT = 2;

export function renderChat(state: TUIState): string {
  const { termWidth, termHeight } = state;
  // Same proportions as the events view (left list ~40%, right detail ~60%).
  const leftWidth = Math.floor(termWidth * 0.4);
  const rightWidth = termWidth - leftWidth - 1;
  const panelHeight = termHeight - 4; // header + tab bar + spacing + hints

  const sessionsPanel = renderSessionList(state, leftWidth, panelHeight, state.focusedPanel === 0);
  const conversationPanel = renderConversation(state, rightWidth, panelHeight, state.focusedPanel === 1);

  return sideBySide(sessionsPanel, conversationPanel);
}

// ── Left pane: session list ─────────────────────────────────────────

function renderSessionList(state: TUIState, width: number, height: number, focused: boolean): string {
  const innerW = width - 2;
  const visibleRows = height - 3;
  const lines: string[] = [];
  const sessions = state.chatSessions;

  if (sessions.length === 0) {
    lines.push(dim('  (no sessions)'));
    lines.push('');
    lines.push(dim('  Run `vinyan chat` or POST'));
    lines.push(dim('  /api/v1/sessions/:id/messages'));
    lines.push(dim('  to start a conversation.'));
  } else {
    for (let i = 0; i < Math.min(sessions.length, visibleRows); i++) {
      const session = sessions[i]!;
      const isActive = session.id === state.chatActiveSessionId;
      lines.push(formatSessionRow(session, innerW, isActive));
    }
  }

  while (lines.length < visibleRows) lines.push('');

  const title = `Sessions (${sessions.length})`;
  return panel(title, lines.join('\n'), width, height, focused);
}

function formatSessionRow(session: ChatSessionSummary, innerW: number, active: boolean): string {
  // Marker for the currently-displayed session
  const marker = active ? color('▸', ANSI.cyan) : ' ';
  // 8-char short id
  const shortId = session.id.slice(0, 8);
  const idDisplay = active ? color(shortId, ANSI.bold, ANSI.cyan) : color(shortId, ANSI.bold);
  // Status badge color
  const statusColor =
    session.status === 'active' ? ANSI.green : session.status === 'suspended' ? ANSI.yellow : ANSI.gray;
  const status = color(session.status.padEnd(9), statusColor);
  // Message count (badge-like)
  const countLabel = `${session.messageCount}msg`;
  const ageMs = Date.now() - session.createdAt;
  const ageLabel = formatRelativeAge(ageMs);

  // Layout: ▸ <id> <status> <count> <age>
  const line = `${marker} ${idDisplay} ${status} ${dim(countLabel)} ${dim(ageLabel)}`;
  return truncate(line, innerW);
}

function formatRelativeAge(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

// ── Right pane: conversation messages ───────────────────────────────

function renderConversation(state: TUIState, width: number, height: number, focused: boolean): string {
  const innerW = width - 2;
  const lines: string[] = [];

  // Header: which session is being shown
  if (!state.chatActiveSessionId) {
    lines.push(dim('  No active session.'));
    lines.push('');
    lines.push(dim('  Select one from the left or run a task'));
    lines.push(dim('  with sessionId set to populate this view.'));
    while (lines.length < height - 3) lines.push('');
    return panel('Conversation', lines.join('\n'), width, height, focused);
  }

  const headerSessionShort = state.chatActiveSessionId.slice(0, 8);
  lines.push(dim(`  Session: ${headerSessionShort}`));

  // Phase 0.5: live "running tools" inline status — mirrors the cli
  // chat-stream-renderer "⚙ preparing <tool>…" line. Cleared when
  // agent:tool_executed fires for the same tool-call id.
  if (state.chatRunningTools.size > 0) {
    for (const { tool } of state.chatRunningTools.values()) {
      lines.push(truncate(`  ${color('⚙', ANSI.yellow)} ${dim('preparing')} ${tool}…`, innerW));
    }
  }

  // Pending clarifications banner — fired when either:
  //   (a) the most recent assistant turn was an [INPUT-REQUIRED] block
  //       (legacy string[] path from SessionManager.getPendingClarifications)
  //   (b) the orchestrator emitted `agent:clarification_requested` with
  //       structured questions (Phase D path — prefer this when present)
  const structured = state.chatStructuredClarifications;
  if (structured.length > 0) {
    lines.push('');
    lines.push(color('  ⁇ Waiting for your input:', ANSI.bold, ANSI.yellow));
    for (const block of renderStructuredClarifications(structured, innerW)) {
      lines.push(block);
    }
    lines.push(dim('    หรือพิมพ์คำตอบของคุณเอง — free text ใช้ได้เสมอ'));
    lines.push('');
  } else if (state.chatPendingClarifications.length > 0) {
    lines.push('');
    lines.push(color('  ⁇ Waiting for clarification:', ANSI.bold, ANSI.yellow));
    for (const q of state.chatPendingClarifications) {
      lines.push(truncate(`    ${color('•', ANSI.yellow)} ${q}`, innerW));
    }
    lines.push('');
  } else {
    lines.push('');
  }

  // Phase E: workflow TODO checklist (fired by `workflow:plan_ready`).
  if (state.chatWorkflowPlan && state.chatWorkflowPlan.steps.length > 0) {
    for (const block of renderWorkflowPlan(state.chatWorkflowPlan.steps, state.chatWorkflowStepStatus, innerW)) {
      lines.push(block);
    }
    lines.push('');
  }

  // Conversation messages. Render newest at the bottom (chat-style).
  const conversation = state.chatConversation;
  if (conversation.length === 0) {
    lines.push(dim('  (no messages yet)'));
  } else {
    // Compute available rows for messages (after the header section).
    const headerRowsUsed = lines.length;
    const messageRows = Math.max(0, height - 3 - headerRowsUsed);
    const rendered = renderMessageBlock(conversation, innerW, messageRows, state.chatScroll);
    for (const r of rendered) lines.push(r);
  }

  while (lines.length < height - 3) lines.push('');

  const title = `Conversation (${conversation.length})`;
  return panel(title, lines.join('\n'), width, height, focused);
}

/**
 * Render a list of conversation messages into a fixed number of rows,
 * with newest at the bottom and a scroll offset that can hide N newest
 * messages (useful for letting users scroll back through long chats).
 *
 * Returns exactly `maxRows` lines, padding with empty strings if needed.
 */
export function renderMessageBlock(
  messages: ChatMessageEntry[],
  innerW: number,
  maxRows: number,
  scrollOffset = 0,
): string[] {
  if (maxRows <= 0) return [];

  // Format every message into wrapped lines, then take the slice
  // that fits the visible window.
  const allLines: string[] = [];
  for (const msg of messages) {
    const formatted = formatMessage(msg, innerW);
    for (const line of formatted) allLines.push(line);
    allLines.push(''); // blank separator
  }

  // Cut trailing blank if present.
  if (allLines.length > 0 && allLines[allLines.length - 1] === '') allLines.pop();

  // Apply scroll: how many newest lines to skip (default 0 = show newest).
  const tailEnd = Math.max(0, allLines.length - scrollOffset);
  const tailStart = Math.max(0, tailEnd - maxRows);
  const visible = allLines.slice(tailStart, tailEnd);

  // Pad the top so messages stick to the bottom of the window
  // (chat-style, newest visible).
  const padding = Math.max(0, maxRows - visible.length);
  const padded: string[] = [];
  for (let i = 0; i < padding; i++) padded.push('');
  for (const line of visible) padded.push(line);
  return padded;
}

/**
 * Format a single message into its display lines:
 *   <Role>:           ← bold, color-coded
 *     <content>...    ← indented, wrapped to innerW-4
 */
function formatMessage(msg: ChatMessageEntry, innerW: number): string[] {
  const roleLabel = msg.role === 'user' ? color('You', ANSI.bold, ANSI.yellow) : color('Vinyan', ANSI.bold, ANSI.green);
  const time = formatRelativeAge(Date.now() - msg.timestamp);
  const header = `  ${roleLabel} ${dim(`(${time} ago)`)}`;

  // Wrap content to innerW - 4 (2-space indent + a little breathing room).
  const wrapWidth = Math.max(20, innerW - 4);
  const wrapped = wrapText(msg.content, wrapWidth);
  const contentLines = wrapped.map((l) => `    ${l}`);
  return [truncate(header, innerW), ...contentLines.map((l) => truncate(l, innerW))];
}

/**
 * Word-aware text wrapping for the conversation pane. Breaks on spaces
 * when possible; falls back to hard breaks for words longer than the
 * wrap width. Preserves explicit \n characters from the source content
 * (e.g., the [INPUT-REQUIRED] block formatting).
 */
export function wrapText(text: string, width: number): string[] {
  if (width <= 0) return [text];
  const out: string[] = [];
  for (const paragraph of text.split('\n')) {
    if (paragraph.length === 0) {
      out.push('');
      continue;
    }
    let current = '';
    const words = paragraph.split(' ');
    for (const word of words) {
      if (word.length > width) {
        // Hard-break long words into width-sized chunks
        if (current.length > 0) {
          out.push(current);
          current = '';
        }
        for (let i = 0; i < word.length; i += width) {
          const chunk = word.slice(i, i + width);
          if (chunk.length === width) {
            out.push(chunk);
          } else {
            current = chunk;
          }
        }
        continue;
      }
      const candidate = current.length === 0 ? word : `${current} ${word}`;
      if (candidate.length > width) {
        out.push(current);
        current = word;
      } else {
        current = candidate;
      }
    }
    if (current.length > 0) out.push(current);
  }
  return out;
}

/**
 * Render a structured clarification set as numbered/checkbox lines.
 *
 * Kind rendering:
 *   - 'single' → `  (1) label` — user types one digit.
 *   - 'multi'  → `  [ ] 1. label` — user types `1,3`.
 *   - 'free'   → prompt only; user types free text.
 *
 * Free-text override is ALWAYS available; callers surface a hint line.
 */
export function renderStructuredClarifications(questions: ClarificationQuestion[], innerW: number): string[] {
  const out: string[] = [];
  questions.forEach((q, idx) => {
    const prefix = questions.length > 1 ? `  Q${idx + 1}. ` : '  ';
    out.push(truncate(color(`${prefix}${q.prompt}`, ANSI.bold, ANSI.cyan), innerW));
    // Phase C — surface the question-level rationale when the smart gate
    // populated one (e.g. "Defaults below come from your last 3 sessions").
    if (q.questionRationale) {
      out.push(truncate(`    ${dim(`☆ ${q.questionRationale}`)}`, innerW));
    }
    if (q.kind === 'free' || !q.options || q.options.length === 0) {
      out.push(truncate(`    ${dim('(free text — พิมพ์คำตอบได้เลย)')}`, innerW));
      return;
    }
    q.options.forEach((opt, i) => {
      const bracket = q.kind === 'multi' ? color('[ ]', ANSI.yellow) : color(`(${i + 1})`, ANSI.yellow);
      const hint = opt.hint ? dim(` — ${opt.hint}`) : '';
      // Phase C — render the recommendation marker, trend badge, and
      // rationale tooltip when the smart gate populated them. Older
      // events without these fields render exactly as before.
      const recMarker = opt.suggestedDefault ? color(' ★', ANSI.bold, ANSI.green) : '';
      const trendBadge = opt.trendingHint ? color(` [${opt.trendingHint}]`, ANSI.cyan) : '';
      out.push(truncate(`    ${bracket} ${opt.label}${recMarker}${trendBadge}${hint}`, innerW));
      if (opt.rationale) {
        out.push(truncate(`        ${dim(`↳ ${opt.rationale}`)}`, innerW));
      }
    });
    if (q.kind === 'multi' && q.maxSelections) {
      out.push(truncate(`    ${dim(`(เลือกได้สูงสุด ${q.maxSelections} ข้อ — พิมพ์หมายเลขคั่นด้วย comma)`)}`, innerW));
    }
  });
  return out;
}

/**
 * Render a workflow plan as a TODO checklist with per-step status glyphs.
 *   ◉ = in-progress
 *   ✓ = completed
 *   ✗ = failed
 *   ○ = pending (default when status missing)
 */
export function renderWorkflowPlan(
  steps: Array<{ id: string; description: string; strategy: string; dependencies: string[] }>,
  statusMap: Map<string, 'pending' | 'in-progress' | 'completed' | 'failed'>,
  innerW: number,
): string[] {
  const out: string[] = [];
  const completed = [...statusMap.values()].filter((s) => s === 'completed').length;
  out.push(color(`  ☰ Workflow plan (${completed}/${steps.length} done):`, ANSI.bold, ANSI.green));
  for (const step of steps) {
    const status = statusMap.get(step.id) ?? 'pending';
    const glyph =
      status === 'completed'
        ? color('✓', ANSI.green)
        : status === 'in-progress'
          ? color('◉', ANSI.yellow)
          : status === 'failed'
            ? color('✗', ANSI.red)
            : color('○', ANSI.dim);
    const label = status === 'completed' ? dim(step.description) : step.description;
    out.push(truncate(`    ${glyph} ${label} ${dim(`[${step.strategy}]`)}`, innerW));
  }
  return out;
}

// Re-export padEnd for tests that exercise the layout helpers.
export { padEnd };
