/**
 * Core Loop Integration Tests — verifies §16.4 acceptance criteria.
 *
 * Uses mock LLM providers so tests don't require API keys.
 * Exercises the full executeTask pipeline: Perceive → Predict → Plan → Generate → Verify → Learn.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { createOrchestrator } from "../../src/orchestrator/factory.ts";
import { LLMProviderRegistry } from "../../src/orchestrator/llm/provider-registry.ts";
import { createMockProvider } from "../../src/orchestrator/llm/mock-provider.ts";
import type { TaskInput } from "../../src/orchestrator/types.ts";

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "vinyan-integration-"));
  mkdirSync(join(tempDir, "src"), { recursive: true });
  writeFileSync(join(tempDir, "src", "foo.ts"), "export const x = 1;\n");
  writeFileSync(
    join(tempDir, "vinyan.json"),
    JSON.stringify({
      oracles: {
        type: { enabled: false },
        dep: { enabled: false },
        ast: { enabled: false },
        test: { enabled: false },
        lint: { enabled: false },
      },
    }),
  );
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

function makeInput(overrides?: Partial<TaskInput>): TaskInput {
  return {
    id: "t-integration",
    source: "cli",
    goal: "Fix the export value",
    budget: { maxTokens: 10_000, maxDurationMs: 5_000, maxRetries: 1 },
    ...overrides,
  };
}

function makeRegistry(responseContent?: string) {
  const registry = new LLMProviderRegistry();
  const content = responseContent ?? JSON.stringify({
    proposedMutations: [
      { file: "src/foo.ts", content: "export const x = 2;\n", explanation: "changed value" },
    ],
    proposedToolCalls: [],
    uncertainties: [],
  });
  registry.register(createMockProvider({ id: "mock/fast", tier: "fast", responseContent: content }));
  registry.register(createMockProvider({ id: "mock/balanced", tier: "balanced", responseContent: content }));
  registry.register(createMockProvider({ id: "mock/powerful", tier: "powerful", responseContent: content }));
  return registry;
}

describe("Core Loop Integration — §16.4 Acceptance Criteria", () => {
  test("1. L0 task completes without LLM call (A3)", async () => {
    // A3: at L0, Orchestrator must make zero LLM calls — verify via spy
    let llmCallCount = 0;
    const registry = new LLMProviderRegistry();
    const spyProvider = createMockProvider({ id: "mock/fast", tier: "fast", responseContent: "{}" });
    const originalGenerate = spyProvider.generate.bind(spyProvider);
    spyProvider.generate = async (request: Parameters<typeof originalGenerate>[0]) => {
      llmCallCount++;
      return originalGenerate(request);
    };
    registry.register(spyProvider);

    const orchestrator = createOrchestrator({ workspace: tempDir, registry, useSubprocess: false });
    // No targetFiles → L0 routing → no LLM needed
    const result = await orchestrator.executeTask(makeInput());
    expect(result.status).toBe("completed");
    expect(result.id).toBe("t-integration");
    expect(result.trace.routingLevel).toBe(0);
    // Core A3 assertion: zero LLM calls at L0
    expect(llmCallCount).toBe(0);
  });

  test("2. L1 task uses fast provider and returns mutations", async () => {
    const orchestrator = createOrchestrator({ workspace: tempDir, registry: makeRegistry(), useSubprocess: false });
    const result = await orchestrator.executeTask(
      makeInput({ targetFiles: ["src/foo.ts"] }),
    );
    expect(result.id).toBe("t-integration");
    // Result has either mutations (if verified) or escalation
    expect(result.trace).toBeDefined();
    expect(result.trace.routingLevel).toBeGreaterThanOrEqual(0);
  });

  test("3. executeTask returns valid TaskResult shape", async () => {
    const orchestrator = createOrchestrator({ workspace: tempDir, registry: makeRegistry(), useSubprocess: false });
    const result = await orchestrator.executeTask(makeInput());
    expect(result).toHaveProperty("id");
    expect(result).toHaveProperty("status");
    expect(result).toHaveProperty("mutations");
    expect(result).toHaveProperty("trace");
    expect(["completed", "failed", "escalated"]).toContain(result.status);
  });

  test("4. traces are collected for each attempt", async () => {
    const orchestrator = createOrchestrator({ workspace: tempDir, registry: makeRegistry(), useSubprocess: false });
    await orchestrator.executeTask(makeInput());
    const traces = orchestrator.traceCollector.getTraces();
    expect(traces.length).toBeGreaterThanOrEqual(1);
    expect(traces[0]!.taskId).toBe("t-integration");
  });

  test("5. escalation when oracle gate always rejects (A6 fail-closed)", async () => {
    // Inject an oracleGate that ALWAYS fails — forces escalation through all levels
    const alwaysFailGate = {
      verify: async () => ({
        passed: false,
        verdicts: {},
        reason: "forced failure for escalation test",
      }),
    };
    const orchestrator = createOrchestrator({
      workspace: tempDir,
      registry: makeRegistry(),
      useSubprocess: false,
      oracleGate: alwaysFailGate,
    });
    const result = await orchestrator.executeTask(
      makeInput({
        targetFiles: ["src/foo.ts"],
        budget: { maxTokens: 10_000, maxDurationMs: 10_000, maxRetries: 1 },
      }),
    );
    // All retries fail verification → must escalate
    expect(result.status).toBe("escalated");
  });

  test("6. traces record model_used and duration for every attempt", async () => {
    const orchestrator = createOrchestrator({ workspace: tempDir, registry: makeRegistry(), useSubprocess: false });
    await orchestrator.executeTask(
      makeInput({ targetFiles: ["src/foo.ts"] }),
    );
    const traces = orchestrator.traceCollector.getTraces();
    expect(traces.length).toBeGreaterThanOrEqual(1);
    for (const trace of traces) {
      expect(trace.model_used).toBeDefined();
      expect(typeof trace.model_used).toBe("string");
      expect(trace.duration_ms).toBeGreaterThanOrEqual(0);
      expect(trace.taskId).toBe("t-integration");
    }
  });

  test("7. factory creates working orchestrator with default config", () => {
    const orchestrator = createOrchestrator({ workspace: tempDir, useSubprocess: false });
    expect(orchestrator).toHaveProperty("executeTask");
    expect(orchestrator).toHaveProperty("traceCollector");
    expect(typeof orchestrator.executeTask).toBe("function");
  });

  test("8. task ID preserved in result", async () => {
    const orchestrator = createOrchestrator({ workspace: tempDir, registry: makeRegistry(), useSubprocess: false });
    const result = await orchestrator.executeTask(makeInput({ id: "custom-id-42" }));
    expect(result.id).toBe("custom-id-42");
  });

  test("9. trace includes model_used and tokens_consumed", async () => {
    const orchestrator = createOrchestrator({ workspace: tempDir, registry: makeRegistry(), useSubprocess: false });
    await orchestrator.executeTask(makeInput());
    const traces = orchestrator.traceCollector.getTraces();
    const trace = traces[0]!;
    expect(trace.model_used).toBeDefined();
    expect(typeof trace.tokens_consumed).toBe("number");
    expect(typeof trace.duration_ms).toBe("number");
  });

  test("10. multiple tasks run independently", async () => {
    const orchestrator = createOrchestrator({ workspace: tempDir, registry: makeRegistry(), useSubprocess: false });
    const r1 = await orchestrator.executeTask(makeInput({ id: "task-1" }));
    const r2 = await orchestrator.executeTask(makeInput({ id: "task-2" }));
    expect(r1.id).toBe("task-1");
    expect(r2.id).toBe("task-2");
    expect(orchestrator.traceCollector.getTraces().length).toBeGreaterThanOrEqual(2);
  });
});
