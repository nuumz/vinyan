/**
 * Yinyan T3 — Kernel ↔ Critic bridge.
 *
 * Adapts a `CriticEngine` into the `ReasoningKernelDeps.preCheck` shape
 * expected by `runReasoningKernel`. Each generated `Hypothesis` runs
 * through the critic; the resulting ternary verdict maps to a
 * `PreCheckVerdict` row that the deterministic selector consumes:
 *
 *   - `verdict: 'rejected'` → `passed: false` (hypothesis eliminated)
 *   - `verdict: 'approved'` → `passed: true` (hypothesis survives, audit row)
 *   - `verdict: 'abstain'`  → entry omitted entirely
 *     (selector treats missing entry as pass per the contract at
 *     `hypothesis-selector.ts:142` — the hypothesis falls through to the
 *     Wilson-LB / cost tiebreakers like a no-precheck case)
 *
 * `failClosedResult` (from `llm-critic-impl.ts`) maps to `'rejected'` per the
 * pre-existing fail-closed contract — the bridge does NOT specially demote
 * fail-closed to abstain. That preserves the legacy invariant that a
 * provider error during critic review never silently approves the proposal.
 *
 * Axiom anchors:
 *   - A1: critic is a different reasoning engine from the generator (factory
 *     wires `cross-family-guard` separately; this file consumes the resolved
 *     critic without re-checking).
 *   - A2: `'abstain'` is a first-class signal — the bridge OMITS it from
 *     the verdict array rather than fabricating a `passed: true/false`.
 *   - A3: pure mapping function — no LLM call inside the bridge itself; the
 *     critic call is delegated to the supplied `CriticEngine` whose own
 *     determinism contract is the caller's responsibility.
 *   - A8: each emitted verdict carries the critic's reason string so the
 *     audit trail can replay why a hypothesis was eliminated.
 */
import type { Hypothesis } from '../thinking/hypothesis.ts';
import type { PreCheckVerdict } from '../thinking/hypothesis-selector.ts';
import type { PerceptualHierarchy, TaskInput } from '../types.ts';
import type { CriticContext, CriticEngine, WorkerProposal } from './critic-engine.ts';
import { criticVerdictOf } from './critic-engine.ts';

export interface KernelPreCheckBridgeOptions {
  critic: CriticEngine;
  task: TaskInput;
  perception: PerceptualHierarchy;
  acceptanceCriteria?: string[];
  /** Optional context threaded to the critic — same shape used by core-loop. */
  criticContext?: CriticContext;
}

/**
 * Build a `preCheck` function suitable for `ReasoningKernelDeps.preCheck`.
 * The returned closure runs the critic per hypothesis sequentially. Sequential
 * (not parallel) by design: the critic is a pre-check, not a generator —
 * concurrency would multiply provider load without speeding the pipeline up
 * because the kernel must wait for all verdicts before selection.
 */
export function buildKernelPreCheck(opts: KernelPreCheckBridgeOptions) {
  return async (hypotheses: Hypothesis[]): Promise<PreCheckVerdict[]> => {
    const verdicts: PreCheckVerdict[] = [];
    for (const h of hypotheses) {
      const proposal: WorkerProposal = {
        approach: h.approachLabel,
        mutations: [
          {
            // The critic prompt expects a per-file mutation summary. Hypothesis
            // content is opaque text from the kernel's perspective; we surface
            // it under a synthetic "hypothesis" path so the prompt's mutation
            // section renders without claiming a real file edit. The verifier
            // gate downstream still operates on actual mutations from the
            // winning hypothesis once the selector picks one.
            file: `<hypothesis:${h.id}>`,
            content: h.content,
            explanation: `Branch ${h.engineId} (${h.approachLabel})`,
          },
        ],
      };
      const result = await opts.critic.review(
        proposal,
        opts.task,
        opts.perception,
        opts.acceptanceCriteria,
        opts.criticContext,
      );
      const verdict = criticVerdictOf(result);
      if (verdict === 'abstain') {
        // Omit — selector treats missing entry as pass (A2 first-class
        // uncertainty). The hypothesis survives to the Wilson / cost
        // tiebreakers.
        continue;
      }
      verdicts.push({
        hypothesisId: h.id,
        passed: verdict === 'approved',
        oracle: 'critic',
        reason: result.reason,
      });
    }
    return verdicts;
  };
}
