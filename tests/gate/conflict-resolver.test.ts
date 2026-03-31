/**
 * Conflict Resolver tests — verifies the 5-step deterministic contradiction
 * resolution algorithm (concept §3.2, A5 Tiered Trust).
 */
import { describe, test, expect } from "bun:test";
import { resolveConflicts, type ResolverConfig } from "../../src/gate/conflict-resolver.ts";
import type { OracleVerdict } from "../../src/core/types.ts";
import { buildVerdict } from "../../src/core/index.ts";

// ── Helpers ─────────────────────────────────────────────────────

function makeVerdict(overrides: Partial<OracleVerdict> = {}): OracleVerdict {
  return buildVerdict({
    verified: true,
    type: "known",
    confidence: 1.0,
    evidence: [],
    fileHashes: {},
    duration_ms: 10,
    ...overrides,
  });
}

const DEFAULT_CONFIG: ResolverConfig = {
  oracleTiers: {
    ast: "deterministic",
    type: "deterministic",
    dep: "heuristic",
    test: "deterministic",
    lint: "deterministic",
  },
  informationalOracles: new Set(["dep"]),
};

// ── No conflict cases ───────────────────────────────────────────

describe("resolveConflicts — no conflict", () => {
  test("all oracles pass → allow", () => {
    const result = resolveConflicts(
      {
        ast: makeVerdict({ verified: true }),
        type: makeVerdict({ verified: true }),
      },
      DEFAULT_CONFIG,
    );
    expect(result.decision).toBe("allow");
    expect(result.reasons).toHaveLength(0);
    expect(result.resolutions).toHaveLength(0);
  });

  test("all oracles fail → block with all reasons", () => {
    const result = resolveConflicts(
      {
        ast: makeVerdict({ verified: false, reason: "symbol not found" }),
        type: makeVerdict({ verified: false, reason: "type error" }),
      },
      DEFAULT_CONFIG,
    );
    expect(result.decision).toBe("block");
    expect(result.reasons).toHaveLength(2);
    expect(result.reasons[0]).toContain("ast");
    expect(result.reasons[1]).toContain("type");
  });

  test("no oracle results → allow", () => {
    const result = resolveConflicts({}, DEFAULT_CONFIG);
    expect(result.decision).toBe("allow");
  });

  test("only informational oracle fails → allow", () => {
    const result = resolveConflicts(
      {
        dep: makeVerdict({ verified: false, reason: "high blast radius" }),
      },
      DEFAULT_CONFIG,
    );
    expect(result.decision).toBe("allow");
    expect(result.reasons).toHaveLength(0);
  });
});

// ── Step 1: Domain separation ───────────────────────────────────

describe("resolveConflicts — Step 1: domain separation", () => {
  test("cross-domain conflict: structural pass + quality fail → both valid → block", () => {
    const result = resolveConflicts(
      {
        type: makeVerdict({ verified: true }),
        lint: makeVerdict({ verified: false, reason: "lint error" }),
      },
      DEFAULT_CONFIG,
    );
    // lint (quality) failure stands because it's a different domain than type (structural)
    expect(result.decision).toBe("block");
    expect(result.reasons).toContain('Oracle "lint" rejected: lint error');
    expect(result.resolutions).toHaveLength(1);
    expect(result.resolutions[0]!.resolvedAtStep).toBe(1);
    expect(result.resolutions[0]!.winner).toBe("lint"); // cross-domain: fail stands
  });

  test("cross-domain conflict: functional fail + structural pass → both valid → block", () => {
    const result = resolveConflicts(
      {
        ast: makeVerdict({ verified: true }),
        test: makeVerdict({ verified: false, reason: "test failed" }),
      },
      DEFAULT_CONFIG,
    );
    expect(result.decision).toBe("block");
    expect(result.resolutions[0]!.resolvedAtStep).toBe(1);
  });
});

// ── Step 2: Confidence/tier comparison ──────────────────────────

describe("resolveConflicts — Step 2: tier comparison", () => {
  test("same-domain: deterministic pass overrides heuristic fail → allow", () => {
    const config: ResolverConfig = {
      oracleTiers: {
        ast: "deterministic",
        type: "heuristic",
      },
      informationalOracles: new Set(),
    };
    const result = resolveConflicts(
      {
        ast: makeVerdict({ verified: true }),
        type: makeVerdict({ verified: false, reason: "heuristic type issue" }),
      },
      config,
    );
    expect(result.decision).toBe("allow");
    expect(result.resolutions).toHaveLength(1);
    expect(result.resolutions[0]!.resolvedAtStep).toBe(2);
    expect(result.resolutions[0]!.winner).toBe("ast");
    expect(result.resolutions[0]!.loser).toBe("type");
  });

  test("same-domain: heuristic pass does NOT override deterministic fail → block", () => {
    const config: ResolverConfig = {
      oracleTiers: {
        ast: "heuristic",
        type: "deterministic",
      },
      informationalOracles: new Set(),
    };
    const result = resolveConflicts(
      {
        ast: makeVerdict({ verified: true }),
        type: makeVerdict({ verified: false, reason: "deterministic type error" }),
      },
      config,
    );
    expect(result.decision).toBe("block");
    expect(result.resolutions[0]!.resolvedAtStep).toBe(2);
    expect(result.resolutions[0]!.winner).toBe("type");
  });
});

// ── Step 3: Evidence weight ─────────────────────────────────────

describe("resolveConflicts — Step 3: evidence weight", () => {
  test("same domain/tier: more evidence wins → allow when passer has more", () => {
    const result = resolveConflicts(
      {
        ast: makeVerdict({
          verified: true,
          evidence: [
            { file: "a.ts", snippet: "ok", line: 1 },
            { file: "b.ts", snippet: "ok", line: 2 },
            { file: "c.ts", snippet: "ok", line: 3 },
          ],
        }),
        type: makeVerdict({
          verified: false,
          reason: "weak rejection",
          evidence: [{ file: "a.ts", snippet: "err", line: 1 }],
        }),
      },
      {
        oracleTiers: { ast: "deterministic", type: "deterministic" },
        informationalOracles: new Set(),
      },
    );
    expect(result.decision).toBe("allow");
    expect(result.resolutions[0]!.resolvedAtStep).toBe(3);
    expect(result.resolutions[0]!.winner).toBe("ast");
  });

  test("same domain/tier: more evidence wins → block when failer has more", () => {
    const result = resolveConflicts(
      {
        ast: makeVerdict({ verified: true, evidence: [] }),
        type: makeVerdict({
          verified: false,
          reason: "strong rejection",
          evidence: [
            { file: "a.ts", snippet: "err", line: 1 },
            { file: "b.ts", snippet: "err", line: 2 },
          ],
        }),
      },
      {
        oracleTiers: { ast: "deterministic", type: "deterministic" },
        informationalOracles: new Set(),
      },
    );
    expect(result.decision).toBe("block");
    expect(result.resolutions[0]!.resolvedAtStep).toBe(3);
    expect(result.resolutions[0]!.winner).toBe("type");
  });
});

// ── Step 4: Historical accuracy ─────────────────────────────────

describe("resolveConflicts — Step 4: historical accuracy", () => {
  test("same domain/tier/evidence: higher accuracy oracle wins", () => {
    const result = resolveConflicts(
      {
        ast: makeVerdict({ verified: true, evidence: [] }),
        type: makeVerdict({ verified: false, reason: "rejection", evidence: [] }),
      },
      {
        oracleTiers: { ast: "deterministic", type: "deterministic" },
        informationalOracles: new Set(),
        oracleAccuracy: {
          ast: { total: 100, correct: 95 },   // 95% accuracy
          type: { total: 100, correct: 80 },   // 80% accuracy
        },
      },
    );
    expect(result.decision).toBe("allow");
    expect(result.resolutions[0]!.resolvedAtStep).toBe(4);
    expect(result.resolutions[0]!.winner).toBe("ast");
  });

  test("higher accuracy for failer → block", () => {
    const result = resolveConflicts(
      {
        ast: makeVerdict({ verified: true, evidence: [] }),
        type: makeVerdict({ verified: false, reason: "rejection", evidence: [] }),
      },
      {
        oracleTiers: { ast: "deterministic", type: "deterministic" },
        informationalOracles: new Set(),
        oracleAccuracy: {
          ast: { total: 100, correct: 75 },
          type: { total: 100, correct: 95 },
        },
      },
    );
    expect(result.decision).toBe("block");
    expect(result.resolutions[0]!.resolvedAtStep).toBe(4);
    expect(result.resolutions[0]!.winner).toBe("type");
  });
});

// ── Step 5: Escalation ──────────────────────────────────────────

describe("resolveConflicts — Step 5: escalation", () => {
  test("all steps tied → contradictory escalation → block", () => {
    const result = resolveConflicts(
      {
        ast: makeVerdict({ verified: true, evidence: [] }),
        type: makeVerdict({ verified: false, reason: "rejection", evidence: [] }),
      },
      {
        oracleTiers: { ast: "deterministic", type: "deterministic" },
        informationalOracles: new Set(),
        // No accuracy data → step 4 skipped
      },
    );
    expect(result.decision).toBe("block");
    expect(result.hasContradiction).toBe(true);
    expect(result.resolutions[0]!.resolvedAtStep).toBe(5);
    expect(result.reasons).toContain("Unresolved oracle contradiction — escalated to contradictory state");
  });
});

// ── Multi-oracle conflicts ──────────────────────────────────────

describe("resolveConflicts — multi-oracle", () => {
  test("2 pass + 1 fail (same domain, lower tier) → allow", () => {
    const result = resolveConflicts(
      {
        ast: makeVerdict({ verified: true }),
        type: makeVerdict({ verified: true }),
        lint: makeVerdict({ verified: false, reason: "lint issue" }),
      },
      {
        oracleTiers: { ast: "deterministic", type: "deterministic", lint: "deterministic" },
        informationalOracles: new Set(),
      },
    );
    // lint is quality domain, ast/type are structural → step 1: cross-domain, lint stands
    expect(result.decision).toBe("block");
  });

  test("structural pass + structural fail (deterministic vs heuristic) → allow", () => {
    const result = resolveConflicts(
      {
        ast: makeVerdict({ verified: true }),
        type: makeVerdict({ verified: false, reason: "heuristic type check" }),
      },
      {
        oracleTiers: { ast: "deterministic", type: "heuristic" },
        informationalOracles: new Set(),
      },
    );
    expect(result.decision).toBe("allow");
    expect(result.resolutions[0]!.resolvedAtStep).toBe(2);
  });

  test("multiple conflicts each resolved at different steps", () => {
    const result = resolveConflicts(
      {
        ast: makeVerdict({ verified: true }),
        type: makeVerdict({ verified: false, reason: "type error" }),
        lint: makeVerdict({ verified: false, reason: "lint error" }),
      },
      {
        oracleTiers: { ast: "deterministic", type: "heuristic", lint: "deterministic" },
        informationalOracles: new Set(),
      },
    );
    // ast vs type: same domain (structural), ast=deterministic > type=heuristic → step 2, ast wins
    // ast vs lint: cross-domain (structural vs quality) → step 1, lint stands
    expect(result.resolutions).toHaveLength(2);
    // type overridden by ast, lint stands
    expect(result.decision).toBe("block");
    expect(result.reasons.some((r) => r.includes("lint"))).toBe(true);
    expect(result.reasons.some((r) => r.includes("type"))).toBe(false);
  });
});
