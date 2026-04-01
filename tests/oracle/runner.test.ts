import { describe, expect, test } from 'bun:test';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import type { HypothesisTuple } from '../../src/core/types.ts';
import { runOracle } from '../../src/oracle/runner.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturesDir = resolve(__dirname, 'fixtures');

const baseHypothesis: HypothesisTuple = {
  target: 'src/test.ts',
  pattern: 'symbol-exists',
  workspace: '/tmp/test-workspace',
};

describe('OracleRunner', () => {
  test('echo oracle: stdio protocol round-trip', async () => {
    const verdict = await runOracle('test-echo', baseHypothesis, {
      oraclePath: resolve(fixturesDir, 'echo-oracle.ts'),
    });

    expect(verdict.verified).toBe(true);
    expect(verdict.evidence).toHaveLength(1);
    expect(verdict.evidence[0]!.file).toBe('src/test.ts');
    expect(verdict.evidence[0]!.snippet).toBe('echo: symbol-exists');
    expect(verdict.fileHashes['src/test.ts']).toBe('test-hash');
    expect(verdict.durationMs).toBeGreaterThan(0);
  });

  test('timeout: kills hanging oracle and returns timeout verdict', async () => {
    const verdict = await runOracle('test-hang', baseHypothesis, {
      oraclePath: resolve(fixturesDir, 'hang-oracle.ts'),
      timeoutMs: 500,
    });

    expect(verdict.verified).toBe(false);
    expect(verdict.reason).toContain('timed out');
    expect(verdict.durationMs).toBeGreaterThanOrEqual(400);
  });

  test('bad output: returns parse error verdict', async () => {
    const verdict = await runOracle('test-bad', baseHypothesis, {
      oraclePath: resolve(fixturesDir, 'bad-output-oracle.ts'),
    });

    expect(verdict.verified).toBe(false);
    expect(verdict.reason).toContain('Failed to parse oracle output');
  });

  test('unknown oracle: returns error verdict', async () => {
    const verdict = await runOracle('nonexistent-oracle', baseHypothesis);

    expect(verdict.verified).toBe(false);
    expect(verdict.reason).toContain('Unknown oracle');
  });
});
