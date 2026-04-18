/**
 * Phase 7d-1: Tests for hook config schema + loader. Covers valid configs,
 * defaults, missing files, invalid JSON, and schema violations.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { clearHookConfigCache, loadHookConfig } from '../../../src/orchestrator/hooks/hook-loader.ts';
import { EMPTY_HOOK_CONFIG, HookConfigSchema } from '../../../src/orchestrator/hooks/hook-schema.ts';

function writeHookFile(workspace: string, content: string): void {
  const dotVinyan = join(workspace, '.vinyan');
  mkdirSync(dotVinyan, { recursive: true });
  writeFileSync(join(dotVinyan, 'hooks.json'), content);
}

describe('HookConfigSchema', () => {
  test('empty object yields empty hooks arrays', () => {
    const parsed = HookConfigSchema.parse({});
    expect(parsed.hooks.PreToolUse).toEqual([]);
    expect(parsed.hooks.PostToolUse).toEqual([]);
  });

  test('EMPTY_HOOK_CONFIG is structurally equal to schema default', () => {
    expect(EMPTY_HOOK_CONFIG.hooks.PreToolUse).toEqual([]);
    expect(EMPTY_HOOK_CONFIG.hooks.PostToolUse).toEqual([]);
  });

  test('matcher defaults to empty string (match-all)', () => {
    const parsed = HookConfigSchema.parse({
      hooks: {
        PreToolUse: [{ hooks: [{ command: 'echo hi' }] }],
      },
    });
    expect(parsed.hooks.PreToolUse[0]!.matcher).toBe('');
  });

  test('command entries default type to "command" and timeout to 5000', () => {
    const parsed = HookConfigSchema.parse({
      hooks: {
        PreToolUse: [{ matcher: 'file_.*', hooks: [{ command: 'echo hi' }] }],
      },
    });
    const hook = parsed.hooks.PreToolUse[0]!.hooks[0]!;
    expect(hook.type).toBe('command');
    expect(hook.timeout).toBe(5000);
    expect(hook.command).toBe('echo hi');
  });

  test('custom timeout is honored', () => {
    const parsed = HookConfigSchema.parse({
      hooks: {
        PreToolUse: [{ matcher: 'shell_exec', hooks: [{ command: 'check.sh', timeout: 10000 }] }],
      },
    });
    expect(parsed.hooks.PreToolUse[0]!.hooks[0]!.timeout).toBe(10000);
  });

  test('rejects empty hooks array on a matcher', () => {
    const result = HookConfigSchema.safeParse({
      hooks: { PreToolUse: [{ matcher: '.*', hooks: [] }] },
    });
    expect(result.success).toBe(false);
  });

  test('rejects empty command string', () => {
    const result = HookConfigSchema.safeParse({
      hooks: { PreToolUse: [{ matcher: '.*', hooks: [{ command: '' }] }] },
    });
    expect(result.success).toBe(false);
  });

  test('rejects timeout above 60000ms cap', () => {
    const result = HookConfigSchema.safeParse({
      hooks: {
        PreToolUse: [{ matcher: '.*', hooks: [{ command: 'x', timeout: 120_000 }] }],
      },
    });
    expect(result.success).toBe(false);
  });

  test('rejects zero or negative timeout', () => {
    const result = HookConfigSchema.safeParse({
      hooks: {
        PreToolUse: [{ matcher: '.*', hooks: [{ command: 'x', timeout: 0 }] }],
      },
    });
    expect(result.success).toBe(false);
  });
});

describe('loadHookConfig', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'vinyan-hook-loader-'));
    clearHookConfigCache();
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
    clearHookConfigCache();
  });

  test('missing .vinyan/hooks.json → empty default config', () => {
    const config = loadHookConfig(tempDir);
    expect(config.hooks.PreToolUse).toEqual([]);
    expect(config.hooks.PostToolUse).toEqual([]);
  });

  test('valid hooks.json parses both event arrays', () => {
    writeHookFile(
      tempDir,
      JSON.stringify({
        hooks: {
          PreToolUse: [{ matcher: 'file_write|file_edit', hooks: [{ command: 'precommit.sh' }] }],
          PostToolUse: [{ matcher: '.*', hooks: [{ command: 'audit.sh', timeout: 3000 }] }],
        },
      }),
    );

    const config = loadHookConfig(tempDir);
    expect(config.hooks.PreToolUse).toHaveLength(1);
    expect(config.hooks.PreToolUse[0]!.matcher).toBe('file_write|file_edit');
    expect(config.hooks.PreToolUse[0]!.hooks[0]!.command).toBe('precommit.sh');
    expect(config.hooks.PostToolUse).toHaveLength(1);
    expect(config.hooks.PostToolUse[0]!.hooks[0]!.timeout).toBe(3000);
  });

  test('invalid JSON → throws with clear error', () => {
    writeHookFile(tempDir, '{ not json ]]');
    expect(() => loadHookConfig(tempDir)).toThrow(/Invalid JSON/);
  });

  test('invalid schema → throws with path in error message', () => {
    writeHookFile(
      tempDir,
      JSON.stringify({
        hooks: {
          PreToolUse: [
            // missing command string
            { matcher: '.*', hooks: [{}] },
          ],
        },
      }),
    );
    expect(() => loadHookConfig(tempDir)).toThrow(/Invalid .vinyan\/hooks.json/);
  });

  test('config is cached per workspace', () => {
    writeHookFile(
      tempDir,
      JSON.stringify({
        hooks: { PreToolUse: [{ matcher: '.*', hooks: [{ command: 'a' }] }] },
      }),
    );
    const first = loadHookConfig(tempDir);
    // Overwrite the file — cached result should NOT reflect the change.
    writeHookFile(
      tempDir,
      JSON.stringify({
        hooks: { PreToolUse: [{ matcher: '.*', hooks: [{ command: 'b' }] }] },
      }),
    );
    const second = loadHookConfig(tempDir);
    expect(second.hooks.PreToolUse[0]!.hooks[0]!.command).toBe('a');
    expect(first).toBe(second); // same reference
  });

  test('clearHookConfigCache forces a reload', () => {
    writeHookFile(
      tempDir,
      JSON.stringify({
        hooks: { PreToolUse: [{ matcher: '.*', hooks: [{ command: 'a' }] }] },
      }),
    );
    loadHookConfig(tempDir);
    writeHookFile(
      tempDir,
      JSON.stringify({
        hooks: { PreToolUse: [{ matcher: '.*', hooks: [{ command: 'b' }] }] },
      }),
    );
    clearHookConfigCache();
    const config = loadHookConfig(tempDir);
    expect(config.hooks.PreToolUse[0]!.hooks[0]!.command).toBe('b');
  });
});
