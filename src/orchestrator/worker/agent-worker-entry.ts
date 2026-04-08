/**
 * Agent Worker Entry — subprocess entry point for L1+ agentic workers.
 *
 * Runs a tool loop driven by LLM responses:
 *   Read init → build history → (LLM.generate → process → writeTurn → read results)* → exit
 *
 * Only writeTurn() writes to stdout. ALL debug/error logging → stderr.
 * The core logic is in runAgentWorkerLoop() with explicit I/O params for testability.
 */
import { OrchestratorTurnSchema, type WorkerTurn } from '../protocol.ts';
import type { HistoryMessage, LLMProvider, Message, ToolResultMessage } from '../types.ts';
import { PromptTooLargeError } from '../types.ts';
import { compressPerception } from '../llm/perception-compressor.ts';

// ── Constants ──────────────────────────────────────────────────────
const MAX_COMPRESSION_ATTEMPTS = 2;
const CONTEXT_COMPRESSION_CONTINUATION_PROMPT = [
  'The conversation history above has been compressed to fit within context limits.',
  'The [COMPRESSED CONTEXT] block summarizes prior turns. Continue the task from where you left off.',
].join('\n');

// ── Public types ───────────────────────────────────────────────────

export interface WorkerIO {
  readLine: () => Promise<string | null>;
  writeLine: (line: string) => void;
}

// ── Main ───────────────────────────────────────────────────────────

/**
 * Core agent loop — testable without subprocess.
 * Takes explicit I/O functions instead of process.stdin/stdout.
 */
export async function runAgentWorkerLoop(
  provider: LLMProvider,
  io: WorkerIO,
): Promise<void> {
  // 1. Read init turn
  const initLine = await io.readLine();
  if (!initLine) {
    logError('No init turn received');
    return;
  }

  let parsed: ReturnType<typeof OrchestratorTurnSchema.safeParse>;
  try {
    parsed = OrchestratorTurnSchema.safeParse(JSON.parse(initLine));
  } catch {
    logError('Failed to parse init turn JSON');
    return;
  }
  if (!parsed.success || parsed.data.type !== 'init') {
    logError(`Invalid init turn: ${JSON.stringify(parsed.error?.issues ?? 'not init type')}`);
    return;
  }
  const init = parsed.data;

  // Start parent death watchdog (orphan protection)
  const parentPid = parseInt(process.env.VINYAN_ORCHESTRATOR_PID ?? '0');
  let watchdog: ReturnType<typeof setInterval> | undefined;
  if (parentPid > 0) {
    watchdog = setInterval(() => {
      try {
        process.kill(parentPid, 0); // signal 0 = alive check
      } catch {
        io.writeLine(JSON.stringify({
          type: 'uncertain',
          turnId: 't-orphan',
          reason: 'Parent process gone — self-terminating',
          uncertainties: ['orphaned worker'],
          tokensConsumed: 0,
        }) + '\n');
        if (watchdog) clearInterval(watchdog);
        process.exit(1);
      }
    }, 10_000);
  }

  // 2. Compress perception
  const compressedPerception = compressPerception(init.perception, init.budget.contextWindow);

  // 3. Build initial history
  const taskType = init.taskType ?? (!init.allowedPaths?.length ? 'reasoning' : 'code');
  const history: HistoryMessage[] = [
    {
      role: 'system',
      content: buildSystemPrompt(init.routingLevel, taskType),
    },
    {
      role: 'user',
      content: buildInitUserMessage(init.goal, compressedPerception, init.priorAttempts, (init as any).understanding),
    },
  ];

  let compressionAttempts = 0;
  let totalTokensConsumed = 0;
  let turnCount = 0;

  try {
  // 4. Main loop
  for (let turn = 0; turn < init.budget.maxTurns; turn++) {
    // 4a. Proactive compression check
    const historyTokens = estimateHistoryTokens(history);
    if (historyTokens > init.budget.contextWindow * 0.75 && compressionAttempts < MAX_COMPRESSION_ATTEMPTS) {
      history.splice(0, history.length, ...compressHistory(history));
      compressionAttempts++;
    }

    // 4b. LLM generate
    let response: Awaited<ReturnType<typeof provider.generate>>;
    try {
      response = await provider.generate({
        systemPrompt: '',  // already in history[0]
        userPrompt: '',    // already in history
        maxTokens: Math.min(init.budget.maxTokens - totalTokensConsumed, 4096),
        messages: history,
        tools: init.toolManifest.map(t => ({ name: t.name, description: t.description, parameters: t.inputSchema })),
      });
    } catch (err) {
      // PromptTooLargeError → compress history and retry once
      if (err instanceof PromptTooLargeError && compressionAttempts < MAX_COMPRESSION_ATTEMPTS) {
        logError(`Prompt too large (~${err.estimatedTokens} tokens), compressing and retrying`);
        history.splice(0, history.length, ...compressHistory(history));
        compressionAttempts++;
        continue; // retry this turn with compressed history
      }
      const msg = err instanceof Error ? err.message : String(err);
      logError(`LLM generate failed: ${msg}`);
      writeTurn(io, {
        type: 'uncertain',
        turnId: `t${turnCount}`,
        reason: `LLM generation error: ${msg}`,
        uncertainties: [`LLM call failed: ${msg}`],
        tokensConsumed: totalTokensConsumed,
      });
      return;
    }

    totalTokensConsumed += response.tokensUsed.input + response.tokensUsed.output;
    turnCount++;

    // 4c. Append assistant response to history
    const assistantMsg: Message = {
      role: 'assistant',
      content: response.content,
      thinking: response.thinking,
      toolCalls: response.toolCalls.length > 0 ? response.toolCalls : undefined,
    };
    history.push(assistantMsg);

    // 4d. Handle max_tokens — reactive compression
    if (response.stopReason === 'max_tokens') {
      if (compressionAttempts < MAX_COMPRESSION_ATTEMPTS) {
        history.splice(0, history.length, ...compressHistory(history));
        compressionAttempts++;
        continue; // retry with compressed history
      }
      // Can't compress further — give up
      writeTurn(io, {
        type: 'uncertain',
        turnId: `t${turnCount}`,
        reason: 'max_tokens after compression attempts exhausted',
        uncertainties: ['Context window exhausted'],
        tokensConsumed: totalTokensConsumed,
      });
      return;
    }

    // 4e. Tool calls (including attempt_completion)
    if (response.stopReason === 'tool_use' || response.toolCalls.length > 0) {
      const completionCall = response.toolCalls.find(c => c.tool === 'attempt_completion');
      const regularCalls = response.toolCalls.filter(c => c.tool !== 'attempt_completion');

      if (regularCalls.length > 0) {
        // Write tool_calls turn and wait for results
        writeTurn(io, {
          type: 'tool_calls',
          turnId: `t${turnCount}`,
          calls: regularCalls,
          rationale: response.content || 'Tool execution',
          tokensConsumed: totalTokensConsumed,
        });

        // Read tool_results from orchestrator
        const resultsLine = await io.readLine();
        if (!resultsLine) {
          logError('No tool_results received — stream closed');
          return;
        }

        let resultsParsed: ReturnType<typeof OrchestratorTurnSchema.safeParse>;
        try {
          resultsParsed = OrchestratorTurnSchema.safeParse(JSON.parse(resultsLine));
        } catch {
          logError('Failed to parse tool_results JSON');
          return;
        }
        if (!resultsParsed.success) {
          logError(`Invalid tool_results: ${JSON.stringify(resultsParsed.error.issues)}`);
          return;
        }

        if (resultsParsed.data.type === 'terminate') {
          return; // orchestrator asked us to stop
        }

        if (resultsParsed.data.type === 'tool_results') {
          for (const r of resultsParsed.data.results) {
            const toolResultMsg: ToolResultMessage = {
              role: 'tool_result',
              toolCallId: r.callId,
              content: typeof r.output === 'string' ? r.output
                : r.status === 'success' && r.output != null ? JSON.stringify(r.output)
                : (r.error ?? ''),
              isError: r.status !== 'success',
            };
            history.push(toolResultMsg);
          }
        }
      }

      // Handle attempt_completion (processed AFTER regular tools)
      if (completionCall) {
        const params = completionCall.parameters;
        const status = (params.status as string) ?? 'done';
        if (status === 'uncertain') {
          writeTurn(io, {
            type: 'uncertain',
            turnId: `t${turnCount}`,
            reason: (params.summary as string) ?? 'Worker reported uncertainty',
            uncertainties: (params.uncertainties as string[]) ?? [],
            tokensConsumed: totalTokensConsumed,
          });
        } else {
          writeTurn(io, {
            type: 'done',
            turnId: `t${turnCount}`,
            proposedContent: (params.proposedContent as string) ?? (params.summary as string),
            tokensConsumed: totalTokensConsumed,
          });
        }
        return;
      }
      continue; // back to loop for next LLM call
    }

    // 4f. end_turn with no attempt_completion — implicit done
    writeTurn(io, {
      type: 'done',
      turnId: `t${turnCount}`,
      proposedContent: response.content,
      tokensConsumed: totalTokensConsumed,
    });
    return;
  }

  // Exhausted maxTurns
  writeTurn(io, {
    type: 'uncertain',
    turnId: `t${turnCount}`,
    reason: 'Max turns exhausted',
    uncertainties: ['Reached maximum turn limit without completing task'],
    tokensConsumed: totalTokensConsumed,
  });
  } finally {
    if (watchdog) clearInterval(watchdog);
  }
}

/**
 * Subprocess entry point — wires process.stdin/stdout to the core loop.
 */
export async function agentWorkerMain(
  provider: LLMProvider,
): Promise<void> {
  const reader = Bun.stdin.stream().getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  const io: WorkerIO = {
    async readLine(): Promise<string | null> {
      while (true) {
        const newlineIdx = buffer.indexOf('\n');
        if (newlineIdx !== -1) {
          const line = buffer.slice(0, newlineIdx).trim();
          buffer = buffer.slice(newlineIdx + 1);
          return line || null;
        }
        const { done, value } = await reader.read();
        if (done) return buffer.trim() || null;
        buffer += decoder.decode(value, { stream: true });
      }
    },
    writeLine(line: string): void {
      process.stdout.write(line);
    },
  };

  await runAgentWorkerLoop(provider, io);
}

// ── Helpers ────────────────────────────────────────────────────────

function writeTurn(io: WorkerIO, turn: WorkerTurn): void {
  io.writeLine(JSON.stringify(turn) + '\n');
}

function logError(msg: string): void {
  process.stderr.write(`[agent-worker] ${msg}\n`);
}

export function buildSystemPrompt(routingLevel: number, taskType: 'code' | 'reasoning' = 'code'): string {
  if (taskType === 'reasoning') {
    return [
      `You are a Vinyan reasoning agent at routing level L${routingLevel}.`,
      'Your task is to research, reason about, or answer the given question using available tools.',
      'You may use file_read, shell_exec, or search tools to gather information before answering.',
      "When you are done, call attempt_completion with status 'done' and put your full answer in the proposedContent field.",
      "If you cannot answer, call attempt_completion with status 'uncertain'.",
      'IMPORTANT: You MUST call attempt_completion to signal task end. Do not just stop responding.',
    ].join('\n');
  }
  return [
    `You are a Vinyan agentic worker at routing level L${routingLevel}.`,
    'Your task is to use the available tools to accomplish the given goal.',
    "When you are done, call attempt_completion with status 'done'.",
    "If you cannot complete the task, call attempt_completion with status 'uncertain'.",
    'IMPORTANT: You MUST call attempt_completion to signal task end. Do not just stop responding.',
  ].join('\n');
}

export function buildInitUserMessage(
  goal: string,
  perception: unknown,
  priorAttempts?: unknown[],
  understanding?: unknown,
): string {
  let msg = `## Task\n${goal}`;

  // Render semantic context from enriched understanding (Layer 1+2)
  if (understanding && typeof understanding === 'object') {
    const u = understanding as Record<string, unknown>;
    const intent = u.semanticIntent as Record<string, unknown> | undefined;
    if (intent) {
      const lines: string[] = ['\n\n## Semantic Context'];
      if (typeof intent.goalSummary === 'string') lines.push(`Summary: ${intent.goalSummary}`);
      if (Array.isArray(intent.steps) && intent.steps.length) {
        lines.push('Steps:');
        for (const s of intent.steps) lines.push(`  - ${s}`);
      }
      if (Array.isArray(intent.successCriteria) && intent.successCriteria.length) {
        lines.push('Done when:');
        for (const c of intent.successCriteria) lines.push(`  - ${c}`);
      }
      if (Array.isArray(intent.affectedComponents) && intent.affectedComponents.length) {
        lines.push(`Affected: ${intent.affectedComponents.join(', ')}`);
      }
      if (typeof intent.rootCause === 'string') lines.push(`Root cause hypothesis: ${intent.rootCause}`);
      lines.push(`Intent: ${intent.primaryAction} — ${intent.scope}`);
      const constraints = intent.implicitConstraints as Array<{ text: string; polarity: string }> | undefined;
      if (Array.isArray(constraints)) {
        for (const c of constraints) {
          lines.push(`${c.polarity === 'must-not' ? 'MUST NOT' : 'MUST'}: ${c.text}`);
        }
      }
      msg += lines.join('\n');
    }
    // Resolved entities (Layer 1)
    const entities = u.resolvedEntities as Array<{ reference: string; resolvedPaths: string[]; resolution: string }> | undefined;
    if (Array.isArray(entities) && entities.length) {
      msg += '\n\nResolved entities:';
      for (const e of entities) msg += `\n  "${e.reference}" → ${e.resolvedPaths?.join(', ')} (${e.resolution})`;
    }
  }

  msg += `\n\n## Perception\n${JSON.stringify(perception, null, 2)}`;
  if (priorAttempts && priorAttempts.length > 0) {
    msg += `\n\n## Prior Attempts\n${JSON.stringify(priorAttempts, null, 2)}`;
  }
  return msg;
}

export function estimateHistoryTokens(history: HistoryMessage[]): number {
  return Math.ceil(JSON.stringify(history).length / 3.5);
}

/**
 * Two-tier context compression.
 * Keep: [0] system, [1] init user — verbatim always.
 * Classify middle turns as LANDMARK vs NON-LANDMARK.
 * Combine into single role: 'user' message (fix #3: NOT 'assistant').
 * Keep: last 3 turns verbatim.
 */
export function compressHistory(history: HistoryMessage[]): HistoryMessage[] {
  if (history.length <= 5) return history; // too short to compress

  const system = history[0]!;   // system prompt — guaranteed by length > 5 check
  const init = history[1]!;     // init user message — guaranteed by length > 5 check
  const lastN = history.slice(-3); // preserve last 3 turns

  const middleTurns = history.slice(2, -3);
  if (middleTurns.length === 0) return history;

  const summaries: string[] = [];
  for (const turn of middleTurns) {
    if ('toolCalls' in turn && turn.toolCalls) {
      const toolNames = turn.toolCalls.map(c => c.tool).join(', ');
      summaries.push(`[assistant] Called tools: ${toolNames}`);
    } else if (turn.role === 'tool_result') {
      const content = (turn as ToolResultMessage).content ?? '';
      const isError = 'isError' in turn && (turn as ToolResultMessage).isError;
      const truncated = content.slice(0, isError ? 500 : 100);
      summaries.push(`[tool_result${isError ? ' ERROR' : ''}] ${truncated}`);
    } else if (turn.role === 'assistant') {
      summaries.push(`[assistant] ${((turn as Message).content ?? '').slice(0, 100)}`);
    } else if (turn.role === 'user') {
      summaries.push(`[user] ${((turn as Message).content ?? '').slice(0, 100)}`);
    }
  }

  const compressedBlock: Message = {
    role: 'user', // FIX #3: MUST be 'user', not 'assistant'
    content: `[COMPRESSED CONTEXT: ${middleTurns.length} turns]\n${summaries.join('\n')}\n\n${CONTEXT_COMPRESSION_CONTINUATION_PROMPT}`,
  };

  return [system, init, compressedBlock, ...lastN].filter((m): m is HistoryMessage => m !== undefined);
}

// ── Subprocess bootstrap ───────────────────────────────────────────

if (import.meta.main) {
  const socketPath = process.env.VINYAN_PROXY_SOCKET;
  if (!socketPath) {
    logError('VINYAN_PROXY_SOCKET env var is required for subprocess bootstrap');
    process.exit(1);
  }
  // Dynamic import to avoid bundling proxy code into test builds
  const { createProxyProvider } = await import('../llm/llm-proxy.ts');
  const routingLevel = parseInt(process.env.VINYAN_ROUTING_LEVEL ?? '1', 10);
  const tier: 'fast' | 'balanced' | 'powerful' =
    routingLevel >= 3 ? 'powerful' : routingLevel >= 2 ? 'balanced' : 'fast';
  const provider = createProxyProvider(socketPath, tier);
  await agentWorkerMain(provider);
}
