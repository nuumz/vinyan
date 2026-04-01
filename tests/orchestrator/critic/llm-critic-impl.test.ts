import { describe, test, expect, beforeEach } from "bun:test";
import { LLMCriticImpl } from "../../../src/orchestrator/critic/llm-critic-impl.ts";
import type { LLMProvider, LLMRequest, TaskInput, PerceptualHierarchy } from "../../../src/orchestrator/types.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mockProvider(content: string, tokensUsed = { input: 100, output: 50 }): LLMProvider {
  return {
    id: "test-provider",
    tier: "fast",
    generate: async (_req: LLMRequest) => ({
      content,
      tokensUsed,
      toolCalls: [],
      model: "mock-model",
      stopReason: "end_turn" as const,
    }),
  };
}

function throwingProvider(error = "network error"): LLMProvider {
  return {
    id: "test-provider",
    tier: "fast",
    generate: async () => { throw new Error(error); },
  };
}

const minimalTask: TaskInput = {
  id: "test-task-1",
  source: "cli",
  goal: "Add a greeting function",
  targetFiles: ["src/hello.ts"],
  budget: { maxTokens: 10_000, maxDurationMs: 5_000, maxRetries: 1 },
};

const minimalPerception: PerceptualHierarchy = {
  taskTarget: { file: "src/hello.ts", symbol: undefined, description: "Add a greeting function" },
  dependencyCone: { directImporters: [], directImportees: [], transitiveBlastRadius: 0 },
  diagnostics: { lintWarnings: [], typeErrors: [], failingTests: [] },
  verifiedFacts: [],
  runtime: { nodeVersion: "v20", os: "darwin", availableTools: [] },
};

const minimalProposal = {
  mutations: [{ file: "src/hello.ts", content: "export function greet() { return 'hi'; }", explanation: "added greeting" }],
  approach: "simple function",
};

// ---------------------------------------------------------------------------
// parseCriticResponse — tested indirectly through review()
// ---------------------------------------------------------------------------

describe("LLMCriticImpl", () => {
  describe("parseCriticResponse (via review)", () => {
    test("valid JSON → correct CriticResult", async () => {
      const response = JSON.stringify({
        approved: true,
        aspects: [
          { name: "requirement_coverage", passed: true, explanation: "covers all requirements" },
          { name: "logic_correctness", passed: true, explanation: "logic is sound" },
        ],
        reason: "looks good",
      });
      const critic = new LLMCriticImpl(mockProvider(response));
      const result = await critic.review(minimalProposal, minimalTask, minimalPerception);

      expect(result.approved).toBe(true);
      expect(result.confidence).toBe(1.0);
      expect(result.aspects).toHaveLength(2);
      expect(result.reason).toBe("looks good");
    });

    test("JSON in markdown fences → parsed correctly", async () => {
      const response = "```json\n" + JSON.stringify({
        approved: false,
        aspects: [{ name: "logic_correctness", passed: false, explanation: "off-by-one" }],
        reason: "bug found",
      }) + "\n```";
      const critic = new LLMCriticImpl(mockProvider(response));
      const result = await critic.review(minimalProposal, minimalTask, minimalPerception);

      expect(result.approved).toBe(false);
      expect(result.confidence).toBe(0);
      expect(result.aspects[0]!.name).toBe("logic_correctness");
    });

    test("JSON in bare backtick fences (no json label) → parsed", async () => {
      const response = "```\n" + JSON.stringify({
        approved: true,
        aspects: [{ name: "completeness", passed: true, explanation: "ok" }],
      }) + "\n```";
      const critic = new LLMCriticImpl(mockProvider(response));
      const result = await critic.review(minimalProposal, minimalTask, minimalPerception);

      expect(result.approved).toBe(true);
      expect(result.aspects).toHaveLength(1);
    });

    test("invalid JSON → fail-closed", async () => {
      const critic = new LLMCriticImpl(mockProvider("this is not json at all"));
      const result = await critic.review(minimalProposal, minimalTask, minimalPerception);

      expect(result.approved).toBe(false);
      expect(result.confidence).toBe(0.3);
      expect(result.reason).toContain("fail-closed");
    });

    test("missing 'approved' field → fail-closed", async () => {
      const response = JSON.stringify({
        aspects: [{ name: "test", passed: true, explanation: "ok" }],
      });
      const critic = new LLMCriticImpl(mockProvider(response));
      const result = await critic.review(minimalProposal, minimalTask, minimalPerception);

      expect(result.approved).toBe(false);
      expect(result.confidence).toBe(0.3);
    });

    test("missing 'aspects' field → fail-closed", async () => {
      const response = JSON.stringify({ approved: true });
      const critic = new LLMCriticImpl(mockProvider(response));
      const result = await critic.review(minimalProposal, minimalTask, minimalPerception);

      expect(result.approved).toBe(false);
      expect(result.confidence).toBe(0.3);
    });

    test("empty aspects array → approved with confidence 0.3", async () => {
      const response = JSON.stringify({ approved: true, aspects: [] });
      const critic = new LLMCriticImpl(mockProvider(response));
      const result = await critic.review(minimalProposal, minimalTask, minimalPerception);

      expect(result.approved).toBe(true);
      expect(result.confidence).toBe(0.3);
    });

    test("aspect with missing 'name' → fail-closed", async () => {
      const response = JSON.stringify({
        approved: true,
        aspects: [{ passed: true, explanation: "ok" }],
      });
      const critic = new LLMCriticImpl(mockProvider(response));
      const result = await critic.review(minimalProposal, minimalTask, minimalPerception);

      expect(result.approved).toBe(false);
      expect(result.confidence).toBe(0.3);
    });

    test("aspect with missing 'explanation' → defaults to empty string", async () => {
      const response = JSON.stringify({
        approved: true,
        aspects: [{ name: "test", passed: true }],
      });
      const critic = new LLMCriticImpl(mockProvider(response));
      const result = await critic.review(minimalProposal, minimalTask, minimalPerception);

      expect(result.approved).toBe(true);
      expect(result.aspects[0]!.explanation).toBe("");
    });

    test("mixed pass/fail aspects → confidence reflects ratio", async () => {
      const response = JSON.stringify({
        approved: false,
        aspects: [
          { name: "a", passed: true, explanation: "" },
          { name: "b", passed: false, explanation: "" },
          { name: "c", passed: true, explanation: "" },
          { name: "d", passed: true, explanation: "" },
        ],
        reason: "one failed",
      });
      const critic = new LLMCriticImpl(mockProvider(response));
      const result = await critic.review(minimalProposal, minimalTask, minimalPerception);

      expect(result.confidence).toBe(0.75); // 3/4
    });
  });

  describe("provider errors", () => {
    test("provider throws → fail-closed result", async () => {
      const critic = new LLMCriticImpl(throwingProvider());
      const result = await critic.review(minimalProposal, minimalTask, minimalPerception);

      expect(result.approved).toBe(false);
      expect(result.confidence).toBe(0.3);
      expect(result.tokensUsed).toEqual({ input: 0, output: 0 });
    });
  });

  describe("tokensUsed tracking", () => {
    test("tokens from provider response are forwarded", async () => {
      const response = JSON.stringify({
        approved: true,
        aspects: [{ name: "test", passed: true, explanation: "ok" }],
      });
      const critic = new LLMCriticImpl(mockProvider(response, { input: 500, output: 200 }));
      const result = await critic.review(minimalProposal, minimalTask, minimalPerception);

      expect(result.tokensUsed).toEqual({ input: 500, output: 200 });
    });
  });
});
