import { describe, test, expect } from "bun:test";
import type { CriticEngine, CriticResult, WorkerProposal } from "../../../src/orchestrator/critic/critic-engine.ts";
import type { TaskInput, PerceptualHierarchy } from "../../../src/orchestrator/types.ts";
import { LLMCriticImpl } from "../../../src/orchestrator/critic/llm-critic-impl.ts";
import type { LLMProvider } from "../../../src/orchestrator/types.ts";

/** Minimal mock implementation to verify the interface contract */
function createMockCritic(result: Partial<CriticResult> = {}): CriticEngine {
  return {
    review: async () => ({
      approved: true,
      verdicts: {},
      confidence: 0.8,
      aspects: [],
      tokensUsed: { input: 100, output: 50 },
      ...result,
    }),
  };
}

function makeProposal(): WorkerProposal {
  return {
    mutations: [{ file: "src/foo.ts", content: "export const x = 2;", explanation: "fix" }],
    approach: "direct-edit",
  };
}

function makeTask(): TaskInput {
  return {
    id: "t-1",
    source: "cli",
    goal: "Fix bug",
    budget: { maxTokens: 50_000, maxDurationMs: 60_000, maxRetries: 3 },
  };
}

function makePerception(): PerceptualHierarchy {
  return {
    taskTarget: { file: "src/foo.ts", description: "Fix bug" },
    dependencyCone: { directImporters: [], directImportees: [], transitiveBlastRadius: 0 },
    diagnostics: { lintWarnings: [], typeErrors: [], failingTests: [] },
    verifiedFacts: [],
    runtime: { nodeVersion: "v18", os: "darwin", availableTools: [] },
  };
}

describe("CriticEngine interface contract", () => {
  test("approved review returns approved=true", async () => {
    const critic = createMockCritic({ approved: true });
    const result = await critic.review(makeProposal(), makeTask(), makePerception());
    expect(result.approved).toBe(true);
    expect(result.confidence).toBeGreaterThan(0);
  });

  test("rejected review returns reason", async () => {
    const critic = createMockCritic({
      approved: false,
      reason: "Logic error in conditional",
      aspects: [{ name: "logic-correctness", passed: false, explanation: "Off-by-one" }],
    });
    const result = await critic.review(makeProposal(), makeTask(), makePerception());
    expect(result.approved).toBe(false);
    expect(result.reason).toBe("Logic error in conditional");
    expect(result.aspects).toHaveLength(1);
    expect(result.aspects[0]!.passed).toBe(false);
  });

  test("verdicts are keyed by aspect name", async () => {
    const critic = createMockCritic({
      verdicts: {
        "critic-logic": {
          verified: true,
          type: "uncertain",
          confidence: 0.85,
          evidence: [],
          fileHashes: {},
          duration_ms: 100,
        },
      },
    });
    const result = await critic.review(makeProposal(), makeTask(), makePerception());
    expect(result.verdicts["critic-logic"]).toBeDefined();
    expect(result.verdicts["critic-logic"]!.type).toBe("uncertain");
  });

  test("tokens are tracked", async () => {
    const critic = createMockCritic();
    const result = await critic.review(makeProposal(), makeTask(), makePerception());
    expect(result.tokensUsed.input).toBeGreaterThan(0);
    expect(result.tokensUsed.output).toBeGreaterThan(0);
  });

  test("accepts acceptance criteria parameter", async () => {
    const critic = createMockCritic();
    const result = await critic.review(
      makeProposal(), makeTask(), makePerception(),
      ["all tests pass", "no new lint warnings"],
    );
    expect(result.approved).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// LLMCriticImpl fail-closed behavior (A2 compliance)
// ---------------------------------------------------------------------------

function makeThrowingProvider(): LLMProvider {
  return {
    generate: async () => { throw new Error("provider unavailable"); },
  } as unknown as LLMProvider;
}

function makeUnparseableProvider(): LLMProvider {
  return {
    generate: async () => ({
      content: "this is not valid JSON at all",
      tokensUsed: { input: 50, output: 20 },
    }),
  } as unknown as LLMProvider;
}

describe("LLMCriticImpl fail-closed behavior", () => {
  test("returns approved=false when LLM provider throws", async () => {
    const critic = new LLMCriticImpl(makeThrowingProvider());
    const result = await critic.review(makeProposal(), makeTask(), makePerception());
    expect(result.approved).toBe(false);
    expect(result.confidence).toBe(0.3);
    expect(result.reason).toContain("fail-closed");
  });

  test("returns approved=false when LLM response is unparseable", async () => {
    const critic = new LLMCriticImpl(makeUnparseableProvider());
    const result = await critic.review(makeProposal(), makeTask(), makePerception());
    expect(result.approved).toBe(false);
    expect(result.confidence).toBe(0.3);
    expect(result.reason).toContain("fail-closed");
  });

  test("all aspects are passed=false on failure", async () => {
    const critic = new LLMCriticImpl(makeThrowingProvider());
    const result = await critic.review(makeProposal(), makeTask(), makePerception());
    expect(result.aspects.length).toBe(5);
    for (const aspect of result.aspects) {
      expect(aspect.passed).toBe(false);
      expect(aspect.explanation).toContain("fail-closed");
    }
  });

  test("tokens are tracked even on parse failure", async () => {
    const critic = new LLMCriticImpl(makeUnparseableProvider());
    const result = await critic.review(makeProposal(), makeTask(), makePerception());
    expect(result.tokensUsed.input).toBe(50);
    expect(result.tokensUsed.output).toBe(20);
  });
});
