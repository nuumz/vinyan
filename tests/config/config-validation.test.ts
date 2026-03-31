import { describe, test, expect } from "bun:test";
import { VinyanConfigSchema } from "../../src/config/schema.ts";

// Minimal valid routing config (defaults: 0.2 < 0.4 < 0.7)
const VALID_ROUTING = {
  l0_max_risk: 0.2,
  l1_max_risk: 0.4,
  l2_max_risk: 0.7,
};

describe("VinyanConfigSchema — routing threshold ordering", () => {
  test("default config passes validation (0.2 < 0.4 < 0.7)", () => {
    const result = VinyanConfigSchema.safeParse({
      phase1: {
        routing: VALID_ROUTING,
      },
    });
    expect(result.success).toBe(true);
  });

  test("l0_max_risk > l1_max_risk fails validation", () => {
    const result = VinyanConfigSchema.safeParse({
      phase1: {
        routing: {
          l0_max_risk: 0.5,
          l1_max_risk: 0.3,
          l2_max_risk: 0.7,
        },
      },
    });
    expect(result.success).toBe(false);
  });

  test("reversed ordering (l0 > l1 > l2) fails validation", () => {
    const result = VinyanConfigSchema.safeParse({
      phase1: {
        routing: {
          l0_max_risk: 0.9,
          l1_max_risk: 0.6,
          l2_max_risk: 0.3,
        },
      },
    });
    expect(result.success).toBe(false);
  });

  test("equal values fail validation (not strictly ordered)", () => {
    // l0 === l1 violates strict ordering
    const result1 = VinyanConfigSchema.safeParse({
      phase1: {
        routing: {
          l0_max_risk: 0.3,
          l1_max_risk: 0.3,
          l2_max_risk: 0.7,
        },
      },
    });
    expect(result1.success).toBe(false);

    // l1 === l2 violates strict ordering
    const result2 = VinyanConfigSchema.safeParse({
      phase1: {
        routing: {
          l0_max_risk: 0.2,
          l1_max_risk: 0.5,
          l2_max_risk: 0.5,
        },
      },
    });
    expect(result2.success).toBe(false);
  });

  test("l1_max_risk > l2_max_risk fails validation", () => {
    const result = VinyanConfigSchema.safeParse({
      phase1: {
        routing: {
          l0_max_risk: 0.2,
          l1_max_risk: 0.8,
          l2_max_risk: 0.6,
        },
      },
    });
    expect(result.success).toBe(false);
  });

  test("config without phase1 (phase 0 only) passes validation", () => {
    const result = VinyanConfigSchema.safeParse({
      version: 1,
      oracles: {},
    });
    expect(result.success).toBe(true);
  });

  test("valid non-default routing thresholds pass validation", () => {
    const result = VinyanConfigSchema.safeParse({
      phase1: {
        routing: {
          l0_max_risk: 0.1,
          l1_max_risk: 0.5,
          l2_max_risk: 0.9,
        },
      },
    });
    expect(result.success).toBe(true);
  });
});
