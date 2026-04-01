/**
 * ECP ↔ A2A Translation Layer — bidirectional conversion between
 * OracleVerdict (internal ECP) and A2A data parts with ECP semantics.
 *
 * Follows the pattern of src/mcp/ecp-translation.ts but for A2A transport.
 *
 * Source of truth: Plan Phase C2
 */
import type { OracleVerdict, Evidence } from "../core/types.ts";
import { buildVerdict } from "../core/index.ts";
import {
  type ECPDataPart,
  type ECPMessageType,
  ECPDataPartSchema,
  ECP_MIME_TYPE,
} from "./ecp-data-part.ts";
import { clampFull, type PeerTrustLevel } from "../oracle/tier-clamp.ts";

/**
 * Convert an OracleVerdict to an ECP data part for A2A transmission.
 * The verdict is wrapped in ECP semantics with full epistemic metadata.
 */
export function verdictToECPDataPart(
  verdict: OracleVerdict,
  messageType: ECPMessageType = "respond",
  options: {
    conversationId?: string;
    instanceId?: string;
    publicKey?: string;
  } = {},
): ECPDataPart {
  return {
    ecp_version: 1,
    message_type: messageType,
    epistemic_type: verdict.type,
    confidence: verdict.confidence,
    confidence_reported: true,
    evidence: verdict.evidence,
    falsifiable_by: verdict.falsifiable_by?.[0],
    temporal_context: verdict.temporal_context
      ? {
          valid_from: verdict.temporal_context.valid_from,
          ttl_ms: verdict.temporal_context.valid_until - verdict.temporal_context.valid_from,
        }
      : undefined,
    conversation_id: options.conversationId,
    payload: {
      verified: verdict.verified,
      oracleName: verdict.oracleName,
      reason: verdict.reason,
      fileHashes: verdict.fileHashes,
      duration_ms: verdict.duration_ms,
      errorCode: verdict.errorCode,
    },
    signer: options.instanceId
      ? { instance_id: options.instanceId, public_key: options.publicKey ?? "" }
      : undefined,
  };
}

/**
 * Convert an ECP data part from A2A to an OracleVerdict.
 * Applies peer trust clamping — remote verdicts are always "uncertain" (A5).
 */
export function ecpDataPartToVerdict(
  dataPart: ECPDataPart,
  peerTrust: PeerTrustLevel = "untrusted",
): OracleVerdict {
  const payload = dataPart.payload as Record<string, unknown> | undefined;

  const rawConfidence = dataPart.confidence_reported
    ? dataPart.confidence
    : 0;

  // Apply canonical clamping: transport=a2a + peer trust
  const clampedConfidence = clampFull(rawConfidence, undefined, "a2a", peerTrust);

  const evidence: Evidence[] = (dataPart.evidence ?? []).map(e => ({
    file: e.file,
    line: e.line,
    snippet: e.snippet,
    contentHash: e.contentHash,
  }));

  return buildVerdict({
    verified: payload?.verified as boolean ?? false,
    type: "uncertain", // A5: remote sources never get 'known'
    confidence: clampedConfidence,
    confidence_reported: dataPart.confidence_reported,
    evidence,
    fileHashes: (payload?.fileHashes as Record<string, string>) ?? {},
    reason: payload?.reason as string | undefined,
    oracleName: payload?.oracleName as string | undefined,
    duration_ms: (payload?.duration_ms as number) ?? 0,
    errorCode: payload?.errorCode as OracleVerdict["errorCode"],
    origin: "a2a",
    falsifiable_by: dataPart.falsifiable_by ? [dataPart.falsifiable_by] : undefined,
    temporal_context: dataPart.temporal_context
      ? {
          valid_from: dataPart.temporal_context.valid_from,
          valid_until: dataPart.temporal_context.valid_from + dataPart.temporal_context.ttl_ms,
          decay_model: "none" as const,
        }
      : undefined,
  });
}

/**
 * Wrap an ECP data part into an A2A message part.
 */
export function wrapAsA2ADataPart(ecpDataPart: ECPDataPart): {
  type: "data";
  mimeType: string;
  data: Record<string, unknown>;
} {
  return {
    type: "data",
    mimeType: ECP_MIME_TYPE,
    data: ecpDataPart as unknown as Record<string, unknown>,
  };
}

/**
 * Extract and validate an ECP data part from an A2A message part.
 * Returns null if the part is not an ECP data part or fails validation.
 */
export function extractECPFromA2APart(part: {
  type?: string;
  mimeType?: string;
  data?: unknown;
}): ECPDataPart | null {
  if (part.type !== "data" || part.mimeType !== ECP_MIME_TYPE || !part.data) {
    return null;
  }
  const result = ECPDataPartSchema.safeParse(part.data);
  return result.success ? result.data : null;
}
