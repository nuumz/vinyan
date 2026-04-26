/**
 * Common Sense Substrate — type definitions.
 *
 * Source of truth for the rule shape, three-axis microtheory label, pattern
 * matcher, and abnormality predicate.
 *
 * See `docs/design/commonsense-substrate-system-design.md` §3.3.
 */
import { z } from 'zod/v4';

// ── Three-axis microtheory label ─────────────────────────────────────────
//
// A rule is selected when ALL three axis values match the proposed action's
// extracted triple, with `universal` as wildcard. This avoids the redundancy
// trap Cyc hit with single-axis partitioning while keeping seed corpus small.

export const MicrotheoryLanguageSchema = z.enum([
  'typescript-strict',
  'python-typed',
  'python-untyped',
  'shell-bash',
  'shell-zsh',
  'go',
  'rust',
  'sql',
  'universal',
]);
export type MicrotheoryLanguage = z.infer<typeof MicrotheoryLanguageSchema>;

export const MicrotheoryDomainSchema = z.enum([
  'web-rest',
  'cli',
  'data-pipeline',
  'infra-terraform',
  'git-workflow',
  'filesystem',
  'process',
  'universal',
]);
export type MicrotheoryDomain = z.infer<typeof MicrotheoryDomainSchema>;

export const MicrotheoryActionSchema = z.enum([
  'read-only',
  'mutation-additive',
  'mutation-destructive',
  'tool-invocation',
  'universal',
]);
export type MicrotheoryAction = z.infer<typeof MicrotheoryActionSchema>;

export const MicrotheoryLabelSchema = z.object({
  language: MicrotheoryLanguageSchema,
  domain: MicrotheoryDomainSchema,
  action: MicrotheoryActionSchema,
});
export type MicrotheoryLabel = z.infer<typeof MicrotheoryLabelSchema>;

// ── Pattern matcher ──────────────────────────────────────────────────────
//
// A pattern describes WHICH proposed actions trigger this rule. The
// `kind: 'literal-substring'` form is sufficient for M1 (covers all ~30 seed
// rules ported from hardcoded). Richer matchers (regex, AST shape, glob)
// are deferred to M2/M3 when seed pressure surfaces gaps.

export const PatternSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('literal-substring'),
    target_field: z.enum(['command', 'path', 'verb', 'file_extension']),
    needle: z.string().min(1),
    // Defaults to case-sensitive when omitted — see predicate-eval.ts
    case_sensitive: z.boolean().optional(),
  }),
  z.object({
    kind: z.literal('exact-match'),
    target_field: z.enum(['command', 'path', 'verb', 'file_extension']),
    value: z.string().min(1),
  }),
  z.object({
    kind: z.literal('regex'),
    target_field: z.enum(['command', 'path', 'verb', 'file_extension']),
    pattern: z.string().min(1), // serialized RegExp source; flags via separate field
    flags: z.string().optional(),
  }),
]);
export type Pattern = z.infer<typeof PatternSchema>;

// ── Abnormality predicate ────────────────────────────────────────────────
//
// Reiter-style: rule fires UNLESS the abnormality predicate holds. Same
// kinds as Pattern for symmetry; an undefined predicate means "no abnormal
// case" (the rule is monotonic — rare in commonsense).

export const AbnormalityPredicateSchema = PatternSchema; // same shape
export type AbnormalityPredicate = z.infer<typeof AbnormalityPredicateSchema>;

// ── Rule ─────────────────────────────────────────────────────────────────

export const DefaultOutcomeSchema = z.enum(['allow', 'block', 'needs-confirmation', 'escalate']);
export type DefaultOutcome = z.infer<typeof DefaultOutcomeSchema>;

export const RuleSourceSchema = z.enum([
  'innate', // hardcoded seed
  'configured', // workspace vinyan.json
  'promoted-from-pattern', // sleep-cycle Wilson-CI promotion
]);
export type RuleSource = z.infer<typeof RuleSourceSchema>;

export const CommonSenseRuleSchema = z.object({
  id: z.string().regex(/^[a-f0-9]{64}$/, 'id must be sha256 hex'), // SHA-256 hex
  microtheory: MicrotheoryLabelSchema,
  pattern: PatternSchema,
  default_outcome: DefaultOutcomeSchema,
  abnormality_predicate: AbnormalityPredicateSchema.optional(),
  priority: z.number().int().min(0).max(100).default(50),
  confidence: z.number().min(0.5).max(0.7), // pragmatic tier band
  source: RuleSourceSchema,
  evidence_hash: z.string().optional(),
  promoted_from_pattern_id: z.string().optional(),
  created_at: z.number().int(),
  rationale: z.string().min(1), // human-readable WHY (audit)
  // ── Telemetry (Appendix C #6 — Override-rate demotion) ────────────────
  // Populated/maintained by CommonSenseRegistry; not user-supplied.
  firing_count: z.number().int().min(0).default(0),
  override_count: z.number().int().min(0).default(0),
  last_fired_at: z.number().int().nullable().optional(),
  retired_at: z.number().int().nullable().optional(),
});
export type CommonSenseRule = z.infer<typeof CommonSenseRuleSchema>;

// ── Insert payload (id derived, created_at injected, telemetry maintained by registry) ──

export const CommonSenseRuleInputSchema = CommonSenseRuleSchema.omit({
  id: true,
  created_at: true,
  firing_count: true,
  override_count: true,
  last_fired_at: true,
  retired_at: true,
});
export type CommonSenseRuleInput = z.infer<typeof CommonSenseRuleInputSchema>;

// ── Application context (M2-facing — used to drive microtheory selection) ─

export const ApplicationContextSchema = z.object({
  command: z.string().optional(),
  path: z.string().optional(),
  verb: z.string().optional(),
  file_extension: z.string().optional(),
  microtheory_hint: MicrotheoryLabelSchema.optional(),
});
export type ApplicationContext = z.infer<typeof ApplicationContextSchema>;
