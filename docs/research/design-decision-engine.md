# Epistemic Decision Engine: Confidence as First-Class Decision Driver

> **Status:** Design proposal (not yet implemented)
> **Author:** Design session 2026-04-01
> **Axioms:** A2 (First-Class Uncertainty), A3 (Deterministic Governance), A5 (Tiered Trust), A7 (Prediction Error as Learning)

---

## 1. Problem Statement

Vinyan computes rich epistemic metadata — per-oracle confidence scores, tier-clamped values, temporal decay, evidence chains — then **collapses all of it into a single boolean** at the gate decision boundary.

Three critical information-destroying bottlenecks:

1. **Gate decision** (`gate.ts:289`): `reasons.length > 0 ? "block" : "allow"` — a confidence=0.89 oracle failure is identical to a confidence=0.15 oracle failure.

2. **Oracle gate adapter** (`oracle-gate-adapter.ts:55-62`): Returns `passed: boolean`, stripping all per-oracle confidence data before it reaches the orchestrator.

3. **Core loop outcome** (`core-loop.ts:527`): `verification.passed ? "success" : "failure"` — the self-model learns from a binary outcome when a continuous signal was available.

**Consequence:** The system cannot distinguish "high-confidence failure" (genuine bug, strong evidence) from "low-confidence failure" (oracle flaky, insufficient evidence), and it cannot distinguish "borderline pass" from "emphatic pass". This forces conservative blocking behavior and prevents nuanced retry/escalation strategies.

---

## 2. Proposed GateDecision Type

### 2.1 New Decision Taxonomy

```typescript
/**
 * Epistemic gate decision — replaces binary allow/block.
 * A2: "uncertain" is a first-class state, not an error.
 * A3: Decision logic is fully rule-based — thresholds are constants.
 */
export type EpistemicGateDecision =
  | "allow"             // High confidence pass — proceed normally
  | "allow-with-caveats" // Pass but confidence below comfort — proceed, flag for monitoring
  | "uncertain"         // Mixed signals, low aggregate confidence — escalate verification
  | "block";            // Clear failure — reject

export interface EpistemicGateVerdict {
  decision: EpistemicGateDecision;
  /** Aggregate confidence across all oracle verdicts (0.0-1.0). */
  aggregateConfidence: number;
  /** Per-oracle confidence breakdown. */
  oracleConfidences: Record<string, {
    confidence: number;
    tier: string;
    verified: boolean;
    evidenceCount: number;
  }>;
  /** Reasons for blocking or caveats. */
  reasons: string[];
  /** Caveats when decision is "allow-with-caveats". */
  caveats: string[];
  oracle_results: Record<string, OracleVerdict>;
  durationMs: number;
  qualityScore?: QualityScore;
  riskScore?: number;
  /** When decision is "uncertain", this suggests what would resolve it. */
  resolutionHint?: UncertaintyResolutionHint;
}

export interface UncertaintyResolutionHint {
  /** Which oracles need re-running or deeper analysis. */
  oraclesNeeded: string[];
  /** Suggested minimum routing level to resolve. */
  suggestedLevel: RoutingLevel;
  /** Why the current evidence is insufficient. */
  reason: string;
}
```

### 2.2 Decision Logic (Pseudocode)

```typescript
function deriveEpistemicDecision(
  aggregateConfidence: number,
  oracleResults: Record<string, OracleVerdict>,
  conflictResolution: ResolvedGateResult,
  thresholds: ConfidenceThresholds,
): EpistemicGateDecision {
  // Rule 1: Guardrail failures (injection/bypass) are always hard blocks
  //         regardless of confidence. This preserves existing behavior.
  if (conflictResolution.reasons.some(r => r.includes("injection") || r.includes("Bypass"))) {
    return "block";
  }

  // Rule 2: Unresolved contradictions → uncertain (A2)
  if (conflictResolution.hasContradiction) {
    return "uncertain";
  }

  // Rule 3: Any deterministic oracle failure with confidence >= HIGH → hard block
  //         Deterministic oracles (AST, type checker) produce ground truth.
  //         High-confidence failure from them is definitive.
  const hasHighConfidenceDeterministicFailure = Object.entries(oracleResults).some(
    ([name, verdict]) =>
      !verdict.verified &&
      verdict.confidence >= thresholds.HIGH_CONFIDENCE &&
      getOracleTier(name) === "deterministic"
  );
  if (hasHighConfidenceDeterministicFailure) {
    return "block";
  }

  // Rule 4: All oracles pass
  const allPassed = Object.values(oracleResults).every(v => v.verified);
  if (allPassed) {
    if (aggregateConfidence >= thresholds.HIGH_CONFIDENCE) {
      return "allow";
    }
    // All pass but low aggregate confidence → something is off
    // (e.g., all oracles returned 0.3 confidence — technically pass but unreliable)
    if (aggregateConfidence >= thresholds.ADEQUATE_CONFIDENCE) {
      return "allow-with-caveats";
    }
    return "uncertain";
  }

  // Rule 5: Some oracles fail
  if (aggregateConfidence < thresholds.UNCERTAIN) {
    // Very low aggregate — we don't have enough information to decide
    return "uncertain";
  }

  // Rule 6: Failures exist but were overridden by conflict resolution
  const nonOverriddenFailures = conflictResolution.reasons.length;
  if (nonOverriddenFailures === 0) {
    // All failures were overridden by higher-tier passes
    if (aggregateConfidence >= thresholds.ADEQUATE_CONFIDENCE) {
      return "allow-with-caveats"; // Overridden failures are still a caveat
    }
    return "uncertain";
  }

  // Rule 7: Remaining failures — evaluate confidence of failing oracles
  const failingConfidences = Object.values(oracleResults)
    .filter(v => !v.verified)
    .map(v => v.confidence);
  const avgFailConfidence = failingConfidences.reduce((a, b) => a + b, 0) / failingConfidences.length;

  if (avgFailConfidence < thresholds.LOW_CONFIDENCE) {
    // Failures exist but the oracles themselves are not confident in their rejection
    return "uncertain";
  }

  return "block";
}
```

---

## 3. Confidence Threshold Table

| Threshold | Value | Effect | Justification |
|-----------|-------|--------|---------------|
| `HIGH_CONFIDENCE` | 0.85 | Fast-path allow; skip optional/informational oracles at L0-L1 | Tier clamp caps: deterministic=1.0, heuristic=0.9. A score of 0.85 means near-ceiling for heuristic oracles. Below this, even a "pass" may not be trustworthy. |
| `ADEQUATE_CONFIDENCE` | 0.60 | Normal verification path; full oracle suite; "allow-with-caveats" zone | Mid-range: above probabilistic cap (0.7) weighted down by mixed signals. Represents "more likely right than wrong" with reasonable evidence. |
| `LOW_CONFIDENCE` | 0.40 | Escalate routing level; request deeper verification | Matches speculative tier cap (0.4). Below this, confidence is no better than coin-flip territory. Failing oracles below this threshold may be unreliable. |
| `UNCERTAIN` | 0.25 | Flag for human review or maximum escalation | Below the untrusted peer trust cap (0.25). At this level the system is effectively saying "I have no idea." |

### 3.1 Interaction with L0-L3 Routing Levels

The routing level determines which oracles run. The confidence thresholds determine what happens with their results:

| Routing Level | Risk Score Range | Oracles Available | Confidence Role |
|---------------|-----------------|-------------------|-----------------|
| L0 Reflex | 0.0 - 0.2 | None (hash-only) | Implicit confidence = 1.0 for hash match, 0.0 for mismatch. Binary by design — L0 does not produce oracle verdicts. No change needed. |
| L1 Heuristic | 0.2 - 0.4 | AST, Type, Dep, Lint | Aggregate confidence drives allow/allow-with-caveats/uncertain. If uncertain at L1, escalate to L2. |
| L2 Analytical | 0.4 - 0.7 | All structural + Test | Full confidence aggregation. "allow-with-caveats" triggers critic review. "uncertain" escalates to L3. |
| L3 Deliberative | 0.7 - 1.0 | All + Shadow execution | "uncertain" at L3 → human escalation. No further automatic escalation exists. |

### 3.2 Threshold Configurability

```typescript
export interface ConfidenceThresholds {
  HIGH_CONFIDENCE: number;    // default 0.85
  ADEQUATE_CONFIDENCE: number; // default 0.60
  LOW_CONFIDENCE: number;     // default 0.40
  UNCERTAIN: number;          // default 0.25
}

const DEFAULT_THRESHOLDS: ConfidenceThresholds = {
  HIGH_CONFIDENCE: 0.85,
  ADEQUATE_CONFIDENCE: 0.60,
  LOW_CONFIDENCE: 0.40,
  UNCERTAIN: 0.25,
};
```

These should be loadable from `vinyan.config.ts` alongside existing oracle/routing configuration, but with hardcoded defaults for backward compatibility.

---

## 4. Aggregate Confidence Formula

### 4.1 Design Goals

The aggregate must:
1. Weight deterministic oracles higher than heuristic/probabilistic (A5)
2. Incorporate the actual confidence value, not just pass/fail
3. Penalize low evidence count (an oracle reporting 0.9 with 0 evidence items is suspicious)
4. Factor in historical accuracy when available
5. Be fully deterministic and reproducible (A3)

### 4.2 Formula

```typescript
/**
 * Compute aggregate confidence across all oracle verdicts.
 *
 * Formula: weighted harmonic mean of adjusted oracle confidences.
 *
 * Why harmonic mean instead of arithmetic mean?
 * - A single very-low-confidence oracle should pull the aggregate down hard.
 * - Arithmetic mean: [0.95, 0.95, 0.10] → 0.67 (still "adequate")
 * - Harmonic mean:   [0.95, 0.95, 0.10] → 0.25 (flagged as "uncertain")
 * - This matches the epistemic principle: a chain of reasoning is only
 *   as strong as its weakest link.
 *
 * A5 compliance: tier weights ensure deterministic oracles dominate.
 * A3 compliance: all constants are fixed — no learned parameters in formula.
 */
function computeAggregateConfidence(
  oracleResults: Record<string, OracleVerdict>,
  oracleTiers: Record<string, string>,
  oracleAccuracy?: Record<string, { total: number; correct: number }>,
): number {
  const entries = Object.entries(oracleResults);
  if (entries.length === 0) return 1.0; // No oracles → implicit full confidence

  let weightedRecipSum = 0;
  let totalWeight = 0;

  for (const [name, verdict] of entries) {
    const tier = oracleTiers[name] ?? "deterministic";

    // Component 1: Tier weight (A5)
    const tierWeight = TIER_WEIGHTS[tier] ?? 1.0;

    // Component 2: Evidence quality factor
    // 0 evidence → 0.3 multiplier (suspicious), 1 → 0.6, 3+ → 1.0
    const evidenceFactor = Math.min(1.0, 0.3 + (verdict.evidence.length * 0.233));

    // Component 3: Historical accuracy factor (when available)
    // No history → 1.0 (neutral). History with <10 samples → damped.
    let accuracyFactor = 1.0;
    if (oracleAccuracy) {
      const record = oracleAccuracy[name];
      if (record && record.total >= 10) {
        accuracyFactor = record.correct / record.total;
      } else if (record && record.total > 0) {
        // Damped: blend toward 0.5 for small samples (Wilson CI spirit)
        const rawAccuracy = record.correct / record.total;
        const damping = record.total / 10;
        accuracyFactor = damping * rawAccuracy + (1 - damping) * 0.5;
      }
    }

    // Combined weight for this oracle
    const weight = tierWeight * evidenceFactor * accuracyFactor;

    // Adjusted confidence: the oracle's reported confidence,
    // modulated by whether it passed or failed.
    //
    // For PASSING oracles: confidence represents "how sure am I this is correct"
    // For FAILING oracles: confidence represents "how sure am I this is wrong"
    //
    // To aggregate into a single "how confident are we in the overall correctness",
    // we use: pass → confidence, fail → (1 - confidence)
    const adjustedConfidence = verdict.verified
      ? verdict.confidence
      : (1 - verdict.confidence);

    // Clamp to avoid division-by-zero in harmonic mean (floor at 0.01)
    const clampedConfidence = Math.max(0.01, adjustedConfidence);

    weightedRecipSum += weight / clampedConfidence;
    totalWeight += weight;
  }

  if (totalWeight === 0) return 0.5; // defensive

  // Weighted harmonic mean
  const harmonicMean = totalWeight / weightedRecipSum;

  return Math.max(0, Math.min(1.0, harmonicMean));
}
```

### 4.3 Tier Weights (Reused from quality-score.ts)

```typescript
const TIER_WEIGHTS: Record<string, number> = {
  deterministic: 1.0,  // AST, Type — ground truth from tools
  heuristic: 0.7,      // Lint, Dep — well-known rules, edge cases exist
  probabilistic: 0.4,  // Test — non-determinism possible (flaky tests, timing)
  speculative: 0.2,    // LLM-as-critic, external reviews — opinions, not facts
};
```

### 4.4 Worked Example

Three oracles evaluate a file mutation:

| Oracle | Tier | Verified | Confidence | Evidence Count |
|--------|------|----------|------------|----------------|
| type | deterministic | true | 0.95 | 3 |
| lint | heuristic | false | 0.60 | 1 |
| test | probabilistic | true | 0.80 | 5 |

Calculations:
- **type**: tierWeight=1.0, evidenceFactor=min(1.0, 0.3+3*0.233)=1.0, weight=1.0. adjustedConf=0.95 (pass).
- **lint**: tierWeight=0.7, evidenceFactor=min(1.0, 0.3+1*0.233)=0.533, weight=0.373. adjustedConf=1-0.60=0.40 (fail).
- **test**: tierWeight=0.4, evidenceFactor=min(1.0, 0.3+5*0.233)=1.0, weight=0.4. adjustedConf=0.80 (pass).

weightedRecipSum = 1.0/0.95 + 0.373/0.40 + 0.4/0.80 = 1.053 + 0.933 + 0.500 = 2.486
totalWeight = 1.0 + 0.373 + 0.4 = 1.773
harmonicMean = 1.773 / 2.486 = **0.713**

Decision: aggregateConfidence=0.713 > ADEQUATE_CONFIDENCE(0.60) but lint failed and was not overridden → conflict resolution applies. If lint's failure is overridden by type (same domain, higher tier), decision = **"allow-with-caveats"**. If not overridden, decision = **"block"** (a non-overridden failure stands regardless of aggregate).

---

## 5. Orchestrator Integration Points (Per Step)

### 5.1 Step 2 to Step 3: Predict to Plan

**Current behavior:** `prediction.forceMinLevel` is the only signal from prediction to planning. Low metaConfidence is ignored.

**Proposed behavior:**

```typescript
// In core-loop.ts, after Step 2 (PREDICT)
if (prediction) {
  // NEW: Low metaConfidence → request finer-grained decomposition
  if (prediction.metaConfidence < 0.3) {
    // Inject decomposition hint: "break into smaller, independently verifiable steps"
    input = {
      ...input,
      constraints: [
        ...(input.constraints ?? []),
        "DECOMPOSE_FINE: metaConfidence below 0.3 — prefer smaller subtasks",
      ],
    };
  }

  // NEW: Many uncertain areas → expand perception for wider blast radius
  if (prediction.uncertainAreas.length >= 3) {
    // Request L2-level perception even at L1 routing
    const deeperPerception = await deps.perception.assemble(input, Math.max(routing.level, 2));
    perception = deeperPerception;
  }
}
```

**Justification:** When the self-model is unsure, the system should compensate with more granular planning (smaller subtasks are easier to verify) and broader perception (more context reduces blind spots).

### 5.2 Step 2 to Step 4: Predict to Generate

**Current behavior:** Worker receives perception and working memory. Prediction confidence is not surfaced to the worker.

**Proposed behavior:**

```typescript
// In WorkerInput (types.ts), add:
export interface WorkerInput {
  // ... existing fields ...
  /** Self-model prediction — worker can adjust strategy based on confidence. */
  predictionContext?: {
    confidence: number;
    metaConfidence: number;
    uncertainAreas: string[];
    expectedQualityScore: number;
  };
}
```

The worker's system prompt should include:

```
Self-Model Confidence: {confidence} (meta: {metaConfidence})
Uncertain areas: {uncertainAreas.join(', ')}

When confidence is below 0.5:
- Prefer conservative, minimal changes
- Add inline comments explaining non-obvious decisions
- Flag any assumptions explicitly
```

**Budget scaling:** Token budget should scale inversely with confidence for the generation step (more tokens = more room to reason carefully):

```typescript
const confidenceMultiplier = prediction
  ? Math.max(1.0, 1.5 - prediction.confidence) // Low confidence → up to 1.5x budget
  : 1.0;
const adjustedBudget = Math.min(
  routing.budgetTokens * confidenceMultiplier,
  routing.budgetTokens * 1.5, // Hard cap at 1.5x
);
```

### 5.3 Step 5 to Retry: Verify to Retry

**Current behavior:** `verification.passed === false` → retry. `verification.passed === true` → success. No middle ground.

**Proposed behavior:**

```typescript
// After Step 5 (VERIFY), replace the binary check:

// OLD:
// if (verification.passed) { ... success ... }

// NEW:
const epistemicDecision = verification.epistemicDecision; // from new gate

switch (epistemicDecision.decision) {
  case "allow":
    // High confidence success → commit and return
    break;

  case "allow-with-caveats":
    // Success but with warnings — proceed but record caveats
    if (routing.level < 2 && epistemicDecision.aggregateConfidence < 0.70) {
      // At L0-L1, low-confidence success triggers re-verification at L2
      // This is the KEY new behavior: a "pass" can still trigger escalation
      deps.bus?.emit("task:re-verify", {
        taskId: input.id,
        reason: "low-confidence-pass",
        aggregateConfidence: epistemicDecision.aggregateConfidence,
        caveats: epistemicDecision.caveats,
      });
      // Escalate to L2 for deeper verification but DON'T retry generation
      // — the mutations are probably fine, we just want more oracle confidence
      const deeperVerification = await verifyAtLevel(
        workerResult.mutations, routing.level + 1, deps
      );
      if (deeperVerification.decision === "block") {
        // Deeper verification found issues — treat as failure
        workingMemory.recordFailedApproach(trace.approach, deeperVerification.reasons.join("; "));
        continue; // retry
      }
      // Deeper verification confirmed — upgrade to full "allow"
    }
    // Commit with caveats logged
    break;

  case "uncertain":
    // Cannot decide — escalate routing level (not retry count)
    deps.bus?.emit("task:escalate", {
      taskId: input.id,
      fromLevel: routing.level,
      toLevel: routing.level + 1,
      reason: `uncertain: aggregateConfidence=${epistemicDecision.aggregateConfidence}`,
    });
    // Important: do NOT consume a retry. Uncertainty is not a failure.
    // Jump to next routing level with the same generation output.
    break;

  case "block":
    // High confidence failure — consume retry
    workingMemory.recordFailedApproach(trace.approach, epistemicDecision.reasons.join("; "));
    continue;
}
```

**Key insight:** "uncertain" does not consume a retry. The generation may be fine — we just can't tell with the current oracle set. Escalating to a higher routing level brings in more/deeper oracles without wasting a regeneration cycle.

### 5.4 Step 5 to Step 6: Verify to Learn

**Current behavior:** `outcome: verification.passed ? "success" : "failure"` — binary.

**Proposed behavior:**

```typescript
// ExecutionTrace gets a richer outcome model:
export interface ExecutionTrace {
  // ... existing fields ...

  /** NEW: Continuous confidence signal for self-model calibration. */
  verificationConfidence: number; // 0.0-1.0 aggregate confidence

  /** NEW: Epistemic decision for trace analysis. */
  epistemicDecision: EpistemicGateDecision;

  /** Outcome remains for backward compat but is derived from epistemic decision. */
  outcome: "success" | "failure" | "timeout" | "escalated";
}

// Pipeline confidence for self-model calibration:
// min(prediction.metaConfidence, verification.aggregateConfidence)
//
// This ensures the learning signal reflects BOTH:
// - How confident the self-model was in its prediction
// - How confident the oracles were in their verification
//
// If either is low, the composite is low → the self-model learns to be cautious.
const pipelineConfidence = prediction
  ? Math.min(prediction.metaConfidence, verification.aggregateConfidence)
  : verification.aggregateConfidence;
```

This gives the self-model a gradient signal instead of a step function. A task that passes with 0.61 confidence teaches differently than one that passes with 0.95.

---

## 6. Retry/Escalation Policy Changes

### 6.1 Current Policy

```
Retry exhausted at L(n) → escalate to L(n+1) → retry at L(n+1)
L3 exhausted → escalate to human
```

### 6.2 Proposed Policy

```
                    +-----------+
                    |  Verify   |
                    +-----+-----+
                          |
              +-----------+-----------+-------------+
              |           |           |             |
           "allow"  "allow-with-  "uncertain"   "block"
              |      caveats"       |             |
              |           |         |             |
           COMMIT    COMMIT +    ESCALATE     RETRY at
                     LOG CAVEATS  (no retry    current
                     + optional    consumed)    level
                     re-verify                   |
                     at L+1                      |
                                            retries
                                           exhausted?
                                              |
                                         ESCALATE to
                                           L(n+1)
```

### 6.3 Key Policy Changes

| Policy | Current | Proposed | Rationale |
|--------|---------|----------|-----------|
| Uncertain verdict | N/A (does not exist) | Escalate routing level, DO NOT consume retry | Uncertainty is not failure — the same code may pass with deeper oracles |
| Low-confidence pass | Treated as success | "allow-with-caveats" → optional re-verify at L+1 | Prevents false confidence. A borderline pass should be double-checked at critical levels. |
| High-confidence failure | Same as low-confidence failure | "block" → consume retry, record approach as failed | No change — a confident failure is a real failure. |
| Low-confidence failure | Same as high-confidence failure | "uncertain" → escalate without consuming retry | A flaky oracle failing with 0.2 confidence should not count against the generation. |
| Re-verification | Does not exist | New: re-run oracles at higher level without regenerating | Saves LLM tokens — if the code is probably fine, just verify deeper instead of regenerating. |

### 6.4 Retry Budget Accounting

```typescript
// Current: retries are a flat count
for (let retry = 0; retry < input.budget.maxRetries; retry++) { ... }

// Proposed: split into generation retries and verification escalations
interface RetryBudget {
  generationRetries: number;  // Consumed by "block" decisions
  verificationEscalations: number; // Consumed by "uncertain" decisions (cheaper)
  maxGenerationRetries: number; // From input.budget.maxRetries
  maxVerificationEscalations: number; // 2x generation retries (verification is cheap)
}
```

This reflects reality: a verification escalation (re-running oracles at a higher level) costs ~2 seconds and zero LLM tokens, while a generation retry costs thousands of tokens and 10-30 seconds.

---

## 7. Backward Compatibility

### 7.1 Missing Confidence (Legacy/External Oracles)

When an oracle returns `confidence: 0` or omits confidence:

```typescript
function normalizeOracleConfidence(verdict: OracleVerdict): number {
  // Oracles that crash or timeout already set confidence=0 with errorCode
  if (verdict.errorCode) return 0;

  // A2 compliance flag: oracle explicitly reported confidence?
  if (verdict.confidenceReported === false || verdict.confidence === 0) {
    // Assume tier-based default: deterministic → 0.95, heuristic → 0.70, etc.
    // This is generous but reflects the oracle's tier ceiling
    return DEFAULT_CONFIDENCE_BY_TIER[getOracleTier(verdict.oracleName ?? "")] ?? 0.5;
  }

  return verdict.confidence;
}

const DEFAULT_CONFIDENCE_BY_TIER: Record<string, number> = {
  deterministic: 0.95,
  heuristic: 0.70,
  probabilistic: 0.50,
  speculative: 0.30,
};
```

### 7.2 L0 Reflex (< 100ms, No Oracles)

L0 does not run any oracles. The current behavior is correct:
- Hash match → allow (implicit confidence = 1.0)
- Hash mismatch → escalate to L1

No change needed. L0 never produces an `EpistemicGateVerdict` — it uses the existing fast path. The `EpistemicGateVerdict` type is only produced when oracles actually run (L1+).

### 7.3 GateDecision Backward Compatibility

The existing `GateDecision = "allow" | "block"` type is used throughout the codebase. To avoid breaking changes:

```typescript
// Backward-compat mapping
function toClassicDecision(epistemic: EpistemicGateDecision): GateDecision {
  switch (epistemic) {
    case "allow":
    case "allow-with-caveats":
      return "allow";
    case "uncertain":
    case "block":
      return "block";
  }
}
```

The `GateVerdict` type keeps its existing fields and adds the new epistemic fields alongside. Consumers that only read `decision` continue to work. Consumers that want richer signals read `epistemicDecision` and `aggregateConfidence`.

```typescript
export interface GateVerdict {
  // Existing (backward compat)
  decision: GateDecision; // "allow" | "block" — derived from epistemicDecision
  reasons: string[];
  oracle_results: Record<string, OracleVerdict>;
  durationMs: number;
  qualityScore?: QualityScore;
  riskScore?: number;

  // New epistemic fields (optional — absent for L0/read-only fast paths)
  epistemicDecision?: EpistemicGateDecision;
  aggregateConfidence?: number;
  caveats?: string[];
  resolutionHint?: UncertaintyResolutionHint;
}
```

### 7.4 VerificationResult Backward Compatibility

The `OracleGateAdapter` returns `{ passed: boolean, verdicts, reason }`. Extend, don't replace:

```typescript
interface VerificationResult {
  passed: boolean; // Backward compat: derived from epistemicDecision
  verdicts: Record<string, OracleVerdict>;
  reason?: string;
  // New epistemic fields
  epistemicDecision?: EpistemicGateDecision;
  aggregateConfidence?: number;
  caveats?: string[];
}
```

### 7.5 A3 Compliance Check

Every decision path in the proposed system is a threshold comparison, weighted sum, or table lookup. No LLM is consulted for routing, retry, or escalation decisions. The thresholds are compile-time constants with config overrides. The aggregate formula uses fixed weights derived from the existing `TIER_WEIGHTS`. This satisfies A3 (Deterministic Governance).

---

## 8. Example Scenarios

### 8.1 Scenario: Type Error Fix — Clean Pass

**Task:** Fix type error in `src/auth/login.ts`
**Routing:** L1 (risk score = 0.25)
**Oracles:** type, lint

| Oracle | Tier | Verified | Confidence | Evidence |
|--------|------|----------|------------|----------|
| type | deterministic | true | 1.0 | 3 items |
| lint | heuristic | true | 0.85 | 1 item |

**Aggregate:** Harmonic mean with tier weights.
- type: weight=1.0*1.0=1.0, adjConf=1.0
- lint: weight=0.7*0.533=0.373, adjConf=0.85
- WHM = (1.0+0.373) / (1.0/1.0 + 0.373/0.85) = 1.373 / (1.0 + 0.439) = 1.373/1.439 = **0.954**

**Decision:** aggregateConfidence=0.954 >= HIGH_CONFIDENCE(0.85), all passed → **"allow"**
**Orchestrator:** Commit immediately. Normal learning trace.

### 8.2 Scenario: Refactoring with Flaky Test Oracle

**Task:** Extract method in `src/core/bus.ts`
**Routing:** L2 (risk score = 0.55)
**Oracles:** type, lint, test, dep

| Oracle | Tier | Verified | Confidence | Evidence |
|--------|------|----------|------------|----------|
| type | deterministic | true | 0.98 | 5 items |
| lint | heuristic | true | 0.90 | 2 items |
| test | probabilistic | false | 0.30 | 1 item |
| dep | heuristic | true | 0.75 | 4 items |

**Aggregate:**
- type: weight=1.0*1.0=1.0, adjConf=0.98
- lint: weight=0.7*0.766=0.536, adjConf=0.90
- test: weight=0.4*0.533=0.213, adjConf=1-0.30=0.70 (fail → inverted)
- dep: weight=0.7*1.0=0.7, adjConf=0.75

WHM = (1.0+0.536+0.213+0.7) / (1.0/0.98 + 0.536/0.90 + 0.213/0.70 + 0.7/0.75)
    = 2.449 / (1.020 + 0.596 + 0.304 + 0.933) = 2.449 / 2.853 = **0.858**

Test oracle fails but with low confidence (0.30). Conflict resolution: test is "functional" domain, type/lint are "structural" — cross-domain per Step 1. Test failure stands independently.

However, test failure confidence (0.30) < LOW_CONFIDENCE (0.40) → the failing oracle itself is not confident in its rejection.

**Decision:** Non-overridden failure exists BUT avg failing confidence (0.30) < LOW_CONFIDENCE → **"uncertain"**

**Orchestrator:** Does NOT consume a retry. Escalates to L3 for shadow execution + deeper test run. If L3 tests pass, upgrades to "allow". If L3 tests fail with high confidence, "block".

**Value added:** Under the current system, this would be a hard "block" triggering a full retry (regenerate + re-verify). The new system recognizes that the test oracle's low confidence means it might be a flaky test, and escalates verification instead of regeneration.

### 8.3 Scenario: Dangerous Mutation — Confident Failures

**Task:** Modify database schema migration
**Routing:** L3 (risk score = 0.85)
**Oracles:** type, lint, test, dep

| Oracle | Tier | Verified | Confidence | Evidence |
|--------|------|----------|------------|----------|
| type | deterministic | false | 0.95 | 4 items |
| lint | heuristic | false | 0.80 | 3 items |
| test | probabilistic | false | 0.85 | 8 items |
| dep | heuristic | true | 0.70 | 6 items |

Type oracle (deterministic tier) fails with confidence >= HIGH_CONFIDENCE(0.85) → Rule 3 triggers immediately.

**Decision:** **"block"** (high-confidence deterministic failure is definitive)

**Orchestrator:** Consumes retry. Records all three failing oracles' evidence in working memory. Next attempt gets the full failure context.

### 8.4 Scenario: New File — No History, Sparse Oracles

**Task:** Create new utility module `src/utils/retry.ts`
**Routing:** L1 (risk score = 0.15 → but blast radius > 1 file → forced L1)
**Oracles:** type, lint (AST skipped — requiresContext, test skipped — no existing tests)

| Oracle | Tier | Verified | Confidence | Evidence |
|--------|------|----------|------------|----------|
| type | deterministic | true | 0.95 | 1 item |
| lint | heuristic | true | 0.60 | 0 items |

**Aggregate:**
- type: weight=1.0*0.533=0.533, adjConf=0.95 (1 evidence item)
- lint: weight=0.7*0.3=0.21, adjConf=0.60 (0 evidence → 0.3 factor, suspicious)

WHM = (0.533+0.21) / (0.533/0.95 + 0.21/0.60) = 0.743 / (0.561 + 0.350) = 0.743/0.911 = **0.815**

All passed. aggregateConfidence=0.815 > ADEQUATE_CONFIDENCE(0.60) but < HIGH_CONFIDENCE(0.85).

**Decision:** **"allow-with-caveats"**

Caveats: "lint oracle passed with 0 evidence items (suspicious); only 2 of 5 oracles ran"

**Orchestrator:** Commits but logs caveats. Self-model records the low-confidence pass. If this is at L1 and confidence < 0.70, triggers optional re-verification at L2 (runs test oracle which was unavailable at L1).

---

## 9. Open Questions

### Q1: Harmonic vs. Geometric vs. Arithmetic Mean

The design proposes weighted harmonic mean to penalize low-confidence outliers. This may be too aggressive — a single oracle returning 0.1 will tank the aggregate to ~0.2 even if all others are 0.95. Should we use:
- **Geometric mean:** Less extreme than harmonic, still penalizes outliers
- **Trimmed harmonic mean:** Drop the lowest-confidence oracle before computing
- **Configurable per routing level:** Harmonic at L3 (conservative), arithmetic at L1 (permissive)

**Recommendation:** Start with harmonic mean at all levels. If empirical data shows too many false "uncertain" verdicts at L1-L2, switch to geometric for L1 and keep harmonic for L2-L3.

### Q2: Re-Verification Without Regeneration

The design proposes that "uncertain" triggers re-verification at a higher level without consuming a retry. This requires a new code path: re-run oracles at L(n+1) tier on the SAME mutations. The current architecture runs verification as part of the generate-verify loop. Decoupling "run more oracles" from "regenerate code" requires refactoring the inner loop.

**Recommended approach:** Extract a `verifyAtLevel(mutations, level, deps)` function that can be called independently of the worker dispatch.

### Q3: Dynamic Threshold Adjustment

Should confidence thresholds be static forever, or should they adapt based on historical data (e.g., if 90% of "allow-with-caveats" decisions turn out fine, relax the HIGH_CONFIDENCE threshold)? This would violate A3 (deterministic governance) unless the adaptation itself is rule-based (e.g., "after 1000 traces, if allow-with-caveats false positive rate < 5%, lower HIGH_CONFIDENCE by 0.05").

**Recommendation:** Keep thresholds static for Phase 1. Track false positive/negative rates per decision category. Phase 3 Evolution Engine can propose threshold adjustments as `EvolutionaryRule` with `action: "adjust-threshold"`, subject to backtesting before promotion.

### Q4: Confidence in Quality Score

Currently `computeQualityScore` uses `verdict.verified` (boolean) for `architecturalCompliance`. Should it use the confidence value instead? e.g., `weightedSum += verdict.confidence * weight` instead of `(verdict.verified ? 1 : 0) * weight`.

**Recommendation:** Yes — this is a natural extension. `architecturalCompliance` should become a confidence-weighted score, not a boolean-weighted score. This gives a gradient signal to the self-model even when all oracles pass (a 0.6-confidence pass scores lower than a 0.95-confidence pass).

### Q5: Conflict Resolver Integration

The current 5-step conflict resolver operates on pass/fail + tier. The new aggregate confidence formula also considers tier and evidence count. Should the conflict resolver be merged into the aggregate formula, or remain a separate pre-processing step?

**Recommendation:** Keep them separate. The conflict resolver handles _contradictions_ (oracle A says pass, oracle B says fail). The aggregate formula computes overall system confidence. Conflict resolution runs first to determine which verdicts stand, then the aggregate formula runs on the surviving verdicts. This separation of concerns maps cleanly to the existing architecture.

### Q6: EventBus Events for Epistemic Decisions

New events needed:
```typescript
// New event types
"gate:epistemic_decision": {
  taskId: string;
  decision: EpistemicGateDecision;
  aggregateConfidence: number;
  caveats: string[];
}
"task:re-verify": {
  taskId: string;
  reason: string;
  aggregateConfidence: number;
  targetLevel: RoutingLevel;
}
"confidence:threshold_crossed": {
  taskId: string;
  threshold: string; // "HIGH_CONFIDENCE" | "ADEQUATE_CONFIDENCE" etc.
  value: number;
  direction: "above" | "below";
}
```

These events enable the audit trail, CLI progress display, and Sleep Cycle to observe confidence-driven decisions without coupling to the gate or orchestrator internals.
