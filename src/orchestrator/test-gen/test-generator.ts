/**
 * TestGenerator — generative verification interface (§17.7).
 *
 * After code generation, generates targeted test cases for the proposed changes,
 * runs them, and uses failures as a semantic verification signal.
 *
 * A4 compliance: generated test failures produce content-addressed evidence.
 *
 * Activation: L2+ routing levels only, after Critic passes.
 */
import type { Evidence } from '../../core/types.ts';
import type { WorkerProposal } from '../critic/critic-engine.ts';
import type { PerceptualHierarchy } from '../types.ts';

/** Result of test generation and execution */
export interface TestGenResult {
  generatedTests: Array<{
    name: string;
    code: string;
    targetFunction: string;
    category: 'happy-path' | 'edge-case' | 'regression' | 'acceptance';
  }>;
  results: Array<{
    name: string;
    passed: boolean;
    error?: string;
    durationMs: number;
  }>;
  failures: Array<{
    name: string;
    error: string;
    evidence: Evidence;
  }>;
  tokensUsed: { input: number; output: number };
}

/** TestGenerator interface — implemented by LLMTestGenerator */
export interface TestGenerator {
  generateAndRun(proposal: WorkerProposal, perception: PerceptualHierarchy): Promise<TestGenResult>;
}
