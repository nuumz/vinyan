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
}
