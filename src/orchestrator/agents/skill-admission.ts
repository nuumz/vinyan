/**
 * Skill admission policy — Phase-B gate that prevents persona drift.
 *
 * Sits in front of the Wilson-LB statistical promotion gate in
 * `proposeAcquiredToBoundPromotions`. A `researcher` persona that has used
 * a `marketing-copy-write` skill enough to clear the Wilson floor would
 * still get the skill promoted to `bound` today; this policy refuses such
 * promotions because the skill's tags do not overlap the persona's
 * declared `acquirableSkillTags` namespace.
 *
 * Rule-based (A3 governance), no LLM in the path. Reuses the existing
 * `matchesAcquirableTags` glob matcher that already gates *runtime
 * acquisition* (`local-hub-acquirer.ts:191`) — this gate covers the
 * complementary *persistence* step that survives across sessions.
 *
 * The matcher returns boolean (any pattern matches any tag); we additionally
 * compute an overlap ratio for audit + future strict mode tuning. The ratio
 * is NOT consulted by the gate today (parameter `skill.admission.min_overlap_ratio`
 * defaults to 0); raising it post-MVP tightens admission without code changes.
 */

import { matchesAcquirableTags, matchOne } from './skill-tag-matcher.ts';

export type AdmissionVerdict = 'accept' | 'reject';

export interface AdmissionDecision {
  /** Verdict after applying the gate. */
  readonly verdict: AdmissionVerdict;
  /** Fraction of the skill's tags matched by at least one persona pattern; in [0, 1]. */
  readonly overlapRatio: number;
  /** Brief, human-readable reason — populated on reject for audit/CLI surfaces. */
  readonly reason?: string;
}

/**
 * Decide whether `skillTags` may be promoted to `bound` for a persona whose
 * acquisition scope is `personaTags`. Empty/undefined tags on either side
 * reject with overlap 0 (matches `matchesAcquirableTags` semantics).
 *
 * `minOverlapRatio` is consulted only when boolean match passes — when set
 * above 0, accept additionally requires `overlapRatio >= minOverlapRatio`.
 * Parameterised so the caller can read the live ceiling from
 * `parameter-registry.ts` (`skill.admission.min_overlap_ratio`).
 */
export function decideAdmission(
  personaTags: readonly string[] | undefined,
  skillTags: readonly string[] | undefined,
  minOverlapRatio = 0,
): AdmissionDecision {
  if (!personaTags || personaTags.length === 0) {
    return { verdict: 'reject', overlapRatio: 0, reason: 'persona declares no acquirable scope' };
  }
  if (!skillTags || skillTags.length === 0) {
    return { verdict: 'reject', overlapRatio: 0, reason: 'skill declares no tags' };
  }

  const ok = matchesAcquirableTags(personaTags, skillTags);
  const ratio = tagOverlapRatio(personaTags, skillTags);

  if (!ok) {
    return {
      verdict: 'reject',
      overlapRatio: 0,
      reason: `no tag in [${skillTags.join(', ')}] matches persona scope [${personaTags.join(', ')}]`,
    };
  }
  if (minOverlapRatio > 0 && ratio < minOverlapRatio) {
    return {
      verdict: 'reject',
      overlapRatio: ratio,
      reason: `overlap ratio ${ratio.toFixed(3)} below admission floor ${minOverlapRatio.toFixed(3)}`,
    };
  }
  return { verdict: 'accept', overlapRatio: ratio };
}

/**
 * Fraction of `skillTags` that match at least one of `personaTags` (glob).
 * Range [0, 1]. Returns 0 when either side is empty.
 *
 * Asymmetric on purpose: a skill is "in scope" when most of what it claims
 * to do (its tags) is something the persona is allowed to acquire. A
 * persona with many declared scopes should not gain credit for breadth on
 * a narrowly tagged skill.
 */
export function tagOverlapRatio(
  personaTags: readonly string[] | undefined,
  skillTags: readonly string[] | undefined,
): number {
  if (!personaTags || personaTags.length === 0) return 0;
  if (!skillTags || skillTags.length === 0) return 0;
  let matched = 0;
  for (const tag of skillTags) {
    for (const pattern of personaTags) {
      if (matchOne(pattern, tag)) {
        matched++;
        break;
      }
    }
  }
  return matched / skillTags.length;
}
