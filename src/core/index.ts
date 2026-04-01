export { type BusEventName, createBus, EventBus, type VinyanBus, type VinyanBusEvents } from './bus.ts';
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
export type { SubjectiveOpinion } from './subjective-opinion.ts';
export {
  dogmatic,
  fromScalar,
  isValid,
  isVacuous,
  projectedProbability,
  resolveOpinion,
  SubjectiveOpinionSchema,
  vacuous,
} from './subjective-opinion.ts';

/**
 * Build an OracleVerdict with required ECP fields.
 * EHD C1 fix: 'type' and 'confidence' are now REQUIRED — no silent defaults.
 * Oracles must explicitly declare their epistemic state.
 */
export function buildVerdict(
  fields: import('./types.ts').OracleVerdict,
): import('./types.ts').OracleVerdict {
  return fields;
}
