/**
 * LocalHubAcquirer — Phase-6 SkillAcquirer implementation backed by the
 * workspace's local artifact store (`.vinyan/skills/`).
 *
 * Phase-14 (Item 1): optional remote-fetch fallback. When a `SkillImporter`
 * handle and a `discoverCandidateIds` hook are wired, a cache miss triggers
 * a discovery call → `importer.import(skillId)` for each candidate →
 * artifact-store rescan. Discovery is a caller-supplied hook (config-driven
 * candidate list, registry index lookup, etc.) so this module stays free of
 * network IO and adapter assumptions.
 *
 * Out-of-scope for this implementation:
 *   - Autonomous draft generation (`AutonomousSkillCreator` integration).
 *
 * Defenses applied at acquisition time (unchanged across local-only and
 * import-fallback paths):
 *   1. **Status filter** — only `status: 'active'` skills are candidates.
 *   2. **Tag-scope match** — `matchesAcquirableTags(persona.acquirableSkillTags,
 *      skill.tags)` must succeed. Empty/undefined tags on either side reject.
 *   3. **Capability id match** — skill must declare a `provides_capabilities`
 *      entry whose `id` matches the gap's `id`.
 *   4. **Toolset allowlist** — skill's `requires_toolsets` must satisfy
 *      `areToolsetsAllowedForRole(persona.role, ...)`. Risk M3 mitigation.
 *   5. **A9 fail-safe** — any IO error inside the artifact-store iteration
 *      degrades to an empty result so a transient FS issue never blocks
 *      task execution. Importer failures degrade the same way: the local
 *      candidate list (possibly empty) is returned.
 *
 * Result ordering: by skill `confidence_tier` desc (deterministic first),
 * then by id ascending. Callers usually want the first ref only — taking
 * the highest-tier candidate.
 */

import type { ConfidenceTier } from '../../core/confidence-tier.ts';
import type { SkillArtifactStore } from '../../skills/artifact-store.ts';
import type { SkillImporter } from '../../skills/hub/importer.ts';
import type { AgentSpec, CapabilityRequirement, SkillRef } from '../types.ts';
import type { SkillAcquirer, SkillAcquirerOptions } from './skill-acquirer.ts';
import { matchesAcquirableTags } from './skill-tag-matcher.ts';
import { areToolsetsAllowedForRole } from './toolset-allowlist.ts';

/**
 * Tier ordering for sort: deterministic first, speculative last. Mirrors the
 * `derive-persona-capabilities` deterministic load order.
 */
const TIER_RANK: Record<ConfidenceTier, number> = {
  deterministic: 0,
  heuristic: 1,
  pragmatic: 2,
  probabilistic: 3,
  speculative: 4,
};

/**
 * Caller-supplied discovery hook — given a (persona, gap), returns a list
 * of skill ids to attempt importing from a remote registry. The acquirer
 * does not assume how this list is produced (config file, GitHub search,
 * tag-based registry index, hard-coded mapping in tests) — discovery is
 * a separate concern. Empty array → no remote fetch attempted.
 */
export type RemoteCandidateDiscoveryFn = (
  persona: AgentSpec,
  gap: CapabilityRequirement,
) => Promise<readonly string[]>;

export interface LocalHubAcquirerOptions {
  /** Artifact store backing the workspace's `.vinyan/skills/` directory. */
  artifactStore: SkillArtifactStore;
  /**
   * Optional cap on candidates returned per acquireForGap call. Default: 1.
   * Acquirer returns the highest-tier matching skill so the persona's
   * loadout doesn't balloon from one gap.
   */
  maxResults?: number;
  /**
   * Phase-14 Item 1 — optional `SkillImporter` for remote-fetch fallback.
   * When supplied alongside `discoverCandidateIds`, the acquirer attempts
   * to import skills from a remote registry on cache miss, then rescans the
   * local artifact store. The importer's gate + critic + quarantine flow
   * applies — only `status: 'active'` skills become candidates after
   * promotion. Without this, the acquirer remains local-only (Phase-6
   * behaviour).
   */
  importer?: SkillImporter;
  /**
   * Phase-14 Item 1 — companion to `importer`. Discovery hook that returns
   * the list of skill ids to try fetching when the local cache misses.
   * Without this, no remote fetch is attempted regardless of `importer`.
   */
  discoverCandidateIds?: RemoteCandidateDiscoveryFn;
}

export class LocalHubAcquirer implements SkillAcquirer {
  private readonly store: SkillArtifactStore;
  private readonly maxResults: number;
  private readonly importer?: SkillImporter;
  private readonly discoverCandidateIds?: RemoteCandidateDiscoveryFn;

  constructor(opts: LocalHubAcquirerOptions) {
    this.store = opts.artifactStore;
    this.maxResults = opts.maxResults ?? 1;
    this.importer = opts.importer;
    this.discoverCandidateIds = opts.discoverCandidateIds;
  }

  async acquireForGap(
    persona: AgentSpec,
    gap: CapabilityRequirement,
    _options: SkillAcquirerOptions,
  ): Promise<readonly SkillRef[]> {
    // First pass: scan local artifact store. This is the existing Phase-6
    // behaviour — it remains the fast-path / steady-state code.
    const localCandidates = await this.scanLocalCandidates(persona, gap);
    if (localCandidates.length > 0) {
      return this.sortAndCap(localCandidates);
    }

    // Phase-14 Item 1 — remote-fetch fallback. Only attempts the import
    // pipeline when both an importer AND a discovery hook are configured.
    // Either piece missing → return the (possibly empty) local result so
    // legacy / local-only setups behave exactly as before.
    if (!this.importer || !this.discoverCandidateIds) {
      return this.sortAndCap(localCandidates);
    }
    let candidateIds: readonly string[];
    try {
      candidateIds = await this.discoverCandidateIds(persona, gap);
    } catch {
      // A9: discovery failure degrades to local-only result.
      return this.sortAndCap(localCandidates);
    }
    if (candidateIds.length === 0) {
      return this.sortAndCap(localCandidates);
    }

    // Run each candidate through the importer's promote pipeline. Each
    // import is independent — one rejection does not abort siblings.
    // Importer writes to the artifact store on `promoted`, so the
    // post-import rescan picks up successful imports automatically.
    for (const skillId of candidateIds) {
      try {
        await this.importer.import(skillId);
      } catch {
        /* importer is observational; failures recorded in trust ledger */
      }
    }

    // Second pass: rescan local store and re-apply all 4 defenses. Skills
    // that the importer rejected (failed gate / critic / guardrails / sig)
    // never landed as `active` and are correctly excluded again here.
    const postImport = await this.scanLocalCandidates(persona, gap);
    return this.sortAndCap(postImport);
  }

  /**
   * Scan the local artifact store and apply all 4 defenses. Returns the raw
   * candidate list pre-sort. Pure read-side — no writes, no network.
   */
  private async scanLocalCandidates(persona: AgentSpec, gap: CapabilityRequirement): Promise<Candidate[]> {
    let listing: Awaited<ReturnType<typeof this.store.list>>;
    try {
      listing = await this.store.list();
    } catch {
      return [];
    }

    const candidates: Candidate[] = [];
    for (const entry of listing) {
      let record: Awaited<ReturnType<typeof this.store.read>>;
      try {
        record = await this.store.read(entry.id);
      } catch {
        continue; // can't parse → skip
      }
      const fm = record.frontmatter;

      // Defense 1: status must be active.
      if (fm.status !== 'active') continue;

      // Defense 2: persona role-scope.
      if (!matchesAcquirableTags(persona.acquirableSkillTags, fm.tags)) continue;

      // Defense 3: capability id match.
      const provides = fm.provides_capabilities ?? [];
      const matchesGap = provides.some((c) => c.id === gap.id);
      if (!matchesGap) continue;

      // Defense 4: toolset allowlist for the persona's role.
      if (!areToolsetsAllowedForRole(persona.role, fm.requires_toolsets)) continue;

      candidates.push({
        ref: {
          id: fm.id,
          pinnedVersion: fm.version,
          ...(fm.content_hash ? { contentHash: fm.content_hash } : {}),
        },
        tier: fm.confidence_tier,
        id: fm.id,
      });
    }
    return candidates;
  }

  /**
   * Sort by tier asc (deterministic first) then id asc — stable picks
   * across runs so outcome attribution is reproducible (A8). Cap at
   * `maxResults`.
   */
  private sortAndCap(candidates: Candidate[]): readonly SkillRef[] {
    candidates.sort((a, b) => {
      const tierDiff = TIER_RANK[a.tier] - TIER_RANK[b.tier];
      if (tierDiff !== 0) return tierDiff;
      return a.id.localeCompare(b.id);
    });
    return candidates.slice(0, this.maxResults).map((c) => c.ref);
  }
}

interface Candidate {
  ref: SkillRef;
  tier: ConfidenceTier;
  id: string;
}
