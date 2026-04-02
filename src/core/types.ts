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
  /** Heuristic: whether test files exist and pass (renamed from testMutationScore). Phase 1+. */
  testPresenceHeuristic?: number;
  /** Weighted combination — single scalar for ranking. */
  composite: number;
  /** How many dimensions were actually computed (2 in Phase 0, 4 in Phase 1+). */
  dimensionsAvailable: number;
  /** Which phase's dimensions are trustworthy. */
  phase: 'phase0' | 'phase1' | 'phase2';
  /** C3 fix: true when zero oracles ran — score is INDETERMINATE, not trusted. */
  unverified?: boolean;
}

// ── Abstention types (C3 fix: oracles that cannot produce verdicts must abstain) ──────

export type AbstentionReason =
  | 'no_test_files'
  | 'no_linter_configured'
  | 'out_of_domain'
  | 'insufficient_data'
  | 'timeout'
  | 'circuit_open'
  | 'target_not_found';

export interface OracleAbstention {
  type: 'abstained';
  reason: AbstentionReason;
  oracleName: string;
  durationMs: number;
  prerequisites?: string[];
}

export type OracleResponse = OracleVerdict | OracleAbstention;

export function isAbstention(response: OracleResponse): response is OracleAbstention {
  return response.type === 'abstained';
}

/** Oracle verification error codes for programmatic handling. */
export type OracleErrorCode =
  | 'TIMEOUT'
  | 'PARSE_ERROR'
  | 'TYPE_MISMATCH'
  | 'SYMBOL_NOT_FOUND'
  | 'ORACLE_CRASH'
  | 'BUILD_FAILED'
  | 'VET_VIOLATION'
  | 'MODULE_UNTIDY'
  | 'BORROW_CHECK'
  | 'LIFETIME_ERROR'
  | 'TRAIT_NOT_SATISFIED'
  | 'UNSAFE_VIOLATION'
  | 'UNSUPPORTED_PATTERN';

/**
 * Output from an oracle — the verification result with evidence chain.
 *
 * Relationship to ECP (Epistemic Communication Protocol):
 * OracleVerdict is the concrete implementation of the abstract ECPResponse concept
 * defined in concept.md §2.2. Every OracleVerdict carries epistemic metadata:
 *   - type → ECPResponse.type (epistemic state: known/unknown/uncertain/contradictory)
 *   - confidence → ECPResponse.confidence (1.0 for deterministic, <1.0 for heuristic)
 *   - evidence → ECPResponse.evidence (provenance chain)
 *   - falsifiableBy → ECPResponse.falsifiable_by (conditions that would invalidate)
 *   - deliberationRequest → ECPResponse.deliberation_request (request more compute)
 *   - temporalContext → ECPResponse.temporal_context (evidence validity window)
 *
 * Phase 2+: A generic ECPResponse<T> wrapper may be introduced to unify all
 * reasoning engine outputs under a single protocol type. OracleVerdict would
 * then become ECPResponse<VerificationData>.
 */
export interface OracleVerdict {
  verified: boolean;
  /** A2: Full epistemic state taxonomy. Phase 0 uses 'known'|'unknown' only. */
  type: 'known' | 'unknown' | 'uncertain' | 'contradictory';
  /** 1.0 for deterministic oracles (AST, type), <1.0 for heuristic. Maps to ECPResponse.confidence. */
  confidence: number;
  evidence: Evidence[];
  /** Conditions that would invalidate this verdict. Maps to ECPResponse.falsifiable_by. */
  falsifiableBy?: string[];
  /** Map of file path → SHA-256 hash at verification time */
  fileHashes: Record<string, string>;
  /** Human-readable explanation when !verified */
  reason?: string;
  /** Programmatic error code for structured error handling. */
  errorCode?: OracleErrorCode;
  /** Oracle name — attached by runner, not set by oracle process itself. */
  oracleName?: string;
  /** Time taken for oracle execution */
  durationMs: number;
  /** Instance provenance — where this verdict originated. Phase 5 A2A support. */
  origin?: 'local' | 'a2a' | 'mcp';
  /** A2 compliance: true = oracle explicitly reported confidence; false/undefined = absent. */
  confidenceReported?: boolean;
  /** Multi-dimensional quality signal (Phase 1 — not computed in Phase 0) */
  qualityScore?: QualityScore;
  /** Phase 1+: Engine requests more compute budget (→ concept §2.2 ECP). */
  deliberationRequest?: {
    reason: string;
    suggestedBudget: number;
  };
  /** Phase 1+: Evidence validity window with TTL (→ concept §2.2 ECP). */
  temporalContext?: {
    validFrom: number;
    validUntil: number;
    decayModel: 'linear' | 'step' | 'none';
  };
  /** Phase B+: Subjective Logic opinion for SL fusion (Phase 4). */
  opinion?: import('./subjective-opinion.ts').SubjectiveOpinion;
  /** Phase B+: Unclamped opinion before tier adjustment (for audit). */
  rawOpinion?: import('./subjective-opinion.ts').SubjectiveOpinion;
}

/** A verified fact stored in the World Graph. */
export interface Fact {
  id: string;
  target: string;
  pattern: string;
  evidence: Evidence[];
  oracleName: string;
  fileHash: string;
  /** Absolute path to the source file whose content hash is stored in fileHash. */
  sourceFile: string;
  verifiedAt: number;
  sessionId?: string;
  confidence: number;
  /** Epoch ms — fact evidence expires after this time (from oracle temporalContext). ECP spec §3.6. */
  validUntil?: number;
  /** How confidence decays over time (from oracle temporalContext). ECP spec §3.6. */
  decayModel?: 'linear' | 'step' | 'none';
}
