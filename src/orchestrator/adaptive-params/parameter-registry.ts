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

export const PARAMETER_TYPES = ['number', 'integer', 'duration-ms', 'number-record'] as const;
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
  /** Default literal value. For `number-record`, an object of number values. */
  readonly default: number | Readonly<Record<string, number>>;
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
    description:
      'How long an intent classification stays in the LRU+TTL cache before re-resolution.',
    tunable: true,
  },
  {
    key: 'intent.llm_uncertain_threshold',
    type: 'number',
    default: 0.5,
    range: [0, 1],
    axiom: 'A2',
    owner: 'intent-merge',
    description:
      'LLM confidence below which the merge result is flagged uncertain (clarification candidate).',
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
    description:
      'Minimum number of supporting observations before a pattern is eligible for promotion.',
    tunable: true,
  },
  {
    key: 'sleep_cycle.pattern_min_confidence',
    type: 'number',
    default: 0.6,
    range: [0, 1],
    axiom: 'A7',
    owner: 'sleep-cycle',
    description:
      'Minimum Wilson lower-bound confidence required for a pattern to promote.',
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
    description:
      'Default time window for human approval before auto-reject. UI/operator deployments may want longer.',
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
      return { ok: true };
    }
  }
}
