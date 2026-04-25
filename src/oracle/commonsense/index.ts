/**
 * Common Sense Substrate — public exports.
 *
 * M1: Registry + seeds + types. Oracle wiring (M2) and activation gate (M3)
 * arrive in subsequent slices — see `docs/design/commonsense-substrate-system-design.md`.
 */

export { evaluatePattern } from './predicate-eval.ts';
export type { MicrotheoryQuery } from './registry.ts';
export { CommonSenseRegistry, computeRuleId } from './registry.ts';

export { INNATE_RULES, loadInnateSeed } from './seeds/innate.ts';

export type {
  AbnormalityPredicate,
  ApplicationContext,
  CommonSenseRule,
  CommonSenseRuleInput,
  DefaultOutcome,
  MicrotheoryAction,
  MicrotheoryDomain,
  MicrotheoryLabel,
  MicrotheoryLanguage,
  Pattern,
  RuleSource,
} from './types.ts';

export {
  AbnormalityPredicateSchema,
  ApplicationContextSchema,
  CommonSenseRuleInputSchema,
  CommonSenseRuleSchema,
  DefaultOutcomeSchema,
  MicrotheoryActionSchema,
  MicrotheoryDomainSchema,
  MicrotheoryLabelSchema,
  MicrotheoryLanguageSchema,
  PatternSchema,
  RuleSourceSchema,
} from './types.ts';
