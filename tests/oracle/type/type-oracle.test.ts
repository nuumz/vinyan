import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { HypothesisTuple } from '../../../src/core/types.ts';
import { verify } from '../../../src/oracle/type/type-verifier.ts';

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
});
