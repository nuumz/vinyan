/**
 * W3 H3 — cron reply delivery helper.
 *
 * Converts a {@link TaskResult} + {@link ScheduledHypothesisTuple} origin
 * into a {@link GatewayOutboundEnvelope} and dispatches it through the
 * {@link MessagingAdapterLifecycleManager}. For CLI-originated schedules
 * the dispatch is a no-op (logged only) — there's no adapter to route to.
 *
 * A3 compliance: the origin → envelope mapping is rule-based; no LLM is in
 * the reply path.
 *
 * A6 compliance: adapter failures (throws or non-ok receipts) are logged
 * but never thrown out of this function. A broken adapter cannot break
 * the tick loop.
 */

import type { TaskResult } from '../../orchestrator/types.ts';
import { MAX_ENVELOPE_TEXT_LEN } from '../envelope.ts';
import type { MessagingAdapterLifecycleManager } from '../lifecycle.ts';
import type { GatewayOutboundEnvelope } from '../types.ts';
import type { ScheduledHypothesisTuple } from './types.ts';

export interface DeliverReplyDeps {
  readonly lifecycle: MessagingAdapterLifecycleManager;
  readonly log: (level: 'info' | 'warn' | 'error', msg: string, meta?: Record<string, unknown>) => void;
  /** Test hook for deterministic envelope ids. */
  readonly uuid?: () => string;
}

/**
 * Build an OutboundEnvelope from a cron task result + origin, and dispatch
 * via the messaging lifecycle. Returns a no-op for CLI origins.
 *
 * Never throws. Adapter failures are logged and swallowed — the tick loop
 * must keep running regardless.
 */
export async function deliverCronReply(
  schedule: ScheduledHypothesisTuple,
  result: TaskResult,
  deps: DeliverReplyDeps,
): Promise<void> {
  const origin = schedule.origin;

  if (origin.platform === 'cli') {
    deps.log('info', '[schedule] cli-origin schedule fired; no reply to dispatch', {
      scheduleId: schedule.id,
      taskStatus: result.status,
    });
    return;
  }

  if (!origin.chatId) {
    deps.log('warn', '[schedule] non-cli origin without chatId; cannot deliver reply', {
      scheduleId: schedule.id,
      platform: origin.platform,
    });
    return;
  }

  const envelope: GatewayOutboundEnvelope = {
    envelopeId: deps.uuid?.() ?? cryptoRandomId(),
    platform: origin.platform,
    chatId: origin.chatId,
    text: summarizeResult(result),
    ...(origin.threadKey ? { replyTo: origin.threadKey } : {}),
  };

  try {
    const receipt = await deps.lifecycle.deliver(envelope);
    if (!receipt.ok) {
      deps.log('warn', '[schedule] deliver receipt reported failure', {
        scheduleId: schedule.id,
        platform: origin.platform,
        error: receipt.error,
      });
    }
  } catch (err) {
    // Lifecycle.deliver catches adapter throws and converts them to failing
    // receipts, so this branch is belt-and-braces — surfaces only if the
    // lifecycle itself is broken (e.g. undefined).
    deps.log('error', '[schedule] lifecycle.deliver threw', {
      scheduleId: schedule.id,
      platform: origin.platform,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Build a human-readable summary of a TaskResult suitable for a messaging
 * platform reply. Truncated to {@link MAX_ENVELOPE_TEXT_LEN}. Prefers
 * `answer` (set on reasoning/Q&A tasks), falls back to a small JSON dump.
 */
function summarizeResult(result: TaskResult): string {
  const raw = selectBody(result);
  return truncate(raw, MAX_ENVELOPE_TEXT_LEN);
}

function selectBody(result: TaskResult): string {
  if (typeof result.answer === 'string' && result.answer.length > 0) {
    return result.answer;
  }
  if (Array.isArray(result.clarificationNeeded) && result.clarificationNeeded.length > 0) {
    return result.clarificationNeeded.join('\n');
  }
  // Fall back to a bounded JSON dump. 4K keeps the envelope small even if
  // the result contains deep mutation diffs.
  try {
    return JSON.stringify(
      {
        status: result.status,
        escalationReason: result.escalationReason,
        mutations: result.mutations.length,
      },
      null,
      2,
    );
  } catch {
    return `status=${result.status}`;
  }
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  // Leave room for the ellipsis marker so the message stays valid.
  const ellipsis = '…';
  return text.slice(0, Math.max(0, max - ellipsis.length)) + ellipsis;
}

function cryptoRandomId(): string {
  const g = globalThis as { crypto?: { randomUUID?: () => string } };
  if (g.crypto?.randomUUID) return g.crypto.randomUUID();
  return `env-${Date.now().toString(16)}-${Math.random().toString(16).slice(2, 10)}`;
}
