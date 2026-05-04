/**
 * Vinyan Reminder Block — structured system guidance injected into worker-visible output.
 *
 * Inspired by Claude Code's `<system-reminder>` cache-boundary pattern: content wrapped
 * in `<vinyan-reminder>` tags is authoritative orchestrator-authored guidance — NOT
 * user input and NOT tool output. The worker treats tagged content as:
 *
 *   - **Authoritative**: reflects the orchestrator's verified view of session state
 *     (files touched, prior failures, budget pressure, stall detection).
 *   - **Non-interactive**: do not reply to it directly. Use it to adjust next action.
 *   - **Refreshable**: may change every turn. Always read the latest block; earlier
 *     reminders are stale.
 *
 * Cache-boundary rationale:
 *   System prompt = cached, static (behavioral rules, project instructions).
 *   User message  = fresh per turn, contains `<vinyan-reminder>` blocks with dynamic
 *                   session state. Cache invalidation boundary sits BEFORE the
 *                   reminder, so reminders can change every turn without evicting
 *                   the static system prompt from cache.
 *
 * Current usage: the orchestrator wraps session-state hints (budget pressure, stall
 * detection, dedup warnings, file state) in reminder tags and injects them into
 * tool-result output, so the LLM sees them clearly separated from actual tool output.
 */

/**
 * Wrap content in `<vinyan-reminder>` tags. Returns null for null / empty input so
 * callers can skip injection when there's nothing to say.
 *
 * Whitespace around the body is stripped so wrapped output is always compact.
 */
export function wrapReminder(content: string | null | undefined): string | null {
  const trimmed = content?.trim();
  if (!trimmed) return null;
  return `<vinyan-reminder>\n${trimmed}\n</vinyan-reminder>`;
}

/**
 * Check whether a string already contains a reminder block.
 * Useful for callers that want to avoid double-wrapping when composing output.
 */
export function hasReminderBlock(content: string | null | undefined): boolean {
  return typeof content === 'string' && content.includes('<vinyan-reminder>');
}

/**
 * Hard cap on the rendered `[ROOT-INTENT-ANCHOR]` body so a long-running
 * session cannot bloat the prompt by re-injecting the same goal repeatedly.
 * 200 chars matches the budget-clamp guarantees in `agent-loop.ts` — any
 * raw goal longer than this is truncated with an ellipsis.
 */
export const ROOT_INTENT_ANCHOR_CAP = 200;

/**
 * T6 (Yinyan A10 enforcement) — emit a `[ROOT-INTENT-ANCHOR]` reminder
 * that re-states the user's original task goal alongside the current
 * sub-goal. The agent-loop injects this at every L3 boundary so a long
 * worker session does not silently drift into a goal-adjacent
 * interpretation.
 *
 * Wraps the result in the standard `<vinyan-reminder>` envelope so the
 * worker treats the anchor with the same protocol as other reminders.
 * Returns `null` when both inputs are empty / blank — the caller skips
 * injection in that case.
 *
 * Truncates each component to `ROOT_INTENT_ANCHOR_CAP` chars total so a
 * pathological goal cannot push existing prompt sections out of the
 * window. Truncation is content-sensitive (single trailing `…` ellipsis)
 * because the worker is expected to read the anchor verbatim — silent
 * truncation without a visible marker would mislead it about the
 * intended scope.
 */
export function wrapRootIntentAnchor(rootIntent: string, currentGoal?: string): string | null {
  const root = (rootIntent ?? '').trim();
  if (!root) return null;
  const current = (currentGoal ?? '').trim();
  const rootClipped = root.length > ROOT_INTENT_ANCHOR_CAP ? `${root.slice(0, ROOT_INTENT_ANCHOR_CAP - 1)}…` : root;
  const currentClipped =
    current.length > ROOT_INTENT_ANCHOR_CAP ? `${current.slice(0, ROOT_INTENT_ANCHOR_CAP - 1)}…` : current;
  const lines = [`[ROOT-INTENT-ANCHOR] Original goal: ${rootClipped}`];
  if (currentClipped && currentClipped !== rootClipped) {
    lines.push(`[ROOT-INTENT-ANCHOR] Current sub-goal: ${currentClipped}`);
  }
  lines.push('Confirm your next action serves the original goal before acting.');
  return wrapReminder(lines.join('\n'));
}

/**
 * System-prompt description of the reminder protocol. Include this in `buildSystemPrompt`
 * so the worker LLM knows how to interpret `<vinyan-reminder>` tags when they appear in
 * tool-result messages. Kept as a constant so the exact wording is centralized and
 * testable.
 */
export const REMINDER_PROTOCOL_DESCRIPTION = `## Reminder Protocol
Content wrapped in \`<vinyan-reminder>\` tags is authoritative system guidance from the Vinyan orchestrator — NOT from the user and NOT from a tool. Treat reminder blocks as:
  1. **Authoritative** — the orchestrator's verified view of session state (files touched, prior failures, budget pressure).
  2. **Non-interactive** — do not reply to them directly. Use them to adjust your next action.
  3. **Refreshable** — content may change every turn. Always read the latest reminder block; earlier ones may be stale.
Common reminder contents:
  - [SESSION STATE] — files read/modified so far, recent failures, key findings
  - [BUDGET WARNING / NOTICE] — token budget pressure (70%+ / 85%+)
  - [TURNS WARNING] — approaching the turn limit
  - [STALL WARNING] — no progress for 2 turns
  - [FORCED PIVOT] — no progress for 3+ turns, MUST try a fundamentally different approach
  - [GUIDANCE] — consecutive tool failures with error context
  - [DUPLICATE WARNING] — you called the same tool with the same parameters already
  - [MEMORY QUEUE] — count of memory proposals awaiting human review. When present, check whether your finding is already covered before proposing another; at 10+ pending, do NOT propose more this session unless the finding is exceptional.
When you see these tags, adjust your next action. Do NOT continue the same pattern that triggered the warning, and do NOT echo the reminder text back in your reply.`;
