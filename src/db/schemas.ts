/**
 * Zod schemas for SQLite row deserialization — validates data at the DB boundary.
 *
 * These schemas enforce type correctness when reading from SQLite, preventing
 * malformed or corrupt rows from silently propagating through the system.
 *
 * Source of truth: spec/tdd.md §2 (Canonical Interface Registry)
 */
import { z } from 'zod/v4';

// ── EvolutionaryRule row schema ──────────────────────────────────────────

const RuleActionSchema = z.enum(['escalate', 'require-oracle', 'prefer-model', 'adjust-threshold', 'assign-worker']);

const RuleStatusSchema = z.enum(['probation', 'active', 'retired']);

export const EvolutionaryRuleRowSchema = z
  .object({
    id: z.string(),
    source: z.string(),
    condition: z.string().transform((v) => JSON.parse(v) as Record<string, unknown>),
    action: RuleActionSchema,
    parameters: z.string().transform((v) => JSON.parse(v) as Record<string, unknown>),
    status: RuleStatusSchema,
    created_at: z.number(),
    effectiveness: z.number(),
    specificity: z.number(),
    superseded_by: z
      .string()
      .nullable()
      .transform((v) => v ?? undefined),
    origin: z
      .enum(['local', 'a2a', 'mcp'])
      .nullable()
      .transform((v) => v ?? 'local')
      .optional(),
  })
  .transform((row) => ({
    id: row.id,
    source: row.source as 'sleep-cycle' | 'manual',
    condition: row.condition,
    action: row.action,
    parameters: row.parameters,
    status: row.status,
    createdAt: row.created_at,
    effectiveness: row.effectiveness,
    specificity: row.specificity,
    supersededBy: row.superseded_by,
    origin: row.origin,
  }));

// ── WorkerProfile row schema ────────────────────────────────────────────

const WorkerStatusSchema = z.enum(['probation', 'active', 'demoted', 'retired']);

export const WorkerProfileRowSchema = z.object({
  id: z.string(),
  model_id: z.string(),
  model_version: z.string().nullable().optional(),
  temperature: z.number(),
  tool_allowlist: z
    .string()
    .nullable()
    .optional()
    .transform((v) => (v ? (JSON.parse(v) as string[]) : undefined)),
  system_prompt_tpl: z.string().nullable().optional(),
  max_context_tokens: z.number().nullable().optional(),
  status: WorkerStatusSchema,
  created_at: z.number(),
  promoted_at: z.number().nullable().optional(),
  demoted_at: z.number().nullable().optional(),
  demotion_reason: z.string().nullable().optional(),
  demotion_count: z.number(),
});

// ── ExecutionTrace row schema ───────────────────────────────────────────

const TraceOutcomeSchema = z.enum(['success', 'failure', 'timeout', 'escalated']);

export const ExecutionTraceRowSchema = z.object({
  id: z.string(),
  task_id: z.string(),
  session_id: z.string().nullable().optional(),
  worker_id: z.string().nullable().optional(),
  timestamp: z.number(),
  routing_level: z.number(),
  task_type_signature: z.string().nullable().optional(),
  approach: z.string(),
  approach_description: z.string().nullable().optional(),
  risk_score: z.number().nullable().optional(),
  oracle_verdicts: z.string(),
  quality_composite: z.number().nullable().optional(),
  quality_arch: z.number().nullable().optional(),
  quality_efficiency: z.number().nullable().optional(),
  quality_simplification: z.number().nullable().optional(),
  quality_testmutation: z.number().nullable().optional(),
  model_used: z.string(),
  tokens_consumed: z.number(),
  duration_ms: z.number(),
  outcome: TraceOutcomeSchema,
  failure_reason: z.string().nullable().optional(),
  affected_files: z.string(),
  prediction_error: z.string().nullable().optional(),
  validation_depth: z.enum(['structural', 'structural_and_tests', 'full_shadow']).nullable().optional(),
  shadow_validation: z.string().nullable().optional(),
  exploration: z.unknown().nullable().optional(),
  framework_markers: z.string().nullable().optional(),
  worker_selection_audit: z.string().nullable().optional(),
});
