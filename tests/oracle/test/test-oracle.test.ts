import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { HypothesisTuple, OracleVerdict } from '../../../src/core/types.ts';
import { isAbstention } from '../../../src/core/types.ts';
import { verify } from '../../../src/oracle/test/test-verifier.ts';

describe('test-oracle', () => {
  let workspace: string;

  beforeAll(() => {
    workspace = mkdtempSync(join(tmpdir(), 'vinyan-test-oracle-'));

    // Create a minimal bun project
    writeFileSync(join(workspace, 'package.json'), JSON.stringify({ name: 'test-fixture' }));
    writeFileSync(join(workspace, 'bun.lockb'), '');

    // Source files
    mkdirSync(join(workspace, 'src'), { recursive: true });
    writeFileSync(join(workspace, 'src', 'math.ts'), 'export function add(a: number, b: number) { return a + b; }\n');

    // Passing test
    mkdirSync(join(workspace, 'tests'), { recursive: true });
    writeFileSync(
      join(workspace, 'tests', 'math.test.ts'),
      `import { test, expect } from "bun:test";
import { add } from "../src/math.ts";
test("add works", () => { expect(add(1, 2)).toBe(3); });
`,
    );

    // Failing test
    writeFileSync(
      join(workspace, 'tests', 'fail.test.ts'),
      `import { test, expect } from "bun:test";
test("always fails", () => { expect(1).toBe(2); });
`,
    );
  });

  afterAll(() => {
    rmSync(workspace, { recursive: true, force: true });
  });

  test('returns verified=true when tests pass', async () => {
    const hypothesis: HypothesisTuple = {
      target: 'src/math.ts',
      pattern: 'test-pass',
      workspace,
    };
    const response = await verify(hypothesis);
    expect(isAbstention(response)).toBe(false);
    const verdict = response as OracleVerdict;
    expect(verdict.verified).toBe(true);
    expect(verdict.durationMs).toBeGreaterThan(0);
  }, 10_000);

  test('returns verified=false when tests fail', async () => {
    writeFileSync(join(workspace, 'src', 'broken.ts'), 'export const x = 1;\n');
    writeFileSync(
      join(workspace, 'tests', 'broken.test.ts'),
      `import { test, expect } from "bun:test";
test("broken", () => { expect(1).toBe(2); });
`,
    );

    const hypothesis: HypothesisTuple = {
      target: 'src/broken.ts',
      pattern: 'test-pass',
      workspace,
    };
    const response = await verify(hypothesis);
    expect(isAbstention(response)).toBe(false);
    const verdict = response as OracleVerdict;
    expect(verdict.verified).toBe(false);
    expect(verdict.reason).toBeDefined();
  }, 10_000);

  test('returns OracleAbstention when no test file exists', async () => {
    const hypothesis: HypothesisTuple = {
      target: 'src/no-tests-for-this.ts',
      pattern: 'test-pass',
      workspace,
    };
    const response = await verify(hypothesis);
    expect(isAbstention(response)).toBe(true);
    if (isAbstention(response)) {
      expect(response.type).toBe('abstained');
      expect(response.reason).toBe('no_test_files');
      expect(response.oracleName).toBe('test');
      expect(response.durationMs).toBeGreaterThanOrEqual(0);
      expect(response.prerequisites).toBeDefined();
    }
  });
});
