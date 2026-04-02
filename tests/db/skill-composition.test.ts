import { Database } from 'bun:sqlite';
import { beforeEach, describe, expect, test } from 'bun:test';
import { SKILL_SCHEMA_SQL } from '../../src/db/skill-schema.ts';
import { SkillStore } from '../../src/db/skill-store.ts';
import type { CachedSkill } from '../../src/orchestrator/types.ts';

let db: Database;
let store: SkillStore;

beforeEach(() => {
  db = new Database(':memory:');
  db.exec(SKILL_SCHEMA_SQL);
  store = new SkillStore(db);
});

function makeSkill(overrides?: Partial<CachedSkill>): CachedSkill {
  return {
    taskSignature: 'test::default',
    approach: 'direct-edit',
    successRate: 0.85,
    status: 'active',
    probationRemaining: 0,
    usageCount: 5,
    riskAtCreation: 0.15,
    depConeHashes: { 'src/auth.ts': 'abc123' },
    lastVerifiedAt: Date.now(),
    verificationProfile: 'hash-only',
    ...overrides,
  };
}

describe('Skill Composition', () => {
  test('insert and retrieve composed skill', () => {
    const skill = makeSkill({
      taskSignature: 'composed::build-auth',
      composedOf: ['build-auth::jwt', 'build-auth::middleware', 'build-auth::tests'],
    });
    store.insert(skill);

    const found = store.findBySignature('composed::build-auth');
    expect(found).not.toBeNull();
    expect(found!.composedOf).toEqual(['build-auth::jwt', 'build-auth::middleware', 'build-auth::tests']);
  });

  test('findComposedSkill returns only active composed skills', () => {
    store.insert(makeSkill({
      taskSignature: 'composed::build-auth',
      status: 'active',
      composedOf: ['build-auth::jwt', 'build-auth::middleware'],
    }));
    store.insert(makeSkill({
      taskSignature: 'composed::build-api',
      status: 'demoted',
      composedOf: ['build-api::routes', 'build-api::handlers'],
    }));

    expect(store.findComposedSkill('composed::build-auth')).not.toBeNull();
    expect(store.findComposedSkill('composed::build-api')).toBeNull();
  });

  test('findComposedSkill returns null for non-composed skill', () => {
    store.insert(makeSkill({ taskSignature: 'simple::task', status: 'active' }));
    expect(store.findComposedSkill('simple::task')).toBeNull();
  });

  test('findAllComposed returns all composed skills regardless of status', () => {
    store.insert(makeSkill({
      taskSignature: 'composed::a',
      composedOf: ['a::1', 'a::2'],
    }));
    store.insert(makeSkill({
      taskSignature: 'composed::b',
      status: 'demoted',
      composedOf: ['b::1', 'b::2'],
    }));
    store.insert(makeSkill({ taskSignature: 'simple::c' }));

    const composed = store.findAllComposed();
    expect(composed).toHaveLength(2);
  });

  test('detectComposition proposes from co-occurring skills', () => {
    const skills: CachedSkill[] = [
      makeSkill({ taskSignature: 'build-auth::jwt', usageCount: 5 }),
      makeSkill({ taskSignature: 'build-auth::middleware', usageCount: 4 }),
      makeSkill({ taskSignature: 'build-auth::tests', usageCount: 3 }),
      makeSkill({ taskSignature: 'other::task', usageCount: 10 }),
    ];

    const compositions = store.detectComposition(skills, 3);
    expect(compositions).toHaveLength(1);
    expect(compositions[0]!.taskSignature).toBe('composed::build-auth');
    expect(compositions[0]!.subSkills).toContain('build-auth::jwt');
    expect(compositions[0]!.subSkills).toContain('build-auth::middleware');
    expect(compositions[0]!.subSkills).toContain('build-auth::tests');
  });

  test('detectComposition ignores low-count skills below threshold', () => {
    const skills: CachedSkill[] = [
      makeSkill({ taskSignature: 'rare::a', usageCount: 1 }),
      makeSkill({ taskSignature: 'rare::b', usageCount: 2 }),
    ];

    const compositions = store.detectComposition(skills, 3);
    expect(compositions).toHaveLength(0);
  });

  test('detectComposition skips already-existing composed skills', () => {
    // Pre-insert a composed skill
    store.insert(makeSkill({
      taskSignature: 'composed::build-auth',
      status: 'active',
      composedOf: ['build-auth::jwt', 'build-auth::middleware'],
    }));

    const skills: CachedSkill[] = [
      makeSkill({ taskSignature: 'build-auth::jwt', usageCount: 5 }),
      makeSkill({ taskSignature: 'build-auth::middleware', usageCount: 4 }),
    ];

    const compositions = store.detectComposition(skills, 3);
    expect(compositions).toHaveLength(0);
  });

  test('skill without composedOf has undefined composedOf field', () => {
    store.insert(makeSkill({ taskSignature: 'plain::skill' }));
    const found = store.findBySignature('plain::skill');
    expect(found).not.toBeNull();
    expect(found!.composedOf).toBeUndefined();
  });
});
