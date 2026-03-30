import { describe, test, expect } from "bun:test";
import { checkSafetyInvariants, filterSafeRules } from "../../src/evolution/safety-invariants.ts";
import type { EvolutionaryRule } from "../../src/orchestrator/types.ts";

function makeRule(overrides?: Partial<EvolutionaryRule>): EvolutionaryRule {
  return {
    id: "rule-1",
    source: "sleep-cycle",
    condition: {},
    action: "escalate",
    parameters: { toLevel: 2 },
    status: "active",
    created_at: Date.now(),
    effectiveness: 0.5,
    specificity: 0,
    ...overrides,
  };
}

describe("checkSafetyInvariants", () => {
  test("safe rule passes all invariants", () => {
    const result = checkSafetyInvariants(makeRule());
    expect(result.safe).toBe(true);
    expect(result.violations).toHaveLength(0);
  });

  test("I1: detects disabled human escalation", () => {
    const result = checkSafetyInvariants(makeRule({
      action: "adjust-threshold",
      parameters: { disableHumanEscalation: true },
    }));
    expect(result.safe).toBe(false);
    expect(result.violations[0]).toContain("I1");
  });

  test("I2: detects relaxed security", () => {
    const result = checkSafetyInvariants(makeRule({
      action: "adjust-threshold",
      parameters: { relaxSecurity: true },
    }));
    expect(result.safe).toBe(false);
    expect(result.violations[0]).toContain("I2");
  });

  test("I3: detects budget ceiling violation", () => {
    const result = checkSafetyInvariants(makeRule({
      action: "adjust-threshold",
      parameters: { maxTokens: 1_000_000 },
    }));
    expect(result.safe).toBe(false);
    expect(result.violations[0]).toContain("I3");
  });

  test("I4: detects skipped tests", () => {
    const result = checkSafetyInvariants(makeRule({
      action: "adjust-threshold",
      parameters: { skipTests: true },
    }));
    expect(result.safe).toBe(false);
    expect(result.violations[0]).toContain("I4");
  });

  test("I5: detects disabled rollback", () => {
    const result = checkSafetyInvariants(makeRule({
      action: "adjust-threshold",
      parameters: { disableRollback: true },
    }));
    expect(result.safe).toBe(false);
    expect(result.violations[0]).toContain("I5");
  });

  test("I6: detects routing floor violation", () => {
    const result = checkSafetyInvariants(makeRule({
      action: "adjust-threshold",
      parameters: { forceL0ForMultiFile: true },
    }));
    expect(result.safe).toBe(false);
    expect(result.violations[0]).toContain("I6");
  });

  test("multiple violations detected at once", () => {
    const result = checkSafetyInvariants(makeRule({
      action: "adjust-threshold",
      parameters: { skipTests: true, disableRollback: true, relaxSecurity: true },
    }));
    expect(result.safe).toBe(false);
    expect(result.violations.length).toBeGreaterThanOrEqual(3);
  });
});

describe("filterSafeRules", () => {
  test("filters out unsafe rules and reports violations", () => {
    const rules = [
      makeRule({ id: "safe-1" }),
      makeRule({ id: "unsafe-1", action: "adjust-threshold", parameters: { skipTests: true } }),
      makeRule({ id: "safe-2", parameters: { toLevel: 3 } }),
    ];

    const result = filterSafeRules(rules);
    expect(result.safe).toHaveLength(2);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]!.ruleId).toBe("unsafe-1");
  });
});
