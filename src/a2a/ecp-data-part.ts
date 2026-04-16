/**
 * ECP-over-A2A Data Part — Zod schema for ECP semantics inside A2A data parts.
 *
 * All Vinyan-to-Vinyan communication uses this schema inside A2A `data` parts
 * with `mimeType: "application/vnd.vinyan.ecp+json"`.
 *
 * Mandatory for Vinyan peers (validated via Zod), optional for external agents.
 * `confidence_reported: boolean` distinguishes absent vs zero confidence (A2).
 *
 * Source of truth: Plan Phase C1
 */
import { z } from 'zod/v4';

// ── Sub-schemas ────────────────────────────────────────────────────────

export const EvidencePartSchema = z.object({
  file: z.string(),
  line: z.number(),
  snippet: z.string(),
  content_hash: z.string().optional(),
});

export const TraceContextSchema = z.object({
  trace_id: z.string(),
  span_id: z.string(),
  parent_span_id: z.string().optional(),
  trace_flags: z.number().default(0),
  vinyan_correlation_id: z.string().optional(),
  vinyan_confidence_at_entry: z.number().optional(),
  vinyan_routing_level: z.number().optional(),
  vinyan_instance_chain: z.array(z.string()).optional(),
});

export const CostSignalSchema = z.object({
  tokens_input: z.number(),
  tokens_output: z.number(),
  duration_ms: z.number(),
  oracle_invocations: z.number(),
  estimated_usd: z.number().optional(),
  budget_utilization_pct: z.number().optional(),
});

export const TemporalContextSchema = z.object({
  valid_from: z.number(),
  ttl_ms: z.number(),
});

export const SignerSchema = z.object({
  instance_id: z.string(),
  public_key: z.string(),
});

// ── Message Types ──────────────────────────────────────────────────────

export const ECPMessageTypeSchema = z.enum([
  // Existing primitives (7)
  'assert',
  'query',
  'respond',
  'request',
  'delegate',
  'cancel',
  'subscribe',
  // New primitives (4) — Phase G
  'propose',
  'affirm',
  'commit',
  'retract',
  // Knowledge sharing — Phase E
  'knowledge_offer',
  'knowledge_accept',
  'knowledge_transfer',
  // Coordination — Phase G4, H
  'feedback',
  'intent_declare',
  'intent_release',
  // Meta — Phase J, D4, L1
  'capability_update',
  'trust_attestation',
  'heartbeat',
  // Streaming — Phase F
  'progress',
  'partial_verdict',
  // Cross-instance rooms — Phase R3
  'room_update',
]);

export type ECPMessageType = z.infer<typeof ECPMessageTypeSchema>;

// ── Epistemic Types ────────────────────────────────────────────────────

export const EpistemicTypeSchema = z.enum(['known', 'unknown', 'uncertain', 'contradictory']);
export type EpistemicType = z.infer<typeof EpistemicTypeSchema>;

// ── ECP Data Part (main schema) ────────────────────────────────────────

export const ECPDataPartSchema = z.object({
  ecp_version: z.literal(1).default(1),
  message_type: ECPMessageTypeSchema,
  epistemic_type: EpistemicTypeSchema,
  confidence: z.number().min(0).max(1),
  /** Optional SL opinion — must be consistent with confidence scalar */
  opinion: z
    .object({
      belief: z.number().min(0).max(1),
      disbelief: z.number().min(0).max(1),
      uncertainty: z.number().min(0).max(1),
      baseRate: z.number().min(0).max(1),
    })
    .refine((o) => Math.abs(o.belief + o.disbelief + o.uncertainty - 1) < 0.001, {
      message: 'belief + disbelief + uncertainty must sum to 1',
    })
    .optional(),
  confidence_reported: z.boolean(),
  evidence: z.array(EvidencePartSchema).optional(),
  falsifiable_by: z.string().optional(),
  temporal_context: TemporalContextSchema.optional(),
  conversation_id: z.string().optional(),
  /** R3: when present, scopes this message to a named room. Messages without
   *  room_id are broadcast to all peers (backward compatible). */
  room_id: z.string().optional(),
  trace_context: TraceContextSchema.optional(),
  cost: CostSignalSchema.optional(),
  payload: z.unknown(),
  signer: SignerSchema.optional(),
  signature: z.string().optional(),

  // ── ECP wire-format additions (all optional for backward compat) ──
  tier_reliability: z.number().min(0).max(1).optional(),
  engine_certainty: z.number().min(0).max(1).optional(),
  confidence_source: z.enum(['evidence-derived', 'self-model-calibrated', 'llm-self-report']).optional(),
});

export type ECPDataPart = z.infer<typeof ECPDataPartSchema>;

/** MIME type for ECP data parts inside A2A messages. */
export const ECP_MIME_TYPE = 'application/vnd.vinyan.ecp+json';

// ── Helpers ────────────────────────────────────────────────────────────

/** Check if an A2A data part contains ECP semantics. */
export function isECPDataPart(part: { mimeType?: string; data?: unknown }): boolean {
  return part.mimeType === ECP_MIME_TYPE && part.data != null;
}

/** Parse and validate an ECP data part. Returns null on validation failure. */
export function parseECPDataPart(data: unknown): ECPDataPart | null {
  const result = ECPDataPartSchema.safeParse(data);
  return result.success ? result.data : null;
}
