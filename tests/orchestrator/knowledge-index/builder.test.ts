import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildKnowledgeIndex,
  formatAsMarkdown,
  rebuildKnowledgeIndex,
  writeKnowledgeIndex,
} from '../../../src/orchestrator/knowledge-index/builder.ts';

// ---------------------------------------------------------------------------
// Test workspace fixture
// ---------------------------------------------------------------------------

let workspaceRoot: string;

function writeFile(relPath: string, content: string): void {
  const abs = join(workspaceRoot, relPath);
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, content, 'utf-8');
}

beforeEach(() => {
  workspaceRoot = mkdtempSync(join(tmpdir(), 'vinyan-knowledge-index-'));
});

afterEach(() => {
  rmSync(workspaceRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// buildKnowledgeIndex
// ---------------------------------------------------------------------------

describe('buildKnowledgeIndex', () => {
  test('returns empty modules when src/ does not exist', () => {
    const index = buildKnowledgeIndex(workspaceRoot, { nowMs: 1_700_000_000_000 });
    expect(index.modules).toEqual([]);
    expect(index.workspaceRoot).toBe(workspaceRoot);
    expect(index.srcDir).toBe('src');
    expect(index.generatedAt).toBe(1_700_000_000_000);
  });

  test('extracts first non-empty JSDoc line from index.ts of each top-level dir', () => {
    writeFile(
      'src/oracle/index.ts',
      `/**
 * Oracle subsystem — verification engines (ast, type, dep, test, lint).
 *
 * Detail block is ignored.
 */
export const x = 1;
`,
    );
    writeFile(
      'src/core/index.ts',
      `/**
 * Core types and event bus.
 */
export const y = 2;
`,
    );

    const index = buildKnowledgeIndex(workspaceRoot, { nowMs: 1 });
    expect(index.modules).toHaveLength(2);
    // Sorted alphabetically
    expect(index.modules[0]?.path).toBe('src/core/');
    expect(index.modules[0]?.description).toBe('Core types and event bus.');
    expect(index.modules[1]?.path).toBe('src/oracle/');
    expect(index.modules[1]?.description).toBe('Oracle subsystem — verification engines (ast, type, dep, test, lint).');
  });

  test('falls back to first .ts file when index.ts has no JSDoc', () => {
    writeFile('src/util/index.ts', 'export const noop = () => {};');
    writeFile(
      'src/util/helpers.ts',
      `/**
 * Helper utilities for string manipulation.
 */
export const x = 1;
`,
    );
    const index = buildKnowledgeIndex(workspaceRoot, { nowMs: 1 });
    expect(index.modules[0]?.description).toBe('Helper utilities for string manipulation.');
  });

  test('skips .test.ts and .d.ts files when looking for JSDoc', () => {
    writeFile(
      'src/foo/index.test.ts',
      `/**
 * Test fixtures — should NOT be the description source.
 */
`,
    );
    writeFile(
      'src/foo/main.ts',
      `/**
 * Foo subsystem — the real description.
 */
`,
    );
    const index = buildKnowledgeIndex(workspaceRoot, { nowMs: 1 });
    expect(index.modules[0]?.description).toBe('Foo subsystem — the real description.');
  });

  test('returns "(no description)" when no JSDoc is found in any file', () => {
    writeFile('src/empty/a.ts', 'export const a = 1;');
    writeFile('src/empty/b.ts', '// just a line comment, not JSDoc');
    const index = buildKnowledgeIndex(workspaceRoot, { nowMs: 1 });
    expect(index.modules[0]?.description).toBe('(no description)');
  });

  test('caps description at 120 chars with ellipsis', () => {
    const longLine = `${'x'.repeat(200)} should be truncated`;
    writeFile(
      'src/big/index.ts',
      `/**
 * ${longLine}
 */
`,
    );
    const index = buildKnowledgeIndex(workspaceRoot, { nowMs: 1 });
    const desc = index.modules[0]?.description ?? '';
    expect(desc.length).toBe(120);
    expect(desc.endsWith('…')).toBe(true);
  });

  test('counts .ts files recursively (excluding non-ts files)', () => {
    writeFile('src/multi/index.ts', '/** desc */');
    writeFile('src/multi/a.ts', '');
    writeFile('src/multi/sub/b.ts', '');
    writeFile('src/multi/sub/deeper/c.ts', '');
    writeFile('src/multi/README.md', 'not counted');
    writeFile('src/multi/data.json', 'not counted');
    const index = buildKnowledgeIndex(workspaceRoot, { nowMs: 1 });
    expect(index.modules[0]?.fileCount).toBe(4); // index.ts + a.ts + b.ts + c.ts
  });

  test('skips dot-directories like .git or .vinyan', () => {
    writeFile('src/.hidden/index.ts', '/** hidden */');
    writeFile('src/visible/index.ts', '/** visible */');
    const index = buildKnowledgeIndex(workspaceRoot, { nowMs: 1 });
    expect(index.modules.map((m) => m.path)).toEqual(['src/visible/']);
  });

  test('skips underscore-prefixed dirs by default but includes them when opt-in', () => {
    writeFile('src/_internal/index.ts', '/** internal */');
    writeFile('src/public/index.ts', '/** public */');

    const without = buildKnowledgeIndex(workspaceRoot, { nowMs: 1 });
    expect(without.modules.map((m) => m.path)).toEqual(['src/public/']);

    const withInternal = buildKnowledgeIndex(workspaceRoot, { nowMs: 1, includeUnderscoreDirs: true });
    expect(withInternal.modules.map((m) => m.path)).toEqual(['src/_internal/', 'src/public/']);
  });

  test('honors custom srcDir', () => {
    writeFile('lib/foo/index.ts', '/** foo */');
    const index = buildKnowledgeIndex(workspaceRoot, { srcDir: 'lib', nowMs: 1 });
    expect(index.modules[0]?.path).toBe('lib/foo/');
    expect(index.srcDir).toBe('lib');
  });

  test('ignores files at the top of src/ (no description scan, only directories matter)', () => {
    writeFile('src/loose-file.ts', '/** loose */');
    writeFile('src/realmodule/index.ts', '/** real */');
    const index = buildKnowledgeIndex(workspaceRoot, { nowMs: 1 });
    expect(index.modules.map((m) => m.path)).toEqual(['src/realmodule/']);
  });
});

// ---------------------------------------------------------------------------
// formatAsMarkdown
// ---------------------------------------------------------------------------

describe('formatAsMarkdown', () => {
  test('renders deterministic markdown with header + module list', () => {
    const md = formatAsMarkdown({
      generatedAt: Date.UTC(2026, 3, 30, 12, 34),
      workspaceRoot: '/ws',
      srcDir: 'src',
      modules: [
        { path: 'src/core/', description: 'Core types.', fileCount: 3, lastModified: 0 },
        { path: 'src/oracle/', description: 'Oracle gate.', fileCount: 12, lastModified: 0 },
      ],
    });
    expect(md).toContain('# Vinyan Knowledge Index');
    expect(md).toContain('Total modules: 2');
    expect(md).toContain('- `src/core/` — Core types.');
    expect(md).toContain('- `src/oracle/` — Oracle gate.');
    expect(md).toContain('2026-04-30 12:34 UTC');
  });

  test('renders empty placeholder when there are no modules', () => {
    const md = formatAsMarkdown({
      generatedAt: 0,
      workspaceRoot: '/ws',
      srcDir: 'src',
      modules: [],
    });
    expect(md).toContain('_(no modules detected)_');
  });

  test('output is byte-identical for two builds with the same input (determinism)', () => {
    const idx = {
      generatedAt: 1_700_000_000_000,
      workspaceRoot: '/ws',
      srcDir: 'src',
      modules: [{ path: 'src/x/', description: 'X', fileCount: 1, lastModified: 0 }],
    } as const;
    expect(formatAsMarkdown(idx)).toBe(formatAsMarkdown(idx));
  });
});

// ---------------------------------------------------------------------------
// writeKnowledgeIndex / rebuildKnowledgeIndex
// ---------------------------------------------------------------------------

describe('writeKnowledgeIndex', () => {
  test('writes to .vinyan/knowledge-index.md by default and creates the directory', () => {
    const path = writeKnowledgeIndex(workspaceRoot, {
      generatedAt: 1,
      workspaceRoot,
      srcDir: 'src',
      modules: [{ path: 'src/x/', description: 'X', fileCount: 1, lastModified: 0 }],
    });
    expect(path).toBe(join(workspaceRoot, '.vinyan', 'knowledge-index.md'));
    const content = readFileSync(path, 'utf-8');
    expect(content).toContain('- `src/x/` — X');
  });

  test('honors custom outputDir + filename', () => {
    const path = writeKnowledgeIndex(
      workspaceRoot,
      {
        generatedAt: 1,
        workspaceRoot,
        srcDir: 'src',
        modules: [],
      },
      { outputDir: join(workspaceRoot, 'out'), filename: 'catalog.md' },
    );
    expect(path).toBe(join(workspaceRoot, 'out', 'catalog.md'));
  });
});

describe('rebuildKnowledgeIndex', () => {
  test('builds + writes in one call; returns index and path', () => {
    writeFile('src/foo/index.ts', '/** Foo module. */');
    const result = rebuildKnowledgeIndex(workspaceRoot, { nowMs: 1 });
    expect(result.index.modules).toHaveLength(1);
    expect(result.index.modules[0]?.description).toBe('Foo module.');
    expect(result.path).toBe(join(workspaceRoot, '.vinyan', 'knowledge-index.md'));
    const content = readFileSync(result.path, 'utf-8');
    expect(content).toContain('Foo module.');
  });
});
