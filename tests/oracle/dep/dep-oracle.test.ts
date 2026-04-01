import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { HypothesisTuple } from '../../../src/core/types.ts';
import { verify } from '../../../src/oracle/dep/dep-analyzer.ts';

describe('dep-oracle', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'vinyan-dep-test-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  test('A→B→C chain: blast radius of C = 2', async () => {
    // C is a leaf module
    writeFileSync(join(tempDir, 'c.ts'), `export const value = 42;\n`);
    // B imports C
    writeFileSync(join(tempDir, 'b.ts'), `import { value } from "./c.ts";\nexport const doubled = value * 2;\n`);
    // A imports B
    writeFileSync(join(tempDir, 'a.ts'), `import { doubled } from "./b.ts";\nconsole.log(doubled);\n`);

    const hypothesis: HypothesisTuple = {
      target: 'c.ts',
      pattern: 'dependency-check',
      workspace: tempDir,
    };

    const verdict = await verify(hypothesis);
    expect(verdict.verified).toBe(true);
    expect(verdict.evidence).toHaveLength(2);
    const depFiles = verdict.evidence.map((e) => e.file).sort();
    expect(depFiles).toEqual(['a.ts', 'b.ts']);
    expect(verdict.reason).toContain('2 file(s)');
  });

  test('isolated file → blast radius 0', async () => {
    writeFileSync(join(tempDir, 'isolated.ts'), `export const x = 1;\n`);
    writeFileSync(join(tempDir, 'other.ts'), `export const y = 2;\n`);

    const hypothesis: HypothesisTuple = {
      target: 'isolated.ts',
      pattern: 'dependency-check',
      workspace: tempDir,
    };

    const verdict = await verify(hypothesis);
    expect(verdict.verified).toBe(true);
    expect(verdict.evidence).toHaveLength(0);
    expect(verdict.reason).toContain('0 file(s)');
  });

  test('non-existent target → verified=false', async () => {
    const hypothesis: HypothesisTuple = {
      target: 'missing.ts',
      pattern: 'dependency-check',
      workspace: tempDir,
    };

    const verdict = await verify(hypothesis);
    expect(verdict.verified).toBe(false);
    expect(verdict.reason).toContain('not found');
  });

  test('diamond dependency: D→B, D→C, B→A, C→A → blast radius of A = 3', async () => {
    writeFileSync(join(tempDir, 'a.ts'), `export const base = 1;\n`);
    writeFileSync(join(tempDir, 'b.ts'), `import { base } from "./a.ts";\nexport const b = base + 1;\n`);
    writeFileSync(join(tempDir, 'c.ts'), `import { base } from "./a.ts";\nexport const c = base + 2;\n`);
    writeFileSync(
      join(tempDir, 'd.ts'),
      `import { b } from "./b.ts";\nimport { c } from "./c.ts";\nconsole.log(b, c);\n`,
    );

    const hypothesis: HypothesisTuple = {
      target: 'a.ts',
      pattern: 'dependency-check',
      workspace: tempDir,
    };

    const verdict = await verify(hypothesis);
    expect(verdict.verified).toBe(true);
    expect(verdict.evidence).toHaveLength(3);
    const depFiles = verdict.evidence.map((e) => e.file).sort();
    expect(depFiles).toEqual(['b.ts', 'c.ts', 'd.ts']);
  });

  test('re-export chain is followed', async () => {
    writeFileSync(join(tempDir, 'core.ts'), `export const val = 1;\n`);
    writeFileSync(join(tempDir, 'barrel.ts'), `export { val } from "./core.ts";\n`);
    writeFileSync(join(tempDir, 'consumer.ts'), `import { val } from "./barrel.ts";\nconsole.log(val);\n`);

    const hypothesis: HypothesisTuple = {
      target: 'core.ts',
      pattern: 'dependency-check',
      workspace: tempDir,
    };

    const verdict = await verify(hypothesis);
    expect(verdict.verified).toBe(true);
    // barrel re-exports core → consumer imports barrel → both are dependents
    expect(verdict.evidence).toHaveLength(2);
    const depFiles = verdict.evidence.map((e) => e.file).sort();
    expect(depFiles).toEqual(['barrel.ts', 'consumer.ts']);
  });

  test('tsconfig paths: alias imports resolve correctly for blast radius', async () => {
    // Create src/ directory with a module
    mkdirSync(join(tempDir, 'src', 'utils'), { recursive: true });
    writeFileSync(join(tempDir, 'src/utils/math.ts'), `export function add(a: number, b: number) { return a + b; }\n`);

    // Consumer uses path alias: @/utils/math
    writeFileSync(join(tempDir, 'src/app.ts'), `import { add } from "@/utils/math";\nconsole.log(add(1, 2));\n`);

    // Another consumer uses relative path
    writeFileSync(join(tempDir, 'src/other.ts'), `import { add } from "./utils/math.ts";\nconsole.log(add(3, 4));\n`);

    // tsconfig.json with paths
    writeFileSync(
      join(tempDir, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: {
          baseUrl: '.',
          paths: { '@/*': ['src/*'] },
        },
      }),
    );

    const hypothesis: HypothesisTuple = {
      target: 'src/utils/math.ts',
      pattern: 'dependency-check',
      workspace: tempDir,
    };

    const verdict = await verify(hypothesis);
    expect(verdict.verified).toBe(true);
    // Both app.ts (via alias) and other.ts (via relative) depend on math.ts
    expect(verdict.evidence).toHaveLength(2);
    const depFiles = verdict.evidence.map((e) => e.file).sort();
    expect(depFiles).toEqual(['src/app.ts', 'src/other.ts']);
  });
});
