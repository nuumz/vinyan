import { describe, test, expect } from "bun:test";
import { resolveRuleConflicts } from "../../src/evolution/rule-resolver.ts";
import type { EvolutionaryRule } from "../../src/orchestrator/types.ts";

function makeRule(overrides?: Partial<EvolutionaryRule>): EvolutionaryRule {
  return {
    id: "rule-1",
    source: "sleep-cycle",
    condition: { file_pattern: "*.ts" },
    action: "escalate",
    parameters: { toLevel: 2 },
    status: "active",
    created_at: Date.now(),
    effectiveness: 0.5,
    specificity: 1,
    ...overrides,
  };
}

describe("resolveRuleConflicts", () => {
  test("no conflict — different action types both apply", () => {
    const rules = [
      makeRule({ id: "r1", action: "escalate" }),
      makeRule({ id: "r2", action: "require-oracle" }),
    ];
    const winners = resolveRuleConflicts(rules);
    expect(winners).toHaveLength(2);
  });

  test("specificity wins — more conditions = higher priority", () => {
    const rules = [
      makeRule({ id: "r1", specificity: 1, effectiveness: 0.5 }),
      makeRule({ id: "r2", specificity: 2, effectiveness: 0.3 }),
    ];
    const winners = resolveRuleConflicts(rules);
    expect(winners).toHaveLength(1);
    expect(winners[0]!.id).toBe("r2"); // higher specificity wins
  });

  test("effectiveness breaks tie when specificity is equal", () => {
    const rules = [
      makeRule({ id: "r1", specificity: 1, effectiveness: 0.7 }),
      makeRule({ id: "r2", specificity: 1, effectiveness: 0.9 }),
    ];
    const winners = resolveRuleConflicts(rules);
    expect(winners).toHaveLength(1);
    expect(winners[0]!.id).toBe("r2"); // higher effectiveness wins
  });

  test("safety floor — stricter action wins on full tie", () => {
    const rules = [
      makeRule({ id: "r1", specificity: 1, effectiveness: 0.5, parameters: { toLevel: 1 } }),
      makeRule({ id: "r2", specificity: 1, effectiveness: 0.5, parameters: { toLevel: 3 } }),
    ];
    const winners = resolveRuleConflicts(rules);
    expect(winners).toHaveLength(1);
    expect(winners[0]!.id).toBe("r2"); // L3 is stricter than L1
  });

  test("single rule returns as-is", () => {
    const rules = [makeRule()];
    expect(resolveRuleConflicts(rules)).toHaveLength(1);
  });

  test("empty input returns empty", () => {
    expect(resolveRuleConflicts([])).toHaveLength(0);
  });
});
