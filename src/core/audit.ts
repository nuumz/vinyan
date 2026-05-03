/**
 * Unified Audit Entry — the canonical shape every observable orchestrator
 * action lands as for the A8 (Traceable Accountability) audit surface.
 *
 * One discriminated union, twelve variants. The wrapper carries cross-cutting
 * provenance (id, ts, policyVersion, actor, evidenceRefs, hierarchy ids);
 * the variant carries the kind-specific payload. Validated via zod at the
 * publish boundary (dev/test) and at the projection ingest boundary (prod
 * safeParse + drop+counter on schema fail).
 *
 * Persistence path: `audit:entry` events flow through the existing
 * `task_events` table (one row per entry). Live UI synthesizes this log
 * from legacy events; historical replay reads the durable rows directly.
 *
 * SCHEMA VERSIONING — `AUDIT_SCHEMA_VERSION` is 2 for new emits. The reader
 * accepts both 1 and 2; v1 rows persisted before the Phase-2 expansion are
 * still folded by the projection. Bumping the constant is what triggers a
 * breakage; renames are only safe under a new version.
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
 *
 * Phase 2 adds `subagent_output` so a `kind:'final'` row can carry a
 * verifiable link to the sub-agent's emitted output without duplicating
 * the bytes.
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
  z.object({
    type: z.literal('subagent_output'),
    subAgentId: z.string().min(1),
    outputHash: z.string().regex(/^[0-9a-f]{64}$/),
  }),
]);

export type EvidenceRef = z.infer<typeof EvidenceRefSchema>;

// ── Wrapper (cross-cutting fields shared by every variant) ──────────────

/**
 * Bumped to 2 for the Phase-2 hierarchy expansion. Reader accepts both
 * (`schemaVersion: 1 | 2`); writers always stamp 2. A bump to 3 would be
 * required for any breaking shape change (rename, removed field).
 */
export const AUDIT_SCHEMA_VERSION = 2 as const;

/**
 * Schema versions the reader accepts. v1 rows landed before the Phase-2
 * hierarchy fields existed; the wrapper makes those fields optional so a
 * v1 row parses cleanly under the v2 schema.
 */
const ACCEPTED_SCHEMA_VERSIONS = z.union([z.literal(1), z.literal(2)]);

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
  schemaVersion: ACCEPTED_SCHEMA_VERSIONS,
  actor: ActorRefSchema,
  evidenceRefs: z.array(EvidenceRefSchema).optional(),
  redactionPolicyHash: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .optional(),
  // ── Hierarchy ids (Phase 2) ──────────────────────────────────────────
  /** Owning chat session. Optional because root-task emits may pre-date the cache that backfills sessionId. */
  sessionId: z.string().min(1).optional(),
  /**
   * Workflow id. Documentation alias for `taskId` — Vinyan does not maintain
   * a separate workflow identity. Emitters either omit (legacy) or set to
   * the same value as `taskId`. Validators do NOT enforce equality at this
   * layer; the emit-helper does.
   */
  workflowId: z.string().min(1).optional(),
  /** Sub-task scope when the row pertains to a delegate / wf-step / coding-cli child task. */
  subTaskId: z.string().min(1).optional(),
  /** Sub-agent scope when the row originated inside a delegate's worker context. */
  subAgentId: z.string().min(1).optional(),
});

export type AuditEntryWrapper = z.infer<typeof WrapperFieldsSchema>;

// ── Variant schemas ─────────────────────────────────────────────────────

const ThoughtVariant = z.object({
  kind: z.literal('thought'),
  content: z.string(),
  trigger: z.enum(['pre-tool', 'post-tool', 'plan', 'reflect', 'compaction']).optional(),
  tokenCount: z.number().int().nonnegative().optional(),
  /** ULID of the audit entry that closed this thought block (e.g., the next tool_call). */
  closedBy: z.string().min(1).optional(),
});

const ToolCallVariant = z.object({
  kind: z.literal('tool_call'),
  lifecycle: z.enum(['proposed', 'authorized', 'denied', 'executed', 'failed', 'retried']),
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
  /** Audit-entry id of the prior attempt this row supersedes. */
  retryOf: z.string().min(1).optional(),
  /** Reason text recorded on a denial — surfaces in the UI denial drawer. */
  denyReason: z.string().min(1).optional(),
  /** Capability-token id (when the contract layer issued one for this call). */
  capabilityTokenId: z.string().min(1).optional(),
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

/**
 * Sub-task lifecycle — emitted at delegate / workflow-step child-task
 * spawn / return / cancel. Distinct from `subagent`: this row scopes the
 * unit-of-work; the sub-agent is the persona doing it. In today's 1:1
 * mapping the two coincide, but the schema keeps them separate so a
 * future move to many-to-one (one sub-agent owning N sub-tasks) doesn't
 * require a wire change.
 */
const SubTaskVariant = z.object({
  kind: z.literal('subtask'),
  /** SubTaskId — required on the variant for downstream filters even though the wrapper carries it too. */
  subTaskId: z.string().min(1),
  phase: z.enum(['spawn', 'progress', 'return', 'cancel']),
  /** sha256 of the sub-task's final output, when phase='return'. */
  outputHash: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .optional(),
});

/**
 * Sub-agent lifecycle — emitted when a delegate's persona/worker is
 * spawned, returns, or is cancelled. Today's invariant:
 * `subAgentId === subTaskId`. See `subAgentIdFromSubTask` in
 * `agent-vocabulary.ts` — the mapping is centralised so a future
 * decoupling is one edit.
 */
const SubAgentVariant = z.object({
  kind: z.literal('subagent'),
  subAgentId: z.string().min(1),
  phase: z.enum(['spawn', 'return', 'cancel']),
  persona: z.string().min(1).optional(),
  capabilityTokenId: z.string().min(1).optional(),
  budgetMs: z.number().int().nonnegative().optional(),
  outputHash: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .optional(),
});

/**
 * Legacy `delegate` variant — pre-Phase-2 sub-agent emit shape. Kept as a
 * back-compat reader so v1 rows still parse. New emit sites use
 * `kind:'subagent'` (carries the same data with the new wrapper fields).
 * @deprecated Phase 2.5 onwards. Remove one release after every emit
 * site has migrated to `kind:'subagent'`.
 */
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

/**
 * Workflow-level lifecycle — one row per plan transition. `planHash`
 * surfaces re-plans without forcing a separate `workflowId` (Vinyan's
 * workflow id is the task id; `planHash` distinguishes versions of the
 * plan within that workflow).
 */
const WorkflowVariant = z.object({
  kind: z.literal('workflow'),
  phase: z.enum(['planned', 'started', 'paused', 'resumed', 'completed', 'failed']),
  /** sha256 of the canonical-JSON of the plan at this transition. */
  planHash: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .optional(),
});

/**
 * Session-level lifecycle — emitted by SessionManager. Today these go to
 * JSONL only; Phase 2.4 wires them to the bus + manifest so the audit log
 * carries them alongside task-scoped rows.
 */
const SessionVariant = z.object({
  kind: z.literal('session'),
  phase: z.enum(['created', 'message', 'archived', 'unarchived', 'deleted', 'compacted', 'restored', 'purged']),
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
  /** Phase 2: assembling sub-agent ids — distinct from steps because one step may host multiple sub-agents. */
  assembledFromSubAgentIds: z.array(z.string().min(1)).optional(),
});

const VariantSchema = z.discriminatedUnion('kind', [
  ThoughtVariant,
  ToolCallVariant,
  DecisionVariant,
  VerdictVariant,
  PlanStepVariant,
  SubTaskVariant,
  SubAgentVariant,
  DelegateVariant,
  WorkflowVariant,
  SessionVariant,
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
  WrapperFieldsSchema.extend(ThoughtVariant.shape),
  WrapperFieldsSchema.extend(ToolCallVariant.shape),
  WrapperFieldsSchema.extend(DecisionVariant.shape),
  WrapperFieldsSchema.extend(VerdictVariant.shape),
  WrapperFieldsSchema.extend(PlanStepVariant.shape),
  WrapperFieldsSchema.extend(SubTaskVariant.shape),
  WrapperFieldsSchema.extend(SubAgentVariant.shape),
  WrapperFieldsSchema.extend(DelegateVariant.shape),
  WrapperFieldsSchema.extend(WorkflowVariant.shape),
  WrapperFieldsSchema.extend(SessionVariant.shape),
  WrapperFieldsSchema.extend(GateVariant.shape),
  WrapperFieldsSchema.extend(FinalVariant.shape),
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
