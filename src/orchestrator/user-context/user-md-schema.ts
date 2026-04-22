/**
 * USER.md — dialectic user-model schema.
 *
 * USER.md is Vinyan's counterpart to Hermes' static user-profile file, but
 * with a falsifiable twist (A2, A7): every H2 section carries a
 * `predicted_response` claim about how the user will behave. When observed
 * turns contradict the prediction, the dialectic update rule
 * (see `dialectic.ts`) demotes the section, revises it, or flips it to
 * `type: 'unknown'`.
 *
 * These Zod schemas are the single source of truth for USER.md shape;
 * the parser/writer pair guarantees a canonical round-trip.
 *
 * Axiom anchors:
 *   - A2 First-class uncertainty — unknown-flip is a valid terminal state.
 *   - A5 Tiered trust — each section is tagged with a ConfidenceTier.
 *   - A7 Prediction-error as learning — update rule fires on rolling error.
 */
import { z } from 'zod/v4';

import { CONFIDENCE_TIERS, type ConfidenceTier } from '../../core/confidence-tier.ts';

/**
 * Placeholder prediction string written into a section that the dialectic
 * rule has flipped to `type: 'unknown'`. Keeps the section renderable
 * while clearly signalling that the system no longer commits to a claim.
 */
export const UNKNOWN_PREDICTION_TEXT = '(unknown — user behavior contradicts prior prediction)';

/** Frontmatter YAML block. Version pinned to semver; profile is scope key. */
export const UserMdFrontmatterSchema = z.object({
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
  profile: z.string().default('default'),
});

export type UserMdFrontmatter = z.infer<typeof UserMdFrontmatterSchema>;

/**
 * One user-model slice. `slug` is derived from the H2 heading at parse time
 * (lowercase + hyphen + ASCII-fold); writing USER.md regenerates it so
 * the on-disk file never ships a slug separately.
 */
export const UserMdSectionSchema = z.object({
  slug: z.string().regex(/^[a-z][a-z0-9-]*$/),
  heading: z.string().min(1),
  /** The falsifiable claim about user behavior. Empty means no prediction committed. */
  predictedResponse: z.string(),
  body: z.string(),
  evidenceTier: z.enum(CONFIDENCE_TIERS).default('heuristic'),
  confidence: z.number().min(0).max(1).default(0.7),
  lastRevisedAt: z.number().int().optional(),
});

export type UserMdSection = z.infer<typeof UserMdSectionSchema>;

/** Full parsed record. */
export interface UserMdRecord {
  frontmatter: UserMdFrontmatter;
  sections: UserMdSection[];
}

/** Parse error raised by the parser when USER.md structure is malformed. */
export class UserMdParseError extends Error {
  constructor(
    message: string,
    public readonly line?: number,
  ) {
    super(message);
    this.name = 'UserMdParseError';
  }
}

// ---------------------------------------------------------------------------
// Tier ordering helpers — the dialectic rule demotes one tier at a time
// ---------------------------------------------------------------------------

/**
 * Demotion ladder for sections under rolling prediction-error pressure.
 * `deterministic` cannot be demoted via this rule (would require a content-hash
 * change, not a behavioral contradiction); the rule treats it as `heuristic`
 * for demotion purposes.
 */
const DEMOTION_NEXT: Record<ConfidenceTier, ConfidenceTier> = {
  deterministic: 'heuristic',
  heuristic: 'probabilistic',
  probabilistic: 'speculative',
  // Speculative is the floor — cannot demote further (A5).
  speculative: 'speculative',
};

/** Return the tier one step weaker than `tier`, clamped at speculative. */
export function demoteOneTier(tier: ConfidenceTier): ConfidenceTier {
  return DEMOTION_NEXT[tier];
}

/** True when a tier is already at the demotion floor. */
export function isAtDemotionFloor(tier: ConfidenceTier): boolean {
  return tier === 'speculative';
}
