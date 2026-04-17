/**
 * Generate Phase — Step 4 of the Orchestrator lifecycle.
 *
 * Dispatches work to a worker (single-shot, DAG, or agentic loop),
 * applies quality gates, accumulates token budget, and executes
 * read-only tool calls.
 */

import { createContract } from '../../core/agent-contract.ts';
import type { DAGExecutionResult, NodeDispatcher } from '../dag-executor.ts';
import { executeDAG } from '../dag-executor.ts';
import type {
  ExecutionTrace,
  PerceptualHierarchy,
  RoutingDecision,
  SemanticTaskUnderstanding,
  TaskDAG,
  TaskInput,
  TaskResult,
  ToolCall,
  WorkerSelectionResult,
} from '../types.ts';
import type { WorkerLoopResult } from '../agent/agent-loop.ts';
import type { PhaseContext, GenerateResult, WorkerResult, PhaseContinue, PhaseReturn, PhaseRetry, PhaseThrow } from './types.ts';
import { Phase } from './types.ts';

interface GenerateInput {
  routing: RoutingDecision;
  perception: PerceptualHierarchy;
  understanding: SemanticTaskUnderstanding;
  plan: TaskDAG | undefined;
  totalTokensConsumed: number;
  budgetCapMultiplier: number;
  workerSelection?: WorkerSelectionResult;
  lastWorkerSelection?: WorkerSelectionResult;
  retry: number;
}

export async function executeGeneratePhase(
  ctx: PhaseContext,
  gi: GenerateInput,
): Promise<PhaseContinue<GenerateResult> | PhaseReturn | PhaseRetry | PhaseThrow> {
  const { input, deps, startTime, workingMemory, explorationFlag } = ctx;
  const { routing, perception, understanding, plan, workerSelection, lastWorkerSelection, retry } = gi;
  let { totalTokensConsumed } = gi;
  const conversationHistory = ctx.conversationHistory;

  // ── Step 4: GENERATE (dispatch to worker) ────────────────────
  const contract = createContract(input, routing);

  // Crash Recovery: persist checkpoint before dispatch
  try {
    deps.taskCheckpoint?.save({
      taskId: input.id,
      inputJson: JSON.stringify(input),
      routingLevel: routing.level,
      planJson: plan ? JSON.stringify({ nodeCount: plan.nodes.length, isFallback: plan.isFallback }) : null,
      perceptionJson: perception?.taskTarget ? JSON.stringify({ taskTarget: perception.taskTarget.file }) : null,
      attemptCount: retry + 1,
    });
  } catch {
    // Checkpoint failure is non-fatal — proceed without crash protection
  }

  // A6: Approval gate — require human approval for high-risk tasks before dispatch
  const riskThreshold = 0.7;
  if (deps.approvalGate && routing.riskScore !== undefined && routing.riskScore >= riskThreshold) {
    const reason = `Risk score ${routing.riskScore.toFixed(2)} exceeds threshold ${riskThreshold} (L${routing.level})`;
    const decision = await deps.approvalGate.requestApproval(input.id, routing.riskScore, reason);
    if (decision === 'rejected') {
      const rejectedResult: TaskResult = {
        id: input.id,
        status: 'failed',
        mutations: [],
        trace: {
          id: `trace-${input.id}-approval-rejected`,
          taskId: input.id,
          routingLevel: routing.level,
          approach: 'approval-gate',
          outcome: 'failure',
          oracleVerdicts: {},
          tokensConsumed: 0,
          durationMs: 0,
          affectedFiles: [],
          timestamp: Date.now(),
          modelUsed: 'none',
        },
        escalationReason: `Task rejected by approval gate: ${reason}`,
      };
      deps.bus?.emit('task:complete', { result: rejectedResult });
      return Phase.return(rejectedResult);
    }
  }

  deps.bus?.emit('worker:dispatch', { taskId: input.id, routing });
  const dispatchStart = Date.now();
  let workerResult!: WorkerResult;
  let isAgenticResult = false;
  let lastAgentResult: WorkerLoopResult | null = null;
  let dagResult: DAGExecutionResult | null = null;
  let roomId: string | undefined;

  try {
    const hasAgentDeps = !!deps.workerPool.getAgentLoopDeps?.();
    if (routing.level >= 2 && !hasAgentDeps) {
      console.warn('[vinyan] L2+ task but agentLoopDeps unavailable — degraded to single-shot dispatch');
    }
    if (routing.level <= 1 || !hasAgentDeps) {
      // L0-L1 or no agent deps: single-shot or DAG dispatch
      if (plan && !plan.isFallback && plan.nodes.length > 1) {
        // EO #1+#4: Multi-node plan → DAG executor with parallel dispatch
        const memSnapshot = workingMemory.getSnapshot();
        const dispatcher: NodeDispatcher = async (nodeId, node) => {
          const nodeInput: TaskInput = {
            ...input,
            id: `${input.id}-${nodeId}`,
            targetFiles: node.targetFiles.length > 0 ? node.targetFiles : input.targetFiles,
            goal: node.description || input.goal,
          };
          const result = await deps.workerPool.dispatch(nodeInput, perception, memSnapshot, plan, routing, understanding, contract, conversationHistory);
          return {
            nodeId,
            mutations: result.mutations,
            tokensConsumed: result.tokensConsumed,
            durationMs: result.durationMs,
          };
        };
        dagResult = await executeDAG(plan, dispatcher);
        deps.bus?.emit('dag:executed', {
          taskId: input.id,
          nodes: dagResult.results.length,
          parallel: dagResult.usedParallelExecution,
          fileConflicts: dagResult.fileConflicts.length,
        });
        workerResult = {
          mutations: dagResult.results.flatMap((r) =>
            r.mutations.map((m) => ({
              file: m.file,
              content: m.content,
              diff: m.diff ?? '',
              explanation: m.explanation ?? '',
            })),
          ),
          proposedToolCalls: [],
          tokensConsumed: dagResult.totalTokens,
          durationMs: dagResult.totalDurationMs,
        };
      } else {
        // Single-node or fallback: direct dispatch
        workerResult = await deps.workerPool.dispatch(
          input,
          perception,
          workingMemory.getSnapshot(),
          plan,
          routing,
          understanding,
          contract,
          conversationHistory,
        );
      }
    } else {
      // L2+: agentic loop (multi-turn with tools) OR Agent Conversation Room
      const agentLoopDeps = deps.workerPool.getAgentLoopDeps!()!;
      const { runAgentLoop } = await import('../agent/agent-loop.ts');

      // ── ACR (Agent Conversation Room) branch ───────────────────────
      // When the decomposer emitted `collaborationMode: 'room'` AND a
      // RoomDispatcher is wired, route the task through a role-scoped
      // supervisor FSM (drafter → critic → integrator with shared ledger
      // + blackboard). On admission failure or any other room error, we
      // fall through to the existing agentic-loop branch as a safe
      // degrade — the room is strictly additive.
      let roomHandled = false;
      if (plan?.collaborationMode === 'room' && plan.roomContract && deps.roomDispatcher) {
        try {
          const dispatchOutcome = await deps.roomDispatcher.execute({
            parentInput: input,
            perception,
            memory: workingMemory.getSnapshot(),
            plan,
            routing,
            parentContract: contract,
            agentLoopDeps,
            understanding,
            conversationHistory,
            contract: plan.roomContract,
          });
          workerResult = {
            mutations: dispatchOutcome.mutations
              .filter((m) => m.content !== null)
              .map((m) => ({
                file: m.file,
                content: m.content ?? '',
                diff: m.diff,
                explanation: m.explanation,
              })),
            proposedToolCalls: [],
            uncertainties: dispatchOutcome.uncertainties,
            tokensConsumed: dispatchOutcome.tokensConsumed,
            cacheReadTokens: dispatchOutcome.cacheReadTokens,
            cacheCreationTokens: dispatchOutcome.cacheCreationTokens,
            durationMs: dispatchOutcome.durationMs,
            needsUserInput: dispatchOutcome.needsUserInput,
          };
          isAgenticResult = true;
          roomHandled = true;
          roomId = plan.roomContract!.roomId;
        } catch (roomErr) {
          console.warn(`[vinyan] Room dispatch failed, falling back to agentic-loop: ${String(roomErr)}`);
        }
      }

      if (!roomHandled) {
        try {
          lastAgentResult = await runAgentLoop(
            input,
            perception,
            workingMemory.getSnapshot(),
            plan,
            routing,
            agentLoopDeps,
            understanding,
            contract,
            conversationHistory,
          );
        } catch (agentLoopErr) {
          // Fallback: subprocess agent loop failed — degrade to single-shot in-process dispatch
          console.warn(`[vinyan] Agent loop failed, falling back to single-shot dispatch: ${String(agentLoopErr)}`);
          workerResult = await deps.workerPool.dispatch(
            input,
            perception,
            workingMemory.getSnapshot(),
            plan,
            routing,
            understanding,
            contract,
            conversationHistory,
          );
          // Skip agentic result mapping — use single-shot result directly
          lastAgentResult = null;
        }
      }

      if (!roomHandled && lastAgentResult) {
        isAgenticResult = true;
        workerResult = {
          mutations: lastAgentResult.mutations
            .filter((m) => m.content !== null)
            .map((m) => ({
              file: m.file,
              content: m.content ?? '',
              diff: m.diff,
              explanation: m.explanation,
            })),
          proposedToolCalls: lastAgentResult.proposedToolCalls,
          uncertainties: lastAgentResult.uncertainties,
          tokensConsumed: lastAgentResult.tokensConsumed,
          cacheReadTokens: lastAgentResult.cacheReadTokens,
          cacheCreationTokens: lastAgentResult.cacheCreationTokens,
          durationMs: lastAgentResult.durationMs,
          proposedContent: lastAgentResult.proposedContent,
          nonRetryableError: lastAgentResult.nonRetryableError,
          needsUserInput: lastAgentResult.needsUserInput,
        };

        // Agent Conversation: when the agent paused to ask the user, do NOT
        // record a prior-attempt. A user clarification is not a failed approach —
        // it's a collaborative request. Recording it would pollute WorkingMemory
        // and bias future retries against the (not yet answered) approach.
        if (lastAgentResult.isUncertain && !lastAgentResult.needsUserInput) {
          const { buildAgentSessionSummary } = await import('./generate-helpers.ts');
          const summary = buildAgentSessionSummary(lastAgentResult, retry, 'uncertain');
          workingMemory.addPriorAttempt(summary);
        }
      }
    }
    deps.bus?.emit('worker:complete', {
      taskId: input.id,
      output: workerResult as unknown as import('../types.ts').WorkerOutput,
      durationMs: Date.now() - dispatchStart,
    });

    // ── Non-retryable error fast-exit ────────────────────────────
    if (workerResult.nonRetryableError) {
      console.error(`[vinyan] Non-retryable error — aborting: ${workerResult.nonRetryableError}`);
      const failTrace: ExecutionTrace = {
        id: `trace-${input.id}-non-retryable`,
        taskId: input.id,
        workerId: routing.workerId ?? routing.model ?? 'unknown',
        timestamp: Date.now(),
        routingLevel: routing.level,
        approach: 'non-retryable-error',
        oracleVerdicts: {},
        modelUsed: routing.model ?? 'none',
        tokensConsumed: workerResult.tokensConsumed,
        durationMs: Date.now() - startTime,
        outcome: 'failure',
        failureReason: workerResult.nonRetryableError,
        affectedFiles: input.targetFiles ?? [],
      };
      await deps.traceCollector.record(failTrace);
      deps.bus?.emit('trace:record', { trace: failTrace });
      const failResult: TaskResult = {
        id: input.id,
        status: 'failed',
        mutations: [],
        trace: failTrace,
      };
      deps.bus?.emit('task:complete', { result: failResult });
      return Phase.return(failResult);
    }

    // Answer quality gate: reasoning tasks must produce non-empty answer
    if (input.taskType === 'reasoning' && !workerResult.proposedContent?.trim()) {
      workingMemory.recordFailedApproach(`Empty answer at L${routing.level}`, 'answer-quality-gate');
      return Phase.retry();
    }

    // A1 Reasoning quality gate: deterministic post-generation checks.
    if (input.taskType === 'reasoning' && workerResult.proposedContent) {
      // Check 1: Instruction echo detection
      const echoFragments = [
        'do not use json',
        'match the user\'s language',
        'never fabricate facts',
        'answer directly and concisely',
        'code blocks for your answer',
        'produce a concise',
      ];
      const outputPrefix = workerResult.proposedContent.slice(0, 200).toLowerCase();
      const echoCount = echoFragments.filter((f) => outputPrefix.includes(f)).length;
      if (echoCount >= 2) {
        workingMemory.recordFailedApproach(`Instruction echo detected (${echoCount} fragments)`, 'answer-quality-gate');
        return Phase.retry();
      }

      // Check 1b: Hallucinated tool calls at L0-L1
      if (routing.level <= 1) {
        const hallucinationPatterns = [
          '<function_calls>',
          '<invoke name=',
          '<tool_use>',
          '<tool_call>',
          '```tool_code',
        ];
        const contentLower = workerResult.proposedContent.toLowerCase();
        const hasHallucination = hallucinationPatterns.some((p) => contentLower.includes(p));
        if (hasHallucination) {
          workingMemory.recordFailedApproach(
            `Hallucinated tool calls at L${routing.level} (text-only mode has no tools)`,
            'answer-quality-gate',
          );
          return Phase.retry();
        }
      }

      // Check 2: A6 defense-in-depth — strip mutating tool calls from non-mutation domains
      // Exception: tool-needed tasks explicitly require tool execution (e.g. "open Chrome", CLI commands)
      const shouldFilterTools = understanding.taskDomain !== 'code-mutation' && understanding.toolRequirement !== 'tool-needed';
      if (shouldFilterTools && workerResult.proposedToolCalls.length > 0) {
        const { READONLY_TOOLS } = await import('../types.ts');
        workerResult.proposedToolCalls = workerResult.proposedToolCalls.filter(
          (tc) => READONLY_TOOLS.has(tc.tool),
        );
      }
    }

    // G6: Accumulate global token budget
    totalTokensConsumed += workerResult.tokensConsumed;
    const globalBudgetCap = input.budget.maxTokens * gi.budgetCapMultiplier;
    if (totalTokensConsumed > globalBudgetCap) {
      const budgetTrace: ExecutionTrace = {
        id: `trace-${input.id}-budget-exceeded`,
        taskId: input.id,
        workerId: routing.workerId ?? routing.model ?? 'unknown',
        timestamp: Date.now(),
        routingLevel: routing.level,
        approach: 'global-budget-exceeded',
        oracleVerdicts: {},
        modelUsed: routing.model ?? 'none',
        tokensConsumed: totalTokensConsumed,
        durationMs: Date.now() - startTime,
        outcome: 'failure',
        failureReason: `Global token budget exceeded: ${totalTokensConsumed} > ${globalBudgetCap}`,
        affectedFiles: input.targetFiles ?? [],
        workerSelectionAudit: workerSelection ?? lastWorkerSelection,
      };
      await deps.traceCollector.record(budgetTrace);
      deps.bus?.emit('trace:record', { trace: budgetTrace });
      deps.bus?.emit('task:budget-exceeded', {
        taskId: input.id,
        totalTokensConsumed,
        globalCap: globalBudgetCap,
      });
      const budgetResult: TaskResult = {
        id: input.id,
        status: 'failed',
        mutations: [],
        trace: budgetTrace,
      };
      deps.bus?.emit('task:complete', { result: budgetResult });
      return Phase.return(budgetResult);
    }
  } catch (dispatchErr) {
    deps.bus?.emit('worker:error', {
      taskId: input.id,
      error: String(dispatchErr),
      routing,
    });
    const dispatchFailTrace: ExecutionTrace = {
      id: `trace-${input.id}-dispatch-error-${routing.level}-${retry}`,
      taskId: input.id,
      workerId: routing.workerId ?? routing.model ?? 'unknown',
      timestamp: Date.now(),
      routingLevel: routing.level,
      approach: 'dispatch-error',
      oracleVerdicts: {},
      modelUsed: routing.model ?? 'none',
      tokensConsumed: 0,
      durationMs: Date.now() - startTime,
      outcome: 'failure',
      failureReason: `Worker dispatch failed: ${String(dispatchErr)}`,
      affectedFiles: input.targetFiles ?? [],
      workerSelectionAudit: workerSelection ?? lastWorkerSelection,
      exploration: explorationFlag || undefined,
    };
    await deps.traceCollector.record(dispatchFailTrace);
    deps.bus?.emit('trace:record', { trace: dispatchFailTrace });
    return Phase.throw(dispatchErr);
  }

  // ── Step 4½a: EXECUTE read-only tool calls (safe pre-verification) ──
  let mutatingToolCalls: ToolCall[] = [];
  if (deps.toolExecutor && workerResult.proposedToolCalls.length > 0) {
    const toolContext = {
      workspace: deps.workspace ?? process.cwd(),
      allowedPaths: input.targetFiles ?? [],
      routingLevel: routing.level,
    } as import('../tools/tool-interface.ts').ToolContext;

    const { readOnly, mutating } = deps.toolExecutor.partitionBySideEffect(workerResult.proposedToolCalls);
    mutatingToolCalls = mutating;

    if (readOnly.length > 0) {
      const readOnlyResults = await deps.toolExecutor.executeProposedTools(readOnly, toolContext);
      deps.bus?.emit('tools:executed', { taskId: input.id, results: readOnlyResults });
    }
  }

  return Phase.continue({
    workerResult,
    isAgenticResult,
    lastAgentResult,
    dagResult,
    mutatingToolCalls,
    totalTokensConsumed,
    roomId,
  });
}
