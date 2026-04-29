/**
 * Autonomous Skill Creation — shared types (W4 SK4).
 *
 * Closes the A7 learning loop: when observed composite PredictionError drops
 * meaningfully on a cluster of same-signature tasks, draft a SkillMdRecord
 * candidate, run it through Oracle Gate + Critic (A1), and promote into the
 * SkillStore at `'probabilistic'` tier.
 *
 * Authoritative spec: `docs/architecture/decisions.md` Decision 20 — SKILL.md
 * as ECP-Verified Capability Package.
 *
 * Axiom anchors:
 *   A1 — generation (LLM draft) ≠ verification (gate + critic must differ)
 *   A3 — governance path is rule-based (trigger, promotion, demotion)
 *   A7 — learning signal = PredictionError reduction, not success streak
 */

import type { SkillMdRecord } from '../skill-md/index.ts';

// ── Prediction-error window (trigger substrate) ────────────────────────

/**
 * A single closed-out task's PredictionError sample. `compositeError` is
 * pre-blended from Brier/CRPS/quality by the caller — this module does not
 * re-derive it.
 *
 * Shape matches what `prediction_ledger` + `prediction_outcomes` materialize
 * (see `src/db/prediction-ledger-schema.ts`).
 */
export interface PredictionErrorSample {
  readonly taskId: string;
  readonly taskSignature: string;
  /** Composite PredictionError in [0, 1]; lower = more accurate. */
  readonly compositeError: number;
  readonly outcome: 'success' | 'failure' | 'timeout' | 'escalated';
  readonly ts: number;
  /**
   * Phase-8: persona that handled this task. When present, the creator
   * keys windows on (personaId × taskSignature) so different personas
   * accumulate distinct draft windows for the same task family. Optional
   * for backward compatibility — legacy samples that omit it fall into
   * the persona-agnostic window keyed on `taskSignature` alone.
   */
  readonly personaId?: string;
}

/**
 * Phase-8 helper: compose the window key from the persona+signature pair.
 * Centralised so the creator and any future sampler agree on the convention.
 */
export function composeWindowKey(taskSignature: string, personaId?: string): string {
  return personaId ? `${personaId}::${taskSignature}` : taskSignature;
}

/**
 * Snapshot of the rolling window for one task signature — consumed by the
 * creator's state machine and surfaced to observability/TUI.
 */
export interface WindowState {
  readonly taskSignature: string;
  readonly samples: readonly PredictionErrorSample[];
  /** Mean composite error over the most recent `splitHalf` samples. */
  readonly meanRecentError: number;
  /** Mean composite error over the prior `splitHalf` samples. */
  readonly meanPriorError: number;
  /** `meanPriorError - meanRecentError`; positive = sustained improvement. */
  readonly reductionDelta: number;
  readonly successFraction: number;
  /** Wilson lower bound on the success rate across the full window. */
  readonly wilsonLB: number;
  /** `true` iff every `WindowPolicy` threshold is satisfied. Fires the creator. */
  readonly qualifies: boolean;
}

/**
 * Tunable thresholds for the trigger rule. Defaults picked to be conservative:
 * big enough window to avoid streak noise, >=0.15 absolute reduction so we
 * never confuse variance with learning.
 */
export interface WindowPolicy {
  /** Total samples required before we evaluate qualification. */
  readonly windowSize: number;
  /** Samples compared in each half of the drop-detection test. */
  readonly splitHalf: number;
  /** Minimum `meanPriorError - meanRecentError` to qualify. */
  readonly minReductionDelta: number;
  /** Minimum `successes / total` across the window. */
  readonly minSuccessFraction: number;
  /** Minimum Wilson lower-bound on success rate across the window. */
  readonly minWilsonLB: number;
  /** Cooldown between drafts for the same signature, in milliseconds. */
  readonly cooldownMs: number;
}

// ── Draft request/decision envelope ────────────────────────────────────

/**
 * Payload handed to the draft generator. The generator is the ONLY LLM-backed
 * component in the creation path (A3): everything after it is rule-based.
 */
export interface DraftRequest {
  readonly taskSignature: string;
  readonly representativeSamples: readonly PredictionErrorSample[];
  readonly workspaceHint?: { readonly files: readonly string[] };
  /**
   * A7 commitment: the generator stamps this into
   * `expected_prediction_error_reduction` verbatim, so downstream backtesting
   * can compare "promised vs actual" error reduction.
   */
  readonly expectedReduction: {
    readonly baseline: number;
    readonly target: number;
    readonly window: number;
  };
}

/**
 * Terminal state of a `tryDraftFor` call. The ruleId is carried on the
 * promoted arm so the ledger can replay exactly which policy fired.
 */
export type DraftDecision =
  | { kind: 'no-op'; reason: 'window-unqualified' | 'active-skill-exists' | 'cooldown-active' }
  | { kind: 'drafted-rejected'; reason: 'critic' | 'gate' | 'guardrail-scan'; detail: string }
  | { kind: 'drafted-promoted'; skillId: string; tier: 'probabilistic'; ruleId: string };

/**
 * Structural type for the draft generator. Real impl wires an LLM via a
 * ReasoningEngine; the stub in `draft-generator.ts` suffices for tests and
 * the MVP factory wire-in.
 */
export type DraftGenerator = (req: DraftRequest) => Promise<SkillMdRecord>;

/**
 * Observational record for a single window sample. Exported for tests +
 * potential telemetry consumers so the surface here is explicit.
 */
export interface WindowObservation {
  readonly taskSignature: string;
  readonly sample: PredictionErrorSample;
  readonly state: WindowState;
}
