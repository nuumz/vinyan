/**
 * Built-in tools — 8 core tools for file I/O, search, shell, and VCS.
 * Source of truth: vinyan-tdd.md §18.1
 */
import { readFileSync, writeFileSync, readdirSync } from "fs";
import { createHash } from "crypto";
import { resolve, join } from "path";
import type { ToolResult } from "../types.ts";
import type { Tool, ToolContext } from "./tool-interface.ts";

const TOOL_TIMEOUT_MS = 30_000;

function makeEvidence(file: string, content: string) {
  return {
    file,
    line: 0,
    snippet: content.slice(0, 100),
    contentHash: createHash("sha256").update(content).digest("hex"),
  };
}

function makeResult(callId: string, tool: string, partial: Partial<ToolResult>): ToolResult {
  return {
    callId,
    tool,
    status: "success",
    duration_ms: 0,
    ...partial,
  };
}

export const fileRead: Tool = {
  name: "file_read",
  description: "Read file contents",
  minIsolationLevel: 0,
  category: "file_read",
  sideEffect: false,
  async execute(params, context) {
    const filePath = (params.file_path ?? params.path) as string;
    const absPath = resolve(context.workspace, filePath);
    try {
      const content = readFileSync(absPath, "utf-8");
      return makeResult(params._callId as string ?? "", "file_read", {
        output: content,
        evidence: makeEvidence(filePath, content),
      });
    } catch (e) {
      return makeResult(params._callId as string ?? "", "file_read", {
        status: "error",
        error: e instanceof Error ? e.message : String(e),
      });
    }
  },
};

export const fileWrite: Tool = {
  name: "file_write",
  description: "Write content to a file",
  minIsolationLevel: 1,
  category: "file_write",
  sideEffect: true,
  async execute(params, context) {
    const filePath = (params.file_path ?? params.path) as string;
    const content = params.content as string;
    const absPath = resolve(context.workspace, filePath);
    try {
      writeFileSync(absPath, content);
      return makeResult(params._callId as string ?? "", "file_write", {
        output: `Wrote ${content.length} bytes to ${filePath}`,
        evidence: makeEvidence(filePath, content),
      });
    } catch (e) {
      return makeResult(params._callId as string ?? "", "file_write", {
        status: "error",
        error: e instanceof Error ? e.message : String(e),
      });
    }
  },
};

export const fileEdit: Tool = {
  name: "file_edit",
  description: "Apply an edit to a file (read, modify, write)",
  minIsolationLevel: 1,
  category: "file_write",
  sideEffect: true,
  async execute(params, context) {
    const filePath = (params.file_path ?? params.path) as string;
    const oldStr = params.old_string as string;
    const newStr = params.new_string as string;
    const absPath = resolve(context.workspace, filePath);
    try {
      const original = readFileSync(absPath, "utf-8");
      if (!original.includes(oldStr)) {
        return makeResult(params._callId as string ?? "", "file_edit", {
          status: "error",
          error: `old_string not found in ${filePath}`,
        });
      }
      const updated = original.replaceAll(oldStr, newStr);
      writeFileSync(absPath, updated);
      return makeResult(params._callId as string ?? "", "file_edit", {
        output: `Edited ${filePath}`,
        evidence: makeEvidence(filePath, updated),
      });
    } catch (e) {
      return makeResult(params._callId as string ?? "", "file_edit", {
        status: "error",
        error: e instanceof Error ? e.message : String(e),
      });
    }
  },
};

export const directoryList: Tool = {
  name: "directory_list",
  description: "List directory contents",
  minIsolationLevel: 0,
  category: "file_read",
  sideEffect: false,
  async execute(params, context) {
    const dirPath = (params.path ?? params.directory) as string ?? ".";
    const absPath = resolve(context.workspace, dirPath);
    try {
      const entries = readdirSync(absPath, { withFileTypes: true });
      const output = entries.map(e => `${e.isDirectory() ? "d" : "f"} ${e.name}`).join("\n");
      return makeResult(params._callId as string ?? "", "directory_list", { output });
    } catch (e) {
      return makeResult(params._callId as string ?? "", "directory_list", {
        status: "error",
        error: e instanceof Error ? e.message : String(e),
      });
    }
  },
};

export const searchGrep: Tool = {
  name: "search_grep",
  description: "Search file contents with grep",
  minIsolationLevel: 0,
  category: "search",
  sideEffect: false,
  async execute(params, context) {
    const pattern = params.pattern as string;
    const path = (params.path ?? ".") as string;
    // Path containment — reject traversal outside workspace
    const absPath = resolve(context.workspace, path);
    if (!absPath.startsWith(context.workspace + "/") && absPath !== context.workspace) {
      return makeResult(params._callId as string ?? "", "search_grep", {
        status: "error",
        error: `Path '${path}' escapes workspace`,
      });
    }
    try {
      const proc = Bun.spawn(["grep", "-rn", pattern, path], {
        cwd: context.workspace,
        stdout: "pipe",
        stderr: "pipe",
      });
      const timeoutPromise = new Promise<"timeout">(r => setTimeout(() => r("timeout"), TOOL_TIMEOUT_MS));
      const processPromise = (async () => {
        const stdout = await new Response(proc.stdout).text();
        await proc.exited;
        return stdout;
      })();
      const result = await Promise.race([processPromise, timeoutPromise]);
      if (result === "timeout") {
        proc.kill();
        return makeResult(params._callId as string ?? "", "search_grep", {
          status: "error",
          error: "search_grep timed out after 30s",
        });
      }
      return makeResult(params._callId as string ?? "", "search_grep", { output: result });
    } catch (e) {
      return makeResult(params._callId as string ?? "", "search_grep", {
        status: "error",
        error: e instanceof Error ? e.message : String(e),
      });
    }
  },
};

export const shellExec: Tool = {
  name: "shell_exec",
  description: "Execute a shell command (allowlisted commands only)",
  minIsolationLevel: 1,
  category: "shell",
  sideEffect: true,
  async execute(params, context) {
    const command = params.command as string;
    // Validate cwd if provided — must stay within workspace
    const cwd = params.cwd as string | undefined;
    const effectiveCwd = cwd ? resolve(context.workspace, cwd) : context.workspace;
    if (!effectiveCwd.startsWith(context.workspace + "/") && effectiveCwd !== context.workspace) {
      return makeResult(params._callId as string ?? "", "shell_exec", {
        status: "error",
        error: `cwd '${cwd}' escapes workspace`,
      });
    }
    try {
      const proc = Bun.spawn(["sh", "-c", command], {
        cwd: effectiveCwd,
        stdout: "pipe",
        stderr: "pipe",
      });
      const timeoutPromise = new Promise<"timeout">(r => setTimeout(() => r("timeout"), TOOL_TIMEOUT_MS));
      const processPromise = (async () => {
        const stdout = await new Response(proc.stdout).text();
        const stderr = await new Response(proc.stderr).text();
        const exitCode = await proc.exited;
        return { stdout, stderr, exitCode };
      })();
      const result = await Promise.race([processPromise, timeoutPromise]);
      if (result === "timeout") {
        proc.kill();
        return makeResult(params._callId as string ?? "", "shell_exec", {
          status: "error",
          error: "shell_exec timed out after 30s",
        });
      }
      return makeResult(params._callId as string ?? "", "shell_exec", {
        status: result.exitCode === 0 ? "success" : "error",
        output: result.stdout,
        error: result.exitCode !== 0 ? `Exit code ${result.exitCode}: ${result.stderr}` : undefined,
      });
    } catch (e) {
      return makeResult(params._callId as string ?? "", "shell_exec", {
        status: "error",
        error: e instanceof Error ? e.message : String(e),
      });
    }
  },
};

export const gitStatus: Tool = {
  name: "git_status",
  description: "Show git working tree status",
  minIsolationLevel: 0,
  category: "vcs",
  sideEffect: false,
  async execute(params, context) {
    try {
      const proc = Bun.spawn(["git", "status", "--porcelain"], {
        cwd: context.workspace,
        stdout: "pipe",
        stderr: "pipe",
      });
      const stdout = await new Response(proc.stdout).text();
      await proc.exited;
      return makeResult(params._callId as string ?? "", "git_status", { output: stdout });
    } catch (e) {
      return makeResult(params._callId as string ?? "", "git_status", {
        status: "error",
        error: e instanceof Error ? e.message : String(e),
      });
    }
  },
};

export const gitDiff: Tool = {
  name: "git_diff",
  description: "Show git diff",
  minIsolationLevel: 0,
  category: "vcs",
  sideEffect: false,
  async execute(params, context) {
    const target = params.file_path as string | undefined;
    const args = ["git", "diff"];
    if (target) args.push(target);
    try {
      const proc = Bun.spawn(args, {
        cwd: context.workspace,
        stdout: "pipe",
        stderr: "pipe",
      });
      const stdout = await new Response(proc.stdout).text();
      await proc.exited;
      return makeResult(params._callId as string ?? "", "git_diff", { output: stdout });
    } catch (e) {
      return makeResult(params._callId as string ?? "", "git_diff", {
        status: "error",
        error: e instanceof Error ? e.message : String(e),
      });
    }
  },
};

/** All built-in tools indexed by name. */
export const BUILT_IN_TOOLS: Map<string, Tool> = new Map([
  ["file_read", fileRead],
  ["file_write", fileWrite],
  ["file_edit", fileEdit],
  ["directory_list", directoryList],
  ["search_grep", searchGrep],
  ["shell_exec", shellExec],
  ["git_status", gitStatus],
  ["git_diff", gitDiff],
]);
