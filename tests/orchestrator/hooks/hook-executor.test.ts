/**
 * Phase 7d-1: Tests for the hook executor. Exercises real shell commands
 * through Bun.spawn so we cover the full pipe / exit-code / JSON-parse
 * path rather than mocking process I/O.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { executeHook } from '../../../src/orchestrator/hooks/hook-executor.ts';

describe('executeHook', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'vinyan-hook-exec-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  test('happy path — exit 0 with no stdout is a silent allow', async () => {
    const result = await executeHook(
      'true',
      { event: 'PreToolUse' },
      {
        timeoutMs: 5000,
        cwd: tempDir,
      },
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('');
    expect(result.timedOut).toBe(false);
    expect(result.decision).toBeUndefined();
    expect(result.message).toBeUndefined();
  });

  test('non-zero exit is captured with stderr', async () => {
    const result = await executeHook(
      'echo "nope" >&2; exit 2',
      { event: 'PreToolUse' },
      { timeoutMs: 5000, cwd: tempDir },
    );
    expect(result.exitCode).toBe(2);
    expect(result.stderr.trim()).toBe('nope');
  });

  test('JSON stdout with decision=block is parsed', async () => {
    const result = await executeHook(
      `echo '{"decision":"block","message":"no writes to src/core"}'`,
      { event: 'PreToolUse' },
      { timeoutMs: 5000, cwd: tempDir },
    );
    expect(result.exitCode).toBe(0);
    expect(result.decision).toBe('block');
    expect(result.message).toBe('no writes to src/core');
  });

  test('JSON stdout with decision=allow is parsed', async () => {
    const result = await executeHook(
      `echo '{"decision":"allow"}'; exit 1`,
      { event: 'PreToolUse' },
      { timeoutMs: 5000, cwd: tempDir },
    );
    // Exit 1 but explicit allow — dispatcher will interpret precedence;
    // here we just assert the parse is correct.
    expect(result.decision).toBe('allow');
    expect(result.exitCode).toBe(1);
  });

  test('non-JSON stdout does not fail the executor', async () => {
    const result = await executeHook(
      'echo "plain text output"',
      { event: 'PreToolUse' },
      { timeoutMs: 5000, cwd: tempDir },
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('plain text output');
    expect(result.decision).toBeUndefined();
  });

  test('partial JSON-looking stdout is tolerated', async () => {
    const result = await executeHook(
      `echo '{ not actually json'`,
      { event: 'PreToolUse' },
      { timeoutMs: 5000, cwd: tempDir },
    );
    expect(result.exitCode).toBe(0);
    expect(result.decision).toBeUndefined();
  });

  test('stdin payload is delivered to the hook as JSON', async () => {
    // Hook reads stdin and echoes the event field back via stdout. We parse
    // the stdout JSON and assert it matches what we wrote.
    const result = await executeHook(
      `cat`,
      { event: 'PreToolUse', tool_name: 'file_write', tool_input: { file_path: 'src/x.ts' } },
      { timeoutMs: 5000, cwd: tempDir },
    );
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout.trim()) as {
      event: string;
      tool_name: string;
      tool_input: { file_path: string };
    };
    expect(parsed.event).toBe('PreToolUse');
    expect(parsed.tool_name).toBe('file_write');
    expect(parsed.tool_input.file_path).toBe('src/x.ts');
  });

  test('timeout kills runaway hooks and marks timedOut', async () => {
    const result = await executeHook('sleep 10', { event: 'PreToolUse' }, { timeoutMs: 100, cwd: tempDir });
    expect(result.timedOut).toBe(true);
    expect(result.exitCode).toBe(-1);
    expect(result.stderr).toContain('timed out');
  });

  test('cwd option is honored', async () => {
    // pwd prints the current directory; we assert it's the tempDir.
    const result = await executeHook('pwd', { event: 'PreToolUse' }, { timeoutMs: 5000, cwd: tempDir });
    expect(result.exitCode).toBe(0);
    // tmpDir on macOS may be a symlink (/var vs /private/var); accept both.
    expect(result.stdout).toMatch(new RegExp(tempDir.replace(/^\/var/, '(/private)?/var').replace(/\//g, '\\/')));
  });

  test('decision must be exactly "block" or "allow" — unknown values ignored', async () => {
    const result = await executeHook(
      `echo '{"decision":"maybe"}'`,
      { event: 'PreToolUse' },
      { timeoutMs: 5000, cwd: tempDir },
    );
    expect(result.decision).toBeUndefined();
  });

  test('duration is recorded in ms', async () => {
    const result = await executeHook('true', { event: 'PreToolUse' }, { timeoutMs: 5000, cwd: tempDir });
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(result.durationMs).toBeLessThan(5000);
  });
});
