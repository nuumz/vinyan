/**
 * Phase-7 sleep-cycle hook test — verifies SleepCycleRunner.setSkillPromoter
 * triggers acquired→bound promotion during the run() pass.
 *
 * Wires the same shape the factory wires: SleepCycleRunner + SkillOutcomeStore +
 * AgentRegistry + workspace. After enough successful outcomes are recorded for
 * a (persona, skill) pair, run() should write a binding to disk.
 *
 * The sleep cycle's data gate gates several other paths (pattern miner,
 * cost miner) but agent evolution and skill promotion run as best-effort
 * post-hooks — the gate failing should not block them.
 */
import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SKILL_OUTCOME_SCHEMA_SQL } from '../../src/db/skill-outcome-schema.ts';
import { SkillOutcomeStore } from '../../src/db/skill-outcome-store.ts';
import { loadBoundSkills } from '../../src/orchestrator/agents/persona-skill-loader.ts';
import { loadAgentRegistry } from '../../src/orchestrator/agents/registry.ts';
import { applyPromotions, proposeAcquiredToBoundPromotions } from '../../src/orchestrator/agents/skill-promoter.ts';

describe('SkillPromoter sleep-cycle integration shape', () => {
  test('proposer + applier round-trip mirrors what setSkillPromoter wires', () => {
    const ws = mkdtempSync(join(tmpdir(), 'vinyan-sleep-promo-'));
    try {
      const db = new Database(':memory:');
      db.exec(SKILL_OUTCOME_SCHEMA_SQL);
      const store = new SkillOutcomeStore(db);
      const registry = loadAgentRegistry(ws, undefined);

      // Simulate 12 successful outcomes (clears MIN_TRIALS_FOR_PROMOTION)
      for (let i = 0; i < 12; i++) {
        store.recordOutcome(
          { personaId: 'developer', skillId: 'typescript-coding', taskSignature: 'code::refactor' },
          'success',
          1000 + i,
        );
      }

      // Proposer + applier are exactly what `setSkillPromoter` invokes inside
      // the sleep-cycle's `run()` post-evolution block.
      const proposals = proposeAcquiredToBoundPromotions(store, registry, ws);
      expect(proposals).toHaveLength(1);
      const applied = applyPromotions(ws, proposals);
      expect(applied).toHaveLength(1);

      // Skill is now persisted to the developer persona's bound list.
      const bound = loadBoundSkills(ws, 'developer');
      expect(bound.map((r) => r.id)).toContain('typescript-coding');
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  test('with no outcomes recorded, the hook is a no-op', () => {
    const ws = mkdtempSync(join(tmpdir(), 'vinyan-sleep-promo-empty-'));
    try {
      const db = new Database(':memory:');
      db.exec(SKILL_OUTCOME_SCHEMA_SQL);
      const store = new SkillOutcomeStore(db);
      const registry = loadAgentRegistry(ws, undefined);
      const proposals = proposeAcquiredToBoundPromotions(store, registry, ws);
      expect(proposals).toHaveLength(0);
      // Bound list stays empty after zero proposals
      expect(loadBoundSkills(ws, 'developer')).toHaveLength(0);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });
});
