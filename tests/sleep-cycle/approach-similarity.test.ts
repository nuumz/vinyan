/**
 * Tests for approach similarity — Jaccard-based clustering.
 *
 * Validates that semantically similar LLM-generated approach strings
 * cluster together, fixing the evolution learning signal.
 */
import { describe, test, expect } from "bun:test";
import {
  normalizeApproach,
  jaccardSimilarity,
  clusterByApproach,
  APPROACH_SIMILARITY_THRESHOLD,
} from "../../src/sleep-cycle/approach-similarity.ts";

describe("normalizeApproach", () => {
  test("lowercases and tokenizes", () => {
    const tokens = normalizeApproach("Extract Helper Function");
    expect(tokens).toEqual(["extract", "function", "helper"]);
  });

  test("removes stop words", () => {
    const tokens = normalizeApproach("use async/await with try-catch error handling");
    expect(tokens).not.toContain("with");
    expect(tokens).toContain("async");
    expect(tokens).toContain("await");
    expect(tokens).toContain("try");
    expect(tokens).toContain("catch");
    expect(tokens).toContain("error");
    expect(tokens).toContain("handling");
    expect(tokens).toContain("use");
  });

  test("splits on punctuation and special characters", () => {
    const tokens = normalizeApproach("file_read; shell_exec (safe-mode)");
    expect(tokens).toContain("file");
    expect(tokens).toContain("read");
    expect(tokens).toContain("shell");
    expect(tokens).toContain("exec");
    expect(tokens).toContain("safe");
    expect(tokens).toContain("mode");
  });

  test("filters single-character tokens", () => {
    const tokens = normalizeApproach("a b c extract d e");
    expect(tokens).toEqual(["extract"]);
  });

  test("returns sorted tokens", () => {
    const tokens = normalizeApproach("zebra alpha middle");
    expect(tokens).toEqual(["alpha", "middle", "zebra"]);
  });

  test("handles empty string", () => {
    expect(normalizeApproach("")).toEqual([]);
  });
});

describe("jaccardSimilarity", () => {
  test("identical sets return 1.0", () => {
    expect(jaccardSimilarity(["a", "b", "c"], ["a", "b", "c"])).toBe(1.0);
  });

  test("disjoint sets return 0", () => {
    expect(jaccardSimilarity(["a", "b"], ["c", "d"])).toBe(0);
  });

  test("partial overlap returns correct fraction", () => {
    // intersection = {a, b}, union = {a, b, c, d} => 2/4 = 0.5
    expect(jaccardSimilarity(["a", "b", "c"], ["a", "b", "d"])).toBeCloseTo(0.5);
  });

  test("both empty return 1.0", () => {
    expect(jaccardSimilarity([], [])).toBe(1.0);
  });

  test("one empty returns 0", () => {
    expect(jaccardSimilarity(["a"], [])).toBe(0);
    expect(jaccardSimilarity([], ["a"])).toBe(0);
  });
});

describe("clusterByApproach", () => {
  test("semantically similar approaches cluster together", () => {
    const items = [
      { id: 1, approach: "Extract helper function to utils" },
      { id: 2, approach: "extract helper function into utils module" },
      { id: 3, approach: "Completely different — rewrite from scratch" },
    ];

    const clusters = clusterByApproach(items, (i) => i.approach);
    // First two should cluster (both about extracting helper to utils)
    expect(clusters.size).toBe(2);

    // Find the cluster containing item 1
    let extractCluster: typeof items | undefined;
    for (const [, group] of clusters) {
      if (group.some(i => i.id === 1)) {
        extractCluster = group;
        break;
      }
    }
    expect(extractCluster).toBeDefined();
    expect(extractCluster!.length).toBe(2);
    expect(extractCluster!.some(i => i.id === 2)).toBe(true);
  });

  test("distinct approaches stay separate", () => {
    const items = [
      { id: 1, approach: "Implement JWT authentication middleware" },
      { id: 2, approach: "Add database connection pooling" },
      { id: 3, approach: "Refactor CSS grid layout" },
    ];

    const clusters = clusterByApproach(items, (i) => i.approach);
    expect(clusters.size).toBe(3);
  });

  test("exact duplicates cluster together", () => {
    const items = [
      { id: 1, approach: "fix the bug" },
      { id: 2, approach: "fix the bug" },
    ];

    const clusters = clusterByApproach(items, (i) => i.approach);
    expect(clusters.size).toBe(1);
    const [, group] = clusters.entries().next().value!;
    expect(group.length).toBe(2);
  });

  test("custom threshold works", () => {
    const items = [
      { id: 1, approach: "extract helper function" },
      { id: 2, approach: "extract utility function" },
    ];

    // Very high threshold — should not cluster
    const strict = clusterByApproach(items, (i) => i.approach, 0.99);
    expect(strict.size).toBe(2);

    // Very low threshold — should cluster
    const loose = clusterByApproach(items, (i) => i.approach, 0.3);
    expect(loose.size).toBe(1);
  });

  test("handles empty input", () => {
    const clusters = clusterByApproach([], (i: { approach: string }) => i.approach);
    expect(clusters.size).toBe(0);
  });

  test("default threshold is 0.6", () => {
    expect(APPROACH_SIMILARITY_THRESHOLD).toBe(0.6);
  });
});
