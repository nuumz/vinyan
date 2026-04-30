# ECP: System Design & Implementation Plan

> ⚠️ **Status: To-Be — DO NOT IMPLEMENT FROM THIS DOC.** This describes a hypothetical "ECP v2" that has **never been released**. Only one ECP version exists today: see [`spec/ecp-spec.md`](../spec/ecp-spec.md). Read this for ideas; cite the spec for authority. The migration brainstorm referenced below has been moved to [`archive/ecp-migration-brainstorm.md`](../archive/ecp-migration-brainstorm.md).

> **Date:** 2026-04-04 | **Status:** Design Draft (NOT shipped) | **Produced by:** Expert Agent Team (4 domain specialists + Orchestrator)
> **Input:** [`archive/ecp-migration-brainstorm.md`](../archive/ecp-migration-brainstorm.md) — archived; corrected and refined by codebase verification
> **Review:** [ecp-system-design-debate-synthesis.md](../research/ecp-system-design-debate-synthesis.md) — 6-expert review, 5 dead ends identified, CONDITIONAL GO
> **Prerequisite:** [ecp-spec.md](../spec/ecp-spec.md), [design-subjective-logic.md](../research/design-subjective-logic.md)

---

## 1. Scope & Goals

### 1.1 What This Document Covers

Transform ECP v1 into v2 by resolving 4 verified deficits (D1, D3, D4, D5) in the epistemic protocol layer. D2 (Pipeline Confidence) is **already resolved** — see §2 Delta Analysis.

### 1.2 Non-Goals

- No LLM invocation changes (v2 is entirely in the rule-based governance layer)
- No new oracle types
- No wire format breaking changes (all additions are optional fields; assumes consumers use Zod `.passthrough()` or `JSON.parse()` without strict field validation)
- No Merkle evidence (deferred to PH5.18 network phase)

**Epistemic boundaries not addressed by v2:**
- Conditional opinions (uncertainty contingent on runtime environment)
- Temporal confidence decay (confidence staleness over time)
- Multi-modal evidence weighting (test vs static analysis weighted differently per context)
- Higher-order opinions (uncertainty about one's own uncertainty)

### 1.3 Success Criteria

| Criterion | Measurement |
|-----------|------------|
| Zero-oracle verdicts report vacuous confidence | `confidence: 0.5`, `opinion: vacuous()`, `unverified: true` |
| SL opinions are first-class on all verdicts | `verdict.opinion` populated when confidence > 0 |
| Confidence source is machine-enforceable | `confidenceSource` field filters LLM self-reports from governance |
| Tier/engine split enables calibration | `tierReliability` + `engineCertainty` independently queryable in traces |
| Belief intervals available for fusion results | `ResolvedGateResult.beliefInterval` computed from fused SL opinion (NOT on individual verdicts) |
| All existing tests pass | Zero regressions in `bun run test:all` |
| Backward compatible | v1 consumers read v2 verdicts without error (optional fields ignored) |

---

## 2. Delta Analysis — Brainstorm vs. Codebase Reality

The brainstorm document ([ecp-migration-brainstorm.md](../research/ecp-migration-brainstorm.md)) was produced from codebase analysis but contained inaccuracies discovered by the Expert Team's verification pass.

### 2.1 Corrected Findings

| Brainstorm Claim | Verified Reality | Impact on Plan |
|---|---|---|
| `buildVerdict()` defaults `confidence: 1.0` (D3 source) | `buildVerdict()` is **identity function** — passthrough only. The real D3 source is `OracleVerdictSchema.confidence.default(1.0)` in Zod parse | Fix target is `src/oracle/protocol.ts`, not `src/core/index.ts` |
| Phase C: PipelineConfidence "proposed, not yet implemented" | **FULLY IMPLEMENTED AND ACTIVE.** `computePipelineConfidence()` uses weighted geometric mean. `deriveConfidenceDecision()` routes 4 tiers. Active in core-loop Steps 5-6. Persisted to SQLite. | Phase C scope **eliminated** — 0 work remaining |
| Weighted-sum formula: `Σ(step × weight) / Σ(weight)` | Actual: **weighted geometric mean** `exp(Σ wᵢ · ln(vᵢ))` — more sensitive to individual low values | No formula change needed |
| 5 pipeline fields: `{pred, plan, gen, verif, critic}` | 6 fields: `{prediction, metaPrediction, planning, generation, verification, critic}` | `metaPrediction` already handles Self-Model meta-confidence |
| Weights `{0.10, 0.15, 0.20, 0.40, 0.15}` | Actual: `{0.15, 0.05, 0.10, 0.10, 0.40, 0.20}` — verification still dominates at 40% | No weight change needed |
| Thresholds `{≥0.8, 0.6-0.8, 0.4-0.6, <0.4}` | Actual: `{≥0.70, 0.50-0.70, 0.30-0.50, <0.30}` — lower, calibrated thresholds | No threshold change needed |
| ConflictResolver is "5-step" | 4-step compressed flow: domain separation → SL K-zones → accuracy tiebreak → escalation | Minor naming correction |
| All 30+ `buildVerdict()` callers need audit | All 30+ callers **explicitly set confidence** — zero rely on Zod defaults | Vacuous default is **safe** for internal callers |

### 2.2 Actual Remaining Work

| Deficit | Status | Remaining Work |
|---------|--------|---------------|
| D1 — Scalar confidence conflation | **Partially resolved** — `opinion?` field exists, `projectedProbability()` works. Missing: promotion to first-class, `beliefInterval` on `ResolvedGateResult` | Schema + behavioral changes |
| D2 — No pipeline confidence propagation | **✅ RESOLVED** — fully implemented in `pipeline-confidence.ts`, active in core-loop | None |
| D3 — Confidence laundering | **Open** — `OracleVerdictSchema.default(1.0)` still active, `quality-score.ts` still returns `1.0` for zero-oracle | Zod schema + quality score changes |
| D4 — Confidence source conflation | **Open** — single `confidence` field, no `tierReliability`/`engineCertainty` split | New fields + population logic |
| D5 — No evidence chain integrity | **Deferred** — not needed for local-only deployment | None (PH5.18) |

---

## 3. System Design

### 3.1 Architecture Overview

```
┌──────────────────────── ECP Change Surface ──────────────────────────┐
│                                                                         │
│  ┌─────────────┐  ┌──────────────┐  ┌───────────────┐  ┌────────────┐ │
│  │ Schema Layer │  │ Behavioral   │  │ Verification  │  │ Integration│ │
│  │ (Phase A)    │  │ Layer        │  │ Layer Changes │  │ Layer      │ │
│  │             │  │ (Phase B)    │  │ (Phase B)     │  │ (Phase C)  │ │
│  ├─────────────┤  ├──────────────┤  ├───────────────┤  ├────────────┤ │
│  │ types.ts    │  │ protocol.ts  │  │ conflict-     │  │ ecp-       │ │
│  │ +4 fields   │──│ Zod default  │  │ resolver.ts   │  │ translation│ │
│  │ on Verdict  │  │ → vacuous    │  │ +fusedOpinion │  │ .ts +src   │ │
│  │             │  │ +v2 fields   │  │ +belief_int   │  │            │ │
│  │ Fact +2     │  │              │  │               │  │ ecp-data-  │ │
│  │             │  │ quality-     │  │ tier-clamp.ts │  │ part.ts    │ │
│  │ orchestrator│  │ score.ts     │  │ +clampOpinion │  │ +v2 fields │ │
│  │ /types.ts   │  │ zero→vacuous │  │ Full()        │  │            │ │
│  │ (no change) │  │              │  │               │  │ conformance│ │
│  └─────────────┘  └──────────────┘  └───────────────┘  │ L1+L3     │ │
│                                                         └────────────┘ │
│                                                                         │
│  ╔═════════════════════════════════════════════════════╗                │
│  ║ UNCHANGED: pipeline-confidence.ts, core-loop.ts,   ║                │
│  ║ trace-store.ts — already v2-ready                   ║                │
│  ╚═════════════════════════════════════════════════════╝                │
└─────────────────────────────────────────────────────────────────────────┘
```

### 3.2 Schema Evolution Design

#### 3.2.1 OracleVerdict Extension

**File:** `src/core/types.ts`

```typescript
// ── v2 additions to OracleVerdict (all optional for backward compat) ──

interface OracleVerdict {
  // ... all existing v1 fields unchanged ...

  // ── NEW v2 fields ──

  /** Tier methodology reliability — set by Orchestrator from oracle registry, NOT by engine.
   *  Deterministic oracles (AST, tsc) get 1.0; heuristic (lint) 0.7-0.9; probabilistic (LLM) 0.3-0.7.
   *  Axiom A5: tier determines the ceiling. */
  tierReliability?: number;

  /** Engine's per-verdict certainty — reported by the oracle engine itself.
   *  Separates "how reliable is this oracle type" from "how certain is this specific result."
   *  Axiom A7: enables calibration of engine accuracy over time. */
  engineCertainty?: number;

  /** How confidence was derived — governs governance eligibility.
   *  Only 'evidence-derived' and 'self-model-calibrated' enter routing/gating.
   *  'llm-self-report' is logged for A7 analysis only, excluded from governance.
   *  Axiom A3: machine-enforceable, not policy-dependent. */
  confidenceSource?: 'evidence-derived' | 'self-model-calibrated' | 'llm-self-report';
}
```

**Design decisions:**
- `tierReliability` is a `number` (not enum) — allows continuous calibration via A7 traces
- `confidenceSource` has exactly 3 values — minimal set that covers all producer types
- `beliefInterval` is derived from `opinion` via `ResolvedGateResult` only — NOT on individual verdicts (avoids sync hazard with `opinion` field; consumers compute from opinion when needed)
- **Naming convention:** v2 fields use **camelCase** in TypeScript interfaces and Zod schemas (`tierReliability`, `engineCertainty`, `confidenceSource`) — matching existing fields like `qualityScore`, `oracleName`, `durationMs`. The A2A ECPDataPart wire format uses **snake_case** (`tier_reliability`, `engine_certainty`, `confidence_source`) per A2A spec convention, with camelCase↔snake_case translation at the bridge boundary.

#### 3.2.2 Fact Extension

**File:** `src/core/types.ts`

```typescript
interface Fact {
  // ... existing fields ...

  /** SL opinion tuple — propagated from verdict at fact creation time. */
  opinion?: SubjectiveOpinion;

  /** Tier reliability — copied from verdict for fact-level trust assessment. */
  tierReliability?: number;
}
```

#### 3.2.3 OracleVerdictSchema (Zod) v2

**File:** `src/oracle/protocol.ts`

```typescript
export const OracleVerdictSchema = z.object({
  // ── v1 required fields (unchanged) ──
  verified: z.boolean(),
  type: z.enum(['known', 'unknown', 'uncertain', 'contradictory']).default('known'),
  confidence: z.number().min(0).max(1).default(0.5),    // ← D3 FIX: was 1.0
  evidence: z.array(EvidenceSchema),
  falsifiableBy: z.array(z.string()).optional(),
  fileHashes: z.record(z.string(), z.string()),
  reason: z.string().optional(),
  errorCode: OracleErrorCodeSchema.optional(),
  oracleName: z.string().optional(),
  durationMs: z.number(),
  qualityScore: QualityScoreSchema.optional(),
  deliberationRequest: DeliberationRequestSchema.optional(),
  temporalContext: TemporalContextSchema.optional(),

  // ── v2 additions (all optional) ──
  opinion: SubjectiveOpinionSchema.optional(),
  tierReliability: z.number().min(0).max(1).optional(),
  engineCertainty: z.number().min(0).max(1).optional(),
  confidenceSource: z.enum([
    'evidence-derived',
    'self-model-calibrated',
    'llm-self-report',
  ]).optional(),
  confidenceReported: z.boolean().optional(),
});
```

**D3 Fix mechanics:** When an external oracle returns `{ verified: true, evidence: [...], fileHashes: {...}, durationMs: 50 }` without `confidence`, Zod parse now fills `confidence: 0.5` instead of `1.0`. Combined with `confidenceReported: undefined` (falsy), the gate knows this confidence was not explicitly asserted.

#### 3.2.4 SubjectiveOpinionSchema (new Zod schema)

**File:** `src/oracle/protocol.ts` (add)

```typescript
export const SubjectiveOpinionSchema = z.object({
  belief: z.number().min(0).max(1),
  disbelief: z.number().min(0).max(1),
  uncertainty: z.number().min(0).max(1),
  baseRate: z.number().min(0).max(1),
}).refine(
  (o) => Math.abs(o.belief + o.disbelief + o.uncertainty - 1.0) < 0.001,
  { message: 'SL invariant: belief + disbelief + uncertainty must equal 1.0 (±0.001)' },
);
// NOTE: Wire tolerance (0.001) is intentionally wider than internal SL_EPSILON (1e-6)
// to accommodate JSON serialization rounding from external oracles. See §3.3.10.
```

### 3.3 Behavioral Changes Design

#### 3.3.1 Vacuous Default (D3 Resolution)

**Target:** `src/oracle/protocol.ts` — `OracleVerdictSchema`

**Change:** `confidence: z.number().min(0).max(1).default(1.0)` → `.default(0.5)`

**Caller safety analysis (verified by @Explore #1):**
- 30+ direct callers of `buildVerdict()` across 8 files
- **ALL explicitly set `confidence`** — zero rely on Zod default
- Built-in oracles: AST (0/0.95/1.0), Lint (0.8/1.0), Rust (0.9/1.0), Runner (0), Gate (0)
- MCP bridge: 0.5/0.7 (explicit)
- A2A bridge: clampFull output (explicit)
- **Risk: external oracles using `OracleVerdictSchema.parse()` without setting confidence** — these will now get 0.5 instead of 1.0

**Mitigation:** Conformance suite v2 validation warns when `confidenceReported` is false/undefined.

#### 3.3.2 Zero-Oracle Quality Score (D3 Companion)

**Target:** `src/gate/quality-score.ts` — `computeQualityScore()` zero-oracle path

**Current:**
```typescript
// When entries.length === 0:
return {
  architecturalCompliance: 1.0,      // ← Vacuous inflation
  efficiency,
  composite: efficiency * 0.4 + 1.0 * 0.6,
  dimensionsAvailable: 1,
  phase: 'basic',
  unverified: true,
};
```

**v2:**
```typescript
return {
  architecturalCompliance: 0.5,      // ← Vacuous neutral (SL baseRate)
  efficiency,
  composite: efficiency * 0.4 + 0.5 * 0.6,
  dimensionsAvailable: 1,
  phase: 'basic',
  unverified: true,
};
```

**Impact:** Tasks that skip oracle verification (L0 hash-only) will report `composite ≈ 0.5 * 0.6 + eff * 0.4` instead of `1.0 * 0.6 + eff * 0.4`. For L0 tasks this is correct — no structural verification was performed.

> **Note:** The `QualityScore` interface (`src/core/types.ts`) does **not** currently have an `opinion` field. We intentionally omit adding SL opinion to `QualityScore` in v2 — it's a composite metric, not a single epistemically-typed assertion. The vacuous default is expressed through the scalar `0.5` value.

#### 3.3.3 SL Opinion Clamping (new function)

**Target:** `src/oracle/tier-clamp.ts` — add `clampOpinionFull()`

**Design:**

```typescript
import { type SubjectiveOpinion } from '../core/subjective-opinion.ts';

/**
 * Clamp an SL opinion tuple by tier, transport, and peer trust.
 *
 * Unlike scalar clamping (which caps the maximum confidence),
 * opinion clamping enforces MINIMUM UNCERTAINTY FLOORS per tier.
 * A deterministic oracle can have u ≥ 0.01, a heuristic oracle u ≥ 0.10, etc.
 *
 * This preserves the SL invariant (b + d + u = 1) by redistributing
 * mass from belief/disbelief into uncertainty.
 *
 * Axiom A5: tiered trust → tiered uncertainty floors.
 */
export function clampOpinionFull(
  opinion: SubjectiveOpinion,
  tier?: string,
  transport?: string,
  peerTrust?: PeerTrustLevel,
): SubjectiveOpinion {
  // Guard: normalize invalid input opinions (from external sources)
  const sum = opinion.belief + opinion.disbelief + opinion.uncertainty;
  if (Math.abs(sum - 1.0) > SL_EPSILON) {
    opinion = {
      ...opinion,
      belief: opinion.belief / sum,
      disbelief: opinion.disbelief / sum,
      uncertainty: opinion.uncertainty / sum,
    };
  }

  const effectiveTier = tier ?? 'heuristic';

  // Step 1: Apply tier uncertainty floor
  let clamped = clampOpinionByTier(opinion, effectiveTier);

  // Step 2: Apply transport-based ceiling by scaling down belief proportionally
  // IMPORTANT: We scale belief/disbelief proportionally rather than using fromScalar(),
  // because fromScalar() produces u=0 (dogmatic), destroying the tier uncertainty floor.
  const transportCap = TRANSPORT_CAPS[transport ?? 'stdio'] ?? 1.0;
  clamped = scaleBeliefByCeiling(clamped, transportCap);
  // Re-apply tier floor — scaling may have shifted uncertainty below minimum
  clamped = clampOpinionByTier(clamped, effectiveTier);

  // Step 3: Apply peer trust ceiling (same proportional scaling)
  if (peerTrust) {
    const peerCap = PEER_TRUST_CAPS[peerTrust] ?? 1.0;
    clamped = scaleBeliefByCeiling(clamped, peerCap);
    clamped = clampOpinionByTier(clamped, effectiveTier);
  }

  return clamped;
}

/**
 * Scale down belief so that projectedProbability ≤ ceiling,
 * redistributing excess mass to uncertainty (preserving disbelief).
 * This preserves the SL invariant b + d + u = 1.
 */
function scaleBeliefByCeiling(
  opinion: SubjectiveOpinion,
  ceiling: number,
): SubjectiveOpinion {
  const projected = projectedProbability(opinion);
  if (projected <= ceiling) return opinion;

  // Correct delta accounts for baseRate feedback: moving mass to uncertainty
  // feeds back through P = b + u×a, so raw `excess` under-corrects.
  // delta = excess / (1 - baseRate) compensates for the baseRate×Δu term.
  const divisor = 1 - opinion.baseRate;
  const delta = divisor > SL_EPSILON ? excess / divisor : excess;  // guard: baseRate ≈ 1.0
  const newBelief = Math.max(0, opinion.belief - delta);
  return {
    belief: newBelief,
    disbelief: opinion.disbelief,
    uncertainty: 1 - newBelief - opinion.disbelief,  // absorbs the delta
    baseRate: opinion.baseRate,
  };
}
```

**Existing `clampOpinionByTier()` uncertainty floors** (already in `subjective-opinion.ts`):
- `deterministic: 0.01` — nearly certain, minimal epistemic humility
- `heuristic: 0.10` — structural evidence, some uncertainty
- `probabilistic: 0.25` — statistical evidence, significant uncertainty

#### 3.3.4 Belief Interval on Conflict Resolver Output

**Target:** `src/gate/conflict-resolver.ts` — `ResolvedGateResult`

**Current:**
```typescript
export interface ResolvedGateResult {
  decision: 'allow' | 'block';
  reasons: string[];
  resolutions: ConflictResolution[];
  hasContradiction: boolean;
}
```

**v2:**
```typescript
export interface ResolvedGateResult {
  decision: 'allow' | 'block';
  reasons: string[];
  resolutions: ConflictResolution[];
  hasContradiction: boolean;

  // ── v2 additions ──
  /** Fused SL opinion from all non-conflicting verdicts. Undefined if no fusion occurred. */
  fusedOpinion?: SubjectiveOpinion;
  /** Derived from fusedOpinion: [belief, 1-disbelief]. Shows "how much we don't know" after fusion.
   *  NOTE: beliefInterval lives ONLY on ResolvedGateResult (post-fusion), not on individual OracleVerdicts.
   *  Per-verdict consumers should use opinion.belief and 1-opinion.disbelief directly. */
  beliefInterval?: { belief: number; plausibility: number };
}
```

**Computation point:** After SL fusion in Step 2. The code uses `cumulativeFusion()` (pairwise, not `fuseAll`). Fusion executes for all cases where K ≤ 0.7 (both the 0.3-0.7 accuracy-tiebreak zone and the K < 0.3 direct zone):

```typescript
// In the conflict resolver fusion path (K ≤ 0.7):
const fused = cumulativeFusion(opinionA, opinionB);
result.fusedOpinion = fused;
result.beliefInterval = {
  belief: fused.belief,
  plausibility: 1 - fused.disbelief,  // equivalently: fused.belief + fused.uncertainty
};
```

**K-zone behavior (from codebase — code still uses 5-step numbering internally):**
- K > 0.7 → Escalate (high contradiction, no fusion)
- 0.3 ≤ K ≤ 0.7 → Accuracy tiebreak, then fusion if tiebreak inconclusive
- K < 0.3 → Direct fusion (low contradiction, opinions are compatible)

#### 3.3.5 Confidence Source Population

| Producer | `confidenceSource` Value | Where Set |
|----------|--------------------------|-----------|
| Built-in oracles (AST, Type, Lint, Test, Dep) | `'evidence-derived'` | `src/oracle/runner.ts` — after oracle produces verdict |
| MCP bridge (external tool results) | `'evidence-derived'` | `src/mcp/ecp-translation.ts` — in `mcpToEcp()` |
| A2A bridge (remote peer verdicts) | `'evidence-derived'` | `src/a2a/ecp-a2a-translation.ts` — in `ecpDataPartToVerdict()` |
| Self-Model predictions | `'self-model-calibrated'` | `src/orchestrator/core-loop.ts` — Step 2 predict |
| LLM worker responses (if worker reports confidence) | `'llm-self-report'` | `src/orchestrator/worker/worker-pool.ts` — post-dispatch |
| Oracle with no explicit confidence (Zod default) | NOT SET (undefined) | `src/oracle/protocol.ts` — Zod parse, `confidenceReported` unset (falsy) |

> **`confidenceReported` population rule:** Any code path that enriches a verdict with `confidenceSource` must also set `confidenceReported: true`. When `confidenceSource` is undefined AND `confidenceReported` is falsy, the confidence came from the Zod `.default(0.5)` — governance should treat it as vacuous.

**Governance filter (A3 enforcement):**
```typescript
// In gate/risk-router.ts or wherever routing decisions consume confidence:
function isGovernanceEligible(source?: string): boolean {
  if (!source) return false;  // Zod default → not eligible
  return source === 'evidence-derived' || source === 'self-model-calibrated';
  // 'llm-self-report' is explicitly excluded
}
```

**Empty eligible set fallback (A3 + A2):** When ALL verdicts have `confidenceSource: 'llm-self-report'` or `undefined`, the governance filter yields an empty eligible set. In this case, the gate returns `{ decision: 'block', unverified: true, confidence: 0.5 }` — an honest vacuous verdict rather than a false positive. Emit `'governance:vacuous-evidence'` event for A7 calibration learning.

#### 3.3.6 Tier Reliability Population

`tierReliability` is set by the **Orchestrator**, not by the oracle engine (A6: zero-trust execution).

```typescript
// In oracle/runner.ts — after receiving verdict from oracle process:
function enrichVerdictWithRegistryData(
  verdict: OracleVerdict,
  registryEntry: OracleRegistryEntry,
): OracleVerdict {
  const tierRel = TIER_CAPS[registryEntry.tier] ?? 0.9; // fallback matches clampByTier default (heuristic=0.9)
  return {
    ...verdict,
    tierReliability: tierRel,
    confidenceSource: 'evidence-derived',
    confidenceReported: true,  // oracle DID provide explicit confidence
    // engineCertainty = the oracle's self-reported confidence
    engineCertainty: verdict.confidence,
    // confidence = min(tierReliability, engineCertainty) — A5 clamping (v1-compatible scalar)
    confidence: Math.min(tierRel, verdict.confidence),
  };
}
```

> **Double-clamping interaction (C1 note):** Step 1 `min(tierReliability, engineCertainty)` produces an intermediate scalar for v1-compatible consumers (scalar confidence path, MCP output). Steps 2-3 in §4.1 compute SL opinion + `clampOpinionFull()` → `projectedProbability()` overwrites confidence for v2 consumers. The scalar `min()` is NOT dead logic — it serves the v1 backward-compatible path and provides a fast confidence ceiling without SL overhead for L0-L1 routing.

#### 3.3.7 Level-Differentiated Fusion Policy

Not all routing levels need full SL fusion overhead:

| Level | Fusion Strategy | Rationale |
|-------|----------------|----------|
| **L0 Reflex** | Scalar confidence only (no SL) | <100ms budget, hash-only verify, no oracle verdicts to fuse |
| **L1 Heuristic** | Scalar averaging of enriched confidences | <2s budget, structural oracles only — SL fusion overhead unjustified for 1-3 verdicts |
| **L2 Analytical** | Full SL fusion: `cumulativeFusion()` + K-zone conflict + `beliefInterval` | <10s budget, test oracles produce meaningful contradictions worth detecting |
| **L3 Deliberative** | Full SL fusion + shadow validation + `beliefInterval` governance | <60s budget, highest-stakes decisions need full epistemic resolution |

**Implementation:** `resolveConflicts()` accepts a `routingLevel` parameter. When `level ≤ 1`, skip SL fusion and return `fusedOpinion: undefined`, `beliefInterval: undefined`. Scalar confidence averaging uses the same `min(tierReliability, engineCertainty)` values from enrichment.

#### 3.3.8 `fromScalar()` Dogmatic Opinion Fix (A2)

**Problem (identified by Data Flow Engineer):** `fromScalar(value)` creates opinions with `u=0` (zero uncertainty) regardless of evidence quality. Oracle confidence `0.95` from 50 tests and `0.95` from 1 test both produce `{ b: 0.95, d: 0.05, u: 0, a: 0.5 }` — a *dogmatic* opinion that claims perfect knowledge. This violates A2 (First-Class Uncertainty) and corrupts Phase 7's calibration baseline.

**Fix:** Add optional `defaultUncertainty` parameter:

```typescript
// In src/core/subjective-opinion.ts:
export function fromScalar(
  value: number,
  defaultUncertainty = 0.3,  // ← NEW: honest about epistemic gap
  baseRate = 0.5,
): SubjectiveOpinion {
  const u = Math.max(0, Math.min(1, defaultUncertainty));
  const remaining = 1 - u;
  return {
    belief: value * remaining,
    disbelief: (1 - value) * remaining,
    uncertainty: u,
    baseRate,
  };
}
```

**Impact:** `fromScalar(0.95)` now produces `{ b: 0.665, d: 0.035, u: 0.3, a: 0.5 }` — `projectedProbability()` returns `0.665 + 0.3 × 0.5 = 0.815`, honestly lower than the raw scalar. Tier clamping in `clampOpinionFull()` further adjusts uncertainty based on oracle tier.

**Backward compatibility:** Default parameter means existing callers `fromScalar(x)` silently gain the fix. Callers that explicitly need dogmatic opinions can pass `fromScalar(x, 0)`.

> **Conservative heuristic note:** `defaultUncertainty = 0.3` is a conservative heuristic — it treats all scalar-converted opinions equally regardless of evidence volume. Phase 7 replaces this with evidence-count-derived uncertainty computed from oracle execution metadata (sample size, test count, assertion density). The 0.3 constant provides an honest baseline until per-oracle calibration data is available.

#### 3.3.9 Quality-Score / Fusion Pipeline Split

**Problem (identified by Architecture Purist):** The execution order between `computeQualityScore()` and fusion is ambiguous. If quality-score runs before fusion, it can't benefit from `fusedOpinion`. If after, the fusion step doesn't have quality context. This creates a circular dependency.

**Fix:** Split quality-score into explicit two-step pipeline:

```typescript
// Step 1: Aggregate oracle verdicts → base quality (runs BEFORE fusion)
function computeFromVerdicts(entries: OracleEntry[]): QualityScore {
  // Existing logic — architecturalCompliance from oracle verdicts
  // Zero-oracle case returns 0.5 (§3.3.2)
}

// Step 2: If fusedOpinion available, recalibrate (runs AFTER fusion, optional)
function recalibrateWithFusion(
  baseScore: QualityScore,
  fusedOpinion?: SubjectiveOpinion,
): QualityScore {
  if (!fusedOpinion) return baseScore;
  // Replace architecturalCompliance with projectedProbability(fusedOpinion)
  // This gives the composite score SL-grade epistemic grounding
  const fusedConfidence = projectedProbability(fusedOpinion);
  return {
    ...baseScore,
    architecturalCompliance: fusedConfidence,
    composite: baseScore.efficiency * 0.4 + fusedConfidence * 0.6,
  };
}
```

**Pipeline execution order:**
```
Verdicts → computeFromVerdicts() → baseQuality
        → resolveConflicts()     → fusedOpinion
                                  → recalibrateWithFusion(baseQuality, fusedOpinion) → finalQuality
```

#### 3.3.10 Floating-Point Tolerance Standardization

**Problem (identified by Data Flow Engineer):** Zod `SubjectiveOpinionSchema` uses `0.001` tolerance for SL invariant; internal `isValid()` in `subjective-opinion.ts` uses `1e-9` (1,000,000× stricter). Opinions that pass Zod validation silently fail internal consistency checks.

**Fix:** Define a single tolerance constant:

```typescript
// In src/core/subjective-opinion.ts:
export const SL_EPSILON = 1e-6;  // 6 decimal places — sufficient for IEEE 754 double
```

**Two-tier tolerance decision:**
- **Wire boundary (Zod parse):** `0.001` — accommodates JSON serialization rounding from external oracles. Applied in `SubjectiveOpinionSchema.refine()` (§3.2.4).
- **Internal computation:** `SL_EPSILON = 1e-6` — applied in `isValid()`, `isVacuous()`, `clampOpinionFull()` normalization guard, and all runtime SL comparisons.

This is intentional, not contradictory: external data may arrive slightly imprecise (wire), but once parsed, all internal operations use the tighter tolerance.

### 3.4 Integration Design

#### 3.4.1 A2A ECPDataPart Schema Update

**File:** `src/a2a/ecp-data-part.ts`

```typescript
// Change ecp_version to support both v1 and v2
ecp_version: z.union([z.literal(1), z.literal(2)]).default(1),

// Add v2 fields (all optional for backward compat)
tier_reliability: z.number().min(0).max(1).optional(),
engine_certainty: z.number().min(0).max(1).optional(),
confidence_source: z.enum([
  'evidence-derived', 'self-model-calibrated', 'llm-self-report',
]).optional(),
```

**Version negotiation:** When `ecp_version: 2`, v2 fields are expected. When `ecp_version: 1`, v2 fields may be present but are informational only.

#### 3.4.2 A2A Bridge Translation (both directions)

**`verdictToECPDataPart()` additions:**
```typescript
// Add to return object (only when fields exist — camelCase verdict → snake_case wire):
...(verdict.tierReliability !== undefined && { tier_reliability: verdict.tierReliability }),
...(verdict.engineCertainty !== undefined && { engine_certainty: verdict.engineCertainty }),
...(verdict.confidenceSource && { confidence_source: verdict.confidenceSource }),
```

**`ecpDataPartToVerdict()` additions:**
```typescript
// Parse v2 fields from incoming data part (snake_case wire → camelCase verdict):
...(dataPart.tier_reliability !== undefined && { tierReliability: dataPart.tier_reliability }),
...(dataPart.engine_certainty !== undefined && { engineCertainty: dataPart.engine_certainty }),
...(dataPart.confidence_source && { confidenceSource: dataPart.confidence_source }),
```

**A2A trust override (A6):** For `untrusted` or `provisional` peers, override `confidenceSource` to `'llm-self-report'` regardless of the peer's claim. Only `trusted` peers may assert `'evidence-derived'`. This prevents untrusted peers from injecting governance-eligible confidence:

```typescript
// In ecpDataPartToVerdict(), after field translation:
if (peerTrust !== 'trusted' && verdict.confidenceSource === 'evidence-derived') {
  verdict.confidenceSource = 'llm-self-report';  // A6: zero-trust, downgrade claim
}
```

> **Threat model assumption:** This protects against honest misconfiguration and basic confidence injection, NOT adversarial compromise of initially-trusted peers (which requires cryptographic attestation, deferred to PH5.18).

#### 3.4.3 MCP Bridge Additions

**`ecpToMcp()`** — include v2 fields in JSON payload for Vinyan-aware consumers:
```typescript
// In the JSON object written to MCP content[0].text:
...(verdict.tierReliability !== undefined && { tier_reliability: verdict.tierReliability }),
...(verdict.confidenceSource && { confidence_source: verdict.confidenceSource }),
```

**`mcpToEcp()`** — tag confidence source:
```typescript
// All MCP-originated verdicts:
confidenceSource: 'evidence-derived' as const,  // MCP results are tool outputs, not LLM self-reports
```

#### 3.4.4 Conformance Suite Updates

**Level 1 — add opinion consistency check:**
```typescript
// If verdict.opinion is present:
// C_NEW_1: Validate b + d + u = 1.0 (±0.001)
// C_NEW_2: Validate |confidence - projectedProbability(opinion)| < 0.01
```

**Level 3 — add tier/engine split validation:**
```typescript
// If tierReliability and engineCertainty are both present:
// C_NEW_3: Validate confidence ≤ tierReliability (A5: tier is the ceiling)
// C_NEW_4: Validate confidence ≤ engineCertainty (engine can't be more confident than it claims)
// C_NEW_5: On ResolvedGateResult.beliefInterval (if present):
//   Validate beliefInterval.belief ≤ beliefInterval.plausibility
//   If fusedOpinion present, validate beliefInterval.belief ≈ fusedOpinion.belief (±0.01)
```

#### 3.4.5 Agent Card Version Advertisement

**File:** `src/a2a/agent-card.ts`

```typescript
// Change from:
ecp_version: 1,
// To:
ecp_version: 2,
supported_versions: [1, 2],
```

#### 3.4.6 Oracle SDK Types

**File:** `packages/oracle-sdk-ts/src/index.ts`

Add `tierReliability?`, `engineCertainty?`, `confidenceSource?` to the exported `OracleVerdict` type. These are optional fields — SDK consumers that don't use them are unaffected.

> **SDK schema default sync (C5):** The SDK's `OracleVerdictSchema` (in `packages/oracle-sdk-ts/src/schemas.ts`) MUST change the confidence default from `1.0` → `0.5` in lockstep with the core schema change in Phase B1. Failure to sync causes external oracles to silently inflate confidence. See §5.2 B1 for details.

---

## 4. Data Flow Diagram

### 4.1 Verdict Enrichment Pipeline (new in v2)

```
Oracle Engine                    Orchestrator                         Gate
    │                                │                                  │
    │ OracleVerdict                  │                                  │
    │ {verified, type,               │                                  │
    │  confidence: 0.95,             │                                  │
    │  evidence, fileHashes}         │                                  │
    │───────────────────────────────►│                                  │
    │                                │                                  │
    │                    ┌───────────┤                                  │
    │                    │ 1. ENRICH │                                  │
    │                    │           │                                  │
    │                    │ tierReliability = TIER_CAPS[oracle.tier]     │
    │                    │ engineCertainty = verdict.confidence         │
    │                    │ confidenceSource = 'evidence-derived'        │
    │                    │ confidence = min(tierRel, engineCert)        │
    │                    │ confidenceReported = true                    │
    │                    └───────────┤                                  │
    │                                │                                  │
    │                    ┌───────────┤                                  │
    │                    │ 2. OPINIONIZE                                │
    │                    │                                              │
    │                    │ IF verdict.opinion exists AND isValid():     │
    │                    │   opinion = verdict.opinion                  │
    │                    │ ELSE:                                        │
    │                    │   opinion = fromScalar(confidence, 0.3)    │
    │                    │                                              │
    │                    │ rawOpinion = opinion (audit copy)            │
    │                    └───────────┤                                  │
    │                                │                                  │
    │                    ┌───────────┤                                  │
    │                    │ 3. CLAMP  │                                  │
    │                    │                                              │
    │                    │ opinion = clampOpinionFull(                  │
    │                    │   opinion, tier, transport, peerTrust)       │
    │                    │ confidence = projectedProbability(opinion)   │
    │                    └───────────┤                                  │
    │                                │                                  │
    │                                │ Enriched OracleVerdict           │
    │                                │──────────────────────────────────►│
    │                                │                                  │
    │                                │                  ┌───────────────┤
    │                                │                  │ RESOLVE       │
    │                                │                  │ ConflictRes.  │
    │                                │                  │ → fusedOpinion│
    │                                │                  │ → beliefInt   │
    │                                │                  └───────────────┤
    │                                │                                  │
    │                                │◄─────────────────────────────────│
    │                                │ ResolvedGateResult               │
    │                                │ {decision, fusedOpinion,         │
    │                                │  beliefInterval, ...}            │
```

### 4.2 Governance Filter

```
                 confidenceSource
                       │
          ┌────────────┼────────────┐
          │            │            │
    'evidence-      'self-model-   'llm-self-
     derived'       calibrated'     report'
          │            │            │
          ▼            ▼            ▼
    ┌──────────┐ ┌──────────┐ ┌──────────┐
    │ ELIGIBLE │ │ ELIGIBLE │ │ EXCLUDED │
    │ for gate │ │ for gate │ │ from     │
    │ routing  │ │ routing  │ │ governance│
    │ scoring  │ │ scoring  │ │          │
    └──────────┘ └──────────┘ │ Logged   │
                              │ for A7   │
                              │ calib.   │
                              └──────────┘
```

### 4.3 Feedback Loop: `engineCertainty` → SelfModel Calibration (DE2 Wire)

**Dead end identified:** `engineCertainty` is populated by `enrichVerdictWithRegistryData()` (§3.3.6) and persisted to trace-store, but `SelfModel.calibrate()` never reads it. The calibration loop is blind to per-engine confidence accuracy.

**Wiring spec:**

```
Verdicts (with engineCertainty)
    │
    ▼
trace-store (persisted with full v2 fields)
    │
    ▼
SelfModel.calibrate()
    ├─ Read: predicted confidence (from Step 2 predict)
    ├─ Read: actual engineCertainty (from trace)
    ├─ Compute: delta = |predicted - actual|
    └─ Update: per-oracle-type EMA accuracy score
```

**Implementation point:** `src/orchestrator/core-loop.ts` Step 6 (Learn). After `TraceCollector.collect()`, pass `engineCertainty` from each verdict into `SelfModel.calibrate()` as the ground-truth signal. This enables the prediction error mechanism (A7).

**Signature extension:** v2 extends the `SelfModel` interface to accept optional engine certainty data:
```typescript
calibrate?(
  prediction: SelfModelPrediction,
  trace: ExecutionTrace,
  engineCertaintyMap?: Record<string, number>,  // ← v2: oracle_name → engineCertainty
): PredictionError | undefined;
```
Phase 7 implements the EMA calibration algorithm that consumes `engineCertaintyMap`. v2 provides the data and the ready signature.

**v2 scope:** Populate the field and persist to trace. Phase 7 implements the actual EMA calibration algorithm that reads it.

### 4.4 Feedback Loop: `fusedOpinion` → Quality Recalibration (DE4 Wire)

**Dead end identified:** `fusedOpinion` is computed by `resolveConflicts()` (§3.3.4) but `computePipelineConfidence()` only accepts scalars — the fused SL opinion is discarded.

**Wiring spec (enabled by §3.3.9 pipeline split):**

```
Verdicts ───► computeFromVerdicts() ──► baseQuality
    │
    └────► resolveConflicts()    ──► fusedOpinion
                                       │
                                       ▼
                              recalibrateWithFusion(base, fused) ─► finalQuality
                                       │
                                       ▼
                              computePipelineConfidence({...phases, verification: finalQuality.composite})
                                       │
                                       ▼
                              deriveConfidenceDecision() → routing tier
```

**Key:** `finalQuality.composite` — recalibrated with SL-grade fusion — feeds directly into the `verification` slot of `computePipelineConfidence()`, which has 40% weight. This closes the most impactful feedback loop: oracle verdicts → SL fusion → quality → pipeline confidence → routing decision.

**v2 scope:** Wire the pipeline split and pass `fusedOpinion` to `recalibrateWithFusion()`. The pipeline confidence function itself is unchanged (already v2-ready per §2.1).

---

## 5. Implementation Plan

### 5.1 Phase A — Schema Evolution (Zero Risk)

**Scope:** Add optional fields to types and Zod schemas. No behavior change. All existing tests pass unchanged.

| Step | File | Change | LOC | Deps |
|------|------|--------|-----|------|
| A1 | `src/core/types.ts` | Add `tierReliability?`, `engineCertainty?`, `confidenceSource?` to `OracleVerdict` | ~10 | None |
| A2 | `src/core/types.ts` | Add `opinion?`, `tierReliability?` to `Fact` | ~4 | A1 |
| A3 | `src/oracle/protocol.ts` | Add `SubjectiveOpinionSchema` with `.refine(b+d+u=1)` | ~10 | None |
| A4 | `src/oracle/protocol.ts` | Add v2 optional fields to `OracleVerdictSchema` | ~15 | A3 |
| A5 | `src/a2a/ecp-data-part.ts` | Add v2 wire-format fields (snake_case) + change `ecp_version` to `z.union([z.literal(1), z.literal(2)])` | ~10 | None |
| A6 | `packages/oracle-sdk-ts/src/index.ts` | Add v2 fields (camelCase) to exported `OracleVerdict` type | ~6 | A1 |
| A7 | `src/oracle/protocol.ts` | Add `GUARDRAIL_BLOCKED` to `OracleErrorCodeSchema` enum (pre-existing debt fix) | ~1 | None |
| A8 | `src/core/subjective-opinion.ts` | Define `SL_EPSILON = 1e-6` constant, update all internal tolerance checks | ~5 | None |

**Verification:** `get_errors` on each file → `bun run check` → `bun run test` (all existing tests must pass).

### 5.2 Phase B — Behavioral Changes (Medium Risk)

**Scope:** Change defaults, add computation logic, enrich verdicts. Some tests may need updates.

| Step | File | Change | Risk | Deps |
|------|------|--------|------|------|
| B1 | `src/oracle/protocol.ts`, `packages/oracle-sdk-ts/src/schemas.ts` | Change `confidence` Zod default from `1.0` → `0.5` (BOTH core + SDK in lockstep) | **HIGH** — external oracle impact | A4 |
| B2 | `src/gate/quality-score.ts` | Zero-oracle path: `architecturalCompliance: 1.0` → `0.5` | MEDIUM | None |
| B3 | `src/oracle/tier-clamp.ts` | Add `clampOpinionFull()` function | LOW | A1 |
| B4 | `src/gate/conflict-resolver.ts` | Add `fusedOpinion` + `beliefInterval` to `ResolvedGateResult`, populate in fusion step; accept `routingLevel` param, skip SL fusion for L0-L1 | LOW | A1, B3 |
| B5 | `src/oracle/runner.ts` | Enrich verdict with `tierReliability`, `engineCertainty`, `confidenceSource` from registry | MEDIUM | A1 |
| B6 | `src/mcp/ecp-translation.ts` | Set `confidenceSource: 'evidence-derived'` on `mcpToEcp()` output | LOW | A1 |
| B7 | `src/a2a/ecp-a2a-translation.ts` | Translate v2 fields (camelCase↔snake_case) in both `verdictToECPDataPart()` and `ecpDataPartToVerdict()`; apply A6 trust override on inbound | LOW | A5 |
| B8 | `src/core/subjective-opinion.ts` | Fix `fromScalar()` — add `defaultUncertainty` param (default 0.3), eliminate dogmatic u=0 (§3.3.8) | MEDIUM | A8 |
| B9 | `src/gate/quality-score.ts` | Split into `computeFromVerdicts()` + `recalibrateWithFusion()` (§3.3.9); wire fusedOpinion consumption (DE4) | MEDIUM | B4 |
| B10 | `src/orchestrator/core-loop.ts` | Wire `engineCertainty` from trace into `SelfModel.calibrate()` call (DE2) | LOW | B5 |

**Test strategy:**
- B1: Run `bun run test` — check which tests assert `confidence: 1.0` on schema-parsed verdicts. Update expectations.
- B2: `tests/gate/quality-score*.test.ts` — update zero-oracle expectations from 1.0 → 0.5
- B3: New unit tests for `clampOpinionFull()` — 4 test cases (per tier level)
- B4: `tests/gate/conflict-resolver*.test.ts` — add assertion for `fusedOpinion` and `beliefInterval` presence; verify L0-L1 skips SL fusion
- B5: `tests/oracle/runner*.test.ts` — verify enrichment fields present
- B8: `tests/core/subjective-opinion.test.ts` — `fromScalar(0.95)` now has u>0; `fromScalar(0.95, 0)` remains dogmatic for explicit callers
- B9: `tests/gate/quality-score.test.ts` — test `recalibrateWithFusion()` with mock fusedOpinion; verify composite recalculation
- B10: `tests/orchestrator/core-loop.test.ts` — verify `engineCertainty` is passed to `SelfModel.calibrate()`

### 5.3 Phase C — Integration & Polish (Low Risk)

| Step | File | Change | Deps |
|------|------|--------|------|
| C1 | `packages/ecp-conformance/src/level1.ts` | Add opinion consistency validation (b+d+u=1, P(opinion)≈confidence) | A3 |
| C2 | `packages/ecp-conformance/src/level3.ts` | Add `tierReliability`/`engineCertainty` validation + `beliefInterval` bounds (on `ResolvedGateResult` only) | A1 |
| C3 | `src/a2a/agent-card.ts` | Change `ecp_version: 1` → `ecp_version: 2`, add `supported_versions: [1, 2]` | None |
| C4 | `packages/ecp-conformance/src/schemas.ts` | Add `SubjectiveOpinionSchema` and `BeliefIntervalSchema` to conformance schemas | A3 |
| C5 | `src/config/schema.ts` | Add `ECP_SCHEMA_DEFAULTS` + `ECP_ENRICHMENT` feature flags (both default `false`); gate B1-B2 and B5-B10 respectively | None |

**Test strategy:**
- C1-C2: `tests/ecp-conformance/` — add test cases for v2 validation rules
- C3: `tests/a2a/agent-card.test.ts` — update version assertion
- C5: `tests/config/` — verify feature flag defaults to `false`; verify behavioral gates respect flag state

### 5.4 Dependency Graph

```
A1 (types.ts)
├── A2 (Fact) ─────────────────────────────────────────────► Done
├── A6 (oracle-sdk types) ─────────────────────────────────────────► Done
├── B3 (clampOpinionFull) ─► B4 (resolver beliefInterval) ─► Done
├── B5 (runner enrichment) ─► B10 (core-loop SelfModel wire) ► Done
├── B6 (MCP bridge) ──────────────────────────────────────────► Done
└── C2 (conformance L3) ────────────────────────────────────────► Done

A3 (SL Zod schema)
├── A4 (VerdictSchema v2 fields) ─► B1 (default 0.5 — core + SDK) ► Done
├── C1 (conformance L1 SL) ─────────────────────────────────────► Done
└── C4 (conformance schemas) ───────────────────────────────► Done

A8 (SL_EPSILON constant)
└── B8 (fromScalar fix) ────────────────────────────────────────► Done

B4 (resolver fusion)
└── B9 (quality-score pipeline split) ────────────────────► Done

A5 (A2A data part)
├── B7 (A2A bridge) ──────────────────────────────────────► Done
└── C3 (agent card) ──────────────────────────────────────► Done

B2 (quality-score) ───────────────────────────────────────► Done (independent)
```

**Critical path:** A1 → A3 → A4 → B1 (must be sequential — each depends on previous)

---

## 6. Testing Strategy

### 6.1 Test Categories

| Category | What | When | Runner |
|----------|------|------|--------|
| **Unit** | Individual function behavior (clampOpinionFull, enrichVerdict, SL fusion) | After each B-step | `bun test tests/oracle/tier-clamp.test.ts` etc. |
| **Integration** | Gate pipeline with v2 verdicts (schema parse → enrich → conflict resolve → quality score) | After all Phase B | `bun run test:integration` |
| **Conformance** | L1 opinion consistency, L3 tier/engine validation | After Phase C | `bun test tests/ecp-conformance/` |
| **Regression** | All existing tests pass with v2 schema changes | After Phase A, after Phase B | `bun run test:all` |

### 6.2 New Test Cases

| Test | File | Asserts |
|------|------|---------|
| `clampOpinionFull preserves SL invariant` | `tests/oracle/tier-clamp.test.ts` | b+d+u=1 after clamping each tier |
| `clampOpinionFull enforces uncertainty floor` | same | probabilistic tier → u ≥ 0.25 |
| `enrichVerdictWithRegistryData sets all v2 fields` | `tests/oracle/runner.test.ts` | tierReliability, engineCertainty, confidenceSource all defined |
| `Zod default confidence is 0.5 (not 1.0)` | `tests/oracle/protocol.test.ts` | `OracleVerdictSchema.parse({...minimal}).confidence === 0.5` |
| `zero-oracle quality returns 0.5 compliance` | `tests/gate/quality-score.test.ts` | architecturalCompliance === 0.5, unverified === true |
| `conflict resolver emits fusedOpinion` | `tests/gate/conflict-resolver.test.ts` | fusedOpinion defined when K < 0.3 |
| `conflict resolver emits beliefInterval` | same | beliefInterval.belief ≤ beliefInterval.plausibility |
| `mcpToEcp sets confidenceSource` | `tests/mcp/ecp-translation.test.ts` | confidenceSource === 'evidence-derived' |
| `A2A roundtrip preserves v2 fields` | `tests/a2a/ecp-a2a-translation.test.ts` | verdict → dataPart → verdict, all v2 fields survive |
| `conformance L1 rejects invalid SL opinion` | `tests/ecp-conformance/level1.test.ts` | b+d+u ≠ 1 → L1 check fails |
| `conformance L3 validates tier/engine split` | `tests/ecp-conformance/level3.test.ts` | confidence > tierReliability → L3 check fails |
| `governance filter rejects llm-self-report` | `tests/gate/governance-filter.test.ts` | `isGovernanceEligible('llm-self-report') === false` |
| `governance filter rejects undefined source` | same | `isGovernanceEligible(undefined) === false` |
| `all-llm-self-report verdicts trigger vacuous block` | `tests/gate/conflict-resolver.test.ts` | gate returns `{ decision: 'block', unverified: true }` + emits `governance:vacuous-evidence` |
| `fromScalar produces non-dogmatic opinion` | `tests/core/subjective-opinion.test.ts` | `fromScalar(0.95).uncertainty === 0.3` (not 0) |
| `fromScalar(x, 0) remains dogmatic` | same | `fromScalar(0.95, 0).uncertainty === 0` (explicit override) |
| `recalibrateWithFusion overrides compliance` | `tests/gate/quality-score.test.ts` | `recalibrateWithFusion(base, fused).architecturalCompliance === projectedProbability(fused)` |
| `recalibrateWithFusion no-op without opinion` | same | `recalibrateWithFusion(base, undefined)` returns base unchanged |
| `SL_EPSILON consistent across codebase` | `tests/core/subjective-opinion.test.ts` | Opinion with b+d+u off by 1e-7 passes `isValid()` |
| `ECP_SCHEMA_DEFAULTS flag gates defaults` | `tests/config/vinyan-config.test.ts` | When `ECP_SCHEMA_DEFAULTS=false`, Zod default remains 1.0 and quality returns 1.0 |
| `ECP_ENRICHMENT flag gates enrichment` | same | When `ECP_ENRICHMENT=false`, verdict enrichment + fromScalar fix disabled |

### 6.3 Regression Risk Matrix

| Phase | Files Changed | Existing Test Files Affected | Expected Failures |
|-------|--------------|------------------------------|-------------------|
| A (schema) | 6 | 0 | 0 — purely additive |
| B1 (Zod default) | 1 | Any test using `OracleVerdictSchema.parse()` without explicit confidence | ~2-5 tests |
| B2 (quality) | 1 | `tests/gate/quality-score.test.ts` | ~1-3 tests (assert 1.0 → now 0.5) |
| B3-B4 (clamp+resolver) | 2 | 0 — additive fields on return type | 0 |
| B5 (runner enrichment) | 1 | `tests/oracle/runner.test.ts` | ~1-2 tests (new fields in output) |
| B6-B7 (bridges) | 2 | `tests/mcp/`, `tests/a2a/` | ~0-2 tests |
| B8 (fromScalar) | 1 | Any test asserting `fromScalar().uncertainty === 0` | ~2-4 tests |
| B9 (quality split) | 1 | `tests/gate/quality-score.test.ts` | ~1-2 tests (function signature change) |
| B10 (core-loop wire) | 1 | `tests/orchestrator/core-loop.test.ts` | ~0-1 tests |
| C (conformance) | 4 | `tests/ecp-conformance/` | 0 — new tests only |
| C5 (feature flag) | 1 | 0 | 0 — new config, new tests only |

---

## 7. Migration Risks & Mitigations

| Risk | Severity | Probability | Mitigation |
|------|----------|-------------|------------|
| External oracles relying on Zod `confidence: 1.0` default get downgraded to 0.5 | HIGH | MEDIUM (oracle-sdk-ts `buildVerdict` is also passthrough — SDK users who omit `confidence` get 0.5) | Conformance v2 guide + warning when `confidenceReported` is false. Consider SDK `buildVerdict()` adding a runtime warning when confidence is omitted |
| SDK schema default out-of-sync with core schema | HIGH | MEDIUM — `packages/oracle-sdk-ts/src/schemas.ts` must change in lockstep with B1 | B1 implementation plan includes SDK schema explicitly; pre-merge CI runs both test suites; Phase A adds SDK schema to dependency graph. **Rollback:** If B1 causes external oracle issues, revert both core + SDK default to 1.0 and add `confidenceReported: false` flag instead |
| Zero-oracle quality change (1.0→0.5) triggers unexpected L0 task failures | MEDIUM | MEDIUM (L0 tasks may hit lower composite scores) | L0 tasks use binary `verification.passed` gate, not composite score — verify this in core-loop |
| A2A peers on v1 reject v2 fields as unknown | LOW | LOW (Zod `.passthrough()` ignores unknown fields) | Agent card advertises `supported_versions: [1, 2]` for negotiation |
| SL opinion invariant violation from external oracles | LOW | LOW | SubjectiveOpinionSchema `.refine()` rejects invalid opinions at parse time |
| Test churn from D3 default change | MEDIUM | HIGH (expected ~5-10 test updates) | Part of the plan — update tests in Phase B, not a regression |

### 7.1 Pre-Existing Technical Debt (not introduced by v2)

These are **not v2 blockers** but should be tracked:

1. **Zod/Interface sync gap:** `OracleVerdictSchema` (Zod) is missing fields that exist on the TypeScript `OracleVerdict` interface: `confidenceReported`, `opinion`, `rawOpinion`, `origin`. The v2 additions will add `opinion` and `tierReliability`/`engineCertainty`/`confidenceSource` to Zod, but `rawOpinion` and `origin` remain unsynced. Consider a comprehensive alignment pass in Phase A.

2. **Invalid error code:** `src/oracle/runner.ts` uses `errorCode: 'GUARDRAIL_BLOCKED'` which is not in `OracleErrorCodeSchema` (only TIMEOUT, PARSE_ERROR, TYPE_MISMATCH, SYMBOL_NOT_FOUND, ORACLE_CRASH). This would be rejected by Zod strict-parse. **Now addressed in Phase A7.**

3. **Conflict resolver step numbering:** Code comment says "5-step" and uses `resolvedAtStep: 1 | 2 | 3 | 4 | 5`, but the SL upgrade merged old steps 2+3. The design doc describes 4 logical steps — code should be updated to match (not blocking for v2).

### 7.2 Deployment Strategy

3-phase rollout with feature flag for safe behavioral changes:

| Phase | Scope | Duration | Risk | Rollback |
|-------|-------|----------|------|----------|
| **1. Schema Migration** | Phase A: types + Zod + SDK types. Both flags `false`. | Day 1 | Zero — additive optional fields only | Remove fields (backward compatible) |
| **2. Behavioral Canary** | Phase B+C: enable `ECP_ENRICHMENT` for 10% of tasks; `ECP_SCHEMA_DEFAULTS` still false. Monitor enrichment field population. | Days 2-3 | Low — flag = instant rollback | Set `ECP_ENRICHMENT=false` |
| **2b. Defaults Canary** | Enable `ECP_SCHEMA_DEFAULTS` for 10% of tasks. Monitor confidence distributions and zero-oracle paths. | Days 4-5 | Medium — changes defaults | Set `ECP_SCHEMA_DEFAULTS=false` |
| **3. Full Rollout** | 100% after 5-day stability window. Remove flag guards (flag becomes dead code). | Day 7+ | Mitigated by canary data | Revert to canary (10%) and investigate |

**Feature flag mechanics:**
```typescript
// In src/config/schema.ts:
export const ECP_SCHEMA_DEFAULTS = config.ecp?.v2SchemaDefaults ?? false;  // HIGH risk
export const ECP_ENRICHMENT = config.ecp?.v2Enrichment ?? false;            // MEDIUM risk

// ECP_SCHEMA_DEFAULTS gates (HIGH risk — changes default behavior):
// - B1: Zod confidence default remains 1.0 when false
// - B2: Zero-oracle quality returns 1.0 when false

// ECP_ENRICHMENT gates (MEDIUM risk — adds new computation):
// - B5: No verdict enrichment (tierReliability/engineCertainty) when false
// - B8: fromScalar() uses u=0 (dogmatic) when false
// - B9: No quality recalibration with fusedOpinion when false
// - B10: No engineCertainty→SelfModel wire when false

// All Phase A/C changes (schema additions, conformance) are unconditional.
```

**Canary trace field:** Each task trace persists `ecpBehaviorVersion: 1 | 2` reflecting which flag state was active. This enables forensic analysis during canary — without it, debugging confidence-related issues requires guessing which behavior path a specific task used.

**Monitoring during canary:**
- Confidence distribution shift (expect lower mean when `ECP_SCHEMA_DEFAULTS` ON)
- Oracle verdict parse failures (expect 0 — Zod still accepts v1 shape)
- Quality score distribution (expect lower composite for zero-oracle tasks when `ECP_SCHEMA_DEFAULTS` ON)
- Enrichment field population rate (expect >0 when `ECP_ENRICHMENT` ON)
- Test oracle compatibility (run conformance suite against canary)

---

## 8. Files Changed Summary

| Phase | Files (read-write) | New Functions | Modified Functions |
|-------|-------------------|---------------|-------------------|
| A | `src/core/types.ts`, `src/oracle/protocol.ts`, `src/a2a/ecp-data-part.ts`, `packages/oracle-sdk-ts/src/index.ts`, `src/core/subjective-opinion.ts` | `SubjectiveOpinionSchema`, `SL_EPSILON` | None (additive only) |
| B | `src/oracle/protocol.ts`, `packages/oracle-sdk-ts/src/schemas.ts`, `src/gate/quality-score.ts`, `src/oracle/tier-clamp.ts`, `src/gate/conflict-resolver.ts`, `src/oracle/runner.ts`, `src/mcp/ecp-translation.ts`, `src/a2a/ecp-a2a-translation.ts`, `src/core/subjective-opinion.ts`, `src/orchestrator/core-loop.ts` | `clampOpinionFull()`, `enrichVerdictWithRegistryData()`, `isGovernanceEligible()`, `computeFromVerdicts()`, `recalibrateWithFusion()` | `fromScalar()`, `computeQualityScore()`, `resolveConflicts()`, `mcpToEcp()`, `verdictToECPDataPart()`, `ecpDataPartToVerdict()` |
| C | `packages/ecp-conformance/src/level1.ts`, `packages/ecp-conformance/src/level3.ts`, `packages/ecp-conformance/src/schemas.ts`, `src/a2a/agent-card.ts`, `src/config/schema.ts` | L1/L3 validation checks, `ECP_SCHEMA_DEFAULTS`, `ECP_ENRICHMENT` | `generateAgentCard()` |

**Total: 19 files changed, 6 new functions/constants, ~11 modified functions.**

---

## 9. Estimated Effort by Phase

| Phase | Scope | Complexity | Verification |
|-------|-------|-----------|--------------|
| **A** — Schema | 5 files, additive only | Trivial | `get_errors` + `bun run test` |
| **B** — Behavioral | 10 files, default changes + new functions + dead end wiring | Medium — B1, B5, B8, B9 need careful test updates | `get_errors` + affected tests + `bun run test:all` |
| **C** — Integration | 5 files, conformance + agent card + feature flag | Low | `get_errors` + conformance tests |

---

## 10. Appendix: Axiom Traceability

Every v2 change traces to a Vinyan axiom:

| Change | Primary Axiom | Motivation | Justification |
|--------|--------------|------------|---------------|
| Vacuous default (D3) | A2 — First-Class Uncertainty | axiom-driven | "I don't know" is a valid state, not masked as 1.0 |
| SL opinion promotion | A2 — First-Class Uncertainty | axiom-driven | Rich uncertainty representation, not just scalar |
| Confidence source enum | A3 — Deterministic Governance | axiom-driven | Machine-enforceable LLM exclusion from governance |
| Tier/engine split | A5 — Tiered Trust | axiom-driven | Separates methodology reliability from per-verdict certainty |
| Tier reliability from registry | A6 — Zero-Trust Execution | axiom-driven | Orchestrator assigns trust, not the engine itself |
| Belief interval (on ResolvedGateResult only) | A2 — First-Class Uncertainty | axiom-driven | Makes "gap between what we know and don't" explicit, post-fusion only |
| clampOpinionFull | A5 — Tiered Trust | axiom-driven | SL-native tier enforcement (uncertainty floors) |
| Conformance v2 checks | A3 — Deterministic Governance | axiom-driven | Rule-based validation, no LLM in compliance path |
| Level-differentiated fusion (§3.3.7) | A5 — Tiered Trust | axiom-driven | L0-L1 use scalar averaging; L2-L3 use full SL fusion — match verification depth to risk |
| Governance empty-set fallback (§3.3.5) | A2 + A3 — Uncertainty + Governance | axiom-driven | Honest block when no verifiable evidence exists, logged for A7 calibration |
| A2A trust override (§3.4.2) | A6 — Zero-Trust Execution | axiom-driven | Untrusted peers cannot claim evidence-derived confidence |
| SL invariant guard (§3.3.3) | A2 — First-Class Uncertainty | axiom-driven | Normalize malformed opinions from external sources before clamping |
| `fromScalar()` fix (§3.3.8) | A2 — First-Class Uncertainty | axiom-driven | Eliminate dogmatic u=0 fabrication; honest uncertainty from scalar conversion |
| Quality-score pipeline split (§3.3.9) | A3 — Deterministic Governance | engineering | Unambiguous execution order; fusion feeds quality deterministically |
| FP tolerance standardization (§3.3.10) | A2 — First-Class Uncertainty | engineering | Consistent SL invariant checking prevents silent validation failures |
| `engineCertainty` → SelfModel wire (§4.3) | A7 — Prediction Error as Learning | axiom-driven | Closes calibration feedback loop; enables predicted vs actual comparison |
| `fusedOpinion` → quality recalibration (§4.4) | A5 + A7 — Tiered Trust + Learning | axiom-driven | SL-grade fusion replaces scalar averaging in quality assessment |
| Feature flag (§7.2) | — | engineering | Deployment best practice; instant rollback without code change |

---

## 11. Deferred Debate Items

The following items were identified during the [ECP debate synthesis](../research/ecp-debate-synthesis.md) as Tier 0 (critical) but are **not in current scope**. They are behavioral/operational capabilities, not protocol-layer changes.

| Item | Source | Deferral Rationale |
|------|--------|--------------------|
| Miscalibration auto-recovery handler | Debate §3.1 | Orchestrator behavior — implement in Phase 7 (self-improvement loop) |
| Fix `isUncertain` + escalation-only-retry | Debate §3.2 | Requires core-loop behavioral change, not protocol schema change |
| Oracle contradiction recovery protocol | Debate §3.3 | Behavioral capability requiring new state machine, not schema |
| Config validation framework | Debate §3.4 | Operational guard — independent of ECP protocol version |
| Fix 7 axiom violations in existing code | Debate §3.5 | Requires separate audit pass — orthogonal to v2 schema changes |
| Trace archival + cascade invalidation | Debate §3.6 | World-graph operational concern, not ECP wire protocol |
| Threshold governance (A3 compliance) | Debate §3.7 | Runtime governance — depends on v2 `confidenceSource` field existing first |
| Evidence confidence enum | Debate §3.8 | **Partially covered** by `confidenceSource` field on OracleVerdict |

| Governance filter calibration | Design review | Whether `isGovernanceEligible()` rules should themselves produce traces and be subject to A7 learning. Depends on v2 `confidenceSource` infrastructure. |

> **Dependency note:** Threshold governance (item 7) depends on v2's `confidenceSource` field existing. Once v2 is deployed, this becomes implementable without further schema changes.

---

## 12. Autonomy Readiness Assessment (Phase 7 Foundation)

v2 provides ~60% of Phase 7's **data-structure foundation** (schemas, wire format, persistence). The remaining 40% — algorithms (EMA learning, drift detection) and operational infrastructure (monitoring, alerting) — represents the majority of Phase 7's implementation effort.

### What v2 Enables for Phase 7

| Autonomy Metric | v2 Status | Phase 7 Gap |
|----------------|-----------|-------------|
| Self-Correcting Routing | 🟡 Partial | v2 wires dead ends (DE1-DE5); Phase 7 adds EMA learning algorithm that consumes `engineCertainty` + `fusedOpinion` |
| Graceful Degradation | 🟢 Strong | v2 defines confidence tiers + governance filter; Phase 7 adds trigger rules for automatic escalation |
| Drift Recovery | 🟡 Partial | v2 populates `engineCertainty` in traces; Phase 7 adds comparison algorithm (predicted vs actual delta → EMA mismatch) |
| Evidential Soundness (A1-A4) | 🟡 Mixed | v2 fixes `fromScalar()` u=0 and tolerance inconsistency; Phase 7 adds compliance test suite |
| No Silent Regressions | 🟡 Partial | v2 adds quality thresholds + `confidenceSource` governance; Phase 7 adds anomaly detection |
| Bounded Miscalibration | ⬜ Deferred | Phase 7: EMA bounds + calibration loop + cold-start bootstrap |
| Operator-Free Operation | 🟢 Strong | v2 + existing task decomposer + worker routing = most infrastructure present |

### What Phase 7 Builds Directly on v2

- **Drift Recovery** — `engineCertainty` history in traces (v2) + comparison algorithm (PH7)
- **Auto-Learning Routing** — `fusedOpinion` framework (v2) + EMA learning (PH7)
- **Silent Regression Detection** — `qualityScore` + `confidenceSource` governance (v2) + anomaly detection (PH7)

### What Phase 7 Still Needs (New Infrastructure)

- Calibration algorithm (EMA loop, bounds enforcement, cold-start bootstrap)
- Operator-free monitoring (auto-alerting on miscalibration threshold)
- Feedback loop closure (outcome capture, latency tracking, confidence→outcome correlation)
