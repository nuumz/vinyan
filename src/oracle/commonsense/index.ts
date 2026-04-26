/**
 * Common Sense Substrate — public exports.
 *
 * M1: Registry + seeds + types. Oracle wiring (M2) and activation gate (M3)
 * arrive in subsequent slices — see `docs/design/commonsense-substrate-system-design.md`.
 */

export { evaluatePattern } from './predicate-eval.ts';
export type { DemotionConfig, DemotionEvaluation, MicrotheoryQuery } from './registry.ts';
export { CommonSenseRegistry, computeRuleId, DEFAULT_DEMOTION_CONFIG } from './registry.ts';

export { classifyMutation } from './mutation-classifier.ts';
export { extractApplicationContext, selectMicrotheory } from './microtheory-selector.ts';

// M4 — Pattern → microtheory inference
export {
  inferAction,
  inferDomain,
  inferLanguage,
  inferMicrotheory,
  inferRuleMatcher,
} from './microtheory-inferer.ts';

export { clearRegistryCache, setDbPathResolver, verify } from './oracle.ts';

// M3 — surprise-driven activation
export {
  ActivationDebouncer,
  DEFAULT_ACTIVATION_CONFIG,
  defaultDebouncer,
  shouldActivate,
} from './activation.ts';
export type { ActivationConfig, ActivationDecision, ActivationInput } from './activation.ts';

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
