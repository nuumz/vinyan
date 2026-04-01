/**
 * A2A Confidence Injector Tests — I13 + A5 compliance.
 * Uses canonical clampFull() pipeline: tier × transport × peer trust.
 */
import { describe, test, expect } from "bun:test";
import {
  injectA2AConfidence,
  createA2AVerdict,
} from "../../src/a2a/confidence-injector.ts";
import { PEER_TRUST_CAPS } from "../../src/oracle/tier-clamp.ts";
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
  test("untrusted peer: high confidence capped to 0.25", () => {
    const verdict = makeVerdict({ confidence: 0.9 });
    const result = injectA2AConfidence(verdict);
    expect(result.confidence).toBe(PEER_TRUST_CAPS.untrusted);
    expect(result.confidence).toBe(0.25);
  });

  test("trusted peer: high confidence capped to 0.60", () => {
    const verdict = makeVerdict({ confidence: 0.9 });
    const result = injectA2AConfidence(verdict, undefined, "trusted");
    expect(result.confidence).toBe(PEER_TRUST_CAPS.trusted);
  });

  test("provisional peer: confidence capped to 0.40", () => {
    const verdict = makeVerdict({ confidence: 0.8 });
    const result = injectA2AConfidence(verdict, undefined, "provisional");
    expect(result.confidence).toBe(PEER_TRUST_CAPS.provisional);
  });

  test("established peer: confidence capped to 0.50", () => {
    const verdict = makeVerdict({ confidence: 0.8 });
    const result = injectA2AConfidence(verdict, undefined, "established");
    expect(result.confidence).toBe(PEER_TRUST_CAPS.established);
  });

  test("low confidence stays when below cap", () => {
    const verdict = makeVerdict({ confidence: 0.1 });
    const result = injectA2AConfidence(verdict, undefined, "trusted");
    expect(result.confidence).toBe(0.1);
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

  test("tier + transport + peer trust all apply (most restrictive wins)", () => {
    const verdict = makeVerdict({ confidence: 0.9 });
    // speculative=0.4, a2a=0.7, untrusted=0.25 → min is 0.25
    const result = injectA2AConfidence(verdict, "speculative", "untrusted");
    expect(result.confidence).toBe(0.25);
  });
});

describe("createA2AVerdict", () => {
  test("success verdict has correct structure (untrusted default)", () => {
    const verdict = createA2AVerdict(true, "Tests passed");
    expect(verdict.verified).toBe(true);
    expect(verdict.type).toBe("uncertain");
    expect(verdict.confidence).toBe(PEER_TRUST_CAPS.untrusted);
    expect(verdict.reason).toBe("Tests passed");
    expect(verdict.evidence).toEqual([]);
    expect(verdict.fileHashes).toEqual({});
  });

  test("failure verdict has correct structure", () => {
    const verdict = createA2AVerdict(false, "Type errors found");
    expect(verdict.verified).toBe(false);
    expect(verdict.type).toBe("uncertain");
    expect(verdict.confidence).toBe(PEER_TRUST_CAPS.untrusted);
    expect(verdict.reason).toBe("Type errors found");
  });

  test("trusted peer gets higher cap", () => {
    const verdict = createA2AVerdict(true, "ok", "trusted");
    expect(verdict.confidence).toBe(PEER_TRUST_CAPS.trusted);
  });

  test("confidence never exceeds peer trust cap", () => {
    for (const level of ["untrusted", "provisional", "established", "trusted"] as const) {
      const verdict = createA2AVerdict(true, "ok", level);
      expect(verdict.confidence).toBeLessThanOrEqual(PEER_TRUST_CAPS[level]);
    }
  });
});
