/**
 * Task Uncertainty Computation — pure function.
 *
 * Computes a 2-component uncertainty signal (planComplexity + taskNovelty)
 * for the 2D routing grid. Deterministic signals weighted higher per A5 (Tiered Trust).
 *
 * Source of truth: docs/design/extensible-thinking-system-design.md §4.3
 * Phase 2.1 uses 2 signals; Phase 3.5 restores full 5-component signal.
 */
import type { TaskUncertaintySignal } from './thinking-policy.ts';

export function computeTaskUncertainty(input: {
  taskInput: {
    targetFiles?: string[];
    constraints?: string[];
  };
  priorTraceCount: number;
}): TaskUncertaintySignal {
  const { taskInput, priorTraceCount } = input;

  // Component 1: Plan complexity — deterministic signal (A5: higher weight)
  // Structural proxy: file count + constraint count
  const fileCount = Math.min(1.0, (taskInput.targetFiles?.length ?? 1) / 20);
  const constraintCount = Math.min(1.0, (taskInput.constraints?.length ?? 0) / 5);
  const planComplexity = fileCount * 0.6 + constraintCount * 0.4;

  // Component 2: Task novelty — heuristic signal (A5: lower weight)
  // First solve = high uncertainty, after 50 traces = mastered
  const taskNovelty = 1.0 - Math.min(1.0, priorTraceCount / 50);

  // Weighted aggregate — deterministic signals weighted higher per A5
  const score = Math.max(0, Math.min(1,
    planComplexity * 0.60 +
    taskNovelty * 0.40,
  ));

  return {
    score,
    components: {
      planComplexity,
      priorTraceCount: Math.min(1.0, priorTraceCount / 50),
    },
    basis: priorTraceCount < 3 ? 'cold-start'
      : priorTraceCount < 50 ? 'novelty-based'
      : 'calibrated',
  };
}
