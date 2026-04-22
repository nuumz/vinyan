/**
 * SkillRegistryAdapter — shared interface every skill-registry adapter
 * (GitHub, agentskills.io, claude-marketplace, lobehub, clawhub, skills.sh,
 * .well-known) must implement.
 *
 * Adapters are read-only facades around an external registry. They return
 * raw SKILL.md text and companion files; none of them do parsing,
 * quarantine, or promotion — that is exclusively the `SkillImporter`'s job
 * (A1 Epistemic Separation: fetcher ≠ verifier).
 */
import type { ConfidenceTier } from '../../core/confidence-tier.ts';

/**
 * L0 listing returned by `list()` — the bare-minimum fields needed to
 * render a search result. Frontmatter is NOT fully parsed here; the caller
 * must still `fetch()` and parse before trusting any field beyond these.
 */
export interface SkillListingL0 {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly description: string;
  readonly confidenceTier: ConfidenceTier;
  readonly author?: string;
}

/**
 * Result of a `fetch()` call. `skillMd` is the raw text (the importer will
 * parse it); `files` is a map of relative path → text content for every
 * companion file referenced in the SKILL.md's `## Files` whitelist.
 *
 * `signature` — optional ed25519 signature if the registry supplies one.
 * Verification is the importer's responsibility, not the adapter's.
 */
export interface SkillFetchResult {
  readonly skillMd: string;
  readonly files: ReadonlyMap<string, string>;
  readonly signature?: {
    readonly algorithm: 'ed25519';
    readonly signer: string;
    readonly value: string;
  };
}

export type SkillRegistryName =
  | 'github'
  | 'agentskills-io'
  | 'claude-marketplace'
  | 'lobehub'
  | 'clawhub'
  | 'skills-sh'
  | 'well-known';

export interface SkillRegistryAdapter {
  readonly name: SkillRegistryName;
  list(query: string, opts?: { limit?: number }): Promise<readonly SkillListingL0[]>;
  fetch(id: string): Promise<SkillFetchResult>;
}

/**
 * Generic fetch implementation so adapters can inject a test double.
 * Matches the subset of the WHATWG `fetch` shape we actually use.
 */
export type FetchImpl = (
  input: string,
  init?: { headers?: Record<string, string>; method?: string },
) => Promise<{
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
  json(): Promise<unknown>;
}>;

export class SkillRegistryError extends Error {
  constructor(
    message: string,
    public readonly adapter: string,
    public override readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'SkillRegistryError';
  }
}

export class SkillNotFoundError extends SkillRegistryError {
  constructor(adapter: string, id: string) {
    super(`Skill '${id}' not found in adapter '${adapter}'`, adapter);
    this.name = 'SkillNotFoundError';
  }
}
