import { describe, test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { PatternStore } from "../../src/db/pattern-store.ts";
import { PATTERN_SCHEMA_SQL } from "../../src/db/pattern-schema.ts";
import type { ExtractedPattern } from "../../src/orchestrator/types.ts";

function createStore(): PatternStore {
  const db = new Database(":memory:");
  db.exec(PATTERN_SCHEMA_SQL);
  return new PatternStore(db);
}

function makePattern(overrides?: Partial<ExtractedPattern>): ExtractedPattern {
  return {
    id: `p-${Math.random().toString(36).slice(2)}`,
    type: "anti-pattern",
    description: "test pattern",
    frequency: 10,
    confidence: 0.7,
    taskTypeSignature: "refactor::src/auth.ts",
    sourceTraceIds: ["t1", "t2", "t3"],
    createdAt: Date.now(),
    decayWeight: 1.0,
    ...overrides,
  };
}

describe("PatternStore", () => {
  test("insert and query by type", () => {
    const store = createStore();
    store.insert(makePattern({ id: "p1", type: "anti-pattern" }));
    store.insert(makePattern({ id: "p2", type: "success-pattern" }));
    store.insert(makePattern({ id: "p3", type: "anti-pattern" }));

    const anti = store.queryByType("anti-pattern");
    expect(anti).toHaveLength(2);
    expect(anti.every(p => p.type === "anti-pattern")).toBe(true);

    const success = store.queryByType("success-pattern");
    expect(success).toHaveLength(1);
  });

  test("query by task signature", () => {
    const store = createStore();
    store.insert(makePattern({ id: "p1", taskTypeSignature: "refactor::auth.ts" }));
    store.insert(makePattern({ id: "p2", taskTypeSignature: "fix::db.ts" }));
    store.insert(makePattern({ id: "p3", taskTypeSignature: "refactor::auth.ts" }));

    const results = store.findByTaskSignature("refactor::auth.ts");
    expect(results).toHaveLength(2);
  });

  test("insert/query roundtrip preserves all fields", () => {
    const store = createStore();
    const pattern = makePattern({
      id: "p-rt",
      type: "success-pattern",
      approach: "approach-A",
      comparedApproach: "approach-B",
      qualityDelta: 0.35,
      expiresAt: Date.now() + 100000,
      decayWeight: 0.85,
    });
    store.insert(pattern);

    const result = store.queryByType("success-pattern")[0]!;
    expect(result.id).toBe("p-rt");
    expect(result.approach).toBe("approach-A");
    expect(result.comparedApproach).toBe("approach-B");
    expect(result.qualityDelta).toBeCloseTo(0.35);
    expect(result.expiresAt).toBeDefined();
    expect(result.decayWeight).toBeCloseTo(0.85);
    expect(result.sourceTraceIds).toEqual(["t1", "t2", "t3"]);
  });

  test("findActive filters by decay weight", () => {
    const store = createStore();
    store.insert(makePattern({ id: "p1", decayWeight: 0.5 }));
    store.insert(makePattern({ id: "p2", decayWeight: 0.05 }));
    store.insert(makePattern({ id: "p3", decayWeight: 0.9 }));

    const active = store.findActive(0.1);
    expect(active).toHaveLength(2);
    expect(active.map(p => p.id).sort()).toEqual(["p1", "p3"]);
  });

  test("updateDecayWeight modifies in place", () => {
    const store = createStore();
    store.insert(makePattern({ id: "p1", decayWeight: 1.0 }));

    store.updateDecayWeight("p1", 0.3);

    const result = store.findActive(0)[0]!;
    expect(result.decayWeight).toBeCloseTo(0.3);
  });

  test("count returns total patterns", () => {
    const store = createStore();
    expect(store.count()).toBe(0);

    store.insert(makePattern({ id: "p1" }));
    store.insert(makePattern({ id: "p2" }));
    expect(store.count()).toBe(2);
  });

  test("countByType separates anti and success", () => {
    const store = createStore();
    store.insert(makePattern({ id: "p1", type: "anti-pattern" }));
    store.insert(makePattern({ id: "p2", type: "success-pattern" }));
    store.insert(makePattern({ id: "p3", type: "anti-pattern" }));

    expect(store.countByType("anti-pattern")).toBe(2);
    expect(store.countByType("success-pattern")).toBe(1);
  });

  test("sleep cycle run tracking", () => {
    const store = createStore();
    expect(store.countCycleRuns()).toBe(0);

    store.recordCycleStart("c1");
    expect(store.countCycleRuns()).toBe(0); // running, not completed

    store.recordCycleComplete("c1", 100, 3);
    expect(store.countCycleRuns()).toBe(1);
  });
});
