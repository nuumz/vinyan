import { beforeEach, describe, expect, test } from 'bun:test';
import {
  clearDynamicOracles,
  getOracleEntry,
  getOraclePath,
  listOracles,
  listOraclesForLanguage,
  registerOracle,
  unregisterOracle,
} from '../../src/oracle/registry.ts';

describe('Oracle Registry', () => {
  beforeEach(() => {
    clearDynamicOracles();
  });

  describe('listOracles', () => {
    test('returns built-in oracles when no dynamics registered', () => {
      const oracles = listOracles();
      expect(oracles).toContain('ast-oracle');
      expect(oracles).toContain('type-oracle');
      expect(oracles).toContain('dep-oracle');
      expect(oracles).toContain('test-oracle');
      expect(oracles).toContain('lint-oracle');
      expect(oracles.length).toBeGreaterThanOrEqual(5);
    });

    test('includes dynamic oracles after registration', () => {
      registerOracle('custom-oracle', { command: 'python run.py', languages: ['python'] });
      const oracles = listOracles();
      expect(oracles).toContain('custom-oracle');
    });
  });

  describe('registerOracle', () => {
    test('registered oracle appears in listOracles', () => {
      registerOracle('my-oracle', { command: 'node oracle.js' });
      expect(listOracles()).toContain('my-oracle');
    });

    test('re-registration overwrites previous entry', () => {
      registerOracle('my-oracle', { command: 'v1' });
      registerOracle('my-oracle', { command: 'v2' });
      const entry = getOracleEntry('my-oracle');
      expect(entry?.command).toBe('v2');
    });

    test('dynamic oracle overrides built-in with same name', () => {
      registerOracle('ast-oracle', { command: 'custom-ast', languages: ['python'] });
      const entry = getOracleEntry('ast-oracle');
      expect(entry?.command).toBe('custom-ast');
    });
  });

  describe('unregisterOracle', () => {
    test('returns true for existing dynamic oracle', () => {
      registerOracle('temp-oracle', { command: 'echo' });
      expect(unregisterOracle('temp-oracle')).toBe(true);
    });

    test('returns false for non-existent oracle', () => {
      expect(unregisterOracle('does-not-exist')).toBe(false);
    });

    test('returns false for built-in oracle (cannot unregister)', () => {
      expect(unregisterOracle('ast-oracle')).toBe(false);
    });

    test('double unregister → first true, second false', () => {
      registerOracle('temp-oracle', { command: 'echo' });
      expect(unregisterOracle('temp-oracle')).toBe(true);
      expect(unregisterOracle('temp-oracle')).toBe(false);
    });
  });

  describe('listOraclesForLanguage', () => {
    test('typescript → returns all built-in oracles', () => {
      const oracles = listOraclesForLanguage('typescript');
      expect(oracles).toContain('ast-oracle');
      expect(oracles).toContain('type-oracle');
      expect(oracles).toContain('dep-oracle');
      expect(oracles).toContain('test-oracle');
      expect(oracles).toContain('lint-oracle');
    });

    test('python → returns only dynamic oracles that support it', () => {
      registerOracle('py-lint', { command: 'ruff', languages: ['python'] });
      const oracles = listOraclesForLanguage('python');
      expect(oracles).toContain('py-lint');
      expect(oracles).not.toContain('ast-oracle');
    });

    test('unknown language → returns empty list', () => {
      expect(listOraclesForLanguage('cobol')).toEqual([]);
    });

    test('dynamic oracle with matching language is included', () => {
      registerOracle('ts-custom', { command: 'echo', languages: ['typescript'] });
      const oracles = listOraclesForLanguage('typescript');
      expect(oracles).toContain('ts-custom');
    });
  });

  describe('clearDynamicOracles', () => {
    test('removes all dynamic oracles', () => {
      registerOracle('a', { command: 'a' });
      registerOracle('b', { command: 'b' });
      clearDynamicOracles();
      const oracles = listOracles();
      expect(oracles).not.toContain('a');
      expect(oracles).not.toContain('b');
    });

    test('built-in oracles survive clear', () => {
      registerOracle('dynamic', { command: 'x' });
      clearDynamicOracles();
      expect(listOracles()).toContain('ast-oracle');
    });
  });

  describe('getOracleEntry', () => {
    test('returns built-in entry', () => {
      const entry = getOracleEntry('ast-oracle');
      expect(entry).toBeDefined();
      expect(entry!.tier).toBe('deterministic');
    });

    test('returns undefined for non-existent oracle', () => {
      expect(getOracleEntry('nope')).toBeUndefined();
    });

    test('dynamic overrides built-in', () => {
      registerOracle('ast-oracle', { command: 'custom', tier: 'heuristic' });
      const entry = getOracleEntry('ast-oracle');
      expect(entry?.command).toBe('custom');
      expect(entry?.tier).toBe('heuristic');
    });
  });

  describe('getOraclePath', () => {
    test('returns path for built-in oracle', () => {
      const path = getOraclePath('ast-oracle');
      expect(path).toBeDefined();
      expect(path).toContain('ast/index.ts');
    });

    test('returns undefined for command-only dynamic oracle', () => {
      registerOracle('cmd-oracle', { command: 'run-it' });
      expect(getOraclePath('cmd-oracle')).toBeUndefined();
    });

    test('returns path for dynamic oracle with path', () => {
      registerOracle('path-oracle', { path: '/custom/oracle.ts' });
      expect(getOraclePath('path-oracle')).toBe('/custom/oracle.ts');
    });
  });
});
