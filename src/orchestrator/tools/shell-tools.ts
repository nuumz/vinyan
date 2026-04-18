/**
 * Shell tools — shell_exec.
 */

import { resolve } from 'path';
import { makeResult, TOOL_TIMEOUT_MS } from './built-in-tools.ts';
import type { Tool, ToolDescriptor } from './tool-interface.ts';

const FIRE_AND_FORGET_GRACE_MS = 300;

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
          fireAndForget: {
            type: 'boolean',
            description: 'Return after launch instead of waiting for process exit',
          },
        },
        required: ['command'],
      },
      category: 'shell',
      sideEffect: true,
      minRoutingLevel: 2,
      toolKind: 'executable',
    };
  },
  async execute(params, context) {
    const command = params.command as string;
    const fireAndForget = params.fireAndForget === true;

    // Agentic mode: enforce read-only whitelist (A6 — zero-trust execution)
    if (context.overlayDir) {
      const SHELL_READ_ONLY_WHITELIST = [
        'grep',
        'find',
        'cat',
        'head',
        'tail',
        'ls',
        'wc',
        'git log',
        'git diff',
        'git status',
        'git show',
        'git blame',
      ];
      const cmd = command.trim();
      const allowed = SHELL_READ_ONLY_WHITELIST.some((prefix) => cmd === prefix || cmd.startsWith(`${prefix} `));
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
      if (fireAndForget) {
        if (isLaunchStyleCommand(command)) {
          return await executeLaunchStyleFireAndForget(
            command,
            effectiveCwd,
            (params.callId as string) ?? '',
          );
        }
        return await executeGenericFireAndForget(
          command,
          effectiveCwd,
          (params.callId as string) ?? '',
        );
      }

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

function isLaunchStyleCommand(command: string): boolean {
  return /^(open(\s+-a)?\s|xdg-open\s|start\s+""\s)/i.test(command.trim());
}

async function executeLaunchStyleFireAndForget(command: string, cwd: string, callId: string) {
  const proc = Bun.spawn(['sh', '-c', `${command} >/dev/null 2>&1 &`], {
    cwd,
    stdin: 'ignore',
    stdout: 'ignore',
    stderr: 'ignore',
  });

  const exitCode = await proc.exited;
  return makeResult(callId, 'shell_exec', {
    status: exitCode === 0 ? 'success' : 'error',
    error: exitCode !== 0 ? `Exit code ${exitCode}` : undefined,
  });
}

async function executeGenericFireAndForget(command: string, cwd: string, callId: string) {
  const proc = Bun.spawn(['sh', '-c', command], {
    cwd,
    stdin: 'ignore',
    stdout: 'ignore',
    stderr: 'ignore',
    detached: true,
  });

  const outcome = await Promise.race<
    { type: 'exit'; exitCode: number } | { type: 'launched' }
  >([
    proc.exited.then((exitCode) => ({ type: 'exit', exitCode } as const)),
    new Promise((resolve) =>
      setTimeout(() => resolve({ type: 'launched' } as const), FIRE_AND_FORGET_GRACE_MS),
    ),
  ]);

  if (outcome.type === 'launched') {
    proc.unref?.();
    return makeResult(callId, 'shell_exec', {
      status: 'success',
    });
  }

  return makeResult(callId, 'shell_exec', {
    status: outcome.exitCode === 0 ? 'success' : 'error',
    error: outcome.exitCode !== 0 ? `Exit code ${outcome.exitCode}` : undefined,
  });
}
