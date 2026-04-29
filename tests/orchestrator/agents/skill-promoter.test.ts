/**
 * Tests for skill-promoter — Phase-6 acquired→bound proposer.
 *
 * Covers:
 *   - proposes when (persona, skill) clears Wilson LB threshold + min trials
 *   - skips when n < min trials (cold-start)
 *   - skips when already bound
 *   - aggregates across task signatures
 *   - applyPromotions persists to .vinyan/agents/<id>/skills.json
 *   - applyPromotions idempotent
 */
import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SKILL_OUTCOME_SCHEMA_SQL } from '../../../src/db/skill-outcome-schema.ts';
import { SkillOutcomeStore } from '../../../src/db/skill-outcome-store.ts';
import { loadBoundSkills, saveBoundSkills } from '../../../src/orchestrator/agents/persona-skill-loader.ts';
import { loadAgentRegistry } from '../../../src/orchestrator/agents/registry.ts';
import { applyPromotions, proposeAcquiredToBoundPromotions } from '../../../src/orchestrator/agents/skill-promoter.ts';

function setup() {
  const ws = mkdtempSync(join(tmpdir(), 'vinyan-promo-'));
  const db = new Database(':memory:');
  db.exec(SKILL_OUTCOME_SCHEMA_SQL);
  const store = new SkillOutcomeStore(db);
  const registry = loadAgentRegistry(ws, undefined, undefined, {});
  return { ws, store, registry, cleanup: () => rmSync(ws, { recursive: true, force: true }) };
}

describe('proposeAcquiredToBoundPromotions', () => {
  test('proposes when n ≥ 10 and Wilson LB ≥ 0.65', () => {
    const { ws, store, registry, cleanup } = setup();
    try {
      // 15/15 success → Wilson LB on 15 trials with all success ≈ 0.79 (≥ 0.65)
      for (let i = 0; i < 15; i++) {
        store.recordOutcome(
          { personaId: 'developer', skillId: 'typescript-coding', taskSignature: 'code::refactor' },
          'success',
          1000 + i,
        );
      }
      const proposals = proposeAcquiredToBoundPromotions(store, registry, ws);
      expect(proposals).toHaveLength(1);
      expect(proposals[0]?.personaId).toBe('developer');
      expect(proposals[0]?.skillId).toBe('typescript-coding');
      expect(proposals[0]?.wilsonLB).toBeGreaterThan(0.65);
    } finally {
      cleanup();
    }
  });

  test('skips when n < min trials', () => {
    const { ws, store, registry, cleanup } = setup();
    try {
      for (let i = 0; i < 5; i++) {
        store.recordOutcome(
          { personaId: 'developer', skillId: 'typescript-coding', taskSignature: 'code::refactor' },
          'success',
          1000 + i,
        );
      }
      expect(proposeAcquiredToBoundPromotions(store, registry, ws)).toHaveLength(0);
    } finally {
      cleanup();
    }
  });

  test('skips when LB < 0.65 (mostly failure)', () => {
    const { ws, store, registry, cleanup } = setup();
    try {
      for (let i = 0; i < 3; i++) {
        store.recordOutcome(
          { personaId: 'developer', skillId: 'typescript-coding', taskSignature: 'code::refactor' },
          'success',
          1000 + i,
        );
      }
      for (let i = 0; i < 12; i++) {
        store.recordOutcome(
          { personaId: 'developer', skillId: 'typescript-coding', taskSignature: 'code::refactor' },
          'failure',
          2000 + i,
        );
      }
      // 3/15 ≈ 0.2 success rate → LB much less than 0.65
      expect(proposeAcquiredToBoundPromotions(store, registry, ws)).toHaveLength(0);
    } finally {
      cleanup();
    }
  });

  test('skips when skill already bound (idempotency)', () => {
    const { ws, store, registry, cleanup } = setup();
    try {
      saveBoundSkills(ws, 'developer', [{ id: 'typescript-coding' }]);
      for (let i = 0; i < 15; i++) {
        store.recordOutcome(
          { personaId: 'developer', skillId: 'typescript-coding', taskSignature: 'code::refactor' },
          'success',
          1000 + i,
        );
      }
      expect(proposeAcquiredToBoundPromotions(store, registry, ws)).toHaveLength(0);
    } finally {
      cleanup();
    }
  });

  test('aggregates across task signatures', () => {
    const { ws, store, registry, cleanup } = setup();
    try {
      // 5 successes in code::refactor + 6 successes in code::add → 11/11 across signatures
      for (let i = 0; i < 5; i++) {
        store.recordOutcome(
          { personaId: 'developer', skillId: 'typescript-coding', taskSignature: 'code::refactor' },
          'success',
          1000 + i,
        );
      }
      for (let i = 0; i < 6; i++) {
        store.recordOutcome(
          { personaId: 'developer', skillId: 'typescript-coding', taskSignature: 'code::add' },
          'success',
          2000 + i,
        );
      }
      const proposals = proposeAcquiredToBoundPromotions(store, registry, ws);
      expect(proposals).toHaveLength(1);
      expect(proposals[0]?.successes).toBe(11);
    } finally {
      cleanup();
    }
  });
});

describe('applyPromotions', () => {
  test('persists to skills.json', () => {
    const { ws, cleanup } = setup();
    try {
      const applied = applyPromotions(ws, [
        {
          personaId: 'developer',
          skillId: 'typescript-coding',
          successes: 15,
          failures: 0,
          wilsonLB: 0.8,
          evidenceTaskSignature: 'code::refactor',
        },
      ]);
      expect(applied).toHaveLength(1);
      const bound = loadBoundSkills(ws, 'developer');
      expect(bound.map((r) => r.id)).toContain('typescript-coding');
    } finally {
      cleanup();
    }
  });

  test('preserves existing bindings', () => {
    const { ws, cleanup } = setup();
    try {
      saveBoundSkills(ws, 'developer', [{ id: 'react-patterns' }]);
      applyPromotions(ws, [
        {
          personaId: 'developer',
          skillId: 'typescript-coding',
          successes: 15,
          failures: 0,
          wilsonLB: 0.8,
          evidenceTaskSignature: 'code::refactor',
        },
      ]);
      const bound = loadBoundSkills(ws, 'developer')
        .map((r) => r.id)
        .sort();
      expect(bound).toEqual(['react-patterns', 'typescript-coding']);
    } finally {
      cleanup();
    }
  });

  test('idempotent — re-applying same proposals is a no-op', () => {
    const { ws, cleanup } = setup();
    try {
      const proposal = {
        personaId: 'developer',
        skillId: 'typescript-coding',
        successes: 15,
        failures: 0,
        wilsonLB: 0.8,
        evidenceTaskSignature: 'code::refactor',
      };
      const first = applyPromotions(ws, [proposal]);
      expect(first).toHaveLength(1);
      const second = applyPromotions(ws, [proposal]);
      expect(second).toHaveLength(0); // already bound
      expect(loadBoundSkills(ws, 'developer')).toHaveLength(1);
    } finally {
      cleanup();
    }
  });
});
