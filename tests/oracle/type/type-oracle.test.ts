import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { HypothesisTuple } from '../../../src/core/types.ts';
import { clearTscCache, verify } from '../../../src/oracle/type/type-verifier.ts';

describe('type-oracle', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'vinyan-type-test-'));
    // Create a minimal tsconfig.json in the temp workspace
    writeFileSync(
      join(tempDir, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: {
          strict: true,
          noEmit: true,
          target: 'ESNext',
          module: 'ESNext',
          moduleResolution: 'bundler',
        },
        include: ['**/*.ts'],
      }),
    );
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  test('valid TypeScript → verified=true', async () => {
    writeFileSync(join(tempDir, 'valid.ts'), `export function add(a: number, b: number): number { return a + b; }\n`);

    const hypothesis: HypothesisTuple = {
      target: 'valid.ts',
      pattern: 'type-check',
      workspace: tempDir,
    };

    const verdict = await verify(hypothesis);
    expect(verdict.verified).toBe(true);
    expect(verdict.evidence).toHaveLength(0);
    expect(verdict.durationMs).toBeGreaterThanOrEqual(0);
  });

  test('type error → verified=false with evidence', async () => {
    writeFileSync(
      join(tempDir, 'broken.ts'),
      `export function add(a: number, b: number): number { return a + "hello"; }\n`,
    );

    const hypothesis: HypothesisTuple = {
      target: 'broken.ts',
      pattern: 'type-check',
      workspace: tempDir,
    };

    const verdict = await verify(hypothesis);
    expect(verdict.verified).toBe(false);
    expect(verdict.evidence.length).toBeGreaterThan(0);
    expect(verdict.evidence[0]!.snippet).toContain('TS');
    expect(verdict.reason).toContain('type error');
  });

  test('filters diagnostics to target file only', async () => {
    // File A has error, File B is clean
    writeFileSync(join(tempDir, 'a.ts'), `export const x: number = "wrong";\n`);
    writeFileSync(join(tempDir, 'b.ts'), `export const y: number = 42;\n`);

    const hypothesis: HypothesisTuple = {
      target: 'b.ts',
      pattern: 'type-check',
      workspace: tempDir,
    };

    const verdict = await verify(hypothesis);
    // b.ts itself has no errors
    expect(verdict.verified).toBe(true);
  });

  test('incremental mode creates .vinyan/tsbuildinfo', async () => {
    writeFileSync(join(tempDir, 'valid.ts'), `export const x = 1;\n`);
    clearTscCache();

    const hypothesis: HypothesisTuple = {
      target: 'valid.ts',
      pattern: 'type-check',
      workspace: tempDir,
    };

    await verify(hypothesis);
    expect(existsSync(join(tempDir, '.vinyan', 'tsbuildinfo'))).toBe(true);
  });

  test('dedup: concurrent verify calls for same workspace share one tsc invocation', async () => {
    writeFileSync(join(tempDir, 'a.ts'), `export const a: number = 1;\n`);
    writeFileSync(join(tempDir, 'b.ts'), `export const b: number = 2;\n`);
    clearTscCache();

    const hypA: HypothesisTuple = { target: 'a.ts', pattern: 'type-check', workspace: tempDir };
    const hypB: HypothesisTuple = { target: 'b.ts', pattern: 'type-check', workspace: tempDir };

    // Fire both concurrently — should share single tsc invocation
    const [verdictA, verdictB] = await Promise.all([verify(hypA), verify(hypB)]);
    expect(verdictA.verified).toBe(true);
    expect(verdictB.verified).toBe(true);
    // Both should complete roughly at the same time (shared tsc)
    expect(Math.abs(verdictA.durationMs - verdictB.durationMs)).toBeLessThan(500);
  });

  test('tsbuildinfo updates when source file changes', async () => {
    writeFileSync(join(tempDir, 'src.ts'), `export const x = 1;\n`);
    clearTscCache();

    const hypothesis: HypothesisTuple = { target: 'src.ts', pattern: 'type-check', workspace: tempDir };

    // First run — creates tsbuildinfo
    await verify(hypothesis);
    const buildInfoPath = join(tempDir, '.vinyan', 'tsbuildinfo');
    expect(existsSync(buildInfoPath)).toBe(true);
    const info1 = readFileSync(buildInfoPath, 'utf-8');

    // Modify the source file
    writeFileSync(join(tempDir, 'src.ts'), `export const x = 2;\nexport const y = 3;\n`);
    clearTscCache();

    // Second run — tsbuildinfo should be updated
    await verify(hypothesis);
    const info2 = readFileSync(buildInfoPath, 'utf-8');
    expect(info2).not.toBe(info1);
  });

  test('detects new type error after source change', async () => {
    writeFileSync(join(tempDir, 'evolving.ts'), `export const x: number = 1;\n`);
    clearTscCache();

    const hypothesis: HypothesisTuple = { target: 'evolving.ts', pattern: 'type-check', workspace: tempDir };

    // First run — clean
    const v1 = await verify(hypothesis);
    expect(v1.verified).toBe(true);

    // Introduce type error
    writeFileSync(join(tempDir, 'evolving.ts'), `export const x: number = "oops";\n`);
    clearTscCache();

    // Second run — should detect
    const v2 = await verify(hypothesis);
    expect(v2.verified).toBe(false);
    expect(v2.evidence.length).toBeGreaterThan(0);
  });
});
