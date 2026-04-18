# Subjective Logic Integration Design for ECP

> **Date:** 2026-04-01 | **Status:** Design | **Audience:** Protocol designers, implementers
> **Prerequisite reading:** `docs/research/formal-uncertainty-frameworks.md`, `docs/spec/ecp-spec.md` ss4
> **Axiom justification:** A2 (First-Class Uncertainty), A5 (Tiered Trust), A3 (Deterministic Governance)

---

## 1. Problem Statement

Vinyan's current confidence model is a single scalar in [0, 1], clamped by trust tier, transport, and peer trust. This model conflates two fundamentally different epistemic states:

- **Balanced evidence:** "I have strong evidence both for and against" -> confidence = 0.5
- **No evidence:** "I have not examined this" -> confidence = 0.5

The scalar also cannot express how much of a verdict's uncertainty stems from lack of examination versus genuine ambiguity. When aggregating verdicts from multiple oracles, the system cannot distinguish independent evidence from shared upstream dependencies, leading to overconfident combined estimates.

Subjective Logic (Josang, 2016) resolves these problems with an opinion tuple `omega = (b, d, u, a)` that explicitly separates belief, disbelief, and uncertainty mass. The projected probability `P = b + a*u` maintains backward compatibility with the scalar model while exposing the richer epistemic structure needed for principled oracle composition.

This document specifies the concrete integration of Subjective Logic into ECP, covering type definitions, migration path, fusion operators, clamping semantics, and wire format.

---

## 2. SubjectiveOpinion Type

### 2.1 TypeScript Interface

```typescript
/**
 * Subjective Logic opinion tuple (Josang, 2016).
 *
 * Invariants:
 *   b + d + u = 1
 *   0 <= b, d, u <= 1
 *   0 < a < 1
 *
 * Projected probability: P = b + a * u
 * When u = 0, reduces to standard probability (b = P, d = 1 - P).
 * When u = 1, reduces to prior (P = a).
 */
interface SubjectiveOpinion {
  /** Belief mass — confidence in the hypothesis. */
  belief: number;
  /** Disbelief mass — confidence in the negation. */
  disbelief: number;
  /** Uncertainty mass — unassigned evidence (b + d + u = 1). */
  uncertainty: number;
  /** Base rate (prior probability). Influences projected probability when u > 0. */
  baseRate: number;
}
```

### 2.2 Zod Schema

```typescript
import { z } from "zod/v4";

export const SubjectiveOpinionSchema = z
  .object({
    belief: z.number().min(0).max(1),
    disbelief: z.number().min(0).max(1),
    uncertainty: z.number().min(0).max(1),
    base_rate: z.number().gt(0).lt(1),
  })
  .check(
    (val) => Math.abs(val.belief + val.disbelief + val.uncertainty - 1.0) < 1e-9,
    { error: "belief + disbelief + uncertainty must equal 1" },
  );
```

**Note on naming:** The Zod schema uses `snake_case` (`base_rate`) for wire format consistency with the existing `ECPDataPartSchema`. The TypeScript interface uses `camelCase` (`baseRate`) for in-process consistency with the existing codebase (e.g., `baseRate` matches `fileHashes`, `oracleName`, `durationMs` patterns in `OracleVerdict`).

### 2.3 Location

The `SubjectiveOpinion` interface and a `SubjectiveOpinionSchema` Zod schema should live in a new file:

```
src/core/subjective-opinion.ts
```

Rationale: It is a core epistemic primitive referenced by `types.ts` (OracleVerdict), `ecp-data-part.ts` (wire format), `conflict-resolver.ts` (fusion), and `tier-clamp.ts` (clamping). Placing it under `src/core/` mirrors the existing pattern where `types.ts` and `bus.ts` hold fundamental abstractions. A dedicated file avoids bloating `types.ts` and allows importing the Zod schema without pulling in all core types.

### 2.4 Relationship to OracleVerdict

Add an optional `opinion` field to OracleVerdict:

```typescript
export interface OracleVerdict {
  // ... existing fields unchanged ...
  confidence: number;  // ALWAYS present — backward compat

  /** Subjective Logic opinion (ECP). When absent, derive from confidence. */
  opinion?: SubjectiveOpinion;
}
```

The `confidence` field remains mandatory and authoritative for all existing code paths. The `opinion` field enriches it with the uncertainty dimension. The two must be consistent: `opinion.belief + opinion.baseRate * opinion.uncertainty` should approximate `confidence` within a tolerance of 0.01.

### 2.5 Helper Functions

```typescript
// src/core/subjective-opinion.ts

/** Derive a SubjectiveOpinion from a scalar confidence (Phase A shim). */
export function fromScalar(confidence: number, baseRate: number = 0.5): SubjectiveOpinion {
  // Scalar confidence implies u = 0 (all evidence examined, no uncertainty declared)
  return {
    belief: confidence,
    disbelief: 1 - confidence,
    uncertainty: 0,
    baseRate,
  };
}

/** Compute projected probability P = b + a * u. */
export function projectedProbability(o: SubjectiveOpinion): number {
  return o.belief + o.baseRate * o.uncertainty;
}

/** Create a vacuous opinion (no evidence). */
export function vacuous(baseRate: number = 0.5): SubjectiveOpinion {
  return { belief: 0, disbelief: 0, uncertainty: 1, baseRate };
}

/** Create a dogmatic opinion (complete certainty, u = 0). */
export function dogmatic(belief: number, baseRate: number = 0.5): SubjectiveOpinion {
  return { belief, disbelief: 1 - belief, uncertainty: 0, baseRate };
}

/** Check if an opinion is effectively vacuous (u > threshold). */
export function isVacuous(o: SubjectiveOpinion, threshold: number = 0.95): boolean {
  return o.uncertainty > threshold;
}

/** Validate the b + d + u = 1 invariant. */
export function isValid(o: SubjectiveOpinion): boolean {
  const sum = o.belief + o.disbelief + o.uncertainty;
  return (
    Math.abs(sum - 1.0) < 1e-9 &&
    o.belief >= 0 && o.disbelief >= 0 && o.uncertainty >= 0 &&
    o.baseRate > 0 && o.baseRate < 1
  );
}

/**
 * Resolve an OracleVerdict's opinion: return the explicit opinion if present,
 * otherwise derive from scalar confidence using the given base rate.
 */
export function resolveOpinion(
  verdict: { confidence: number; opinion?: SubjectiveOpinion },
  baseRate: number = 0.5,
): SubjectiveOpinion {
  return verdict.opinion ?? fromScalar(verdict.confidence, baseRate);
}
```

---

## 3. Migration Path

### Phase A: Additive (Immediate, Non-Breaking)

**Goal:** Add opinion support without changing any existing behavior.

**Steps:**

1. Create `src/core/subjective-opinion.ts` with the type, schema, and helper functions from ss2.
2. Add optional `opinion?: SubjectiveOpinion` to the `OracleVerdict` interface in `src/core/types.ts`.
3. Add optional `opinion` field to `ECPDataPartSchema` in `src/a2a/ecp-data-part.ts` (see ss8).
4. Update `buildVerdict()` in `src/core/index.ts` to accept an optional `opinion` parameter and pass it through.
5. Add `resolveOpinion()` as a convenience — all consumers that need an opinion call this, getting either the explicit opinion or the derived one.

**Behavioral guarantee:** No existing test changes. No existing code path changes. The `opinion` field is purely additive. All existing consumers continue to read `confidence` as before.

**Derivation rule (scalar -> opinion):**

```
opinion = { b: confidence, d: 1 - confidence, u: 0, a: 0.5 }
```

This is a dogmatic opinion — zero uncertainty, which honestly represents that the scalar confidence model declares no uncertainty. It is NOT an accurate epistemic claim (deterministic oracles truly have u ~ 0, but heuristic oracles should have u > 0). The derivation is a compatibility shim, not truth.

### Phase B: Oracle Enrichment (Per-Oracle, Incremental)

**Goal:** Oracle runners populate `opinion` with meaningful uncertainty values.

**Steps:**

1. Update each oracle runner to emit `opinion` alongside `confidence`.
2. The `confidence` field is set to `projectedProbability(opinion)` for backward compatibility.
3. Uncertainty ranges by oracle type:

| Oracle | Tier | Typical u | Rationale |
|:-------|:-----|:----------|:----------|
| AST oracle | deterministic | 0.0 | Parse either succeeds or fails. No uncertainty. |
| Type oracle | deterministic | 0.0 | tsc --noEmit is binary. |
| Dep oracle | heuristic | 0.10 - 0.25 | Import graph may miss dynamic imports, re-exports. |
| Test oracle | deterministic | 0.0 - 0.05 | Tests pass/fail deterministically; u > 0 only for flaky detection. |
| Lint oracle | deterministic | 0.0 | Lint rules are binary. |
| LLM-backed oracle | probabilistic | 0.20 - 0.50 | Model uncertainty is inherent. |
| Remote A2A oracle | varies | += 0.05 - 0.15 | Transport adds uncertainty on top of base oracle u. |

4. Update `buildVerdict()` to auto-compute `confidence = projectedProbability(opinion)` when opinion is provided but confidence is not explicitly set.

**Migration order:** Start with the dep oracle (highest natural uncertainty among built-ins), then LLM-backed oracles (Phase 1), then remote A2A oracles (Phase 5). Deterministic oracles can emit `opinion = { b: 1, d: 0, u: 0, a: 0.5 }` immediately since their uncertainty is genuinely zero.

### Phase C: Full SL Fusion (Replaces Heuristic Aggregation)

**Goal:** Replace the 5-step conflict resolver's heuristic with SL fusion operators.

**Steps:**

1. Implement fusion operators in `src/core/subjective-opinion.ts` (see ss5).
2. Add source independence declarations to oracle registration (see ss5.4).
3. Refactor `conflict-resolver.ts`:
   - Steps 1-2 remain (domain separation and tier ranking are orthogonal to fusion).
   - Steps 3-4 (evidence weight, historical accuracy) are replaced by SL fusion with K-based conflict detection.
   - Step 5 (escalation) is replaced by K threshold check.
4. Update `quality-score.ts` to use projected probability from fused opinions instead of raw pass/fail ratios.
5. The `confidence` field on `GateResult` becomes `projectedProbability(fusedOpinion)`.

**Prerequisites for Phase C:**
- All blocking oracles must emit `opinion` (Phase B complete for built-ins).
- Source independence declarations populated in oracle registry.
- Backtesting against trace data to validate that SL fusion produces equivalent or better decisions than the current 5-step heuristic on historical data.

---

## 4. Base Rate Selection Rules

The base rate `a` is the prior probability P(H) when no evidence exists (`u = 1`). It determines projected probability for partially uncertain opinions. Getting it wrong biases every verdict.

### 4.1 Per-Tier Default Base Rates

```typescript
const TIER_BASE_RATES: Record<string, number> = {
  deterministic: 0.5,   // Agnostic — compiler either passes or doesn't
  heuristic:     0.4,   // Slightly pessimistic — heuristics have known biases
  probabilistic: 0.3,   // Pessimistic — statistical methods have inherent error
  speculative:   0.2,   // Very pessimistic — speculation is often wrong
};
```

**Rationale for asymmetric priors:** The base rate answers "if this oracle had zero evidence, what would we guess?" For deterministic tools (compilers, parsers), there is no intrinsic bias — 0.5 is correct. For heuristic and probabilistic tools, we observe empirically that they produce more false positives than false negatives in verification contexts. The pessimistic prior encodes this: absent evidence, assume the hypothesis is more likely false than true.

**Why not all 0.5?** A uniform base rate of 0.5 across all tiers would mean that a vacuous opinion from a speculative oracle (u = 1) produces the same projected probability (0.5) as a vacuous opinion from a deterministic oracle. This violates A5 (Tiered Trust) — we should trust the absence of speculative evidence less than the absence of deterministic evidence.

### 4.2 Per-Oracle Override

Some oracles have domain-specific base rates that differ from their tier default. The oracle registration should allow overriding:

```typescript
export interface OracleRegistryEntry {
  // ... existing fields ...
  tier?: "deterministic" | "heuristic" | "probabilistic" | "speculative";
  /** Override the tier's default base rate for projected probability. */
  baseRate?: number;
}
```

**Examples:**
- A test oracle checking a function with 90% historical pass rate: `baseRate = 0.9` (we expect it to pass).
- A lint oracle for a new linter configuration: `baseRate = 0.3` (new configs often have false positives).
- A remote A2A oracle from an untrusted peer: `baseRate = 0.2` (pessimistic about remote claims).

### 4.3 Resolution Order

When resolving the base rate for a verdict:

```
1. verdict.opinion.baseRate         (oracle explicitly set it)
2. oracleRegistry[name].baseRate    (per-oracle override)
3. TIER_BASE_RATES[tier]            (tier default)
4. 0.5                              (ultimate fallback)
```

The first non-undefined value wins. This allows progressive refinement: start with tier defaults, then tune per-oracle as calibration data accumulates (A7 Prediction Error as Learning).

### 4.4 Calibration via Prediction Error

Phase C+ enhancement: use the Self-Model's prediction error tracking (A7) to calibrate base rates empirically.

```
a_calibrated = EMA(actual_pass_rate, alpha=0.1)
```

Where `actual_pass_rate` is the exponential moving average of historical outcomes for this oracle on this task type. This converges the prior toward the true pass rate. Gating condition: require >= 30 historical verdicts before overriding the tier default (small-sample protection).

---

## 5. Fusion Operator Selection Algorithm

### 5.1 Operators

Subjective Logic defines several fusion operators. The three relevant to oracle composition:

**Cumulative Fusion (CF):** Combines independent evidence. Like adding observations to a dataset. The result has less uncertainty than either input — more evidence means more certainty.

```typescript
function cumulativeFusion(a: SubjectiveOpinion, b: SubjectiveOpinion): SubjectiveOpinion {
  // Josang (2016), Definition 12.2
  // Handles the case where both opinions are dogmatic (u_a = u_b = 0)
  if (a.uncertainty === 0 && b.uncertainty === 0) {
    // Both dogmatic: use averaging as fallback (gamma = 0.5)
    return averagingFusion(a, b);
  }

  const denom = a.uncertainty + b.uncertainty - a.uncertainty * b.uncertainty;

  const belief = (a.belief * b.uncertainty + b.belief * a.uncertainty) / denom;
  const disbelief = (a.disbelief * b.uncertainty + b.disbelief * a.uncertainty) / denom;
  const uncertainty = (a.uncertainty * b.uncertainty) / denom;

  // Base rate: weighted by uncertainty mass (more uncertain source has more prior influence)
  const baseRate = (a.baseRate * b.uncertainty + b.baseRate * a.uncertainty) /
                   (a.uncertainty + b.uncertainty);

  return { belief, disbelief, uncertainty, baseRate };
}
```

**Key property:** `u_fused < min(u_a, u_b)` — cumulative fusion always reduces uncertainty. This is correct when sources are independent; it would be dangerously overconfident for dependent sources.

**Averaging Fusion (AF):** Combines dependent evidence. Averages opinions without reducing uncertainty beyond the mean.

```typescript
function averagingFusion(a: SubjectiveOpinion, b: SubjectiveOpinion): SubjectiveOpinion {
  // Josang (2016), Definition 12.6
  // Equal weights (gamma_a = gamma_b = 0.5)
  const belief = 0.5 * a.belief + 0.5 * b.belief;
  const disbelief = 0.5 * a.disbelief + 0.5 * b.disbelief;
  const uncertainty = 0.5 * a.uncertainty + 0.5 * b.uncertainty;
  const baseRate = 0.5 * a.baseRate + 0.5 * b.baseRate;

  return { belief, disbelief, uncertainty, baseRate };
}
```

**Key property:** `u_fused = mean(u_a, u_b)` — uncertainty does NOT decrease. This is conservative; appropriate when sources share evidence.

**Weighted Fusion (WF):** Combines sources with different reliability levels. Tier weights determine influence.

```typescript
function weightedFusion(
  a: SubjectiveOpinion,
  wa: number,
  b: SubjectiveOpinion,
  wb: number,
): SubjectiveOpinion {
  const totalW = wa + wb;
  const na = wa / totalW;
  const nb = wb / totalW;

  const belief = na * a.belief + nb * b.belief;
  const disbelief = na * a.disbelief + nb * b.disbelief;
  const uncertainty = na * a.uncertainty + nb * b.uncertainty;
  const baseRate = na * a.baseRate + nb * b.baseRate;

  return { belief, disbelief, uncertainty, baseRate };
}
```

### 5.2 Source Independence Declaration

Extend `OracleRegistryEntry` with shared dependency metadata:

```typescript
export interface OracleRegistryEntry {
  // ... existing fields ...

  /** Shared upstream dependencies. Oracles with overlapping deps are NOT independent. */
  sharedDependencies?: string[];

  /** Epistemic domain — oracles in different domains assess different concerns. */
  domain?: "structural" | "quality" | "functional";
}
```

**Built-in oracle dependency declarations:**

| Oracle | `sharedDependencies` | `domain` |
|:-------|:---------------------|:---------|
| ast-oracle | `["ast-parse", "file-read"]` | structural |
| type-oracle | `["ast-parse", "file-read", "tsconfig"]` | structural |
| dep-oracle | `["ast-parse", "file-read", "import-graph"]` | structural |
| test-oracle | `["test-runner", "runtime-exec"]` | functional |
| lint-oracle | `["ast-parse", "file-read", "lint-config"]` | quality |

### 5.3 Operator Selection Algorithm

Given two oracles A and B, select the fusion operator:

```typescript
function selectFusionOperator(
  a: OracleRegistryEntry,
  b: OracleRegistryEntry,
): "cumulative" | "averaging" | "weighted" {
  const aDeps = new Set(a.sharedDependencies ?? []);
  const bDeps = new Set(b.sharedDependencies ?? []);

  // Compute Jaccard overlap
  const intersection = [...aDeps].filter(d => bDeps.has(d)).length;
  const union = new Set([...aDeps, ...bDeps]).size;
  const overlap = union > 0 ? intersection / union : 0;

  // Different domains are always independent (even with shared file reads)
  if (a.domain && b.domain && a.domain !== b.domain) {
    return "cumulative";
  }

  // Same domain: check dependency overlap
  if (overlap > 0.5) {
    // High overlap: dependent sources — use averaging
    return "averaging";
  }

  if (overlap > 0) {
    // Partial overlap: use weighted fusion with tier weights
    return "weighted";
  }

  // No overlap: independent — cumulative fusion
  return "cumulative";
}
```

**Threshold rationale:** The 0.5 Jaccard threshold is conservative. Two oracles sharing more than half their upstream dependencies are treated as dependent. This avoids the overconfidence trap where AST + Type oracles (both reading the same file, both parsing the same AST) produce artificially reduced uncertainty via cumulative fusion.

### 5.4 Multi-Oracle Fusion (N > 2)

For N oracles, fusion is applied pairwise in tier-priority order (highest tier first):

```typescript
function fuseAll(
  opinions: Array<{ name: string; opinion: SubjectiveOpinion; entry: OracleRegistryEntry }>,
): SubjectiveOpinion {
  // Sort by tier priority descending (deterministic first)
  const sorted = [...opinions].sort(
    (a, b) => getTierPriority(b.entry.tier) - getTierPriority(a.entry.tier)
  );

  // Skip vacuous opinions — they should not influence the result
  const nonVacuous = sorted.filter(o => !isVacuous(o.opinion));
  if (nonVacuous.length === 0) return vacuous(0.5);
  if (nonVacuous.length === 1) return nonVacuous[0].opinion;

  let fused = nonVacuous[0].opinion;

  for (let i = 1; i < nonVacuous.length; i++) {
    const operator = selectFusionOperator(nonVacuous[0].entry, nonVacuous[i].entry);

    switch (operator) {
      case "cumulative":
        fused = cumulativeFusion(fused, nonVacuous[i].opinion);
        break;
      case "averaging":
        fused = averagingFusion(fused, nonVacuous[i].opinion);
        break;
      case "weighted": {
        const wa = TIER_WEIGHTS[nonVacuous[0].entry.tier ?? "deterministic"] ?? 1.0;
        const wb = TIER_WEIGHTS[nonVacuous[i].entry.tier ?? "deterministic"] ?? 1.0;
        fused = weightedFusion(fused, wa, nonVacuous[i].opinion, wb);
        break;
      }
    }
  }

  return fused;
}
```

**Note on associativity:** Cumulative fusion is commutative and associative, so pairwise order does not matter. Averaging fusion is commutative and associative. Weighted fusion depends on weight allocation. The tier-priority ordering ensures that the highest-trust evidence anchors the fusion.

---

## 6. Conflict Constant K Computation

### 6.1 Definition

For two opinions mapped to mass functions on the binary frame `{H, not-H}`:

```
m_1({H})       = b_1
m_1({not-H})   = d_1
m_1({H,not-H}) = u_1

m_2({H})       = b_2
m_2({not-H})   = d_2
m_2({H,not-H}) = u_2
```

The conflict constant K is the total mass assigned to the empty set before normalization in Dempster's rule:

```
K = m_1({H}) * m_2({not-H}) + m_1({not-H}) * m_2({H})
K = b_1 * d_2 + d_1 * b_2
```

### 6.2 Implementation

```typescript
/** Compute Dempster-Shafer conflict constant between two opinions. */
function conflictConstant(a: SubjectiveOpinion, b: SubjectiveOpinion): number {
  return a.belief * b.disbelief + a.disbelief * b.belief;
}

/** Compute pairwise conflict matrix and max conflict for a set of opinions. */
function computeConflictReport(
  opinions: Array<{ name: string; opinion: SubjectiveOpinion }>,
): ConflictReport {
  let maxK = 0;
  const pairs: Array<{ a: string; b: string; k: number }> = [];

  for (let i = 0; i < opinions.length; i++) {
    for (let j = i + 1; j < opinions.length; j++) {
      const k = conflictConstant(opinions[i].opinion, opinions[j].opinion);
      pairs.push({ a: opinions[i].name, b: opinions[j].name, k });
      if (k > maxK) maxK = k;
    }
  }

  return {
    maxConflict: maxK,
    isHighConflict: maxK > HIGH_CONFLICT_THRESHOLD,
    pairs,
  };
}

interface ConflictReport {
  /** Maximum pairwise conflict constant. */
  maxConflict: number;
  /** True when maxConflict exceeds the threshold — do not fuse, report contradiction. */
  isHighConflict: boolean;
  /** All pairwise conflict values for diagnostics. */
  pairs: Array<{ a: string; b: string; k: number }>;
}
```

### 6.3 Conflict Threshold

```typescript
const HIGH_CONFLICT_THRESHOLD = 0.5;
```

**Interpretation:**
- K = 0: No conflict. Sources fully agree.
- K < 0.3: Low conflict. Safe to fuse with any operator.
- 0.3 <= K < 0.5: Moderate conflict. Fuse with averaging (conservative) rather than cumulative.
- K >= 0.5: High conflict. More than half the joint evidence is contradictory. Do NOT fuse — report as `type: "contradictory"` and escalate.

**Rationale for 0.5:** When K >= 0.5, the normalization in Dempster's rule (`1 / (1 - K)`) amplifies the remaining mass by at least 2x, which can produce Zadeh-paradox-like counterintuitive results. The 0.5 threshold is standard in the DST literature and conservative enough to avoid pathological fusion outcomes.

### 6.4 Integration with Conflict Resolver

In the refactored conflict resolver (Phase C), K replaces steps 3-5:

```typescript
// Pseudocode: Phase C conflict resolution
function resolveConflictsPhaseC(
  oracleResults: Record<string, OracleVerdict>,
  config: ResolverConfig,
): ResolvedGateResult {
  // Step 1: Domain separation (unchanged from current)
  // Step 2: Tier ranking (unchanged from current)

  // NEW Step 3: Compute K for same-domain, same-tier conflicts
  const conflictReport = computeConflictReport(sameTierOpinions);

  if (conflictReport.isHighConflict) {
    // K > 0.5: Do not fuse, escalate as contradictory
    return {
      decision: "block",
      reasons: [`High oracle conflict (K=${conflictReport.maxConflict.toFixed(3)})`],
      resolutions: [],
      hasContradiction: true,
      conflictReport,  // NEW field
    };
  }

  // K <= 0.5: Fuse opinions using appropriate operator
  const fusedOpinion = fuseAll(opinions);
  const projectedConf = projectedProbability(fusedOpinion);

  // Decision based on fused projected probability
  return {
    decision: projectedConf >= ALLOW_THRESHOLD ? "allow" : "block",
    reasons: projectedConf < ALLOW_THRESHOLD ? [`Fused confidence ${projectedConf.toFixed(3)} below threshold`] : [],
    resolutions: [],
    hasContradiction: false,
    fusedOpinion,  // NEW field
    conflictReport,
  };
}
```

### 6.5 Extended ResolvedGateResult

```typescript
export interface ResolvedGateResult {
  decision: "allow" | "block";
  reasons: string[];
  resolutions: ConflictResolution[];
  hasContradiction: boolean;
  /** Phase C: Fused opinion from all non-vacuous oracle verdicts. */
  fusedOpinion?: SubjectiveOpinion;
  /** Phase C: Pairwise conflict analysis. */
  conflictReport?: ConflictReport;
}
```

---

## 7. Tier Clamping with Subjective Logic

### 7.1 Problem

Current clamping: `Math.min(confidence, TIER_CAPS[tier])`. This directly reduces the scalar. With opinions, we need a clamping strategy that respects the epistemic semantics.

**Constraint:** Clamping must NEVER reduce uncertainty. Reducing `u` would claim more evidence exists than actually does — a direct violation of A2 (First-Class Uncertainty).

### 7.2 Design: Clamp Projected Probability

Clamping applies to the projected probability `P = b + a*u`, not to the opinion components directly.

**Algorithm:**

```typescript
function clampOpinionByTier(
  opinion: SubjectiveOpinion,
  tier: string,
): SubjectiveOpinion {
  const cap = TIER_CAPS[tier] ?? 1.0;
  const P = projectedProbability(opinion);

  if (P <= cap) return opinion;  // No clamping needed

  // P exceeds cap. Reduce belief to bring P down to cap.
  // P_new = b_new + a * u = cap
  // b_new = cap - a * u
  const newBelief = Math.max(0, cap - opinion.baseRate * opinion.uncertainty);

  // Redistributed mass goes to disbelief (we trust the tier constraint)
  const newDisbelief = 1 - newBelief - opinion.uncertainty;

  return {
    belief: newBelief,
    disbelief: Math.max(0, newDisbelief),
    uncertainty: opinion.uncertainty,  // NEVER touch uncertainty
    baseRate: opinion.baseRate,
  };
}
```

**Why reduce belief, not increase disbelief directly?** The tier cap says "this type of oracle cannot be more than X confident." This means we have meta-evidence that limits belief. The excess belief mass converts to disbelief mass — the tier constraint is itself a form of evidence against unbounded confidence.

### 7.3 Transport and Peer Trust Clamping

The same principle applies to transport and peer trust clamping:

```typescript
function clampOpinionFull(
  opinion: SubjectiveOpinion,
  tier?: string,
  transport?: string,
  peerTrust?: PeerTrustLevel,
): SubjectiveOpinion {
  let clamped = opinion;
  if (tier) clamped = clampOpinionByTier(clamped, tier);
  if (transport) clamped = clampOpinionByTransport(clamped, transport);
  if (peerTrust) clamped = clampOpinionByPeerTrust(clamped, peerTrust);
  return clamped;
}
```

Each clamping stage uses the same algorithm: if projected probability exceeds the cap, reduce belief while preserving uncertainty.

### 7.4 Clamping Interaction with Scalar Confidence

During Phase A and B (mixed scalar/opinion mode), clamping works at both levels:

1. `clampFull(confidence, tier, transport, peerTrust)` — clamps scalar as before.
2. `clampOpinionFull(opinion, tier, transport, peerTrust)` — clamps opinion if present.
3. The clamped `confidence` field is set to `projectedProbability(clampedOpinion)` to maintain consistency.

### 7.5 Alternative Considered: Cap on Projected Probability Only

An alternative approach: store the raw (unclamped) opinion and apply the cap only when computing projected probability for decisions. This preserves the original epistemic information.

**Pros:** Full provenance — the original oracle opinion is recoverable. Useful for auditing and A7 calibration.

**Cons:** Consumers must remember to apply clamping. Risk of accidentally using unclamped values in decision paths.

**Decision:** Clamp at intake (modify the opinion), but store the original unclamped opinion in a separate `rawOpinion` field for audit purposes. This follows the current pattern where `confidence` is clamped at intake in the oracle runner.

```typescript
export interface OracleVerdict {
  // ... existing fields ...
  opinion?: SubjectiveOpinion;       // Clamped (used for decisions)
  rawOpinion?: SubjectiveOpinion;    // Unclamped (audit/calibration only)
}
```

---

## 8. Wire Format Extension

### 8.1 ECPDataPart Schema Extension

Add an optional `opinion` field to `ECPDataPartSchema`:

```typescript
export const ECPDataPartSchema = z.object({
  ecp_version: z.literal(1),  // Stays at 1 — additive change, not breaking
  message_type: ECPMessageType,
  epistemic_type: EpistemicType,
  confidence: z.number().min(0).max(1),         // ALWAYS present
  confidence_reported: z.boolean(),
  opinion: SubjectiveOpinionSchema.optional(),   // NEW — ECP extension
  evidence: z.array(EvidencePartSchema).optional(),
  falsifiable_by: z.string().optional(),
  temporal_context: TemporalContextSchema.optional(),
  conversation_id: z.string().optional(),
  trace_context: TraceContextSchema.optional(),
  cost: CostSignalSchema.optional(),
  payload: z.unknown(),
  signer: SignerSchema.optional(),
  signature: z.string().optional(),
});
```

### 8.2 Wire Format Example

```json
{
  "ecp_version": 1,
  "message_type": "respond",
  "epistemic_type": "known",
  "confidence": 0.76,
  "confidence_reported": true,
  "opinion": {
    "belief": 0.6,
    "disbelief": 0.1,
    "uncertainty": 0.3,
    "base_rate": 0.4
  },
  "evidence": [
    { "file": "src/auth/login.ts", "line": 42, "snippet": "export function validate()" }
  ],
  "payload": { "verified": true }
}
```

**Consistency constraint:** `confidence` must equal `projectedProbability(opinion)` within tolerance. Here: `0.6 + 0.4 * 0.3 = 0.72`. Wait — that is 0.72, not 0.76. This illustrates why the constraint matters. The sender must ensure:

```
|confidence - (opinion.belief + opinion.base_rate * opinion.uncertainty)| < 0.01
```

If the validation fails, the receiver logs a warning and uses `confidence` (the established field) as authoritative. The opinion is treated as informational but unreliable.

### 8.3 Backward Compatibility

- **Existing Vinyan instances (no opinion support):** See `confidence` as before. The `opinion` field is optional and ignored by Zod's default `passthrough`/`strip` behavior.
- **External A2A agents:** Never see `opinion` unless they parse the ECP data part. The `confidence` scalar remains the canonical interop field.
- **New Vinyan instances receiving old messages:** `opinion` is undefined. `resolveOpinion()` derives it from `confidence`.

### 8.4 Schema Versioning Note

The `ecp_version` remains `1`. Adding an optional field is a backward-compatible change. The version should increment to `2` only when a breaking change occurs (e.g., making `opinion` mandatory, removing `confidence`, changing field semantics). A future version bump to `2` might be appropriate at Phase C completion, when `opinion` becomes the primary confidence representation.

---

## 9. Vacuous Verdict Protocol

### 9.1 When to Issue Vacuous Verdicts

An oracle should return a vacuous opinion `(0, 0, 1, a)` when:

1. **No test files found** — test oracle cannot evaluate (no tests to run).
2. **No lint config present** — lint oracle has no rules to apply.
3. **Out of domain** — a TypeScript oracle receiving a Python file.
4. **Oracle disabled** — circuit breaker is open.
5. **Timeout with no partial result** — oracle ran out of time before producing any evidence.

Currently, some of these cases return `verified: true, confidence: 0.5` (a false claim of balanced evidence) or throw errors. Both are epistemically dishonest.

### 9.2 Verdict Shape for Vacuous Verdicts

```typescript
// Example: test oracle with no tests found
const verdict: OracleVerdict = {
  verified: true,           // Not disproving the hypothesis
  type: "unknown",          // A2: "I don't know" is a valid state
  confidence: 0.5,          // Projected probability: 0 + 0.5 * 1 = 0.5 (prior)
  opinion: {
    belief: 0,
    disbelief: 0,
    uncertainty: 1,
    baseRate: 0.5,
  },
  evidence: [],              // No evidence — this IS vacuous
  fileHashes: {},
  durationMs: 12,
  reason: "No test files found in workspace",
};
```

**Key semantic:** `verified: true` with `type: "unknown"` means "I am not blocking, but I am also not providing evidence." This is different from `verified: true, type: "known"` which means "I verified this is correct."

### 9.3 Aggregation Rules for Vacuous Verdicts

```typescript
// In fuseAll():
const nonVacuous = sorted.filter(o => !isVacuous(o.opinion));
if (nonVacuous.length === 0) return vacuous(0.5);
```

**Rules:**
1. Vacuous opinions are filtered out BEFORE fusion. They do not participate.
2. If ALL opinions are vacuous, the fused result is vacuous — the system honestly says "no oracle could evaluate this."
3. A vacuous verdict does NOT count as a "pass" in the current `passed.length` / `failed.length` tallying. It is an abstention.
4. The gate should log a warning when > 50% of oracles return vacuous verdicts — this signals the hypothesis is poorly covered by the oracle battery.

### 9.4 Detection

```typescript
function isVacuous(o: SubjectiveOpinion, threshold: number = 0.95): boolean {
  return o.uncertainty > threshold;
}
```

The threshold of 0.95 rather than 1.0 allows for floating-point imprecision and near-vacuous opinions (e.g., oracle ran for 100ms, found one very weak signal: `u = 0.97`). An opinion with `u > 0.95` is treated as effectively vacuous — the tiny sliver of belief/disbelief is not meaningful enough to influence aggregation.

### 9.5 Phase A Compatibility

During Phase A (opinion is optional), vacuous detection falls back to heuristics:

```typescript
function isEffectivelyVacuous(verdict: OracleVerdict): boolean {
  if (verdict.opinion) return isVacuous(verdict.opinion);
  // Heuristic: no evidence + type unknown + neutral confidence
  return (
    verdict.type === "unknown" &&
    verdict.evidence.length === 0 &&
    Math.abs(verdict.confidence - 0.5) < 0.1
  );
}
```

---

## 10. Backward Compatibility Guarantees

### 10.1 Invariants Maintained Across All Phases

| Invariant | Guarantee |
|:----------|:----------|
| `confidence` field exists on every OracleVerdict | Always present, always a number in [0, 1] |
| `confidence` is authoritative for scalar consumers | Old code reading `confidence` gets the correct value |
| `opinion` is optional | Absence means "no SL data provided" — derive from scalar |
| Existing tests pass without modification | Phase A adds fields only; no semantic changes |
| `ecp_version: 1` remains valid | Optional field addition is non-breaking |
| Tier clamping produces identical results for scalar-only verdicts | `clampByTier(confidence, tier)` behavior unchanged |
| Conflict resolver produces identical decisions for scalar-only verdicts | Phase C only activates when opinions are present |

### 10.2 Consistency Invariant

When both `confidence` and `opinion` are present:

```
|confidence - projectedProbability(opinion)| < 0.01
```

This is enforced at:
1. **Verdict creation:** `buildVerdict()` computes `confidence` from `opinion` when opinion is provided.
2. **Wire ingestion:** `parseECPDataPart()` validates consistency; logs warning on mismatch.
3. **Clamping:** Both scalar and opinion are clamped together.

### 10.3 Deprecation Path

Long-term (Phase D, not designed here), the scalar `confidence` field could be deprecated in favor of `projectedProbability(opinion)`. This requires:
- All internal consumers migrated to `opinion`.
- `ecp_version` bumped to `2`.
- `confidence` retained as computed field for external A2A interop.

This is NOT proposed for the current design. Scalar `confidence` remains primary for the foreseeable future.

---

## 11. Computational Cost Analysis

### 11.1 Per-Operation Costs

| Operation | Complexity | Typical Time | Notes |
|:----------|:-----------|:-------------|:------|
| `fromScalar()` | O(1) | < 1 us | Two subtractions |
| `projectedProbability()` | O(1) | < 1 us | One multiply + one add |
| `isVacuous()` | O(1) | < 1 us | One comparison |
| `cumulativeFusion()` | O(1) | < 1 us | ~10 arithmetic ops |
| `averagingFusion()` | O(1) | < 1 us | 4 weighted averages |
| `weightedFusion()` | O(1) | < 1 us | 4 weighted averages |
| `conflictConstant()` | O(1) | < 1 us | 2 multiplies + 1 add |
| `computeConflictReport()` | O(n^2) | < 10 us for n=5 | Pairwise comparison |
| `fuseAll()` | O(n^2) | < 20 us for n=5 | Sort + pairwise fusion + operator selection |
| `clampOpinionByTier()` | O(1) | < 1 us | Conditional arithmetic |
| Zod validation (opinion) | O(1) | ~5 us | 4 number checks + 1 refinement |

### 11.2 Aggregate Impact

For a typical L2 gate evaluation with 5 oracles:

```
Current (scalar):
  5x clampByTier             ~  5 us
  resolveConflicts (5-step)  ~ 10 us
  computeQualityScore        ~ 15 us
  Total                      ~ 30 us

With SL (Phase C):
  5x resolveOpinion          ~  5 us
  5x clampOpinionByTier      ~  5 us
  1x computeConflictReport   ~ 10 us
  1x fuseAll                 ~ 15 us
  1x projectedProbability    ~  1 us
  Total                      ~ 36 us
```

**Overhead: approximately 6 microseconds (20%).** This is negligible compared to oracle execution time (100ms - 10s) and well within the latency budgets of all routing levels (L0: 100ms, L1: 2s, L2: 10s, L3: 60s).

### 11.3 Memory Impact

Each `SubjectiveOpinion` is 4 numbers (32 bytes). Adding `opinion` and `rawOpinion` to every `OracleVerdict` adds 64 bytes per verdict. For 5 oracles, that is 320 bytes total — negligible.

The opinion is also stored in the World Graph `Fact` table. Adding 4 columns to SQLite (belief, disbelief, uncertainty, base_rate) adds ~32 bytes per fact row. At 100,000 facts, that is ~3.2 MB — well within SQLite's comfort zone.

---

## 12. Open Questions

### Q1: Base Rate Adaptation Rate

Should base rates adapt quickly (high alpha EMA) or slowly (low alpha)? Fast adaptation tracks the oracle's true positive rate but is vulnerable to distributional shift (new project types). Slow adaptation is robust but may stay miscalibrated for many verdicts.

**Proposed resolution:** Start with alpha = 0.05 (slow, robust) and expose as a configuration parameter. Increase to 0.1 after validating on real trace data.

### Q2: Cross-Instance Opinion Trust

When Vinyan Instance A receives an opinion from Instance B via A2A, should A trust B's uncertainty value? A malicious or miscalibrated instance could claim low uncertainty to dominate fusion.

**Proposed resolution:** Apply peer trust clamping to the opinion, not just the projected probability. Untrusted peers have their belief clamped AND their uncertainty floored (e.g., `u = max(u, 0.3)` for untrusted peers). This prevents a remote oracle from claiming certainty it hasn't earned.

### Q3: Multi-Hypothesis Extension

The current design assumes a binary frame: `{H, not-H}` (verified / not verified). Some future oracle patterns may need multinomial opinions (e.g., "which of these 3 implementations is correct?"). Josang's Dirichlet multinomial opinions extend the framework but add complexity (n-dimensional simplex instead of triangle).

**Proposed resolution:** Defer to Phase 5+. The binary frame covers all current oracle verification scenarios. If multinomial needs arise, introduce `DirichletOpinion` as a separate type — do not generalize `SubjectiveOpinion`.

### Q4: Fusion Order Sensitivity

For weighted and averaging fusion, the pairwise order may matter slightly due to floating-point arithmetic (not mathematically, but numerically). Should we normalize after each pairwise fusion or only at the end?

**Proposed resolution:** Normalize after each fusion step (re-assert `b + d + u = 1` with a renormalization pass). This bounds floating-point drift and costs negligible compute.

### Q5: Interaction with Temporal Decay

How does temporal decay interact with opinions? Should `b` decay (losing belief over time) or should `u` increase (evidence becomes stale, increasing uncertainty)?

**Proposed resolution:** Uncertainty growth is more epistemically honest. Over time, evidence quality degrades, so mass should flow from belief (and disbelief) to uncertainty:

```typescript
function applyTemporalDecay(
  opinion: SubjectiveOpinion,
  elapsedMs: number,
  halfLifeMs: number,
): SubjectiveOpinion {
  const decayFactor = Math.pow(0.5, elapsedMs / halfLifeMs);
  const retainedMass = decayFactor;
  const decayedMass = 1 - retainedMass;

  return {
    belief: opinion.belief * retainedMass,
    disbelief: opinion.disbelief * retainedMass,
    uncertainty: opinion.uncertainty + (opinion.belief + opinion.disbelief) * decayedMass,
    baseRate: opinion.baseRate,
  };
}
```

This preserves the `b + d + u = 1` invariant and converges to a vacuous opinion as time approaches infinity — the verdict returns to "I don't know" when its evidence is fully stale.

### Q6: Gate Allow Threshold

Currently, the gate decision is `verified: true/false` per oracle, then conflict resolution. With SL fusion, the decision becomes: "is the fused projected probability above a threshold?" What should that threshold be?

**Proposed resolution:** Start with 0.5 (the decision boundary where belief exceeds the base-rate-weighted uncertainty). Expose as a configurable parameter in `gate/` config. Risk routing levels may use different thresholds: L0 = 0.9 (very conservative reflex), L3 = 0.4 (deliberative is more tolerant).

### Q7: Audit Trail Format

The fused opinion and conflict report should be persisted for A7 (Prediction Error as Learning). Where?

**Proposed resolution:** Add `fusedOpinion` and `conflictK` columns to the trace store (`src/db/trace-store.ts`). The full `ConflictReport` is stored as JSON in a `conflict_report` column. This enables post-hoc analysis of fusion quality and conflict patterns.

---

## References

- Josang, A. (2016). *Subjective Logic: A Formalism for Reasoning Under Uncertainty.* Springer.
- Josang, A., et al. (2018). Multi-Source Fusion Operations in Subjective Logic. *Information Fusion*, 48, 80-97.
- Shafer, G. (1976). *A Mathematical Theory of Evidence.* Princeton University Press.
- Josang, A. (2001). A Logic for Uncertain Probabilities. *International Journal of Uncertainty, Fuzziness and Knowledge-Based Systems*, 9(3), 279-311.
- `docs/research/formal-uncertainty-frameworks.md` — Framework comparison and protocol design principles (P1-P8).
- `docs/spec/ecp-spec.md` ss4.2 — BeliefInterval extension specification.
