import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { WorkerPoolImpl, createUnifiedDiff } from "../../../src/orchestrator/worker/worker-pool.ts";
import { LLMProviderRegistry } from "../../../src/orchestrator/llm/provider-registry.ts";
import { createMockProvider } from "../../../src/orchestrator/llm/mock-provider.ts";
import type { TaskInput, PerceptualHierarchy, WorkingMemoryState, RoutingDecision } from "../../../src/orchestrator/types.ts";

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "vinyan-worker-test-"));
  mkdirSync(join(tempDir, "src"), { recursive: true });
  writeFileSync(join(tempDir, "src", "foo.ts"), "export const x = 1;\n");
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

function makeInput(overrides?: Partial<TaskInput>): TaskInput {
  return {
    id: "t-1",
    source: "cli",
    goal: "Fix bug",
    targetFiles: ["src/foo.ts"],
    budget: { maxTokens: 50_000, maxDurationMs: 60_000, maxRetries: 3 },
    ...overrides,
  };
}

function makePerception(): PerceptualHierarchy {
  return {
    taskTarget: { file: "src/foo.ts", description: "Fix bug" },
    dependencyCone: { directImporters: [], directImportees: [], transitiveBlastRadius: 0 },
    diagnostics: { lintWarnings: [], typeErrors: [], failingTests: [] },
    verifiedFacts: [],
    runtime: { nodeVersion: "v18", os: "darwin", availableTools: ["file_read"] },
  };
}

function makeMemory(): WorkingMemoryState {
  return { failedApproaches: [], activeHypotheses: [], unresolvedUncertainties: [], scopedFacts: [] };
}

function makeRouting(level: 0 | 1 | 2 | 3): RoutingDecision {
  return {
    level,
    model: level === 0 ? null : "mock-model",
    budgetTokens: level === 0 ? 0 : 10_000,
    latencyBudget_ms: 5_000,
  };
}

function makeRegistry(options?: { shouldFail?: boolean; latencyMs?: number; responseContent?: string }) {
  const registry = new LLMProviderRegistry();
  registry.register(createMockProvider({
    id: "mock/fast", tier: "fast",
    ...options,
  }));
  registry.register(createMockProvider({
    id: "mock/balanced", tier: "balanced",
    ...options,
  }));
  registry.register(createMockProvider({
    id: "mock/powerful", tier: "powerful",
    ...options,
  }));
  return registry;
}

describe("WorkerPoolImpl", () => {
  test("L0 dispatch returns empty result — no LLM call", async () => {
    const pool = new WorkerPoolImpl({ registry: makeRegistry(), workspace: tempDir, useSubprocess: false });
    const result = await pool.dispatch(makeInput(), makePerception(), makeMemory(), undefined, makeRouting(0));
    expect(result.mutations).toHaveLength(0);
    expect(result.tokensConsumed).toBe(0);
    expect(result.duration_ms).toBeGreaterThanOrEqual(0);
  });

  test("L1 dispatch with mock provider returns structured result", async () => {
    const content = JSON.stringify({
      proposedMutations: [{ file: "src/foo.ts", content: "export const x = 2;\n", explanation: "fix value" }],
      proposedToolCalls: [],
      uncertainties: [],
    });
    const pool = new WorkerPoolImpl({
      registry: makeRegistry({ responseContent: content }),
      workspace: tempDir,
      useSubprocess: false,
    });
    const result = await pool.dispatch(makeInput(), makePerception(), makeMemory(), undefined, makeRouting(1));
    expect(result.mutations).toHaveLength(1);
    expect(result.mutations[0]!.file).toBe("src/foo.ts");
    expect(result.mutations[0]!.content).toBe("export const x = 2;\n");
    expect(result.mutations[0]!.explanation).toBe("fix value");
    expect(result.tokensConsumed).toBe(150); // 100 input + 50 output from mock
  });

  test("L1 dispatch computes diff for existing file", async () => {
    const content = JSON.stringify({
      proposedMutations: [{ file: "src/foo.ts", content: "export const x = 2;\n", explanation: "change value" }],
      proposedToolCalls: [],
      uncertainties: [],
    });
    const pool = new WorkerPoolImpl({
      registry: makeRegistry({ responseContent: content }),
      workspace: tempDir,
      useSubprocess: false,
    });
    const result = await pool.dispatch(makeInput(), makePerception(), makeMemory(), undefined, makeRouting(1));
    expect(result.mutations[0]!.diff).toContain("--- a/src/foo.ts");
    expect(result.mutations[0]!.diff).toContain("+++ b/src/foo.ts");
    expect(result.mutations[0]!.diff).toContain("-export const x = 1;");
    expect(result.mutations[0]!.diff).toContain("+export const x = 2;");
  });

  test("L1 dispatch computes diff for new file", async () => {
    const content = JSON.stringify({
      proposedMutations: [{ file: "src/new.ts", content: "export const y = 1;\n", explanation: "new file" }],
      proposedToolCalls: [],
      uncertainties: [],
    });
    const pool = new WorkerPoolImpl({
      registry: makeRegistry({ responseContent: content }),
      workspace: tempDir,
      useSubprocess: false,
    });
    const result = await pool.dispatch(makeInput(), makePerception(), makeMemory(), undefined, makeRouting(1));
    expect(result.mutations[0]!.diff).toContain("@@ -0,0 +1,");
    expect(result.mutations[0]!.diff).toContain("+export const y = 1;");
  });

  test("timeout returns empty result", async () => {
    const pool = new WorkerPoolImpl({
      registry: makeRegistry({ latencyMs: 5000 }),
      workspace: tempDir,
      useSubprocess: false,
    });
    const routing = makeRouting(1);
    routing.latencyBudget_ms = 50; // Very short timeout
    const result = await pool.dispatch(makeInput(), makePerception(), makeMemory(), undefined, routing);
    expect(result.mutations).toHaveLength(0);
  });

  test("provider failure returns empty result gracefully", async () => {
    const pool = new WorkerPoolImpl({
      registry: makeRegistry({ shouldFail: true }),
      workspace: tempDir,
      useSubprocess: false,
    });
    const result = await pool.dispatch(makeInput(), makePerception(), makeMemory(), undefined, makeRouting(1));
    expect(result.mutations).toHaveLength(0);
    expect(result.tokensConsumed).toBe(0);
  });

  test("non-JSON LLM response returns empty mutations", async () => {
    const pool = new WorkerPoolImpl({
      registry: makeRegistry({ responseContent: "I cannot help with that." }),
      workspace: tempDir,
      useSubprocess: false,
    });
    const result = await pool.dispatch(makeInput(), makePerception(), makeMemory(), undefined, makeRouting(1));
    expect(result.mutations).toHaveLength(0);
    expect(result.tokensConsumed).toBe(150); // tokens still counted
  });

  test("no provider for routing level returns empty result", async () => {
    const registry = new LLMProviderRegistry(); // empty registry
    const pool = new WorkerPoolImpl({ registry, workspace: tempDir, useSubprocess: false });
    const result = await pool.dispatch(makeInput(), makePerception(), makeMemory(), undefined, makeRouting(1));
    expect(result.mutations).toHaveLength(0);
    expect(result.tokensConsumed).toBe(0);
  });
});

describe("createUnifiedDiff", () => {
  test("identical content returns empty string", () => {
    expect(createUnifiedDiff("f.ts", "hello", "hello")).toBe("");
  });

  test("new file diff has +0,0 header", () => {
    const diff = createUnifiedDiff("f.ts", "", "line1\nline2\n");
    expect(diff).toContain("@@ -0,0 +1,");
    expect(diff).toContain("+line1");
  });

  test("delete file diff has -1,N header", () => {
    const diff = createUnifiedDiff("f.ts", "line1\n", "");
    expect(diff).toContain("@@ -1,");
    expect(diff).toContain("-line1");
  });
});
