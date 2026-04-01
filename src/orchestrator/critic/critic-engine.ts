/**
 * CriticEngine — LLM-as-Critic interface stub (§17.6).
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
import type { Evidence, OracleVerdict } from '../../core/types.ts';
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

/** CriticEngine interface — stub for Phase 1B implementation */
export interface CriticEngine {
  review(
    proposal: WorkerProposal,
    task: TaskInput,
    perception: PerceptualHierarchy,
    acceptanceCriteria?: string[],
  ): Promise<CriticResult>;
}
