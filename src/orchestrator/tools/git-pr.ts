/**
 * git_pr — open a GitHub pull request via the `gh` CLI.
 *
 * Ship policy blocks:
 *   - Unknown PR base branches (only main/master/develop/next are allowed).
 *   - Empty or >70-char titles.
 *
 * Degrades gracefully when `gh` is not installed — returns code=gh_not_installed
 * so the caller can fall back to instructing the user, rather than hard-crashing.
 *
 * Defaults to `--draft` to make the "Ship it!" moment reviewable rather than
 * auto-published; the agent must explicitly pass draft=false to publish.
 */

import { makeResult } from './tool-helpers.ts';
import { approvePr } from './ship-policy.ts';
import type { Tool, ToolDescriptor } from './tool-interface.ts';

async function whichGh(cwd: string): Promise<boolean> {
  try {
    // Inherit current PATH explicitly so callers (and tests) that mutate
    // `process.env.PATH` see the change reflected here.
    const proc = Bun.spawn(['gh', '--version'], {
      cwd,
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...process.env },
    });
    await proc.exited;
    return proc.exitCode === 0;
  } catch {
    return false;
  }
}

export const gitPr: Tool = {
  name: 'git_pr',
  description: `Open a GitHub pull request via the \`gh\` CLI.

Usage:
- Requires \`gh\` to be installed + authenticated. Returns code=gh_not_installed otherwise (does not crash).
- Defaults to draft=true — pass draft=false to publish immediately.
- Base branch must be in main / master / develop / next.
- Title max 70 chars (github renders longer titles poorly).`,
  minIsolationLevel: 1,
  category: 'vcs',
  sideEffect: true,
  descriptor(): ToolDescriptor {
    return {
      name: 'git_pr',
      description: this.description,
      inputSchema: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'PR title (1-70 chars)' },
          body: { type: 'string', description: 'PR body (markdown accepted)' },
          base: { type: 'string', description: 'Base branch (default: main)' },
          draft: { type: 'boolean', description: 'Open as draft (default true)' },
        },
        required: ['title', 'body'],
      },
      category: 'vcs',
      sideEffect: true,
      minRoutingLevel: 1,
      toolKind: 'executable',
    };
  },
  async execute(params, context) {
    const callId = (params.callId as string) ?? '';
    const title = String(params.title ?? '');
    const body = String(params.body ?? '');
    const base = String(params.base ?? 'main');
    const draft = params.draft !== false;

    const policy = approvePr({ title, base });
    if (!policy.allowed) {
      return makeResult(callId, 'git_pr', {
        status: 'denied',
        error: policy.reason,
        output: { code: policy.code },
      });
    }

    const ghAvailable = await whichGh(context.workspace);
    if (!ghAvailable) {
      return makeResult(callId, 'git_pr', {
        status: 'error',
        error: 'gh CLI not installed or not on PATH',
        output: { code: 'gh_not_installed' },
      });
    }

    const args = ['gh', 'pr', 'create', '--title', title, '--body-file', '-', '--base', base];
    if (draft) args.push('--draft');

    try {
      const proc = Bun.spawn(args, {
        cwd: context.workspace,
        stdin: 'pipe',
        stdout: 'pipe',
        stderr: 'pipe',
        env: { ...process.env, GH_PROMPT_DISABLED: '1' },
      });
      if (proc.stdin) {
        proc.stdin.write(body);
        await proc.stdin.end();
      }
      await proc.exited;
      const stdout = await new Response(proc.stdout).text();
      const stderr = await new Response(proc.stderr).text();
      if (proc.exitCode !== 0) {
        return makeResult(callId, 'git_pr', {
          status: 'error',
          error: stderr.trim() || stdout.trim() || `gh pr create exited ${proc.exitCode}`,
        });
      }
      // gh prints the PR URL on stdout.
      const url = stdout.trim().split('\n').find((line) => line.startsWith('http')) ?? stdout.trim();
      return makeResult(callId, 'git_pr', {
        status: 'success',
        output: {
          url,
          title,
          base,
          draft,
        },
      });
    } catch (e) {
      return makeResult(callId, 'git_pr', {
        status: 'error',
        error: e instanceof Error ? e.message : String(e),
      });
    }
  },
};
