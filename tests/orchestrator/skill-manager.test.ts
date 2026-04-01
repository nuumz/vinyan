import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { SKILL_SCHEMA_SQL } from '../../src/db/skill-schema.ts';
import { SkillStore } from '../../src/db/skill-store.ts';
import { hashContent, SkillManager } from '../../src/orchestrator/skill-manager.ts';
import type { ExtractedPattern } from '../../src/orchestrator/types.ts';

let db: Database;
let store: SkillStore;
let tempDir: string;

beforeEach(() => {
  db = new Database(':memory:');
  db.exec(SKILL_SCHEMA_SQL);
  store = new SkillStore(db);
  tempDir = mkdtempSync(join(tmpdir(), 'vinyan-skill-'));
  mkdirSync(join(tempDir, 'src'), { recursive: true });
  writeFileSync(join(tempDir, 'src', 'auth.ts'), 'export function login() {}');
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

function makePattern(overrides?: Partial<ExtractedPattern>): ExtractedPattern {
  return {
    id: 'p-1',
    type: 'success-pattern',
    description: 'direct-edit is effective for refactors',
    frequency: 20,
    confidence: 0.85,
    taskTypeSignature: 'refactor::auth.ts',
    approach: 'direct-edit',
    qualityDelta: 0.3,
    sourceTraceIds: ['t-1', 't-2'],
    createdAt: Date.now(),
    decayWeight: 1.0,
    ...overrides,
  };
}

describe('SkillManager', () => {
  test('match returns active skill for matching signature', () => {
    const manager = new SkillManager({ skillStore: store, workspace: tempDir });
    const hashes = manager.computeCurrentHashes(['src/auth.ts']);

    manager.createFromPattern(makePattern(), 0.1, hashes);
    // Skill is in probation — should NOT match
    expect(manager.match('refactor::auth.ts')).toBeNull();

    // Manually promote to active
    store.updateStatus('refactor::auth.ts', 'active', 0);
    const skill = manager.match('refactor::auth.ts');
    expect(skill).not.toBeNull();
    expect(skill!.approach).toBe('direct-edit');
  });

  test('createFromPattern creates skill in probation', () => {
    const manager = new SkillManager({ skillStore: store, workspace: tempDir });
    const hashes = { 'src/auth.ts': 'abc' };

    const skill = manager.createFromPattern(makePattern(), 0.15, hashes);
    expect(skill.status).toBe('probation');
    expect(skill.probationRemaining).toBe(10);
    expect(skill.verificationProfile).toBe('hash-only'); // risk < 0.2
  });

  test('risk-tiered verification profiles', () => {
    const manager = new SkillManager({ skillStore: store, workspace: tempDir });
    const hashes = { 'src/auth.ts': 'abc' };

    const low = manager.createFromPattern(makePattern({ taskTypeSignature: 'low' }), 0.1, hashes);
    expect(low.verificationProfile).toBe('hash-only');

    const mid = manager.createFromPattern(makePattern({ taskTypeSignature: 'mid' }), 0.3, hashes);
    expect(mid.verificationProfile).toBe('structural');

    const high = manager.createFromPattern(makePattern({ taskTypeSignature: 'high' }), 0.5, hashes);
    expect(high.verificationProfile).toBe('full');
  });

  test('verify passes when dep cone hashes match', () => {
    const manager = new SkillManager({ skillStore: store, workspace: tempDir });
    const hashes = manager.computeCurrentHashes(['src/auth.ts']);
    const skill = manager.createFromPattern(makePattern(), 0.1, hashes);

    const result = manager.verify(skill);
    expect(result.valid).toBe(true);
  });

  test('verify fails when file content has changed', () => {
    const manager = new SkillManager({ skillStore: store, workspace: tempDir });
    const hashes = manager.computeCurrentHashes(['src/auth.ts']);
    const skill = manager.createFromPattern(makePattern(), 0.1, hashes);

    // Change the file
    writeFileSync(join(tempDir, 'src', 'auth.ts'), 'export function logout() {}');

    const result = manager.verify(skill);
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('hash mismatch');
  });

  test('recordOutcome promotes after probation completes', () => {
    const manager = new SkillManager({
      skillStore: store,
      workspace: tempDir,
      probationSessions: 3,
    });
    const hashes = manager.computeCurrentHashes(['src/auth.ts']);
    const skill = manager.createFromPattern(makePattern(), 0.1, hashes);
    expect(skill.probationRemaining).toBe(3);

    // Tick 3 successes → should promote
    manager.recordOutcome(skill, true);
    const s1 = store.findBySignature(skill.taskSignature)!;
    expect(s1.probationRemaining).toBe(2);

    manager.recordOutcome(s1, true);
    const s2 = store.findBySignature(skill.taskSignature)!;
    expect(s2.probationRemaining).toBe(1);

    manager.recordOutcome(s2, true);
    const s3 = store.findBySignature(skill.taskSignature)!;
    expect(s3.status).toBe('active');
    expect(s3.probationRemaining).toBe(0);
  });

  test('recordOutcome demotes on failure', () => {
    const manager = new SkillManager({ skillStore: store, workspace: tempDir });
    const hashes = manager.computeCurrentHashes(['src/auth.ts']);
    const skill = manager.createFromPattern(makePattern(), 0.1, hashes);

    manager.recordOutcome(skill, false);
    const demoted = store.findBySignature(skill.taskSignature)!;
    expect(demoted.status).toBe('demoted');
  });

  test('hashContent produces consistent hashes', () => {
    const h1 = hashContent('hello world');
    const h2 = hashContent('hello world');
    const h3 = hashContent('different');

    expect(h1).toBe(h2);
    expect(h1).not.toBe(h3);
    expect(h1.length).toBe(16); // truncated sha256
  });
});
