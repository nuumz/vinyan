/**
 * Memory Wiki — contracts.
 *
 * The single source of truth for every shape the wiki subsystem moves
 * across module boundaries (DB rows, vault files, API payloads, bus
 * events). Concrete stores/writers/retrievers in sibling files implement
 * these — this file freezes the surface.
 *
 * Design anchor: `docs/design/llm-memory-wiki-system-design.md`.
 *
 * Axioms:
 *   A1 — every write is `WikiPageProposal -> WikiWriteResult`. Generators
 *        produce proposals; only the validator ack-routes them to disk.
 *   A3 — types are deterministic; no LLM is in the contract path.
 *   A4 — `WikiSource.contentHash` is required and addressing.
 *   A5 — `evidenceTier` is mandatory on pages and claims.
 */
import { z } from 'zod/v4';
import { CONFIDENCE_TIERS, type ConfidenceTier } from '../../core/confidence-tier.ts';

// ── Source kinds ────────────────────────────────────────────────────────

export const WIKI_SOURCE_KINDS = [
  'session',
  'trace',
  'user-note',
  'web-capture',
  'coding-cli-run',
  'verification',
  'approval',
] as const;
export type WikiSourceKind = (typeof WIKI_SOURCE_KINDS)[number];

// ── Page types ──────────────────────────────────────────────────────────

export const WIKI_PAGE_TYPES = [
  'concept',
  'entity',
  'project',
  'decision',
  'failure-pattern',
  'workflow-pattern',
  'source-summary',
  'task-memory',
  'agent-profile',
  'open-question',
] as const;
export type WikiPageType = (typeof WIKI_PAGE_TYPES)[number];

// ── Lifecycle ───────────────────────────────────────────────────────────

export const WIKI_LIFECYCLE_STATES = ['draft', 'canonical', 'stale', 'disputed', 'archived'] as const;
export type WikiLifecycle = (typeof WIKI_LIFECYCLE_STATES)[number];

// ── Edge kinds ──────────────────────────────────────────────────────────

export const WIKI_EDGE_TYPES = [
  'mentions',
  'cites',
  'supersedes',
  'contradicts',
  'derived-from',
  'implements',
  'belongs-to',
] as const;
export type WikiEdgeType = (typeof WIKI_EDGE_TYPES)[number];

// ── Source ──────────────────────────────────────────────────────────────

export interface WikiProvenance {
  readonly profile: string;
  readonly sessionId?: string;
  readonly taskId?: string;
  readonly agentId?: string;
  readonly user?: string;
}

export interface WikiSource {
  /** sha256(kind|contentHash|createdAt). Stable, content-addressed. */
  readonly id: string;
  readonly kind: WikiSourceKind;
  /** sha256(body) — A4. */
  readonly contentHash: string;
  readonly createdAt: number;
  readonly provenance: WikiProvenance;
  /** Serialized payload — JSON for structured kinds, markdown for prose. */
  readonly body: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface WikiSourceRef {
  readonly id: string;
  readonly contentHash: string;
  readonly kind: WikiSourceKind;
}

// ── Page ────────────────────────────────────────────────────────────────

export interface WikiPage {
  readonly id: string;
  readonly profile: string;
  readonly type: WikiPageType;
  readonly title: string;
  readonly aliases: readonly string[];
  readonly tags: readonly string[];
  readonly body: string;
  readonly evidenceTier: ConfidenceTier;
  readonly confidence: number;
  readonly lifecycle: WikiLifecycle;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly validUntil?: number;
  /** Names of human-protected sections (markdown markers preserved on rewrite). */
  readonly protectedSections: readonly string[];
  /** sha256(body) for stale-detection cascades. */
  readonly bodyHash: string;
  /** Source references this page cites (resolved from claims). */
  readonly sources: readonly WikiSourceRef[];
}

// ── Claim ───────────────────────────────────────────────────────────────

export interface WikiClaim {
  readonly id: string;
  readonly pageId: string;
  readonly text: string;
  /** Source ids this claim is grounded in. */
  readonly sourceIds: readonly string[];
  readonly evidenceTier: ConfidenceTier;
  readonly confidence: number;
  readonly createdAt: number;
}

// ── Edge ────────────────────────────────────────────────────────────────

export interface WikiEdge {
  readonly fromId: string;
  readonly toId: string;
  readonly edgeType: WikiEdgeType;
  readonly confidence: number;
  readonly createdAt: number;
}

// ── Operation ───────────────────────────────────────────────────────────

export type WikiOperationOp =
  | 'ingest'
  | 'propose'
  | 'write'
  | 'reject'
  | 'stale'
  | 'promote'
  | 'demote'
  | 'lint'
  | 'archive'
  | 'restore';

export interface WikiOperation {
  readonly id: number;
  readonly ts: number;
  readonly op: WikiOperationOp;
  readonly pageId?: string;
  readonly sourceId?: string;
  readonly actor: string;
  readonly reason?: string;
  readonly payload?: Readonly<Record<string, unknown>>;
}

// ── Lint ────────────────────────────────────────────────────────────────

export const WIKI_LINT_CODES = [
  'broken-wikilink',
  'orphan-page',
  'duplicate-page',
  'contradiction-candidate',
  'stale-page',
  'uncited-canonical-claim',
  'missing-source-backlink',
  'low-confidence-canonical',
  'open-question-no-owner',
  'repeated-failure',
] as const;
export type WikiLintCode = (typeof WIKI_LINT_CODES)[number];

export type WikiLintSeverity = 'error' | 'warn' | 'info';

export interface WikiLintFinding {
  readonly id: number;
  readonly ts: number;
  readonly code: WikiLintCode;
  readonly severity: WikiLintSeverity;
  readonly pageId?: string;
  readonly detail?: string;
  readonly resolvedAt?: number;
}

// ── Proposal & write result ─────────────────────────────────────────────

/**
 * Proposal shape passed to PageWriter. The validator either accepts
 * (returning `{ ok: true, page }`) or rejects with a typed reason.
 *
 * `id` may be omitted for new pages — the writer derives it from the
 * (profile, type, title) tuple. When `id` is provided the writer treats
 * it as an upsert.
 */
export interface WikiPageProposal {
  readonly id?: string;
  readonly profile: string;
  readonly type: WikiPageType;
  readonly title: string;
  readonly aliases?: readonly string[];
  readonly tags?: readonly string[];
  readonly body: string;
  readonly evidenceTier: ConfidenceTier;
  readonly confidence: number;
  readonly lifecycle?: WikiLifecycle;
  readonly validUntil?: number;
  readonly protectedSections?: readonly string[];
  readonly sources: readonly WikiSourceRef[];
  /** Actor performing the write (agent id, 'system', or 'user:<id>'). */
  readonly actor: string;
  readonly reason?: string;
}

export type WikiWriteResult =
  | { readonly ok: true; readonly page: WikiPage; readonly created: boolean }
  | {
      readonly ok: false;
      readonly reason:
        | 'frontmatter_invalid'
        | 'uncited_canonical'
        | 'broken_wikilink'
        | 'human_protected_modified'
        | 'tier_demotion'
        | 'profile_unknown'
        | 'path_invalid'
        | 'body_too_large'
        | 'duplicate_alias';
      readonly detail: string;
    };

// ── Search & retrieval ──────────────────────────────────────────────────

export interface WikiSearchOpts {
  readonly profile: string;
  readonly limit?: number;
  readonly types?: readonly WikiPageType[];
  readonly minTier?: ConfidenceTier;
  readonly lifecycle?: readonly WikiLifecycle[];
  readonly freshnessMs?: number;
  readonly tags?: readonly string[];
}

export interface WikiPageHit {
  readonly page: WikiPage;
  readonly score: number;
  readonly components: {
    readonly bm25: number;
    readonly tierWeight: number;
    readonly recency: number;
    readonly graphBoost: number;
  };
}

export interface PageGraph {
  readonly center: string;
  readonly nodes: readonly WikiPage[];
  readonly edges: readonly WikiEdge[];
  readonly depth: number;
}

// ── ContextPack ─────────────────────────────────────────────────────────

export interface ContextPackPage {
  readonly page: WikiPage;
  readonly trustLabel: string;
  readonly score: number;
  readonly excerpt: string;
}

export interface OmittedItem {
  readonly id: string;
  readonly title: string;
  readonly reason: 'token-budget' | 'stale' | 'disputed' | 'lifecycle-archived' | 'tier-floor' | 'profile-mismatch';
}

export interface ContextPackRequest {
  readonly profile: string;
  readonly goal: string;
  readonly tokenBudget?: number;
  readonly types?: readonly WikiPageType[];
  readonly includeFailures?: boolean;
  readonly includeOpenQuestions?: boolean;
  readonly minTier?: ConfidenceTier;
  readonly scope?: ScopeFilter;
}

export interface ScopeFilter {
  readonly profile?: string;
  readonly sessionId?: string;
  readonly taskId?: string;
  readonly agentId?: string;
  readonly tags?: readonly string[];
}

export interface ContextPack {
  readonly pages: readonly ContextPackPage[];
  readonly citations: readonly WikiSourceRef[];
  readonly graph: PageGraph;
  readonly decisions: readonly WikiPage[];
  readonly failures: readonly WikiPage[];
  readonly openQuestions: readonly WikiPage[];
  readonly omitted: readonly OmittedItem[];
  readonly tokenEstimate: number;
  readonly generatedAt: number;
}

// ── Ingest ──────────────────────────────────────────────────────────────

export interface SourceIngestInput {
  readonly kind: WikiSourceKind;
  readonly body: string;
  readonly provenance: WikiProvenance;
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly createdAt?: number;
}

export interface IngestResult {
  readonly source: WikiSource;
  readonly pages: readonly WikiPage[];
  readonly proposalsRejected: ReadonlyArray<{ proposal: WikiPageProposal; reason: string }>;
  readonly operations: readonly WikiOperation[];
}

// ── Zod schemas (boundary validation) ───────────────────────────────────

const ProfileSchema = z.string().refine((v) => v === 'default' || /^[a-z][a-z0-9-]*$/.test(v), {
  message: 'profile must be "default" or match /^[a-z][a-z0-9-]*$/',
});

export const ConfidenceTierSchema = z.enum(CONFIDENCE_TIERS);
export const WikiSourceKindSchema = z.enum(WIKI_SOURCE_KINDS);
export const WikiPageTypeSchema = z.enum(WIKI_PAGE_TYPES);
export const WikiLifecycleSchema = z.enum(WIKI_LIFECYCLE_STATES);
export const WikiEdgeTypeSchema = z.enum(WIKI_EDGE_TYPES);
export const WikiLintCodeSchema = z.enum(WIKI_LINT_CODES);

export const WikiProvenanceSchema = z.object({
  profile: ProfileSchema,
  sessionId: z.string().optional(),
  taskId: z.string().optional(),
  agentId: z.string().optional(),
  user: z.string().optional(),
});

export const WikiSourceRefSchema = z.object({
  id: z.string().min(1),
  contentHash: z.string().min(1),
  kind: WikiSourceKindSchema,
});

export const WikiSourceSchema = z.object({
  id: z.string().min(1),
  kind: WikiSourceKindSchema,
  contentHash: z.string().min(1),
  createdAt: z.number().int(),
  provenance: WikiProvenanceSchema,
  body: z.string(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

/**
 * Shared frontmatter constraints used by both the proposal and the
 * stored page. Confidence ≤ tier ceiling is enforced *outside* the zod
 * schema (in PageWriter) because we want a typed reason tag.
 */
export const WikiPageProposalSchema = z.object({
  id: z.string().min(1).optional(),
  profile: ProfileSchema,
  type: WikiPageTypeSchema,
  title: z.string().min(1).max(200),
  aliases: z.array(z.string().min(1)).max(20).optional(),
  tags: z.array(z.string().min(1)).max(30).optional(),
  body: z.string().max(64 * 1024),
  evidenceTier: ConfidenceTierSchema,
  confidence: z.number().min(0).max(1),
  lifecycle: WikiLifecycleSchema.optional(),
  validUntil: z.number().int().optional(),
  protectedSections: z.array(z.string()).max(10).optional(),
  sources: z.array(WikiSourceRefSchema),
  actor: z.string().min(1),
  reason: z.string().max(500).optional(),
});

export const WikiSearchOptsSchema = z.object({
  profile: ProfileSchema,
  limit: z.number().int().positive().max(200).optional(),
  types: z.array(WikiPageTypeSchema).optional(),
  minTier: ConfidenceTierSchema.optional(),
  lifecycle: z.array(WikiLifecycleSchema).optional(),
  freshnessMs: z.number().int().nonnegative().optional(),
  tags: z.array(z.string().min(1)).optional(),
});

export const ContextPackRequestSchema = z.object({
  profile: ProfileSchema,
  goal: z.string().min(1).max(2000),
  tokenBudget: z.number().int().positive().max(20_000).optional(),
  types: z.array(WikiPageTypeSchema).optional(),
  includeFailures: z.boolean().optional(),
  includeOpenQuestions: z.boolean().optional(),
  minTier: ConfidenceTierSchema.optional(),
  scope: z
    .object({
      profile: ProfileSchema.optional(),
      sessionId: z.string().optional(),
      taskId: z.string().optional(),
      agentId: z.string().optional(),
      tags: z.array(z.string()).optional(),
    })
    .optional(),
});

export const SourceIngestInputSchema = z.object({
  kind: WikiSourceKindSchema,
  body: z
    .string()
    .min(1)
    .max(1024 * 1024),
  provenance: WikiProvenanceSchema,
  metadata: z.record(z.string(), z.unknown()).optional(),
  createdAt: z.number().int().optional(),
});

// ── Constants ───────────────────────────────────────────────────────────

export const MAX_PAGE_BODY_BYTES = 64 * 1024;
export const MAX_SOURCE_BODY_BYTES = 1024 * 1024;
export const DEFAULT_CONTEXT_PACK_TOKEN_BUDGET = 4000;
export const DEFAULT_GRAPH_DEPTH = 1;
