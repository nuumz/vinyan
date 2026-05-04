/**
 * Adaptive Parameter Registry — declarative source of truth for every
 * "ceiling parameter" that may be tuned at runtime.
 *
 * Distinguished from **Guard axioms** (A1, A3, A4, A6 — immutable
 * contracts): ceiling parameters are NUMERIC limits that calcify
 * capability without being load-bearing for safety. They live here so
 * sleep-cycle / operator can adapt them, audited via `parameter-ledger`.
 *
 * Adding a new parameter:
 *   1. Add an entry to `PARAMETERS` below with `default`, `range`,
 *      `axiom` category, `owner` module, and `tunable: true | false`.
 *   2. Replace the module-scope constant with a `params.getNumber(key)`
 *      call (or `getDurationMs`, `getRecord` for richer types).
 *   3. Existing tests still pass — defaults preserve byte-identical
 *      behavior when no override is in the ledger.
 *
 * Cross-reference: `docs/foundation/agent-vocabulary.md` and the
 * upcoming "Guard axioms vs Ceiling parameters" section in
 * `docs/foundation/concept.md`.
 */

export const PARAMETER_TYPES = ['number', 'integer', 'duration-ms', 'number-record', 'boolean'] as const;
export type ParameterType = (typeof PARAMETER_TYPES)[number];

export const AXIOM_CATEGORIES = [
  'A1',
  'A2',
  'A3',
  'A4',
  'A5',
  'A6',
  'A7',
  'A8',
  'A9',
  'A10',
  'A11',
  'A12',
  'A13',
  'A14',
] as const;
export type AxiomCategory = (typeof AXIOM_CATEGORIES)[number];

/**
 * Discriminated definition. Per-type fields are validated at lookup
 * time; the registry keeps the shape simple so authoring is easy.
 */
export interface ParameterDef {
  readonly key: string;
  readonly type: ParameterType;
  /**
   * Default literal value. For `number-record`, an object of number
   * values; for `boolean`, a literal `true`/`false`.
   */
  readonly default: number | boolean | Readonly<Record<string, number>>;
  /** Optional inclusive range (applies to `number`, `integer`, `duration-ms`). */
  readonly range?: readonly [number, number];
  readonly axiom: AxiomCategory;
  /** Module that owns this parameter — used for ledger attribution. */
  readonly owner: string;
  readonly description: string;
  /**
   * Whether sleep-cycle adaptation may modify this. `false` means: yes,
   * the value lives in the registry, but it is NOT permitted to drift —
   * operator config or human edit only.
   */
  readonly tunable: boolean;
}

// ── The registry ────────────────────────────────────────────────────────

const PARAMETERS_DEF: readonly ParameterDef[] = [
  // ── Intent resolver (A3 governance + A2 uncertainty + A4 freshness) ──
  {
    key: 'intent.deterministic_skip_threshold',
    type: 'number',
    default: 0.85,
    range: [0, 1],
    axiom: 'A3',
    owner: 'intent-resolver',
    description:
      'Confidence at which a deterministic candidate skips the LLM advisory. Higher → more LLM calls; lower → more deterministic-only routing.',
    tunable: true,
  },
  {
    key: 'intent.cache_ttl_ms',
    type: 'duration-ms',
    default: 30_000,
    range: [1_000, 24 * 60 * 60 * 1000],
    axiom: 'A4',
    owner: 'intent-resolver',
    description: 'How long an intent classification stays in the LRU+TTL cache before re-resolution.',
    tunable: true,
  },
  {
    key: 'intent.llm_uncertain_threshold',
    type: 'number',
    default: 0.5,
    range: [0, 1],
    axiom: 'A2',
    owner: 'intent-merge',
    description: 'LLM confidence below which the merge result is flagged uncertain (clarification candidate).',
    tunable: true,
  },

  // ── Risk router (A6 routing) ──
  {
    key: 'risk_router.thresholds',
    type: 'number-record',
    default: { l0: 0.2, l1: 0.4, l2: 0.7 },
    axiom: 'A6',
    owner: 'risk-router',
    description:
      'Risk score → routing level breakpoints. Below l0 → L0 reflex; below l1 → L1 heuristic; below l2 → L2 analytical; otherwise L3.',
    tunable: true,
  },

  // ── Sleep cycle (A7 learning) ──
  {
    key: 'sleep_cycle.pattern_min_frequency',
    type: 'integer',
    default: 5,
    range: [1, 1000],
    axiom: 'A7',
    owner: 'sleep-cycle',
    description: 'Minimum number of supporting observations before a pattern is eligible for promotion.',
    tunable: true,
  },
  {
    key: 'sleep_cycle.pattern_min_confidence',
    type: 'number',
    default: 0.6,
    range: [0, 1],
    axiom: 'A7',
    owner: 'sleep-cycle',
    description: 'Minimum Wilson lower-bound confidence required for a pattern to promote.',
    tunable: true,
  },

  // ── Oracle circuit breaker (A6 routing / A9 degradation) ──
  {
    key: 'oracle.circuit_breaker_failure_threshold',
    type: 'integer',
    default: 3,
    range: [1, 100],
    axiom: 'A9',
    owner: 'oracle-circuit-breaker',
    description: 'Consecutive failures before an oracle circuit opens.',
    tunable: true,
  },
  {
    key: 'oracle.circuit_breaker_reset_timeout_ms',
    type: 'duration-ms',
    default: 60_000,
    range: [1_000, 60 * 60 * 1000],
    axiom: 'A9',
    owner: 'oracle-circuit-breaker',
    description: 'Open-circuit cool-down before the breaker probes recovery.',
    tunable: true,
  },

  // ── Memory provider (A4 freshness) ──
  {
    key: 'memory.recency_half_life_ms',
    type: 'duration-ms',
    default: 14 * 24 * 60 * 60 * 1000,
    range: [60_000, 365 * 24 * 60 * 60 * 1000],
    axiom: 'A4',
    owner: 'memory-default-provider',
    description: 'Half-life used by the memory ranker recency decay.',
    tunable: true,
  },

  // ── Working memory (A2 uncertainty / bounded scratchpad) ──
  {
    key: 'working_memory.max_failed_approaches',
    type: 'integer',
    default: 20,
    range: [1, 1000],
    axiom: 'A2',
    owner: 'working-memory',
    description:
      'Max failed approaches retained before lowest-confidence eviction. Acts as a soft ceiling on retry-loop memory.',
    tunable: true,
  },
  {
    key: 'working_memory.max_hypotheses',
    type: 'integer',
    default: 10,
    range: [1, 200],
    axiom: 'A2',
    owner: 'working-memory',
    description: 'Active hypotheses retained per task before lowest-confidence eviction.',
    tunable: true,
  },
  {
    key: 'working_memory.max_uncertainties',
    type: 'integer',
    default: 10,
    range: [1, 200],
    axiom: 'A2',
    owner: 'working-memory',
    description: 'Unresolved clarifications retained per task before FIFO eviction.',
    tunable: true,
  },

  // ── Sleep-cycle pattern promotion (A7) ──
  {
    key: 'sleep_cycle.promotion_wilson_threshold',
    type: 'number',
    default: 0.95,
    range: [0.5, 0.99],
    axiom: 'A7',
    owner: 'sleep-cycle',
    description:
      'Wilson lower-bound threshold for promoting a pattern to a commonsense rule. Higher = stricter, fewer/safer promotions; lower = faster learning at higher false-positive risk.',
    tunable: true,
  },
  {
    key: 'sleep_cycle.promotion_min_observations',
    type: 'integer',
    default: 30,
    range: [5, 1000],
    axiom: 'A7',
    owner: 'sleep-cycle',
    description: 'Minimum observation count gating Wilson promotion.',
    tunable: true,
  },

  // ── Critic / debate routing (A1) ──
  {
    key: 'critic.debate_trigger_risk_threshold',
    type: 'number',
    default: 0.7,
    range: [0.3, 0.99],
    axiom: 'A1',
    owner: 'critic-engine',
    description:
      'Risk score above which the 3-seat architecture debate fires (advocate / counter / architect). Each debate is ~3× LLM cost.',
    tunable: true,
  },

  // ── Autonomous skill creator (A7 / A11 RFC) ──
  {
    key: 'autonomous_skills.gate_confidence_floor',
    type: 'number',
    default: 0.7,
    range: [0.5, 0.99],
    axiom: 'A7',
    owner: 'autonomous-skill-creator',
    description:
      'Minimum gate confidence for an autonomous skill draft to be promoted to a proposal. Below this, draft is silently dropped.',
    tunable: true,
  },

  // ── Approval gate (A6) ──
  {
    key: 'approval.timeout_ms',
    type: 'duration-ms',
    default: 300_000,
    range: [10_000, 60 * 60 * 1000],
    axiom: 'A6',
    owner: 'approval-gate',
    description: 'Default time window for human approval before auto-reject. UI/operator deployments may want longer.',
    tunable: true,
  },

  // ── Verifier-side confidence discount on injected priors (A5) ──
  {
    key: 'verify.injected_prior_discount',
    type: 'number',
    default: 0.85,
    range: [0, 1],
    axiom: 'A5',
    owner: 'phase-verify',
    description:
      'Multiplier applied to oracle verdict confidence when the verified ' +
      'generation depended on a CoT-inject decision (ruleId=collab-cot-inject-v1) ' +
      'targeting the current sub-task. Lower → stricter A5 honesty about ' +
      'memory-as-evidence dependency; sleep-cycle may tune within range.',
    tunable: true,
  },
  // ── CoT continuity (A10 + A4 freshness) ──
  {
    key: 'cot.reuse_max_staleness_ms',
    type: 'duration-ms',
    default: 300_000,
    range: [10_000, 24 * 60 * 60 * 1000],
    axiom: 'A10',
    owner: 'collaboration-block',
    description:
      'Drop a prior-round thought from CoT injection when its age exceeds this. ' +
      'Bounds the staleness window introduced when a sub-task pauses on an approval / ' +
      'human-input gate between rounds — A10 grounded-fresh contract. A4 also benefits ' +
      'because file-hash drift correlates with elapsed time.',
    tunable: true,
  },
  // ── Role protocol — exit + retry tuning (A2/A6) ──
  {
    key: 'role.exit.confidence_floor',
    type: 'number',
    default: 0.85,
    range: [0.7, 0.95],
    axiom: 'A2',
    owner: 'role-protocol',
    description:
      'Override threshold for any `evidence-confidence` exit criterion in a role protocol. ' +
      'When set, replaces the per-criterion threshold at run time so operators can tighten ' +
      "or loosen exit thresholds without rewriting the protocol declaration. The protocol's " +
      'declared threshold is used when this override is at its default ceiling (i.e. when ' +
      "RoleProtocolRunOptions doesn't pass an override).",
    tunable: true,
  },
  {
    key: 'role.step.retry_max',
    type: 'integer',
    default: 0,
    range: [0, 5],
    axiom: 'A6',
    owner: 'role-protocol',
    description:
      'Default `retryMax` for protocol steps that do not declare one. A blocking-oracle ' +
      'failure on such a step is retried up to this many times before being marked ' +
      'oracle-blocked. Higher values cost tokens; lower values fail-fast on systematic ' +
      'miswriting.',
    tunable: true,
  },

  // ── Reality anchoring — DelusionDetector + PsychosisMonitor (A4 + A7) ──
  {
    key: 'psychosis.delusion_ceiling',
    type: 'number',
    default: 0.15,
    range: [0.05, 0.5],
    axiom: 'A4',
    owner: 'reality-anchor',
    description:
      'Per-trace delusion-rate ceiling that PsychosisMonitor treats as a trigger. ' +
      'When the fraction of stale citations in a verify cycle exceeds this, the ' +
      'persona enters quarantine candidacy. Lower = stricter (more re-grounding); ' +
      'higher = more tolerant of A4 hash drift.',
    tunable: true,
  },
  {
    key: 'psychosis.prediction_error_ceiling',
    type: 'number',
    default: 0.4,
    range: [0.1, 0.8],
    axiom: 'A7',
    owner: 'reality-anchor',
    description:
      'Mean prediction-error magnitude (over the rolling per-persona window) above ' +
      'which PsychosisMonitor fires. A7 — sustained gap between persona predictions ' +
      'and oracle outcomes is a learning-loop signal, not a single-task one.',
    tunable: true,
  },
  {
    key: 'psychosis.contradiction_ceiling',
    type: 'number',
    default: 0.2,
    range: [0.05, 0.5],
    axiom: 'A1',
    owner: 'reality-anchor',
    description:
      'Mean fraction of failing oracles per trace (over the persona window) above ' +
      'which PsychosisMonitor fires. Multiple oracles disagreeing with a persona ' +
      'across many tasks is an A1-violation-class signal.',
    tunable: true,
  },
  {
    key: 'psychosis.goal_drift_ceiling',
    type: 'number',
    default: 0.3,
    range: [0.1, 0.6],
    axiom: 'A10',
    owner: 'reality-anchor',
    description:
      'Reserved for A10 goal-grounding integration in Phase C4. Fraction of traces ' +
      'in the window whose goal-grounding action ≠ "continue" — i.e. goal drift / ' +
      're-clarify / abort. Defined in the registry now so C3 can reference the key; ' +
      'enforcement lands when the re-grounding state machine consumes it.',
    tunable: true,
  },
  {
    key: 'reality_anchor.shadow_clean_streak_required',
    type: 'integer',
    default: 5,
    range: [1, 50],
    axiom: 'A7',
    owner: 'reality-anchor',
    description:
      'Number of consecutive clean traces (success outcome AND no delusion) a persona ' +
      'in `shadow-mode` must accumulate before the regrounder transitions them back to ' +
      '`active`. Lower = faster reentry but riskier; higher = stricter A4-honest recovery.',
    tunable: true,
  },

  // ── Skill admission (A3 governance) ──
  {
    key: 'skill.admission.min_overlap_ratio',
    type: 'number',
    default: 0,
    range: [0, 1],
    axiom: 'A3',
    owner: 'skill-admission',
    description:
      "Minimum fraction of a skill's tags that must match the persona's acquirableSkillTags " +
      'for the skill to be promoted to `bound`. Default 0 means boolean match suffices ' +
      '(any-tag-matches-any-pattern). Raise post-MVP to tighten admission without code changes.',
    tunable: true,
  },

  // ── World-graph retention (A4) ──
  {
    key: 'world_graph.retention_max_age_days',
    type: 'integer',
    default: 30,
    range: [7, 730],
    axiom: 'A4',
    owner: 'world-graph',
    description: 'Max age of facts before retention pass evicts them.',
    tunable: true,
  },
  {
    key: 'world_graph.retention_max_fact_count',
    type: 'integer',
    default: 50_000,
    range: [1_000, 5_000_000],
    axiom: 'A4',
    owner: 'world-graph',
    description: 'Hard cap on total facts before retention triggers.',
    tunable: true,
  },

  // ── Yinyan T3 (critic-augmented verification + kernel activation) ──
  {
    key: 'thinking.multi_hypothesis_enabled',
    type: 'boolean',
    default: false,
    axiom: 'A1',
    owner: 'orchestrator',
    description:
      'Kill-switch for the multi-hypothesis kernel from PR #44. Default false: the kernel substrate is wired but dormant. T5 calibrator may flip this true once per-task-type backtests show positive Wilson-LB lift over single-shot.',
    tunable: true,
  },
  {
    key: 'critic.debate_margin_threshold',
    type: 'number',
    default: 0.05,
    range: [0.01, 0.5],
    axiom: 'A1',
    owner: 'critic',
    description:
      'When the kernel selector reports a winner-vs-runnerUp margin below this threshold, the debate-router fires regardless of risk score. Tunable per task type by T5 calibrator.',
    tunable: true,
  },

  // ── Yinyan T5 (per-task-type thinking calibration) ──
  {
    key: 'thinking.budget_table',
    type: 'number-record',
    // Sparse: keys are dynamic, populated by the sleep-cycle calibrator
    // as `${taskType}:${thinkingMode}` → recommended max-output-token
    // budget. Empty default means "no per-type override exists yet" —
    // the compiler falls through to its profile-default budget for any
    // (taskType, mode) pair the calibrator hasn't promoted.
    default: {},
    axiom: 'A7',
    owner: 'sleep-cycle-t5',
    description:
      'Per-task-type thinking budget table. Keys: "${taskType}:${thinkingMode}". Values: token budget. Sleep-cycle T5 promotes entries only when the per-type readiness gate passes AND the walk-forward backtest accepts the proposed budget. P9 monotonicity: an existing entry MUST not regress more than `decay_rate` per cycle (enforced pre-write by the calibrator).',
    tunable: true,
  },
];

const REGISTRY: ReadonlyMap<string, ParameterDef> = (() => {
  const map = new Map<string, ParameterDef>();
  for (const def of PARAMETERS_DEF) {
    if (map.has(def.key)) {
      throw new Error(`parameter-registry: duplicate key "${def.key}"`);
    }
    map.set(def.key, def);
  }
  return map;
})();

export function getParameterDef(key: string): ParameterDef | undefined {
  return REGISTRY.get(key);
}

export function listParameterDefs(): readonly ParameterDef[] {
  return PARAMETERS_DEF;
}

/**
 * Validate that a value is shape-compatible with a parameter def. Returns
 * a typed result so callers can surface the reason without throwing.
 */
export function validateParameterValue(
  def: ParameterDef,
  value: unknown,
): { ok: true } | { ok: false; reason: string } {
  switch (def.type) {
    case 'number': {
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        return { ok: false, reason: 'expected finite number' };
      }
      if (def.range && (value < def.range[0] || value > def.range[1])) {
        return { ok: false, reason: `out of range [${def.range[0]}, ${def.range[1]}]` };
      }
      return { ok: true };
    }
    case 'integer': {
      if (typeof value !== 'number' || !Number.isInteger(value)) {
        return { ok: false, reason: 'expected integer' };
      }
      if (def.range && (value < def.range[0] || value > def.range[1])) {
        return { ok: false, reason: `out of range [${def.range[0]}, ${def.range[1]}]` };
      }
      return { ok: true };
    }
    case 'duration-ms': {
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
        return { ok: false, reason: 'expected non-negative finite duration in ms' };
      }
      if (def.range && (value < def.range[0] || value > def.range[1])) {
        return { ok: false, reason: `out of range [${def.range[0]}, ${def.range[1]}]ms` };
      }
      return { ok: true };
    }
    case 'number-record': {
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return { ok: false, reason: 'expected number record' };
      }
      const expected = def.default as Readonly<Record<string, number>>;
      const actual = value as Record<string, unknown>;
      for (const key of Object.keys(expected)) {
        const v = actual[key];
        if (typeof v !== 'number' || !Number.isFinite(v)) {
          return { ok: false, reason: `field "${key}" must be a finite number` };
        }
      }
      // T5: sparse-record extension — extra keys (not in default) are
      // accepted but every value must still be a finite number. Lets
      // dynamic-key tables (`thinking.budget_table`) store entries the
      // registry default doesn't enumerate, while keeping hostile/garbage
      // writes (booleans, strings, NaN, Infinity) out of the ledger.
      for (const key of Object.keys(actual)) {
        if (key in expected) continue;
        const v = actual[key];
        if (typeof v !== 'number' || !Number.isFinite(v)) {
          return { ok: false, reason: `extra field "${key}" must be a finite number` };
        }
      }
      return { ok: true };
    }
    case 'boolean': {
      if (typeof value !== 'boolean') {
        return { ok: false, reason: 'expected boolean' };
      }
      return { ok: true };
    }
  }
}
