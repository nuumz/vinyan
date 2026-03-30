import { describe, test, expect } from "bun:test";
import { assemblePrompt } from "../../../src/orchestrator/llm/prompt-assembler.ts";
import type { PerceptualHierarchy, WorkingMemoryState, TaskDAG } from "../../../src/orchestrator/types.ts";

function makePerception(): PerceptualHierarchy {
  return {
    taskTarget: { file: "src/foo.ts", description: "Fix bug" },
    dependencyCone: {
      directImporters: ["src/bar.ts"],
      directImportees: ["src/utils.ts"],
      transitiveBlastRadius: 3,
    },
    diagnostics: { lintWarnings: [], typeErrors: [], failingTests: [] },
    verifiedFacts: [],
    runtime: { nodeVersion: "v18", os: "darwin", availableTools: ["file_read", "file_write"] },
  };
}

function makeMemory(overrides?: Partial<WorkingMemoryState>): WorkingMemoryState {
  return {
    failedApproaches: [],
    activeHypotheses: [],
    unresolvedUncertainties: [],
    scopedFacts: [],
    ...overrides,
  };
}

describe("PromptAssembler", () => {
  test("system prompt contains ROLE and OUTPUT FORMAT", () => {
    const { systemPrompt } = assemblePrompt("Fix bug", makePerception(), makeMemory());
    expect(systemPrompt).toContain("[ROLE]");
    expect(systemPrompt).toContain("[OUTPUT FORMAT]");
    expect(systemPrompt).toContain("proposedMutations");
  });

  test("user prompt contains TASK and PERCEPTION", () => {
    const { userPrompt } = assemblePrompt("Fix bug", makePerception(), makeMemory());
    expect(userPrompt).toContain("[TASK]");
    expect(userPrompt).toContain("Fix bug");
    expect(userPrompt).toContain("[PERCEPTION]");
    expect(userPrompt).toContain("src/foo.ts");
  });

  test("§17.5 criterion 2: prompt contains failed approach constraints", () => {
    const memory = makeMemory({
      failedApproaches: [
        { approach: "inline function", oracleVerdict: "type error", timestamp: Date.now() },
        { approach: "extract class", oracleVerdict: "dep violation", timestamp: Date.now() },
      ],
    });
    const { userPrompt } = assemblePrompt("Fix bug", makePerception(), memory);
    expect(userPrompt).toContain("[CONSTRAINTS]");
    expect(userPrompt).toContain("Do NOT try");
    expect(userPrompt).toContain("inline function");
    expect(userPrompt).toContain("extract class");
  });

  test("includes PLAN section when plan provided", () => {
    const plan: TaskDAG = {
      nodes: [
        { id: "n1", description: "Step 1: fix type", targetFiles: ["src/foo.ts"], dependencies: [], assignedOracles: ["type"] },
      ],
    };
    const { userPrompt } = assemblePrompt("Fix bug", makePerception(), makeMemory(), plan);
    expect(userPrompt).toContain("[PLAN]");
    expect(userPrompt).toContain("Step 1: fix type");
  });

  test("system prompt lists available tools", () => {
    const { systemPrompt } = assemblePrompt("Fix bug", makePerception(), makeMemory());
    expect(systemPrompt).toContain("file_read");
    expect(systemPrompt).toContain("file_write");
  });

  test("includes diagnostics when type errors present", () => {
    const perception = makePerception();
    perception.diagnostics.typeErrors = [
      { file: "src/foo.ts", line: 5, message: "Type 'string' is not assignable" },
    ];
    const { userPrompt } = assemblePrompt("Fix bug", perception, makeMemory());
    expect(userPrompt).toContain("[DIAGNOSTICS]");
    expect(userPrompt).toContain("not assignable");
  });
});
