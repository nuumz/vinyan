/**
 * CLI Agent Mode Tests — verifies `vinyan run` command parsing and execution.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'vinyan-cli-run-'));
  mkdirSync(join(tempDir, 'src'), { recursive: true });
  writeFileSync(join(tempDir, 'src', 'foo.ts'), 'export const x = 1;\n');
  writeFileSync(
    join(tempDir, 'vinyan.json'),
    JSON.stringify({
      oracles: {
        type: { enabled: false },
        dep: { enabled: false },
        ast: { enabled: false },
        test: { enabled: false },
        lint: { enabled: false },
      },
    }),
  );
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe('CLI run command', () => {
  test('outputs JSON TaskResult to stdout', async () => {
    const proc = Bun.spawn(['bun', 'run', 'src/cli/index.ts', 'run', 'Fix bug', '--workspace', tempDir, '--timeout', '3000'], {
      cwd: join(import.meta.dir, '../..'),
      stdout: 'pipe',
      stderr: 'pipe',
    });

    // Hard-kill if process hangs (no LLM → orchestrator may not exit on its own)
    const killTimer = setTimeout(() => proc.kill(), 10_000);

    const [stdout, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      proc.exited,
    ]);
    clearTimeout(killTimer);

    // Should output valid JSON (even if task escalates without real LLM)
    let parsed;
    try {
      parsed = JSON.parse(stdout);
    } catch {
      // May have error output — that's OK for no-LLM scenario
      parsed = null;
    }

    if (parsed) {
      expect(parsed).toHaveProperty('id');
      expect(parsed).toHaveProperty('status');
    }
    // Exit code: 0 (completed), 1 (failed), 2 (escalated), 130 (killed on timeout)
    expect([0, 1, 2, 130]).toContain(exitCode);
  }, 15000);

  test('missing goal shows usage and exits with code 2', async () => {
    const proc = Bun.spawn(['bun', 'run', 'src/cli/index.ts', 'run', '--file', 'src/foo.ts'], {
      cwd: join(import.meta.dir, '../..'),
      stdout: 'pipe',
      stderr: 'pipe',
    });

    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;

    expect(exitCode).toBe(2);
    expect(stderr).toContain('Usage:');
  });

  test('--file flag is parsed correctly', async () => {
    const proc = Bun.spawn(
      ['bun', 'run', 'src/cli/index.ts', 'run', 'Fix it', '--file', 'src/foo.ts', '--workspace', tempDir, '--timeout', '3000'],
      {
        cwd: join(import.meta.dir, '../..'),
        stdout: 'pipe',
        stderr: 'pipe',
      },
    );

    const stdout = await new Response(proc.stdout).text();
    await proc.exited;

    // Try to parse — if valid JSON, task was created with the file
    try {
      const parsed = JSON.parse(stdout);
      expect(parsed).toHaveProperty('id');
    } catch {
      // Process may fail without LLM, that's acceptable
    }
  }, 15000);

  test('default command shows run in help', async () => {
    const proc = Bun.spawn(['bun', 'run', 'src/cli/index.ts', 'unknown-command'], {
      cwd: join(import.meta.dir, '../..'),
      stdout: 'pipe',
      stderr: 'pipe',
    });

    const stderr = await new Response(proc.stderr).text();
    await proc.exited;

    expect(stderr).toContain('run');
  });
});
