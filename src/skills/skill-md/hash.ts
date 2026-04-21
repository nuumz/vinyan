/**
 * SKILL.md content hash — SHA-256 over canonicalized frontmatter + body.
 *
 * Canonicalization (repeatable — must match writer.ts):
 *   - Frontmatter: strip `content_hash` and `signature` (they're OUTputs of
 *     the hash, not inputs), sort keys alphabetically, serialize via the
 *     writer's canonical YAML path.
 *   - Body: reconstruct via the writer's canonical markdown path, so
 *     whitespace-only edits (trailing spaces, duplicate blank lines) do
 *     NOT change the hash.
 *   - Join with a fixed separator `---BODY---` so the hash does not alias
 *     across frontmatter/body boundaries.
 *
 * Output format: `sha256:<64 hex chars>` — matches the Zod regex in
 * schema.ts and the `file_hashes` convention elsewhere in the codebase.
 */
import { createHash } from 'node:crypto';

import type { SkillMdBody, SkillMdFrontmatter } from './schema.ts';
import { canonicalBodyMarkdown, canonicalFrontmatterYaml } from './writer.ts';

const BODY_DELIMITER = '\n---BODY---\n';

/** Canonical frontmatter used for hashing — drops `content_hash` + `signature`. */
export function canonicalFrontmatterForHash(frontmatter: SkillMdFrontmatter): string {
  // Structured clone minus the two fields that are outputs of hashing.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { content_hash: _ch, signature: _sig, ...rest } = frontmatter;
  return canonicalFrontmatterYaml(rest as SkillMdFrontmatter);
}

/** Compute the `sha256:<hex>` content hash for a SKILL.md record. */
export function computeContentHash(frontmatter: SkillMdFrontmatter, body: SkillMdBody): string {
  const canonicalFm = canonicalFrontmatterForHash(frontmatter);
  const canonicalBody = canonicalBodyMarkdown(body);
  const hasher = createHash('sha256');
  hasher.update(canonicalFm);
  hasher.update(BODY_DELIMITER);
  hasher.update(canonicalBody);
  return `sha256:${hasher.digest('hex')}`;
}
