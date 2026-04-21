/**
 * SKILL.md artifact — public surface (Decision 20).
 *
 * See `src/skills/skill-md/schema.ts` for the Zod schema and TS types,
 * `parser.ts` for text → record, `writer.ts` for record → canonical text,
 * and `hash.ts` for the content-hash canonicalization.
 *
 * This module is deliberately pure: no DB, no filesystem, no network.
 * Storage lives in `cached_skills` (see migration 004).
 */

export { canonicalFrontmatterForHash, computeContentHash } from './hash.ts';
export { parseSkillMd } from './parser.ts';
export {
  type SkillMdBody,
  type SkillMdFrontmatter,
  SkillMdFrontmatterSchema,
  SkillMdParseError,
  type SkillMdRecord,
} from './schema.ts';
export { canonicalBodyMarkdown, canonicalFrontmatterYaml, writeSkillMd } from './writer.ts';
