/**
 * Phase 7d-2: Tests for permission config schema + loader. Covers valid
 * configs, defaults, missing files, invalid JSON, schema violations, and
 * per-workspace caching.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  clearPermissionConfigCache,
  loadPermissionConfig,
} from '../../../src/orchestrator/permissions/permission-loader.ts';
import {
  EMPTY_PERMISSION_CONFIG,
  PermissionConfigSchema,
} from '../../../src/orchestrator/permissions/permission-schema.ts';

function writePermissionFile(workspace: string, content: string): void {
  const dotVinyan = join(workspace, '.vinyan');
  mkdirSync(dotVinyan, { recursive: true });
  writeFileSync(join(dotVinyan, 'permissions.json'), content);
}

describe('PermissionConfigSchema', () => {
  test('empty object yields empty rule arrays', () => {
    const parsed = PermissionConfigSchema.parse({});
    expect(parsed.deny).toEqual([]);
    expect(parsed.allow).toEqual([]);
  });

  test('EMPTY_PERMISSION_CONFIG is structurally equal to schema default', () => {
    expect(EMPTY_PERMISSION_CONFIG.deny).toEqual([]);
    expect(EMPTY_PERMISSION_CONFIG.allow).toEqual([]);
  });

  test('deny and allow arrays parse with tool/match/reason fields', () => {
    const parsed = PermissionConfigSchema.parse({
      deny: [{ tool: 'shell_exec', match: 'rm\\s+-rf', reason: 'destructive' }],
      allow: [{ tool: 'file_write', match: 'src/.*' }],
    });
    expect(parsed.deny[0]!.tool).toBe('shell_exec');
    expect(parsed.deny[0]!.match).toBe('rm\\s+-rf');
    expect(parsed.deny[0]!.reason).toBe('destructive');
    expect(parsed.allow[0]!.tool).toBe('file_write');
    expect(parsed.allow[0]!.match).toBe('src/.*');
  });

  test('tool field is required on every rule', () => {
    const result = PermissionConfigSchema.safeParse({
      deny: [{ match: 'rm -rf' }],
    });
    expect(result.success).toBe(false);
  });

  test('empty tool string is rejected', () => {
    const result = PermissionConfigSchema.safeParse({
      deny: [{ tool: '', match: 'x' }],
    });
    expect(result.success).toBe(false);
  });

  test('match and reason are optional', () => {
    const parsed = PermissionConfigSchema.parse({
      deny: [{ tool: 'shell_exec' }],
    });
    expect(parsed.deny[0]!.match).toBeUndefined();
    expect(parsed.deny[0]!.reason).toBeUndefined();
  });
});

describe('loadPermissionConfig', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'vinyan-perm-loader-'));
    clearPermissionConfigCache();
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
    clearPermissionConfigCache();
  });

  test('missing .vinyan/permissions.json → empty default config', () => {
    const config = loadPermissionConfig(tempDir);
    expect(config.deny).toEqual([]);
    expect(config.allow).toEqual([]);
  });

  test('valid permissions.json parses both arrays', () => {
    writePermissionFile(
      tempDir,
      JSON.stringify({
        deny: [
          { tool: 'shell_exec', match: 'rm\\s+-rf.*', reason: 'destructive' },
          { tool: 'file_write', match: '/etc/.*' },
        ],
        allow: [{ tool: 'file_write', match: 'src/.*' }],
      }),
    );

    const config = loadPermissionConfig(tempDir);
    expect(config.deny).toHaveLength(2);
    expect(config.deny[0]!.tool).toBe('shell_exec');
    expect(config.deny[0]!.reason).toBe('destructive');
    expect(config.allow).toHaveLength(1);
    expect(config.allow[0]!.match).toBe('src/.*');
  });

  test('invalid JSON → throws with clear error', () => {
    writePermissionFile(tempDir, '{ not json ]]');
    expect(() => loadPermissionConfig(tempDir)).toThrow(/Invalid JSON/);
  });

  test('invalid schema → throws with .vinyan/permissions.json in message', () => {
    writePermissionFile(tempDir, JSON.stringify({ deny: [{ match: 'no-tool-field' }] }));
    expect(() => loadPermissionConfig(tempDir)).toThrow(/\.vinyan\/permissions\.json/);
  });

  test('config is cached per workspace', () => {
    writePermissionFile(tempDir, JSON.stringify({ deny: [{ tool: 'shell_exec' }] }));
    const first = loadPermissionConfig(tempDir);
    writePermissionFile(tempDir, JSON.stringify({ deny: [{ tool: 'file_write' }] }));
    const second = loadPermissionConfig(tempDir);
    expect(second.deny[0]!.tool).toBe('shell_exec');
    expect(first).toBe(second);
  });

  test('clearPermissionConfigCache forces a reload', () => {
    writePermissionFile(tempDir, JSON.stringify({ deny: [{ tool: 'shell_exec' }] }));
    loadPermissionConfig(tempDir);
    writePermissionFile(tempDir, JSON.stringify({ deny: [{ tool: 'file_write' }] }));
    clearPermissionConfigCache();
    const config = loadPermissionConfig(tempDir);
    expect(config.deny[0]!.tool).toBe('file_write');
  });
});
