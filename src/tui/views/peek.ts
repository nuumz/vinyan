/**
 * Peek View — per-agent live stream.
 *
 * Book-integration Wave 3.1 (see docs/architecture/book-integration-overview.md).
 *
 * The existing TUI watch mode (src/tui/commands.ts `startWatch`) prints every
 * bus event flowing through the orchestrator — great for observing the
 * system, terrible for observing ONE worker. `peek` filters the same event
 * stream down to a single task id so operators can follow a specific
 * agent's turn-by-turn progress without drowning in cross-task noise.
 *
 * Design notes:
 *   - Zero governance impact. This is a pure read-side consumer of events
 *     that are already on the bus. No axiom touched.
 *   - Reuses `EventRenderer`'s categorization/icons by subscribing to the
 *     same event names, but filters each payload to match `taskId`.
 *   - Supports glob-style prefix matching so `peek t-abc-*` follows a
 *     whole delegation chain (parent + children spawned with `t-abc-child-…`).
 */

import type { BusEventName, VinyanBus } from '../../core/bus.ts';
import { ANSI, color, dim, formatTimestamp } from '../renderer.ts';

// ── Config ──────────────────────────────────────────────────────────

export interface PeekConfig {
  /**
   * Exact task id or glob-style prefix pattern. `foo-*` matches anything
   * starting with `foo-`; `*-child-*` matches children; `*` matches all
   * (effectively a watch view).
   */
  taskIdPattern: string;
  /** Whether to prefix rendered lines with HH:MM:SS. Default true. */
  showTimestamps?: boolean;
  /** Optional sink for the formatted lines — default: console.log. */
  write?: (line: string) => void;
}

// ── Event whitelist ─────────────────────────────────────────────────

/**
 * Events that carry a `taskId` we can filter on. Maintained as a literal
 * list so adding a new `taskId`-bearing event to the bus requires an
 * explicit edit here — catches new events during code review rather than
 * silently missing them.
 */
const TASK_EVENTS: BusEventName[] = [
  'task:start',
  'task:complete',
  'task:uncertain',
  'task:escalate',
  'task:timeout',
  'task:explore',
  'task:approval_required',
  'task:recovered',
  'task:budget-exceeded',
  'worker:dispatch',
  'worker:complete',
  'worker:error',
  'worker:selected',
  'oracle:verdict',
  'oracle:contradiction',
  'oracle:deliberation_request',
  'critic:verdict',
  'agent:session_start',
  'agent:session_end',
  'agent:turn_complete',
  'agent:tool_executed',
  'agent:tool_denied',
  'agent:contract_violation',
  'agent:transcript_compaction',
  'agent:clarification_requested',
  'delegation:done',
  'delegation:remote',
  'dag:executed',
  'prediction:generated',
  'prediction:calibration',
  'prediction:outcome-skipped',
  'prediction:miscalibrated',
  'prediction:tier_upgraded',
  'verification:contradiction_escalated',
  'verification:contradiction_unresolved',
  // Wave 1.1 — worker-level silence watchdog. The payload carries
  // taskId so `peek` can surface it inline with turn events.
  'guardrail:silent_agent',
];

// ── Matching ────────────────────────────────────────────────────────

/**
 * Compile a glob pattern into a regex. Supports `*` only (enough for
 * task id prefixes; we deliberately skip `?`, `[…]` etc. to keep the
 * mental model small).
 */
function compileGlob(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`);
}

/**
 * Best-effort taskId extractor. Events vary: some put `taskId` at the
 * top level, some nest it under `result`, `job`, `input`, etc. We walk
 * a small list of known locations rather than a generic deep scan so
 * that adding a new event here is a conscious choice.
 */
function extractTaskId(payload: unknown): string | undefined {
  if (payload && typeof payload === 'object') {
    const p = payload as Record<string, unknown>;
    if (typeof p.taskId === 'string') return p.taskId;
    if (p.result && typeof (p.result as Record<string, unknown>).taskId === 'string') {
      return (p.result as Record<string, unknown>).taskId as string;
    }
    if (p.input && typeof (p.input as Record<string, unknown>).id === 'string') {
      return (p.input as Record<string, unknown>).id as string;
    }
    if (p.job && typeof (p.job as Record<string, unknown>).taskId === 'string') {
      return (p.job as Record<string, unknown>).taskId as string;
    }
  }
  return undefined;
}

// ── Peek runner ─────────────────────────────────────────────────────

export interface PeekHandle {
  stop(): void;
  /** Count of events matched so far — useful in tests. */
  matchedCount(): number;
}

/**
 * Attach to the bus and stream matched events until `stop()` is called.
 * Returns synchronously — no promise-based wait loop — so the CLI can
 * block on `process.on('SIGINT')` or similar in the caller.
 */
export function startPeek(bus: VinyanBus, config: PeekConfig): PeekHandle {
  const pattern = compileGlob(config.taskIdPattern);
  const write = config.write ?? ((line: string) => console.log(line));
  const showTimestamps = config.showTimestamps !== false;
  const unsubscribers: Array<() => void> = [];
  let matched = 0;

  const handleEvent = (eventName: string, payload: unknown): void => {
    const taskId = extractTaskId(payload);
    if (!taskId) return;
    if (!pattern.test(taskId)) return;

    matched++;
    const ts = showTimestamps ? `${dim(formatTimestamp(Date.now()))} ` : '';
    const taskTag = color(taskId.padEnd(20).slice(0, 20), ANSI.cyan);
    const eventTag = color(eventName.padEnd(24).slice(0, 24), ANSI.magenta);
    const summary = summarizeForPeek(eventName, payload);
    write(`${ts}${taskTag} ${eventTag} ${summary}`);
  };

  for (const eventName of TASK_EVENTS) {
    const unsub = bus.on(eventName, (payload: unknown) => {
      handleEvent(eventName, payload);
    });
    unsubscribers.push(unsub);
  }

  return {
    stop() {
      for (const unsub of unsubscribers) unsub();
      unsubscribers.length = 0;
    },
    matchedCount() {
      return matched;
    },
  };
}

// ── Summaries ───────────────────────────────────────────────────────

/**
 * Compact per-event summary tuned for `peek` — denser than the general
 * EventRenderer summary because we already know the task id and don't
 * need to repeat it.
 */
function summarizeForPeek(event: string, payload: unknown): string {
  const p = (payload ?? {}) as Record<string, unknown>;
  switch (event) {
    case 'task:start':
      return `routing=${JSON.stringify(p.routing ?? null).slice(0, 60)}`;
    case 'task:complete': {
      const r = p.result as { status?: string; mutations?: unknown[] } | undefined;
      return `status=${r?.status ?? '?'} mutations=${r?.mutations?.length ?? 0}`;
    }
    case 'task:uncertain':
      return `reason="${String(p.reason ?? '').slice(0, 80)}"`;
    case 'agent:session_start':
      return `level=${p.routingLevel ?? '?'} maxTokens=${(p.budget as { maxTokens?: number })?.maxTokens ?? '?'}`;
    case 'agent:session_end':
      return `outcome=${p.outcome ?? '?'} tokens=${p.tokensConsumed ?? 0} turns=${p.turnsUsed ?? 0}`;
    case 'agent:turn_complete':
      return `turn=${p.turnId ?? '?'} tokens=${p.tokensConsumed ?? 0} remaining=${p.turnsRemaining ?? '?'}`;
    case 'agent:tool_executed':
      return `tool=${p.toolName ?? '?'} ${p.isError ? color('ERR', ANSI.red) : color('ok', ANSI.green)} ${p.durationMs ?? 0}ms`;
    case 'agent:tool_denied':
      return `tool=${p.toolName ?? '?'} reason="${String(p.violation ?? '').slice(0, 60)}"`;
    case 'oracle:verdict':
      return `oracle=${p.oracleName ?? '?'} ${JSON.stringify(p.verdict ?? {}).slice(0, 60)}`;
    case 'critic:verdict':
      return `accepted=${p.accepted ?? '?'} conf=${(p.confidence as number | undefined)?.toFixed(2) ?? '?'}`;
    case 'delegation:done':
      return `child=${p.childTaskId ?? '?'} status=${p.status ?? '?'} tokens=${p.tokensUsed ?? 0}`;
    case 'guardrail:silent_agent':
      return color(
        `SILENT state=${p.state ?? '?'} for=${p.silentForMs ?? 0}ms lastEvent=${p.lastEvent ?? '?'}`,
        ANSI.yellow,
      );
    default:
      return JSON.stringify(payload).slice(0, 120);
  }
}
