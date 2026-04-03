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
import { partitionTranscript } from './transcript-compactor.ts';
import { manifestFor } from '../tools/tool-manifest.ts';
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
  };
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
): Promise<WorkerLoopResult> {
  const startTime = performance.now();
  const budget = AgentBudgetTracker.fromRouting(routing, deps.contextWindow);
  const overlay = SessionOverlay.create(deps.workspace, input.id);
  const transcript: WorkerTurn[] = [];
  let tokensConsumed = 0;
  let session: IAgentSession | null = null;

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

    session = deps.createSession?.(proc) ?? new AgentSession(proc);

    // Build and send init turn
    const initTurn: OrchestratorTurn = {
      type: 'init',
      taskId: input.id,
      goal: input.goal,
      routingLevel: routing.level as Exclude<typeof routing.level, 0>,
      perception: compressedPerception,
      workingMemory: memory,
      ...(plan ? { plan } : {}),
      budget: budget.toSnapshot(),
      allowedPaths: input.targetFiles ?? [],
      toolManifest: manifestFor(routing),
      ...(memory.priorAttempts?.length ? { priorAttempts: memory.priorAttempts } : {}),
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
        return buildUncertainResult(
          mutations,
          ['Subprocess timeout or crash — no response received'],
          tokensConsumed,
          performance.now() - startTime,
          transcript,
        );
      }

      transcript.push(turn);

      if (turn.type === 'tool_calls') {
        const turnTokens = turn.tokensConsumed ?? estimateTokens(turn);
        budget.recordTurn(turnTokens);
        tokensConsumed += turnTokens;

        // EO #5: Check if transcript compaction is warranted
        const snap = budget.toSnapshot();
        const pressureRatio = tokensConsumed / snap.maxTokens;
        if (pressureRatio > 0.7 && transcript.length > 5) {
          const partition = partitionTranscript(transcript);
          deps.bus?.emit('agent:transcript_compaction', {
            taskId: input.id,
            evidenceTurns: partition.evidenceTurns.filter((t) => t.isEvidence).length,
            narrativeTurns: partition.compactedNarrativeTurns,
            tokensSaved: partition.tokensSaved,
          });
          // NOTE: actual narrative summarization requires LLM call — deferred to future enhancement.
        }

        // Cap tool calls per turn
        const calls = turn.calls.slice(0, maxToolCallsPerTurn);
        const results: ToolResult[] = [];

        // Synthetic errors for dropped calls
        for (let i = maxToolCallsPerTurn; i < turn.calls.length; i++) {
          const dropped = turn.calls[i]!;
          results.push({
            callId: dropped.id,
            tool: dropped.tool,
            status: 'denied',
            error: `Dropped: exceeded maxToolCallsPerTurn (${maxToolCallsPerTurn})`,
            durationMs: 0,
          });
        }

        // Execute allowed calls
        for (const call of calls) {
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

        // Send results back to worker
        await session.send({
          type: 'tool_results',
          turnId: turn.turnId,
          results,
        });
        deps.bus?.emit('agent:turn_complete', {
          taskId: input.id,
          turnId: turn.turnId,
          tokensConsumed,
          turnsRemaining: budget.toSnapshot().maxTurns - transcript.length,
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
