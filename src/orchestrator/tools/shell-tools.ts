/**
 * Shell tools — shell_exec.
 */

import { resolve } from 'path';
import type { Tool, ToolDescriptor } from './tool-interface.ts';
import { makeResult, TOOL_TIMEOUT_MS } from './built-in-tools.ts';

export const shellExec: Tool = {
  name: 'shell_exec',
  description: 'Execute a shell command (allowlisted commands only)',
  minIsolationLevel: 1,
  category: 'shell',
  sideEffect: true,
  descriptor(): ToolDescriptor {
    return {
      name: 'shell_exec',
      description: this.description,
      inputSchema: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'Shell command to execute' },
          cwd: { type: 'string', description: 'Working directory' },
        },
        required: ['command'],
      },
      category: 'shell',
      sideEffect: true,
      minRoutingLevel: 2,
    };
  },
  async execute(params, context) {
    const command = params.command as string;

    // Agentic mode: enforce read-only whitelist (A6 — zero-trust execution)
    if (context.overlayDir) {
      const SHELL_READ_ONLY_WHITELIST = [
        'grep', 'find', 'cat', 'head', 'tail', 'ls', 'wc',
        'git log', 'git diff', 'git status', 'git show', 'git blame',
      ];
      const cmd = command.trim();
      const allowed = SHELL_READ_ONLY_WHITELIST.some(
        prefix => cmd === prefix || cmd.startsWith(`${prefix} `),
      );
      if (!allowed) {
        return makeResult((params.callId as string) ?? '', 'shell_exec', {
          status: 'error',
          error: `[BLOCKED] Command not in read-only whitelist. Allowed: ${SHELL_READ_ONLY_WHITELIST.join(', ')}`,
        });
      }
    }

    // Validate cwd if provided — must stay within workspace
    const cwd = params.cwd as string | undefined;
    const effectiveCwd = cwd ? resolve(context.workspace, cwd) : context.workspace;
    if (!effectiveCwd.startsWith(`${context.workspace}/`) && effectiveCwd !== context.workspace) {
      return makeResult((params.callId as string) ?? '', 'shell_exec', {
        status: 'error',
        error: `cwd '${cwd}' escapes workspace`,
      });
    }
    try {
      const proc = Bun.spawn(['sh', '-c', command], {
        cwd: effectiveCwd,
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const timeoutPromise = new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), TOOL_TIMEOUT_MS));
      const processPromise = (async () => {
        const stdout = await new Response(proc.stdout).text();
        const stderr = await new Response(proc.stderr).text();
        const exitCode = await proc.exited;
        return { stdout, stderr, exitCode };
      })();
      const result = await Promise.race([processPromise, timeoutPromise]);
      if (result === 'timeout') {
        proc.kill();
        return makeResult((params.callId as string) ?? '', 'shell_exec', {
          status: 'error',
          error: 'shell_exec timed out after 30s',
        });
      }
      return makeResult((params.callId as string) ?? '', 'shell_exec', {
        status: result.exitCode === 0 ? 'success' : 'error',
        output: result.stdout,
        error: result.exitCode !== 0 ? `Exit code ${result.exitCode}: ${result.stderr}` : undefined,
      });
    } catch (e) {
      return makeResult((params.callId as string) ?? '', 'shell_exec', {
        status: 'error',
        error: e instanceof Error ? e.message : String(e),
      });
    }
  },
};
