/**
 * Property-Based Tests — Deterministic Governance (A3)
 *
 * Uses fast-check to verify invariants that must hold for ALL inputs:
 * - resolveRuleConflicts: permutation invariance
 * - computeBlastRadius: BFS completeness
 * - Wilson CI: mathematical bounds
 */
import { describe, test, expect } from "bun:test";
import * as fc from "fast-check";
import { resolveRuleConflicts } from "../../src/evolution/rule-resolver.ts";
import { computeBlastRadius } from "../../src/oracle/dep/dep-analyzer.ts";
import { wilsonLowerBound, wilsonUpperBound } from "../../src/sleep-cycle/wilson.ts";
import type { EvolutionaryRule } from "../../src/orchestrator/types.ts";

// ── Generators ──────────────────────────────────────────────────────────

const actionArb = fc.constantFrom(
  "escalate" as const,
  "require-oracle" as const,
  "prefer-model" as const,
  "adjust-threshold" as const,
  "assign-worker" as const,
);

const ruleArb: fc.Arbitrary<EvolutionaryRule> = fc.record({
  id: fc.uuid(),
  source: fc.constantFrom("sleep-cycle" as const, "manual" as const),
  condition: fc.record({
    file_pattern: fc.option(fc.string(), { nil: undefined }),
    oracle_name: fc.option(fc.string(), { nil: undefined }),
    risk_above: fc.option(fc.float({ min: 0, max: 1, noNaN: true }), { nil: undefined }),
    model_pattern: fc.option(fc.string(), { nil: undefined }),
  }),
  action: actionArb,
  parameters: fc.constant({}),
  status: fc.constantFrom("probation" as const, "active" as const, "retired" as const),
  created_at: fc.nat(),
  effectiveness: fc.float({ min: 0, max: 1, noNaN: true }),
  specificity: fc.nat({ max: 4 }),
  superseded_by: fc.option(fc.uuid(), { nil: undefined }),
});

// ── resolveRuleConflicts: Permutation Invariance (A3) ────────────────

describe("PBT: resolveRuleConflicts permutation invariance", () => {
  test("same rules in different order → same winners (A3)", () => {
    fc.assert(
      fc.property(fc.array(ruleArb, { minLength: 1, maxLength: 10 }), (rules) => {
        const result1 = resolveRuleConflicts(rules);
        // Shuffle the input
        const shuffled = [...rules].reverse();
        const result2 = resolveRuleConflicts(shuffled);

        // Same number of winners
        expect(result1.length).toBe(result2.length);

        // Same winner IDs (order doesn't matter — sort for comparison)
        const ids1 = result1.map(r => r.id).sort();
        const ids2 = result2.map(r => r.id).sort();
        expect(ids1).toEqual(ids2);
      }),
      { numRuns: 200 },
    );
  });

  test("output is subset of input — no rule fabrication", () => {
    fc.assert(
      fc.property(fc.array(ruleArb, { minLength: 0, maxLength: 10 }), (rules) => {
        const winners = resolveRuleConflicts(rules);
        const inputIds = new Set(rules.map(r => r.id));
        for (const w of winners) {
          expect(inputIds.has(w.id)).toBe(true);
        }
      }),
      { numRuns: 200 },
    );
  });

  test("at most one winner per action type", () => {
    fc.assert(
      fc.property(fc.array(ruleArb, { minLength: 0, maxLength: 10 }), (rules) => {
        const winners = resolveRuleConflicts(rules);
        const actions = winners.map(w => w.action);
        const uniqueActions = new Set(actions);
        expect(actions.length).toBe(uniqueActions.size);
      }),
      { numRuns: 200 },
    );
  });

  test("empty input → empty output", () => {
    expect(resolveRuleConflicts([])).toEqual([]);
  });

  test("single rule → that rule wins", () => {
    fc.assert(
      fc.property(ruleArb, (rule) => {
        const result = resolveRuleConflicts([rule]);
        expect(result).toHaveLength(1);
        expect(result[0]!.id).toBe(rule.id);
      }),
      { numRuns: 100 },
    );
  });
});

// ── computeBlastRadius: BFS Completeness ─────────────────────────────

describe("PBT: computeBlastRadius BFS completeness", () => {
  // Generate a small dependency graph
  const fileArb = fc.constantFrom("a.ts", "b.ts", "c.ts", "d.ts", "e.ts");
  const graphArb = fc.array(
    fc.tuple(fileArb, fc.array(fileArb, { minLength: 0, maxLength: 3 })),
    { minLength: 0, maxLength: 10 },
  ).map(edges => {
    const graph = new Map<string, Set<string>>();
    for (const [file, deps] of edges) {
      graph.set(file, new Set(deps));
    }
    return graph;
  });

  test("blast radius is deterministic for same input (A3)", () => {
    fc.assert(
      fc.property(fileArb, graphArb, (target, graph) => {
        const result1 = computeBlastRadius(target, graph);
        const result2 = computeBlastRadius(target, graph);
        expect(result1.sort()).toEqual(result2.sort());
      }),
      { numRuns: 200 },
    );
  });

  test("blast radius is monotonic: adding edges never reduces it", () => {
    fc.assert(
      fc.property(fileArb, graphArb, fileArb, fileArb, (target, graph, newFrom, newTo) => {
        const before = new Set(computeBlastRadius(target, graph));

        // Add an edge
        const extended = new Map(graph);
        const deps = extended.get(newFrom) ?? new Set();
        deps.add(newTo);
        extended.set(newFrom, deps);

        const after = new Set(computeBlastRadius(target, extended));

        // Every file in before should still be in after
        for (const file of before) {
          expect(after.has(file)).toBe(true);
        }
      }),
      { numRuns: 200 },
    );
  });

  test("empty graph → empty blast radius", () => {
    const result = computeBlastRadius("any.ts", new Map());
    expect(result).toHaveLength(0);
  });

  test("direct dependent is always in blast radius", () => {
    // If b.ts imports a.ts, then b.ts should be in a.ts's blast radius
    const graph = new Map<string, Set<string>>();
    graph.set("b.ts", new Set(["a.ts"]));

    const result = computeBlastRadius("a.ts", graph);
    expect(result).toContain("b.ts");
  });
});

// ── Wilson CI: Mathematical Bounds ───────────────────────────────────

describe("PBT: Wilson score confidence interval bounds", () => {
  const validInputArb = fc.record({
    successes: fc.nat({ max: 1000 }),
    total: fc.integer({ min: 1, max: 1000 }),
  }).filter(({ successes, total }) => successes <= total);

  test("lower bound ≤ observed proportion ≤ upper bound (for n > 0)", () => {
    fc.assert(
      fc.property(validInputArb, ({ successes, total }) => {
        const p = successes / total;
        const lb = wilsonLowerBound(successes, total);
        const ub = wilsonUpperBound(successes, total);
        expect(lb).toBeLessThanOrEqual(p + 1e-10); // small epsilon for float precision
        expect(ub).toBeGreaterThanOrEqual(p - 1e-10);
      }),
      { numRuns: 500 },
    );
  });

  test("lower bound is in [0, 1]", () => {
    fc.assert(
      fc.property(validInputArb, ({ successes, total }) => {
        const lb = wilsonLowerBound(successes, total);
        expect(lb).toBeGreaterThanOrEqual(0);
        expect(lb).toBeLessThanOrEqual(1);
      }),
      { numRuns: 500 },
    );
  });

  test("upper bound is in [0, 1]", () => {
    fc.assert(
      fc.property(validInputArb, ({ successes, total }) => {
        const ub = wilsonUpperBound(successes, total);
        expect(ub).toBeGreaterThanOrEqual(0);
        expect(ub).toBeLessThanOrEqual(1);
      }),
      { numRuns: 500 },
    );
  });

  test("lower bound ≤ upper bound", () => {
    fc.assert(
      fc.property(validInputArb, ({ successes, total }) => {
        const lb = wilsonLowerBound(successes, total);
        const ub = wilsonUpperBound(successes, total);
        expect(lb).toBeLessThanOrEqual(ub + 1e-10);
      }),
      { numRuns: 500 },
    );
  });

  test("interval narrows with more observations", () => {
    // For fixed proportion, width should decrease as n increases
    fc.assert(
      fc.property(
        fc.float({ min: Math.fround(0.05), max: Math.fround(0.95), noNaN: true }),
        fc.integer({ min: 10, max: 100 }),
        (proportion, nSmall) => {
          const nLarge = nSmall * 10;
          const sSmall = Math.round(proportion * nSmall);
          const sLarge = Math.round(proportion * nLarge);

          const widthSmall = wilsonUpperBound(sSmall, nSmall) - wilsonLowerBound(sSmall, nSmall);
          const widthLarge = wilsonUpperBound(sLarge, nLarge) - wilsonLowerBound(sLarge, nLarge);

          expect(widthLarge).toBeLessThanOrEqual(widthSmall + 1e-10);
        },
      ),
      { numRuns: 200 },
    );
  });

  test("zero total returns 0 for both bounds", () => {
    expect(wilsonLowerBound(0, 0)).toBe(0);
    expect(wilsonUpperBound(0, 0)).toBe(0);
  });
});
