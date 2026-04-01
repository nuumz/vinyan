/**
 * Core interfaces for Vinyan Phase 0 — Oracle Gate MVP.
 * Source of truth: architecture.md Decision 3 (HypothesisTuple, OracleVerdict)
 */

/** Input to any oracle — a structured hypothesis to verify. */
export interface HypothesisTuple {
  /** File path or symbol identifier, e.g. "src/auth/login.ts" or "AuthService.validate" */
  target: string;
  /** What to verify, e.g. "symbol-exists", "function-signature", "import-exists" */
  pattern: string;
  /** Additional context for the oracle */
  context?: Record<string, unknown>;
  /** Absolute path to workspace root */
  workspace: string;
}

/** A single piece of evidence from oracle verification. */
export interface Evidence {
  file: string;
  line: number;
  snippet: string;
  /** SHA-256 of source file at verification time — A4 Content-Addressed Truth compliance. */
  contentHash?: string;
}

/** Multi-dimensional quality signal — Phase 0 computes architecturalCompliance + efficiency only. */
export interface QualityScore {
  /** Import depth, circular deps, layer violations (0.0–1.0). */
  architecturalCompliance: number;
  /** Tokens consumed / quality achieved (0.0–1.0). */
  efficiency: number;
  /** Reduction in cyclomatic complexity (0.0–1.0). Phase 1+. */
  simplificationGain?: number;
  /** % of injected faults caught by tests. Phase 1+. */
  testMutationScore?: number;
  /** Weighted combination — single scalar for ranking. */
  composite: number;
  /** How many dimensions were actually computed (2 in Phase 0, 4 in Phase 1+). */
  dimensions_available: number;
  /** Which phase's dimensions are trustworthy. */
  phase: "phase0" | "phase1" | "phase2";
}

/** Oracle verification error codes for programmatic handling. */
export type OracleErrorCode =
  | "TIMEOUT"
  | "PARSE_ERROR"
  | "TYPE_MISMATCH"
  | "SYMBOL_NOT_FOUND"
  | "ORACLE_CRASH";

/**
 * Output from an oracle — the verification result with evidence chain.
 *
 * Relationship to ECP (Epistemic Communication Protocol):
 * OracleVerdict is the concrete implementation of the abstract ECPResponse concept
 * defined in concept.md §2.2. Every OracleVerdict carries epistemic metadata:
 *   - type → ECPResponse.type (epistemic state: known/unknown/uncertain/contradictory)
 *   - confidence → ECPResponse.confidence (1.0 for deterministic, <1.0 for heuristic)
 *   - evidence → ECPResponse.evidence (provenance chain)
 *   - falsifiable_by → ECPResponse.falsifiable_by (conditions that would invalidate)
 *   - deliberation_request → ECPResponse.deliberation_request (request more compute)
 *   - temporal_context → ECPResponse.temporal_context (evidence validity window)
 *
 * Phase 2+: A generic ECPResponse<T> wrapper may be introduced to unify all
 * reasoning engine outputs under a single protocol type. OracleVerdict would
 * then become ECPResponse<VerificationData>.
 */
export interface OracleVerdict {
  verified: boolean;
  /** A2: Full epistemic state taxonomy. Phase 0 uses 'known'|'unknown' only. */
  type: "known" | "unknown" | "uncertain" | "contradictory";
  /** 1.0 for deterministic oracles (AST, type), <1.0 for heuristic. Maps to ECPResponse.confidence. */
  confidence: number;
  evidence: Evidence[];
  /** Conditions that would invalidate this verdict. Maps to ECPResponse.falsifiable_by. */
  falsifiable_by?: string[];
  /** Map of file path → SHA-256 hash at verification time */
  fileHashes: Record<string, string>;
  /** Human-readable explanation when !verified */
  reason?: string;
  /** Programmatic error code for structured error handling. */
  errorCode?: OracleErrorCode;
  /** Oracle name — attached by runner, not set by oracle process itself. */
  oracleName?: string;
  /** Time taken for oracle execution */
  duration_ms: number;
  /** Multi-dimensional quality signal (Phase 1 — not computed in Phase 0) */
  qualityScore?: QualityScore;
  /** Phase 1+: Engine requests more compute budget (→ concept §2.2 ECP). */
  deliberation_request?: {
    reason: string;
    suggestedBudget: number;
  };
  /** Phase 1+: Evidence validity window with TTL (→ concept §2.2 ECP). */
  temporal_context?: {
    valid_from: number;
    valid_until: number;
    decay_model: "linear" | "step" | "none";
  };
}

/** A verified fact stored in the World Graph. */
export interface Fact {
  id: string;
  target: string;
  pattern: string;
  evidence: Evidence[];
  oracle_name: string;
  file_hash: string;
  /** Absolute path to the source file whose content hash is stored in file_hash. */
  source_file: string;
  verified_at: number;
  session_id?: string;
  confidence: number;
  /** Epoch ms — fact evidence expires after this time (from oracle temporal_context). ECP spec §3.6. */
  valid_until?: number;
  /** How confidence decays over time (from oracle temporal_context). ECP spec §3.6. */
  decay_model?: "linear" | "step" | "none";
}
