import { Database } from 'bun:sqlite';
import { beforeEach, describe, expect, test } from 'bun:test';
import { migration010 } from '../../../src/db/migrations/010_commonsense_rules.ts';
import { CommonSenseRegistry, computeRuleId } from '../../../src/oracle/commonsense/registry.ts';
import { INNATE_RULES, loadInnateSeed } from '../../../src/oracle/commonsense/seeds/innate.ts';
import type { CommonSenseRuleInput } from '../../../src/oracle/commonsense/types.ts';

let db: Database;
let registry: CommonSenseRegistry;

beforeEach(() => {
  db = new Database(':memory:');
  // Bootstrap schema_version table (migration runner expects it).
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (
      version INTEGER PRIMARY KEY, description TEXT NOT NULL, applied_at INTEGER NOT NULL
    );
  `);
  migration010.up(db);
  registry = new CommonSenseRegistry(db);
});

function makeRule(overrides: Partial<CommonSenseRuleInput> = {}): CommonSenseRuleInput {
  return {
    microtheory: { language: 'shell-bash', domain: 'filesystem', action: 'mutation-destructive' },
    pattern: { kind: 'literal-substring', target_field: 'command', needle: 'rm -rf', case_sensitive: true },
    default_outcome: 'block',
    priority: 90,
    confidence: 0.7,
    source: 'innate',
    rationale: 'test rule',
    ...overrides,
  };
}

describe('CommonSenseRegistry — content-addressing', () => {
  test('computeRuleId is stable for same (microtheory, pattern, default_outcome)', () => {
    const rule = makeRule();
    const id1 = computeRuleId(rule.microtheory, rule.pattern, rule.default_outcome);
    const id2 = computeRuleId(rule.microtheory, rule.pattern, rule.default_outcome);
    expect(id1).toBe(id2);
    expect(id1).toMatch(/^[a-f0-9]{64}$/);
  });

  test('id differs when pattern differs', () => {
    const a = computeRuleId(
      { language: 'shell-bash', domain: 'filesystem', action: 'mutation-destructive' },
      { kind: 'literal-substring', target_field: 'command', needle: 'rm -rf', case_sensitive: true },
      'block',
    );
    const b = computeRuleId(
      { language: 'shell-bash', domain: 'filesystem', action: 'mutation-destructive' },
      { kind: 'literal-substring', target_field: 'command', needle: 'rm -fr', case_sensitive: true },
      'block',
    );
    expect(a).not.toBe(b);
  });

  test('id differs when default_outcome differs', () => {
    const rule = makeRule();
    const idBlock = computeRuleId(rule.microtheory, rule.pattern, 'block');
    const idAllow = computeRuleId(rule.microtheory, rule.pattern, 'allow');
    expect(idBlock).not.toBe(idAllow);
  });
});

describe('CommonSenseRegistry — insert/find', () => {
  test('insertRule returns a rule with derived id and created_at', () => {
    const inserted = registry.insertRule(makeRule());
    expect(inserted.id).toMatch(/^[a-f0-9]{64}$/);
    expect(inserted.created_at).toBeGreaterThan(0);
    expect(inserted.rationale).toBe('test rule');
  });

  test('insert is idempotent on (microtheory, pattern, default_outcome)', () => {
    registry.insertRule(makeRule({ rationale: 'first' }));
    registry.insertRule(makeRule({ rationale: 'updated' }));
    expect(registry.count()).toBe(1);

    const id = computeRuleId(
      { language: 'shell-bash', domain: 'filesystem', action: 'mutation-destructive' },
      { kind: 'literal-substring', target_field: 'command', needle: 'rm -rf', case_sensitive: true },
      'block',
    );
    const round = registry.findById(id);
    expect(round).not.toBeNull();
    // INSERT OR REPLACE updates rationale to the latest write.
    expect(round?.rationale).toBe('updated');
  });

  test('findById returns null for unknown id', () => {
    expect(registry.findById('0'.repeat(64))).toBeNull();
  });
});

describe('CommonSenseRegistry — microtheory query', () => {
  test('findApplicable matches exact three-axis label', () => {
    registry.insertRule(makeRule());
    const hits = registry.findApplicable({
      language: 'shell-bash',
      domain: 'filesystem',
      action: 'mutation-destructive',
    });
    expect(hits).toHaveLength(1);
  });

  test('universal acts as wildcard on either side', () => {
    registry.insertRule(
      makeRule({
        microtheory: { language: 'universal', domain: 'git-workflow', action: 'mutation-destructive' },
        pattern: {
          kind: 'literal-substring',
          target_field: 'command',
          needle: 'git push --force',
          case_sensitive: true,
        },
      }),
    );
    // Query with concrete language → universal stored rule still matches.
    const hits = registry.findApplicable({
      language: 'typescript-strict',
      domain: 'git-workflow',
      action: 'mutation-destructive',
    });
    expect(hits).toHaveLength(1);
  });

  test('returns empty when no axis matches', () => {
    registry.insertRule(makeRule());
    const hits = registry.findApplicable({
      language: 'rust',
      domain: 'web-rest',
      action: 'read-only',
    });
    expect(hits).toHaveLength(0);
  });

  test('orders by priority desc then created_at desc', () => {
    registry.insertRule(makeRule({ priority: 50, rationale: 'low' }));
    registry.insertRule(
      makeRule({
        pattern: { kind: 'literal-substring', target_field: 'command', needle: 'rm -fr', case_sensitive: true },
        priority: 95,
        rationale: 'high',
      }),
    );
    const hits = registry.findApplicable({
      language: 'shell-bash',
      domain: 'filesystem',
      action: 'mutation-destructive',
    });
    expect(hits[0]?.priority).toBe(95);
    expect(hits[1]?.priority).toBe(50);
  });
});

describe('CommonSenseRegistry — findFiring (pattern + abnormality)', () => {
  test('rule fires when pattern matches and no abnormality predicate', () => {
    registry.insertRule(makeRule());
    const firing = registry.findFiring(
      { language: 'shell-bash', domain: 'filesystem', action: 'mutation-destructive' },
      { command: 'sudo rm -rf /tmp/cache' },
    );
    expect(firing).toHaveLength(1);
  });

  test('rule does NOT fire when abnormality predicate holds', () => {
    registry.insertRule(
      makeRule({
        microtheory: { language: 'universal', domain: 'git-workflow', action: 'mutation-destructive' },
        pattern: {
          kind: 'literal-substring',
          target_field: 'command',
          needle: 'git push --force',
          case_sensitive: true,
        },
        abnormality_predicate: {
          kind: 'literal-substring',
          target_field: 'command',
          needle: '--force-with-lease',
          case_sensitive: true,
        },
      }),
    );
    const firing = registry.findFiring(
      { language: 'universal', domain: 'git-workflow', action: 'mutation-destructive' },
      { command: 'git push --force --force-with-lease origin main' },
    );
    expect(firing).toHaveLength(0); // abnormality holds → suppressed
  });

  test('rule fires when pattern matches and abnormality does NOT hold', () => {
    registry.insertRule(
      makeRule({
        microtheory: { language: 'universal', domain: 'git-workflow', action: 'mutation-destructive' },
        pattern: {
          kind: 'literal-substring',
          target_field: 'command',
          needle: 'git push --force',
          case_sensitive: true,
        },
        abnormality_predicate: {
          kind: 'literal-substring',
          target_field: 'command',
          needle: '--force-with-lease',
          case_sensitive: true,
        },
      }),
    );
    const firing = registry.findFiring(
      { language: 'universal', domain: 'git-workflow', action: 'mutation-destructive' },
      { command: 'git push --force origin main' },
    );
    expect(firing).toHaveLength(1);
  });
});

describe('CommonSenseRegistry — count helpers', () => {
  test('countBySource segregates correctly', () => {
    registry.insertRule(makeRule({ source: 'innate' }));
    registry.insertRule(
      makeRule({
        pattern: { kind: 'literal-substring', target_field: 'command', needle: 'rm -fr', case_sensitive: true },
        source: 'configured',
      }),
    );
    registry.insertRule(
      makeRule({
        pattern: { kind: 'literal-substring', target_field: 'command', needle: 'rm -RF', case_sensitive: true },
        source: 'promoted-from-pattern',
      }),
    );
    expect(registry.countBySource('innate')).toBe(1);
    expect(registry.countBySource('configured')).toBe(1);
    expect(registry.countBySource('promoted-from-pattern')).toBe(1);
    expect(registry.count()).toBe(3);
  });

  test('deleteById removes the row', () => {
    const inserted = registry.insertRule(makeRule());
    expect(registry.deleteById(inserted.id)).toBe(true);
    expect(registry.count()).toBe(0);
    expect(registry.deleteById(inserted.id)).toBe(false); // already gone
  });
});

describe('CommonSenseRegistry — schema constraints', () => {
  test('rejects confidence outside pragmatic band [0.5, 0.7]', () => {
    expect(() => registry.insertRule(makeRule({ confidence: 0.4 }))).toThrow();
    expect(() => registry.insertRule(makeRule({ confidence: 0.95 }))).toThrow();
  });

  test('rejects priority outside [0, 100]', () => {
    expect(() => registry.insertRule(makeRule({ priority: -1 }))).toThrow();
    expect(() => registry.insertRule(makeRule({ priority: 101 }))).toThrow();
  });
});

describe('Innate seed', () => {
  test('loadInnateSeed inserts every INNATE_RULES row', () => {
    const result = loadInnateSeed(registry);
    expect(result.inserted).toBe(INNATE_RULES.length);
    expect(registry.count()).toBeLessThanOrEqual(INNATE_RULES.length); // dedup-collapses are allowed
    expect(registry.countBySource('innate')).toBe(registry.count());
  });

  test('seed is idempotent — re-running does not duplicate', () => {
    loadInnateSeed(registry);
    const firstCount = registry.count();
    loadInnateSeed(registry);
    expect(registry.count()).toBe(firstCount);
  });

  test('seed corpus includes the rm -rf / block rule', () => {
    loadInnateSeed(registry);
    const firing = registry.findFiring(
      { language: 'shell-bash', domain: 'filesystem', action: 'mutation-destructive' },
      { command: 'rm -rf /' },
    );
    expect(firing.length).toBeGreaterThan(0);
    const hasBlockingRule = firing.some((r) => r.default_outcome === 'block' && r.priority >= 95);
    expect(hasBlockingRule).toBe(true);
  });

  test('seed all-pragmatic-tier confidence', () => {
    loadInnateSeed(registry);
    for (const rule of INNATE_RULES) {
      expect(rule.confidence).toBeGreaterThanOrEqual(0.5);
      expect(rule.confidence).toBeLessThanOrEqual(0.7);
    }
  });

  test('git push --force has --force-with-lease abnormality predicate', () => {
    loadInnateSeed(registry);
    const firing = registry.findFiring(
      { language: 'universal', domain: 'git-workflow', action: 'mutation-destructive' },
      { command: 'git push --force-with-lease origin main' },
    );
    // The plain --force rule must NOT fire when --force-with-lease is present.
    const forceRule = firing.find(
      (r) =>
        r.pattern.kind === 'literal-substring' &&
        r.pattern.needle === 'git push --force' &&
        r.abnormality_predicate !== undefined,
    );
    expect(forceRule).toBeUndefined();
  });
});
