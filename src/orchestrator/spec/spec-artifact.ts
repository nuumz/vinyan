/**
 * SpecArtifact — structured pre-Plan specification for code-mutation tasks.
 *
 * Produced by phase-spec.ts (Spec Refinement Phase) during the Agentic SDLC
 * lifecycle. Becomes a deterministic oracle input that GoalEvaluator and
 * Plan-phase consume — eliminating LLM-drift in goal evaluation by anchoring
 * "done" to a frozen, human-approved set of acceptance criteria.
 *
 * Axiom alignment:
 *   - A1: artifact is produced by Spec Room (multi-role); critic role distinct
 *         from author role enforces separation.
 *   - A3: once approved, artifact is immutable input to deterministic gates
 *         (acceptanceCriteria → GoalEvaluator C5 coverage check).
 *   - A7: edge cases + acceptance criteria turn implicit expectations explicit
 *         BEFORE generation, shrinking post-hoc prediction error.
 */
import { z } from 'zod/v4';

// ── Acceptance criterion ─────────────────────────────────────────────

/** Oracle that should verify a given criterion. Closed vocabulary — extending
 *  requires a code change to keep SpecArtifact governance reproducible. */
export const SPEC_ORACLE_VOCAB = [
  'ast',
  'type',
  'test',
  'lint',
  'dep',
  'goal-alignment',
  'critic',
  'manual',
] as const;
export type SpecOracle = (typeof SPEC_ORACLE_VOCAB)[number];

export const AcceptanceCriterionSchema = z.object({
  id: z.string().min(1),
  description: z.string().min(3),
  /** Whether this criterion is mechanically verifiable (vs subjective). */
  testable: z.boolean(),
  /** Which oracle should verify this criterion when generation completes. */
  oracle: z.enum(SPEC_ORACLE_VOCAB),
});
export type AcceptanceCriterion = z.infer<typeof AcceptanceCriterionSchema>;

// ── API shape (optional) ─────────────────────────────────────────────

export const ApiFieldSchema = z.object({
  name: z.string(),
  type: z.string(),
  required: z.boolean().default(true),
  description: z.string().optional(),
});
export type ApiField = z.infer<typeof ApiFieldSchema>;

export const ApiShapeSchema = z.object({
  name: z.string().min(1),
  kind: z.enum(['function', 'class', 'endpoint', 'event', 'type']),
  inputs: z.array(ApiFieldSchema).default([]),
  outputs: z.array(ApiFieldSchema).default([]),
  invariants: z.array(z.string()).default([]),
});
export type ApiShape = z.infer<typeof ApiShapeSchema>;

// ── Data contract (optional, free-form) ──────────────────────────────

export const DataContractSchema = z.object({
  name: z.string().min(1),
  schema: z.string().min(1),
  notes: z.string().optional(),
});
export type DataContract = z.infer<typeof DataContractSchema>;

// ── Edge case ────────────────────────────────────────────────────────

export const EdgeCaseSeveritySchema = z.enum(['blocker', 'major', 'minor']);
export type EdgeCaseSeverity = z.infer<typeof EdgeCaseSeveritySchema>;

export const EdgeCaseSchema = z.object({
  id: z.string().min(1),
  scenario: z.string().min(3),
  expected: z.string().min(3),
  severity: EdgeCaseSeveritySchema,
});
export type EdgeCase = z.infer<typeof EdgeCaseSchema>;

// ── Reasoning-variant fields (Gap C, 2026-04-28) ─────────────────────

/** Output shape for non-code reasoning tasks — replaces apiShape + dataContracts. */
export const ExpectedDeliverableSchema = z.object({
  kind: z.enum(['answer', 'plan', 'analysis', 'recommendation', 'comparison']),
  audience: z.string().min(1),
  format: z.enum(['prose', 'list', 'table', 'diagram-spec']),
  minDepth: z.enum(['shallow', 'deep']).optional(),
});
export type ExpectedDeliverable = z.infer<typeof ExpectedDeliverableSchema>;

/** Explicit topical-scope guard — the reasoning analogue to invariants. */
export const ScopeBoundariesSchema = z.object({
  outOfScope: z.array(z.string()).max(5).default([]),
  assumptions: z.array(z.string()).max(5).default([]),
});
export type ScopeBoundaries = z.infer<typeof ScopeBoundariesSchema>;

// ── Spec artifact ────────────────────────────────────────────────────

/** Frozen artifact version. Bumping requires a migration in spec-to-goal-oracle. */
export const SPEC_ARTIFACT_VERSION = '1' as const;

/** Code-mutation variant (existing). `variant` defaults to 'code' for
 *  backwards compatibility with persisted artifacts that predate Gap C. */
export const SpecArtifactCodeSchema = z.object({
  version: z.literal(SPEC_ARTIFACT_VERSION),
  variant: z.literal('code').default('code'),
  summary: z.string().min(5).max(280),
  acceptanceCriteria: z.array(AcceptanceCriterionSchema).min(1).max(20),
  apiShape: z.array(ApiShapeSchema).default([]),
  dataContracts: z.array(DataContractSchema).default([]),
  edgeCases: z.array(EdgeCaseSchema).default([]),
  openQuestions: z.array(z.string()).default([]),
  /** ISO timestamp when human approved. Absent → not yet approved. */
  approvedBy: z.string().optional(),
  approvedAt: z.number().optional(),
});
export type SpecArtifactCode = z.infer<typeof SpecArtifactCodeSchema>;

/** Reasoning / analysis / planning variant (Gap C). Tighter caps reflect the
 *  fact that reasoning specs without mechanical oracles need a smaller
 *  surface to stay verifiable by goal-alignment + critic alone. */
export const SpecArtifactReasoningSchema = z.object({
  version: z.literal(SPEC_ARTIFACT_VERSION),
  variant: z.literal('reasoning'),
  summary: z.string().min(5).max(280),
  acceptanceCriteria: z
    .array(
      AcceptanceCriterionSchema.extend({
        oracle: z.enum(['goal-alignment', 'critic', 'manual']),
      }),
    )
    .min(1)
    .max(7),
  expectedDeliverables: z.array(ExpectedDeliverableSchema).min(1).max(3),
  scopeBoundaries: ScopeBoundariesSchema.default({ outOfScope: [], assumptions: [] }),
  edgeCases: z.array(EdgeCaseSchema).max(4).default([]),
  openQuestions: z.array(z.string()).default([]),
  approvedBy: z.string().optional(),
  approvedAt: z.number().optional(),
});
export type SpecArtifactReasoning = z.infer<typeof SpecArtifactReasoningSchema>;

/**
 * Top-level discriminated union. Existing persisted artifacts (no `variant`
 * field) parse through the code branch via the schema's default. New
 * reasoning specs MUST set `variant: 'reasoning'` explicitly.
 */
export const SpecArtifactSchema = z.preprocess(
  (raw) => {
    if (raw && typeof raw === 'object' && !('variant' in raw)) {
      return { ...(raw as object), variant: 'code' };
    }
    return raw;
  },
  z.discriminatedUnion('variant', [SpecArtifactCodeSchema, SpecArtifactReasoningSchema]),
);
export type SpecArtifact = SpecArtifactCode | SpecArtifactReasoning;

// ── Helpers ──────────────────────────────────────────────────────────

/**
 * Project a SpecArtifact's testable criteria into a flat string list
 * compatible with TaskInput.acceptanceCriteria. Used by phase-spec to
 * populate the enhancedInput so the existing GoalEvaluator C5 coverage
 * check picks them up without further refactoring (A3-safe seam).
 *
 * Variant-agnostic: both code and reasoning variants share the
 * AcceptanceCriterion shape (id/description/testable/oracle).
 */
export function specToAcceptanceCriteriaList(spec: SpecArtifact): string[] {
  return spec.acceptanceCriteria
    .filter((c) => c.testable)
    .map((c) => c.description);
}

/**
 * Project the spec's edge-case scenarios into a constraints list. Edge cases
 * become additional constraints the worker must respect. Blocker-severity
 * cases are prefixed with `MUST:` to elevate them in prompt assembly.
 *
 * Reasoning variants ALSO emit `MUST: out-of-scope: …` items and
 * `ASSUME: …` items so phase-generate can guard against topical drift —
 * the failure mode A10 token-Jaccard catches imperfectly for prose tasks.
 */
export function specToConstraintsList(spec: SpecArtifact): string[] {
  const out: string[] = spec.edgeCases.map((ec) => {
    const prefix = ec.severity === 'blocker' ? 'MUST: ' : '';
    return `${prefix}${ec.scenario} → ${ec.expected}`;
  });
  if (spec.variant === 'reasoning') {
    for (const item of spec.scopeBoundaries.outOfScope) {
      out.push(`MUST: out-of-scope: ${item}`);
    }
    for (const item of spec.scopeBoundaries.assumptions) {
      out.push(`ASSUME: ${item}`);
    }
  }
  return out;
}

/** True when the spec has been approved (has approvedBy + approvedAt). */
export function isSpecApproved(spec: SpecArtifact): boolean {
  return Boolean(spec.approvedBy && spec.approvedAt);
}
