/**
 * Per-agent bridge promotion tests.
 *
 * Verifies:
 *   - Per-agent simple skill graduates to namespaced heavy id `<agent>/<name>`
 *   - Aggregation only counts outcomes for matching personaId
 *   - Two agents owning the same simple-skill name graduate independently
 *   - Ledger row carries `agentId` in evidence
 */
import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runSimpleSkillPromoter } from '../../../src/skills/simple/promoter.ts';
import { createSimpleSkillRegistry } from '../../../src/skills/simple/registry.ts';
import { SkillArtifactStore } from '../../../src/skills/artifact-store.ts';
import { SkillOutcomeStore } from '../../../src/db/skill-outcome-store.ts';
import { SkillTrustLedgerStore } from '../../../src/db/skill-trust-ledger-store.ts';

let workspace: string;
let userDir: string;
let userAgentsDir: string;
let projectDir: string;
let projectAgentsDir: string;
let artifactDir: string;
let db: Database;
let outcomeStore: SkillOutcomeStore;
let ledger: SkillTrustLedgerStore;
let artifactStore: SkillArtifactStore;

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'pa-bridge-ws-'));
  userDir = mkdtempSync(join(tmpdir(), 'pa-bridge-user-'));
  userAgentsDir = mkdtempSync(join(tmpdir(), 'pa-bridge-user-agents-'));
  projectDir = mkdtempSync(join(tmpdir(), 'pa-bridge-proj-'));
  projectAgentsDir = mkdtempSync(join(tmpdir(), 'pa-bridge-proj-agents-'));
  artifactDir = mkdtempSync(join(tmpdir(), 'pa-bridge-artifact-'));

  db = new Database(':memory:');
  db.exec(`
    CREATE TABLE skill_outcomes (
      persona_id TEXT NOT NULL,
      skill_id TEXT NOT NULL,
      task_signature TEXT NOT NULL,
      successes INTEGER NOT NULL DEFAULT 0,
      failures INTEGER NOT NULL DEFAULT 0,
      last_outcome_at INTEGER NOT NULL,
      PRIMARY KEY (persona_id, skill_id, task_signature)
    );
  `);
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

  outcomeStore = new SkillOutcomeStore(db);
  ledger = new SkillTrustLedgerStore(db);
  artifactStore = new SkillArtifactStore({ rootDir: artifactDir });
});

afterEach(() => {
  db.close();
  rmSync(workspace, { recursive: true, force: true });
  rmSync(userDir, { recursive: true, force: true });
  rmSync(userAgentsDir, { recursive: true, force: true });
  rmSync(projectDir, { recursive: true, force: true });
  rmSync(projectAgentsDir, { recursive: true, force: true });
  rmSync(artifactDir, { recursive: true, force: true });
});

function plantAgent(agentId: string, name: string, description: string, body: string): void {
  const dir = join(userAgentsDir, agentId, 'skills', name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n---\n${body}\n`);
}

function buildRegistry() {
  return createSimpleSkillRegistry({
    workspace,
    userSkillsDir: userDir,
    projectSkillsDir: projectDir,
    userAgentsDir,
    projectAgentsDir,
    watch: false,
  });
}

function recordSuccesses(personaId: string, skillId: string, taskSig: string, n: number): void {
  for (let i = 0; i < n; i++) {
    outcomeStore.recordOutcome({ personaId, skillId, taskSignature: taskSig }, 'success', 1000 + i);
  }
}

describe('promoter — per-agent graduation', () => {
  test('per-agent skill graduates to namespaced heavy id <agent>/<name>', async () => {
    plantAgent('developer', 'review', 'TS review', '## Procedure\n\n1. step\n2. step');
    recordSuccesses('developer', 'review', 'sig-1', 20);

    const registry = buildRegistry();
    try {
      const result = await runSimpleSkillPromoter({
        registry,
        outcomeStore,
        artifactStore,
        ledger,
        profile: 'default',
      });
      expect(result.promoted.length).toBe(1);
      expect(result.promoted[0]?.skillName).toBe('review');
      expect(result.promoted[0]?.agentId).toBe('developer');
      expect(result.promoted[0]?.heavySkillId).toBe('developer/review');

      const heavy = await artifactStore.read('developer/review');
      expect(heavy.frontmatter.id).toBe('developer/review');
      expect(heavy.frontmatter.name).toBe('review');
    } finally {
      registry.close();
    }
  });

  test('per-agent aggregation excludes other personas', async () => {
    plantAgent('developer', 'tool', 'desc', 'body');
    // The "developer" agent has only 5 successes — below the 15 threshold.
    recordSuccesses('developer', 'tool', 'sig-1', 5);
    // The "reviewer" persona has 20 — but those should NOT count toward
    // developer's per-agent skill.
    recordSuccesses('reviewer', 'tool', 'sig-1', 20);

    const registry = buildRegistry();
    try {
      const result = await runSimpleSkillPromoter({
        registry,
        outcomeStore,
        artifactStore,
        ledger,
        profile: 'default',
      });
      expect(result.promoted).toEqual([]);
      expect(result.skipped[0]?.reason).toContain('insufficient trials');
    } finally {
      registry.close();
    }
  });

  test('two agents own same simple-skill name → graduate independently', async () => {
    plantAgent('developer', 'workflow', 'dev workflow', 'dev body');
    plantAgent('reviewer', 'workflow', 'rev workflow', 'rev body');
    recordSuccesses('developer', 'workflow', 'sig-d', 20);
    recordSuccesses('reviewer', 'workflow', 'sig-r', 20);

    const registry = buildRegistry();
    try {
      const result = await runSimpleSkillPromoter({
        registry,
        outcomeStore,
        artifactStore,
        ledger,
        profile: 'default',
      });
      expect(result.promoted.length).toBe(2);
      const ids = new Set(result.promoted.map((p) => p.heavySkillId));
      expect(ids).toEqual(new Set(['developer/workflow', 'reviewer/workflow']));

      const dev = await artifactStore.read('developer/workflow');
      const rev = await artifactStore.read('reviewer/workflow');
      expect(dev.frontmatter.id).toBe('developer/workflow');
      expect(rev.frontmatter.id).toBe('reviewer/workflow');
    } finally {
      registry.close();
    }
  });

  test('ledger row records agentId in evidence', async () => {
    plantAgent('developer', 'audit', 'audit desc', 'body');
    recordSuccesses('developer', 'audit', 'sig-1', 20);

    const registry = buildRegistry();
    try {
      await runSimpleSkillPromoter({
        registry,
        outcomeStore,
        artifactStore,
        ledger,
        profile: 'default',
      });

      const history = ledger.history('developer/audit', { profile: 'default' });
      expect(history.length).toBe(1);
      expect((history[0]?.evidence.agentId as string)).toBe('developer');
      expect(history[0]?.evidence.promotedFrom).toBe('simple-skill-layer');
    } finally {
      registry.close();
    }
  });

  test('shared-scope skill still aggregates across personas', async () => {
    // Plant a shared skill (no agent dir).
    const sharedDir = join(userDir, 'public');
    mkdirSync(sharedDir, { recursive: true });
    writeFileSync(join(sharedDir, 'SKILL.md'), `---\nname: public\ndescription: pub\n---\nbody\n`);

    // Spread outcomes across multiple agents — should sum to ≥15 trials.
    recordSuccesses('developer', 'public', 'sig-1', 8);
    recordSuccesses('reviewer', 'public', 'sig-2', 8);

    const registry = buildRegistry();
    try {
      const result = await runSimpleSkillPromoter({
        registry,
        outcomeStore,
        artifactStore,
        ledger,
        profile: 'default',
      });
      expect(result.promoted.length).toBe(1);
      expect(result.promoted[0]?.agentId).toBeNull();
      expect(result.promoted[0]?.heavySkillId).toBe('public');
      expect(result.promoted[0]?.trials).toBe(16);
    } finally {
      registry.close();
    }
  });
});
