import { describe, test, expect } from "bun:test";
import { computeDecayedConfidence, isFullyExpired } from "../../src/world-graph/temporal-decay.ts";
import { WorldGraph } from "../../src/world-graph/world-graph.ts";

describe("temporal-decay", () => {
  describe("computeDecayedConfidence", () => {
    test("linear: midpoint → 50% of original", () => {
      expect(computeDecayedConfidence(1.0, 1000, 2000, "linear", 1500)).toBeCloseTo(0.5, 5);
    });

    test("linear: at start → full confidence", () => {
      expect(computeDecayedConfidence(1.0, 1000, 2000, "linear", 1000)).toBe(1.0);
    });

    test("linear: at end → 0", () => {
      expect(computeDecayedConfidence(1.0, 1000, 2000, "linear", 2000)).toBe(0);
    });

    test("linear: past end → 0", () => {
      expect(computeDecayedConfidence(1.0, 1000, 2000, "linear", 3000)).toBe(0);
    });

    test("linear: before start → full confidence", () => {
      expect(computeDecayedConfidence(1.0, 1000, 2000, "linear", 500)).toBe(1.0);
    });

    test("none: before expiry → full confidence", () => {
      expect(computeDecayedConfidence(1.0, 1000, 2000, "none", 1500)).toBe(1.0);
    });

    test("none: at expiry → 0", () => {
      expect(computeDecayedConfidence(1.0, 1000, 2000, "none", 2000)).toBe(0);
    });

    test("none: after expiry → 0", () => {
      expect(computeDecayedConfidence(1.0, 1000, 2000, "none", 3000)).toBe(0);
    });

    test("step: before expiry → full confidence", () => {
      expect(computeDecayedConfidence(1.0, 1000, 2000, "step", 1500)).toBe(1.0);
    });

    test("step: after expiry → 50% of original (ECP spec §3.6)", () => {
      expect(computeDecayedConfidence(1.0, 1000, 2000, "step", 3000)).toBe(0.5);
    });

    test("step: 0.8 original → 0.4 after expiry", () => {
      expect(computeDecayedConfidence(0.8, 1000, 2000, "step", 3000)).toBeCloseTo(0.4, 5);
    });

    test("no temporal context → original confidence", () => {
      expect(computeDecayedConfidence(0.8, 1000, undefined, undefined)).toBe(0.8);
    });

    test("no decayModel → original confidence", () => {
      expect(computeDecayedConfidence(0.8, 1000, 2000, undefined)).toBe(0.8);
    });

    test("no validUntil → original confidence", () => {
      expect(computeDecayedConfidence(0.8, 1000, undefined, "linear")).toBe(0.8);
    });

    test("linear: zero-length window → 0", () => {
      expect(computeDecayedConfidence(1.0, 1000, 1000, "linear", 1000)).toBe(0);
    });
  });

  describe("isFullyExpired", () => {
    test("no validUntil → not expired", () => {
      expect(isFullyExpired(undefined, undefined)).toBe(false);
    });

    test("none: past validUntil → expired", () => {
      expect(isFullyExpired(2000, "none", 3000)).toBe(true);
    });

    test("none: before validUntil → not expired", () => {
      expect(isFullyExpired(2000, "none", 1000)).toBe(false);
    });

    test("step: past validUntil → never fully expired", () => {
      expect(isFullyExpired(2000, "step", 3000)).toBe(false);
    });

    test("linear: past validUntil → expired", () => {
      expect(isFullyExpired(2000, "linear", 3000)).toBe(true);
    });
  });

  describe("integration: temporal context in WorldGraph", () => {
    test("expired fact with decay_model='none' excluded from queryFacts", () => {
      const wg = new WorldGraph(":memory:");
      try {
        const pastTime = Date.now() - 10_000;
        wg.storeFact({
          target: "src/a.ts",
          pattern: "type-check",
          evidence: [{ file: "src/a.ts", line: 1, snippet: "ok" }],
          oracle_name: "type",
          file_hash: "hash-a",
          source_file: "src/a.ts",
          verified_at: pastTime - 5000,
          confidence: 1.0,
          valid_until: pastTime, // already expired
          decay_model: "none",
        });

        const facts = wg.queryFacts("src/a.ts");
        expect(facts).toHaveLength(0);
      } finally {
        wg.close();
      }
    });

    test("expired fact with decay_model='step' still included (drops to 50%)", () => {
      const wg = new WorldGraph(":memory:");
      try {
        const pastTime = Date.now() - 10_000;
        wg.storeFact({
          target: "src/b.ts",
          pattern: "lint-clean",
          evidence: [{ file: "src/b.ts", line: 1, snippet: "ok" }],
          oracle_name: "lint",
          file_hash: "hash-b",
          source_file: "src/b.ts",
          verified_at: pastTime - 5000,
          confidence: 0.9,
          valid_until: pastTime, // already expired
          decay_model: "step",
        });

        const facts = wg.queryFacts("src/b.ts");
        expect(facts).toHaveLength(1);
        expect(facts[0]!.decay_model).toBe("step");
      } finally {
        wg.close();
      }
    });

    test("non-expired fact with temporal context included", () => {
      const wg = new WorldGraph(":memory:");
      try {
        const futureTime = Date.now() + 60_000;
        wg.storeFact({
          target: "src/c.ts",
          pattern: "type-check",
          evidence: [{ file: "src/c.ts", line: 1, snippet: "ok" }],
          oracle_name: "type",
          file_hash: "hash-c",
          source_file: "src/c.ts",
          verified_at: Date.now(),
          confidence: 1.0,
          valid_until: futureTime,
          decay_model: "linear",
        });

        const facts = wg.queryFacts("src/c.ts");
        expect(facts).toHaveLength(1);
        expect(facts[0]!.valid_until).toBe(futureTime);
        expect(facts[0]!.decay_model).toBe("linear");
      } finally {
        wg.close();
      }
    });

    test("fact without temporal context always included", () => {
      const wg = new WorldGraph(":memory:");
      try {
        wg.storeFact({
          target: "src/d.ts",
          pattern: "type-check",
          evidence: [{ file: "src/d.ts", line: 1, snippet: "ok" }],
          oracle_name: "type",
          file_hash: "hash-d",
          source_file: "src/d.ts",
          verified_at: Date.now(),
          confidence: 1.0,
        });

        const facts = wg.queryFacts("src/d.ts");
        expect(facts).toHaveLength(1);
        expect(facts[0]!.valid_until).toBeUndefined();
      } finally {
        wg.close();
      }
    });
  });
});
