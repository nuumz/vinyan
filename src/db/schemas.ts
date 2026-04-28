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

const RuleActionSchema = z.enum([
  'escalate',
  'require-oracle',
  'prefer-model',
  'adjust-threshold',
  'assign-worker',
  'promote-capability',
]);

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

// ── EngineProfile row schema ────────────────────────────────────────────

const WorkerStatusSchema = z.enum(['probation', 'active', 'demoted', 'retired']);

export const EngineProfileRowSchema = z.object({
  id: z.string(),
  model_id: z.string(),
  status: WorkerStatusSchema,
  created_at: z.number(),
  promoted_at: z.number().nullable().optional(),
  demoted_at: z.number().nullable().optional(),
  demotion_reason: z.string().nullable().optional(),
  demotion_count: z.number(),
  // Authoritative EngineConfig JSON blob. Required column after migration 022.
  engine_config: z.string().transform((v) => JSON.parse(v) as Record<string, unknown>),
});

// ── AgentProfile row schema (workspace singleton, migration 023) ────────

export const AgentProfileRowSchema = z.object({
  id: z.string(),
  instance_id: z.string(),
  display_name: z.string(),
  description: z.string().nullable().optional(),
  workspace_path: z.string(),
  created_at: z.number(),
  updated_at: z.number(),
  // JSON-encoded AgentPreferences; transformed into plain object for consumers
  preferences_json: z.string().transform((v) => {
    try {
      return JSON.parse(v) as Record<string, unknown>;
    } catch {
      return {} as Record<string, unknown>;
    }
  }),
  // JSON-encoded string[] of declared capabilities
  capabilities_json: z.string().transform((v) => {
    try {
      const parsed = JSON.parse(v);
      return Array.isArray(parsed) ? (parsed as string[]) : [];
    } catch {
      return [] as string[];
    }
  }),
  vinyan_md_path: z.string().nullable().optional(),
  vinyan_md_hash: z.string().nullable().optional(),
});

// ── ExecutionTrace row schema ───────────────────────────────────────────

const TraceOutcomeSchema = z.enum(['success', 'failure', 'timeout', 'escalated', 'partial']);

export const ExecutionTraceRowSchema = z.object({
  id: z.string(),
  task_id: z.string(),
  session_id: z.string().nullable().optional(),
  worker_id: z.string().nullable().optional(),
  agent_id: z.string().nullable().optional(),
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
  pipeline_confidence_composite: z.number().nullable().optional(),
  confidence_decision: z.string().nullable().optional(),
  transcript_gzip: z.instanceof(Buffer).or(z.instanceof(Uint8Array)).nullable().optional(),
  transcript_turns: z.number().nullable().optional(),
  agent_selection_reason: z.string().nullable().optional(),
  capability_requirements: z.string().nullable().optional(),
  capability_analysis: z.string().nullable().optional(),
  selected_capability_profile_id: z.string().nullable().optional(),
  selected_capability_profile_source: z.string().nullable().optional(),
  selected_capability_profile_trust_tier: z.string().nullable().optional(),
  capability_fit_score: z.number().nullable().optional(),
  unmet_capability_ids: z.string().nullable().optional(),
  synthetic_agent_id: z.string().nullable().optional(),
  knowledge_used: z.string().nullable().optional(),
  governance_provenance: z.string().nullable().optional(),
  routing_decision_id: z.string().nullable().optional(),
  policy_version: z.string().nullable().optional(),
  governance_actor: z.string().nullable().optional(),
  decision_timestamp: z.number().nullable().optional(),
  evidence_observed_at: z.number().nullable().optional(),
});
