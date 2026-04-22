/**
 * User-context module — dialectic user-model (USER.md) + existing interest miner.
 *
 * USER.md is the falsifiable companion to Hermes' static user profile: each
 * section carries a `predicted_response` and is demoted / revised / flipped
 * to `unknown` as observed user turns contradict it (A2 + A7).
 *
 * The existing interest-miner types are re-exported unchanged so downstream
 * imports from `@vinyan/orchestrator/user-context` keep working.
 */

// Dialectic + prediction-error.
export {
  applyDialectic,
  DIALECTIC_DEFAULTS,
  type DialecticCritic,
  type DialecticDeps,
  type DialecticUpdate,
  type SectionObservation,
} from './dialectic.ts';
export { computeSectionDelta, rollingMean } from './prediction-error.ts';
// Existing interest-miner surface — unchanged.
export type {
  KeywordFrequency,
  MineOptions,
  TaskTypeCount,
  UserContextSnapshot,
} from './types.ts';
export { EMPTY_SNAPSHOT, isEmpty } from './types.ts';
export { parseUserMd, slugifyHeading, writeUserMd } from './user-md-parser.ts';
// USER.md schema + parser.
export {
  demoteOneTier,
  isAtDemotionFloor,
  UNKNOWN_PREDICTION_TEXT,
  type UserMdFrontmatter,
  UserMdFrontmatterSchema,
  UserMdParseError,
  type UserMdRecord,
  type UserMdSection,
  UserMdSectionSchema,
} from './user-md-schema.ts';
