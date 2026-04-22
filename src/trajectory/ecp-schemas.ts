/**
 * Trajectory Exporter — Zod schemas for the ECP-enriched format (Decision 23).
 *
 * ShareGPT schemas live in `schemas.ts`; this file is intentionally separate
 * so the baseline exporter cannot accidentally pull in ECP-only fields.
 *
 * Invariants:
 *   - Redaction runs BEFORE the artifact hash. Manifest `sha256` is over
 *     the gzipped JSONL artifact after redaction; tampering mutates it.
 *     (A4 Content-Addressed Truth.)
 *   - Per-turn Brier/CRPS + OracleVerdict + evidence_chain are the training
 *     signal no other framework can produce. (A7 Prediction Error = learning.)
 */

import { z } from 'zod';
import { CONFIDENCE_TIERS } from '../core/confidence-tier.ts';

/**
 * One entry in the evidence chain. Kept shallow — `kind` names the evidence
 * type ('file-hash', 'test-output', 'ast-match'), `hash` is the content hash
 * binding the evidence to the file/output that produced it.
 */
export const EcpEvidenceChainEntrySchema = z.object({
  kind: z.string(),
  hash: z.string(),
  elapsed_ms: z.number().int().nonnegative().optional(),
});

/**
 * Per-turn oracle verdict summary. `status` is the ECP-enriched status
 * taxonomy — the narrow projection of OracleVerdict.type that downstream
 * learners actually care about.
 */
export const EcpOracleVerdictSchema = z.object({
  oracle: z.string(),
  status: z.enum(['verified', 'falsified', 'uncertain', 'unknown', 'contradictory']),
  confidence: z.number().min(0).max(1),
  evidence_chain: z.array(EcpEvidenceChainEntrySchema),
});

/**
 * Per-turn hypothesis — what the generator was asserting at this step.
 * Optional; present only for turns that produced a testable claim.
 */
export const EcpHypothesisSchema = z.object({
  id: z.string(),
  claim: z.string(),
  falsifiable: z.boolean(),
});

/**
 * Per-turn prediction error — the unique training signal. All fields are
 * optional because not every turn registers a numeric prediction (a system
 * turn or a tool_result turn typically does not).
 */
export const EcpPredictionErrorSchema = z.object({
  brier: z.number().optional(),
  crps_blast: z.number().optional(),
  crps_quality: z.number().optional(),
  surprise_bits: z.number().optional(),
  basis: z.enum(['calibrated', 'uncalibrated']),
});

/**
 * Confidence source for a turn. Either one of the 4-tier vocabulary entries
 * or 'unknown' (A2: explicitly surface unresolved epistemic state).
 */
export const EcpConfidenceSourceSchema = z.enum([...CONFIDENCE_TIERS, 'unknown'] as [string, ...string[]]);

/**
 * One turn in the enriched trajectory. Mirrors ShareGPT turn shape but with
 * epistemic metadata. `content` is always a string — content blocks are
 * flattened like the ShareGPT exporter already does.
 */
export const EcpEnrichedTurnSchema = z.object({
  turn_idx: z.number().int().nonnegative(),
  role: z.enum(['system', 'human', 'gpt', 'tool']),
  content: z.string(),
  tool_calls: z
    .array(
      z.object({
        name: z.string(),
        args_hash: z.string(),
      }),
    )
    .optional(),
  hypothesis: EcpHypothesisSchema.optional(),
  oracle_verdict: EcpOracleVerdictSchema.optional(),
  prediction_error: EcpPredictionErrorSchema.optional(),
  confidence_source: EcpConfidenceSourceSchema.optional(),
  tier_reliability: z.number().min(0).max(1).optional(),
});
export type EcpEnrichedTurn = z.infer<typeof EcpEnrichedTurnSchema>;

/**
 * Routing payload embedded in every enriched row — identical shape to the
 * explainer output so consumers do not need to cross-reference two formats.
 */
export const EcpRoutingFactorSchema = z.object({
  label: z.string(),
  rawValue: z.union([z.number(), z.string()]),
  weightedContribution: z.number(),
});

export const EcpRoutingExplanationSchema = z.object({
  taskId: z.string(),
  level: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]),
  summary: z.string(),
  factors: z.array(EcpRoutingFactorSchema),
  oraclesPlanned: z.array(z.string()),
  oraclesActual: z
    .array(
      z.object({
        name: z.string(),
        verdict: z.enum(['verified', 'falsified', 'uncertain', 'unknown', 'contradictory']),
        confidence: z.number(),
      }),
    )
    .optional(),
  confidenceSource: EcpConfidenceSourceSchema,
  escalationReason: z.string().optional(),
  deescalationReason: z.string().optional(),
  mappingLossWarnings: z.array(z.string()).optional(),
});

/**
 * Full enriched row — one per `execution_traces.id`.
 * `schema` literal gives consumers an unambiguous discriminator vs the
 * ShareGPT baseline format.
 */
export const EcpEnrichedRowSchema = z.object({
  schema: z.literal('vinyan.ecp.trajectory/v1'),
  trace_id: z.string(),
  task_type_signature: z.string().nullable(),
  routing: EcpRoutingExplanationSchema,
  turns: z.array(EcpEnrichedTurnSchema),
  terminal: z.object({
    outcome: z.enum(['success', 'failure', 'timeout', 'escalated']),
    quality_composite: z.number().nullable(),
  }),
  privacy: z.object({
    redaction_applied: z.array(z.string()),
    policy_version: z.string(),
  }),
});
export type EcpEnrichedRow = z.infer<typeof EcpEnrichedRowSchema>;

/**
 * Manifest variant — mirrors `ExportManifestSchema` but with the enriched
 * format discriminator. Kept separate from the ShareGPT manifest so a
 * consumer parsing one does not accidentally accept the other.
 */
export const EcpExportManifestSchema = z.object({
  format: z.literal('ecp-enriched'),
  schema_version: z.literal('v1'),
  dataset_id: z.string(),
  filter: z.object({
    profile: z.string().optional(),
    sinceMs: z.number().int().nullable(),
    outcome: z.array(z.string()).optional(),
    minQualityComposite: z.number().nullable(),
  }),
  rowCount: z.number().int().min(0),
  sha256: z.string(),
  redactionPolicyVersion: z.string(),
  redactionPolicyHash: z.string(),
  createdAt: z.number().int(),
  sourceTables: z.array(z.string()),
  vinyanGitSha: z.string().optional(),
});
export type EcpExportManifest = z.infer<typeof EcpExportManifestSchema>;

export const ECP_DATASET_VERSION = 'ecp-enriched/v1';
