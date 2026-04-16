import { z } from 'zod/v4';
import { SubjectiveOpinionSchema as _SOS } from '../core/subjective-opinion.ts';

// Re-export SubjectiveOpinionSchema for protocol consumers
export { SubjectiveOpinionSchema } from '../core/subjective-opinion.ts';

/** Zod schema for validating oracle input (HypothesisTuple). */
export const HypothesisTupleSchema = z.object({
  target: z.string(),
  pattern: z.string(),
  context: z.record(z.string(), z.unknown()).optional(),
  workspace: z.string(),
});

/** Evidence item schema. */
export const EvidenceSchema = z.object({
  file: z.string(),
  line: z.number(),
  snippet: z.string(),
  contentHash: z.string().optional(),
});

/** QualityScore schema — Phase 0 computes architecturalCompliance + efficiency only. */
export const QualityScoreSchema = z.object({
  architecturalCompliance: z.number(),
  efficiency: z.number(),
  simplificationGain: z.number().optional(),
  testMutationScore: z.number().optional(),
  composite: z.number(),
  dimensionsAvailable: z.number().default(2),
  phase: z.enum(['basic', 'extended', 'full']).default('basic'),
});

/** Oracle error codes for programmatic handling. */
export const OracleErrorCodeSchema = z.enum([
  'TIMEOUT',
  'PARSE_ERROR',
  'TYPE_MISMATCH',
  'SYMBOL_NOT_FOUND',
  'ORACLE_CRASH',
  'GUARDRAIL_BLOCKED',
]);

/** Zod schema for validating oracle output (OracleVerdict). */
/** Deliberation request schema — Phase 1+ ECP extension. */
const DeliberationRequestSchema = z.object({
  reason: z.string(),
  suggestedBudget: z.number(),
});

/** Temporal context schema — Phase 1+ ECP extension. */
const TemporalContextSchema = z.object({
  validFrom: z.number(),
  validUntil: z.number(),
  decayModel: z.enum(['linear', 'step', 'none', 'exponential']),
  halfLife: z.number().optional(),
});

/** Zod schema for validating oracle output (OracleVerdict). */
export const OracleVerdictSchema = z.object({
  verified: z.boolean(),
  type: z.enum(['known', 'unknown', 'uncertain', 'contradictory']).default('known'),
  confidence: z.number().min(0).max(1).default(0.5),
  evidence: z.array(EvidenceSchema),
  falsifiableBy: z.array(z.string()).optional(),
  fileHashes: z.record(z.string(), z.string()),
  reason: z.string().optional(),
  errorCode: OracleErrorCodeSchema.optional(),
  oracleName: z.string().optional(),
  durationMs: z.number(),
  qualityScore: QualityScoreSchema.optional(),
  deliberationRequest: DeliberationRequestSchema.optional(),
  temporalContext: TemporalContextSchema.optional(),

  // ── SL + tier metadata (all optional for backward compat) ──
  opinion: _SOS.optional(),
  tierReliability: z.number().min(0).max(1).optional(),
  engineCertainty: z.number().min(0).max(1).optional(),
  confidenceSource: z.enum(['evidence-derived', 'self-model-calibrated', 'llm-self-report']).optional(),
  confidenceReported: z.boolean().optional(),
});
