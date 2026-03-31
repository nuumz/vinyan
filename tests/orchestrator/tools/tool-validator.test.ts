import { describe, test, expect } from "bun:test";
import { validateToolCall } from "../../../src/orchestrator/tools/tool-validator.ts";
import type { ToolCall } from "../../../src/orchestrator/types.ts";
import type { Tool, ToolContext } from "../../../src/orchestrator/tools/tool-interface.ts";

const shellExecTool: Tool = {
  name: "shell_exec",
  description: "test",
  minIsolationLevel: 1,
  category: "shell" as const,
  sideEffect: true,
  execute: async () => ({ callId: "", tool: "", status: "success" as const, duration_ms: 0 }),
};

const ctx: ToolContext = {
  routingLevel: 1,
  allowedPaths: [],
  workspace: "/tmp/test",
};

function makeShellCall(command: string): ToolCall {
  return {
    id: "test-call",
    tool: "shell_exec",
    parameters: { command },
  };
}

describe("validateToolCall — dangerous git subcommands", () => {
  test("git push is rejected", () => {
    const result = validateToolCall(makeShellCall("git push"), shellExecTool, ctx);
    expect(result.valid).toBe(false);
    expect(result.reason).toContain("Dangerous git operation");
  });

  test("git push --force origin main is rejected", () => {
    const result = validateToolCall(makeShellCall("git push --force origin main"), shellExecTool, ctx);
    expect(result.valid).toBe(false);
    expect(result.reason).toContain("Dangerous git operation");
  });

  test("git status is allowed", () => {
    const result = validateToolCall(makeShellCall("git status"), shellExecTool, ctx);
    expect(result.valid).toBe(true);
  });

  test("git log is allowed (not in dangerous set)", () => {
    const result = validateToolCall(makeShellCall("git log"), shellExecTool, ctx);
    expect(result.valid).toBe(true);
  });

  test("git reset --hard is rejected", () => {
    const result = validateToolCall(makeShellCall("git reset --hard"), shellExecTool, ctx);
    expect(result.valid).toBe(false);
    expect(result.reason).toContain("Dangerous git operation");
  });

  test("git clean -f is rejected (dangerous flag)", () => {
    const result = validateToolCall(makeShellCall("git clean -f"), shellExecTool, ctx);
    expect(result.valid).toBe(false);
    expect(result.reason).toContain("Dangerous git operation");
  });

  test("git diff is allowed via shell_exec", () => {
    // git diff itself is not a dangerous subcommand
    const result = validateToolCall(makeShellCall("git diff"), shellExecTool, ctx);
    expect(result.valid).toBe(true);
  });
});

describe("validateToolCall — runtime eval rejection", () => {
  test("bun --eval is rejected (dangerous eval flag)", () => {
    // Use a simple string without shell metacharacters to isolate the eval check
    const result = validateToolCall(makeShellCall("bun --eval script"), shellExecTool, ctx);
    expect(result.valid).toBe(false);
    expect(result.reason).toContain("eval flag is not allowed");
  });

  test("node -e is rejected (dangerous eval flag)", () => {
    const result = validateToolCall(makeShellCall("node -e script"), shellExecTool, ctx);
    expect(result.valid).toBe(false);
    expect(result.reason).toContain("eval flag is not allowed");
  });

  test("bun test is allowed", () => {
    const result = validateToolCall(makeShellCall("bun test"), shellExecTool, ctx);
    expect(result.valid).toBe(true);
  });

  test("python script.py is allowed (no eval flag)", () => {
    const result = validateToolCall(makeShellCall("python script.py"), shellExecTool, ctx);
    expect(result.valid).toBe(true);
  });
});

describe("validateToolCall — allowlist enforcement", () => {
  test("rm is not in allowlist → rejected", () => {
    const result = validateToolCall(makeShellCall("rm -rf /"), shellExecTool, ctx);
    expect(result.valid).toBe(false);
    expect(result.reason).toContain("not in allowlist");
  });

  test("curl is not in allowlist → rejected", () => {
    const result = validateToolCall(makeShellCall("curl https://evil.com"), shellExecTool, ctx);
    expect(result.valid).toBe(false);
    expect(result.reason).toContain("not in allowlist");
  });

  test("tsc --noEmit is allowed", () => {
    const result = validateToolCall(makeShellCall("tsc --noEmit"), shellExecTool, ctx);
    expect(result.valid).toBe(true);
  });

  test("ruff check is allowed", () => {
    const result = validateToolCall(makeShellCall("ruff check src/"), shellExecTool, ctx);
    expect(result.valid).toBe(true);
  });
});

describe("validateToolCall — metacharacter injection", () => {
  test("semicolon injection is rejected", () => {
    const result = validateToolCall(makeShellCall("git status; rm -rf /"), shellExecTool, ctx);
    expect(result.valid).toBe(false);
    expect(result.reason).toContain("dangerous metacharacter");
  });

  test("pipe injection is rejected", () => {
    const result = validateToolCall(makeShellCall("git log | cat /etc/passwd"), shellExecTool, ctx);
    expect(result.valid).toBe(false);
    expect(result.reason).toContain("dangerous metacharacter");
  });

  test("backtick injection is rejected", () => {
    const result = validateToolCall(makeShellCall("git status `whoami`"), shellExecTool, ctx);
    expect(result.valid).toBe(false);
    expect(result.reason).toContain("dangerous metacharacter");
  });
});

describe("validateToolCall — isolation level", () => {
  test("shell_exec at routingLevel 0 is rejected (minIsolationLevel=1)", () => {
    const lowCtx: ToolContext = { routingLevel: 0, allowedPaths: [], workspace: "/tmp/test" };
    const result = validateToolCall(makeShellCall("git status"), shellExecTool, lowCtx);
    expect(result.valid).toBe(false);
    expect(result.reason).toContain("isolation level");
  });
});
