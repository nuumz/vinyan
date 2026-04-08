/**
 * ECP Verdict Validation Middleware — K1.4 transport hardening.
 *
 * Validates inbound ECP verdict messages before they reach the Oracle Gate.
 * Enforces ecp_version and confidence fields; normalizes legacy messages.
 *
 * A5 compliance: unknown versions treated as lowest-tier (confidence 0.0).
 * Backward compatibility: missing fields are normalized, not rejected.
 */
import { z } from 'zod/v4';

export const SUPPORTED_ECP_VERSIONS = ['1.0', '2.0-draft'] as const;

/** Minimum required fields on every ECP verdict message. */
export const ECPVerdictEnvelopeSchema = z.object({
  ecp_version: z.enum(SUPPORTED_ECP_VERSIONS),
  confidence: z.number().min(0).max(1),
  // K1: optional — logged if missing, prepare for K2 mandatory enforcement
  evidence_chain: z.array(z.string()).optional(),
  falsifiable_by: z.array(z.string()).optional(),
});

export type ECPVerdictEnvelope = z.infer<typeof ECPVerdictEnvelopeSchema>;

/**
 * Validate an ECP verdict envelope against the schema.
 * Returns structured result — never throws.
 */
export function validateECPVerdict(raw: unknown): {
  valid: boolean;
  data?: ECPVerdictEnvelope;
  error?: string;
} {
  const result = ECPVerdictEnvelopeSchema.safeParse(raw);
  if (!result.success) {
    return { valid: false, error: result.error.message };
  }
  return { valid: true, data: result.data };
}

/**
 * Normalize a raw ECP message for backward compatibility.
 * Missing ecp_version → '1.0'; missing confidence → 0.0.
 */
export function normalizeECPMessage(raw: Record<string, unknown>): Record<string, unknown> {
  return {
    ecp_version: raw.ecp_version ?? '1.0',
    confidence: typeof raw.confidence === 'number' ? raw.confidence : 0.0,
    ...raw,
  };
}
