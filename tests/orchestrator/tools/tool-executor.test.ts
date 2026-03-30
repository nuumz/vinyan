import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { ToolExecutor, toolResultToEvidence } from "../../../src/orchestrator/tools/tool-executor.ts";
import { validateToolCall } from "../../../src/orchestrator/tools/tool-validator.ts";
import { BUILT_IN_TOOLS } from "../../../src/orchestrator/tools/built-in-tools.ts";
import type { ToolCall } from "../../../src/orchestrator/types.ts";
import type { ToolContext } from "../../../src/orchestrator/tools/tool-interface.ts";

let tempDir: string;
let executor: ToolExecutor;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "vinyan-tools-test-"));
  mkdirSync(join(tempDir, "src"), { recursive: true });
  writeFileSync(join(tempDir, "src", "foo.ts"), "export const x = 1;\n");
  executor = new ToolExecutor();
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

function makeContext(overrides?: Partial<ToolContext>): ToolContext {
  return {
    routingLevel: 1,
    allowedPaths: ["src/"],
    workspace: tempDir,
    ...overrides,
  };
}

function makeCall(tool: string, params: Record<string, unknown>): ToolCall {
  return { id: `tc-${Math.random().toString(36).slice(2, 6)}`, tool, parameters: params };
}

// §18.5 Acceptance Criteria

describe("Tool Execution — §18.5 Acceptance Criteria", () => {
  test("1. file_read works at L0", async () => {
    const ctx = makeContext({ routingLevel: 0 });
    const results = await executor.executeProposedTools(
      [makeCall("file_read", { file_path: "src/foo.ts" })],
      ctx,
    );
    expect(results).toHaveLength(1);
    expect(results[0]!.status).toBe("success");
    expect(results[0]!.output).toContain("export const x");
  });

  test("2. file_write blocked at L0", async () => {
    const ctx = makeContext({ routingLevel: 0 });
    const results = await executor.executeProposedTools(
      [makeCall("file_write", { file_path: "src/bar.ts", content: "new file" })],
      ctx,
    );
    expect(results).toHaveLength(1);
    expect(results[0]!.status).toBe("denied");
    expect(results[0]!.error).toContain("isolation level");
  });

  test("3. file_write works at L1 within allowedPaths", async () => {
    const ctx = makeContext({ routingLevel: 1 });
    const results = await executor.executeProposedTools(
      [makeCall("file_write", { file_path: "src/bar.ts", content: "const y = 2;\n" })],
      ctx,
    );
    expect(results).toHaveLength(1);
    expect(results[0]!.status).toBe("success");
    const written = readFileSync(join(tempDir, "src", "bar.ts"), "utf-8");
    expect(written).toBe("const y = 2;\n");
  });

  test("4. file_write blocked outside allowedPaths", async () => {
    const ctx = makeContext({ routingLevel: 1, allowedPaths: ["src/"] });
    const results = await executor.executeProposedTools(
      [makeCall("file_write", { file_path: "/etc/passwd", content: "hack" })],
      ctx,
    );
    expect(results).toHaveLength(1);
    expect(results[0]!.status).toBe("denied");
    expect(results[0]!.error).toContain("Absolute path");
  });

  test("C1. absolute path rejected even with allowedPaths", async () => {
    const ctx = makeContext({ routingLevel: 1, allowedPaths: ["src/"] });
    const results = await executor.executeProposedTools(
      [makeCall("file_read", { file_path: "/etc/shadow", content: "" })],
      ctx,
    );
    expect(results).toHaveLength(1);
    expect(results[0]!.status).toBe("denied");
    expect(results[0]!.error).toContain("Absolute path");
  });

  test("C1b. write denied when allowedPaths is empty", async () => {
    const ctx = makeContext({ routingLevel: 1, allowedPaths: [] });
    const results = await executor.executeProposedTools(
      [makeCall("file_write", { file_path: "src/bar.ts", content: "x" })],
      ctx,
    );
    expect(results).toHaveLength(1);
    expect(results[0]!.status).toBe("denied");
    expect(results[0]!.error).toContain("no allowed paths");
  });

  test("5. shell_exec allowlist enforced (allowed command)", async () => {
    const ctx = makeContext({ routingLevel: 1 });
    const call = makeCall("shell_exec", { command: "git status" });
    const tool = BUILT_IN_TOOLS.get("shell_exec")!;
    const validation = validateToolCall(call, tool, ctx);
    expect(validation.valid).toBe(true);
  });

  test("5b. shell_exec allowlist enforced (blocked command)", async () => {
    const ctx = makeContext({ routingLevel: 1 });
    const call = makeCall("shell_exec", { command: "rm -rf /" });
    const tool = BUILT_IN_TOOLS.get("shell_exec")!;
    const validation = validateToolCall(call, tool, ctx);
    expect(validation.valid).toBe(false);
    expect(validation.reason).toContain("not in allowlist");
  });

  test("C2. shell command with semicolon injection rejected", () => {
    const ctx = makeContext({ routingLevel: 1 });
    const call = makeCall("shell_exec", { command: "git status; rm -rf /" });
    const tool = BUILT_IN_TOOLS.get("shell_exec")!;
    const validation = validateToolCall(call, tool, ctx);
    expect(validation.valid).toBe(false);
    expect(validation.reason).toContain("dangerous metacharacter");
  });

  test("C2b. shell command with pipe injection rejected", () => {
    const ctx = makeContext({ routingLevel: 1 });
    const call = makeCall("shell_exec", { command: "git log | cat /etc/passwd" });
    const tool = BUILT_IN_TOOLS.get("shell_exec")!;
    const validation = validateToolCall(call, tool, ctx);
    expect(validation.valid).toBe(false);
    expect(validation.reason).toContain("dangerous metacharacter");
  });

  test("6. bypass pattern detected → blocked", async () => {
    const ctx = makeContext({ routingLevel: 1 });
    const results = await executor.executeProposedTools(
      [makeCall("file_write", { file_path: "src/x.ts", content: "skip oracle verification" })],
      ctx,
    );
    expect(results).toHaveLength(1);
    expect(results[0]!.status).toBe("denied");
  });

  test("7. tool results have content hash (A4)", async () => {
    const ctx = makeContext({ routingLevel: 1 });
    const results = await executor.executeProposedTools(
      [makeCall("file_write", { file_path: "src/new.ts", content: "const z = 3;\n" })],
      ctx,
    );
    expect(results[0]!.evidence).toBeDefined();
    expect(results[0]!.evidence!.contentHash).toBeDefined();
    expect(results[0]!.evidence!.contentHash!.length).toBe(64); // SHA-256 hex
  });

  test("8. all tool results wrapped as ECP evidence", () => {
    const call = makeCall("file_write", { file_path: "src/x.ts" });
    const result = {
      callId: call.id,
      tool: "file_write",
      status: "success" as const,
      output: "wrote 10 bytes",
      evidence: { file: "src/x.ts", line: 0, snippet: "const x", contentHash: "abc123" },
      duration_ms: 5,
    };
    const evidence = toolResultToEvidence(result, call);
    expect(evidence.file).toBe("src/x.ts");
    expect(evidence.contentHash).toBe("abc123");
  });
});

describe("Tool Executor — additional", () => {
  test("unknown tool returns denied", async () => {
    const ctx = makeContext();
    const results = await executor.executeProposedTools(
      [makeCall("nonexistent_tool", {})],
      ctx,
    );
    expect(results).toHaveLength(1);
    expect(results[0]!.status).toBe("denied");
    expect(results[0]!.error).toContain("Unknown tool");
  });

  test("getToolNames returns all 8 built-in tools", () => {
    expect(executor.getToolNames()).toHaveLength(8);
    expect(executor.getToolNames()).toContain("file_read");
    expect(executor.getToolNames()).toContain("shell_exec");
  });
});
