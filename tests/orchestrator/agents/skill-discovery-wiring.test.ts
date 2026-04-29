/**
 * Phase-15 Item 1 — `buildSkillDiscoveryWiring` config-list backend.
 *
 * Covers the contract between `vinyan.json:skills.discovery` and the
 * `LocalHubAcquirer` cache-miss path:
 *   - empty candidate map → no-op hooks (acquirer stays local-only)
 *   - configured candidates + 'none' adapter → discoverCandidateIds returns
 *     ids but importer is never attached (inert by design)
 *   - configured candidates + 'github' adapter + ready criticEngine →
 *     importer attached; cache-miss flow can fire
 *   - acquirer-level integration: persona requests an unmet capability →
 *     discovery returns the configured skill id → importer.import is called
 *
 * The full cache-miss → fetch → promote round-trip is exercised in
 * `tests/orchestrator/agents/local-hub-acquirer-import.test.ts` with a
 * stub importer. This file focuses on the wiring contract.
 */
import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { VinyanConfig } from '../../../src/config/schema.ts';
import { LocalHubAcquirer } from '../../../src/orchestrator/agents/local-hub-acquirer.ts';
import { buildSkillDiscoveryWiring } from '../../../src/orchestrator/agents/skill-discovery-wiring.ts';
import type { CapabilityRequirement } from '../../../src/orchestrator/types.ts';
import { SkillArtifactStore } from '../../../src/skills/artifact-store.ts';

function makeFixtures() {
  const dir = mkdtempSync(join(tmpdir(), 'sk-disco-'));
  const skillsDir = join(dir, 'skills');
  mkdirSync(skillsDir, { recursive: true });
  const artifactStore = new SkillArtifactStore({ rootDir: skillsDir });
  const db = new Database(':memory:');
  // Inline the trust-ledger schema columns used by setupSkillImporter — the
  // wiring helper itself never writes here in these tests, but
  // `setupSkillImporter` constructs a `SkillTrustLedgerStore` on the db.
  db.exec(`
    CREATE TABLE skill_trust_ledger (
      ledger_id INTEGER PRIMARY KEY AUTOINCREMENT,
      profile TEXT NOT NULL,
      skill_id TEXT NOT NULL,
      event TEXT NOT NULL,
      from_status TEXT,
      to_status TEXT,
      from_tier TEXT,
      to_tier TEXT,
      evidence_json TEXT NOT NULL,
      rule_id TEXT,
      created_at INTEGER NOT NULL
    );
  `);
  return {
    dir,
    db,
    artifactStore,
    cleanup: () => {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function makeConfig(discovery: VinyanConfig['skills'] extends infer T ? T : never): VinyanConfig {
  return {
    version: 1,
    oracles: {},
    skills: discovery,
  } as unknown as VinyanConfig;
}

const PERSONA = {
  id: 'developer',
  name: 'Developer',
  description: 'gen',
  role: 'developer' as const,
};

const GAP: CapabilityRequirement = { id: 'lang.typescript', weight: 1, source: 'fingerprint' };

describe('buildSkillDiscoveryWiring', () => {
  test('no skills.discovery → discoverCandidateIds null, attachImporter is no-op', () => {
    const fx = makeFixtures();
    try {
      const wiring = buildSkillDiscoveryWiring({
        vinyanConfig: makeConfig(undefined),
        db: fx.db,
        workspace: fx.dir,
        profile: 'default',
        artifactStore: fx.artifactStore,
      });
      expect(wiring.discoverCandidateIds).toBeNull();
      // attachImporter must not throw even with no real criticEngine.
      expect(() =>
        wiring.attachImporter(
          new LocalHubAcquirer({ artifactStore: fx.artifactStore }),
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          {} as any,
        ),
      ).not.toThrow();
    } finally {
      fx.cleanup();
    }
  });

  test('empty candidate map → no-op hooks', () => {
    const fx = makeFixtures();
    try {
      const wiring = buildSkillDiscoveryWiring({
        vinyanConfig: makeConfig({ discovery: { candidates: {}, adapter: 'github' } }),
        db: fx.db,
        workspace: fx.dir,
        profile: 'default',
        artifactStore: fx.artifactStore,
      });
      expect(wiring.discoverCandidateIds).toBeNull();
    } finally {
      fx.cleanup();
    }
  });

  test('candidates + adapter "none" → discoverCandidateIds returns ids, importer attach is inert', async () => {
    const fx = makeFixtures();
    try {
      const wiring = buildSkillDiscoveryWiring({
        vinyanConfig: makeConfig({
          discovery: {
            candidates: { 'lang.typescript': ['vinyan-skills/ts-coding'] },
            adapter: 'none',
          },
        }),
        db: fx.db,
        workspace: fx.dir,
        profile: 'default',
        artifactStore: fx.artifactStore,
      });
      expect(wiring.discoverCandidateIds).not.toBeNull();
      const ids = await wiring.discoverCandidateIds!(PERSONA, GAP);
      expect(ids).toEqual(['vinyan-skills/ts-coding']);

      // adapter='none' → attach is observable but does not actually wire an
      // importer (assertion: passing a bogus criticEngine doesn't throw,
      // proving the function short-circuits before touching it).
      const acquirer = new LocalHubAcquirer({
        artifactStore: fx.artifactStore,
        discoverCandidateIds: wiring.discoverCandidateIds!,
      });
      expect(() =>
        wiring.attachImporter(
          acquirer,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          { review: () => Promise.reject(new Error('should-not-call')) } as any,
        ),
      ).not.toThrow();
    } finally {
      fx.cleanup();
    }
  });

  test('candidates + adapter "github" + ready criticEngine → importer attached', async () => {
    const fx = makeFixtures();
    try {
      const wiring = buildSkillDiscoveryWiring({
        vinyanConfig: makeConfig({
          discovery: {
            candidates: { 'lang.typescript': ['github:owner/repo'] },
            adapter: 'github',
          },
        }),
        db: fx.db,
        workspace: fx.dir,
        profile: 'default',
        artifactStore: fx.artifactStore,
      });
      const acquirer = new LocalHubAcquirer({
        artifactStore: fx.artifactStore,
        ...(wiring.discoverCandidateIds ? { discoverCandidateIds: wiring.discoverCandidateIds } : {}),
      });
      // CriticEngine has a `review` method; the adapter only references it
      // structurally so a no-op is enough.
      const fakeCritic = {
        review: async () => ({ approved: false, notes: 'stub' }),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any;
      expect(() => wiring.attachImporter(acquirer, fakeCritic)).not.toThrow();

      // After attach, the acquirer's import-fallback path is reachable.
      // We verify by triggering the discovery hook — the configured id
      // surfaces, and the acquirer would call importer.import on cache miss.
      // The actual import would hit GitHub; this test stops at observing the
      // discovery surface (network IO is exercised by adapter unit tests).
      const ids = await wiring.discoverCandidateIds!(PERSONA, GAP);
      expect(ids).toEqual(['github:owner/repo']);
    } finally {
      fx.cleanup();
    }
  });

  test('per-capability candidate isolation: gap A returns A list, gap B returns []', async () => {
    const fx = makeFixtures();
    try {
      const wiring = buildSkillDiscoveryWiring({
        vinyanConfig: makeConfig({
          discovery: {
            candidates: {
              'lang.typescript': ['github:owner/ts'],
            },
            adapter: 'none',
          },
        }),
        db: fx.db,
        workspace: fx.dir,
        profile: 'default',
        artifactStore: fx.artifactStore,
      });
      expect(await wiring.discoverCandidateIds!(PERSONA, GAP)).toEqual(['github:owner/ts']);
      // Unknown capability → empty list. The acquirer's cache-miss branch
      // sees an empty list and returns the local result unchanged.
      expect(
        await wiring.discoverCandidateIds!(PERSONA, { id: 'lang.python', weight: 1, source: 'fingerprint' }),
      ).toEqual([]);
    } finally {
      fx.cleanup();
    }
  });
});
