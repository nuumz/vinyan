/**
 * Skill discovery wiring — Phase-15 Item 1.
 *
 * Builds the runtime hooks the `LocalHubAcquirer` needs to fall through to
 * `SkillImporter` on cache miss. The helper is a pure factory: it reads
 * `vinyan.json:skills.discovery` config and produces (a) a
 * `discoverCandidateIds` closure that returns the configured candidate
 * skill ids per gap, and (b) an `attachImporter` callback the factory
 * invokes once `criticEngine` + oracle gate are constructed (later in the
 * factory than the acquirer itself).
 *
 * Factory uses both halves to avoid refactoring acquirer construction
 * order — the acquirer is built early (workers reference it), but the
 * importer needs criticEngine which is built later.
 *
 * When `skills.discovery.adapter === 'none'` (the default) or the candidate
 * map is empty, the helper returns no-op hooks: the acquirer remains
 * local-only and behaviour matches Phase 14 verbatim.
 */
import type { Database } from 'bun:sqlite';
import type { VinyanConfig } from '../../config/schema.ts';
import { runGate as runOracleGate } from '../../gate/gate.ts';
import type { CriticEngine } from '../critic/critic-engine.ts';
import type { SkillArtifactStore } from '../../skills/artifact-store.ts';
import { AgentskillsIoAdapter } from '../../skills/hub/adapters/agentskills-io.ts';
import { GitHubAdapter } from '../../skills/hub/adapters/github.ts';
import type { SkillRegistryAdapter } from '../../skills/hub/registry-adapter.ts';
import { setupSkillImporter } from '../../skills/hub/wiring.ts';
import type { CapabilityRequirement } from '../types.ts';
import type { LocalHubAcquirer, RemoteCandidateDiscoveryFn } from './local-hub-acquirer.ts';

export interface BuildSkillDiscoveryWiringOptions {
  readonly vinyanConfig: VinyanConfig;
  readonly db: Database;
  readonly workspace: string;
  readonly profile: string;
  readonly artifactStore: SkillArtifactStore;
}

export interface SkillDiscoveryWiring {
  /**
   * Closure to pass into `LocalHubAcquirer({ discoverCandidateIds })`.
   * Returns the configured candidate skill ids for the gap's capability id.
   * `null` when the config has no `skills.discovery` block or its candidate
   * map is empty — acquirer stays local-only in that case.
   */
  readonly discoverCandidateIds: RemoteCandidateDiscoveryFn | null;
  /**
   * Deferred attach: factory calls this once `criticEngine` is ready (after
   * the persona-skill registry init). Builds the `SkillImporter` via
   * `setupSkillImporter` and calls `acquirer.setImporter(...)`. Returns
   * silently when the configured adapter is 'none' — the acquirer's
   * `discoverCandidateIds` will see candidates but the import-fallback path
   * stays inert because `importer` is never set.
   */
  attachImporter(acquirer: LocalHubAcquirer, criticEngine: CriticEngine): void;
}

export function buildSkillDiscoveryWiring(opts: BuildSkillDiscoveryWiringOptions): SkillDiscoveryWiring {
  const discovery = opts.vinyanConfig.skills?.discovery;
  const candidates = discovery?.candidates ?? {};
  const adapterChoice = discovery?.adapter ?? 'none';
  const candidateKeys = Object.keys(candidates);

  // Empty config-list → no discovery hook at all. Importer attach also
  // becomes a no-op since there's nothing to fetch.
  if (candidateKeys.length === 0) {
    return {
      discoverCandidateIds: null,
      attachImporter: () => {
        /* no candidates configured — nothing to wire */
      },
    };
  }

  const discoverCandidateIds: RemoteCandidateDiscoveryFn = async (_persona, gap: CapabilityRequirement) =>
    candidates[gap.id] ?? [];

  return {
    discoverCandidateIds,
    attachImporter(acquirer, criticEngine) {
      // Adapter 'none' keeps the import path inert even when candidates are
      // configured. Operators can flip the adapter on later without touching
      // the candidate map.
      if (adapterChoice === 'none') return;
      const adapter = buildAdapter(adapterChoice, discovery?.github_token);
      if (!adapter) return;
      try {
        const handle = setupSkillImporter({
          db: opts.db,
          adapter,
          runGate: runOracleGate,
          critic: criticEngine,
          workspace: opts.workspace,
          profile: opts.profile,
          artifactStore: opts.artifactStore,
        });
        acquirer.setImporter(handle.importer);
      } catch {
        /* importer wiring is best-effort — acquirer stays local-only on failure */
      }
    },
  };
}

function buildAdapter(choice: 'github' | 'agentskills', githubToken?: string): SkillRegistryAdapter | null {
  if (choice === 'github') {
    return new GitHubAdapter(githubToken ? { token: githubToken } : {});
  }
  if (choice === 'agentskills') {
    return new AgentskillsIoAdapter();
  }
  return null;
}
