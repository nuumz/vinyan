/**
 * ECP Schemas — Zod schemas for oracle I/O validation.
 *
 * These are the canonical schemas for the Epistemic Communication Protocol (ECP).
 * Oracles read HypothesisTuple from stdin and write OracleVerdict to stdout.
 */

import { z } from 'zod/v4';

// ── Input Schema ──────────────────────────────────────────────────────

/** HypothesisTuple — what the oracle should verify. */
export const HypothesisTupleSchema = z.object({
  /** Target file or symbol to verify. */
  target: z.string(),
  /** Verification pattern (e.g., 'type-check', 'symbol-exists', 'import-exists'). */
  pattern: z.string(),
  /** Optional context key-value pairs. */
  context: z.record(z.string(), z.unknown()).optional(),
  /** Workspace root directory. */
  workspace: z.string(),
});

export type HypothesisTuple = z.infer<typeof HypothesisTupleSchema>;

// ── Evidence Schema ───────────────────────────────────────────────────

/** Evidence — a source location with a diagnostic snippet. */
export const EvidenceSchema = z.object({
  /** File path (relative to workspace). */
  file: z.string(),
  /** Line number (1-based). */
  line: z.number(),
  /** Diagnostic message or code snippet. */
  snippet: z.string(),
  /** Optional SHA-256 hash of the file content (A4: content-addressed truth). */
  contentHash: z.string().optional(),
});

export type Evidence = z.infer<typeof EvidenceSchema>;

// ── Quality Score Schema ──────────────────────────────────────────────

/** QualityScore — multi-dimensional quality signal. */
export const QualityScoreSchema = z.object({
  architecturalCompliance: z.number(),
  efficiency: z.number(),
  simplificationGain: z.number().optional(),
  testMutationScore: z.number().optional(),
  composite: z.number(),
  dimensionsAvailable: z.number().default(2),
  phase: z.enum(['phase0', 'phase1', 'phase2']).default('phase0'),
});

export type QualityScore = z.infer<typeof QualityScoreSchema>;

// ── Error Code Schema ─────────────────────────────────────────────────

/** OracleErrorCode — programmatic error classification. */
export const OracleErrorCodeSchema = z.enum([
  'TIMEOUT',
  'PARSE_ERROR',
  'TYPE_MISMATCH',
  'SYMBOL_NOT_FOUND',
  'ORACLE_CRASH',
  'BUILD_FAILED',
  'VET_VIOLATION',
  'MODULE_UNTIDY',
  'BORROW_CHECK',
  'LIFETIME_ERROR',
  'TRAIT_NOT_SATISFIED',
  'UNSAFE_VIOLATION',
  'UNSUPPORTED_PATTERN',
]);

export type OracleErrorCode = z.infer<typeof OracleErrorCodeSchema>;

// ── ECP Extensions ────────────────────────────────────────────────────

/** DeliberationRequest — oracle requests more budget for deeper analysis. */
export const DeliberationRequestSchema = z.object({
  reason: z.string(),
  suggestedBudget: z.number(),
});

export type DeliberationRequest = z.infer<typeof DeliberationRequestSchema>;

/** TemporalContext — validity window for time-bounded verdicts. */
export const TemporalContextSchema = z.object({
  validFrom: z.number(),
  validUntil: z.number(),
  decayModel: z.enum(['linear', 'step', 'none', 'exponential']),
  halfLife: z.number().optional(),
});

export type TemporalContext = z.infer<typeof TemporalContextSchema>;

// ── Output Schema ─────────────────────────────────────────────────────

/** OracleVerdict — the verification result with evidence chain. */
export const OracleVerdictSchema = z.object({
  /** Whether the hypothesis was verified. */
  verified: z.boolean(),
  /** Epistemic state: known (deterministic), unknown, uncertain, contradictory. */
  type: z.enum(['known', 'unknown', 'uncertain', 'contradictory']).default('known'),
  /** Confidence level [0, 1]. ECP v2 default: 0.5 (maximum uncertainty). */
  confidence: z.number().min(0).max(1).default(0.5),
  /** Evidence chain — source locations supporting the verdict. */
  evidence: z.array(EvidenceSchema),
  /** Conditions that would falsify this verdict (ECP falsifiability). */
  falsifiableBy: z.array(z.string()).optional(),
  /** Content-addressed file hashes (A4). */
  fileHashes: z.record(z.string(), z.string()),
  /** Human-readable reason for failure. */
  reason: z.string().optional(),
  /** Programmatic error code. */
  errorCode: OracleErrorCodeSchema.optional(),
  /** Oracle name — attached by runner, not by oracle process. */
  oracleName: z.string().optional(),
  /** Execution duration in milliseconds. */
  durationMs: z.number(),
  /** Multi-dimensional quality signal. */
  qualityScore: QualityScoreSchema.optional(),
  /** Request for deliberation (more budget). */
  deliberationRequest: DeliberationRequestSchema.optional(),
  /** Temporal validity context. */
  temporalContext: TemporalContextSchema.optional(),

  // ── ECP v2 additions (all optional for backward compat) ──
  /** SL opinion tuple. */
  opinion: z.object({
    belief: z.number().min(0).max(1),
    disbelief: z.number().min(0).max(1),
    uncertainty: z.number().min(0).max(1),
    baseRate: z.number().min(0).max(1),
  }).optional(),
  /** Tier methodology reliability — set by Orchestrator. */
  tierReliability: z.number().min(0).max(1).optional(),
  /** Engine's per-verdict certainty. */
  engineCertainty: z.number().min(0).max(1).optional(),
  /** Source of confidence derivation. */
  confidenceSource: z.enum(['evidence-derived', 'self-model-calibrated', 'llm-self-report']).optional(),
  /** Whether confidence was explicitly reported by the oracle. */
  confidenceReported: z.boolean().optional(),
});

export type OracleVerdict = z.infer<typeof OracleVerdictSchema>;
