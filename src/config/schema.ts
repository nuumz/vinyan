/**
 * Config Schema — Zod schema for vinyan.json matching TDD §2.
 *
 * Phase 0 config: version + oracles only.
 * Phase 1+ configs (routing, isolation, evolution, escalation) are accepted
 * under an optional `phase1` namespace for forward-compatibility but are
 * NOT consumed by any Phase 0 code path.
 */
import { z } from "zod/v4";

const OracleConfigSchema = z.object({
  enabled: z.boolean().default(true),
  languages: z.array(z.string()).optional(),
  command: z.string().optional(),
  timeout_ms: z.number().positive().optional(),
  /** Trust tier — determines confidence range and conflict resolution priority. */
  tier: z.enum(["deterministic", "heuristic", "probabilistic", "speculative"]).default("deterministic"),
  /** Behavior on timeout: 'block' = fail-closed, 'warn' = skip oracle and continue. */
  timeout_behavior: z.enum(["block", "warn"]).default("block"),
});

// ─── Phase 1+ schemas (not used in Phase 0) ─────────────────────────

/** 4-level routing thresholds — Phase 1 Orchestrator (→ TDD §16). */
const LatencyBudgetsSchema = z.object({
  l0: z.number().positive().default(100),
  l1: z.number().positive().default(2000),
  l2: z.number().positive().default(10000),
  l3: z.number().positive().default(60000),
}).refine(
  data => data.l0 < data.l1 && data.l1 < data.l2 && data.l2 < data.l3,
  { message: "Latency budgets must be strictly ordered: l0 < l1 < l2 < l3" },
);

const RoutingConfigSchema = z.object({
  l0_max_risk: z.number().min(0).max(1).default(0.2),
  l1_max_risk: z.number().min(0).max(1).default(0.4),
  l2_max_risk: z.number().min(0).max(1).default(0.7),
  l0_l1_model: z.string().default("claude-haiku"),
  l2_model: z.string().default("claude-sonnet"),
  l3_model: z.string().default("claude-opus"),
  l1_budget_tokens: z.number().positive().default(10000),
  l2_budget_tokens: z.number().positive().default(50000),
  l3_budget_tokens: z.number().positive().default(100000),
  latency_budgets_ms: LatencyBudgetsSchema.default(() => defaults(LatencyBudgetsSchema)),
}).refine(
  data => data.l0_max_risk < data.l1_max_risk && data.l1_max_risk < data.l2_max_risk,
  { message: "Risk thresholds must be strictly ordered: l0_max_risk < l1_max_risk < l2_max_risk" },
);

const IsolationConfigSchema = z.object({
  l0_max_risk: z.number().min(0).max(1).default(0.2),
  l1_max_risk: z.number().min(0).max(1).default(0.7),
  container_image: z.string().default("vinyan-sandbox:latest"),
  /** L2 container overlay strategy: 'tmpdir' = host-created temp dirs, 'docker-tmpfs' = in-container tmpfs */
  overlay_strategy: z.enum(["tmpdir", "docker-tmpfs"]).default("tmpdir"),
  /** Shadow validation budget in ms (async, separate from L3 online 60s budget) */
  shadow_budget_ms: z.number().positive().default(300_000),
  /** Max PHE workers for shadow validation (0 = no PHE, just test suite) */
  shadow_phe_max_workers: z.number().min(0).max(5).default(2),
});

const EvolutionConfigSchema = z.object({
  enabled: z.boolean().default(true),
  sleep_cycle_interval_sessions: z.number().positive().default(20),
  probation_sessions: z.number().positive().default(10),
  min_effectiveness: z.number().min(0).max(1).default(0.7),
  /** Data gate: minimum traces before Sleep Cycle activates */
  sleep_cycle_min_traces: z.number().positive().default(100),
  /** Data gate: minimum distinct task types for Sleep Cycle */
  sleep_cycle_min_task_types: z.number().positive().default(5),
  /** Data gate: minimum traces before Evolution Engine activates */
  evolution_min_traces: z.number().positive().default(200),
  /** Data gate: minimum active skills before Evolution Engine activates */
  evolution_min_active_skills: z.number().positive().default(1),
  /** Data gate: minimum completed sleep cycles before Evolution Engine activates */
  evolution_min_sleep_cycles: z.number().positive().default(3),
});

const EscalationConfigSchema = z.object({
  max_retries_before_human: z.number().positive().default(3),
  risk_threshold_for_notification: z.number().min(0).max(1).default(0.8),
  channel: z.enum(["matrix", "slack", "stdout"]).default("stdout"),
});

const Phase1ConfigSchema = z.object({
  routing: RoutingConfigSchema.default(() => defaults(RoutingConfigSchema)),
  isolation: IsolationConfigSchema.default(() => defaults(IsolationConfigSchema)),
  evolution: EvolutionConfigSchema.default(() => defaults(EvolutionConfigSchema)),
  escalation: EscalationConfigSchema.default(() => defaults(EscalationConfigSchema)),
});

// ─── Phase 4 schema (Fleet Governance) ──────────────────────────────

const Phase4ConfigSchema = z.object({
  worker_identity_granularity: z.enum(["model", "model+temp", "full"]).default("full"),
  probation_min_tasks: z.number().positive().default(30),
  demotion_window_tasks: z.number().positive().default(30),
  demotion_max_reentries: z.number().min(0).default(3),
  reentry_cooldown_sessions: z.number().positive().default(50),
  epsilon_worker: z.number().min(0.03).max(0.30).default(0.10),
  diversity_floor_pct: z.number().min(0.05).max(0.50).default(0.15),
  max_active_workers: z.number().positive().default(10),
  capability_min_traces: z.number().positive().default(5),
  negative_capability_threshold: z.number().min(0).max(1).default(0.6),
  staleness_penalty_per_cycle: z.number().min(0).max(1).default(0.9),
});

// ─── Phase 5 schema (Self-Hosted ENS) ────────────────────────────────

const Phase5APIConfigSchema = z.object({
  enabled: z.boolean().default(false),
  port: z.number().positive().default(3927),
  bind: z.string().default("127.0.0.1"),
  auth_required: z.boolean().default(true),
  session_compaction_threshold: z.number().positive().default(20),
  rate_limit_enabled: z.boolean().default(true),
});

const Phase5InstancesConfigSchema = z.object({
  enabled: z.boolean().default(false),
  listen_port: z.number().positive().default(3928),
  heartbeat_interval_ms: z.number().positive().default(15_000),
  heartbeat_timeout_ms: z.number().positive().default(45_000),
  peers: z.array(z.object({
    url: z.string(),
    trust_level: z.enum(["untrusted", "semi-trusted", "trusted"]).default("untrusted"),
  })).default([]),
});

const Phase5PolyglotConfigSchema = z.object({
  enabled_languages: z.array(z.string()).default(["typescript"]),
  language_detection: z.enum(["auto", "config"]).default("auto"),
});

const Phase5MCPConfigSchema = z.object({
  server_enabled: z.boolean().default(false),
  client_servers: z.array(z.object({
    name: z.string(),
    command: z.string(),
    trust_level: z.enum(["untrusted", "semi-trusted", "trusted"]).default("untrusted"),
  })).default([]),
});

const Phase5ConfigSchema = z.object({
  api: Phase5APIConfigSchema.optional(),
  instances: Phase5InstancesConfigSchema.optional(),
  polyglot: Phase5PolyglotConfigSchema.optional(),
  mcp: Phase5MCPConfigSchema.optional(),
});

// ─── Helper ──────────────────────────────────────────────────────────

/** Helper: parse an empty object to get all defaults from a schema with defaulted fields. */
function defaults<T extends z.ZodType>(schema: T): z.output<T> {
  return schema.parse({});
}

// ─── Root schema ─────────────────────────────────────────────────────

export const VinyanConfigSchema = z.object({
  version: z.number().default(1),
  oracles: z.record(z.string(), OracleConfigSchema).default({
    ast: { enabled: true, languages: ["typescript"], tier: "deterministic", timeout_behavior: "block" },
    type: { enabled: true, command: "tsc --noEmit", tier: "deterministic", timeout_behavior: "block" },
    dep: { enabled: true, tier: "heuristic", timeout_behavior: "block" },
    test: { enabled: false, timeout_ms: 5000, tier: "deterministic", timeout_behavior: "warn" },
    lint: { enabled: false, timeout_ms: 1000, tier: "deterministic", timeout_behavior: "warn" },
  }),
  /** Phase 1+ config — accepted for forward-compat, not used in Phase 0. */
  phase1: Phase1ConfigSchema.optional(),
  /** Phase 4 config — Fleet Governance parameters. */
  phase4: Phase4ConfigSchema.optional(),
  /** Phase 5 config — Self-Hosted ENS parameters. */
  phase5: Phase5ConfigSchema.optional(),
});

export type VinyanConfig = z.infer<typeof VinyanConfigSchema>;
export type OracleConfig = z.infer<typeof OracleConfigSchema>;
