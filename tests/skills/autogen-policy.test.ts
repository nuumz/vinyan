/**
 * R1 — adaptive autogenerator threshold policy contract.
 *
 * Verifies:
 *   - empty store collapses to baseline (3) clamped to [MIN, MAX]
 *   - high pendingCount raises the threshold deterministically
 *   - high quarantineRate adds the safety bump
 *   - high acceptanceRate + low pending lowers the threshold (eager
 *     operator)
 *   - feature flag `enabled: false` returns staticThreshold verbatim
 *   - explanation string is deterministic for the same inputs (A3)
 *   - parameter ledger persists every change with provenance
 *   - readPersistedThreshold round-trips through the ledger
 *   - floor / ceiling clamps survive aggressive signals
 */
import { Database } from 'bun:sqlite';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { ALL_MIGRATIONS, MigrationRunner } from '../../src/db/migrations/index.ts';
import { ParameterLedger } from '../../src/orchestrator/adaptive-params/parameter-ledger.ts';
import { SkillProposalStore } from '../../src/db/skill-proposal-store.ts';
import {
  AUTOGEN_THRESHOLD_PARAM_NAME,
  computeAdaptiveThreshold,
  MAX_THRESHOLD,
  MIN_THRESHOLD,
  readPersistedThreshold,
  recordThresholdChange,
} from '../../src/skills/autogen-policy.ts';

let db: Database;
let store: SkillProposalStore;
let ledger: ParameterLedger;

beforeAll(() => {
  db = new Database(':memory:');
  db.exec('PRAGMA journal_mode = WAL');
  new MigrationRunner().migrate(db, ALL_MIGRATIONS);
  store = new SkillProposalStore(db);
  ledger = new ParameterLedger(db);
});

afterAll(() => {
  db.close();
});

const SAFE_MD = `# safe-skill\nUse for refactor.\n## Steps\n1. Do thing.\n`;
const DANGEROUS_MD = `# danger\nexport OPENAI_API_KEY=sk-secrettokenxxxxxxxxxxxxxxxxxxxxxxx\n`;

describe('computeAdaptiveThreshold', () => {
  test('empty store falls to baseline 3 (within MIN/MAX)', () => {
    const snap = computeAdaptiveThreshold(store, 'policy-empty');
    expect(snap.threshold).toBe(3);
    expect(snap.threshold).toBeGreaterThanOrEqual(MIN_THRESHOLD);
    expect(snap.threshold).toBeLessThanOrEqual(MAX_THRESHOLD);
    expect(snap.signals.pendingCount).toBe(0);
    expect(snap.enabled).toBe(true);
  });

  test('disabled flag returns staticThreshold verbatim', () => {
    const snap = computeAdaptiveThreshold(store, 'policy-disabled', {
      enabled: false,
      staticThreshold: 4,
    });
    expect(snap.threshold).toBe(4);
    expect(snap.explanation).toContain('disabled');
  });

  test('staticThreshold is clamped to floor/ceiling even when disabled', () => {
    const low = computeAdaptiveThreshold(store, 'policy-low', {
      enabled: false,
      staticThreshold: 1,
    });
    expect(low.threshold).toBe(MIN_THRESHOLD);

    const high = computeAdaptiveThreshold(store, 'policy-high', {
      enabled: false,
      staticThreshold: 99,
    });
    expect(high.threshold).toBe(MAX_THRESHOLD);
  });

  test('high pendingCount raises threshold (queue pressure)', () => {
    // Seed 25 pending proposals.
    for (let i = 0; i < 25; i += 1) {
      store.create({
        profile: 'policy-flood',
        proposedName: `flood-${i}`,
        proposedCategory: 'test',
        skillMd: SAFE_MD,
      });
    }
    const snap = computeAdaptiveThreshold(store, 'policy-flood');
    // baseline 3 + 2 (queue pressure clamp) = 5.
    expect(snap.threshold).toBe(5);
    expect(snap.signals.pendingCount).toBe(25);
    expect(snap.explanation).toContain('queue depth 25');
  });

  test('high quarantineRate adds safety bump', () => {
    // 5 quarantined, 5 pending → quarantine rate = 50% → +1.
    for (let i = 0; i < 5; i += 1) {
      store.create({
        profile: 'policy-quarantine',
        proposedName: `qq-${i}`,
        proposedCategory: 'test',
        skillMd: DANGEROUS_MD,
      });
    }
    for (let i = 0; i < 5; i += 1) {
      store.create({
        profile: 'policy-quarantine',
        proposedName: `pp-${i}`,
        proposedCategory: 'test',
        skillMd: SAFE_MD,
      });
    }
    const snap = computeAdaptiveThreshold(store, 'policy-quarantine');
    expect(snap.signals.quarantineRate).toBeGreaterThanOrEqual(0.4);
    // baseline 3 + 1 (queue pressure floor → 0 since 10 pending) +
    //   1 (safety pressure) = 4. Or 3 + 1 + 1 = 5 if pending crosses 10.
    expect(snap.threshold).toBeGreaterThanOrEqual(4);
  });

  test('eager operator (high acceptance + low pending) lowers threshold', () => {
    // Create 4 safe pending, then approve all of them → totalDecided=4,
    // approved=4, pending=0. acceptanceRate=1.0, pendingCount<3.
    const ids: string[] = [];
    for (let i = 0; i < 4; i += 1) {
      const p = store.create({
        profile: 'policy-eager',
        proposedName: `ee-${i}`,
        proposedCategory: 'test',
        skillMd: SAFE_MD,
      });
      ids.push(p.id);
    }
    for (const id of ids) {
      store.approve(id, 'policy-eager', 'tester', 'looks fine');
    }
    const snap = computeAdaptiveThreshold(store, 'policy-eager');
    expect(snap.signals.acceptanceRate).toBe(1);
    expect(snap.signals.pendingCount).toBeLessThan(3);
    // baseline 3 - 1 (eager bonus) = 2 (clamped).
    expect(snap.threshold).toBe(2);
  });

  test('explanation deterministic for identical store state', () => {
    const a = computeAdaptiveThreshold(store, 'policy-determ', { enabled: true });
    const b = computeAdaptiveThreshold(store, 'policy-determ', { enabled: true });
    expect(a.threshold).toBe(b.threshold);
    expect(a.explanation).toBe(b.explanation);
    expect(a.signals).toEqual(b.signals);
  });
});

describe('parameter ledger integration', () => {
  test('threshold change appended to ledger with provenance', () => {
    const oldThreshold = 3;
    const snap = computeAdaptiveThreshold(store, 'policy-ledger', {
      enabled: false,
      staticThreshold: 5,
    });
    const recorded = recordThresholdChange(ledger, oldThreshold, snap, 'unit-test');
    expect(recorded).toBe(true);
    const persisted = readPersistedThreshold(ledger);
    expect(persisted).toBe(5);
    const history = ledger.history(AUTOGEN_THRESHOLD_PARAM_NAME, 5);
    expect(history.length).toBeGreaterThanOrEqual(1);
    expect(history[0]?.reason).toContain('unit-test');
    expect(history[0]?.ownerModule).toBe('skill-autogen-policy');
  });

  test('no-op change does not append a row', () => {
    const before = ledger.history(AUTOGEN_THRESHOLD_PARAM_NAME, 50).length;
    const snap = computeAdaptiveThreshold(store, 'policy-ledger', {
      enabled: false,
      staticThreshold: 5,
    });
    const recorded = recordThresholdChange(ledger, 5, snap, 'unit-test no-op');
    expect(recorded).toBe(false);
    const after = ledger.history(AUTOGEN_THRESHOLD_PARAM_NAME, 50).length;
    expect(after).toBe(before);
  });

  test('readPersistedThreshold returns null when no ledger row', () => {
    const freshDb = new Database(':memory:');
    new MigrationRunner().migrate(freshDb, ALL_MIGRATIONS);
    const freshLedger = new ParameterLedger(freshDb);
    expect(readPersistedThreshold(freshLedger)).toBeNull();
    freshDb.close();
  });

  test('persisted threshold respects floor/ceiling on read', () => {
    const freshDb = new Database(':memory:');
    new MigrationRunner().migrate(freshDb, ALL_MIGRATIONS);
    const freshLedger = new ParameterLedger(freshDb);
    // Persist an out-of-range value directly.
    freshLedger.append({
      paramName: AUTOGEN_THRESHOLD_PARAM_NAME,
      oldValue: 3,
      newValue: 99,
      reason: 'boundary test',
      ownerModule: 'test',
    });
    expect(readPersistedThreshold(freshLedger)).toBe(MAX_THRESHOLD);
    freshDb.close();
  });
});
