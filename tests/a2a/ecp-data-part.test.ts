/**
 * ECP Data Part + Translation tests — Phase C.
 */
import { describe, test, expect } from "bun:test";
import {
  ECPDataPartSchema,
  ECP_MIME_TYPE,
  isECPDataPart,
  parseECPDataPart,
} from "../../src/a2a/ecp-data-part.ts";
import {
  verdictToECPDataPart,
  ecpDataPartToVerdict,
  wrapAsA2ADataPart,
  extractECPFromA2APart,
} from "../../src/a2a/ecp-a2a-translation.ts";
import { buildVerdict } from "../../src/core/index.ts";
import { PEER_TRUST_CAPS } from "../../src/oracle/tier-clamp.ts";

// ── Schema Validation ──────────────────────────────────────────────────

describe("ECPDataPartSchema", () => {
  test("validates a complete ECP data part", () => {
    const part = {
      ecp_version: 1,
      message_type: "respond",
      epistemic_type: "known",
      confidence: 0.95,
      confidence_reported: true,
      evidence: [{ file: "test.ts", line: 1, snippet: "ok" }],
      payload: { verified: true },
    };
    const result = ECPDataPartSchema.safeParse(part);
    expect(result.success).toBe(true);
  });

  test("rejects invalid message_type", () => {
    const part = {
      ecp_version: 1,
      message_type: "invalid_type",
      epistemic_type: "known",
      confidence: 0.5,
      confidence_reported: true,
      payload: {},
    };
    const result = ECPDataPartSchema.safeParse(part);
    expect(result.success).toBe(false);
  });

  test("rejects ecp_version != 1", () => {
    const part = {
      ecp_version: 2,
      message_type: "respond",
      epistemic_type: "known",
      confidence: 0.5,
      confidence_reported: true,
      payload: {},
    };
    const result = ECPDataPartSchema.safeParse(part);
    expect(result.success).toBe(false);
  });

  test("validates all 22 message types", () => {
    const types = [
      "assert", "query", "respond", "request", "delegate", "cancel", "subscribe",
      "propose", "affirm", "commit", "retract",
      "knowledge_offer", "knowledge_accept", "knowledge_transfer",
      "feedback", "intent_declare", "intent_release",
      "capability_update", "trust_attestation", "heartbeat",
      "progress", "partial_verdict",
    ];
    for (const type of types) {
      const part = {
        ecp_version: 1,
        message_type: type,
        epistemic_type: "uncertain",
        confidence: 0.5,
        confidence_reported: true,
        payload: {},
      };
      const result = ECPDataPartSchema.safeParse(part);
      expect(result.success).toBe(true);
    }
  });

  test("confidence must be 0-1", () => {
    const base = {
      ecp_version: 1,
      message_type: "respond",
      epistemic_type: "known",
      confidence_reported: true,
      payload: {},
    };
    expect(ECPDataPartSchema.safeParse({ ...base, confidence: -0.1 }).success).toBe(false);
    expect(ECPDataPartSchema.safeParse({ ...base, confidence: 1.1 }).success).toBe(false);
    expect(ECPDataPartSchema.safeParse({ ...base, confidence: 0 }).success).toBe(true);
    expect(ECPDataPartSchema.safeParse({ ...base, confidence: 1 }).success).toBe(true);
  });
});

describe("isECPDataPart", () => {
  test("returns true for correct mimeType and data", () => {
    expect(isECPDataPart({ mimeType: ECP_MIME_TYPE, data: {} })).toBe(true);
  });

  test("returns false for wrong mimeType", () => {
    expect(isECPDataPart({ mimeType: "text/plain", data: {} })).toBe(false);
  });

  test("returns false for null data", () => {
    expect(isECPDataPart({ mimeType: ECP_MIME_TYPE, data: null })).toBe(false);
  });
});

// ── Translation Roundtrip ──────────────────────────────────────────────

describe("ECP ↔ A2A Translation", () => {
  const verdict = buildVerdict({
    verified: true,
    type: "known",
    confidence: 0.95,
    evidence: [{ file: "src/x.ts", line: 10, snippet: "export class X {}" }],
    fileHashes: { "src/x.ts": "sha256:abc" },
    oracleName: "ast-oracle",
    duration_ms: 42,
  });

  test("verdictToECPDataPart creates valid ECP data part", () => {
    const ecpPart = verdictToECPDataPart(verdict);
    const validation = ECPDataPartSchema.safeParse(ecpPart);
    expect(validation.success).toBe(true);
    expect(ecpPart.ecp_version).toBe(1);
    expect(ecpPart.message_type).toBe("respond");
    expect(ecpPart.epistemic_type).toBe("known");
    expect(ecpPart.confidence).toBe(0.95);
    expect(ecpPart.confidence_reported).toBe(true);
    expect(ecpPart.evidence).toHaveLength(1);
  });

  test("ecpDataPartToVerdict applies peer trust clamping", () => {
    const ecpPart = verdictToECPDataPart(verdict);

    const untrusted = ecpDataPartToVerdict(ecpPart, "untrusted");
    expect(untrusted.confidence).toBe(PEER_TRUST_CAPS.untrusted);
    expect(untrusted.type).toBe("uncertain");
    expect(untrusted.origin).toBe("a2a");

    const trusted = ecpDataPartToVerdict(ecpPart, "trusted");
    expect(trusted.confidence).toBe(PEER_TRUST_CAPS.trusted);
  });

  test("roundtrip preserves verified state and evidence", () => {
    const ecpPart = verdictToECPDataPart(verdict);
    const roundtripped = ecpDataPartToVerdict(ecpPart, "trusted");

    expect(roundtripped.verified).toBe(verdict.verified);
    expect(roundtripped.evidence).toHaveLength(1);
    expect(roundtripped.evidence[0]!.file).toBe("src/x.ts");
    expect(roundtripped.oracleName).toBe("ast-oracle");
    // Type degrades to 'uncertain' through A2A boundary (A5)
    expect(roundtripped.type).toBe("uncertain");
  });

  test("confidence_reported=false yields zero confidence", () => {
    const ecpPart = verdictToECPDataPart(verdict);
    ecpPart.confidence_reported = false;
    ecpPart.confidence = 0.9;

    const result = ecpDataPartToVerdict(ecpPart, "trusted");
    expect(result.confidence).toBe(0);
  });

  test("wrapAsA2ADataPart produces correct structure", () => {
    const ecpPart = verdictToECPDataPart(verdict);
    const a2aPart = wrapAsA2ADataPart(ecpPart);

    expect(a2aPart.type).toBe("data");
    expect(a2aPart.mimeType).toBe(ECP_MIME_TYPE);
    expect(a2aPart.data).toBeDefined();
  });

  test("extractECPFromA2APart round-trips with wrapAsA2ADataPart", () => {
    const ecpPart = verdictToECPDataPart(verdict);
    const a2aPart = wrapAsA2ADataPart(ecpPart);
    const extracted = extractECPFromA2APart(a2aPart);

    expect(extracted).not.toBeNull();
    expect(extracted!.ecp_version).toBe(1);
    expect(extracted!.message_type).toBe("respond");
    expect(extracted!.confidence).toBe(0.95);
  });

  test("extractECPFromA2APart returns null for non-ECP parts", () => {
    expect(extractECPFromA2APart({ type: "text", data: {} })).toBeNull();
    expect(extractECPFromA2APart({ type: "data", mimeType: "text/plain", data: {} })).toBeNull();
    expect(extractECPFromA2APart({ type: "data", mimeType: ECP_MIME_TYPE })).toBeNull();
  });
});
