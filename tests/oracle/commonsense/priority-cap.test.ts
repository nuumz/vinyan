import { Database } from 'bun:sqlite';
import { beforeEach, describe, expect, test } from 'bun:test';
import { migration010 } from '../../../src/db/migrations/010_commonsense_rules.ts';
import { CommonSenseRegistry } from '../../../src/oracle/commonsense/registry.ts';
import type { CommonSenseRuleInput } from '../../../src/oracle/commonsense/types.ts';

let registry: CommonSenseRegistry;

beforeEach(() => {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY, description TEXT NOT NULL, applied_at INTEGER NOT NULL);`);
  migration010.up(db);
  registry = new CommonSenseRegistry(db);
});

function makeRule(overrides: Partial<CommonSenseRuleInput>): CommonSenseRuleInput {
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

describe('Registry priority caps — M4', () => {
  test('innate rules retain author-set priority', () => {
    const r = registry.insertRule(makeRule({ source: 'innate', priority: 95 }));
    expect(r.priority).toBe(95);
  });

  test('innate at floor 0 retained', () => {
    const r = registry.insertRule(
      makeRule({
        source: 'innate',
        priority: 0,
        pattern: { kind: 'exact-match', target_field: 'command', value: 'a' },
      }),
    );
    expect(r.priority).toBe(0);
  });

  test('configured rules clamp to [40, 80]', () => {
    const high = registry.insertRule(
      makeRule({ source: 'configured', priority: 95, pattern: { kind: 'exact-match', target_field: 'command', value: 'h' } }),
    );
    expect(high.priority).toBe(80);

    const low = registry.insertRule(
      makeRule({ source: 'configured', priority: 10, pattern: { kind: 'exact-match', target_field: 'command', value: 'l' } }),
    );
    expect(low.priority).toBe(40);

    const mid = registry.insertRule(
      makeRule({ source: 'configured', priority: 60, pattern: { kind: 'exact-match', target_field: 'command', value: 'm' } }),
    );
    expect(mid.priority).toBe(60);
  });

  test('promoted-from-pattern rules clamp to [30, 70]', () => {
    const high = registry.insertRule(
      makeRule({ source: 'promoted-from-pattern', priority: 95, pattern: { kind: 'exact-match', target_field: 'command', value: 'pH' } }),
    );
    expect(high.priority).toBe(70);

    const low = registry.insertRule(
      makeRule({ source: 'promoted-from-pattern', priority: 10, pattern: { kind: 'exact-match', target_field: 'command', value: 'pL' } }),
    );
    expect(low.priority).toBe(30);

    const mid = registry.insertRule(
      makeRule({ source: 'promoted-from-pattern', priority: 50, pattern: { kind: 'exact-match', target_field: 'command', value: 'pM' } }),
    );
    expect(mid.priority).toBe(50);
  });

  test('innate rule outranks promoted rule on same microtheory', () => {
    registry.insertRule(
      makeRule({
        source: 'innate',
        priority: 90,
        pattern: { kind: 'exact-match', target_field: 'command', value: 'inn' },
      }),
    );
    registry.insertRule(
      makeRule({
        source: 'promoted-from-pattern',
        priority: 95, // requested but capped to 70
        pattern: { kind: 'exact-match', target_field: 'command', value: 'pro' },
      }),
    );

    const hits = registry.findApplicable({
      language: 'universal',
      domain: 'universal',
      action: 'universal',
    });
    // findApplicable orders by priority DESC. Innate (90) > promoted-clamped (70).
    expect(hits[0]?.source).toBe('innate');
    expect(hits[0]?.priority).toBe(90);
    expect(hits[1]?.source).toBe('promoted-from-pattern');
    expect(hits[1]?.priority).toBe(70);
  });
});
