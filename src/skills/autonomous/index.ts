/**
 * Autonomous skill creation — public surface (W4 SK4).
 *
 * Observes per-signature PredictionError and, when the rolling window shows
 * sustained reduction, drafts + verifies + promotes a SkillMdRecord into the
 * `probabilistic` tier. This closes the A7 learning loop the paradigm depends
 * on — a system that can codify its own capability gains without operator
 * intervention.
 */

export type {
  DraftDecision,
  DraftGenerator,
  DraftRequest,
  PredictionErrorSample,
  WindowObservation,
  WindowPolicy,
  WindowState,
} from './types.ts';

export { buildWindowState, DEFAULT_WINDOW_POLICY } from './prediction-window.ts';
export { buildStubDraftGenerator } from './draft-generator.ts';
export {
  AUTONOMOUS_DRAFT_RULE_ID,
  AUTONOMOUS_GATE_CONFIDENCE_FLOOR,
  AutonomousSkillCreator,
  type AutonomousSkillCreatorDeps,
} from './creator.ts';
export {
  AUTONOMOUS_MIN_PROBATION_SAMPLES,
  AUTONOMOUS_PROMOTE_RULE_ID,
  AUTONOMOUS_REGRESSION_FACTOR,
  AUTONOMOUS_RETIRE_AFTER_DEMOTIONS,
  type BacktestResult,
  decideAutonomousPromotion,
  type PromotionDecision,
  type PromotionRuleInputs,
} from './promotion.ts';
export type { CachedSkillLike, PredictionLedgerLike, SkillStoreLike } from './store-adapters.ts';
