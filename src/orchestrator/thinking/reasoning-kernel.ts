/**
 * Yinyan T&R Kernel — single entry point for multi-hypothesis reasoning.
 *
 * Composes the L1 generator (hypothesis-generator.ts) and the L2 selector
 * (hypothesis-selector.ts) behind one async call. Phases call this when
 * `ThinkingConfig.type === 'multi-hypothesis'` and degrade gracefully to
 * the single-shot dispatch when they don't.
 *
 * What lives here vs. elsewhere:
 *   - L3 critic / L4 counterfactual / L5 calibrator are FUTURE additions —
 *     this file leaves named seams (`preCheck`, `history`) so they can be
 *     composed in without changing the public contract.
 *   - The ECP wire protocol is unaffected; the kernel is in-process only.
 *
 * Axiom anchors:
 *   - A1: generator and selector are different objects with non-overlapping
 *     responsibilities; the kernel never asks the same engine to do both.
 *   - A2: when the selector abstains, the kernel returns `type: 'unknown'`
 *     instead of fabricating a winner.
 *   - A3: the kernel itself contains no LLM call — every decision is a
 *     pure function of (hypotheses, pre-checks, history).
 *   - A8: `ReasoningKernelResult.audit` carries a replayable rationale.
 */

import type { GenerationInput, GenerationOutcome, Hypothesis, MultiHypothesisPolicy } from './hypothesis.ts';
import type { HypothesisGenerator } from './hypothesis-generator.ts';
import type {
  ApproachHistoryAdapter,
  HypothesisSelector,
  PreCheckVerdict,
  SelectionVerdict,
} from './hypothesis-selector.ts';
import { DefaultHypothesisSelector } from './hypothesis-selector.ts';

export interface ReasoningKernelDeps {
  generator: HypothesisGenerator;
  selector?: HypothesisSelector;
  /**
   * Optional deterministic oracle pre-check hook. Receives the generated
   * hypotheses; returns one PreCheckVerdict per hypothesis the caller wants
   * to gate. Implementations MUST be pure / synchronous-equivalent and MUST
   * NOT call an LLM (A1 + A3).
   */
  preCheck?: (hypotheses: Hypothesis[]) => Promise<PreCheckVerdict[]> | PreCheckVerdict[];
  /** Optional history adapter for Wilson-LB ranking. */
  history?: ApproachHistoryAdapter;
}

export type ReasoningKernelResult =
  | {
      type: 'select';
      winner: Hypothesis;
      verdict: Extract<SelectionVerdict, { type: 'select' }>;
      generation: GenerationOutcome;
      audit: ReasoningKernelAudit;
    }
  | {
      type: 'unknown';
      reason: string;
      generation: GenerationOutcome;
      audit: ReasoningKernelAudit;
    };

/** Pulled out of `SelectionVerdict` for downstream consumers (selector audit, learning loop). */
export type SelectionElimination = SelectionVerdict['eliminations'][number];

export interface ReasoningKernelAudit {
  /** Counts: useful for benchmarks + dashboard at a glance. */
  branchesAttempted: number;
  branchesAccepted: number;
  branchesRejected: number;
  totalTokens: { input: number; output: number; thinking: number };
  /** Selector rule trace verbatim — empty when generation produced no hypotheses. */
  selectionRationale: string[];
  /** Eliminations recorded by the selector — useful for downstream learning. */
  eliminations: SelectionElimination[];
  /** Wall-clock duration in ms. */
  durationMs: number;
}

/**
 * Pure-orchestration entry point. Call this from a phase or a worker-pool
 * branch when the active ThinkingPolicy asks for multi-hypothesis reasoning.
 */
export async function runReasoningKernel(
  deps: ReasoningKernelDeps,
  generationInput: GenerationInput,
  policy: MultiHypothesisPolicy,
): Promise<ReasoningKernelResult> {
  const start = Date.now();
  const selector = deps.selector ?? new DefaultHypothesisSelector();

  const generation = await deps.generator.generate(generationInput, policy);

  const baseAudit = {
    branchesAttempted: generation.hypotheses.length + generation.rejected.length,
    branchesAccepted: generation.hypotheses.length,
    branchesRejected: generation.rejected.length,
    totalTokens: generation.totalTokens,
  };

  if (generation.hypotheses.length === 0) {
    return {
      type: 'unknown',
      reason: 'generator produced no acceptable hypotheses',
      generation,
      audit: {
        ...baseAudit,
        selectionRationale: [],
        eliminations: [],
        durationMs: Date.now() - start,
      },
    };
  }

  let preChecks: PreCheckVerdict[] | undefined;
  if (deps.preCheck) {
    preChecks = await deps.preCheck(generation.hypotheses);
  }

  const verdict = selector.select({
    hypotheses: generation.hypotheses,
    preChecks,
    history: deps.history,
  });

  const audit: ReasoningKernelAudit = {
    ...baseAudit,
    selectionRationale: verdict.type === 'select' ? verdict.rationale : [],
    eliminations: verdict.eliminations,
    durationMs: Date.now() - start,
  };

  if (verdict.type === 'abstain') {
    return {
      type: 'unknown',
      reason: verdict.reason,
      generation,
      audit,
    };
  }

  return {
    type: 'select',
    winner: verdict.winner,
    verdict,
    generation,
    audit,
  };
}
