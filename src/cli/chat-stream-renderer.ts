/**
 * ChatStreamRenderer — live Copilot-style timeline for `vinyan chat`.
 *
 * Subscribes to VinyanBus, filters by a single active taskId, and writes
 * a running activity feed to the attached WritableStream (stdout by default).
 * Renders:
 *   intent → understanding → session_start → tool_started/executed →
 *   streaming assistant deltas → session_end → task:complete footer
 *
 * Pure observer (A3): never touches orchestrator state.
 *
 * Design notes:
 * - Uses only existing ANSI primitives from `src/tui/renderer.ts` — no deps.
 * - Per-turn state lives in `buffers` so delta streaming can switch cleanly
 *   between "thinking" and "answer" blocks.
 * - Tool-started events render a yellow `⚙ preparing` line; the paired
 *   `agent:tool_executed` replaces the preview with a pass/fail line.
 * - When a line has not wrapped yet we ANSI-rewrite in place; once wrapped,
 *   subsequent deltas are appended (never rewrite history).
 */

import type { BusEventName, VinyanBus } from '../core/bus.ts';
import { ANSI, dim } from '../tui/renderer.ts';

const ICONS = {
  intent: '🧠',
  understood: '🔍',
  session: '▶',
  tool: '🔧',
  toolRunning: '⚙',
  oraclePass: '✅',
  oracleFail: '❌',
  critic: '💭',
  escalate: '⬆',
  thinking: '💭',
  answer: '·',
  ok: '✔',
  warn: '⚠',
  retry: '↪',
};

export interface ChatStreamRendererOptions {
  /** Only events whose payload.taskId matches will render. */
  taskId: string;
  /** Writable stream (default: process.stdout). */
  out?: NodeJS.WritableStream;
  /** ANSI colors on/off. Defaults to isTTY. */
  color?: boolean;
  /** Render dim thinking block for streamed thinking deltas. Default false. */
  showThinking?: boolean;
}

export interface ChatStreamRendererHandle {
  /** Unsubscribe + finalize — call on task completion or error. */
  detach: () => void;
  /** Force-close any open inline block (answer / thinking) with a newline. */
  flushSummary: () => void;
  /** Toggle showThinking live (bound to `/thinking`). */
  setShowThinking: (v: boolean) => void;
  /**
   * True when the renderer already wrote the assistant answer inline via
   * `agent:text_delta` / `llm:stream_delta` content. The caller can use this
   * to suppress a duplicate `result.answer` print on task completion.
   */
  didStreamAnswer: () => boolean;
}

interface InternalState {
  /** Which kind the current inline block is, if any. */
  active: 'thinking' | 'answer' | null;
  /** Number of visible chars written to the current inline block. */
  lineLen: number;
  /** Ongoing tool-started preview: callId → { tool, startedAt }. */
  runningTools: Map<string, { tool: string; startedAt: number }>;
  /** Track emitted events to avoid duplicate rendering on re-subscribe. */
  sessionStarted: boolean;
  /** True once we've streamed at least one content chunk — used by the caller
   * to suppress a redundant `result.answer` print. */
  streamedAnswer: boolean;
}

export function attachChatStreamRenderer(
  bus: VinyanBus,
  options: ChatStreamRendererOptions,
): ChatStreamRendererHandle {
  const out = options.out ?? process.stdout;
  const useColor = options.color ?? (out as NodeJS.WriteStream).isTTY === true;
  let showThinking = options.showThinking ?? false;
  const taskId = options.taskId;
  const taskStartedAt = Date.now();

  const state: InternalState = {
    active: null,
    lineLen: 0,
    runningTools: new Map(),
    sessionStarted: false,
    streamedAnswer: false,
  };

  const c = (s: string, code: string) => (useColor ? `${code}${s}${ANSI.reset}` : s);
  const dimS = (s: string) => (useColor ? dim(s) : s);

  const write = (line: string) => {
    closeInlineBlock();
    out.write(`${line}\n`);
  };

  const closeInlineBlock = () => {
    if (state.active) {
      out.write('\n');
      state.active = null;
      state.lineLen = 0;
    }
  };

  const writeInline = (kind: 'thinking' | 'answer', text: string) => {
    if (state.active !== kind) {
      closeInlineBlock();
      const header = kind === 'thinking'
        ? `${ICONS.thinking} ${dimS('thinking')}`
        : `${c('vinyan:', ANSI.green + ANSI.bold)}`;
      out.write(`${header} `);
      state.active = kind;
      state.lineLen = kind === 'thinking' ? 10 : 8; // "thinking " / "vinyan: "
    }
    if (kind === 'answer') state.streamedAnswer = true;
    // Write body with appropriate color
    const body = kind === 'thinking' ? dimS(text) : text;
    out.write(body);
    // Track visible length for wrap-safe redraw (we don't rewrite history, but
    // we keep state accurate for potential future use). Count newlines as reset.
    for (const ch of text) {
      if (ch === '\n') state.lineLen = 0;
      else state.lineLen++;
    }
  };

  // Matches the payload shapes we care about defensively — payloads are typed
  // but users of this renderer could re-emit with partial data.
  const matchesTask = (p: unknown): boolean => {
    if (!p || typeof p !== 'object') return false;
    const obj = p as Record<string, unknown>;
    const tid =
      (obj.taskId as string | undefined) ??
      ((obj.input as Record<string, unknown> | undefined)?.id as string | undefined) ??
      ((obj.result as Record<string, unknown> | undefined)?.id as string | undefined);
    return tid === taskId;
  };

  const unsubs: Array<() => void> = [];
  // Type-erased subscribe helper. Each handler inside the subscriptions
  // block narrows payload via a local `as` cast — keeping one `as unknown`
  // here instead of typing every bus event individually.
  type BusSubscribe = (evt: BusEventName, handler: (p: unknown) => void) => () => void;
  const busOn = bus.on.bind(bus) as unknown as BusSubscribe;
  const on = (evt: BusEventName, handler: (p: unknown) => void) => {
    unsubs.push(
      busOn(evt, (payload: unknown) => {
        if (!matchesTask(payload)) return;
        try {
          handler(payload);
        } catch (err) {
          // Renderer must never kill the task.
          out.write(
            `${dimS(`[chat-stream-renderer error: ${err instanceof Error ? err.message : String(err)}]`)}\n`,
          );
        }
      }),
    );
  };

  // ── Subscriptions ─────────────────────────────────────────────

  on('intent:resolved', (p) => {
    const { strategy, confidence, reasoning } = p as {
      strategy: string;
      confidence: number;
      reasoning?: string;
    };
    const conf = Number.isFinite(confidence) ? confidence.toFixed(2) : '?';
    const tail = reasoning ? dimS(` — ${truncate(reasoning, 60)}`) : '';
    write(`${ICONS.intent} ${dimS('intent')} ${c(strategy, ANSI.cyan)} ${dimS(`(conf ${conf})`)}${tail}`);
  });

  on('understanding:layer0_complete', (p) => {
    const { verb, category } = p as { verb: string; category: string };
    write(`${ICONS.understood} ${dimS('understood')} ${c(verb, ANSI.blue)} → ${category}`);
  });

  on('understanding:layer1_complete', (p) => {
    const { entitiesResolved, isRecurring } = p as {
      entitiesResolved: number;
      isRecurring: boolean;
    };
    if (entitiesResolved > 0 || isRecurring) {
      write(
        `${ICONS.understood} ${dimS(`entities=${entitiesResolved}${isRecurring ? ' · recurring' : ''}`)}`,
      );
    }
  });

  on('task:start', (p) => {
    const { routing } = p as {
      routing: { level: number; model?: string | null };
    };
    const model = routing.model ? ` · ${routing.model}` : '';
    write(`🎯 ${dimS(`L${routing.level}${model}`)}`);
  });

  on('agent:session_start', (p) => {
    if (state.sessionStarted) return;
    state.sessionStarted = true;
    const { routingLevel, budget } = p as {
      routingLevel: number;
      budget: { maxTokens: number; maxTurns: number };
    };
    write(
      `${ICONS.session} ${c('agent', ANSI.bold)} ${dimS(
        `L${routingLevel} · ${budget.maxTurns} turns · ${budget.maxTokens} tokens`,
      )}`,
    );
  });

  on('agent:tool_started', (p) => {
    const { toolName, toolCallId } = p as { toolName: string; toolCallId?: string };
    const callId = toolCallId ?? `${toolName}-${Date.now()}`;
    state.runningTools.set(callId, { tool: toolName, startedAt: Date.now() });
    write(`  ${c(ICONS.toolRunning, ANSI.yellow)} ${dimS('preparing')} ${toolName}…`);
  });

  on('agent:tool_executed', (p) => {
    const { toolName, durationMs, isError, toolCallId } = p as {
      toolName: string;
      durationMs: number;
      isError: boolean;
      toolCallId?: string;
    };
    if (toolCallId) state.runningTools.delete(toolCallId);
    const mark = isError ? c('✗', ANSI.red) : c('✓', ANSI.green);
    write(`  ${ICONS.tool} ${toolName} ${mark} ${dimS(`${durationMs}ms`)}`);
  });

  on('agent:tool_denied', (p) => {
    const { toolName, violation } = p as { toolName: string; violation?: string };
    write(`  ${c('✗', ANSI.red)} tool denied: ${toolName}${violation ? dimS(` — ${violation}`) : ''}`);
  });

  on('agent:turn_complete', (p) => {
    const { tokensConsumed, turnsRemaining } = p as {
      tokensConsumed: number;
      turnsRemaining: number;
    };
    // Only surface when it's a noteworthy checkpoint — low-signal otherwise.
    if (turnsRemaining <= 3) {
      write(`  ${dimS(`↻ turn · ${tokensConsumed} tokens · ${turnsRemaining} turns left`)}`);
    }
  });

  on('agent:thinking', (p) => {
    if (!showThinking) return;
    const { rationale } = p as { rationale: string };
    const text = rationale.length > 180 ? `${rationale.slice(0, 180)}…` : rationale;
    write(`  ${ICONS.thinking} ${dimS(text)}`);
  });

  // Text delta — inline streaming. Plain content goes into the answer block.
  on('agent:text_delta', (p) => {
    const { text } = p as { text: string };
    if (!text) return;
    writeInline('answer', text);
  });

  // Rich delta — split by kind. Content → answer block, thinking → thinking
  // block (if enabled), tool_use_start → yellow preview line.
  on('llm:stream_delta', (p) => {
    const d = p as {
      kind: 'content' | 'thinking' | 'tool_use_start' | 'tool_use_input' | 'tool_use_end';
      text?: string;
      tool?: string;
      toolId?: string;
    };
    switch (d.kind) {
      case 'content':
        if (d.text) writeInline('answer', d.text);
        break;
      case 'thinking':
        if (showThinking && d.text) writeInline('thinking', d.text);
        break;
      case 'tool_use_start':
        if (d.tool) {
          closeInlineBlock();
          out.write(
            `  ${c(ICONS.toolRunning, ANSI.yellow)} ${dimS('preparing')} ${d.tool}(…)\n`,
          );
        }
        break;
      default:
        // tool_use_input / tool_use_end are low-signal for the chat timeline;
        // the paired `agent:tool_executed` supplies the final pass/fail line.
        break;
    }
  });

  on('oracle:verdict', (p) => {
    const { oracleName, verdict } = p as {
      oracleName: string;
      verdict: { verified: boolean; confidence?: number };
    };
    const mark = verdict.verified ? c(ICONS.oraclePass, ANSI.green) : c(ICONS.oracleFail, ANSI.red);
    const conf = verdict.confidence != null ? dimS(` (conf ${verdict.confidence.toFixed(2)})`) : '';
    write(`  ${mark} oracle ${oracleName}${conf}`);
  });

  on('critic:verdict', (p) => {
    const { accepted, confidence, reason } = p as {
      accepted: boolean;
      confidence: number;
      reason?: string;
    };
    const verdict = accepted ? c('accept', ANSI.green) : c('reject', ANSI.yellow);
    const tail = reason ? dimS(` — ${truncate(reason, 60)}`) : '';
    write(`  ${ICONS.critic} critic ${verdict} ${dimS(`(${confidence.toFixed(2)})`)}${tail}`);
  });

  on('task:escalate', (p) => {
    const { fromLevel, toLevel, reason } = p as {
      fromLevel: number;
      toLevel: number;
      reason: string;
    };
    write(`  ${c(ICONS.escalate, ANSI.magenta)} L${fromLevel}→L${toLevel}: ${truncate(reason, 80)}`);
  });

  on('tool:failure_classified', (p) => {
    const { type, recoverable, error } = p as {
      type: string;
      recoverable: boolean;
      error: string;
    };
    write(
      `  ${c(ICONS.warn, ANSI.yellow)} tool error ${dimS(type)}${recoverable ? dimS(' · recoverable') : ''} — ${truncate(error, 80)}`,
    );
  });

  on('tool:remediation_attempted', (p) => {
    const { correctedCommand } = p as { correctedCommand: string };
    write(`  ${c(ICONS.retry, ANSI.yellow)} retry ${dimS(truncate(correctedCommand, 80))}`);
  });

  on('agent:session_end', (p) => {
    const { outcome, tokensConsumed, turnsUsed, durationMs } = p as {
      outcome: string;
      tokensConsumed: number;
      turnsUsed: number;
      durationMs: number;
    };
    closeInlineBlock();
    const color =
      outcome === 'completed' ? ANSI.green : outcome === 'input_required' ? ANSI.yellow : ANSI.red;
    write(
      `${c(ICONS.ok, color)} agent ${outcome} ${dimS(
        `· ${turnsUsed} turns · ${tokensConsumed} tokens · ${Math.round(durationMs)}ms`,
      )}`,
    );
  });

  on('task:complete', (p) => {
    const { result } = p as { result: { status: string; mutations: unknown[] } };
    closeInlineBlock();
    const statusColor =
      result.status === 'completed'
        ? ANSI.green
        : result.status === 'input-required'
          ? ANSI.yellow
          : ANSI.red;
    const elapsed = Date.now() - taskStartedAt;
    write(
      `${c(ICONS.ok, statusColor)} ${result.status} ${dimS(
        `· ${result.mutations.length} mutation(s) · ${elapsed}ms`,
      )}`,
    );
  });

  return {
    detach: () => {
      closeInlineBlock();
      for (const u of unsubs) u();
    },
    flushSummary: closeInlineBlock,
    setShowThinking: (v: boolean) => {
      showThinking = v;
    },
    didStreamAnswer: () => state.streamedAnswer,
  };
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1)}…`;
}
