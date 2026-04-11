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
  'The [COMPRESSED CONTEXT] block summarizes prior turns.',
  'Resume directly — no apology, no recap. Pick up mid-task where you left off.',
  'If the remaining work is large, break it into smaller pieces.',
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
      content: buildInitUserMessage(
        init.goal, compressedPerception, init.priorAttempts,
        (init as any).understanding, init.conversationHistory,
        (init as any).failedApproaches, (init as any).acceptanceCriteria,
      ),
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
        tools: init.toolManifest.map(t => ({ name: t.name, description: t.description, parameters: t.inputSchema, kind: t.toolKind ?? 'executable' })),
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
  const common = `You are a Vinyan autonomous agent at routing level L${routingLevel}.

## Reasoning Framework
For every turn, follow this structured cycle:
1. **Assess** — What do I know? What have I accomplished? What evidence do I have?
2. **Identify gap** — What is still missing, unknown, or unverified?
3. **Select action** — Which single tool best addresses the gap? Why this one over alternatives?
4. **Execute** — Call the tool with precise parameters. One focused action per turn.
5. **Observe** — Did it succeed? What concrete data did I learn? Did it contradict expectations?
6. **Decide** — Am I done? Should I verify? Is my approach working or do I need to pivot?

## Progress Tracking
Track explicitly:
- Files read and understood (with key findings)
- Changes made and their rationale
- What remains and estimated effort
- Whether the current approach is converging or stalling

## Behavioral Rules
- Go straight to the point. Try the simplest approach first without going in circles.
- Be concise between tool calls — keep reasoning to essentials, not narration.
- Lead with action, not explanation. The work speaks louder than the commentary.
- Do NOT add features, refactor code, or make "improvements" beyond what was asked.
- Do NOT create helpers, utilities, or abstractions for one-time operations.
- Do NOT design for hypothetical future requirements. Three similar lines of code is better than a premature abstraction.
- Do NOT add docstrings, comments, or type annotations to code you did not change.
- If a file's content is unknown, say so — do NOT guess or fabricate file contents, imports, or APIs.
- Never claim "all tests pass" or "everything works" without evidence. Report outcomes faithfully.

## Adaptive Strategy
- If a tool call fails, diagnose WHY before retrying. Read the error. Check your assumptions. Try a focused fix.
- If 2+ consecutive failures on the same approach, stop and try a fundamentally different path.
- Read before writing — ALWAYS understand existing code before modifying it.
- Search for existing patterns in the codebase before creating anything new.
- Verify after changing — run tests, check for syntax errors, confirm the change works.
- If you discover unexpected state (unfamiliar files, existing implementations), investigate before overwriting.

## Reversibility Awareness
- Freely take local, reversible actions (reading files, running tests, small edits).
- For destructive or hard-to-reverse actions (deleting files, large rewrites, removing functionality), pause and explain what you intend before proceeding.
- Prefer additive changes over destructive ones when both achieve the goal.

## Budget Awareness
- You have a limited token and turn budget. Work efficiently — every turn counts.
- If you see a [BUDGET WARNING] message, immediately begin wrapping up: summarize progress, document what remains, and call attempt_completion.
- Do NOT waste turns on unnecessary exploration when you already have enough information.
- Do NOT waste turns apologizing, recapping, or narrating what you plan to do. Just do it.

## Completion Protocol
- When done: call attempt_completion with status 'done'. Include a concise summary of what was changed and why.
- When stuck: call attempt_completion with status 'uncertain'. List what you tried, what blocked you, and what you think the next step should be.
- CRITICAL: Before reporting done, verify your work actually achieves the goal. Run the test, check the output, read the result. Do NOT report success based on assumptions.
- You MUST call attempt_completion to signal task end. Never just stop responding.

## After Context Compression
If you see a [COMPRESSED CONTEXT] block, resume directly — no apology, no recap of what you were doing. Pick up where you left off. Break remaining work into smaller pieces if needed.`;

  if (taskType === 'reasoning') {
    return `${common}

## Task Type: Research / Reasoning
Your job is to research, analyze, or answer a question thoroughly.
- Use file_read, shell_exec, or search tools to gather concrete evidence.
- Build your answer from evidence, not assumptions. Cite specific files, line numbers, or command outputs.
- Cross-reference multiple sources when possible — do not rely on a single file read.
- If you cannot find evidence for a claim, say so explicitly rather than guessing.
- Structure your answer clearly: findings first, then analysis, then conclusion.
- Put your full answer in the proposedContent field of attempt_completion.`;
  }

  return `${common}

## Task Type: Code
Your job is to implement, fix, or modify code to accomplish the goal.
- Read target files FIRST to understand existing code, patterns, and conventions.
- Plan your changes before writing — consider blast radius and side effects.
- Prefer minimal, focused changes over large rewrites. A bug fix does not need surrounding code cleaned up.
- After writing, verify: check for syntax errors, run relevant tests if available, read the file back to confirm.
- Match existing code style — indentation, naming conventions, patterns.
- If changing an API or interface, check all callers/importers before modifying.
- Include a concise summary of what you changed and why in proposedContent.`;
}

export function buildInitUserMessage(
  goal: string,
  perception: unknown,
  priorAttempts?: unknown[],
  understanding?: unknown,
  conversationHistory?: Array<{ role: string; content: string; taskId: string; timestamp: number }>,
  failedApproaches?: Array<{ approach: string; oracleVerdict: string }>,
  acceptanceCriteria?: string[],
): string {
  const sections: string[] = [];

  // Conversation history (multi-turn context)
  if (conversationHistory && conversationHistory.length > 0) {
    const turns = conversationHistory.map((entry, i) => {
      const role = entry.role === 'user' ? 'User' : 'Assistant';
      const content = entry.content.length > 2000
        ? `${entry.content.slice(0, 2000)}... (truncated)`
        : entry.content;
      return `[Turn ${i + 1}] ${role}: ${content}`;
    });
    sections.push(`## Conversation History\n${turns.join('\n')}`);
  }

  // Goal — clear and prominent
  sections.push(`## Goal\n${goal}`);

  // Acceptance criteria from task input (if provided separately from understanding)
  if (acceptanceCriteria && acceptanceCriteria.length > 0) {
    const items = acceptanceCriteria.map(c => `- [ ] ${c}`).join('\n');
    sections.push(`## Acceptance Criteria\n${items}`);
  }

  // Failed approaches — explicit "do NOT try" constraints
  if (failedApproaches && failedApproaches.length > 0) {
    const lines = failedApproaches.map((fa, i) =>
      `${i + 1}. ❌ ${fa.approach} — rejected by: ${fa.oracleVerdict}`
    );
    sections.push(`## Failed Approaches (DO NOT repeat)\n${lines.join('\n')}`);
  }

  // Success criteria and semantic context from understanding
  if (understanding && typeof understanding === 'object') {
    const u = understanding as Record<string, unknown>;
    const intent = u.semanticIntent as Record<string, unknown> | undefined;
    if (intent) {
      // Success criteria as a checklist
      if (Array.isArray(intent.successCriteria) && intent.successCriteria.length) {
        const items = (intent.successCriteria as string[]).map(c => `- [ ] ${c}`).join('\n');
        sections.push(`## Success Criteria\nYou are done when ALL of these are met:\n${items}`);
      }

      // Actionable context
      const contextLines: string[] = [];
      if (typeof intent.goalSummary === 'string') contextLines.push(`Summary: ${intent.goalSummary}`);
      if (typeof intent.primaryAction === 'string') contextLines.push(`Action: ${intent.primaryAction} — ${intent.scope ?? ''}`);
      if (typeof intent.rootCause === 'string') contextLines.push(`Root cause hypothesis: ${intent.rootCause}`);
      if (Array.isArray(intent.steps) && intent.steps.length) {
        contextLines.push('Suggested approach:');
        for (const s of intent.steps) contextLines.push(`  1. ${s}`);
      }
      if (Array.isArray(intent.affectedComponents) && intent.affectedComponents.length) {
        contextLines.push(`Key files/components: ${(intent.affectedComponents as string[]).join(', ')}`);
      }

      // Constraints as clear rules
      const constraints = intent.implicitConstraints as Array<{ text: string; polarity: string }> | undefined;
      if (Array.isArray(constraints) && constraints.length) {
        contextLines.push('Constraints:');
        for (const c of constraints) {
          contextLines.push(`  ${c.polarity === 'must-not' ? '❌ MUST NOT' : '✅ MUST'}: ${c.text}`);
        }
      }

      if (contextLines.length) sections.push(`## Context\n${contextLines.join('\n')}`);
    }

    // Resolved entities — show as a quick reference
    const entities = u.resolvedEntities as Array<{ reference: string; resolvedPaths: string[]; resolution: string }> | undefined;
    if (Array.isArray(entities) && entities.length) {
      const entityLines = entities.map(e => `- "${e.reference}" → ${e.resolvedPaths?.join(', ')} (${e.resolution})`);
      sections.push(`## Resolved References\n${entityLines.join('\n')}`);
    }
  }

  // Prior attempts — formatted as lessons, not raw JSON
  if (priorAttempts && priorAttempts.length > 0) {
    const lessons: string[] = [];
    for (let i = 0; i < priorAttempts.length; i++) {
      const attempt = priorAttempts[i] as Record<string, unknown>;
      const outcome = attempt.outcome ?? attempt.status ?? 'unknown';
      const approach = attempt.approach ?? attempt.description ?? 'unspecified';
      const reason = attempt.failureReason ?? attempt.reason ?? attempt.error ?? '';
      lessons.push(`${i + 1}. Approach: ${approach}\n   Result: ${outcome}${reason ? `\n   Lesson: ${reason}` : ''}`);
    }
    sections.push(`## Prior Attempts (DO NOT repeat these)\n${lessons.join('\n')}`);
  }

  // Perception — key data for the agent
  if (perception && typeof perception === 'object') {
    const p = perception as Record<string, unknown>;
    const perceptionLines: string[] = [];

    // Extract useful fields rather than dumping raw JSON
    if (p.taskTarget && typeof p.taskTarget === 'object') {
      const tt = p.taskTarget as Record<string, unknown>;
      if (tt.file) perceptionLines.push(`Target file: ${tt.file}`);
      if (tt.content && typeof tt.content === 'string') {
        const content = tt.content.length > 3000 ? `${tt.content.slice(0, 3000)}\n... (truncated)` : tt.content;
        perceptionLines.push(`Content:\n\`\`\`\n${content}\n\`\`\``);
      }
    }
    if (p.depCone && Array.isArray(p.depCone)) {
      perceptionLines.push(`Dependencies: ${(p.depCone as string[]).slice(0, 20).join(', ')}`);
    }
    if (p.diagnostics && Array.isArray(p.diagnostics) && (p.diagnostics as unknown[]).length > 0) {
      perceptionLines.push(`Diagnostics:\n${JSON.stringify(p.diagnostics, null, 2)}`);
    }
    if (p.worldFacts && Array.isArray(p.worldFacts) && (p.worldFacts as unknown[]).length > 0) {
      const facts = (p.worldFacts as Array<Record<string, unknown>>).slice(0, 10);
      const factLines = facts.map(f => `- ${f.key}: ${f.value} (${f.tier_reliability ?? 'unknown'} reliability)`);
      perceptionLines.push(`Known facts:\n${factLines.join('\n')}`);
    }

    if (perceptionLines.length > 0) {
      sections.push(`## Workspace Context\n${perceptionLines.join('\n\n')}`);
    } else {
      // Fallback to raw JSON if we couldn't extract structured data
      sections.push(`## Workspace Context\n${JSON.stringify(perception, null, 2)}`);
    }
  }

  return sections.join('\n\n');
}

export function estimateHistoryTokens(history: HistoryMessage[]): number {
  return Math.ceil(JSON.stringify(history).length / 3.5);
}

/**
 * Two-tier context compression with landmark preservation.
 *
 * Strategy:
 * - Keep: [0] system, [1] init user — verbatim always (task definition).
 * - Classify middle turns as LANDMARK (tool errors, key findings) vs NON-LANDMARK.
 * - LANDMARK turns get more detail in the summary; non-landmark get one-liners.
 * - Combine into single role: 'user' message (fix #3: NOT 'assistant').
 * - Keep: last 4 turns verbatim (increased from 3 for better continuity).
 */
export function compressHistory(history: HistoryMessage[]): HistoryMessage[] {
  if (history.length <= 6) return history; // too short to compress

  const system = history[0]!;   // system prompt — guaranteed by length check
  const init = history[1]!;     // init user message — guaranteed by length check
  const lastN = history.slice(-4); // preserve last 4 turns (increased from 3)

  const middleTurns = history.slice(2, -4);
  if (middleTurns.length === 0) return history;

  const summaries: string[] = [];
  for (const turn of middleTurns) {
    if ('toolCalls' in turn && turn.toolCalls) {
      const toolNames = turn.toolCalls.map(c => c.tool).join(', ');
      const params = turn.toolCalls.map(c => {
        // Include key params for context (file paths, commands)
        const p = c.parameters;
        if (p.file_path) return `${c.tool}(${p.file_path})`;
        if (p.command) return `${c.tool}("${String(p.command).slice(0, 60)}")`;
        if (p.pattern) return `${c.tool}(pattern="${p.pattern}")`;
        return c.tool;
      }).join(', ');
      summaries.push(`[tools] ${params || toolNames}`);
    } else if (turn.role === 'tool_result') {
      const content = (turn as ToolResultMessage).content ?? '';
      const isError = 'isError' in turn && (turn as ToolResultMessage).isError;
      // LANDMARK: Error results get more space — they contain diagnostic info
      const truncLen = isError ? 600 : 150;
      const truncated = content.slice(0, truncLen);
      summaries.push(`[result${isError ? ' ERROR' : ''}] ${truncated}${content.length > truncLen ? '...' : ''}`);
    } else if (turn.role === 'assistant') {
      const content = (turn as Message).content ?? '';
      // Keep first meaningful sentence, not just 100 chars
      const firstSentence = content.match(/^[^.!?\n]{10,200}[.!?]/)?.[0] ?? content.slice(0, 120);
      summaries.push(`[assistant] ${firstSentence}${content.length > firstSentence.length ? '...' : ''}`);
    } else if (turn.role === 'user') {
      summaries.push(`[user] ${((turn as Message).content ?? '').slice(0, 120)}`);
    }
  }

  const compressedBlock: Message = {
    role: 'user', // FIX #3: MUST be 'user', not 'assistant'
    content: `[COMPRESSED CONTEXT: ${middleTurns.length} turns summarized]\n${summaries.join('\n')}\n\n${CONTEXT_COMPRESSION_CONTINUATION_PROMPT}`,
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
