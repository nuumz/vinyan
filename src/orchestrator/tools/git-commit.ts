/**
 * git_commit — stage supplied paths and produce a commit with a validated message.
 *
 * Policy: every invocation runs through ship-policy.approveCommitMessage
 * first; rejected messages never reach `git`. The tool stages ONLY the paths
 * the caller named (never `git add -A`) — this is a deliberate safety choice
 * so an agent with the tool cannot accidentally commit secrets from an
 * unrelated file edit it has forgotten about.
 *
 * A6: subprocess spawn with fixed argv — command injection via shell
 * interpolation is not possible. The commit message is passed via `-F -`
 * (stdin), so metachars are safe.
 */

import { makeResult } from './tool-helpers.ts';
import { approveCommitMessage } from './ship-policy.ts';
import type { Tool, ToolDescriptor } from './tool-interface.ts';

export const gitCommit: Tool = {
  name: 'git_commit',
  description: `Create a commit from staged files with the supplied message.

Usage:
- Stages ONLY the paths you pass in \`paths\`; never the whole working tree.
- \`message\` is validated by ship policy (min length, no HEREDOC-fence sentinel).
- Returns the new commit SHA on success, or an error with code on rejection.
- Does not push — use git_push for that.`,
  minIsolationLevel: 1,
  category: 'vcs',
  sideEffect: true,
  descriptor(): ToolDescriptor {
    return {
      name: 'git_commit',
      description: this.description,
      inputSchema: {
        type: 'object',
        properties: {
          message: { type: 'string', description: 'Commit message (≥10 chars)' },
          paths: { type: 'array', description: 'Paths to stage + commit', items: { type: 'string' } },
          signoff: { type: 'boolean', description: 'Pass --signoff to git commit' },
          allowEmpty: {
            type: 'boolean',
            description: 'Pass --allow-empty (for merge commits or ci checks); default false',
          },
        },
        required: ['message', 'paths'],
      },
      category: 'vcs',
      sideEffect: true,
      minRoutingLevel: 1,
      toolKind: 'executable',
    };
  },
  async execute(params, context) {
    const callId = (params.callId as string) ?? '';
    const message = String(params.message ?? '');
    const paths = Array.isArray(params.paths) ? (params.paths as unknown[]).map(String) : [];
    const signoff = params.signoff === true;
    const allowEmpty = params.allowEmpty === true;

    const policy = approveCommitMessage(message);
    if (!policy.allowed) {
      return makeResult(callId, 'git_commit', {
        status: 'denied',
        error: policy.reason,
        output: { code: policy.code },
      });
    }

    if (paths.length === 0) {
      return makeResult(callId, 'git_commit', {
        status: 'error',
        error: 'paths must be non-empty (git_commit never stages the whole tree)',
      });
    }

    // Reject any path with `..` or leading `/` — guard against path-traversal
    // into parents or absolute paths outside the workspace.
    for (const p of paths) {
      if (p.startsWith('/') || p.split('/').some((seg) => seg === '..')) {
        return makeResult(callId, 'git_commit', {
          status: 'error',
          error: `path '${p}' is not a workspace-relative path`,
        });
      }
    }

    try {
      // Stage only the supplied paths (never `-A`).
      const addProc = Bun.spawn(['git', 'add', '--', ...paths], {
        cwd: context.workspace,
        stdout: 'pipe',
        stderr: 'pipe',
      });
      await addProc.exited;
      if (addProc.exitCode !== 0) {
        const stderr = await new Response(addProc.stderr).text();
        return makeResult(callId, 'git_commit', {
          status: 'error',
          error: `git add failed: ${stderr.trim()}`,
        });
      }

      // Commit with message via stdin (`-F -`) — avoids all shell escaping.
      const commitArgs = ['git', 'commit', '-F', '-'];
      if (signoff) commitArgs.push('--signoff');
      if (allowEmpty) commitArgs.push('--allow-empty');
      const commitProc = Bun.spawn(commitArgs, {
        cwd: context.workspace,
        stdin: 'pipe',
        stdout: 'pipe',
        stderr: 'pipe',
      });
      if (commitProc.stdin) {
        commitProc.stdin.write(message);
        await commitProc.stdin.end();
      }
      await commitProc.exited;
      const stdout = await new Response(commitProc.stdout).text();
      const stderr = await new Response(commitProc.stderr).text();
      if (commitProc.exitCode !== 0) {
        return makeResult(callId, 'git_commit', {
          status: 'error',
          error: `git commit failed: ${stderr.trim() || stdout.trim()}`,
        });
      }

      // Fetch the new HEAD SHA so the caller can confirm / reference it.
      const shaProc = Bun.spawn(['git', 'rev-parse', 'HEAD'], {
        cwd: context.workspace,
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const shaStdout = await new Response(shaProc.stdout).text();
      await shaProc.exited;
      const sha = shaStdout.trim();

      return makeResult(callId, 'git_commit', {
        status: 'success',
        output: {
          sha,
          message,
          pathsStaged: paths,
          commitOutput: stdout.trim(),
        },
      });
    } catch (e) {
      return makeResult(callId, 'git_commit', {
        status: 'error',
        error: e instanceof Error ? e.message : String(e),
      });
    }
  },
};
