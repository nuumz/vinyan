/**
 * Creative-Clarification Gate — Phase D+E.
 *
 * When the intent resolver picks `agentic-workflow` for a long-form creative
 * goal (novel, webtoon, article, screenplay, video content) AND the session
 * has no prior turns, we pause and emit structured clarification questions
 * (genre / audience / tone / length / platform) so the user can anchor the
 * workflow before the planner burns tokens on a poorly-specified draft.
 *
 * A3 note: the gate is pure rule-based — no LLM, no pattern-match on intent.
 * It only composes deterministic helpers (`inferCreativeDomain`,
 * `buildClarificationSet`) and emits via the bus. Callers decide what to do
 * with the returned `TaskResult` (core-loop returns it; tests assert it).
 */

import type { VinyanBus } from '../core/bus.ts';
import type { SessionManager } from '../api/session-manager.ts';
import type { TraceCollector } from './core-loop.ts';
import type { ExecutionTrace, RoutingDecision, TaskInput, TaskResult } from './types.ts';
import {
  buildClarificationSet,
  inferCreativeDomain,
} from './understanding/clarification-templates.ts';

/**
 * Deps surface kept deliberately narrow so the gate can be unit-tested with
 * lightweight stubs instead of a full OrchestratorDeps.
 */
export interface CreativeClarificationGateDeps {
  bus?: VinyanBus;
  sessionManager?: Pick<SessionManager, 'getTurnsHistory'>;
  traceCollector: Pick<TraceCollector, 'record'>;
}

/**
 * Run the gate. Returns a fully-formed `TaskResult` with `status: 'input-required'`
 * when the gate fires; returns `null` otherwise so callers fall through to the
 * regular dispatch path.
 */
export async function maybeEmitCreativeClarificationGate(
  input: TaskInput,
  routing: RoutingDecision,
  deps: CreativeClarificationGateDeps,
): Promise<TaskResult | null> {
  const creativeDomain = inferCreativeDomain(input.goal);
  if (creativeDomain === 'generic') return null;

  if (hasPriorSessionTurns(input.sessionId, deps.sessionManager)) return null;

  const structuredQuestions = buildClarificationSet({ creativeDomain });
  if (structuredQuestions.length === 0) return null;

  const stringQuestions = structuredQuestions.map((q) => q.prompt);

  const trace: ExecutionTrace = {
    id: `trace-${input.id}-creative-clarify`,
    taskId: input.id,
    sessionId: input.sessionId,
    workerId: 'orchestrator',
    timestamp: Date.now(),
    routingLevel: routing.level,
    approach: 'creative-clarification',
    approachDescription: `Fresh ${creativeDomain} creative task — prompting user for genre/audience/tone/length/platform before dispatch.`,
    oracleVerdicts: {},
    modelUsed: 'none',
    tokensConsumed: 0,
    durationMs: 0,
    outcome: 'success',
    affectedFiles: input.targetFiles ?? [],
  };
  await deps.traceCollector.record(trace);
  deps.bus?.emit('trace:record', { trace });
  deps.bus?.emit('agent:clarification_requested', {
    taskId: input.id,
    sessionId: input.sessionId,
    questions: stringQuestions,
    structuredQuestions,
    routingLevel: routing.level,
    source: 'orchestrator',
  });

  const result: TaskResult = {
    id: input.id,
    status: 'input-required',
    mutations: [],
    trace,
    clarificationNeeded: stringQuestions,
  };
  deps.bus?.emit('task:complete', { result });
  return result;
}

function hasPriorSessionTurns(
  sessionId: string | undefined,
  sessionManager: CreativeClarificationGateDeps['sessionManager'],
): boolean {
  if (!sessionId || !sessionManager) return false;
  try {
    const turns = sessionManager.getTurnsHistory(sessionId, 1);
    return turns.length > 0;
  } catch {
    return false;
  }
}
