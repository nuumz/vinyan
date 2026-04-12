/**
 * Phase 7d-2: Tests for the permission DSL evaluator. Covers deny-wins,
 * explicit allow, pass-through, regex matching, invalid regex fail-open,
 * and exact tool-name matching.
 */

import { describe, expect, test } from 'bun:test';
import { evaluatePermission } from '../../../src/orchestrator/permissions/permission-checker.ts';
import {
  type PermissionConfig,
  PermissionConfigSchema,
} from '../../../src/orchestrator/permissions/permission-schema.ts';

function cfg(config: Parameters<typeof PermissionConfigSchema.parse>[0]): PermissionConfig {
  return PermissionConfigSchema.parse(config);
}

describe('evaluatePermission', () => {
  test('empty config → pass for every tool', () => {
    const config = cfg({});
    const result = evaluatePermission(config, 'file_write', { file_path: 'x.ts' });
    expect(result.decision).toBe('pass');
  });

  test('deny rule matches on tool name only → deny', () => {
    const config = cfg({
      deny: [{ tool: 'shell_exec', reason: 'no shell allowed' }],
    });
    const result = evaluatePermission(config, 'shell_exec', { command: 'ls' });
    expect(result.decision).toBe('deny');
    expect(result.reason).toBe('no shell allowed');
    expect(result.matchedRule?.tool).toBe('shell_exec');
  });

  test('deny rule with no reason gets a sensible default', () => {
    const config = cfg({ deny: [{ tool: 'file_write' }] });
    const result = evaluatePermission(config, 'file_write', {});
    expect(result.decision).toBe('deny');
    expect(result.reason).toContain('file_write');
  });

  test('deny rule with regex match → deny only on match', () => {
    const config = cfg({
      deny: [{ tool: 'shell_exec', match: 'rm\\s+-rf', reason: 'destructive' }],
    });
    const dangerous = evaluatePermission(config, 'shell_exec', {
      command: 'rm -rf /tmp/foo',
    });
    expect(dangerous.decision).toBe('deny');
    expect(dangerous.reason).toBe('destructive');

    const harmless = evaluatePermission(config, 'shell_exec', {
      command: 'ls -la',
    });
    expect(harmless.decision).toBe('pass');
  });

  test('deny beats allow when both match', () => {
    const config = cfg({
      deny: [{ tool: 'file_write', match: '/etc/' }],
      allow: [{ tool: 'file_write' }],
    });
    const result = evaluatePermission(config, 'file_write', {
      file_path: '/etc/passwd',
    });
    expect(result.decision).toBe('deny');
  });

  test('allow rule → explicit allow', () => {
    const config = cfg({
      allow: [{ tool: 'file_write', match: 'src/' }],
    });
    const result = evaluatePermission(config, 'file_write', {
      file_path: 'src/core/main.ts',
    });
    expect(result.decision).toBe('allow');
    expect(result.matchedRule?.tool).toBe('file_write');
  });

  test('tool name must match exactly (not regex)', () => {
    const config = cfg({ deny: [{ tool: 'file_.*' }] });
    // Tool name `file_write` does not equal the literal string `file_.*`
    const result = evaluatePermission(config, 'file_write', {});
    expect(result.decision).toBe('pass');
  });

  test('invalid regex in match → rule silently skipped (fail-open)', () => {
    const config = cfg({
      deny: [{ tool: 'shell_exec', match: '(unterminated' }],
    });
    const result = evaluatePermission(config, 'shell_exec', { command: 'ls' });
    // Bad regex → no match → rule doesn't apply → pass
    expect(result.decision).toBe('pass');
  });

  test('multiple deny rules: first match wins on short-circuit', () => {
    const config = cfg({
      deny: [
        { tool: 'shell_exec', match: 'rm', reason: 'first' },
        { tool: 'shell_exec', match: '.*', reason: 'second' },
      ],
    });
    const result = evaluatePermission(config, 'shell_exec', {
      command: 'rm -rf x',
    });
    expect(result.decision).toBe('deny');
    expect(result.reason).toBe('first');
  });

  test('pass-through when no rule matches any field', () => {
    const config = cfg({
      deny: [{ tool: 'file_write', match: '/etc/' }],
      allow: [{ tool: 'file_write', match: '/tmp/' }],
    });
    const result = evaluatePermission(config, 'file_read', {
      file_path: '/home/user/x.ts',
    });
    expect(result.decision).toBe('pass');
  });

  test('match against nested object uses JSON stringify', () => {
    const config = cfg({
      deny: [{ tool: 'shell_exec', match: '"rm -rf"' }],
    });
    const result = evaluatePermission(config, 'shell_exec', {
      nested: { command: 'rm -rf' },
    });
    // JSON.stringify produces `{"nested":{"command":"rm -rf"}}`, which contains
    // the substring `"rm -rf"`.
    expect(result.decision).toBe('deny');
  });

  test('undefined and null tool_input are tolerated (serialize to empty string)', () => {
    // `.*` matches the empty string, so null/undefined input still fires
    // the deny rule — the checker never throws on missing input.
    const config = cfg({
      deny: [{ tool: 'file_read', match: '.*' }],
    });
    const resultNull = evaluatePermission(config, 'file_read', null);
    expect(resultNull.decision).toBe('deny');

    const resultUndef = evaluatePermission(config, 'file_read', undefined);
    expect(resultUndef.decision).toBe('deny');
  });

  test('string tool_input is matched directly without JSON wrapping', () => {
    const config = cfg({
      deny: [{ tool: 'raw_tool', match: '^hello' }],
    });
    const result = evaluatePermission(config, 'raw_tool', 'hello world');
    expect(result.decision).toBe('deny');
  });

  test('empty match string is treated as "match any" (like hook matchers)', () => {
    const config = cfg({
      deny: [{ tool: 'shell_exec', match: '' }],
    });
    const result = evaluatePermission(config, 'shell_exec', { command: 'ls' });
    expect(result.decision).toBe('deny');
  });
});
