/**
 * Phase-15 (Item 4) — skill tier graduation decision + applier.
 *
 * Decision-function tests use synthetic outcome rows; applier tests use a
 * real in-memory SQLite + temp-dir SkillArtifactStore so the SKILL.md
 * round-trip + ledger writes are exercised end-to-end.
 */
import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ConfidenceTier } from '../../../src/core/confidence-tier.ts';
import { SKILL_OUTCOME_SCHEMA_SQL } from '../../../src/db/skill-outcome-schema.ts';
import type { SkillOutcomeRecord } from '../../../src/db/skill-outcome-store.ts';
import { SkillTrustLedgerStore } from '../../../src/db/skill-trust-ledger-store.ts';
import { SkillArtifactStore } from '../../../src/skills/artifact-store.ts';
import {
  applyTierGraduations,
  TIER_GRADUATION_RULE_ID,
} from '../../../src/skills/autonomous/tier-graduation-applier.ts';
import {
  decideTierGraduations,
  MIN_COOLDOWN_RUNS,
  MIN_TRIALS_PROMOTE,
  nextTierDown,
  nextTierUp,
} from '../../../src/skills/autonomous/tier-graduation.ts';
import { parseSkillMd } from '../../../src/skills/skill-md/index.ts';

function makeRow(opts: {
  skillId?: string;
  personaId?: string;
  taskSignature?: string;
  successes: number;
  failures: number;
}): SkillOutcomeRecord {
  return {
    skillId: opts.skillId ?? 'a/skill',
    personaId: opts.personaId ?? 'developer',
    taskSignature: opts.taskSignature ?? 'code::refactor',
    successes: opts.successes,
    failures: opts.failures,
    lastOutcomeAt: 1,
  };
}

describe('nextTierUp / nextTierDown', () => {
  test('promote ladder', () => {
    expect(nextTierUp('speculative')).toBe('probabilistic');
    expect(nextTierUp('probabilistic')).toBe('pragmatic');
    expect(nextTierUp('pragmatic')).toBe('heuristic');
    expect(nextTierUp('heuristic')).toBe('deterministic');
    expect(nextTierUp('deterministic')).toBeNull();
  });
  test('demote ladder', () => {
    expect(nextTierDown('deterministic')).toBe('heuristic');
    expect(nextTierDown('heuristic')).toBe('pragmatic');
    expect(nextTierDown('pragmatic')).toBe('probabilistic');
    expect(nextTierDown('probabilistic')).toBe('speculative');
    expect(nextTierDown('speculative')).toBeNull();
  });
});

describe('decideTierGraduations', () => {
  test('high LB + ≥30 trials → promote one rung', () => {
    const decisions = decideTierGraduations({
      rows: [makeRow({ skillId: 'a/x', successes: 30, failures: 0 })],
      currentTierBySkill: new Map([['a/x', 'probabilistic' as ConfidenceTier]]),
      cooldownState: new Map(),
      currentRun: 1,
    });
    expect(decisions).toHaveLength(1);
    expect(decisions[0]!.action).toBe('promote');
    expect(decisions[0]!.fromTier).toBe('probabilistic');
    expect(decisions[0]!.toTier).toBe('pragmatic');
  });

  test('low LB + ≥20 trials → demote one rung', () => {
    const decisions = decideTierGraduations({
      rows: [makeRow({ skillId: 'a/x', successes: 2, failures: 18 })],
      currentTierBySkill: new Map([['a/x', 'heuristic' as ConfidenceTier]]),
      cooldownState: new Map(),
      currentRun: 1,
    });
    expect(decisions).toHaveLength(1);
    expect(decisions[0]!.action).toBe('demote');
    expect(decisions[0]!.fromTier).toBe('heuristic');
    expect(decisions[0]!.toTier).toBe('pragmatic');
  });

  test('speculative + low LB → quarantine (status, not tier)', () => {
    const decisions = decideTierGraduations({
      rows: [makeRow({ skillId: 'a/x', successes: 0, failures: 25 })],
      currentTierBySkill: new Map([['a/x', 'speculative' as ConfidenceTier]]),
      cooldownState: new Map(),
      currentRun: 1,
    });
    expect(decisions).toHaveLength(1);
    expect(decisions[0]!.action).toBe('quarantine');
    expect(decisions[0]!.toTier).toBeNull();
  });

  test('deterministic + high LB → no decision (already at top)', () => {
    const decisions = decideTierGraduations({
      rows: [makeRow({ skillId: 'a/x', successes: 100, failures: 0 })],
      currentTierBySkill: new Map([['a/x', 'deterministic' as ConfidenceTier]]),
      cooldownState: new Map(),
      currentRun: 1,
    });
    expect(decisions).toHaveLength(0);
  });

  test('sub-threshold trials (29 successes) → no decision', () => {
    expect(MIN_TRIALS_PROMOTE).toBe(30);
    const decisions = decideTierGraduations({
      rows: [makeRow({ skillId: 'a/x', successes: 29, failures: 0 })],
      currentTierBySkill: new Map([['a/x', 'probabilistic' as ConfidenceTier]]),
      cooldownState: new Map(),
      currentRun: 1,
    });
    expect(decisions).toHaveLength(0);
  });

  test('cooldown blocks re-graduation within MIN_COOLDOWN_RUNS', () => {
    const decisions = decideTierGraduations({
      rows: [makeRow({ skillId: 'a/x', successes: 30, failures: 0 })],
      currentTierBySkill: new Map([['a/x', 'probabilistic' as ConfidenceTier]]),
      cooldownState: new Map([['a/x', 1]]),
      currentRun: 1 + (MIN_COOLDOWN_RUNS - 1),
    });
    expect(decisions).toHaveLength(0);
  });

  test('cooldown elapsed → eligible again', () => {
    const decisions = decideTierGraduations({
      rows: [makeRow({ skillId: 'a/x', successes: 30, failures: 0 })],
      currentTierBySkill: new Map([['a/x', 'probabilistic' as ConfidenceTier]]),
      cooldownState: new Map([['a/x', 1]]),
      currentRun: 1 + MIN_COOLDOWN_RUNS,
    });
    expect(decisions).toHaveLength(1);
    expect(decisions[0]!.action).toBe('promote');
  });

  test('skill missing from currentTierBySkill is skipped', () => {
    const decisions = decideTierGraduations({
      rows: [makeRow({ skillId: 'a/missing', successes: 30, failures: 0 })],
      currentTierBySkill: new Map(), // empty — applier hasn't seen this skill on disk
      cooldownState: new Map(),
      currentRun: 1,
    });
    expect(decisions).toHaveLength(0);
  });

  test('multiple rows per skill: best-evidence wins (highest |LB - 0.5|)', () => {
    const decisions = decideTierGraduations({
      rows: [
        makeRow({ skillId: 'a/x', taskSignature: 'sig-A', successes: 30, failures: 0 }), // LB ~0.86
        makeRow({ skillId: 'a/x', taskSignature: 'sig-B', successes: 60, failures: 0 }), // LB ~0.94 (stronger)
      ],
      currentTierBySkill: new Map([['a/x', 'probabilistic' as ConfidenceTier]]),
      cooldownState: new Map(),
      currentRun: 1,
    });
    expect(decisions).toHaveLength(1);
    expect(decisions[0]!.taskSignature).toBe('sig-B');
  });
});

describe('applyTierGraduations', () => {
  let dir: string;
  let store: SkillArtifactStore;
  let db: Database;
  let ledger: SkillTrustLedgerStore;

  function makeSkillMd(opts: {
    id: string;
    tier?: ConfidenceTier;
    status?: 'probation' | 'active' | 'demoted' | 'quarantined' | 'retired';
  }): string {
    const tier = opts.tier ?? 'probabilistic';
    const status = opts.status ?? 'active';
    const hashLine = tier === 'deterministic' ? `\ncontent_hash: sha256:${'a'.repeat(64)}` : '';
    return `---
id: ${opts.id}
name: ${opts.id}
version: 1.0.0
description: fixture for ${opts.id}
confidence_tier: ${tier}
origin: local
status: ${status}${hashLine}
requires_toolsets: []
provides_capabilities:
  - id: lang.typescript
---

## Overview

Fixture skill for tier graduation tests.

## When to use

Whenever needed.

## Procedure

1. step
`;
  }

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'tier-grad-'));
    mkdirSync(dir, { recursive: true });
    store = new SkillArtifactStore({ rootDir: dir });
    db = new Database(':memory:');
    db.exec(SKILL_OUTCOME_SCHEMA_SQL);
    // The trust ledger schema lives in the squashed initial migration; for
    // this test we just create the table inline.
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
    ledger = new SkillTrustLedgerStore(db);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    db.close();
  });

  test('promote: rewrites SKILL.md with new tier + recomputed hash + ledger row', async () => {
    await store.write(parseSkillMd(makeSkillMd({ id: 'a/x', tier: 'probabilistic' })));
    const before = await store.read('a/x');
    const oldHash = before.contentHash;

    const result = await applyTierGraduations(
      [
        {
          skillId: 'a/x',
          personaId: 'developer',
          taskSignature: 'sig',
          action: 'promote',
          fromTier: 'probabilistic',
          toTier: 'pragmatic',
          wilsonLB: 0.86,
          trials: 30,
          successes: 30,
          failures: 0,
        },
      ],
      { artifactStore: store, ledger, profile: 'test' },
    );
    expect(result.applied).toHaveLength(1);
    expect(result.skipped).toHaveLength(0);

    // SKILL.md round-trip carries the new tier + new hash.
    const after = await store.read('a/x');
    expect(after.frontmatter.confidence_tier).toBe('pragmatic');
    expect(after.contentHash).not.toBe(oldHash);

    // Ledger row references both hashes + the rule id.
    const history = ledger.history('a/x', { profile: 'test' });
    expect(history).toHaveLength(1);
    expect(history[0]!.event).toBe('promoted');
    expect(history[0]!.fromTier).toBe('probabilistic');
    expect(history[0]!.toTier).toBe('pragmatic');
    expect(history[0]!.ruleId).toBe(TIER_GRADUATION_RULE_ID);
    const ev = history[0]!.evidence as { oldHash: string; newHash: string };
    expect(ev.oldHash).toBe(oldHash);
    expect(ev.newHash).toBe(after.contentHash);
  });

  test('quarantine: status flips, tier stays at speculative', async () => {
    await store.write(parseSkillMd(makeSkillMd({ id: 'a/y', tier: 'speculative', status: 'active' })));

    const result = await applyTierGraduations(
      [
        {
          skillId: 'a/y',
          personaId: 'developer',
          taskSignature: 'sig',
          action: 'quarantine',
          fromTier: 'speculative',
          toTier: null,
          wilsonLB: 0.0,
          trials: 25,
          successes: 0,
          failures: 25,
        },
      ],
      { artifactStore: store, ledger, profile: 'test' },
    );
    expect(result.applied).toHaveLength(1);

    const after = await store.read('a/y');
    expect(after.frontmatter.confidence_tier).toBe('speculative');
    expect(after.frontmatter.status).toBe('quarantined');

    const history = ledger.history('a/y', { profile: 'test' });
    expect(history).toHaveLength(1);
    expect(history[0]!.event).toBe('demoted');
    expect(history[0]!.toStatus).toBe('quarantined');
  });

  test('missing artifact → recorded as skipped, not thrown', async () => {
    const result = await applyTierGraduations(
      [
        {
          skillId: 'a/missing',
          personaId: 'developer',
          taskSignature: 'sig',
          action: 'promote',
          fromTier: 'probabilistic',
          toTier: 'pragmatic',
          wilsonLB: 0.9,
          trials: 30,
          successes: 30,
          failures: 0,
        },
      ],
      { artifactStore: store, ledger, profile: 'test' },
    );
    expect(result.applied).toHaveLength(0);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]!.reason).toBe('skill-artifact-not-found');
  });

  test('one decision failing does not block siblings (A9)', async () => {
    await store.write(parseSkillMd(makeSkillMd({ id: 'a/good', tier: 'probabilistic' })));

    const result = await applyTierGraduations(
      [
        {
          skillId: 'a/missing',
          personaId: 'developer',
          taskSignature: 'sig',
          action: 'promote',
          fromTier: 'probabilistic',
          toTier: 'pragmatic',
          wilsonLB: 0.9,
          trials: 30,
          successes: 30,
          failures: 0,
        },
        {
          skillId: 'a/good',
          personaId: 'developer',
          taskSignature: 'sig',
          action: 'promote',
          fromTier: 'probabilistic',
          toTier: 'pragmatic',
          wilsonLB: 0.9,
          trials: 30,
          successes: 30,
          failures: 0,
        },
      ],
      { artifactStore: store, ledger, profile: 'test' },
    );
    expect(result.applied).toHaveLength(1);
    expect(result.applied[0]!.skillId).toBe('a/good');
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]!.decision.skillId).toBe('a/missing');
  });
});
