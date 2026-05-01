/**
 * ParameterStore + ParameterRegistry + ParameterLedger — round-trip + validation.
 */
import { Database } from 'bun:sqlite';
import { beforeEach, describe, expect, test } from 'bun:test';
import { migration001 } from '../../../src/db/migrations/001_initial_schema.ts';
import { migration030 } from '../../../src/db/migrations/030_parameter_ledger.ts';
import { MigrationRunner } from '../../../src/db/migrations/migration-runner.ts';
import {
  getParameterDef,
  listParameterDefs,
  ParameterLedger,
  ParameterStore,
  validateParameterValue,
} from '../../../src/orchestrator/adaptive-params/index.ts';

function freshDb(): Database {
  const db = new Database(':memory:');
  new MigrationRunner().migrate(db, [migration001, migration030]);
  return db;
}

describe('ParameterRegistry — definitions', () => {
  test('every registered parameter has a non-empty key + axiom + owner', () => {
    const defs = listParameterDefs();
    expect(defs.length).toBeGreaterThan(5);
    for (const def of defs) {
      expect(def.key.length).toBeGreaterThan(0);
      expect(def.axiom.length).toBeGreaterThan(0);
      expect(def.owner.length).toBeGreaterThan(0);
      expect(def.description.length).toBeGreaterThan(0);
    }
  });

  test('top-10 high-impact parameters are registered', () => {
    const required = [
      'intent.deterministic_skip_threshold',
      'intent.cache_ttl_ms',
      'intent.llm_uncertain_threshold',
      'risk_router.thresholds',
      'sleep_cycle.pattern_min_frequency',
      'sleep_cycle.pattern_min_confidence',
      'oracle.circuit_breaker_failure_threshold',
      'oracle.circuit_breaker_reset_timeout_ms',
      'memory.recency_half_life_ms',
      'working_memory.max_failed_approaches',
    ];
    for (const key of required) {
      expect(getParameterDef(key)).toBeDefined();
    }
  });

  test('Phase-A expansion: working memory + sleep-cycle promotion + critic debate + autonomous skills + approval + retention', () => {
    const expansion = [
      'working_memory.max_hypotheses',
      'working_memory.max_uncertainties',
      'sleep_cycle.promotion_wilson_threshold',
      'sleep_cycle.promotion_min_observations',
      'critic.debate_trigger_risk_threshold',
      'autonomous_skills.gate_confidence_floor',
      'approval.timeout_ms',
      'world_graph.retention_max_age_days',
      'world_graph.retention_max_fact_count',
    ];
    for (const key of expansion) {
      const def = getParameterDef(key);
      expect(def).toBeDefined();
      expect(def?.tunable).toBe(true);
      expect(def?.range).toBeDefined();
    }
  });

  test('validateParameterValue rejects out-of-range numbers', () => {
    const def = getParameterDef('intent.deterministic_skip_threshold')!;
    expect(validateParameterValue(def, 0.5).ok).toBe(true);
    expect(validateParameterValue(def, 1.5).ok).toBe(false);
    expect(validateParameterValue(def, -0.1).ok).toBe(false);
    expect(validateParameterValue(def, 'x').ok).toBe(false);
  });

  test('validateParameterValue accepts well-formed number-record', () => {
    const def = getParameterDef('risk_router.thresholds')!;
    expect(validateParameterValue(def, { l0: 0.1, l1: 0.5, l2: 0.8 }).ok).toBe(true);
    expect(validateParameterValue(def, { l0: 0.1, l1: 0.5 }).ok).toBe(false); // missing field
    expect(validateParameterValue(def, { l0: 'x', l1: 0.5, l2: 0.8 }).ok).toBe(false);
  });
});

describe('ParameterStore — read fallback', () => {
  test('returns registry default when no override + no ledger', () => {
    const store = new ParameterStore();
    expect(store.getNumber('intent.deterministic_skip_threshold')).toBe(0.85);
    expect(store.getDurationMs('intent.cache_ttl_ms')).toBe(30_000);
    expect(store.getInteger('working_memory.max_failed_approaches')).toBe(20);
  });

  test('override takes precedence over default', () => {
    const store = new ParameterStore({
      overrides: new Map([['intent.deterministic_skip_threshold', 0.7]]),
    });
    expect(store.getNumber('intent.deterministic_skip_threshold')).toBe(0.7);
    const desc = store.describe('intent.deterministic_skip_threshold');
    expect(desc.source).toBe('override');
  });

  test('record types — getRecord returns full record', () => {
    const store = new ParameterStore();
    const rec = store.getRecord('risk_router.thresholds');
    expect(rec.l0).toBe(0.2);
    expect(rec.l1).toBe(0.4);
    expect(rec.l2).toBe(0.7);
  });

  test('throws on unknown key', () => {
    const store = new ParameterStore();
    expect(() => store.getNumber('intent.nonexistent_key')).toThrow(/unknown parameter/);
  });

  test('throws on type mismatch (asking for number on a record param)', () => {
    const store = new ParameterStore();
    expect(() => store.getNumber('risk_router.thresholds')).toThrow(/expected one of/);
  });
});

describe('ParameterStore + Ledger — write path', () => {
  test('set() appends ledger row, updates cache, emits event', () => {
    const db = freshDb();
    const ledger = new ParameterLedger(db, { clock: () => 1_700_000_000_000 });
    const events: unknown[] = [];
    const fakeBus = {
      emit: (_name: string, payload: unknown) => events.push(payload),
    } as never;
    const store = new ParameterStore({ ledger, bus: fakeBus });
    const result = store.set(
      'intent.deterministic_skip_threshold',
      0.78,
      'sleep-cycle observed prediction error decrease at 0.78',
      'sleep-cycle',
    );
    expect(result.ok).toBe(true);
    expect(store.getNumber('intent.deterministic_skip_threshold')).toBe(0.78);
    expect(events.length).toBe(1);

    // History accessible.
    const history = ledger.history('intent.deterministic_skip_threshold');
    expect(history.length).toBe(1);
    expect(history[0]?.newValue).toBe(0.78);
    expect(history[0]?.ownerModule).toBe('sleep-cycle');
  });

  test('set() rejects out-of-range values', () => {
    const store = new ParameterStore();
    const result = store.set(
      'intent.deterministic_skip_threshold',
      1.5,
      'experimental',
      'test',
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain('out of range');
    }
  });

  test('set() rejects unknown key', () => {
    const store = new ParameterStore();
    const result = store.set('nope.unknown', 1, 'x', 'test');
    expect(result.ok).toBe(false);
  });

  test('latest ledger row is replayed on subsequent reads (new store instance)', () => {
    const db = freshDb();
    const ledger = new ParameterLedger(db);
    const store1 = new ParameterStore({ ledger });
    store1.set('memory.recency_half_life_ms', 7 * 24 * 60 * 60 * 1000, 'tighter recall', 'op');

    // Fresh store instance — should read from ledger.
    const store2 = new ParameterStore({ ledger });
    expect(store2.getDurationMs('memory.recency_half_life_ms')).toBe(7 * 24 * 60 * 60 * 1000);
    const desc = store2.describe('memory.recency_half_life_ms');
    expect(desc.source).toBe('ledger');
  });
});

describe('ParameterStore — snapshot + diagnostics', () => {
  test('snapshot returns every registered parameter with current value', () => {
    const store = new ParameterStore({
      overrides: new Map([['intent.deterministic_skip_threshold', 0.9]]),
    });
    const snap = store.snapshot();
    expect(snap.length).toBe(listParameterDefs().length);
    const intent = snap.find((s) => s.key === 'intent.deterministic_skip_threshold');
    expect(intent?.currentValue).toBe(0.9);
    expect(intent?.source).toBe('override');
  });
});
