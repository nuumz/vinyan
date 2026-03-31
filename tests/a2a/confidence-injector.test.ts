/**
 * A2A Confidence Injector Tests — I13 + A5 compliance.
 */
import { describe, test, expect } from "bun:test";
import {
  injectA2AConfidence,
  createA2AVerdict,
  A2A_CONFIDENCE_CAP,
} from "../../src/a2a/confidence-injector.ts";
import type { OracleVerdict } from "../../src/core/types.ts";

function makeVerdict(overrides: Partial<OracleVerdict> = {}): OracleVerdict {
  return {
    verified: true,
    type: "known",
    confidence: 1.0,
    evidence: [{ file: "test.ts", line: 1, snippet: "ok" }],
    fileHashes: { "test.ts": "abc123" },
    duration_ms: 100,
    ...overrides,
  };
}

describe("injectA2AConfidence", () => {
  test("high confidence (0.9) gets capped to 0.5", () => {
    const verdict = makeVerdict({ confidence: 0.9 });
    const result = injectA2AConfidence(verdict);
    expect(result.confidence).toBe(A2A_CONFIDENCE_CAP);
    expect(result.confidence).toBe(0.5);
  });

  test("low confidence (0.3) stays at 0.3", () => {
    const verdict = makeVerdict({ confidence: 0.3 });
    const result = injectA2AConfidence(verdict);
    expect(result.confidence).toBe(0.3);
  });

  test("confidence exactly at 0.5 stays at 0.5", () => {
    const verdict = makeVerdict({ confidence: 0.5 });
    const result = injectA2AConfidence(verdict);
    expect(result.confidence).toBe(0.5);
  });

  test("type always becomes 'uncertain' (A5 lowest trust tier)", () => {
    const known = injectA2AConfidence(makeVerdict({ type: "known" }));
    expect(known.type).toBe("uncertain");

    const contradictory = injectA2AConfidence(makeVerdict({ type: "contradictory" }));
    expect(contradictory.type).toBe("uncertain");
  });

  test("evidence chain is preserved", () => {
    const evidence = [
      { file: "a.ts", line: 10, snippet: "import x" },
      { file: "b.ts", line: 20, snippet: "export y" },
    ];
    const verdict = makeVerdict({ evidence });
    const result = injectA2AConfidence(verdict);
    expect(result.evidence).toEqual(evidence);
    expect(result.evidence).toHaveLength(2);
  });

  test("fileHashes preserved", () => {
    const hashes = { "a.ts": "hash1", "b.ts": "hash2" };
    const verdict = makeVerdict({ fileHashes: hashes });
    const result = injectA2AConfidence(verdict);
    expect(result.fileHashes).toEqual(hashes);
  });

  test("verified field preserved", () => {
    const failing = injectA2AConfidence(makeVerdict({ verified: false }));
    expect(failing.verified).toBe(false);

    const passing = injectA2AConfidence(makeVerdict({ verified: true }));
    expect(passing.verified).toBe(true);
  });

  test("reason field preserved", () => {
    const verdict = makeVerdict({ reason: "test failure detected" });
    const result = injectA2AConfidence(verdict);
    expect(result.reason).toBe("test failure detected");
  });
});

describe("createA2AVerdict", () => {
  test("success verdict has correct structure", () => {
    const verdict = createA2AVerdict(true, "Tests passed");
    expect(verdict.verified).toBe(true);
    expect(verdict.type).toBe("uncertain");
    expect(verdict.confidence).toBe(A2A_CONFIDENCE_CAP);
    expect(verdict.reason).toBe("Tests passed");
    expect(verdict.evidence).toEqual([]);
    expect(verdict.fileHashes).toEqual({});
  });

  test("failure verdict has correct structure", () => {
    const verdict = createA2AVerdict(false, "Type errors found");
    expect(verdict.verified).toBe(false);
    expect(verdict.type).toBe("uncertain");
    expect(verdict.confidence).toBe(A2A_CONFIDENCE_CAP);
    expect(verdict.reason).toBe("Type errors found");
  });

  test("confidence is always capped at 0.5", () => {
    const verdict = createA2AVerdict(true, "ok");
    expect(verdict.confidence).toBeLessThanOrEqual(0.5);
  });
});
