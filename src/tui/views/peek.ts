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
  'phase:timing',
  'worker:dispatch',
  'worker:complete',
  'worker:error',
  'worker:selected',
  'oracle:verdict',
  'oracle:contradiction',
  'oracle:deliberation_request',
  'critic:verdict',
  // Wave 5 observability: `critic:debate_fired` and
  // `critic:debate_denied` fire when DebateRouterCritic decides between
  // the baseline and the 3-seat debate path. Surfacing both lets
  // operators correlate debate cost with task outcome in `peek`.
  'critic:debate_fired',
  'critic:debate_denied',
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
  // Post-merge gap close (Phase A §7 seam #3, 2026-04-15):
  // `monitoring:drift_detected` landed in the feature/main merge as
  // the first new task-bearing event introduced after peek's whitelist
  // was written. Adding it here plus the regression test in
  // `tests/tui/peek-whitelist-coverage.test.ts` closes the drift:
  // future task-bearing events will fail the regression test in CI
  // until the whitelist is updated.
  'monitoring:drift_detected',
  // Task-level operator signals that predate peek but were missed in
  // the initial whitelist. `commit:rejected` is critical for
  // understanding per-task commit-gate denies; `decomposer:fallback`
  // surfaces when the LLM decomposer failed its 3 retries and fell
  // back to a single-node DAG.
  'commit:rejected',
  'decomposer:fallback',
  // `oracle:self_report_excluded` — K1.0 A5 enforcement. Shows when
  // a verdict was filtered from the gate decision because the oracle
  // self-reported confidence instead of producing deterministic
  // evidence. High value for debugging "why did my task pass/fail".
  'oracle:self_report_excluded',
  // Sandbox lifecycle events — per-task container state. Useful when
  // debugging A6 sandbox issues (creation failure, timeout, exit).
  'sandbox:created',
  'sandbox:completed',
  'sandbox:timeout',
  'sandbox:error',
  // `agent:thinking` — per-turn thinking stream. High volume but
  // high signal when following a single agent's reasoning live.
  'agent:thinking',
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
    case 'phase:timing':
      return `${p.phase ?? '?'} ${p.durationMs ?? 0}ms L${p.routingLevel ?? '?'}`;
    case 'critic:debate_fired':
      return color(
        `DEBATE risk=${(p.riskScore as number | undefined)?.toFixed(2) ?? '?'} trigger=${p.trigger ?? '?'}`,
        ANSI.magenta,
      );
    case 'critic:debate_denied':
      return color(`DEBATE denied type=${p.denyType ?? '?'} ${p.reason ?? ''}`.slice(0, 80), ANSI.yellow);
    case 'monitoring:drift_detected':
      return color(
        `DRIFT dims=${Array.isArray(p.triggeredDimensions) ? (p.triggeredDimensions as string[]).join(',') : '?'} delta=${(p.maxRelDelta as number | undefined)?.toFixed(3) ?? '?'}`,
        ANSI.yellow,
      );
    case 'commit:rejected': {
      const rejected = Array.isArray(p.rejected) ? (p.rejected as { path: string; reason: string }[]) : [];
      return color(
        `COMMIT REJECTED ${rejected.length} file(s): ${rejected
          .map((r) => r.path)
          .join(', ')
          .slice(0, 60)}`,
        ANSI.red,
      );
    }
    case 'decomposer:fallback':
      return color('decomposer fell back to single-node DAG', ANSI.yellow);
    default:
      return JSON.stringify(payload).slice(0, 120);
  }
}
