/**
 * Memory Wiki — deterministic validator.
 *
 * Generators (extractor / LLM synthesizer / API) produce
 * `WikiPageProposal`. The validator is the only path to disk. It
 * performs:
 *
 *   1. Schema validation (zod).
 *   2. Tier-confidence clamp (A5).
 *   3. Citation rules:
 *        - canonical pages MUST cite ≥1 source (sources[] non-empty).
 *        - draft pages may cite zero sources.
 *   4. Wikilink resolution: `[[target]]` must resolve to an existing
 *      page id, alias, or be a `derived-from:<id>` reverse-link.
 *      Unresolved targets are recorded as `broken-wikilink` lint
 *      findings (not failures) UNLESS `strictWikilinks` is set.
 *   5. Tier demotion guard: an existing canonical page cannot be
 *      overwritten with a weaker tier without explicit demotion.
 *   6. Human-protected section preservation (delegates to schema.ts).
 *   7. Body size cap.
 *
 * The validator is stateless and pure with respect to its inputs — it
 * receives the existing page (if any) plus a target-resolver from the
 * caller, so it can run inside the writer without owning the store.
 */
import { clampConfidenceToTier, isStrongerThan } from '../../core/confidence-tier.ts';
import { computeBodyHash, mergeProtectedSections } from './schema.ts';
import { type WikiPage, type WikiPageProposal, WikiPageProposalSchema, type WikiWriteResult } from './types.ts';
import { parseWikilinks } from './wikilink-parser.ts';

export interface ValidatorContext {
  /** Existing page on disk (when this is an update). */
  readonly existing: WikiPage | null;
  /** Resolves a wikilink target → existing page id. Returns null when unresolvable. */
  readonly resolveTarget: (profile: string, target: string) => string | null;
  /** When true, broken wikilinks fail the write rather than being recorded as lint findings. */
  readonly strictWikilinks?: boolean;
  /** When true, allow tier demotion (e.g. validator detected stale source). */
  readonly allowDemotion?: boolean;
}

export interface ValidatedPage {
  readonly page: WikiPage;
  readonly created: boolean;
  /** Targets the validator could not resolve — caller emits lint findings. */
  readonly unresolvedTargets: readonly string[];
}

export type ValidatorRejectReason =
  | 'frontmatter_invalid'
  | 'uncited_canonical'
  | 'broken_wikilink'
  | 'human_protected_modified'
  | 'tier_demotion'
  | 'profile_unknown'
  | 'path_invalid'
  | 'body_too_large'
  | 'duplicate_alias';

export type ValidatorResult =
  | { readonly ok: true; readonly value: ValidatedPage }
  | { readonly ok: false; readonly reason: ValidatorRejectReason; readonly detail: string };

export function validateProposal(proposal: WikiPageProposal, ctx: ValidatorContext, now: number): ValidatorResult {
  // 1. Schema
  const parsed = WikiPageProposalSchema.safeParse(proposal);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const path = issue?.path.join('.') ?? '';
    if (path === 'profile') {
      return { ok: false, reason: 'profile_unknown', detail: issue?.message ?? 'invalid profile' };
    }
    if (path === 'body') {
      return { ok: false, reason: 'body_too_large', detail: issue?.message ?? 'body invalid' };
    }
    return { ok: false, reason: 'frontmatter_invalid', detail: issue?.message ?? parsed.error.message };
  }
  const input = parsed.data;
  const lifecycle = input.lifecycle ?? ctx.existing?.lifecycle ?? 'draft';

  // 2. Tier clamp (A5)
  const clamped = clampConfidenceToTier(input.confidence, input.evidenceTier);

  // 3. Citation rule
  if (lifecycle === 'canonical' && input.sources.length === 0) {
    return {
      ok: false,
      reason: 'uncited_canonical',
      detail: 'canonical pages must cite at least one source',
    };
  }

  // 4. Tier demotion guard
  if (ctx.existing && !ctx.allowDemotion && isStrongerThan(ctx.existing.evidenceTier, input.evidenceTier)) {
    return {
      ok: false,
      reason: 'tier_demotion',
      detail: `cannot demote tier from ${ctx.existing.evidenceTier} to ${input.evidenceTier} without allowDemotion`,
    };
  }

  // 5. Human-protected section preservation
  let mergedBody = input.body;
  if (ctx.existing) {
    const merge = mergeProtectedSections(ctx.existing.body, input.body);
    if (!merge) {
      return {
        ok: false,
        reason: 'human_protected_modified',
        detail: 'proposal modifies a human-protected section',
      };
    }
    mergedBody = merge.merged;
  }

  // 6. Duplicate-alias guard (delegated to caller — checks happen in the writer
  //    where the store is available; we keep validator pure).

  // 7. Wikilink resolution
  const links = parseWikilinks(mergedBody);
  const unresolved: string[] = [];
  for (const link of links) {
    const resolved = ctx.resolveTarget(input.profile, link.target);
    if (!resolved) unresolved.push(link.target);
  }
  if (unresolved.length > 0 && ctx.strictWikilinks) {
    return {
      ok: false,
      reason: 'broken_wikilink',
      detail: `unresolved wikilink targets: ${unresolved.slice(0, 5).join(', ')}${unresolved.length > 5 ? '…' : ''}`,
    };
  }

  // 8. Build the validated page
  const id = input.id ?? ctx.existing?.id ?? deriveProposalId(input);
  const createdAt = ctx.existing?.createdAt ?? now;
  const page: WikiPage = {
    id,
    profile: input.profile,
    type: input.type,
    title: input.title,
    aliases: input.aliases ? [...input.aliases] : (ctx.existing?.aliases ?? []),
    tags: input.tags ? [...input.tags] : (ctx.existing?.tags ?? []),
    body: mergedBody,
    evidenceTier: input.evidenceTier,
    confidence: clamped,
    lifecycle,
    createdAt,
    updatedAt: now,
    ...(input.validUntil !== undefined ? { validUntil: input.validUntil } : {}),
    protectedSections: input.protectedSections ? [...input.protectedSections] : (ctx.existing?.protectedSections ?? []),
    bodyHash: computeBodyHash(mergedBody),
    sources: [...input.sources],
  };

  return {
    ok: true,
    value: {
      page,
      created: !ctx.existing,
      unresolvedTargets: unresolved,
    },
  };
}

function deriveProposalId(input: WikiPageProposal): string {
  // Late-import to avoid circular references between schema/validator/writer.
  const { derivePageId } = require('./schema.ts') as typeof import('./schema.ts');
  return derivePageId(input.type, input.title);
}
