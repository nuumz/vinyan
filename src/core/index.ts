export { type BusEventName, createBus, EventBus, type VinyanBus, type VinyanBusEvents } from './bus.ts';
export {
  clampConfidenceToTier,
  CONFIDENCE_TIERS,
  type ConfidenceTier,
  isConfidenceTier,
  isStrongerThan,
  rankOf,
  TIER_CONFIDENCE_CEILING,
  TIER_WEIGHT,
  weakerOf,
} from './confidence-tier.ts';
export type { ConflictReport, FusionInput, SubjectiveOpinion } from './subjective-opinion.ts';
export {
  averagingFusion,
  clampOpinionByTier,
  computeConflictReport,
  cumulativeFusion,
  dogmatic,
  fromScalar,
  fuseAll,
  isVacuous,
  isValid,
  projectedProbability,
  resolveOpinion,
  SubjectiveOpinionSchema,
  temporalDecay,
  vacuous,
  weightedFusion,
} from './subjective-opinion.ts';
export type {
  AbstentionReason,
  Evidence,
  Fact,
  HypothesisTuple,
  OracleAbstention,
  OracleErrorCode,
  OracleResponse,
  OracleVerdict,
  QualityScore,
} from './types.ts';
export { isAbstention } from './types.ts';
export { WriteQueue } from './write-queue.ts';

/**
 * Build an OracleVerdict with required ECP fields.
 * EHD C1 fix: 'type' and 'confidence' are now REQUIRED — no silent defaults.
 * Oracles must explicitly declare their epistemic state.
 */
export function buildVerdict(fields: import('./types.ts').OracleVerdict): import('./types.ts').OracleVerdict {
  return fields;
}
