/**
 * Hybrid skill redesign — bridge test (simple → heavy graduation).
 *
 * Covers:
 *   - Threshold gates: insufficient trials, low success rate, exact boundary
 *   - Round-trip: simple SKILL.md → heavy SKILL.md with valid contentHash + ledger row
 *   - Idempotency: re-running on already-promoted skill is a no-op
 *   - A4: artifact write FIRST, ledger second (verified by stub-throwing ledger)
 *   - A9: missing simple SKILL.md / unreadable file → skip without throwing
 */
import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  MIN_PROMOTION_SUCCESS_RATE,
  MIN_PROMOTION_TRIALS,
  runSimpleSkillPromoter,
} from '../../../src/skills/simple/promoter.ts';
import { createSimpleSkillRegistry } from '../../../src/skills/simple/registry.ts';
import { SkillArtifactStore } from '../../../src/skills/artifact-store.ts';
import { SkillOutcomeStore } from '../../../src/db/skill-outcome-store.ts';
import { SkillTrustLedgerStore } from '../../../src/db/skill-trust-ledger-store.ts';

let workspace: string;
let userDir: string;
let projectDir: string;
let artifactDir: string;
let db: Database;
let outcomeStore: SkillOutcomeStore;
let ledger: SkillTrustLedgerStore;
let artifactStore: SkillArtifactStore;

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'bridge-ws-'));
  userDir = mkdtempSync(join(tmpdir(), 'bridge-user-'));
  projectDir = mkdtempSync(join(tmpdir(), 'bridge-proj-'));
  artifactDir = mkdtempSync(join(tmpdir(), 'bridge-artifact-'));

  db = new Database(':memory:');
  // Outcome table (mirrors migration 019)
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
  // Ledger table (mirrors migration 008)
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
  rmSync(projectDir, { recursive: true, force: true });
  rmSync(artifactDir, { recursive: true, force: true });
});

function plantSimple(name: string, description: string, body: string): void {
  const dir = join(projectDir, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${description}\n---\n${body}\n`,
  );
}

function buildRegistry() {
  return createSimpleSkillRegistry({
    workspace,
    userSkillsDir: userDir,
    projectSkillsDir: projectDir,
    watch: false,
  });
}

function recordWins(personaId: string, skillId: string, taskSig: string, n: number): void {
  for (let i = 0; i < n; i++) {
    outcomeStore.recordOutcome({ personaId, skillId, taskSignature: taskSig }, 'success', 1000 + i);
  }
}

function recordLosses(personaId: string, skillId: string, taskSig: string, n: number): void {
  for (let i = 0; i < n; i++) {
    outcomeStore.recordOutcome({ personaId, skillId, taskSignature: taskSig }, 'failure', 1000 + i);
  }
}

describe('runSimpleSkillPromoter — threshold gates', () => {
  test('insufficient trials → not promoted', async () => {
    plantSimple('immature', 'desc', 'body');
    recordWins('developer', 'immature', 'sig-1', MIN_PROMOTION_TRIALS - 1);

    const registry = buildRegistry();
    try {
      const result = await runSimpleSkillPromoter({
        registry,
        outcomeStore,
        artifactStore,
        ledger,
        profile: 'default',
        now: () => 12345,
      });
      expect(result.promoted).toEqual([]);
      expect(result.skipped[0]?.reason).toContain('insufficient trials');
    } finally {
      registry.close();
    }
  });

  test('low success rate → not promoted', async () => {
    plantSimple('flaky', 'desc', 'body');
    recordWins('developer', 'flaky', 'sig-1', 10);
    recordLosses('developer', 'flaky', 'sig-1', 10); // 50% rate

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
      expect(result.skipped[0]?.reason).toMatch(/success rate/);
    } finally {
      registry.close();
    }
  });

  test('exact boundary (15 trials, 0.8 rate) → promoted', async () => {
    plantSimple('boundary', 'desc', 'body');
    recordWins('developer', 'boundary', 'sig-1', 12);
    recordLosses('developer', 'boundary', 'sig-1', 3); // 12/15 = 0.8 exact

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
      expect(result.promoted[0]?.skillName).toBe('boundary');
      expect(result.promoted[0]?.successRate).toBeCloseTo(0.8, 2);
    } finally {
      registry.close();
    }
  });

  test('high-rate, plenty of trials → promoted', async () => {
    plantSimple('great', 'description for great skill', 'body content');
    // Spread trials across multiple personas + task sigs
    recordWins('developer', 'great', 'task-a', 8);
    recordWins('reviewer', 'great', 'task-b', 8);
    recordLosses('developer', 'great', 'task-a', 1); // 16/17 ≈ 0.94

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
      expect(result.promoted[0]?.trials).toBe(17);
    } finally {
      registry.close();
    }
  });
});

describe('runSimpleSkillPromoter — round-trip', () => {
  test('writes a heavy SKILL.md with valid contentHash', async () => {
    plantSimple('roundtrip', 'description', '## Procedure\n\n1. step\n2. step');
    recordWins('developer', 'roundtrip', 'sig-1', 20);

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

      const heavy = await artifactStore.read('roundtrip');
      expect(heavy.frontmatter.id).toBe('roundtrip');
      expect(heavy.frontmatter.confidence_tier).toBe('pragmatic');
      expect(heavy.frontmatter.status).toBe('active');
      expect(heavy.frontmatter.origin).toBe('local');
      expect(heavy.contentHash).toMatch(/^sha256:[a-f0-9]{64}$/);
    } finally {
      registry.close();
    }
  });

  test('appends a ledger row referencing trials + new hash', async () => {
    plantSimple('ledger-test', 'desc', 'body');
    recordWins('developer', 'ledger-test', 'sig-1', 20);

    const registry = buildRegistry();
    try {
      await runSimpleSkillPromoter({
        registry,
        outcomeStore,
        artifactStore,
        ledger,
        profile: 'default',
      });

      const history = ledger.history('ledger-test', { profile: 'default' });
      expect(history.length).toBe(1);
      expect(history[0]?.event).toBe('promoted');
      expect(history[0]?.toTier).toBe('pragmatic');
      expect(history[0]?.toStatus).toBe('active');
      expect(history[0]?.evidence.trials).toBe(20);
      expect((history[0]?.evidence.newHash as string)).toMatch(/^sha256:[a-f0-9]{64}$/);
    } finally {
      registry.close();
    }
  });
});

describe('runSimpleSkillPromoter — idempotency', () => {
  test('second run on unchanged skill is a no-op', async () => {
    plantSimple('idem', 'desc', 'body');
    recordWins('developer', 'idem', 'sig-1', 20);

    const registry = buildRegistry();
    try {
      const first = await runSimpleSkillPromoter({
        registry,
        outcomeStore,
        artifactStore,
        ledger,
        profile: 'default',
      });
      expect(first.promoted.length).toBe(1);

      const second = await runSimpleSkillPromoter({
        registry,
        outcomeStore,
        artifactStore,
        ledger,
        profile: 'default',
      });
      expect(second.promoted).toEqual([]);
      expect(second.skipped[0]?.reason).toContain('already promoted, content unchanged');
    } finally {
      registry.close();
    }
  });

  test('changed body bumps patch version', async () => {
    plantSimple('versioned', 'desc', 'body version 1');
    recordWins('developer', 'versioned', 'sig-1', 20);

    let registry = buildRegistry();
    try {
      await runSimpleSkillPromoter({
        registry,
        outcomeStore,
        artifactStore,
        ledger,
        profile: 'default',
      });
      registry.close();

      const v1 = await artifactStore.read('versioned');
      expect(v1.frontmatter.version).toBe('0.1.0');

      // Edit the simple skill body
      plantSimple('versioned', 'desc', 'body version 2 — substantially different');
      registry = buildRegistry();
      const second = await runSimpleSkillPromoter({
        registry,
        outcomeStore,
        artifactStore,
        ledger,
        profile: 'default',
      });
      expect(second.promoted.length).toBe(1);
      const v2 = await artifactStore.read('versioned');
      expect(v2.frontmatter.version).toBe('0.1.1');
      expect(v2.contentHash).not.toBe(v1.contentHash);
    } finally {
      registry.close();
    }
  });
});

describe('runSimpleSkillPromoter — A9 degradation', () => {
  test('one failure does not block siblings', async () => {
    plantSimple('good-a', 'a', 'body a');
    plantSimple('good-b', 'b', 'body b');
    recordWins('developer', 'good-a', 'sig-1', 20);
    recordWins('developer', 'good-b', 'sig-1', 20);

    const registry = buildRegistry();
    try {
      // Stub a ledger that throws on first record but recovers — verifies
      // that artifact write happened FIRST (A4) so the file is on disk
      // even when the ledger entry is lost.
      let throws = 1;
      const guardedLedger = {
        ...ledger,
        record(record: Parameters<typeof ledger.record>[0]) {
          if (throws-- > 0) throw new Error('flaky-ledger');
          return ledger.record(record);
        },
      } as typeof ledger;

      const result = await runSimpleSkillPromoter({
        registry,
        outcomeStore,
        artifactStore,
        ledger: guardedLedger,
        profile: 'default',
      });
      expect(result.promoted.length).toBe(2);

      // Both heavy artifacts on disk despite ledger failure on one.
      expect(await artifactStore.read('good-a')).toBeDefined();
      expect(await artifactStore.read('good-b')).toBeDefined();
    } finally {
      registry.close();
    }
  });

  test('skill with zero trials produces no error', async () => {
    plantSimple('untouched', 'desc', 'body');
    // No outcomes recorded.

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
});

describe('runSimpleSkillPromoter — constants exposed for callers', () => {
  test('thresholds match the documented public values', () => {
    expect(MIN_PROMOTION_TRIALS).toBe(15);
    expect(MIN_PROMOTION_SUCCESS_RATE).toBe(0.8);
  });
});
