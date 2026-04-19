/**
 * Git tools — git_status, git_diff.
 */

import { makeResult } from './built-in-tools.ts';
import type { Tool, ToolDescriptor } from './tool-interface.ts';

export const gitStatus: Tool = {
  name: 'git_status',
  description: `Show the porcelain git status of the workspace.

Usage:
- Output is one line per changed path in machine-readable porcelain format (first column = index state, second = working-tree state). Empty output means the tree is clean.
- Read-only: does not stage, commit, or modify anything. Use it before file_edit to check what the user already has in flight.`,
  minIsolationLevel: 0,
  category: 'vcs',
  sideEffect: false,
  descriptor(): ToolDescriptor {
    return {
      name: 'git_status',
      description: this.description,
      inputSchema: { type: 'object', properties: {}, required: [] },
      category: 'vcs',
      sideEffect: false,
      minRoutingLevel: 1,
      toolKind: 'executable',
    };
  },
  async execute(params, context) {
    try {
      const proc = Bun.spawn(['git', 'status', '--porcelain'], {
        cwd: context.workspace,
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const stdout = await new Response(proc.stdout).text();
      await proc.exited;
      return makeResult((params.callId as string) ?? '', 'git_status', { output: stdout });
    } catch (e) {
      return makeResult((params.callId as string) ?? '', 'git_status', {
        status: 'error',
        error: e instanceof Error ? e.message : String(e),
      });
    }
  },
};

export const gitDiff: Tool = {
  name: 'git_diff',
  description: `Show the current unstaged diff, optionally scoped to one path.

Usage:
- With no file_path: diff of the whole working tree vs HEAD (unstaged changes only — staged changes are not shown).
- With file_path: diff restricted to that file or directory.
- Read-only; does not touch the index. Use this to confirm what your own file_write/file_edit calls changed before calling attempt_completion.`,
  minIsolationLevel: 0,
  category: 'vcs',
  sideEffect: false,
  descriptor(): ToolDescriptor {
    return {
      name: 'git_diff',
      description: this.description,
      inputSchema: {
        type: 'object',
        properties: { file_path: { type: 'string', description: 'File to diff (optional)' } },
        required: [],
      },
      category: 'vcs',
      sideEffect: false,
      minRoutingLevel: 1,
      toolKind: 'executable',
    };
  },
  async execute(params, context) {
    const target = params.file_path as string | undefined;
    const args = ['git', 'diff'];
    if (target) args.push(target);
    try {
      const proc = Bun.spawn(args, {
        cwd: context.workspace,
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const stdout = await new Response(proc.stdout).text();
      await proc.exited;
      return makeResult((params.callId as string) ?? '', 'git_diff', { output: stdout });
    } catch (e) {
      return makeResult((params.callId as string) ?? '', 'git_diff', {
        status: 'error',
        error: e instanceof Error ? e.message : String(e),
      });
    }
  },
};
