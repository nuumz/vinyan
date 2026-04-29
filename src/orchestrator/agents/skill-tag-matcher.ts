/**
 * Skill-tag matcher — Phase-5B foundation for skill acquisition.
 *
 * Each persona declares `acquirableSkillTags: string[]` (e.g.
 * `['language:*', 'framework:react']`); each SKILL.md may carry
 * `tags: string[]` (e.g. `['language:typescript']`). The matcher decides
 * whether a skill is in the persona's acquisition scope before any
 * runtime-import / autonomous-acquire path attaches it to the persona
 * for a task.
 *
 * Without this matcher, a Mentor persona could acquire `code-mutation`
 * skills it has no business loading — the matcher is the role-scoping
 * defense line for autonomous skill acquisition.
 *
 * Glob semantics:
 *   - Pattern segments are colon-separated (`language:typescript`,
 *     `framework:react`, `review:code`).
 *   - `*` is a single-segment wildcard: `language:*` matches
 *     `language:typescript` but NOT `language:typescript:strict` (no
 *     multi-segment match — keeps the rule predictable).
 *   - Exact match always wins: `language:typescript` matches
 *     `language:typescript` only.
 *   - No regex semantics — explicit is safer than expressive here.
 *
 * Acceptance rule:
 *   - Empty/undefined `personaTags` → reject. The persona did not declare
 *     an acquisition scope; runtime acquisition is disabled for it.
 *   - Empty/undefined `skillTags` → reject. The skill carries no tag claim;
 *     no proof it belongs to any scope. Skills can opt INTO acquisition by
 *     declaring tags; opting in is on the skill author.
 *   - Match if ANY persona pattern matches ANY skill tag.
 */

/**
 * Returns true when at least one of the persona's `acquirableSkillTags` glob
 * patterns matches at least one of the skill's tags.
 */
export function matchesAcquirableTags(
  personaTags: readonly string[] | undefined,
  skillTags: readonly string[] | undefined,
): boolean {
  if (!personaTags || personaTags.length === 0) return false;
  if (!skillTags || skillTags.length === 0) return false;
  for (const pattern of personaTags) {
    for (const tag of skillTags) {
      if (matchOne(pattern, tag)) return true;
    }
  }
  return false;
}

/**
 * Glob-match one pattern against one concrete tag. Exposed for tests and
 * for callers that want to debug a single match decision.
 */
export function matchOne(pattern: string, tag: string): boolean {
  if (pattern === tag) return true;
  if (!pattern.includes('*')) return false;

  const patternParts = pattern.split(':');
  const tagParts = tag.split(':');
  if (patternParts.length !== tagParts.length) return false;

  for (let i = 0; i < patternParts.length; i++) {
    const p = patternParts[i]!;
    const t = tagParts[i]!;
    if (p === '*') continue; // single-segment wildcard
    if (p === t) continue;
    return false;
  }
  return true;
}
