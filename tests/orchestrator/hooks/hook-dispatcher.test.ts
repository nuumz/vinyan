/**
 * Phase 7d-1: Tests for the hook dispatcher. Exercises PreToolUse blocking,
 * PostToolUse warnings, regex matching, and fail-open behavior on invalid
 * patterns. Uses real shell hooks so the whole pipe is covered end-to-end.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { dispatchPostToolUse, dispatchPreToolUse } from '../../../src/orchestrator/hooks/hook-dispatcher.ts';
import { HookConfigSchema } from '../../../src/orchestrator/hooks/hook-schema.ts';

function makeConfig(hooks: Parameters<typeof HookConfigSchema.parse>[0]) {
  return HookConfigSchema.parse(hooks);
}

describe('dispatchPreToolUse', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'vinyan-hook-dispatch-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  test('no matchers → passes through unchanged', async () => {
    const config = makeConfig({ hooks: { PreToolUse: [], PostToolUse: [] } });
    const result = await dispatchPreToolUse(
      config,
      { event: 'PreToolUse', tool_name: 'file_write', tool_input: {} },
      { cwd: tempDir },
    );
    expect(result.blocked).toBe(false);
    expect(result.invocations).toHaveLength(0);
  });

  test('matching hook with exit 0 → not blocked', async () => {
    const config = makeConfig({
      hooks: {
        PreToolUse: [{ matcher: 'file_write', hooks: [{ command: 'true' }] }],
      },
    });
    const result = await dispatchPreToolUse(
      config,
      { event: 'PreToolUse', tool_name: 'file_write', tool_input: { file_path: 'x.ts' } },
      { cwd: tempDir },
    );
    expect(result.blocked).toBe(false);
    expect(result.invocations).toHaveLength(1);
  });

  test('matching hook with exit 1 → blocked with stderr reason', async () => {
    const config = makeConfig({
      hooks: {
        PreToolUse: [
          {
            matcher: 'file_write',
            hooks: [{ command: 'echo "blocked by policy" >&2; exit 1' }],
          },
        ],
      },
    });
    const result = await dispatchPreToolUse(
      config,
      { event: 'PreToolUse', tool_name: 'file_write', tool_input: {} },
      { cwd: tempDir },
    );
    expect(result.blocked).toBe(true);
    expect(result.reason).toContain('blocked by policy');
  });

  test('JSON decision=block overrides exit 0', async () => {
    const config = makeConfig({
      hooks: {
        PreToolUse: [
          {
            matcher: 'file_write',
            hooks: [{ command: `echo '{"decision":"block","message":"custom reason"}'` }],
          },
        ],
      },
    });
    const result = await dispatchPreToolUse(
      config,
      { event: 'PreToolUse', tool_name: 'file_write', tool_input: {} },
      { cwd: tempDir },
    );
    expect(result.blocked).toBe(true);
    expect(result.reason).toBe('custom reason');
  });

  test('JSON decision=allow overrides exit 1', async () => {
    const config = makeConfig({
      hooks: {
        PreToolUse: [
          {
            matcher: 'file_write',
            hooks: [{ command: `echo '{"decision":"allow"}'; exit 1` }],
          },
        ],
      },
    });
    const result = await dispatchPreToolUse(
      config,
      { event: 'PreToolUse', tool_name: 'file_write', tool_input: {} },
      { cwd: tempDir },
    );
    expect(result.blocked).toBe(false);
  });

  test('regex matcher matches multiple tools', async () => {
    const config = makeConfig({
      hooks: {
        PreToolUse: [{ matcher: 'file_(write|edit)', hooks: [{ command: 'true' }] }],
      },
    });
    const rw = await dispatchPreToolUse(
      config,
      { event: 'PreToolUse', tool_name: 'file_write', tool_input: {} },
      { cwd: tempDir },
    );
    expect(rw.invocations).toHaveLength(1);

    const re = await dispatchPreToolUse(
      config,
      { event: 'PreToolUse', tool_name: 'file_edit', tool_input: {} },
      { cwd: tempDir },
    );
    expect(re.invocations).toHaveLength(1);

    const rr = await dispatchPreToolUse(
      config,
      { event: 'PreToolUse', tool_name: 'file_read', tool_input: {} },
      { cwd: tempDir },
    );
    expect(rr.invocations).toHaveLength(0);
  });

  test('empty matcher string matches every tool', async () => {
    const config = makeConfig({
      hooks: {
        PreToolUse: [{ matcher: '', hooks: [{ command: 'true' }] }],
      },
    });
    for (const toolName of ['file_read', 'file_write', 'shell_exec', 'git_status']) {
      const result = await dispatchPreToolUse(
        config,
        { event: 'PreToolUse', tool_name: toolName, tool_input: {} },
        { cwd: tempDir },
      );
      expect(result.invocations).toHaveLength(1);
    }
  });

  test('invalid regex matcher is skipped (fail-open)', async () => {
    const config = makeConfig({
      hooks: {
        PreToolUse: [
          { matcher: '(unterminated', hooks: [{ command: 'false' }] },
          { matcher: '.*', hooks: [{ command: 'true' }] },
        ],
      },
    });
    const result = await dispatchPreToolUse(
      config,
      { event: 'PreToolUse', tool_name: 'file_write', tool_input: {} },
      { cwd: tempDir },
    );
    // Only the valid '.*' matcher runs — the bad regex is silently skipped.
    expect(result.invocations).toHaveLength(1);
    expect(result.blocked).toBe(false);
  });

  test('short-circuits on first blocker — later hooks do not run', async () => {
    const config = makeConfig({
      hooks: {
        PreToolUse: [
          { matcher: '.*', hooks: [{ command: 'exit 1' }] },
          { matcher: '.*', hooks: [{ command: 'echo should-not-run' }] },
        ],
      },
    });
    const result = await dispatchPreToolUse(
      config,
      { event: 'PreToolUse', tool_name: 'file_write', tool_input: {} },
      { cwd: tempDir },
    );
    expect(result.blocked).toBe(true);
    expect(result.invocations).toHaveLength(1);
  });

  test('multiple commands under one matcher all run when none block', async () => {
    const config = makeConfig({
      hooks: {
        PreToolUse: [
          {
            matcher: '.*',
            hooks: [{ command: 'true' }, { command: 'true' }, { command: 'true' }],
          },
        ],
      },
    });
    const result = await dispatchPreToolUse(
      config,
      { event: 'PreToolUse', tool_name: 'file_write', tool_input: {} },
      { cwd: tempDir },
    );
    expect(result.invocations).toHaveLength(3);
    expect(result.blocked).toBe(false);
  });

  test('timeout in hook is surfaced as a blocking reason', async () => {
    const config = makeConfig({
      hooks: {
        PreToolUse: [{ matcher: '.*', hooks: [{ command: 'sleep 10', timeout: 100 }] }],
      },
    });
    const result = await dispatchPreToolUse(
      config,
      { event: 'PreToolUse', tool_name: 'file_write', tool_input: {} },
      { cwd: tempDir },
    );
    expect(result.blocked).toBe(true);
    expect(result.reason).toContain('timed out');
  });
});

describe('dispatchPostToolUse', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'vinyan-hook-post-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  test('no matchers → no warnings', async () => {
    const config = makeConfig({ hooks: { PreToolUse: [], PostToolUse: [] } });
    const result = await dispatchPostToolUse(
      config,
      {
        event: 'PostToolUse',
        tool_name: 'file_write',
        tool_input: {},
        tool_output: 'Wrote x.ts',
        tool_status: 'success',
      },
      { cwd: tempDir },
    );
    expect(result.warnings).toEqual([]);
    expect(result.invocations).toHaveLength(0);
  });

  test('passing hook → no warning', async () => {
    const config = makeConfig({
      hooks: {
        PostToolUse: [{ matcher: '.*', hooks: [{ command: 'true' }] }],
      },
    });
    const result = await dispatchPostToolUse(
      config,
      {
        event: 'PostToolUse',
        tool_name: 'file_write',
        tool_input: {},
        tool_output: '',
        tool_status: 'success',
      },
      { cwd: tempDir },
    );
    expect(result.warnings).toEqual([]);
  });

  test('failing hook contributes a warning string', async () => {
    const config = makeConfig({
      hooks: {
        PostToolUse: [
          {
            matcher: 'file_write',
            hooks: [{ command: 'echo "lint errors" >&2; exit 1' }],
          },
        ],
      },
    });
    const result = await dispatchPostToolUse(
      config,
      {
        event: 'PostToolUse',
        tool_name: 'file_write',
        tool_input: {},
        tool_output: 'Wrote x.ts',
        tool_status: 'success',
      },
      { cwd: tempDir },
    );
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain('lint errors');
  });

  test('PostToolUse does NOT short-circuit on failure — every matching hook runs', async () => {
    const config = makeConfig({
      hooks: {
        PostToolUse: [
          { matcher: '.*', hooks: [{ command: 'exit 1' }] },
          { matcher: '.*', hooks: [{ command: 'true' }] },
          { matcher: '.*', hooks: [{ command: 'exit 2' }] },
        ],
      },
    });
    const result = await dispatchPostToolUse(
      config,
      {
        event: 'PostToolUse',
        tool_name: 'file_write',
        tool_input: {},
        tool_output: '',
        tool_status: 'success',
      },
      { cwd: tempDir },
    );
    expect(result.invocations).toHaveLength(3);
    expect(result.warnings).toHaveLength(2);
  });

  test('tool_output is passed to the hook via stdin', async () => {
    const config = makeConfig({
      hooks: {
        PostToolUse: [
          {
            matcher: '.*',
            hooks: [
              {
                // Hook reads stdin, parses JSON, exits non-zero if the tool_output
                // field is missing so we can assert delivery.
                command: `python3 -c "import json,sys; d=json.load(sys.stdin); sys.exit(0 if d['tool_output']=='expected-output' else 1)"`,
              },
            ],
          },
        ],
      },
    });
    const result = await dispatchPostToolUse(
      config,
      {
        event: 'PostToolUse',
        tool_name: 'file_write',
        tool_input: {},
        tool_output: 'expected-output',
        tool_status: 'success',
      },
      { cwd: tempDir },
    );
    expect(result.warnings).toEqual([]);
  });
});
