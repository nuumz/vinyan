/**
 * Git tools — git_status, git_diff.
 */

import type { Tool, ToolDescriptor } from './tool-interface.ts';
import { makeResult } from './built-in-tools.ts';

export const gitStatus: Tool = {
  name: 'git_status',
  description: 'Show git working tree status',
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
  description: 'Show git diff',
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
