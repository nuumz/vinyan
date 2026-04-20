/**
 * MemoryProvider — unified memory substrate contract (W1 / PR #2).
 *
 * Types-only module. Concrete providers (DefaultMemoryProvider, vector
 * providers, dialectic USER.md providers) implement this interface in
 * later PRs; this PR freezes the surface so sibling tracks (profile
 * resolver, skills hub, trajectory exporter) can depend on it.
 *
 * Contract anchor: `docs/spec/w1-contracts.md`
 *   §1 ConfidenceTier — import from `src/core/confidence-tier.ts`.
 *                        Do NOT redeclare the literal union anywhere.
 *   §3 Profile column — every record carries a required `profile` string;
 *                        cross-profile reads are prohibited at this layer.
 *
 * Axioms touched:
 *   A2 — first-class unknown (providers may surface tier=speculative,
 *        but `MemoryRecord` itself is a committed claim; uncertainty is
 *        expressed through tier + confidence, never via a tier='unknown').
 *   A4 — content-addressed truth (`contentHash` required when tier is
 *        `deterministic`; invalidate() keys on that hash).
 *   A5 — tiered trust (confidence is clamped to TIER_CONFIDENCE_CEILING).
 */
import { z } from 'zod/v4';
import { CONFIDENCE_TIERS, type ConfidenceTier, TIER_CONFIDENCE_CEILING } from '../../core/confidence-tier.ts';

// ── Supporting shapes ──────────────────────────────────────────────────

export interface EvidenceRef {
  /** Evidence kind: 'file' | 'turn' | 'oracle' | 'user' | 'session' (open-ended) */
  readonly kind: string;
  /** SHA-256 of the evidence artifact. */
  readonly hash: string;
  readonly path?: string;
  readonly turnId?: string;
  readonly oracleId?: string;
}

export const MEMORY_KINDS = ['fact', 'preference', 'user-section', 'episodic'] as const;
export type MemoryKind = (typeof MEMORY_KINDS)[number];

export interface TemporalContext {
  readonly createdAt: number;
  readonly validFrom?: number;
  readonly validUntil?: number;
}

// ── Record ─────────────────────────────────────────────────────────────

export interface MemoryRecord {
  /** Stable id derived from content hash (provider responsibility). */
  readonly id: string;
  /** Profile scope — w1-contracts §3. */
  readonly profile: string;
  readonly kind: MemoryKind;
  readonly content: string;
  /** Confidence value; clamped to TIER_CONFIDENCE_CEILING[evidenceTier]. */
  readonly confidence: number;
  readonly evidenceTier: ConfidenceTier;
  readonly evidenceChain: readonly EvidenceRef[];
  /** Required when evidenceTier === 'deterministic' (A4). */
  readonly contentHash?: string;
  readonly temporalContext: TemporalContext;
  readonly sessionId?: string;
  /** Optional provider-specific embedding. */
  readonly embedding?: Float32Array;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

// ── Search / Result ────────────────────────────────────────────────────

export interface SearchOpts {
  /** Profile scope — REQUIRED. No cross-profile reads at this layer. */
  readonly profile: string;
  /** Default: 10. */
  readonly limit?: number;
  readonly kinds?: readonly MemoryKind[];
  /** Filters weaker tiers out (inclusive floor). */
  readonly minTier?: ConfidenceTier;
  /** Only records newer than `now - freshnessMs`. */
  readonly freshnessMs?: number;
}

export interface MemoryHit {
  readonly record: MemoryRecord;
  readonly score: number;
  readonly components: {
    readonly similarity: number;
    readonly tierWeight: number;
    readonly recency: number;
    readonly predErrorPenalty: number;
  };
}

// ── Write acknowledgement ──────────────────────────────────────────────

export type WriteAck =
  | {
      readonly ok: true;
      readonly id: string;
      readonly tier: ConfidenceTier;
      readonly promotedFrom?: ConfidenceTier;
    }
  | {
      readonly ok: false;
      readonly reason: 'critic_rejected' | 'schema_invalid' | 'tier_demotion' | 'profile_unknown';
      readonly detail: string;
    };

// ── Consolidation / Health ─────────────────────────────────────────────

export interface ConsolidationReport {
  readonly scanned: number;
  readonly promoted: number;
  readonly demoted: number;
  readonly invalidated: number;
  readonly lowConfidenceFlagged: readonly MemoryRecord[];
  readonly nudges: ReadonlyArray<{ readonly topic: string; readonly reason: string }>;
}

export interface HealthReport {
  readonly ok: boolean;
  readonly latencyMs: number;
  readonly notes?: string;
}

// ── Provider interface ─────────────────────────────────────────────────

export interface MemoryProvider {
  readonly id: string;
  /** e.g. 'vector.search' | 'user.dialectic' | 'fts5' */
  readonly capabilities: readonly string[];
  readonly tierSupport: readonly ConfidenceTier[];

  write(record: Omit<MemoryRecord, 'id'>): Promise<WriteAck>;
  search(query: string, opts: SearchOpts): Promise<readonly MemoryHit[]>;
  invalidate(contentHash: string): Promise<{ readonly removed: number }>;
  consolidate(): Promise<ConsolidationReport>;
  healthCheck(): Promise<HealthReport>;
}

// ── Zod schemas (boundary validation) ──────────────────────────────────

/** Accepts the literal `'default'` OR a lowercase kebab-start identifier. */
const ProfileSchema = z.string().refine((v) => v === 'default' || /^[a-z][a-z0-9-]*$/.test(v), {
  message: 'profile must be "default" or match /^[a-z][a-z0-9-]*$/',
});

export const ConfidenceTierSchema = z.enum(CONFIDENCE_TIERS);

export const MemoryKindSchema = z.enum(MEMORY_KINDS);

export const EvidenceRefSchema = z.object({
  kind: z.string().min(1),
  hash: z.string().min(1),
  path: z.string().optional(),
  turnId: z.string().optional(),
  oracleId: z.string().optional(),
});

export const TemporalContextSchema = z.object({
  createdAt: z.number().int(),
  validFrom: z.number().int().optional(),
  validUntil: z.number().int().optional(),
});

/**
 * MemoryRecord schema for boundary validation (pre-persist, pre-return).
 *
 * Invariants enforced:
 *   - `profile` matches §3 convention.
 *   - `confidence ∈ [0, TIER_CONFIDENCE_CEILING[evidenceTier]]`.
 *   - `contentHash` required iff `evidenceTier === 'deterministic'` (A4).
 */
export const MemoryRecordSchema = z
  .object({
    id: z.string().min(1),
    profile: ProfileSchema,
    kind: MemoryKindSchema,
    content: z.string(),
    confidence: z.number().min(0).max(1),
    evidenceTier: ConfidenceTierSchema,
    evidenceChain: z.array(EvidenceRefSchema).readonly(),
    contentHash: z.string().min(1).optional(),
    temporalContext: TemporalContextSchema,
    sessionId: z.string().optional(),
    embedding: z.instanceof(Float32Array).optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .refine((r) => r.confidence <= TIER_CONFIDENCE_CEILING[r.evidenceTier], {
    message: 'confidence exceeds TIER_CONFIDENCE_CEILING for evidenceTier',
    path: ['confidence'],
  })
  .refine((r) => r.evidenceTier !== 'deterministic' || !!r.contentHash, {
    message: 'contentHash is required when evidenceTier === "deterministic"',
    path: ['contentHash'],
  });

/** Input schema for `MemoryProvider.write` (no id yet — provider assigns). */
export const MemoryRecordInputSchema = z
  .object({
    profile: ProfileSchema,
    kind: MemoryKindSchema,
    content: z.string(),
    confidence: z.number().min(0).max(1),
    evidenceTier: ConfidenceTierSchema,
    evidenceChain: z.array(EvidenceRefSchema).readonly(),
    contentHash: z.string().min(1).optional(),
    temporalContext: TemporalContextSchema,
    sessionId: z.string().optional(),
    embedding: z.instanceof(Float32Array).optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .refine((r) => r.confidence <= TIER_CONFIDENCE_CEILING[r.evidenceTier], {
    message: 'confidence exceeds TIER_CONFIDENCE_CEILING for evidenceTier',
    path: ['confidence'],
  })
  .refine((r) => r.evidenceTier !== 'deterministic' || !!r.contentHash, {
    message: 'contentHash is required when evidenceTier === "deterministic"',
    path: ['contentHash'],
  });

/**
 * Search options schema. Rejects cross-profile wildcards — callers must
 * name exactly one profile. A future `profile: 'ALL'` escape hatch would
 * need an explicit audit path (§3) and does NOT live here.
 */
export const SearchOptsSchema = z.object({
  profile: ProfileSchema,
  limit: z.number().int().positive().optional(),
  kinds: z.array(MemoryKindSchema).readonly().optional(),
  minTier: ConfidenceTierSchema.optional(),
  freshnessMs: z.number().int().nonnegative().optional(),
});
