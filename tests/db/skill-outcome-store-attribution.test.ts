/**
 * Phase-15 (M2 closure) — `recordSkillOutcomesFromBid` view-filtered attribution.
 *
 * Covers:
 *   - undefined viewed → equal-credit fallback (legacy)
 *   - empty viewed Set → equal-credit fallback (treated identically to undefined)
 *   - viewed-and-loaded credited; loaded-but-not-viewed gets nothing
 *   - viewed-but-not-loaded ignored (no spurious rows)
 *   - multi-skill mixed case
 *   - return value reflects credited count, not loaded count
 */
import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { SKILL_OUTCOME_SCHEMA_SQL } from '../../src/db/skill-outcome-schema.ts';
import { recordSkillOutcomesFromBid, SkillOutcomeStore } from '../../src/db/skill-outcome-store.ts';

function makeStore(): SkillOutcomeStore {
  const db = new Database(':memory:');
  db.exec(SKILL_OUTCOME_SCHEMA_SQL);
  return new SkillOutcomeStore(db);
}

const PERSONA = 'developer';
const SIG = 'code::refactor';

describe('recordSkillOutcomesFromBid — view-filtered attribution', () => {
  test('viewed undefined → equal credit on every loaded skill (legacy fallback)', () => {
    const store = makeStore();
    const credited = recordSkillOutcomesFromBid(
      store,
      { personaId: PERSONA, loadedSkillIds: ['ts', 'lint', 'refactor'] },
      SIG,
      'success',
      undefined,
    );
    expect(credited).toBe(3);
    for (const skillId of ['ts', 'lint', 'refactor']) {
      const row = store.getOutcome({ personaId: PERSONA, skillId, taskSignature: SIG });
      expect(row?.successes).toBe(1);
    }
  });

  test('viewed empty Set → equal credit (interchangeable with undefined)', () => {
    const store = makeStore();
    const credited = recordSkillOutcomesFromBid(
      store,
      { personaId: PERSONA, loadedSkillIds: ['ts', 'lint'] },
      SIG,
      'success',
      new Set<string>(),
    );
    expect(credited).toBe(2);
    expect(store.getOutcome({ personaId: PERSONA, skillId: 'ts', taskSignature: SIG })?.successes).toBe(1);
    expect(store.getOutcome({ personaId: PERSONA, skillId: 'lint', taskSignature: SIG })?.successes).toBe(1);
  });

  test('viewed-and-loaded → only intersection credited', () => {
    const store = makeStore();
    const credited = recordSkillOutcomesFromBid(
      store,
      { personaId: PERSONA, loadedSkillIds: ['ts', 'lint', 'refactor'] },
      SIG,
      'success',
      new Set(['ts', 'refactor']),
    );
    expect(credited).toBe(2);
    expect(store.getOutcome({ personaId: PERSONA, skillId: 'ts', taskSignature: SIG })?.successes).toBe(1);
    expect(store.getOutcome({ personaId: PERSONA, skillId: 'refactor', taskSignature: SIG })?.successes).toBe(1);
    // Loaded but not viewed → no row created.
    expect(store.getOutcome({ personaId: PERSONA, skillId: 'lint', taskSignature: SIG })).toBeNull();
  });

  test('viewed-but-not-loaded ignored — no spurious rows', () => {
    const store = makeStore();
    const credited = recordSkillOutcomesFromBid(
      store,
      { personaId: PERSONA, loadedSkillIds: ['ts'] },
      SIG,
      'success',
      // Persona viewed `ts` (in loadout) AND `external-tool` (NOT in loadout).
      new Set(['ts', 'external-tool']),
    );
    expect(credited).toBe(1);
    expect(store.getOutcome({ personaId: PERSONA, skillId: 'ts', taskSignature: SIG })?.successes).toBe(1);
    // External tool was viewed but never loaded — no row.
    expect(store.getOutcome({ personaId: PERSONA, skillId: 'external-tool', taskSignature: SIG })).toBeNull();
  });

  test('zero overlap → no credits (return 0)', () => {
    const store = makeStore();
    const credited = recordSkillOutcomesFromBid(
      store,
      { personaId: PERSONA, loadedSkillIds: ['ts', 'lint'] },
      SIG,
      'success',
      new Set(['unrelated']),
    );
    expect(credited).toBe(0);
    expect(store.getOutcome({ personaId: PERSONA, skillId: 'ts', taskSignature: SIG })).toBeNull();
    expect(store.getOutcome({ personaId: PERSONA, skillId: 'lint', taskSignature: SIG })).toBeNull();
  });

  test('failure outcome flows through filter the same as success', () => {
    const store = makeStore();
    const credited = recordSkillOutcomesFromBid(
      store,
      { personaId: PERSONA, loadedSkillIds: ['ts', 'lint', 'refactor'] },
      SIG,
      'failure',
      new Set(['refactor']),
    );
    expect(credited).toBe(1);
    expect(store.getOutcome({ personaId: PERSONA, skillId: 'refactor', taskSignature: SIG })?.failures).toBe(1);
    expect(store.getOutcome({ personaId: PERSONA, skillId: 'ts', taskSignature: SIG })).toBeNull();
  });

  test('no-op when personaId absent (legacy non-persona bids)', () => {
    const store = makeStore();
    const credited = recordSkillOutcomesFromBid(
      store,
      { loadedSkillIds: ['ts', 'lint'] },
      SIG,
      'success',
      new Set(['ts']),
    );
    expect(credited).toBe(0);
  });

  test('no-op when loadedSkillIds is empty (regardless of viewed)', () => {
    const store = makeStore();
    const credited = recordSkillOutcomesFromBid(
      store,
      { personaId: PERSONA, loadedSkillIds: [] },
      SIG,
      'success',
      new Set(['ts']),
    );
    expect(credited).toBe(0);
  });
});
