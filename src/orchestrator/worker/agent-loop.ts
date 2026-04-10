/**
 * Agent Loop — stateless async function that manages a multi-turn agentic session.
 *
 * Spawns an agent-worker-entry subprocess, manages budget/overlay/tools,
 * and returns a WorkerLoopResult compatible with core-loop.ts verification.
 *
 * Source of truth: implementation-plan §6.3, protocol.ts (IPC schemas)
 * Axioms: A3 (deterministic governance), A6 (zero-trust execution)
 */
import type { VinyanBus } from '../../core/bus.ts';
import type { DelegationRequest } from '../protocol.ts';
import type { OrchestratorTurn, WorkerTurn } from '../protocol.ts';
import type {
  AgentSessionSummary,
  PerceptualHierarchy,
  RoutingDecision,
  TaskDAG,
  TaskInput,
  TaskResult,
  ToolCall,
  ToolResult,
  WorkingMemoryState,
} from '../types.ts';
import type { ToolContext } from '../tools/tool-interface.ts';
import type { IAgentSession } from './agent-session.ts';
import { AgentSession, type SubprocessHandle } from './agent-session.ts';
import { AgentBudgetTracker } from './agent-budget.ts';
import { SessionOverlay, type ProposedMutation } from './session-overlay.ts';
import { buildCompactedTranscript, partitionTranscript } from './transcript-compactor.ts';
import { manifestFor } from '../tools/tool-manifest.ts';
import type { AgentContract } from '../../core/agent-contract.ts';
import { authorizeToolCall } from '../../security/tool-authorization.ts';
import { scanToolResult } from '../tools/built-in-tools.ts';
import { type DelegationDecision, DelegationRouter, buildSubTaskInput } from '../delegation-router.ts';

// ── Exported interfaces ──────────────────────────────────────────────

export interface WorkerLoopResult {
  mutations: ProposedMutation[];
  proposedContent?: string;
  uncertainties: string[];
  tokensConsumed: number;
  durationMs: number;
  transcript: WorkerTurn[];
  sessionSummary?: AgentSessionSummary;
  isUncertain: boolean;
  /** Backward compat: core-loop.ts treats WorkerLoopResult like WorkerResult */
  proposedToolCalls: ToolCall[];
  /** When set, indicates a permanent error that should not be retried or escalated. */
  nonRetryableError?: string;
}

export interface AgentLoopDeps {
  workspace: string;
  contextWindow: number;
  agentWorkerEntryPath: string;
  proxySocketPath?: string;
  /** Tool executor for running tools on behalf of the worker */
  toolExecutor: {
    execute(call: ToolCall, context: ToolContext): Promise<ToolResult>;
  };
  /** Guardrails engine for scanning tool results (A6) */
  guardrailsScan?: (input: string) => { blocked: boolean; reason?: string };
  /** Perception compressor */
  compressPerception: (perception: PerceptualHierarchy, contextWindow: number) => PerceptualHierarchy;
  /** EventBus for observability */
  bus?: VinyanBus;
  /** Late-bound task executor for delegation (Phase 6.4) */
  executeTask?: (subInput: TaskInput) => Promise<TaskResult>;
  /** Delegation router for Phase 6.4 */
  delegationRouter?: DelegationRouter;
  /** Injectable session factory for testing */
  createSession?: (proc: SubprocessHandle) => IAgentSession;
  /** @deprecated P1-6: Replaced by deterministic structure-preserve compaction. Kept for backwards compat. */
  compactionLlm?: {
    generate(request: { messages: Array<{ role: string; content: string }>; maxTokens?: number }): Promise<{ content: string; tokensConsumed: number }>;
  };
}

// ── Session Progress Tracker ────────────────────────────────────────

export class SessionProgress {
  filesRead = new Set<string>();
  filesWritten = new Set<string>();
  toolSuccessCount = 0;
  toolFailureCount = 0;
  consecutiveFailures = 0;
  turnsWithoutProgress = 0;
  private lastProgressTurn = 0;

  recordToolResult(toolName: string, isError: boolean, output?: string): void {
    if (isError) {
      this.toolFailureCount++;
      this.consecutiveFailures++;
    } else {
      this.toolSuccessCount++;
      this.consecutiveFailures = 0;
    }

    // Track file operations
    if (!isError && output) {
      if (toolName === 'file_read' || toolName === 'search_files' || toolName === 'list_directory') {
        // Extract path from output if possible
        const pathMatch = output.match(/^(?:Reading|Searching|Listing)\s+(.+)/);
        if (pathMatch) this.filesRead.add(pathMatch[1]!);
      } else if (toolName === 'file_write' || toolName === 'file_patch') {
        const pathMatch = output.match(/^(?:Wrote|Patched)\s+(.+)/);
        if (pathMatch) this.filesWritten.add(pathMatch[1]!);
      }
    }
  }

  recordTurn(hadToolCalls: boolean): void {
    if (hadToolCalls && this.consecutiveFailures === 0) {
      this.turnsWithoutProgress = 0;
      this.lastProgressTurn = Date.now();
    } else {
      this.turnsWithoutProgress++;
    }
  }

  /** Generate a system hint based on current progress state. */
  getSystemHint(budgetRatio: number, turnsRemaining: number): string | null {
    const hints: string[] = [];

    // Budget pressure
    if (budgetRatio >= 0.85) {
      hints.push('[BUDGET WARNING] You have used 85%+ of your budget. Wrap up NOW — summarize your progress and call attempt_completion.');
    } else if (budgetRatio >= 0.70) {
      hints.push('[BUDGET NOTICE] You have used 70%+ of your budget. Start wrapping up — focus only on essential remaining work.');
    }

    // Turn limit pressure
    if (turnsRemaining <= 2) {
      hints.push(`[TURNS WARNING] Only ${turnsRemaining} turn(s) remaining. Finalize your work and call attempt_completion.`);
    }

    // Consecutive failures (lowered from 3 — burns fewer turns on dead ends)
    if (this.consecutiveFailures >= 2) {
      hints.push(`[GUIDANCE] ${this.consecutiveFailures} consecutive tool failures. Step back and try a different approach. Before editing a file, ALWAYS read it first to understand its current content and structure.`);
    }

    // Stall detection (lowered from 3 — earlier intervention)
    if (this.turnsWithoutProgress >= 2) {
      hints.push(`[STALL WARNING] No progress detected for ${this.turnsWithoutProgress} turns. Either make progress or call attempt_completion with status 'uncertain'.`);
    }

    return hints.length > 0 ? hints.join('\n') : null;
  }
}

// ── Helpers ──────────────────────────────────────────────────────────

/** Fallback token estimation when worker doesn't report tokensConsumed */
function estimateTokens(turn: WorkerTurn): number {
  return Math.ceil(JSON.stringify(turn).length / 3.5);
}

function buildUncertainResult(
  mutations: ProposedMutation[],
  uncertainties: string[],
  tokensConsumed: number,
  durationMs: number,
  transcript: WorkerTurn[],
  proposedContent?: string,
  nonRetryableError?: string,
): WorkerLoopResult {
  return {
    mutations,
    proposedContent,
    uncertainties,
    tokensConsumed,
    durationMs: Math.round(durationMs),
    transcript,
    isUncertain: true,
    proposedToolCalls: [],
    nonRetryableError,
  };
}

/** Detect permanent errors (auth, config) from uncertainty messages. */
const NON_RETRYABLE_PATTERNS = [
  /\b40[13]\b/,          // 401 Unauthorized, 403 Forbidden
  /invalid.api.key/i,
  /user not found/i,
  /authentication/i,
  /permission denied/i,
];

function detectNonRetryableError(uncertainties: string[]): string | undefined {
  const joined = uncertainties.join(' ');
  return NON_RETRYABLE_PATTERNS.some(p => p.test(joined)) ? joined : undefined;
}

// ── Delegation handler (Phase 6.4) ───────────────────────────────────

async function handleDelegation(
  request: DelegationRequest,
  parent: TaskInput,
  budget: AgentBudgetTracker,
  routing: RoutingDecision,
  deps: AgentLoopDeps,
): Promise<ToolResult> {
  const decision = deps.delegationRouter!.canDelegate(request, budget, parent);
  if (!decision.allowed) {
    return {
      callId: '',
      tool: 'delegate_task',
      status: 'denied',
      output: `Delegation denied: ${decision.reason}`,
      durationMs: 0,
    };
  }

  const reserved = decision.allocatedTokens;
  const childBudget = budget.deriveChildBudget(reserved);
  const subInput = buildSubTaskInput(request, parent, routing, childBudget);

  const startTime = performance.now();
  try {
    const childResult = await deps.executeTask!(subInput);

    // Refund unused delegation tokens (fix #7)
    const actualConsumed = (childResult as any).tokensUsed
      ? (childResult as any).tokensUsed.input + (childResult as any).tokensUsed.output
      : 0;
    budget.returnUnusedDelegation(reserved, actualConsumed);

    deps.bus?.emit('delegation:done', {
      parentTaskId: parent.id,
      childTaskId: subInput.id,
      status: childResult.status,
      tokensUsed: actualConsumed,
    });

    return {
      callId: '',
      tool: 'delegate_task',
      status: childResult.status === 'completed' ? 'success' : 'error',
      output: JSON.stringify({
        childTaskId: subInput.id,
        status: childResult.status,
        mutations: childResult.mutations?.length ?? 0,
      }),
      durationMs: Math.round(performance.now() - startTime),
    };
  } catch (err) {
    budget.returnUnusedDelegation(reserved, 0);
    return {
      callId: '',
      tool: 'delegate_task',
      status: 'error',
      error: `Delegation failed: ${err instanceof Error ? err.message : String(err)}`,
      durationMs: Math.round(performance.now() - startTime),
    };
  }
}

// ── Main loop ────────────────────────────────────────────────────────

export async function runAgentLoop(
  input: TaskInput,
  perception: PerceptualHierarchy,
  memory: WorkingMemoryState,
  plan: TaskDAG | undefined,
  routing: RoutingDecision,
  deps: AgentLoopDeps,
  understanding?: import('../types.ts').TaskUnderstanding,
  contract?: AgentContract,
  conversationHistory?: import('../types.ts').ConversationEntry[],
): Promise<WorkerLoopResult> {
  const startTime = performance.now();
  // K1.2: Use contract-based budget when available (A3: immutable contract governs execution)
  const budget = contract
    ? AgentBudgetTracker.fromContract(contract, deps.contextWindow)
    : AgentBudgetTracker.fromRouting(routing, deps.contextWindow);
  const overlay = SessionOverlay.create(deps.workspace, input.id);
  let transcript: WorkerTurn[] = [];
  let tokensConsumed = 0;
  let contractViolations = 0;
  let session: IAgentSession | null = null;
  const progress = new SessionProgress();

  const toolContext: ToolContext = {
    routingLevel: routing.level,
    allowedPaths: input.targetFiles ?? [],
    workspace: deps.workspace,
    overlayDir: overlay.dir,
    onDelegate:
      routing.level >= 2 && deps.delegationRouter && deps.executeTask
        ? (params: any) => handleDelegation(params as DelegationRequest, input, budget, routing, deps)
        : undefined,
  };

  try {
    // Compress perception before sending (fix #5)
    const compressedPerception = deps.compressPerception(perception, budget.toSnapshot().contextWindow);

    // Spawn subprocess
    const proc = Bun.spawn(['bun', 'run', deps.agentWorkerEntryPath], {
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
      env: {
        ...process.env,
        VINYAN_ROUTING_LEVEL: String(routing.level),
        VINYAN_MODEL: routing.model ?? '',
        VINYAN_ORCHESTRATOR_PID: String(process.pid),
        ...(deps.proxySocketPath ? { VINYAN_PROXY_SOCKET: deps.proxySocketPath } : {}),
      },
    }) as unknown as SubprocessHandle;

    // Drain stderr in background for diagnostics — surface worker errors to orchestrator
    const stderrChunks: string[] = [];
    const stderrDecoder = new TextDecoder();
    const stderrReader = (proc as any).stderr?.getReader?.();
    if (stderrReader) {
      (async () => {
        try {
          while (true) {
            const { done, value } = await stderrReader.read();
            if (done) break;
            const text = stderrDecoder.decode(value, { stream: true });
            stderrChunks.push(text);
            // Forward worker stderr to orchestrator stderr for visibility
            process.stderr.write(`[worker:${input.id}] ${text}`);
          }
        } catch { /* reader closed */ }
      })();
    }

    session = deps.createSession?.(proc) ?? new AgentSession(proc);

    // Build and send init turn
    const initTurn: OrchestratorTurn = {
      type: 'init',
      taskId: input.id,
      goal: input.goal,
      taskType: input.taskType ?? 'code',
      routingLevel: routing.level as Exclude<typeof routing.level, 0>,
      perception: compressedPerception,
      workingMemory: memory,
      ...(plan ? { plan } : {}),
      budget: budget.toSnapshot(),
      allowedPaths: input.targetFiles ?? [],
      toolManifest: manifestFor(routing),
      ...(memory.priorAttempts?.length ? { priorAttempts: memory.priorAttempts } : {}),
      ...(memory.failedApproaches?.length ? { failedApproaches: memory.failedApproaches } : {}),
      ...(input.acceptanceCriteria?.length ? { acceptanceCriteria: input.acceptanceCriteria } : {}),
      ...(understanding ? { understanding } : {}),
      ...(conversationHistory?.length ? { conversationHistory } : {}),
    };
    await session.send(initTurn);

    deps.bus?.emit('worker:dispatch', { taskId: input.id, routing });
    deps.bus?.emit('agent:session_start', {
      taskId: input.id,
      routingLevel: routing.level,
      budget: budget.toSnapshot(),
    });

    // Agent loop: process worker turns until done, uncertain, or budget exhausted
    const maxToolCallsPerTurn = budget.toSnapshot().maxToolCallsPerTurn;

    while (budget.canContinue()) {
      const turn = await session.receive(budget.remainingMs());

      // Subprocess crash or timeout — treat as uncertain
      if (turn === null) {
        const mutations = overlay.computeDiff();
        const stderrOutput = stderrChunks.join('').trim();
        const reason = stderrOutput
          ? `Subprocess error — ${stderrOutput.slice(0, 500)}`
          : 'Subprocess timeout or crash — no response received';
        return buildUncertainResult(
          mutations,
          [reason],
          tokensConsumed,
          performance.now() - startTime,
          transcript,
          undefined,
          detectNonRetryableError([reason]),
        );
      }

      transcript.push(turn);

      if (turn.type === 'tool_calls') {
        const turnTokens = turn.tokensConsumed ?? estimateTokens(turn);
        budget.recordTurn(turnTokens);
        tokensConsumed += turnTokens;

        // EO #5: Check if transcript compaction is warranted (lowered from 0.7 — preserves context earlier)
        const snap = budget.toSnapshot();
        const pressureRatio = tokensConsumed / snap.maxTokens;
        if (pressureRatio > 0.5 && transcript.length > 5) {
          const partition = partitionTranscript(transcript);
          deps.bus?.emit('agent:transcript_compaction', {
            taskId: input.id,
            evidenceTurns: partition.evidenceTurns.filter((t) => t.isEvidence).length,
            narrativeTurns: partition.compactedNarrativeTurns,
            tokensSaved: partition.tokensSaved,
          });

          // Structure-preserve compaction: keep evidence, replace narrative with metadata
          if (partition.compactedNarrativeTurns > 2) {
            const summary = `[Compacted: ${partition.compactedNarrativeTurns} narrative turns removed, ~${partition.tokensSaved} tokens saved. Evidence turns preserved.]`;
            transcript = buildCompactedTranscript(transcript, summary) as typeof transcript;
          }
        }

        // Cap tool calls: per-turn limit AND session-level limit (§5: 0/0/20/50)
        const sessionRemaining = budget.remainingToolCalls;
        const effectiveLimit = Math.min(maxToolCallsPerTurn, sessionRemaining);
        const calls = turn.calls.slice(0, effectiveLimit);
        const results: ToolResult[] = [];

        // Synthetic errors for dropped calls (per-turn or session limit)
        for (let i = effectiveLimit; i < turn.calls.length; i++) {
          const dropped = turn.calls[i]!;
          const reason = i >= maxToolCallsPerTurn
            ? `Dropped: exceeded maxToolCallsPerTurn (${maxToolCallsPerTurn})`
            : `Dropped: session tool call limit reached (${budget.remainingToolCalls} remaining)`;
          results.push({
            callId: dropped.id,
            tool: dropped.tool,
            status: 'denied',
            error: reason,
            durationMs: 0,
          });
        }

        // Track session-level usage
        budget.recordToolCalls(calls.length);

        // Execute allowed calls
        for (const call of calls) {
          // K1.3: Capability-scoped tool authorization (A6 zero-trust)
          if (contract) {
            const auth = authorizeToolCall(contract, call.tool, call.parameters ?? {});
            if (!auth.authorized) {
              contractViolations++;
              results.push({
                callId: call.id,
                tool: call.tool,
                status: 'error',
                error: auth.violation ?? `Capability denied for ${call.tool}`,
                durationMs: 0,
              });
              deps.bus?.emit('agent:tool_denied', {
                taskId: input.id,
                toolName: call.tool,
                violation: auth.violation,
              });
              // Violation policy: kill immediately or after exceeding tolerance
              if (contract.onViolation === 'kill' || contractViolations > contract.violationTolerance) {
                deps.bus?.emit('agent:contract_violation', {
                  taskId: input.id,
                  violations: contractViolations,
                  policy: contract.onViolation,
                });
                break;
              }
              continue;
            }
          }
          const toolStart = performance.now();
          let result = await deps.toolExecutor.execute(call, toolContext);
          // Guardrails scan on every tool result (A6)
          result = scanToolResult(result, deps.guardrailsScan);
          results.push(result);
          deps.bus?.emit('agent:tool_executed', {
            taskId: input.id,
            turnId: turn.turnId,
            toolName: call.tool,
            durationMs: Math.round(performance.now() - toolStart),
            isError: result.status !== 'success',
          });
        }

        // K1.3: Kill session if contract violation policy triggered
        if (contract && contractViolations > 0) {
          const shouldKill = contract.onViolation === 'kill' || contractViolations > contract.violationTolerance;
          if (shouldKill) {
            return buildUncertainResult(
              overlay.computeDiff(),
              [`Contract violation: ${contractViolations} unauthorized tool call(s)`],
              tokensConsumed,
              Math.round(performance.now() - startTime),
              transcript,
              undefined,
              `Contract violation: session killed (policy=${contract.onViolation}, violations=${contractViolations}/${contract.violationTolerance})`,
            );
          }
        }

        // Track progress from tool results
        for (const r of results) {
          progress.recordToolResult(r.tool, r.status !== 'success', typeof r.output === 'string' ? r.output : undefined);
        }
        progress.recordTurn(results.length > 0);

        // Emit stall event when detected
        if (progress.turnsWithoutProgress > 3) {
          deps.bus?.emit('agent:turn_complete', {
            taskId: input.id,
            turnId: turn.turnId,
            tokensConsumed,
            turnsRemaining: budget.toSnapshot().maxTurns - transcript.length,
          });
        }

        // Inject system hints into the last tool result (budget pressure, stalls, guidance)
        const budgetSnap = budget.toSnapshot();
        const budgetRatio = tokensConsumed / budgetSnap.maxTokens;
        const turnsRemaining = budgetSnap.maxTurns - transcript.length;
        const hint = progress.getSystemHint(budgetRatio, turnsRemaining);

        const finalResults = [...results];
        if (hint && finalResults.length > 0) {
          const lastResult = finalResults[finalResults.length - 1]!;
          const existingOutput = typeof lastResult.output === 'string' ? lastResult.output : JSON.stringify(lastResult.output ?? '');
          finalResults[finalResults.length - 1] = {
            ...lastResult,
            output: `${existingOutput}\n\n${hint}`,
          };
        }

        // Send results back to worker
        await session.send({
          type: 'tool_results',
          turnId: turn.turnId,
          results: finalResults,
        });
        deps.bus?.emit('agent:turn_complete', {
          taskId: input.id,
          turnId: turn.turnId,
          tokensConsumed,
          turnsRemaining,
        });
      } else if (turn.type === 'done') {
        const turnTokens = turn.tokensConsumed ?? estimateTokens(turn);
        budget.recordTurn(turnTokens);
        tokensConsumed += turnTokens;

        const mutations = overlay.computeDiff();
        await session.drainAndClose(); // fix #1: drainAndClose, not close('completed')

        const durationMs = Math.round(performance.now() - startTime);
        deps.bus?.emit('agent:session_end', {
          taskId: input.id,
          outcome: 'completed',
          tokensConsumed,
          turnsUsed: transcript.length,
          durationMs,
        });

        return {
          mutations,
          proposedContent: turn.proposedContent,
          uncertainties: [],
          tokensConsumed,
          durationMs,
          transcript,
          isUncertain: false,
          proposedToolCalls: [],
        };
      } else if (turn.type === 'uncertain') {
        const turnTokens = turn.tokensConsumed ?? estimateTokens(turn);
        budget.recordTurn(turnTokens);
        tokensConsumed += turnTokens;

        const mutations = overlay.computeDiff();
        await session.drainAndClose(); // fix #1: drainAndClose for uncertain too

        deps.bus?.emit('agent:session_end', {
          taskId: input.id,
          outcome: 'uncertain',
          tokensConsumed,
          turnsUsed: transcript.length,
          durationMs: Math.round(performance.now() - startTime),
        });

        return buildUncertainResult(
          mutations,
          turn.uncertainties,
          tokensConsumed,
          performance.now() - startTime,
          transcript,
          undefined,
          detectNonRetryableError(turn.uncertainties),
        );
      }
    }

    // Budget exhausted — terminate session
    await session.close('budget_exceeded');

    deps.bus?.emit('agent:session_end', {
      taskId: input.id,
      outcome: 'budget_exceeded',
      tokensConsumed,
      turnsUsed: transcript.length,
      durationMs: Math.round(performance.now() - startTime),
    });

    const mutations = overlay.computeDiff();
    return buildUncertainResult(
      mutations,
      ['Agent budget exhausted'],
      tokensConsumed,
      performance.now() - startTime,
      transcript,
    );
  } finally {
    // fix #4: always cleanup overlay
    overlay.cleanup();
  }
}
