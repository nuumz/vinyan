/**
 * LocalHubAcquirer — Phase-6 SkillAcquirer implementation backed by the
 * workspace's local artifact store (`.vinyan/skills/`).
 *
 * Out-of-scope for this implementation:
 *   - Network fetch from external hubs (deferred to Phase 7).
 *   - Autonomous draft generation (`AutonomousSkillCreator` integration).
 *   - Quarantine/promotion pipeline (skills must already be `active`).
 *
 * Defenses applied at acquisition time:
 *   1. **Status filter** — only `status: 'active'` skills are candidates.
 *   2. **Tag-scope match** — `matchesAcquirableTags(persona.acquirableSkillTags,
 *      skill.tags)` must succeed. Empty/undefined tags on either side reject.
 *   3. **Capability id match** — skill must declare a `provides_capabilities`
 *      entry whose `id` matches the gap's `id`.
 *   4. **Toolset allowlist** — skill's `requires_toolsets` must satisfy
 *      `areToolsetsAllowedForRole(persona.role, ...)`. Risk M3 mitigation.
 *   5. **A9 fail-safe** — any IO error inside the artifact-store iteration
 *      degrades to an empty result so a transient FS issue never blocks
 *      task execution.
 *
 * Result ordering: by skill `confidence_tier` desc (deterministic first),
 * then by id ascending. Callers usually want the first ref only — taking
 * the highest-tier candidate.
 */

import type { ConfidenceTier } from '../../core/confidence-tier.ts';
import type { SkillArtifactStore } from '../../skills/artifact-store.ts';
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

export interface LocalHubAcquirerOptions {
  /** Artifact store backing the workspace's `.vinyan/skills/` directory. */
  artifactStore: SkillArtifactStore;
  /**
   * Optional cap on candidates returned per acquireForGap call. Default: 1.
   * Acquirer returns the highest-tier matching skill so the persona's
   * loadout doesn't balloon from one gap.
   */
  maxResults?: number;
}

export class LocalHubAcquirer implements SkillAcquirer {
  private readonly store: SkillArtifactStore;
  private readonly maxResults: number;

  constructor(opts: LocalHubAcquirerOptions) {
    this.store = opts.artifactStore;
    this.maxResults = opts.maxResults ?? 1;
  }

  async acquireForGap(
    persona: AgentSpec,
    gap: CapabilityRequirement,
    _options: SkillAcquirerOptions,
  ): Promise<readonly SkillRef[]> {
    // A9: artifact store IO failures degrade to no candidates rather than
    // throwing. The acquirer is observational — the gap stays a gap.
    let listing: Awaited<ReturnType<typeof this.store.list>>;
    try {
      listing = await this.store.list();
    } catch {
      return [];
    }

    interface Candidate {
      ref: SkillRef;
      tier: ConfidenceTier;
      id: string;
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

    // Sort by tier asc (deterministic first) then id asc — stable picks
    // across runs so outcome attribution is reproducible (A8).
    candidates.sort((a, b) => {
      const tierDiff = TIER_RANK[a.tier] - TIER_RANK[b.tier];
      if (tierDiff !== 0) return tierDiff;
      return a.id.localeCompare(b.id);
    });

    return candidates.slice(0, this.maxResults).map((c) => c.ref);
  }
}
