/**
 * Polyglot Oracle Runner Tests — PH5.10
 *
 * Tests dynamic oracle registration and custom command execution.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import type { HypothesisTuple } from '../../src/core/types.ts';
import {
  clearDynamicOracles,
  getOracleEntry,
  listOracles,
  listOraclesForLanguage,
  registerOracle,
  unregisterOracle,
} from '../../src/oracle/registry.ts';
import { runOracle } from '../../src/oracle/runner.ts';

afterEach(() => {
  clearDynamicOracles();
});

const TEST_HYPOTHESIS: HypothesisTuple = {
  target: 'test.py',
  pattern: 'type-check',
  workspace: '/tmp/test',
};

describe('Dynamic Oracle Registration', () => {
  test('registerOracle adds to registry', () => {
    registerOracle('python-type', {
      command: "echo '{}'",
      languages: ['python'],
      tier: 'deterministic',
    });

    expect(listOracles()).toContain('python-type');
    const entry = getOracleEntry('python-type');
    expect(entry?.command).toBe("echo '{}'");
    expect(entry?.languages).toEqual(['python']);
  });

  test('unregisterOracle removes from registry', () => {
    registerOracle('test-oracle-x', { command: 'echo' });
    expect(listOracles()).toContain('test-oracle-x');

    unregisterOracle('test-oracle-x');
    expect(listOracles()).not.toContain('test-oracle-x');
  });

  test('listOraclesForLanguage filters correctly', () => {
    registerOracle('py-oracle', { command: 'pyright', languages: ['python'] });
    registerOracle('go-oracle', { command: 'gopls', languages: ['go'] });

    const pyOracles = listOraclesForLanguage('python');
    expect(pyOracles).toContain('py-oracle');
    expect(pyOracles).not.toContain('go-oracle');

    // TypeScript built-ins
    const tsOracles = listOraclesForLanguage('typescript');
    expect(tsOracles).toContain('ast-oracle');
    expect(tsOracles).toContain('type-oracle');
  });

  test('built-in oracles still work', () => {
    const entry = getOracleEntry('ast-oracle');
    expect(entry).toBeTruthy();
    expect(entry?.path).toBeTruthy();
    expect(entry?.languages).toContain('typescript');
  });
});

describe('Runner with custom command', () => {
  test('custom command oracle executes without crash', async () => {
    // Use a simple command that exits 0 but outputs invalid JSON
    // This tests the runner gracefully handles polyglot oracle output
    const verdict = await runOracle('custom-oracle', TEST_HYPOTHESIS, {
      command: 'echo hello',
      timeoutMs: 5000,
    });

    // echo "hello" is not valid JSON → parse error → returns unknown verdict
    expect(verdict).toBeTruthy();
    expect(verdict.verified).toBe(false);
    expect(verdict.type).toBe('unknown');
    expect(verdict.reason).toContain('parse oracle output');
  });

  test('unknown oracle with no command or path returns unknown verdict', async () => {
    const verdict = await runOracle('nonexistent-oracle', TEST_HYPOTHESIS);

    expect(verdict.verified).toBe(false);
    expect(verdict.type).toBe('unknown');
    expect(verdict.reason).toContain('Unknown oracle');
  });

  test('custom command timeout returns timeout verdict', async () => {
    const verdict = await runOracle('timeout-oracle', TEST_HYPOTHESIS, {
      command: 'sleep 10',
      timeoutMs: 100,
    });

    expect(verdict.verified).toBe(false);
    expect(verdict.type).toBe('unknown');
    expect(verdict.reason).toContain('timed out');
  });
});
