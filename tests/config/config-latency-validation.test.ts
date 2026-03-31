import { describe, test, expect } from "bun:test";
import { VinyanConfigSchema } from "../../src/config/schema.ts";

function configWithLatency(latency: { l0: number; l1: number; l2: number; l3: number }) {
  return {
    phase1: {
      routing: {
        latency_budgets_ms: latency,
      },
    },
  };
}

describe("LatencyBudgetsSchema cross-field validation (WU6)", () => {
  test("default config (100 < 2000 < 10000 < 60000) passes", () => {
    const result = VinyanConfigSchema.safeParse({});
    expect(result.success).toBe(true);
  });

  test("strictly ordered latency budgets pass", () => {
    const result = VinyanConfigSchema.safeParse(
      configWithLatency({ l0: 100, l1: 2000, l2: 10000, l3: 60000 }),
    );
    expect(result.success).toBe(true);
  });

  test("l0 > l1 fails: order l0=5000, l1=2000, l2=10000, l3=60000", () => {
    const result = VinyanConfigSchema.safeParse(
      configWithLatency({ l0: 5000, l1: 2000, l2: 10000, l3: 60000 }),
    );
    expect(result.success).toBe(false);
    if (!result.success) {
      const messages = result.error.issues.map((i) => i.message).join(" ");
      expect(messages).toContain("l0 < l1 < l2 < l3");
    }
  });

  test("l1 > l2 fails: order l0=100, l1=15000, l2=10000, l3=60000", () => {
    const result = VinyanConfigSchema.safeParse(
      configWithLatency({ l0: 100, l1: 15000, l2: 10000, l3: 60000 }),
    );
    expect(result.success).toBe(false);
  });

  test("l2 > l3 fails: order l0=100, l1=2000, l2=70000, l3=60000", () => {
    const result = VinyanConfigSchema.safeParse(
      configWithLatency({ l0: 100, l1: 2000, l2: 70000, l3: 60000 }),
    );
    expect(result.success).toBe(false);
  });

  test("equal adjacent values fail (not strictly ordered): l0=l1=2000", () => {
    const result = VinyanConfigSchema.safeParse(
      configWithLatency({ l0: 2000, l1: 2000, l2: 10000, l3: 60000 }),
    );
    expect(result.success).toBe(false);
  });
});
