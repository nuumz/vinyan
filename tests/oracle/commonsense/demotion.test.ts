/**
 * Tests for Appendix C #6 — Override-rate demotion.
 *
 * Migration 011 adds telemetry columns (firing_count, override_count,
 * last_fired_at, retired_at). Registry exposes:
 *   - recordFiring / recordOverride — bulk counter updates
 *   - evaluateDemotion              — pure check of counters
 *   - retire                        — sets retired_at
 *   - isRetired                     — query
 *   - findApplicable / findActive   — exclude retired rules
 *
 * Demotion criterion: firing_count ≥ 100 AND override_rate > 0.5.
 */
import { Database } from 'bun:sqlite';
import { beforeEach, describe, expect, test } from 'bun:test';
import { migration010 } from '../../../src/db/migrations/010_commonsense_rules.ts';
import { migration011 } from '../../../src/db/migrations/011_commonsense_rule_telemetry.ts';
import {
  CommonSenseRegistry,
  DEFAULT_DEMOTION_CONFIG,
} from '../../../src/oracle/commonsense/registry.ts';
import type { CommonSenseRuleInput } from '../../../src/oracle/commonsense/types.ts';

let db: Database;
let registry: CommonSenseRegistry;

beforeEach(() => {
  db = new Database(':memory:');
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (
      version INTEGER PRIMARY KEY, description TEXT NOT NULL, applied_at INTEGER NOT NULL
    );
  `);
  migration010.up(db);
  migration011.up(db);
  registry = new CommonSenseRegistry(db);
});

function makeRule(overrides: Partial<CommonSenseRuleInput> = {}): CommonSenseRuleInput {
  return {
    microtheory: { language: 'universal', domain: 'universal', action: 'universal' },
    pattern: { kind: 'exact-match', target_field: 'command', value: 'foo' },
    default_outcome: 'allow',
    priority: 50,
    confidence: 0.6,
    source: 'innate',
    rationale: 'test',
    ...overrides,
  };
}

describe('migration011', () => {
  test('idempotent — applying twice does not throw', () => {
    expect(() => migration011.up(db)).not.toThrow();
    expect(() => migration011.up(db)).not.toThrow();
  });

  test('adds firing_count, override_count, last_fired_at, retired_at columns', () => {
    const cols = db.query(`PRAGMA table_info(commonsense_rules)`).all() as Array<{ name: string }>;
    const names = new Set(cols.map((c) => c.name));
    expect(names.has('firing_count')).toBe(true);
    expect(names.has('override_count')).toBe(true);
    expect(names.has('last_fired_at')).toBe(true);
    expect(names.has('retired_at')).toBe(true);
  });

  test('new rules start with zeroed counters', () => {
    const r = registry.insertRule(makeRule());
    const round = registry.findById(r.id);
    expect(round?.firing_count).toBe(0);
    expect(round?.override_count).toBe(0);
    expect(round?.last_fired_at).toBeNull();
    expect(round?.retired_at).toBeNull();
  });
});

describe('recordFiring', () => {
  test('increments firing_count and sets last_fired_at', () => {
    const r = registry.insertRule(makeRule());
    registry.recordFiring([r.id]);
    const round = registry.findById(r.id);
    expect(round?.firing_count).toBe(1);
    expect(round?.last_fired_at).toBeGreaterThan(0);
  });

  test('bulk update increments counter once per call', () => {
    const r = registry.insertRule(makeRule());
    registry.recordFiring([r.id, r.id, r.id]);
    expect(registry.findById(r.id)?.firing_count).toBe(3);
  });

  test('no-op on empty array', () => {
    const r = registry.insertRule(makeRule());
    registry.recordFiring([]);
    expect(registry.findById(r.id)?.firing_count).toBe(0);
  });

  test('no-op for unknown rule ids', () => {
    registry.recordFiring(['0'.repeat(64)]);
    // No throw, no row changed
    expect(registry.count()).toBe(0);
  });
});

describe('recordOverride', () => {
  test('increments override_count', () => {
    const r = registry.insertRule(makeRule());
    registry.recordOverride([r.id]);
    expect(registry.findById(r.id)?.override_count).toBe(1);
  });

  test('does NOT increment firing_count', () => {
    const r = registry.insertRule(makeRule());
    registry.recordOverride([r.id]);
    expect(registry.findById(r.id)?.firing_count).toBe(0);
  });
});

describe('evaluateDemotion', () => {
  test('returns shouldDemote=false when firing_count below threshold', () => {
    const r = registry.insertRule(makeRule());
    registry.recordFiring(Array(50).fill(r.id));
    registry.recordOverride(Array(40).fill(r.id)); // 80% override rate
    const round = registry.findById(r.id)!;
    const eval_ = registry.evaluateDemotion(round);
    expect(eval_.shouldDemote).toBe(false);
    expect(eval_.reason).toContain('insufficient sample');
  });

  test('returns shouldDemote=false when override_rate below threshold', () => {
    const r = registry.insertRule(makeRule());
    registry.recordFiring(Array(120).fill(r.id));
    registry.recordOverride(Array(40).fill(r.id)); // 33% override rate
    const round = registry.findById(r.id)!;
    const eval_ = registry.evaluateDemotion(round);
    expect(eval_.shouldDemote).toBe(false);
    expect(eval_.overrideRate).toBeCloseTo(0.333, 2);
  });

  test('returns shouldDemote=true when both gates exceeded', () => {
    const r = registry.insertRule(makeRule());
    registry.recordFiring(Array(150).fill(r.id));
    registry.recordOverride(Array(80).fill(r.id)); // 53% override rate
    const round = registry.findById(r.id)!;
    const eval_ = registry.evaluateDemotion(round);
    expect(eval_.shouldDemote).toBe(true);
    expect(eval_.firingCount).toBe(150);
    expect(eval_.overrideCount).toBe(80);
    expect(eval_.overrideRate).toBeCloseTo(0.533, 2);
  });

  test('honors custom config', () => {
    const r = registry.insertRule(makeRule());
    registry.recordFiring(Array(20).fill(r.id));
    registry.recordOverride(Array(15).fill(r.id)); // 75% override rate
    const round = registry.findById(r.id)!;
    // Default would not demote (firing_count < 100)
    expect(registry.evaluateDemotion(round).shouldDemote).toBe(false);
    // Custom config with lower threshold demotes
    const eval_ = registry.evaluateDemotion(round, {
      minFiringsForDemotion: 10,
      overrideRateThreshold: 0.5,
    });
    expect(eval_.shouldDemote).toBe(true);
  });

  test('uses default thresholds at exact boundary', () => {
    expect(DEFAULT_DEMOTION_CONFIG.minFiringsForDemotion).toBe(100);
    expect(DEFAULT_DEMOTION_CONFIG.overrideRateThreshold).toBe(0.5);
  });
});

describe('retire + isRetired', () => {
  test('retire sets retired_at and isRetired returns true', () => {
    const r = registry.insertRule(makeRule());
    expect(registry.isRetired(r.id)).toBe(false);
    expect(registry.retire(r.id)).toBe(true);
    expect(registry.isRetired(r.id)).toBe(true);
  });

  test('retire is idempotent — second call still returns true', () => {
    const r = registry.insertRule(makeRule());
    expect(registry.retire(r.id)).toBe(true);
    expect(registry.retire(r.id)).toBe(true); // updates retired_at to new time, but row still changes
  });

  test('retire returns false for unknown id', () => {
    expect(registry.retire('0'.repeat(64))).toBe(false);
  });

  test('retired rules excluded from findApplicable', () => {
    const r = registry.insertRule(makeRule());
    expect(
      registry.findApplicable({ language: 'universal', domain: 'universal', action: 'universal' })
        .length,
    ).toBe(1);
    registry.retire(r.id);
    expect(
      registry.findApplicable({ language: 'universal', domain: 'universal', action: 'universal' })
        .length,
    ).toBe(0);
  });

  test('retired rules excluded from findActive', () => {
    const r1 = registry.insertRule(makeRule({ pattern: { kind: 'exact-match', target_field: 'command', value: 'a' } }));
    registry.insertRule(makeRule({ pattern: { kind: 'exact-match', target_field: 'command', value: 'b' } }));
    expect(registry.findActive().length).toBe(2);
    registry.retire(r1.id);
    expect(registry.findActive().length).toBe(1);
  });
});

describe('end-to-end demotion lifecycle', () => {
  test('rule fires N times, gets overridden, sleep-cycle-style sweep retires it', () => {
    const r = registry.insertRule(makeRule());
    // Simulate 120 firings, 70 overridden by deterministic oracle
    registry.recordFiring(Array(120).fill(r.id));
    registry.recordOverride(Array(70).fill(r.id));

    // Sleep-cycle-style sweep: iterate active rules, demote if criterion met
    let demoted = 0;
    for (const rule of registry.findActive()) {
      const eval_ = registry.evaluateDemotion(rule);
      if (eval_.shouldDemote) {
        registry.retire(rule.id);
        demoted++;
      }
    }
    expect(demoted).toBe(1);
    expect(registry.isRetired(r.id)).toBe(true);
    // Subsequent activation queries skip the retired rule
    expect(
      registry.findApplicable({ language: 'universal', domain: 'universal', action: 'universal' })
        .length,
    ).toBe(0);
  });

  test('rule not yet at sample threshold survives sweep', () => {
    const r = registry.insertRule(makeRule());
    registry.recordFiring(Array(50).fill(r.id));
    registry.recordOverride(Array(40).fill(r.id)); // 80% but only 50 firings

    for (const rule of registry.findActive()) {
      const eval_ = registry.evaluateDemotion(rule);
      if (eval_.shouldDemote) registry.retire(rule.id);
    }
    expect(registry.isRetired(r.id)).toBe(false);
  });
});
