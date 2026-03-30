import { describe, test, expect } from "bun:test";
import { generateRule, generateRules } from "../../src/evolution/rule-generator.ts";
import type { ExtractedPattern } from "../../src/orchestrator/types.ts";

function makePattern(overrides?: Partial<ExtractedPattern>): ExtractedPattern {
  return {
    id: "p-1",
    type: "anti-pattern",
    description: "approach X fails on auth tasks",
    frequency: 20,
    confidence: 0.85,
    taskTypeSignature: "refactor::auth.ts",
    approach: "bad-approach",
    sourceTraceIds: ["t-1"],
    createdAt: Date.now(),
    decayWeight: 1.0,
    ...overrides,
  };
}

describe("generateRule", () => {
  test("anti-pattern generates escalation rule", () => {
    const rule = generateRule(makePattern({ type: "anti-pattern" }));
    expect(rule).not.toBeNull();
    expect(rule!.action).toBe("escalate");
    expect(rule!.status).toBe("probation");
    expect(rule!.parameters.toLevel).toBe(2);
    expect(rule!.parameters.failingApproach).toBe("bad-approach");
    expect(rule!.id).toContain("rule-esc-");
  });

  test("success-pattern generates prefer-model rule", () => {
    const rule = generateRule(makePattern({
      type: "success-pattern",
      approach: "good-approach",
      comparedApproach: "bad-approach",
      qualityDelta: 0.35,
    }));
    expect(rule).not.toBeNull();
    expect(rule!.action).toBe("prefer-model");
    expect(rule!.parameters.preferredApproach).toBe("good-approach");
    expect(rule!.parameters.comparedApproach).toBe("bad-approach");
    expect(rule!.parameters.qualityDelta).toBe(0.35);
  });

  test("rule specificity reflects condition fields", () => {
    // Pattern with file pattern in task signature
    const rule = generateRule(makePattern({ taskTypeSignature: "refactor::auth.ts" }));
    expect(rule!.specificity).toBe(1);

    // Pattern with wildcard file pattern → no file_pattern condition
    const rule2 = generateRule(makePattern({ taskTypeSignature: "refactor::*" }));
    expect(rule2!.specificity).toBe(0);
  });
});

describe("generateRules", () => {
  test("generates rules for multiple patterns", () => {
    const patterns = [
      makePattern({ id: "p1", type: "anti-pattern" }),
      makePattern({ id: "p2", type: "success-pattern", approach: "good" }),
    ];
    const rules = generateRules(patterns);
    expect(rules).toHaveLength(2);
    expect(rules[0]!.action).toBe("escalate");
    expect(rules[1]!.action).toBe("prefer-model");
  });
});
