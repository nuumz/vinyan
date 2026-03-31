/**
 * ECP ↔ MCP translation layer — PH5.5 WP-4.
 *
 * Translates between Vinyan's internal OracleVerdict (ECP) and MCP tool results.
 * A5 (Tiered Trust): All external MCP results get type='uncertain' with
 * confidence capped by trust level.
 */
import type { OracleVerdict, Evidence } from "../core/types.ts";
import { buildVerdict } from "../core/index.ts";
import type { MCPToolResult } from "./types.ts";

/** Trust levels for external MCP sources — maps to confidence caps (A5). */
export type TrustLevel = "local" | "network" | "remote";

const TRUST_CONFIDENCE: Record<TrustLevel, number> = {
  local: 0.7,
  network: 0.5,
  remote: 0.3,
};

/**
 * Convert an OracleVerdict (ECP) to an MCP tool result.
 * - type='unknown' → { verified: null, reason: "insufficient evidence" }
 * - verified=true → success text
 * - verified=false → error text with reason
 */
export function ecpToMcp(verdict: OracleVerdict): MCPToolResult {
  if (verdict.type === "unknown") {
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({
            verified: null,
            reason: "insufficient evidence",
            oracleName: verdict.oracleName,
            duration_ms: verdict.duration_ms,
          }),
        },
      ],
      isError: false,
    };
  }

  const payload: Record<string, unknown> = {
    verified: verdict.verified,
    type: verdict.type,
    confidence: verdict.confidence,
    evidence: verdict.evidence,
    duration_ms: verdict.duration_ms,
  };

  if (verdict.oracleName) payload.oracleName = verdict.oracleName;
  if (verdict.reason) payload.reason = verdict.reason;
  if (verdict.fileHashes && Object.keys(verdict.fileHashes).length > 0) {
    payload.fileHashes = verdict.fileHashes;
  }

  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(payload),
      },
    ],
    isError: !verdict.verified,
  };
}

/**
 * Convert an MCP tool result to an OracleVerdict (ECP).
 * A5: All external MCP results get type='uncertain' with confidence
 * capped by trust level. No external source can claim 'known'.
 */
export function mcpToEcp(
  result: MCPToolResult,
  trustLevel: TrustLevel,
): OracleVerdict {
  const maxConfidence = TRUST_CONFIDENCE[trustLevel];

  // Error results → verified=false
  if (result.isError) {
    const errorText = result.content.map((c) => c.text).join("\n");
    return buildVerdict({
      verified: false,
      type: "uncertain",
      confidence: maxConfidence,
      evidence: [],
      fileHashes: {},
      reason: errorText,
      duration_ms: 0,
    });
  }

  // Try to parse structured content from the MCP result
  const textContent = result.content.map((c) => c.text).join("\n");
  let verified = true;
  let evidence: Evidence[] = [];
  let reason: string | undefined;
  let fileHashes: Record<string, string> = {};

  try {
    const parsed = JSON.parse(textContent);
    if (typeof parsed.verified === "boolean") {
      verified = parsed.verified;
    } else if (parsed.verified === null) {
      verified = false;
    }
    if (Array.isArray(parsed.evidence)) {
      evidence = parsed.evidence;
    }
    if (typeof parsed.reason === "string") {
      reason = parsed.reason;
    }
    if (parsed.fileHashes && typeof parsed.fileHashes === "object") {
      fileHashes = parsed.fileHashes;
    }
  } catch {
    // Unstructured text — treat as opaque success
  }

  return buildVerdict({
    verified,
    type: "uncertain", // A5: external sources never get 'known'
    confidence: maxConfidence,
    evidence,
    fileHashes,
    reason,
    duration_ms: 0,
  });
}
