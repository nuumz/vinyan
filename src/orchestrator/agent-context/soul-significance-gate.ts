/**
 * Soul Significance Gate — determines which task traces warrant LLM reflection.
 *
 * Triggers reflection for ~20% of tasks to keep costs manageable (~$0.001/call).
 * The gate is deterministic and rule-based (A3 compliant).
 *
 * Significance criteria:
 *   1. Failures (always reflect — most learning signal)
 *   2. High prediction error (outcome surprised the self-model)
 *   3. Novel task types (agent has < 3 prior traces for this signature)
 *   4. Rate-limited: max 1 reflection per 5 minutes per agent
 *
 * Source of truth: Living Agent Soul plan
 */
import type { AgentContext } from './types.ts';

/** Minimal trace projection for significance check. */
export interface TraceForSignificance {
  outcome: 'success' | 'failure' | 'timeout' | 'escalated';
  taskTypeSignature?: string;
  predictionError?: { error: { composite: number } };
}

const RATE_LIMIT_MS = 5 * 60 * 1000; // 5 minutes
const PREDICTION_ERROR_THRESHOLD = 0.2;
const NOVEL_TASK_MIN_TRACES = 3;

/** In-memory rate limiter per agent. */
const lastReflection = new Map<string, number>();

/** Check if a trace is significant enough to warrant LLM reflection. */
export function isSignificant(trace: TraceForSignificance, agentContext: AgentContext): boolean {
  // 1. Failures always warrant reflection
  if (trace.outcome === 'failure' || trace.outcome === 'escalated') {
    return true;
  }

  // 2. High prediction error — the outcome surprised the self-model
  if (trace.predictionError) {
    const composite = Math.abs(trace.predictionError.error.composite);
    if (composite > PREDICTION_ERROR_THRESHOLD) {
      return true;
    }
  }

  // 3. Novel task type — agent has few prior traces
  if (trace.taskTypeSignature) {
    const priorEpisodes = agentContext.memory.episodes.filter(
      (ep) => ep.taskSignature === trace.taskTypeSignature,
    );
    if (priorEpisodes.length < NOVEL_TASK_MIN_TRACES) {
      return true;
    }
  }

  return false;
}

/** Check if reflection is rate-limited for this agent. */
export function isRateLimited(agentId: string): boolean {
  const last = lastReflection.get(agentId);
  if (last && Date.now() - last < RATE_LIMIT_MS) {
    return true;
  }
  return false;
}

/** Record that a reflection was performed (for rate limiting). */
export function recordReflection(agentId: string): void {
  lastReflection.set(agentId, Date.now());
}

/** Clear rate limit state (for testing). */
export function clearRateLimits(): void {
  lastReflection.clear();
}
