/**
 * Unified Audit Entry — the canonical shape every observable orchestrator
 * action lands as for the A8 (Traceable Accountability) audit surface.
 *
 * One discriminated union, eight variants. The wrapper carries cross-cutting
 * provenance (id, ts, policyVersion, actor, evidenceRefs); the variant
 * carries the kind-specific payload. Validated via zod at the publish
 * boundary (dev/test) and at the projection ingest boundary (prod safeParse
 * + drop+counter on schema fail).
 *
 * Persistence path: `audit:entry` events flow through the existing
 * `task_events` table (one row per entry). Live UI synthesizes this log
 * from legacy events; historical replay reads the durable rows directly.
 *
 * Actor names follow the canonical agent-vocabulary (persona / worker /
 * cli-delegate / peer / orchestrator / oracle / critic / user). Never bare
 * "agent".
 */

import { z } from 'zod/v4';

// ── Actor reference ─────────────────────────────────────────────────────

/**
 * Who produced this entry. Five orchestrator-internal actors plus three
 * vocabulary-driven external ones. `cli-delegate` matches the canonical
 * agent-vocabulary form (hyphenated) so this enum can compose with
 * `AgentKind` without a translation layer.
 */
export const ACTOR_TYPES = [
  'persona',
  'worker',
  'cli-delegate',
  'peer',
  'orchestrator',
  'oracle',
  'critic',
  'user',
] as const;

export type ActorType = (typeof ACTOR_TYPES)[number];

export const ActorRefSchema = z.object({
  type: z.enum(ACTOR_TYPES),
  id: z.string().min(1).optional(),
  vendor: z.string().min(1).optional(),
});

export type ActorRef = z.infer<typeof ActorRefSchema>;

// ── Evidence reference ──────────────────────────────────────────────────

/**
 * A pointer to the evidence backing an entry. File evidence is bound to a
 * sha256 at observation time (A4); on click, the UI verifies the hash
 * still matches the on-disk content and shows an "evidence stale" banner
 * if drift is detected.
 */
export const EvidenceRefSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('file'),
    path: z.string().min(1),
    sha256: z.string().regex(/^[0-9a-f]{64}$/, 'sha256 must be 64 lowercase hex chars'),
    range: z.tuple([z.number().int().nonnegative(), z.number().int().nonnegative()]).optional(),
  }),
  z.object({
    type: z.literal('fact'),
    factId: z.string().min(1),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
  }),
  z.object({
    type: z.literal('event'),
    eventId: z.string().min(1),
  }),
  z.object({
    type: z.literal('verdict'),
    verdictId: z.string().min(1),
  }),
  z.object({
    type: z.literal('tool_result'),
    auditEntryId: z.string().min(1),
  }),
]);

export type EvidenceRef = z.infer<typeof EvidenceRefSchema>;

// ── Wrapper (cross-cutting fields shared by every variant) ──────────────

export const AUDIT_SCHEMA_VERSION = 1 as const;

const WrapperFieldsSchema = z.object({
  id: z.string().min(1),
  taskId: z.string().min(1),
  parentEntryId: z.string().min(1).optional(),
  // `turn` correlates entries within a single worker turn. The codebase
  // already uses string turn ids (`t1`, `t-exec-1`, …) at the emit
  // boundary; we adopt that here rather than synthesizing a parallel
  // numeric counter that the projection would have to translate.
  turn: z.string().min(1).optional(),
  ts: z.number().int().nonnegative(),
  policyVersion: z.string().min(1),
  schemaVersion: z.literal(AUDIT_SCHEMA_VERSION),
  actor: ActorRefSchema,
  evidenceRefs: z.array(EvidenceRefSchema).optional(),
  redactionPolicyHash: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .optional(),
});

export type AuditEntryWrapper = z.infer<typeof WrapperFieldsSchema>;

// ── Variant schemas ─────────────────────────────────────────────────────

const ThoughtVariant = z.object({
  kind: z.literal('thought'),
  content: z.string(),
  trigger: z.enum(['pre-tool', 'post-tool', 'plan', 'reflect']).optional(),
  tokenCount: z.number().int().nonnegative().optional(),
});

const ToolCallVariant = z.object({
  kind: z.literal('tool_call'),
  lifecycle: z.enum(['executed', 'failed', 'retried']),
  toolId: z.string().min(1),
  toolVersion: z.string().min(1).optional(),
  argsHash: z.string().regex(/^[0-9a-f]{64}$/),
  argsRedacted: z.unknown(),
  resultHash: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .optional(),
  resultRedacted: z.unknown().optional(),
  latencyMs: z.number().nonnegative().optional(),
  retryOf: z.string().min(1).optional(),
});

const DecisionVariant = z.object({
  kind: z.literal('decision'),
  decisionType: z.enum([
    'route',
    'escalate',
    'approve',
    'reject',
    'synthesize',
    'plan_edit',
    'gate_open',
    'gate_close',
    'tool_authorize',
    'tool_deny',
  ]),
  verdict: z.string(),
  rationale: z.string(),
  ruleId: z.string().min(1).optional(),
  ruleVersion: z.string().min(1).optional(),
  modelId: z.string().min(1).optional(),
  confidence: z.number().min(0).max(1).optional(),
  tier: z.enum(['deterministic', 'heuristic', 'probabilistic']).optional(),
});

const VerdictVariant = z.object({
  kind: z.literal('verdict'),
  source: z.enum(['oracle', 'critic', 'hms', 'goal-grounding']),
  pass: z.union([z.boolean(), z.literal('unknown')]),
  score: z.number().optional(),
  confidence: z.number().min(0).max(1).optional(),
  falsifiableBy: z.array(z.string()).optional(),
  oracleId: z.string().min(1).optional(),
});

const PlanStepVariant = z.object({
  kind: z.literal('plan_step'),
  stepId: z.string().min(1),
  status: z.enum(['queued', 'running', 'done', 'failed', 'skipped']),
  parentStepId: z.string().min(1).optional(),
  subAgentId: z.string().min(1).optional(),
});

const DelegateVariant = z.object({
  kind: z.literal('delegate'),
  phase: z.enum(['spawn', 'return', 'cancel']),
  subAgentId: z.string().min(1),
  persona: z.string().min(1).optional(),
  capabilityToken: z.string().min(1).optional(),
  budgetMs: z.number().int().nonnegative().optional(),
  outputHash: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .optional(),
});

const GateVariant = z.object({
  kind: z.literal('gate'),
  gateName: z.enum(['approval', 'human_input', 'partial_decision', 'workflow']),
  phase: z.enum(['opened', 'answered', 'timed_out', 'auto_closed']),
  decision: z.enum(['approve', 'reject', 'edit', 'answer']).optional(),
  payloadRedacted: z.unknown().optional(),
});

const FinalVariant = z.object({
  kind: z.literal('final'),
  contentHash: z.string().regex(/^[0-9a-f]{64}$/),
  contentRedactedPreview: z.string(),
  assembledFromStepIds: z.array(z.string().min(1)),
  assembledFromDelegateIds: z.array(z.string().min(1)),
});

const VariantSchema = z.discriminatedUnion('kind', [
  ThoughtVariant,
  ToolCallVariant,
  DecisionVariant,
  VerdictVariant,
  PlanStepVariant,
  DelegateVariant,
  GateVariant,
  FinalVariant,
]);

export type AuditEntryVariant = z.infer<typeof VariantSchema>;

// ── Combined entry ──────────────────────────────────────────────────────

/**
 * Composing wrapper + variant via merge keeps the discriminator on the
 * top-level `kind` field (so `entry.kind === 'tool_call'` narrows
 * correctly) while letting the wrapper fields ride along on every variant.
 * Each variant's schema is `wrapper.merge(variant)`; the union is
 * discriminated by `kind`.
 */
export const AuditEntrySchema = z.discriminatedUnion('kind', [
  WrapperFieldsSchema.merge(ThoughtVariant),
  WrapperFieldsSchema.merge(ToolCallVariant),
  WrapperFieldsSchema.merge(DecisionVariant),
  WrapperFieldsSchema.merge(VerdictVariant),
  WrapperFieldsSchema.merge(PlanStepVariant),
  WrapperFieldsSchema.merge(DelegateVariant),
  WrapperFieldsSchema.merge(GateVariant),
  WrapperFieldsSchema.merge(FinalVariant),
]);

export type AuditEntry = z.infer<typeof AuditEntrySchema>;

// ── Helpers ─────────────────────────────────────────────────────────────

/**
 * Strict parse — throws on schema violation. Use at publish boundaries in
 * dev/test, where a malformed entry should be loud. Production projection
 * ingest uses `safeParseAuditEntry` instead so a bad row drops + increments
 * a counter rather than crashing the projection.
 */
export function parseAuditEntry(value: unknown): AuditEntry {
  return AuditEntrySchema.parse(value);
}

export function safeParseAuditEntry(
  value: unknown,
): { ok: true; entry: AuditEntry } | { ok: false; error: z.ZodError } {
  const result = AuditEntrySchema.safeParse(value);
  if (result.success) return { ok: true, entry: result.data };
  return { ok: false, error: result.error };
}

/**
 * Filter helpers for projection bySection grouping. Each accepts an
 * `AuditEntry[]` and narrows by `kind` so callers get the variant-specific
 * fields without a type assertion. Pure; no allocation beyond the filter.
 */
export function pickEntries<K extends AuditEntry['kind']>(
  entries: readonly AuditEntry[],
  kind: K,
): Array<Extract<AuditEntry, { kind: K }>> {
  return entries.filter((e): e is Extract<AuditEntry, { kind: K }> => e.kind === kind);
}
