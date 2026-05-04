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

/**
 * T6 (Yinyan A10 enforcement) thresholds for alignment-score gating.
 * Same constants the bridge uses internally — exported so behavior tests
 * pin against the canonical values rather than re-encoding them.
 */
export const ALIGNMENT_REJECT_THRESHOLD = 0.5;
export const ALIGNMENT_AUDIT_WARNING_CEILING = 0.7;

/**
 * T6 — pluggable alignment scorer. The bridge calls this for each
 * hypothesis when wired and translates the returned score into the
 * downgrade ladder:
 *   - score < 0.5 → emit `passed: false` (oracle: 'goal-alignment')
 *   - 0.5 ≤ score ≤ 0.7 → emit `passed: true` with audit-warning reason
 *   - score > 0.7 → no extra verdict emitted (critic verdict stands)
 *
 * Implementations MUST be deterministic and MUST NOT call an LLM —
 * the bridge stays A1/A3-clean only when this scorer is rule-based
 * (e.g. wraps `goal-alignment-verifier.ts`).
 */
export type AlignmentScorer = (hypothesis: Hypothesis) => number | undefined | Promise<number | undefined>;

export interface KernelPreCheckBridgeOptions {
  critic: CriticEngine;
  task: TaskInput;
  perception: PerceptualHierarchy;
  acceptanceCriteria?: string[];
  /** Optional context threaded to the critic — same shape used by core-loop. */
  criticContext?: CriticContext;
  /**
   * T6 — optional alignment scorer. When wired, the bridge consults it
   * AFTER the critic and emits a separate `oracle: 'goal-alignment'`
   * verdict according to the downgrade ladder above. Critic verdicts and
   * alignment verdicts coexist in the returned array — the selector
   * applies BOTH when filtering hypotheses, so a hypothesis that the
   * critic approved but goal-alignment rejected is still eliminated.
   */
  alignmentScorer?: AlignmentScorer;
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
      } else {
        verdicts.push({
          hypothesisId: h.id,
          passed: verdict === 'approved',
          oracle: 'critic',
          reason: result.reason,
        });
      }

      // T6 — alignment-score downgrade ladder. Independent of the critic
      // verdict: a critic-approved hypothesis can still be eliminated by
      // a goal-alignment score below the reject threshold (and vice
      // versa). Two `PreCheckVerdict` rows for the same hypothesis is
      // intentional — the selector treats `passed: false` from any
      // oracle as a HARD eliminator, so the strictest signal wins (A5
      // tiered trust: deterministic alignment beats heuristic critic).
      if (opts.alignmentScorer) {
        const score = await opts.alignmentScorer(h);
        if (typeof score === 'number' && Number.isFinite(score)) {
          if (score < ALIGNMENT_REJECT_THRESHOLD) {
            verdicts.push({
              hypothesisId: h.id,
              passed: false,
              oracle: 'goal-alignment',
              reason: `alignment score ${score.toFixed(2)} < ${ALIGNMENT_REJECT_THRESHOLD} reject threshold`,
            });
          } else if (score <= ALIGNMENT_AUDIT_WARNING_CEILING) {
            // Audit row — hypothesis survives the gate but the trace
            // records why we noticed. Operators query for these rows to
            // tune the reject threshold.
            verdicts.push({
              hypothesisId: h.id,
              passed: true,
              oracle: 'goal-alignment',
              reason: `alignment score ${score.toFixed(2)} in audit-warning band [${ALIGNMENT_REJECT_THRESHOLD}, ${ALIGNMENT_AUDIT_WARNING_CEILING}]`,
            });
          }
        }
      }
    }
    return verdicts;
  };
}
