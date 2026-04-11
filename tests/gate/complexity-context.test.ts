import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildComplexityContext, computeQualityScore } from '../../src/gate/quality-score.ts';

describe('buildComplexityContext (P3.3 — QualityScore enrichment)', () => {
  let workspace: string;

  beforeAll(() => {
    workspace = mkdtempSync(join(tmpdir(), 'vinyan-cx-'));
    // File with branching logic
    writeFileSync(
      join(workspace, 'complex.ts'),
      `function check(x: number) {
  if (x > 0) {
    if (x > 10) {
      return "big";
    } else {
      return "small";
    }
  } else {
    return "negative";
  }
}`,
    );
  });

  afterAll(() => {
    rmSync(workspace, { recursive: true, force: true });
  });

  test('returns undefined for empty mutations', () => {
    const ctx = buildComplexityContext([], workspace);
    expect(ctx).toBeUndefined();
  });

  test('reads original file and pairs with mutated content', () => {
    const ctx = buildComplexityContext(
      [{ file: 'complex.ts', content: "function check(x: number) { return x > 0 ? 'yes' : 'no'; }" }],
      workspace,
    );
    expect(ctx).toBeDefined();
    expect(ctx!.originalSource).toContain('if (x > 0)');
    expect(ctx!.mutatedSource).toContain("? 'yes' : 'no'");
  });

  test('new file (no original) returns empty original', () => {
    const ctx = buildComplexityContext([{ file: 'brand-new.ts', content: 'export const a = 1;' }], workspace);
    expect(ctx).toBeDefined();
    expect(ctx!.originalSource).toBe(''); // file doesn't exist
    expect(ctx!.mutatedSource).toBe('export const a = 1;');
  });

  test('simplification produces simplificationGain > 0 in QualityScore', () => {
    const ctx = buildComplexityContext(
      [{ file: 'complex.ts', content: "function check(x: number) { return x > 0 ? 'yes' : 'no'; }" }],
      workspace,
    );
    const qs = computeQualityScore(
      { ast: { verified: true, confidence: 1, evidence: [], type: 'known' as const, fileHashes: {}, durationMs: 0 } },
      50,
      2000,
      ctx,
    );
    expect(qs.simplificationGain).toBeDefined();
    expect(qs.simplificationGain!).toBeGreaterThan(0);
    expect(qs.phase).toBe('phase1');
    expect(qs.dimensionsAvailable).toBe(3);
  });

  test('new file gets neutral simplificationGain (0.5)', () => {
    const ctx = buildComplexityContext(
      [{ file: 'new-file.ts', content: 'function foo() { if (true) return 1; return 2; }' }],
      workspace,
    );
    const qs = computeQualityScore(
      { ast: { verified: true, confidence: 1, evidence: [], type: 'known' as const, fileHashes: {}, durationMs: 0 } },
      50,
      2000,
      ctx,
    );
    expect(qs.simplificationGain).toBe(0.5);
  });
});
