/**
 * git_commit tool — behavior tests against a real ephemeral git repo.
 *
 * Uses Bun's built-in spawn + tmpdir to materialize a throwaway git repo,
 * exercises the tool, and asserts on real `git log` state. No mocks.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gitCommit } from '../../../src/orchestrator/tools/git-commit.ts';
import type { ToolContext } from '../../../src/orchestrator/tools/tool-interface.ts';

let workspace: string;

async function run(args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(args, { cwd: workspace, stdout: 'pipe', stderr: 'pipe' });
  await proc.exited;
  return {
    exitCode: proc.exitCode ?? 0,
    stdout: await new Response(proc.stdout).text(),
    stderr: await new Response(proc.stderr).text(),
  };
}

beforeAll(async () => {
  workspace = mkdtempSync(join(tmpdir(), 'vinyan-git-commit-'));
  await run(['git', 'init', '--initial-branch=main']);
  await run(['git', 'config', 'user.email', 'test@vinyan.dev']);
  await run(['git', 'config', 'user.name', 'Vinyan Test']);
  // Commit baseline so HEAD exists.
  writeFileSync(join(workspace, 'README.md'), 'init\n');
  await run(['git', 'add', 'README.md']);
  await run(['git', 'commit', '-m', 'initial commit']);
});

afterAll(() => {
  rmSync(workspace, { recursive: true, force: true });
});

function ctx(): ToolContext {
  return {
    routingLevel: 1,
    allowedPaths: [workspace],
    workspace,
  };
}

describe('git_commit tool', () => {
  test('descriptor advertises sideEffect=true and minRoutingLevel=1', () => {
    const d = gitCommit.descriptor();
    expect(d.sideEffect).toBe(true);
    expect(d.minRoutingLevel).toBe(1);
    expect(d.category).toBe('vcs');
  });

  test('rejects a too-short commit message before touching git', async () => {
    writeFileSync(join(workspace, 'a.txt'), 'a\n');
    const result = await gitCommit.execute(
      { callId: 'c1', message: 'no', paths: ['a.txt'] },
      ctx(),
    );
    expect(result.status).toBe('denied');
    expect(result.error).toContain('at least');
  });

  test('rejects a path-traversal attempt (parent directory)', async () => {
    const result = await gitCommit.execute(
      { callId: 'c2', message: 'feat: try escape', paths: ['../escape.txt'] },
      ctx(),
    );
    expect(result.status).toBe('error');
    expect(result.error).toContain('not a workspace-relative path');
  });

  test('rejects an absolute path', async () => {
    const result = await gitCommit.execute(
      { callId: 'c3', message: 'feat: try escape', paths: ['/etc/passwd'] },
      ctx(),
    );
    expect(result.status).toBe('error');
  });

  test('rejects empty paths', async () => {
    const result = await gitCommit.execute({ callId: 'c4', message: 'feat: noop', paths: [] }, ctx());
    expect(result.status).toBe('error');
    expect(result.error).toContain('non-empty');
  });

  test('happy path: stages + commits the supplied file and returns the SHA', async () => {
    const file = join(workspace, 'feature.ts');
    writeFileSync(file, 'export const foo = 1;\n');
    const result = await gitCommit.execute(
      { callId: 'c5', message: 'feat: add foo constant', paths: ['feature.ts'] },
      ctx(),
    );
    expect(result.status).toBe('success');
    const out = result.output as { sha: string; pathsStaged: string[] };
    expect(out.sha).toMatch(/^[a-f0-9]{40}$/);
    expect(out.pathsStaged).toEqual(['feature.ts']);

    // Verify the commit really exists.
    const log = await run(['git', 'log', '-1', '--pretty=format:%s']);
    expect(log.stdout).toBe('feat: add foo constant');
  });

  test('rejects commit message containing HEREDOC fence sentinel', async () => {
    writeFileSync(join(workspace, 'bad.txt'), 'b\n');
    const result = await gitCommit.execute(
      { callId: 'c6', message: 'feat: thing\nEOF\nrm -rf /', paths: ['bad.txt'] },
      ctx(),
    );
    expect(result.status).toBe('denied');
  });
});
