import { describe, test, expect } from "bun:test";
import { wilsonLowerBound, wilsonUpperBound } from "../../src/sleep-cycle/wilson.ts";

describe("wilsonLowerBound", () => {
  test("returns 0 for empty sample", () => {
    expect(wilsonLowerBound(0, 0)).toBe(0);
  });

  test("1/1 gives high lower bound", () => {
    // 1 success out of 1 trial — small sample, LB should be moderate
    const lb = wilsonLowerBound(1, 1);
    expect(lb).toBeGreaterThan(0.02);
    expect(lb).toBeLessThan(1);
  });

  test("10/10 gives higher lower bound than 1/1", () => {
    expect(wilsonLowerBound(10, 10)).toBeGreaterThan(wilsonLowerBound(1, 1));
  });

  test("0 successes gives 0 lower bound", () => {
    expect(wilsonLowerBound(0, 10)).toBe(0);
  });

  test("large sample with 80% success rate gives LB ≥ 0.6", () => {
    // 80/100 = 80% rate, should have Wilson LB well above 0.6
    const lb = wilsonLowerBound(80, 100);
    expect(lb).toBeGreaterThanOrEqual(0.6);
  });

  test("small sample with 80% rate may not reach 0.6 LB", () => {
    // 4/5 = 80% but small N → wider CI → lower LB
    const lb = wilsonLowerBound(4, 5);
    expect(lb).toBeLessThan(0.6);
  });

  test("known value: 5/10 at z=1.96", () => {
    // 50% rate with 10 observations
    const lb = wilsonLowerBound(5, 10, 1.96);
    // Expected: approximately 0.236 (can verify with online calculator)
    expect(lb).toBeGreaterThan(0.2);
    expect(lb).toBeLessThan(0.5);
  });
});

describe("wilsonUpperBound", () => {
  test("returns 0 for empty sample", () => {
    expect(wilsonUpperBound(0, 0)).toBe(0);
  });

  test("upper bound is always >= lower bound", () => {
    for (const [s, n] of [[3, 10], [7, 10], [50, 100], [1, 5]] as [number, number][]) {
      expect(wilsonUpperBound(s, n)).toBeGreaterThanOrEqual(wilsonLowerBound(s, n));
    }
  });

  test("upper bound ≤ 1", () => {
    expect(wilsonUpperBound(10, 10)).toBeLessThanOrEqual(1);
  });
});
