/**
 * SkillExporter tests — DB row → SKILL.md projection.
 */
import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { migration001 } from '../../src/db/migrations/001_initial_schema.ts';
import { migration004 } from '../../src/db/migrations/004_skill_artifact.ts';
import { MigrationRunner } from '../../src/db/migrations/migration-runner.ts';
import { SkillArtifactStore } from '../../src/skills/artifact-store.ts';
import { normalizeIdFromSignature, SkillExporter } from '../../src/skills/exporter.ts';

let db: Database;
let rootDir: string;
let store: SkillArtifactStore;
let exporter: SkillExporter;

beforeEach(() => {
  db = new Database(':memory:');
  const runner = new MigrationRunner();
  runner.migrate(db, [migration001, migration004]);
  rootDir = mkdtempSync(join(tmpdir(), 'skill-exporter-'));
  store = new SkillArtifactStore({ rootDir });
  exporter = new SkillExporter({ db, artifactStore: store });
});

afterEach(() => {
  db.close();
  rmSync(rootDir, { recursive: true, force: true });
});

function insertRow(args: {
  taskSignature: string;
  approach?: string;
  status?: 'probation' | 'active' | 'demoted';
  confidenceTier?: string;
  contentHash?: string | null;
}): void {
  db.run(
    `INSERT INTO cached_skills (
      task_signature, approach, success_rate, status,
      probation_remaining, usage_count, risk_at_creation,
      dep_cone_hashes, last_verified_at, verification_profile,
      confidence_tier, content_hash
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      args.taskSignature,
      args.approach ?? `Approach for ${args.taskSignature}`,
      0.9,
      args.status ?? 'active',
      0,
      5,
      0.2,
      '{}',
      Date.now(),
      'full',
      args.confidenceTier ?? 'probabilistic',
      args.contentHash ?? null,
    ],
  );
}

describe('normalizeIdFromSignature', () => {
  test('preserves namespace separator', () => {
    expect(normalizeIdFromSignature('refactor/extract-method')).toBe('refactor/extract-method');
  });

  test('kebab-cases whitespace and punctuation', () => {
    expect(normalizeIdFromSignature('Fix CRLF in config')).toBe('fix-crlf-in-config');
  });

  test('double slashes collapse to one separator', () => {
    const out = normalizeIdFromSignature('a//b/c');
    expect(out).toMatch(/^[a-z][a-z0-9-]*(\/[a-z][a-z0-9-]*)?$/);
  });
});

describe('exportAll', () => {
  test('projects 3 rows into 3 SKILL.md files', async () => {
    insertRow({
      taskSignature: 'refactor/one',
      contentHash: `sha256:${'a'.repeat(64)}`,
      confidenceTier: 'deterministic',
    });
    insertRow({ taskSignature: 'refactor/two', confidenceTier: 'heuristic' });
    insertRow({ taskSignature: 'tidy imports' });

    const stats = await exporter.exportAll();
    expect(stats.exported).toBe(3);
    expect(stats.errors).toEqual([]);

    const listed = await store.list();
    expect(listed.length).toBe(3);
    const ids = new Set(listed.map((e) => e.id));
    expect(ids.has('refactor/one')).toBe(true);
    expect(ids.has('refactor/two')).toBe(true);
    expect(ids.has('tidy-imports')).toBe(true);
  });

  test('legacy row without content_hash never exports as deterministic', async () => {
    insertRow({
      taskSignature: 'legacy/det',
      confidenceTier: 'deterministic', // the row claims deterministic
      contentHash: null, // … but has no content_hash
    });

    const stats = await exporter.exportAll();
    expect(stats.exported).toBe(1);

    const rec = await store.read('legacy/det');
    expect(rec.frontmatter.confidence_tier).not.toBe('deterministic');
    // Acceptable downgrade targets — see exporter.ts comment.
    expect(['heuristic', 'probabilistic']).toContain(rec.frontmatter.confidence_tier);
  });

  test('overwrite:false skips already-exported artifacts', async () => {
    insertRow({ taskSignature: 'refactor/alpha' });
    insertRow({ taskSignature: 'refactor/beta' });
    insertRow({ taskSignature: 'refactor/gamma' });
    const first = await exporter.exportAll();
    expect(first.exported).toBe(3);

    const second = await exporter.exportAll({ overwrite: false });
    expect(second.exported).toBe(0);
    expect(second.skippedAlreadyExists).toBe(3);
  });

  test('overwrite:true re-writes every artifact', async () => {
    insertRow({ taskSignature: 'refactor/alpha' });
    await exporter.exportAll();
    const second = await exporter.exportAll({ overwrite: true });
    expect(second.exported).toBe(1);
    expect(second.skippedAlreadyExists).toBe(0);
  });
});

describe('exportOne', () => {
  test('returns "ok" for existing row', async () => {
    insertRow({ taskSignature: 'refactor/one' });
    const r = await exporter.exportOne('refactor/one');
    expect(r).toBe('ok');
  });

  test('returns "exists" on second run without overwrite', async () => {
    insertRow({ taskSignature: 'refactor/one' });
    await exporter.exportOne('refactor/one');
    const r = await exporter.exportOne('refactor/one');
    expect(r).toBe('exists');
  });

  test('returns "error" for missing id', async () => {
    const r = await exporter.exportOne('nope/does-not-exist');
    expect(r).toBe('error');
  });
});
