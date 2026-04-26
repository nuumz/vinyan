/**
 * SKILL.md — frontmatter + body schema (Decision 20).
 *
 * The SKILL.md artifact is Vinyan's portable capability format. Frontmatter
 * carries the `agentskills.io`-interop fields plus Vinyan's epistemic
 * extensions (`confidence_tier`, `content_hash`, `expected_error_reduction`,
 * `backtest_id`, `signature`, ...). The body carries authored prose with
 * named H2 sections.
 *
 * These Zod schemas are the single source of truth for SKILL.md shape:
 * parser validates inbound, writer emits, hash canonicalizes.
 */
import { z } from 'zod/v4';
import { CONFIDENCE_TIERS } from '../../core/confidence-tier.ts';

/** Frontmatter YAML block. Ordering is agnostic here — writer canonicalizes. */
export const SkillMdFrontmatterSchema = z
  .object({
    // agentskills.io interop fields
    id: z.string().regex(/^[a-z][a-z0-9-]*(\/[a-z][a-z0-9-]*)?$/),
    name: z.string().min(1),
    version: z.string().regex(/^\d+\.\d+\.\d+$/),
    description: z.string().min(1),
    requires_toolsets: z.array(z.string()).default([]),
    fallback_for_toolsets: z.array(z.string()).default([]),
    platforms: z.array(z.enum(['darwin', 'linux', 'win32'])).optional(),
    author: z.string().optional(),
    license: z.string().optional(),

    // Vinyan epistemic extensions (D20)
    confidence_tier: z.enum(CONFIDENCE_TIERS),
    origin: z.enum(['local', 'a2a', 'mcp', 'hub']).default('local'),
    declared_oracles: z.array(z.string()).default([]),
    expected_prediction_error_reduction: z
      .object({
        baseline_composite_error: z.number().min(0).max(1),
        target_composite_error: z.number().min(0).max(1),
        trial_window: z.number().int().positive(),
      })
      .optional()
      .refine((v) => !v || v.target_composite_error <= v.baseline_composite_error, {
        message: 'target must be <= baseline (reduction, not increase)',
      }),
    falsifiable_by: z.array(z.string()).default([]),
    content_hash: z
      .string()
      .regex(/^sha256:[a-f0-9]{64}$/)
      .optional(),
    dep_cone_hashes: z.record(z.string(), z.string().regex(/^[a-f0-9]{64}$/)).optional(),
    signature: z
      .object({
        algorithm: z.literal('ed25519'),
        signer: z.string(),
        value: z.string(),
      })
      .optional(),
    task_signature: z.string().optional(),

    // Governance state (mirrors cached_skills row)
    status: z.enum(['probation', 'active', 'demoted', 'quarantined', 'retired']).default('probation'),
    promoted_at: z.number().int().optional(),
    backtest_id: z.string().optional(),
  })
  .superRefine((value, ctx) => {
    // Deterministic-tier skills must be content-hash bound (A4 + A5).
    if (value.confidence_tier === 'deterministic' && !value.content_hash) {
      ctx.addIssue({
        code: 'custom',
        path: ['content_hash'],
        message: "confidence_tier 'deterministic' requires content_hash (A4)",
      });
    }
  });

export type SkillMdFrontmatter = z.infer<typeof SkillMdFrontmatterSchema>;

/** Parsed representation of the markdown body. Sections are named by H2 heading. */
export interface SkillMdBody {
  overview: string;
  whenToUse: string;
  preconditions?: string;
  procedure: string;
  /** Whitelisted relative paths parsed from the `## Files` bullet list. */
  files?: string[];
  falsification?: {
    raw: string;
    blocks: Array<{ oracle: string; expect: string }>;
  };
  /**
   * Unknown H2 sections, preserved verbatim for lossless round-trip.
   * Key: the heading text (e.g. 'Examples'); value: raw section body.
   */
  unknownSections?: Record<string, string>;
}

/**
 * Combined record. `contentHash` is computed from canonicalized frontmatter +
 * body; it is NOT part of the on-disk file (drop before canonicalization).
 */
export interface SkillMdRecord {
  frontmatter: SkillMdFrontmatter;
  body: SkillMdBody;
  contentHash: string;
}

/** Parse error with the missing-section name and originating line number. */
export class SkillMdParseError extends Error {
  constructor(
    message: string,
    public readonly line?: number,
    public readonly section?: string,
  ) {
    super(message);
    this.name = 'SkillMdParseError';
  }
}
