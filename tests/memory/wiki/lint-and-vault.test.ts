/**
 * Memory Wiki — lint + vault path safety.
 */
import { Database } from 'bun:sqlite';
import { beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migration001 } from '../../../src/db/migrations/001_initial_schema.ts';
import { MigrationRunner } from '../../../src/db/migrations/migration-runner.ts';
import { MemoryWikiLint } from '../../../src/memory/wiki/lint.ts';
import { PageWriter } from '../../../src/memory/wiki/page-writer.ts';
import { MemoryWikiStore } from '../../../src/memory/wiki/store.ts';
import { assertPathSafe, ensureVaultDirs, resolveVaultLayout } from '../../../src/memory/wiki/vault.ts';

function freshStore(): MemoryWikiStore {
  const db = new Database(':memory:');
  new MigrationRunner().migrate(db, [migration001]);
  return new MemoryWikiStore(db, { clock: () => 1_700_000_000_000 });
}

describe('MemoryWikiLint.run', () => {
  let store: MemoryWikiStore;
  let writer: PageWriter;
  let lint: MemoryWikiLint;
  beforeEach(() => {
    store = freshStore();
    writer = new PageWriter({ store, clock: () => 1_700_000_000_000 });
    lint = new MemoryWikiLint({ store, clock: () => 1_700_000_000_000 });
  });

  it('detects orphan pages', () => {
    expect(
      writer.write({
        profile: 'default',
        type: 'concept',
        title: 'Orphan',
        body: 'no inbound links',
        evidenceTier: 'heuristic',
        confidence: 0.6,
        lifecycle: 'draft',
        sources: [],
        actor: 'system:test',
      }).ok,
    ).toBe(true);
    const result = lint.run({ profile: 'default' });
    const orphans = result.findings.filter((f) => f.code === 'orphan-page');
    expect(orphans.length).toBeGreaterThan(0);
  });

  it('detects duplicate aliases across pages', () => {
    writer.write({
      profile: 'default',
      type: 'concept',
      title: 'A',
      aliases: ['shared'],
      body: 'a',
      evidenceTier: 'heuristic',
      confidence: 0.6,
      lifecycle: 'draft',
      sources: [],
      actor: 'system:test',
    });
    // Second page reuses the alias — should be rejected by writer.
    const second = writer.write({
      profile: 'default',
      type: 'concept',
      title: 'B',
      aliases: ['shared'],
      body: 'b',
      evidenceTier: 'heuristic',
      confidence: 0.6,
      lifecycle: 'draft',
      sources: [],
      actor: 'system:test',
    });
    expect(second.ok).toBe(false);
  });

  it('detects low-confidence canonical pages', () => {
    writer.write({
      profile: 'default',
      type: 'concept',
      title: 'Weak Canonical',
      body: 'hi',
      evidenceTier: 'speculative',
      confidence: 0.2,
      lifecycle: 'canonical',
      sources: [{ id: 's', contentHash: 'h'.repeat(64), kind: 'session' }],
      actor: 'system:test',
    });
    const result = lint.run({ profile: 'default' });
    const low = result.findings.filter((f) => f.code === 'low-confidence-canonical');
    expect(low.length).toBeGreaterThan(0);
  });
});

describe('vault path safety', () => {
  it('rejects path traversal via ..', () => {
    const root = '/tmp/some/root';
    expect(() => assertPathSafe(root, '/tmp/some/root/../escape.md')).toThrow(/escapes root/);
  });

  it('accepts paths under root', () => {
    const root = '/tmp/some/root';
    expect(() => assertPathSafe(root, '/tmp/some/root/sub/file.md')).not.toThrow();
  });

  it('ensureVaultDirs creates all subdirectories', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'vinyan-wiki-test-'));
    const layout = resolveVaultLayout({ workspace: tmp, rootOverride: join(tmp, 'wiki') });
    ensureVaultDirs(layout);
    expect(existsSync(layout.root)).toBe(true);
    expect(existsSync(layout.raw)).toBe(true);
    expect(existsSync(layout.pages)).toBe(true);
    expect(existsSync(layout.schema)).toBe(true);
  });
});
