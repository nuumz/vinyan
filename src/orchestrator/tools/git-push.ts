/**
 * git_push — push a local branch to its remote.
 *
 * Ship-policy hard blocks:
 *   - force-push / force-with-lease to any PROTECTED_BRANCHES (main, master,
 *     release, production) cannot be overridden at the prompt.
 *   - Remote name must be alphanumeric + `._-` to keep it safe for argv.
 *
 * A6: subprocess spawn with fixed argv — no shell interpolation. The branch
 * name is validated against a conservative ref regex before dispatch.
 */

import { makeResult } from './tool-helpers.ts';
import { approvePush } from './ship-policy.ts';
import type { Tool, ToolDescriptor } from './tool-interface.ts';

export const gitPush: Tool = {
  name: 'git_push',
  description: `Push the local branch to a remote.

Usage:
- Pass \`branch\` explicitly — the tool never infers the current branch.
- \`force=true\` is rejected for protected branches (main, master, release, production).
- Returns stdout from \`git push\` on success.
- Non-interactive: if git prompts for a credential the tool fails fast.`,
  minIsolationLevel: 1,
  category: 'vcs',
  sideEffect: true,
  descriptor(): ToolDescriptor {
    return {
      name: 'git_push',
      description: this.description,
      inputSchema: {
        type: 'object',
        properties: {
          branch: { type: 'string', description: 'Branch name to push' },
          remote: { type: 'string', description: 'Remote name (default: origin)' },
          setUpstream: { type: 'boolean', description: 'Pass -u to set upstream' },
          force: { type: 'boolean', description: 'Force push — blocked for protected branches' },
          forceWithLease: { type: 'boolean', description: 'Force-with-lease — blocked for protected branches' },
        },
        required: ['branch'],
      },
      category: 'vcs',
      sideEffect: true,
      minRoutingLevel: 1,
      toolKind: 'executable',
    };
  },
  async execute(params, context) {
    const callId = (params.callId as string) ?? '';
    const branch = String(params.branch ?? '');
    const remote = String(params.remote ?? 'origin');
    const setUpstream = params.setUpstream === true;
    const force = params.force === true;
    const forceWithLease = params.forceWithLease === true;

    const policy = approvePush({ branch, remote, force, forceWithLease });
    if (!policy.allowed) {
      return makeResult(callId, 'git_push', {
        status: 'denied',
        error: policy.reason,
        output: { code: policy.code },
      });
    }

    const args = ['git', 'push'];
    if (setUpstream) args.push('-u');
    if (force) args.push('--force');
    if (forceWithLease) args.push('--force-with-lease');
    args.push(remote, branch);

    try {
      const proc = Bun.spawn(args, {
        cwd: context.workspace,
        stdout: 'pipe',
        stderr: 'pipe',
        // Surface a clear failure instead of blocking on an interactive prompt.
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      });
      await proc.exited;
      const stdout = await new Response(proc.stdout).text();
      const stderr = await new Response(proc.stderr).text();
      if (proc.exitCode !== 0) {
        return makeResult(callId, 'git_push', {
          status: 'error',
          error: stderr.trim() || stdout.trim() || `git push exited ${proc.exitCode}`,
        });
      }
      return makeResult(callId, 'git_push', {
        status: 'success',
        output: {
          remote,
          branch,
          stdout: stdout.trim(),
          stderr: stderr.trim(),
        },
      });
    } catch (e) {
      return makeResult(callId, 'git_push', {
        status: 'error',
        error: e instanceof Error ? e.message : String(e),
      });
    }
  },
};
