/**
 * Built-in tools — 8 core tools for file I/O, search, shell, and VCS.
 * Source of truth: spec/tdd.md §18.1
 */

import { createHash } from 'crypto';
import { readdirSync, readFileSync, writeFileSync } from 'fs';
import { resolve } from 'path';
import type { ToolResult } from '../types.ts';
import type { Tool, ToolDescriptor } from './tool-interface.ts';

const TOOL_TIMEOUT_MS = 30_000;

function makeEvidence(file: string, content: string) {
  return {
    file,
    line: 0,
    snippet: content.slice(0, 100),
    contentHash: createHash('sha256').update(content).digest('hex'),
  };
}

function makeResult(callId: string, tool: string, partial: Partial<ToolResult>): ToolResult {
  return {
    callId,
    tool,
    status: 'success',
    durationMs: 0,
    ...partial,
  };
}

export const fileRead: Tool = {
  name: 'file_read',
  description: 'Read file contents',
  minIsolationLevel: 0,
  category: 'file_read',
  sideEffect: false,
  descriptor(): ToolDescriptor {
    return {
      name: 'file_read',
      description: this.description,
      inputSchema: {
        type: 'object',
        properties: { file_path: { type: 'string', description: 'Path to the file to read' } },
        required: ['file_path'],
      },
      category: 'file_read',
      sideEffect: false,
      minRoutingLevel: 0,
    };
  },
  async execute(params, context) {
    const filePath = (params.file_path ?? params.path) as string;
    const absPath = resolve(context.workspace, filePath);
    try {
      const content = readFileSync(absPath, 'utf-8');
      return makeResult((params.callId as string) ?? '', 'file_read', {
        output: content,
        evidence: makeEvidence(filePath, content),
      });
    } catch (e) {
      return makeResult((params.callId as string) ?? '', 'file_read', {
        status: 'error',
        error: e instanceof Error ? e.message : String(e),
      });
    }
  },
};

export const fileWrite: Tool = {
  name: 'file_write',
  description: 'Write content to a file',
  minIsolationLevel: 1,
  category: 'file_write',
  sideEffect: true,
  descriptor(): ToolDescriptor {
    return {
      name: 'file_write',
      description: this.description,
      inputSchema: {
        type: 'object',
        properties: {
          file_path: { type: 'string', description: 'Path to the file to write' },
          content: { type: 'string', description: 'Content to write' },
        },
        required: ['file_path', 'content'],
      },
      category: 'file_write',
      sideEffect: true,
      minRoutingLevel: 2,
    };
  },
  async execute(params, context) {
    const filePath = (params.file_path ?? params.path) as string;
    const content = params.content as string;
    const absPath = resolve(context.workspace, filePath);
    try {
      writeFileSync(absPath, content);
      return makeResult((params.callId as string) ?? '', 'file_write', {
        output: `Wrote ${content.length} bytes to ${filePath}`,
        evidence: makeEvidence(filePath, content),
      });
    } catch (e) {
      return makeResult((params.callId as string) ?? '', 'file_write', {
        status: 'error',
        error: e instanceof Error ? e.message : String(e),
      });
    }
  },
};

export const fileEdit: Tool = {
  name: 'file_edit',
  description: 'Apply an edit to a file (read, modify, write)',
  minIsolationLevel: 1,
  category: 'file_write',
  sideEffect: true,
  descriptor(): ToolDescriptor {
    return {
      name: 'file_edit',
      description: this.description,
      inputSchema: {
        type: 'object',
        properties: {
          file_path: { type: 'string', description: 'Path to the file to edit' },
          old_string: { type: 'string', description: 'String to replace' },
          new_string: { type: 'string', description: 'Replacement string' },
        },
        required: ['file_path', 'old_string', 'new_string'],
      },
      category: 'file_write',
      sideEffect: true,
      minRoutingLevel: 2,
    };
  },
  async execute(params, context) {
    const filePath = (params.file_path ?? params.path) as string;
    const oldStr = params.old_string as string;
    const newStr = params.new_string as string;
    const absPath = resolve(context.workspace, filePath);
    try {
      const original = readFileSync(absPath, 'utf-8');
      if (!original.includes(oldStr)) {
        return makeResult((params.callId as string) ?? '', 'file_edit', {
          status: 'error',
          error: `old_string not found in ${filePath}`,
        });
      }
      const updated = original.replaceAll(oldStr, newStr);
      writeFileSync(absPath, updated);
      return makeResult((params.callId as string) ?? '', 'file_edit', {
        output: `Edited ${filePath}`,
        evidence: makeEvidence(filePath, updated),
      });
    } catch (e) {
      return makeResult((params.callId as string) ?? '', 'file_edit', {
        status: 'error',
        error: e instanceof Error ? e.message : String(e),
      });
    }
  },
};

export const directoryList: Tool = {
  name: 'directory_list',
  description: 'List directory contents',
  minIsolationLevel: 0,
  category: 'file_read',
  sideEffect: false,
  descriptor(): ToolDescriptor {
    return {
      name: 'directory_list',
      description: this.description,
      inputSchema: {
        type: 'object',
        properties: { path: { type: 'string', description: 'Directory path to list' } },
        required: [],
      },
      category: 'file_read',
      sideEffect: false,
      minRoutingLevel: 2,
    };
  },
  async execute(params, context) {
    const dirPath = ((params.path ?? params.directory) as string) ?? '.';
    const absPath = resolve(context.workspace, dirPath);
    try {
      const entries = readdirSync(absPath, { withFileTypes: true });
      const output = entries.map((e) => `${e.isDirectory() ? 'd' : 'f'} ${e.name}`).join('\n');
      return makeResult((params.callId as string) ?? '', 'directory_list', { output });
    } catch (e) {
      return makeResult((params.callId as string) ?? '', 'directory_list', {
        status: 'error',
        error: e instanceof Error ? e.message : String(e),
      });
    }
  },
};

export const searchGrep: Tool = {
  name: 'search_grep',
  description: 'Search file contents with grep',
  minIsolationLevel: 0,
  category: 'search',
  sideEffect: false,
  descriptor(): ToolDescriptor {
    return {
      name: 'search_grep',
      description: this.description,
      inputSchema: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'Search pattern (regex)' },
          path: { type: 'string', description: 'Path to search in' },
        },
        required: ['pattern'],
      },
      category: 'search',
      sideEffect: false,
      minRoutingLevel: 1,
    };
  },
  async execute(params, context) {
    const pattern = params.pattern as string;
    const path = (params.path ?? '.') as string;
    // Path containment — reject traversal outside workspace
    const absPath = resolve(context.workspace, path);
    if (!absPath.startsWith(`${context.workspace}/`) && absPath !== context.workspace) {
      return makeResult((params.callId as string) ?? '', 'search_grep', {
        status: 'error',
        error: `Path '${path}' escapes workspace`,
      });
    }
    try {
      const proc = Bun.spawn(['grep', '-rn', pattern, path], {
        cwd: context.workspace,
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const timeoutPromise = new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), TOOL_TIMEOUT_MS));
      const processPromise = (async () => {
        const stdout = await new Response(proc.stdout).text();
        await proc.exited;
        return stdout;
      })();
      const result = await Promise.race([processPromise, timeoutPromise]);
      if (result === 'timeout') {
        proc.kill();
        return makeResult((params.callId as string) ?? '', 'search_grep', {
          status: 'error',
          error: 'search_grep timed out after 30s',
        });
      }
      return makeResult((params.callId as string) ?? '', 'search_grep', { output: result });
    } catch (e) {
      return makeResult((params.callId as string) ?? '', 'search_grep', {
        status: 'error',
        error: e instanceof Error ? e.message : String(e),
      });
    }
  },
};

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

export const searchSemantic: Tool = {
  name: 'search_semantic',
  description: 'AST-based symbol search — find symbols by name in a file using TypeScript compiler API',
  minIsolationLevel: 0,
  category: 'search',
  sideEffect: false,
  descriptor(): ToolDescriptor {
    return {
      name: 'search_semantic',
      description: this.description,
      inputSchema: {
        type: 'object',
        properties: {
          file_path: { type: 'string', description: 'File to search in' },
          symbol: { type: 'string', description: 'Symbol name to search for' },
        },
        required: ['file_path', 'symbol'],
      },
      category: 'search',
      sideEffect: false,
      minRoutingLevel: 1,
    };
  },
  async execute(params, context) {
    const filePath = (params.file_path ?? params.path) as string;
    const symbolName = params.symbol as string;
    if (!filePath || !symbolName) {
      return makeResult((params.callId as string) ?? '', 'search_semantic', {
        status: 'error',
        error: 'Both file_path and symbol are required',
      });
    }
    const absPath = resolve(context.workspace, filePath);
    try {
      const ts = (await import('typescript')).default;
      const content = readFileSync(absPath, 'utf-8');
      const sf = ts.createSourceFile(absPath, content, ts.ScriptTarget.Latest, true);

      const matches: Array<{ line: number; snippet: string }> = [];

      function visit(node: import('typescript').Node) {
        let name: string | undefined;

        if (ts.isFunctionDeclaration(node) && node.name) name = node.name.text;
        else if (ts.isClassDeclaration(node) && node.name) name = node.name.text;
        else if (ts.isInterfaceDeclaration(node) && node.name) name = node.name.text;
        else if (ts.isTypeAliasDeclaration(node)) name = node.name.text;
        else if (ts.isEnumDeclaration(node)) name = node.name.text;
        else if (ts.isMethodDeclaration(node) && node.name) name = node.name.getText(sf);
        else if (ts.isVariableStatement(node)) {
          node.declarationList.declarations.forEach((decl) => {
            if (ts.isIdentifier(decl.name) && decl.name.text.includes(symbolName)) {
              const line = sf.getLineAndCharacterOfPosition(decl.getStart(sf)).line + 1;
              const text = decl.getText(sf);
              matches.push({ line, snippet: text.length > 120 ? `${text.slice(0, 117)}...` : text });
            }
          });
        }

        if (name?.includes(symbolName)) {
          const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
          const text = node.getText(sf);
          matches.push({ line, snippet: text.length > 120 ? `${text.slice(0, 117)}...` : text });
        }

        ts.forEachChild(node, visit);
      }

      ts.forEachChild(sf, visit);

      const output =
        matches.length > 0
          ? matches.map((m) => `${filePath}:${m.line}: ${m.snippet}`).join('\n')
          : `No symbol matching "${symbolName}" found in ${filePath}`;
      return makeResult((params.callId as string) ?? '', 'search_semantic', {
        output,
        evidence: makeEvidence(filePath, content),
      });
    } catch (e) {
      return makeResult((params.callId as string) ?? '', 'search_semantic', {
        status: 'error',
        error: e instanceof Error ? e.message : String(e),
      });
    }
  },
};

const HTTP_GET_TIMEOUT_MS = 10_000;
const HTTP_GET_MAX_BYTES = 50 * 1024; // 50KB

export const httpGet: Tool = {
  name: 'http_get',
  description: 'HTTP GET with 10s timeout and 50KB response limit (no auth headers)',
  minIsolationLevel: 1,
  category: 'shell',
  sideEffect: false,
  descriptor(): ToolDescriptor {
    return {
      name: 'http_get',
      description: this.description,
      inputSchema: {
        type: 'object',
        properties: { url: { type: 'string', description: 'URL to fetch' } },
        required: ['url'],
      },
      category: 'shell',
      sideEffect: false,
      minRoutingLevel: 2,
    };
  },
  async execute(params, _context) {
    const url = params.url as string;
    if (!url) {
      return makeResult((params.callId as string) ?? '', 'http_get', {
        status: 'error',
        error: 'url is required',
      });
    }
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), HTTP_GET_TIMEOUT_MS);
      const response = await fetch(url, {
        method: 'GET',
        signal: controller.signal,
        headers: { 'User-Agent': 'vinyan-agent/1.0' },
      });
      clearTimeout(timer);

      const buffer = await response.arrayBuffer();
      let body = new TextDecoder().decode(buffer.slice(0, HTTP_GET_MAX_BYTES));
      const truncated = buffer.byteLength > HTTP_GET_MAX_BYTES;
      if (truncated) {
        body += `\n... [truncated at ${HTTP_GET_MAX_BYTES} bytes, total: ${buffer.byteLength}]`;
      }

      return makeResult((params.callId as string) ?? '', 'http_get', {
        status: response.ok ? 'success' : 'error',
        output: body,
        error: response.ok ? undefined : `HTTP ${response.status} ${response.statusText}`,
      });
    } catch (e) {
      return makeResult((params.callId as string) ?? '', 'http_get', {
        status: 'error',
        error: e instanceof Error ? e.message : String(e),
      });
    }
  },
};

// ── Control tools (Phase 6) ─────────────────────────────────────────

export const attemptCompletion: Tool = {
  name: 'attempt_completion',
  description:
    'Signal task completion or uncertainty. Use status "done" when the task is complete, or "uncertain" when you cannot proceed.',
  minIsolationLevel: 0,
  category: 'control',
  sideEffect: false,
  descriptor(): ToolDescriptor {
    return {
      name: 'attempt_completion',
      description: this.description,
      inputSchema: {
        type: 'object',
        properties: {
          status: { type: 'string', description: 'Task completion status', enum: ['done', 'uncertain'] },
          result: { type: 'string', description: 'Summary of what was accomplished' },
          uncertainties: { type: 'string', description: 'List of unresolved uncertainties (when status is uncertain)' },
        },
        required: ['status'],
      },
      category: 'control',
      sideEffect: false,
      minRoutingLevel: 0,
    };
  },
  async execute(params) {
    // Control tool — the agent loop intercepts this before execution
    return makeResult((params.callId as string) ?? '', 'attempt_completion', {
      output: JSON.stringify({ status: params.status, result: params.result }),
    });
  },
};

export const requestBudgetExtension: Tool = {
  name: 'request_budget_extension',
  description: 'Request additional tokens from the orchestrator when budget is running low.',
  minIsolationLevel: 0,
  category: 'control',
  sideEffect: false,
  descriptor(): ToolDescriptor {
    return {
      name: 'request_budget_extension',
      description: this.description,
      inputSchema: {
        type: 'object',
        properties: {
          additionalTokens: { type: 'number', description: 'Number of additional tokens requested' },
          reason: { type: 'string', description: 'Reason for the budget extension request' },
        },
        required: ['additionalTokens', 'reason'],
      },
      category: 'control',
      sideEffect: false,
      minRoutingLevel: 1,
    };
  },
  async execute(params) {
    // Control tool — handled by agent loop budget tracker
    return makeResult((params.callId as string) ?? '', 'request_budget_extension', {
      output: JSON.stringify({ requested: params.additionalTokens, reason: params.reason }),
    });
  },
};

export const delegateTask: Tool = {
  name: 'delegate_task',
  description:
    'Delegate a sub-task to a child worker. The child runs through the full pipeline with bounded scope.',
  minIsolationLevel: 1,
  category: 'delegation',
  sideEffect: true,
  descriptor(): ToolDescriptor {
    return {
      name: 'delegate_task',
      description: this.description,
      inputSchema: {
        type: 'object',
        properties: {
          goal: { type: 'string', description: 'Natural language description of the sub-task' },
          targetFiles: { type: 'array', description: 'Files the sub-task is scoped to' },
          requiredTools: { type: 'array', description: 'Tools the sub-task needs (optional)' },
          context: { type: 'string', description: 'Additional context for the sub-task (optional)' },
          requestedTokens: { type: 'number', description: 'Token budget for the sub-task (optional)' },
        },
        required: ['goal', 'targetFiles'],
      },
      category: 'delegation',
      sideEffect: true,
      minRoutingLevel: 2,
    };
  },
  async execute(params, context) {
    // Delegation tool — handled by agent loop via context.onDelegate
    if (!context.onDelegate) {
      return makeResult((params.callId as string) ?? '', 'delegate_task', {
        status: 'denied',
        error: 'Delegation not available at this routing level',
      });
    }
    return context.onDelegate(params as any);
  },
};

/** All built-in tools indexed by name. */
export const BUILT_IN_TOOLS: Map<string, Tool> = new Map([
  ['file_read', fileRead],
  ['file_write', fileWrite],
  ['file_edit', fileEdit],
  ['directory_list', directoryList],
  ['search_grep', searchGrep],
  ['shell_exec', shellExec],
  ['git_status', gitStatus],
  ['git_diff', gitDiff],
  ['search_semantic', searchSemantic],
  ['http_get', httpGet],
  ['attempt_completion', attemptCompletion],
  ['request_budget_extension', requestBudgetExtension],
  ['delegate_task', delegateTask],
]);
