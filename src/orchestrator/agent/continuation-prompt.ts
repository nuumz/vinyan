/**
 * Continuation Prompt Builder — Wave 4. Builds the targeted next-turn prompt
 * for a continued agent-loop session. Keeps the existing transcript intact —
 * the continuation appends rather than restarts.
 *
 * A1: this module only shapes the prompt text. Acceptance/rejection of the
 *     agent's output after continuation is performed by completion-gate.ts.
 */
import type { GoalBlocker } from '../goal-satisfaction/goal-evaluator.ts';

export interface ContinuationContext {
  goal: string;
  /** Goal-satisfaction blockers from the most recent evaluator run. */
  blockers: GoalBlocker[];
  /** Names of oracles that failed in the most recent attempt. */
  failedOracles: string[];
  /** 1-based continuation turn number (turn 1 = first continuation). */
  attemptNumber: number;
  /** Hard ceiling the orchestrator will enforce. */
  maxAttempts: number;
}

export function buildContinuationPrompt(ctx: ContinuationContext): string {
  const parts: string[] = [];
  parts.push(
    `[CONTINUATION ${ctx.attemptNumber}/${ctx.maxAttempts}] Your previous attempt_completion was reviewed but the goal is not yet satisfied. Continue — DO NOT restart. Extend your previous work to close the gap.`,
  );

  parts.push(`Original goal: ${ctx.goal}`);

  if (ctx.blockers.length > 0) {
    parts.push('Unresolved blockers:');
    for (const b of ctx.blockers) {
      const tag = b.resolvable ? '' : ' [non-resolvable]';
      parts.push(`  - [${b.category}]${tag} ${b.detail}`);
    }
  }

  if (ctx.failedOracles.length > 0) {
    parts.push(`Oracles that rejected the previous attempt: ${ctx.failedOracles.join(', ')}`);
  }

  parts.push('Address the blockers directly. Reuse anything you already wrote — do not re-read files you already have in context.');

  return parts.join('\n');
}
