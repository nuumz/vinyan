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
