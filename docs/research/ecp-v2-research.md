# ECP v2 Research Directions

> **Status:** Research — none committed. v1 is complete for local oracle coordination.
> **Becomes relevant when:** ECP Network Transport (PH5.18) is implemented.
> **Extracted from:** [protocol-architecture.md](../architecture/protocol-architecture.md) §9.
> **Related spec sections:** [ecp-spec.md](../spec/ecp-spec.md) §4.2 (Belief Intervals brief), §7.2 (Aggregation current impl), Appendix D.2 (Confidence Conflation finding).

---

## 1. Confidence Model Evolution: Scalar → Belief Intervals

**Current (ECP v1):** `confidence: number` — a single scalar in [0, 1].

**Problem:** Scalar confidence conflates two distinct epistemic states:
- "50% confident" (strong evidence for both true and false)
- "No information" (no evidence at all)

Both map to `confidence: 0.5`, but they should produce different Orchestrator behavior.

**Solution (ECP v2):** Dempster-Shafer belief/plausibility intervals.

```typescript
// v1: scalar (current — maintained for backward compatibility)
confidence: 0.5

// v2: belief interval (additive, optional extension)
belief_interval?: {
  belief: number;       // Bel(H) — minimum confidence supported by evidence
  plausibility: number; // Pl(H) — maximum confidence if all unknowns resolve favorably
}
// Uncertainty gap = plausibility - belief
// Gap = 0 → full evidence (deterministic oracle)
// Gap = 1 → no evidence at all
// Gap > 0 → partial evidence → trigger deliberation or escalation
```

**Migration:** `belief_interval` is optional. Engines that don't provide it: `belief = confidence, plausibility = confidence` (zero uncertainty gap — backward compatible). The scalar `confidence` field is ALWAYS present for v1 consumers.

**Orchestrator behavior with belief intervals:**

| Scenario | Belief | Plausibility | Gap | Action |
|:---------|-------:|-------------:|----:|:-------|
| Deterministic (compiler) | 1.0 | 1.0 | 0.0 | Accept immediately |
| Strong heuristic | 0.85 | 0.90 | 0.05 | Accept with high confidence |
| Partial evidence | 0.3 | 0.8 | 0.5 | Escalate — high uncertainty gap |
| No information | 0.0 | 1.0 | 1.0 | Route to different engine |
| Conflicting evidence | 0.4 | 0.6 | 0.2 | Contradiction resolution |

**Axiom alignment:** A2 (First-Class Uncertainty) — belief intervals make uncertainty *measurable*, not just categorical.

---

## 2. Multi-Oracle Aggregation: DS Combination

> The current 5-step heuristic in `conflict-resolver.ts` works well for Vinyan's oracle set. DS combination is one possible future improvement, not a committed design.

**Current (v1, implemented):** `src/gate/conflict-resolver.ts` uses a 5-step deterministic algorithm: (1) domain separation, (2) tier priority (A5), (3) evidence count, (4) historical accuracy, (5) escalation with `hasContradiction: true`. Simple, auditable, sufficient for 5 built-in oracles with clear tier separation.

**Possible v2 improvement:** When 3+ oracles with overlapping domains produce verdicts, Dempster's rule of combination could formally strengthen or weaken combined confidence:

```
// Dempster's rule for two independent mass functions m1, m2:
// Combined mass: m12(A) = Σ{B∩C=A} m1(B)·m2(C) / (1 - K)
// where K = Σ{B∩C=∅} m1(B)·m2(C) is the conflict factor
//
// For ECP: each oracle verdict maps to a mass function over
// the frame {verified, ¬verified, Θ} where Θ = uncertainty.
// The exact mass assignment from scalar confidence requires
// a mapping function — see Shafer (1976) for the rigorous formulation.
```

> **Note:** A naive product of scalar confidences is NOT equivalent to DS combination. The implementation must convert each oracle's `confidence` and `type` into a proper mass function first.

**Practical integration point:**

```typescript
interface DempsterCombination {
  combine(verdicts: OracleVerdict[]): {
    combined_confidence: number;
    conflict_factor: number;    // K — high K means oracles disagree
    contributing_engines: string[];
  };
}

// In src/gate/conflict-resolver.ts — DS runs AFTER tier-based filtering:
//   1. Group verdicts by tier (deterministic > heuristic > probabilistic)
//   2. Within each tier, apply Dempster's combination
//   3. Higher-tier combined result overrides lower-tier
//   4. If conflict_factor > 0.7 → flag as "contradictory"
```

**When NOT to use DS combination:**
- Verdicts from same underlying data source (not independent)
- One oracle explicitly subsumes another (e.g., type-check includes lint-clean)
- Oracle returns `type: "unknown"` (excluded — no evidence to combine)
- AST and type oracles both read the same file → not independent

**Open questions:**
- Does the current oracle set produce enough same-tier overlap to benefit?
- Is arbitrary scalar → mass function mapping more principled than the current heuristic?
- The 5-step algorithm is fully auditable; DS produces a single opaque number.

**Axiom alignment:** A3 (Deterministic Governance) — Dempster's rule is a deterministic mathematical function. A5 (Tiered Trust) — tier ranking still applies as pre-filter.

---

## 3. LLM Confidence Exclusion Policy

> This is a **hard policy** (A3 compliance), not a research direction. Included here for completeness but the policy itself is normative — see [ecp-spec.md](../spec/ecp-spec.md) §4.2.

**Research finding:** LLM self-reported confidence has poor calibration (Kadavath et al. 2022 "Language Models (Mostly) Know What They Know"; Xiong et al. 2024 "Can LLMs Express Their Uncertainty?") — high ECE means expressed confidence ≠ actual accuracy.

**Policy (non-negotiable, A3 compliance):**

```
RULE: LLM-generated confidence values MUST NOT enter the governance path.

1. Oracle wrapping an LLM → confidence = f(evidence_count, evidence_specificity, tool_confirmation)
   LLM self-report → logged for A7 calibration only, never used for routing
2. MCP tool with embedded confidence claims → ignored, apply trust-tier cap
3. Governance decisions → ONLY evidence-derived confidence + tier caps
4. SelfModel prediction confidence (EMA-based) → valid because calibrated against outcomes (A7)
```

**Implementation touchpoints:**

| File | Current Behavior | Required Change |
|:-----|:----------------|:---------------|
| `src/orchestrator/core-loop.ts` | LLM-as-critic verdict | Ensure confidence from evidence structure |
| `src/mcp/ecp-translation.ts` | Already caps at trust level | Add `llm_confidence_excluded: true` annotation |
| `src/gate/quality-score.ts` | Quality dimensions | Document evidence-derived, not LLM claims |

---

## 4. Merkle-Chained Evidence

**Current:** `evidence[]` is a flat array. No tamper-detection or chain integrity verification.

**Proposed (v2):** Certificate Transparency pattern — each evidence item hashes the previous:

```typescript
interface MerkleEvidence extends Evidence {
  prev_hash: string | null;  // SHA-256 of previous evidence item. Null for first.
  self_hash: string;         // SHA-256 of (file + line + snippet + contentHash + prev_hash)
}
```

**Use cases:** Cross-instance fact sharing integrity, audit trail, tamper detection.

**Deferred to v2** — local-only deployment doesn't need tamper-proofing. Critical when PH5.18 enables cross-instance communication.

> **Threat model note:** Merkle evidence addresses integrity, not correctness. A compromised instance can generate valid chains of wrong evidence. Formal threat model should precede this design.

---

## 5. Confidence Conflation Resolution (from Expert Review D.2)

**Finding:** `confidence: number` encodes two orthogonal dimensions:
- **Tier reliability** — deterministic oracle reports 1.0 (evidence class statement)
- **Engine certainty** — heuristic oracle reports 0.7 (uncertainty about this verdict)

**Proposed resolution:** Split into two fields in ECP 2.0:
```typescript
tier_reliability: number;   // Set by Orchestrator from registration. det=1.0, heur=0.7-0.9, prob=0.3-0.7
engine_certainty: number;   // Reported by engine. Its assessment of this specific verdict.
```

**Migration path:**
1. **ECP 1.x (current):** `confidence` remains single field, clamped by tier ceiling (§4.4 workaround)
2. **ECP 2.0:** Introduce both fields. If only `confidence` present → infer `tier_reliability` from registration, `engine_certainty` from value.
