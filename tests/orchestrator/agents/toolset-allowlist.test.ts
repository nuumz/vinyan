/**
 * Tests for the per-role toolset allowlist (Phase-6, risk M3).
 */
import { describe, expect, test } from 'bun:test';
import {
  areToolsetsAllowedForRole,
  getRoleGrants,
  matchDangerousCategory,
} from '../../../src/orchestrator/agents/toolset-allowlist.ts';

describe('matchDangerousCategory', () => {
  test('shell-* matches shell category', () => {
    expect(matchDangerousCategory('shell-exec')).toBe('shell');
    expect(matchDangerousCategory('shell-read')).toBe('shell');
    expect(matchDangerousCategory('exec-runner')).toBe('shell');
  });

  test('network-* matches network category', () => {
    expect(matchDangerousCategory('network-fetch')).toBe('network');
    expect(matchDangerousCategory('http-client')).toBe('network');
  });

  test('safe toolsets return null', () => {
    expect(matchDangerousCategory('lint-runner')).toBeNull();
    expect(matchDangerousCategory('format-tool')).toBeNull();
    expect(matchDangerousCategory('parse-ast')).toBeNull();
  });
});

describe('areToolsetsAllowedForRole', () => {
  test('developer allows shell, write, mutation toolsets', () => {
    expect(areToolsetsAllowedForRole('developer', ['shell-exec'])).toBe(true);
    expect(areToolsetsAllowedForRole('developer', ['write-fs'])).toBe(true);
    expect(areToolsetsAllowedForRole('developer', ['mutate-source'])).toBe(true);
  });

  test('developer rejects network (not in grants)', () => {
    expect(areToolsetsAllowedForRole('developer', ['network-fetch'])).toBe(false);
  });

  test('researcher allows network only', () => {
    expect(areToolsetsAllowedForRole('researcher', ['network-fetch'])).toBe(true);
    expect(areToolsetsAllowedForRole('researcher', ['shell-exec'])).toBe(false);
  });

  test('mentor / reviewer / coordinator / assistant / concierge reject every dangerous toolset', () => {
    for (const role of ['mentor', 'reviewer', 'coordinator', 'assistant', 'concierge'] as const) {
      expect(areToolsetsAllowedForRole(role, ['shell-exec'])).toBe(false);
      expect(areToolsetsAllowedForRole(role, ['network-fetch'])).toBe(false);
      expect(areToolsetsAllowedForRole(role, ['write-fs'])).toBe(false);
    }
  });

  test('safe toolsets are allowed for every role', () => {
    for (const role of [
      'coordinator',
      'developer',
      'architect',
      'author',
      'reviewer',
      'assistant',
      'researcher',
      'mentor',
      'concierge',
    ] as const) {
      expect(areToolsetsAllowedForRole(role, ['lint-runner', 'format-tool'])).toBe(true);
    }
  });

  test('empty toolset list → trivially allowed', () => {
    expect(areToolsetsAllowedForRole('mentor', [])).toBe(true);
  });

  test('mixed safe + dangerous: deny if ANY dangerous outside grants', () => {
    expect(areToolsetsAllowedForRole('developer', ['lint-runner', 'shell-exec'])).toBe(true);
    expect(areToolsetsAllowedForRole('mentor', ['lint-runner', 'shell-exec'])).toBe(false);
  });

  test('undefined role → reject (defense in depth)', () => {
    expect(areToolsetsAllowedForRole(undefined, ['lint-runner'])).toBe(false);
  });

  test('getRoleGrants returns the configured list', () => {
    const dev = getRoleGrants('developer');
    expect(dev).toContain('shell');
    expect(dev).toContain('write');
    expect(dev).toContain('mutation');
    expect(getRoleGrants('reviewer')).toEqual([]);
  });
});
