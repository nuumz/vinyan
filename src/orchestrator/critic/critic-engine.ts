/**
 * CriticEngine — LLM-as-Critic interface (§17.6).
 *
 * Implements semantic verification: a second LLM call reviews the Generator's output
 * for correctness beyond what structural oracles can catch (logic errors, misunderstood
 * requirements, incomplete implementations).
 *
 * A1 compliance: Critic MUST use a different LLM call from the Generator.
 * Same provider is acceptable; same conversation context is NOT.
 *
 * Activation: L2+ routing levels only, after structural oracles pass.
 */
import type { OracleVerdict } from '../../core/types.ts';
import type { PerceptualHierarchy, TaskInput } from '../types.ts';

/** Worker proposal — the output the Critic reviews */
export interface WorkerProposal {
  mutations: Array<{
    file: string;
    content: string;
    diff?: string;
    explanation: string;
  }>;
  approach: string;
}

/** Result of Critic review */
export interface CriticResult {
  approved: boolean;
  reason?: string;
  verdicts: Record<string, OracleVerdict>;
  confidence: number;
  aspects: Array<{
    name: string;
    passed: boolean;
    explanation: string;
  }>;
  tokensUsed: { input: number; output: number };
}

/**
 * Book-integration Wave 5.1: optional context passed alongside the proposal.
 *
 * Replaces the earlier `(task as unknown as { riskScore?: number }).riskScore`
 * cast in both `core-loop.ts` and `DebateRouterCritic`. Implementations that
 * don't care about routing signal can simply ignore this argument — it is
 * optional at every level of the call chain.
 *
 * Fields:
 *   - `riskScore`: the risk-router's output (0..1), used by the debate
 *     router to decide whether to fire the 3-seat debate mode.
 *   - `routingLevel`: the current routing level, for critics that want to
 *     scale their review depth with the routing tier.
 *
 * A3-safe: the context is metadata threaded by the orchestrator, not
 * computed by any LLM in the critic path.
 */
export interface CriticContext {
  riskScore?: number;
  routingLevel?: number;
  /**
   * Accountability slice 4: previous outer-loop iteration's deterministic
   * accountability grade (A/B/C) computed by `DefaultGoalEvaluator`. When
   * present, the critic prompt surfaces it so the reviewer is anchored on
   * what the orchestrator's verifier already concluded — avoiding the
   * "first impression" failure mode where the critic re-approves work
   * that was just rejected for the same reason.
   *
   * A1-safe: this is data threaded between iterations, not a verdict the
   * critic adopts. The critic still produces its own independent review.
   */
  priorAccountabilityGrade?: 'A' | 'B' | 'C';
  /** Blocker categories from the previous iteration's grade (≤ 6, deduped). */
  priorBlockerCategories?: string[];
  /**
   * Slice 4 follow-up: previous iteration's worker self-grade vs. the
   * deterministic grade. When the worker was overconfident (self > eval),
   * the critic prompt surfaces a calibration warning telling the reviewer
   * to be skeptical of self-graded A's lacking strong evidence.
   *
   * A1-safe: data only. The critic still produces its own independent
   * verdict; this just primes scrutiny on the dimension that already
   * failed once.
   */
  priorPredictionError?: {
    selfGrade: 'A' | 'B' | 'C';
    deterministicGrade: 'A' | 'B' | 'C';
    magnitude: 'aligned' | 'minor' | 'severe';
    direction: 'aligned' | 'overconfident' | 'underconfident';
  };
  /**
   * C1: Historical adversary — aggregated failed approaches for the current
   * task signature, surfaced into the critic's user prompt as `[HISTORICAL
   * EVIDENCE]`. Populated by `buildHistoricalAdversaryContext()` in
   * `historical-adversary.ts`. When present and non-empty, the critic is
   * instructed to flag any proposal that repeats a listed approach.
   *
   * A1-safe: data threaded by the orchestrator from the read-only memory
   * surface (`AgentMemoryAPI`); the critic still produces an independent
   * verdict. Off-by-default — orchestrators that do not opt in see no
   * behavior change.
   */
  priorFailedApproaches?: ReadonlyArray<{
    /** Compact descriptor (e.g. "agentic-workflow:llm-reasoning,llm-reasoning"). */
    approach: string;
    /** Discriminator that classified the failure (e.g. "workflow-deadlock"). */
    failureOracle: string;
    /** Times this (approach, failureOracle) appeared in the queried window. */
    occurrences: number;
    /** Most recent observation timestamp — used for recency framing. */
    lastSeenAt: number;
  }>;
  /**
   * C1: aggregate outcome counts for prior traces with the same task
   * signature. Lets the critic anchor on base-rate ("4/12 succeeded last
   * time we tried this") rather than evaluating in isolation. Optional —
   * falls back gracefully when traces are unavailable or the task type
   * has no prior runs.
   */
  priorTraceSummary?: {
    totalAttempts: number;
    successCount: number;
    failureCount: number;
    /** Most common routing level reached across prior attempts (0..3). */
    mostCommonEscalation?: number;
  };
}

/** CriticEngine interface — implemented by LLMCriticImpl */
export interface CriticEngine {
  review(
    proposal: WorkerProposal,
    task: TaskInput,
    perception: PerceptualHierarchy,
    acceptanceCriteria?: string[],
    context?: CriticContext,
  ): Promise<CriticResult>;
  /**
   * Deep-audit #4 (2026-04-15): optional task-completion hook.
   *
   * Critics that maintain per-task state (notably `DebateRouterCritic`
   * via `DebateBudgetGuard`) should release that state when the core
   * loop finishes with a task to prevent unbounded Map growth across
   * a long-running orchestrator process. Critics without per-task
   * state may omit this method.
   *
   * Core-loop calls `criticEngine.clearTask?.(input.id)` in the
   * try/finally wrapper around `executeTask` so the hook fires on
   * every exit path (success, escalation, uncaught error). Safe to
   * call for a task that never invoked `review`.
   */
  clearTask?(taskId: string): void;
}
