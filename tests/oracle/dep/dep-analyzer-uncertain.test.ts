import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { HypothesisTuple } from '../../../src/core/types.ts';
import { verify } from '../../../src/oracle/dep/dep-analyzer.ts';

describe('dep-oracle uncertain verdict (WU13)', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'vinyan-dep-uncertain-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  test('relative import to missing file → type:uncertain, confidence:0.5', async () => {
    // File A imports ./missing-file.ts which does not exist
    writeFileSync(
      join(tempDir, 'a.ts'),
      `import { something } from "./missing-file.ts";\nexport const a = something;\n`,
    );

    const hypothesis: HypothesisTuple = {
      target: 'a.ts',
      pattern: 'dependency-check',
      workspace: tempDir,
    };

    const verdict = await verify(hypothesis);
    expect(verdict.type).toBe('uncertain');
    expect(verdict.confidence).toBe(0.5);
    expect(verdict.verified).toBe(true);
    expect(verdict.reason).toContain('unresolvable');
  });

  test('all relative imports resolve → NOT uncertain', async () => {
    writeFileSync(join(tempDir, 'utils.ts'), `export const helper = () => {};\n`);
    writeFileSync(join(tempDir, 'consumer.ts'), `import { helper } from "./utils.ts";\nexport const x = helper();\n`);

    const hypothesis: HypothesisTuple = {
      target: 'consumer.ts',
      pattern: 'dependency-check',
      workspace: tempDir,
    };

    const verdict = await verify(hypothesis);
    expect(verdict.type).not.toBe('uncertain');
    expect(verdict.verified).toBe(true);
  });

  test('npm package imports (non-relative) do not trigger uncertain', async () => {
    // Only npm imports — no relative imports at all
    writeFileSync(join(tempDir, 'b.ts'), `import { z } from "zod";\nexport const schema = z.string();\n`);

    const hypothesis: HypothesisTuple = {
      target: 'b.ts',
      pattern: 'dependency-check',
      workspace: tempDir,
    };

    const verdict = await verify(hypothesis);
    // Non-relative unresolvable imports are excluded from the check
    expect(verdict.type).not.toBe('uncertain');
    expect(verdict.verified).toBe(true);
  });

  test('mix of resolvable relative and unresolvable relative → uncertain', async () => {
    writeFileSync(join(tempDir, 'exists.ts'), `export const val = 1;\n`);
    writeFileSync(
      join(tempDir, 'mixed.ts'),
      `import { val } from "./exists.ts";\nimport { other } from "./ghost.ts";\nexport const x = val;\n`,
    );

    const hypothesis: HypothesisTuple = {
      target: 'mixed.ts',
      pattern: 'dependency-check',
      workspace: tempDir,
    };

    const verdict = await verify(hypothesis);
    expect(verdict.type).toBe('uncertain');
    expect(verdict.confidence).toBe(0.5);
  });
});
