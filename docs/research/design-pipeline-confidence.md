# Pipeline Uncertainty Propagation Design

**Status:** Design proposal — no code changes
**Date:** 2026-04-01
**Axioms:** A2 (first-class uncertainty), A3 (deterministic governance), A5 (tiered trust), A7 (prediction error as learning)

---

## 1. Problem Statement

The orchestrator's 6-step loop (Perceive → Predict → Plan → Generate → Verify → Learn) treats uncertainty as a local property of individual steps. No mechanism exists to propagate, compound, or act on accumulated uncertainty across the pipeline.

**Specific gaps:**

| Step | What Happens Now | What Should Happen |
|------|-----------------|-------------------|
| 2 → 3 | `prediction.uncertainAreas` discarded; `decompose()` never sees prediction | Decomposer adapts DAG granularity based on prediction confidence |
| 2 → 4 | `workingMemory.unresolvedUncertainties` always empty | Worker receives uncertainty signals from self-model |
| 4 → 5 | Worker uncertainties ignored by verifier | Oracle allocation weighted by mutation confidence |
| 5 → decision | Binary `passed: boolean` | Confidence-weighted allow/re-verify/escalate |
| 5 → 6 | Trace stores prediction + predictionError but not pipeline-level confidence | Full pipeline confidence persisted for calibration |
| retry | Only triggers on `passed === false` | Also triggers on low-confidence success |

**Quantitative consequence:** A chain of 6 steps each at 80% confidence implies ~26% pipeline confidence (0.8^6). The system currently reports this as binary "pass" — a 3x overstatement of certainty.

---

## 2. PipelineConfidence Type Definition

```typescript
/**
 * Tracks compound uncertainty across the orchestrator's 6-step pipeline.
 * Each field is a confidence score in [0.0, 1.0].
 *
 * Axiom compliance:
 *   A2 — uncertainty is a first-class value, not an error
 *   A3 — composite formula is deterministic and auditable
 *   A5 — oracle tier weights feed into verification confidence
 */
interface PipelineConfidence {
  /** Step 2: Self-model prediction confidence (0.5 default if unavailable). */
  prediction: number;

  /** Step 2: Meta-confidence — confidence in the prediction itself. */
  metaPrediction: number;

  /** Step 3: Decomposition quality signal.
   *  1.0 = validated DAG passed all 5 criteria.
   *  0.5 = fallback single-node DAG.
   *  Penalized by 0.1 per unresolved dependency. */
  planning: number;

  /** Step 4: Worker output quality signals.
   *  Derived from: worker-reported uncertainties, mutation count vs expectation,
   *  tokens consumed vs budget (efficiency proxy). */
  generation: number;

  /** Step 5: Tier-weighted aggregate of oracle confidence values.
   *  Uses A5 tier weights: deterministic=1.0, heuristic=0.7, probabilistic=0.4. */
  verification: number;

  /** Step 5b: Critic confidence (L2+ only, 1.0 if critic absent). */
  critic: number;

  /** Final compound score — computed deterministically from the above. */
  composite: number;

  /** Human-readable formula showing how composite was derived (A3 auditability). */
  formula: string;

  /** Which steps had data vs used defaults. */
  dataAvailability: {
    predictionAvailable: boolean;  // false at L0-L1 or < 2 routing level
    planningAvailable: boolean;    // false at L0-L1
    criticAvailable: boolean;      // false when criticEngine absent
  };
}
```

### Companion types

```typescript
/** Per-step confidence contribution — for trace analysis and debugging. */
interface StepConfidence {
  step: 'prediction' | 'metaPrediction' | 'planning' | 'generation' | 'verification' | 'critic';
  value: number;
  weight: number;
  source: string;  // e.g., "self-model.predict()", "dag-validator", "oracle:type:src/foo.ts"
}

/** Decision outcome based on pipeline confidence. */
type ConfidenceDecision =
  | { action: 'allow'; confidence: number }
  | { action: 're-verify'; confidence: number; additionalOracles: string[] }
  | { action: 'retry'; confidence: number; reason: string }
  | { action: 'escalate'; confidence: number; fromLevel: RoutingLevel; toLevel: RoutingLevel }
  | { action: 'refuse'; confidence: number; reason: string };
```

---

## 3. Composite Formula

### Chosen approach: Weighted geometric mean with floor

**Why not multiplicative (Π)?** Assumes step independence — but prediction confidence directly affects planning quality. Pure multiplication is too pessimistic: 6 steps at 0.8 yields 0.26, which is unhelpfully low for a "everything basically worked" scenario.

**Why not minimum?** Useful as a quick check but discards information. A pipeline with [0.9, 0.9, 0.9, 0.4, 0.9, 0.9] is very different from [0.4, 0.4, 0.4, 0.4, 0.4, 0.4] — minimum conflates them.

**Why not Bayesian?** Requires conditional dependency modeling between steps. We don't have enough trace data to estimate P(verification_confidence | planning_confidence) reliably. This is a Phase 5+ concern.

**Why weighted geometric mean?** Captures the compounding nature of uncertainty (geometric) while allowing steps to have different importance weights (weighted). The geometric mean of values near 1.0 stays near 1.0, and a single low value pulls it down proportionally — matching intuition.

### Formula

```
composite = Π(step_i ^ w_i)

where:
  step_i = confidence of step i (clamped to [0.01, 1.0] to avoid zero-product)
  w_i = normalized weight of step i (Σw_i = 1.0)
```

### Weight table

| Step | Weight | Rationale |
|------|--------|-----------|
| prediction | 0.10 | Informs downstream but doesn't block; often cold-start |
| metaPrediction | 0.05 | Second-order signal — low weight, high diagnostic value |
| planning | 0.15 | DAG quality affects coverage but fallback is safe |
| generation | 0.15 | Worker output quality matters but oracles catch errors |
| verification | 0.40 | **Primary truth signal** — oracle verdicts are the hard evidence (A5) |
| critic | 0.15 | Semantic check catches what structural oracles miss |

### Pseudocode

```typescript
const STEP_WEIGHTS = {
  prediction: 0.10,
  metaPrediction: 0.05,
  planning: 0.15,
  generation: 0.15,
  verification: 0.40,
  critic: 0.15,
} as const;

function computePipelineConfidence(steps: {
  prediction: number;
  metaPrediction: number;
  planning: number;
  generation: number;
  verification: number;
  critic: number;
}): PipelineConfidence {
  const FLOOR = 0.01; // prevent log(0)
  const entries = Object.entries(STEP_WEIGHTS) as Array<[keyof typeof STEP_WEIGHTS, number]>;

  // Weighted geometric mean: exp(Σ(w_i * ln(c_i)))
  let weightedLogSum = 0;
  for (const [step, weight] of entries) {
    const clamped = Math.max(FLOOR, Math.min(1.0, steps[step]));
    weightedLogSum += weight * Math.log(clamped);
  }
  const composite = Math.exp(weightedLogSum);

  // Build auditable formula string
  const parts = entries.map(([step, weight]) =>
    `${step}(${steps[step].toFixed(3)})^${weight}`
  );
  const formula = `geom_mean(${parts.join(' * ')}) = ${composite.toFixed(4)}`;

  return {
    prediction: steps.prediction,
    metaPrediction: steps.metaPrediction,
    planning: steps.planning,
    generation: steps.generation,
    verification: steps.verification,
    critic: steps.critic,
    composite,
    formula,
    dataAvailability: {
      predictionAvailable: steps.prediction !== 0.5,
      planningAvailable: steps.planning !== 1.0,
      criticAvailable: steps.critic !== 1.0,
    },
  };
}
```

### Reference values

| Scenario | pred | meta | plan | gen | verify | critic | composite |
|----------|------|------|------|-----|--------|--------|-----------|
| All perfect | 1.0 | 1.0 | 1.0 | 1.0 | 1.0 | 1.0 | 1.000 |
| Normal operation | 0.8 | 0.6 | 0.9 | 0.85 | 0.95 | 0.9 | 0.883 |
| Cold start | 0.5 | 0.29 | 0.5 | 0.7 | 0.9 | 1.0 | 0.715 |
| Low-confidence success | 0.5 | 0.3 | 0.9 | 0.6 | 0.55 | 0.7 | 0.593 |
| Near-failure | 0.3 | 0.1 | 0.5 | 0.4 | 0.4 | 0.5 | 0.381 |

---

## 4. Step-by-Step Data Flow

### Step 1 → 2: Perceive → Predict (no change needed)

Perception already provides the signals that prediction consumes (diagnostics, blast radius, dep cone). The existing interface is sufficient.

### Step 2 → 3: Predict → Plan

**Current interface:**
```typescript
// task-decomposer.ts
decompose(input: TaskInput, perception: PerceptualHierarchy, memory: WorkingMemoryState): Promise<TaskDAG>
```

**Proposed interface:**
```typescript
decompose(
  input: TaskInput,
  perception: PerceptualHierarchy,
  memory: WorkingMemoryState,
  prediction?: SelfModelPrediction,  // NEW: optional for backward compatibility
): Promise<TaskDAG>
```

**Behavioral changes in TaskDecomposerImpl:**

```typescript
// In buildPrompt(), when prediction is available:
if (prediction) {
  userPrompt += `\n\n[PREDICTION CONTEXT]`;
  userPrompt += `\nSelf-model confidence: ${prediction.confidence.toFixed(2)}`;
  userPrompt += `\nMeta-confidence: ${prediction.metaConfidence.toFixed(2)}`;
  userPrompt += `\nBasis: ${prediction.basis}`;

  if (prediction.uncertainAreas.length > 0) {
    userPrompt += `\nUncertain areas: ${prediction.uncertainAreas.join(', ')}`;
  }

  // Cold start guidance
  if (prediction.metaConfidence < 0.3) {
    userPrompt += `\n\n⚠️ LOW META-CONFIDENCE (cold start): Prefer sequential node execution over parallel. Include explicit rollback checkpoints. Add extra verification nodes.`;
  }

  // Low confidence guidance
  if (prediction.confidence < 0.5) {
    userPrompt += `\n\n⚠️ LOW CONFIDENCE: Decompose into smaller, more granular subtasks. Each node should be independently verifiable.`;
  }
}
```

**Planning confidence derivation:**

```typescript
function derivePlanningConfidence(dag: TaskDAG, prediction?: SelfModelPrediction): number {
  let confidence = 1.0;

  // Fallback DAG = 0.5 base confidence
  if (dag.isFallback) {
    confidence = 0.5;
  }

  // Penalty for unresolved dependencies (nodes with deps on missing IDs)
  const nodeIds = new Set(dag.nodes.map(n => n.id));
  const brokenDeps = dag.nodes.reduce((count, node) =>
    count + node.dependencies.filter(d => !nodeIds.has(d)).length, 0);
  confidence -= brokenDeps * 0.1;

  // Nodes without assigned oracles are less verifiable
  const unverifiableNodes = dag.nodes.filter(n => n.assignedOracles.length === 0);
  confidence -= unverifiableNodes.length * 0.05;

  // Cold start penalty: decomposer LLM hasn't been calibrated on this task type
  if (prediction && prediction.metaConfidence < 0.3) {
    confidence *= 0.8;
  }

  return Math.max(0.1, Math.min(1.0, confidence));
}
```

### Step 2 → 4: Predict → Generate (via Working Memory)

**Current gap:** `addUncertainty()` exists in WorkingMemory but is never called in core-loop.ts.

**Proposed injection point — in core-loop.ts between Step 2 and Step 3:**

```typescript
// ── Step 2½: Propagate prediction uncertainty to working memory ──
if (prediction) {
  for (const area of prediction.uncertainAreas) {
    workingMemory.addUncertainty(
      area,
      prediction.confidence,
      deriveSuggestedAction(area, prediction),
    );
  }

  // Add a hypothesis about expected outcome
  workingMemory.addHypothesis(
    `Self-model expects ${prediction.expectedTestResults} outcome (confidence: ${prediction.confidence.toFixed(2)}, basis: ${prediction.basis})`,
    prediction.metaConfidence,
    'self-model',
  );
}
```

**Helper function:**

```typescript
function deriveSuggestedAction(
  area: string,
  prediction: SelfModelPrediction,
): string {
  switch (area) {
    case 'type-errors-present':
      return 'Address type errors before functional changes';
    case 'high-blast-radius':
      return 'Verify all transitive importers after changes';
    case 'low-task-type-observations':
      return 'Use conservative approach — prefer minimal changes';
    default:
      return prediction.confidence < 0.5
        ? 'Proceed with caution — self-model has low confidence'
        : 'Note uncertainty but proceed normally';
  }
}
```

**Prompt assembler change** — in `prompt-assembler.ts`, add confidence header:

```typescript
// After [TASK] section, before [PERCEPTION]:
if (memory.unresolvedUncertainties.length > 0) {
  const maxConfidence = Math.max(
    ...memory.unresolvedUncertainties.map(u => u.selfModelConfidence),
  );
  sections.push(`[CONFIDENCE: ${maxConfidence.toFixed(2)}]
The system's self-model has ${maxConfidence < 0.5 ? 'LOW' : 'MODERATE'} confidence in this task type.
Explicitly flag any parts of your output where you are uncertain.`);
}
```

### Step 4 → 5: Generate → Verify

**Generation confidence derivation:**

```typescript
function deriveGenerationConfidence(
  workerResult: WorkerResult,
  input: TaskInput,
  prediction?: SelfModelPrediction,
): number {
  let confidence = 0.8; // base: worker produced output

  // Worker-reported uncertainties penalize confidence
  const uncertaintyCount = workerResult.uncertainties?.length ?? 0;
  confidence -= uncertaintyCount * 0.1;

  // Zero mutations when mutations were expected
  if (workerResult.mutations.length === 0 && (input.targetFiles?.length ?? 0) > 0) {
    confidence = 0.3;
  }

  // Token efficiency: consuming near-budget suggests struggling
  const tokenRatio = workerResult.tokensConsumed / input.budget.maxTokens;
  if (tokenRatio > 0.9) {
    confidence -= 0.15;
  }

  // Duration efficiency: near-timeout suggests struggling
  const durationRatio = workerResult.durationMs / input.budget.maxDurationMs;
  if (durationRatio > 0.8) {
    confidence -= 0.1;
  }

  return Math.max(0.1, Math.min(1.0, confidence));
}
```

**Proposed: pass generation confidence to oracle gate for weighted allocation.**

The OracleGate interface adds an optional hint:

```typescript
interface OracleGate {
  verify(
    mutations: Array<{ file: string; content: string }>,
    workspace: string,
    hints?: {
      /** Per-mutation confidence from worker. Low-confidence mutations get deeper verification. */
      mutationConfidence?: Record<string, number>;
      /** Worker-reported uncertainty areas. */
      uncertainAreas?: string[];
    },
  ): Promise<VerificationResult>;
}
```

This is a backward-compatible optional parameter. The adapter can use hints to request additional oracles for low-confidence mutations (e.g., always run test oracle on uncertain files).

### Step 5 → Decision: Verify → Allow/Re-verify/Escalate

**Verification confidence derivation:**

```typescript
/**
 * Derive verification confidence from oracle verdicts using A5 tier weights.
 * Returns [0.0, 1.0] where 1.0 = all oracles passed with high confidence.
 */
function deriveVerificationConfidence(
  verdicts: Record<string, OracleVerdict>,
): number {
  const entries = Object.entries(verdicts);
  if (entries.length === 0) return 0.5; // no oracles = neutral

  const TIER_WEIGHTS: Record<string, number> = {
    deterministic: 1.0,
    heuristic: 0.7,
    probabilistic: 0.4,
  };

  let weightedSum = 0;
  let totalWeight = 0;

  for (const [_name, verdict] of entries) {
    // Use oracle's self-reported confidence (A2 compliance)
    const oracleConfidence = verdict.confidence;

    // Tier weight: deterministic oracles count more (A5)
    const tier = verdict.type === 'known' ? 'deterministic'
      : verdict.type === 'uncertain' ? 'heuristic'
      : 'probabilistic';
    const tierWeight = TIER_WEIGHTS[tier] ?? 0.5;

    // Combined: oracle confidence × tier weight × pass/fail
    const contribution = verdict.verified
      ? oracleConfidence * tierWeight
      : (1 - oracleConfidence) * tierWeight * 0.5; // partial credit for low-confidence failure
    weightedSum += contribution;
    totalWeight += tierWeight;
  }

  return totalWeight > 0 ? weightedSum / totalWeight : 0.5;
}
```

**Decision logic:**

```typescript
/** Thresholds for confidence-weighted decisions. */
const CONFIDENCE_THRESHOLDS = {
  /** Above this: allow without additional checks. */
  ADEQUATE: 0.7,
  /** Below this: pipeline is too uncertain to commit. */
  REFUSE: 0.3,
  /** Between REFUSE and ADEQUATE when passed: re-verify at higher level. */
  RE_VERIFY: 0.5,
} as const;

function makeConfidenceDecision(
  passed: boolean,
  pipelineConfidence: PipelineConfidence,
  currentLevel: RoutingLevel,
  retryCount: number,
): ConfidenceDecision {
  const c = pipelineConfidence.composite;

  // Hard pass: oracles passed + adequate confidence
  if (passed && c >= CONFIDENCE_THRESHOLDS.ADEQUATE) {
    return { action: 'allow', confidence: c };
  }

  // Low-confidence success: oracles passed but confidence is concerning
  if (passed && c >= CONFIDENCE_THRESHOLDS.RE_VERIFY && c < CONFIDENCE_THRESHOLDS.ADEQUATE) {
    // Identify which oracles could provide more certainty
    const additionalOracles = identifyAdditionalOracles(pipelineConfidence);
    return { action: 're-verify', confidence: c, additionalOracles };
  }

  // Very low confidence success: below re-verify threshold but technically passed
  if (passed && c < CONFIDENCE_THRESHOLDS.RE_VERIFY && c >= CONFIDENCE_THRESHOLDS.REFUSE) {
    if (currentLevel < 3) {
      return {
        action: 'escalate',
        confidence: c,
        fromLevel: currentLevel,
        toLevel: (currentLevel + 1) as RoutingLevel,
      };
    }
    return { action: 'retry', confidence: c, reason: 'Low confidence success at max routing level' };
  }

  // Pipeline confidence below REFUSE threshold
  if (c < CONFIDENCE_THRESHOLDS.REFUSE) {
    return { action: 'refuse', confidence: c, reason: `Pipeline confidence ${c.toFixed(3)} below refuse threshold ${CONFIDENCE_THRESHOLDS.REFUSE}` };
  }

  // Standard failure
  if (!passed) {
    return { action: 'retry', confidence: c, reason: 'Verification failed' };
  }

  // Unreachable — but A3 demands exhaustive handling
  return { action: 'allow', confidence: c };
}

function identifyAdditionalOracles(pc: PipelineConfidence): string[] {
  const additional: string[] = [];
  // If verification confidence is the weakest link, add more oracles
  if (pc.verification < 0.6) {
    additional.push('test'); // always helpful
  }
  if (pc.generation < 0.5) {
    additional.push('lint'); // catch generation quality issues
  }
  return additional;
}
```

### Step 5 → 6: Verify → Learn

**Proposed addition to ExecutionTrace:**

```typescript
interface ExecutionTrace {
  // ... existing fields ...

  /** Pipeline-level confidence propagated across all 6 steps. */
  pipelineConfidence?: PipelineConfidence;

  /** Decision made based on pipeline confidence. */
  confidenceDecision?: ConfidenceDecision;
}
```

**Enhanced calibration:**

```typescript
// In core-loop.ts, after computing pipeline confidence:
if (prediction && deps.selfModel.calibrate) {
  const predictionError = deps.selfModel.calibrate(prediction, trace);
  if (predictionError) {
    trace.predictionError = predictionError;
  }
  // NEW: Self-model can also learn from pipeline confidence accuracy
  // Was our prediction confidence aligned with the actual pipeline confidence?
  // This feeds into future metaConfidence adjustments.
}
trace.pipelineConfidence = pipelineConfidence;
trace.confidenceDecision = decision;
```

---

## 5. Cold Start Behavior

### Current cold-start safeguards (in CalibratedSelfModel)

| ID | Safeguard | Effect |
|----|-----------|--------|
| S1 | `totalObservations < 50` → `forceMinLevel = 2` | Minimum L2 routing |
| S2 | `observationCount < 10` → `metaConfidence ≤ 0.29` | Capped meta-confidence |
| S3 | `totalObservations < 100` → 10% audit sampling | Human review |
| S4 | `metaConfidence ≤ predictionAccuracy²` | Influence proportional to accuracy |

### Pipeline confidence during cold start

When `metaConfidence < 0.3` (cold start):

1. **prediction = 0.5** (default: no data)
2. **metaPrediction = 0.29** (capped by S2)
3. **planning = 0.5** if fallback DAG, **0.8 * planning** penalty otherwise (cold-start DAG less reliable)
4. **generation = normal derivation** (worker output is independent of observation count)
5. **verification = normal derivation** (oracles don't care about cold start)
6. **critic = normal derivation** (critic is independent)

**Composite at cold start** with normal verification (0.9):

```
composite = 0.5^0.10 * 0.29^0.05 * 0.5^0.15 * 0.7^0.15 * 0.9^0.40 * 1.0^0.15
          = 0.933 * 0.942 * 0.899 * 0.948 * 0.959 * 1.0
          ≈ 0.715
```

This falls between REFUSE (0.3) and ADEQUATE (0.7), correctly placing cold-start tasks in the "re-verify" or "borderline allow" zone. This matches intuition: cold-start tasks that pass verification should still proceed, but with awareness of uncertainty.

### Interaction with routing level decisions

Cold-start tasks already get L2 minimum via S1 (`forceMinLevel = 2`). Pipeline confidence does not override this — it operates on a different axis:

- **Routing level** = how much verification to apply (structural question)
- **Pipeline confidence** = how much to trust the result (epistemic question)

A cold-start task at L2 with passing oracles should commit but emit `pipeline:low_confidence_success` for observability. It should NOT be escalated solely due to cold start — the S1 safeguard already handled that.

### Should cold-start tasks always escalate to L2?

**No change needed.** S1 already forces L2. Adding pipeline confidence on top would double-penalize cold start. The correct behavior is:

1. S1 forces L2 (more oracles run)
2. Oracles produce verdicts with their own confidence
3. Pipeline confidence reflects the cold-start uncertainty through prediction + metaPrediction weights
4. If oracles pass with high confidence, composite is adequate (~0.7) despite cold start
5. If oracles pass with low confidence, composite drops and triggers re-verify

---

## 6. Retry/Escalation Policy

### Current policy (core-loop.ts)

```
for retry in 0..maxRetries:
  perceive → predict → plan → generate → verify
  if passed: return success
  else: record failure, continue
// exhausted: escalate routing level
```

### Proposed policy

```
for retry in 0..maxRetries:
  perceive → predict → plan → generate → verify
  compute pipelineConfidence
  decision = makeConfidenceDecision(passed, pipelineConfidence, level, retry)

  switch decision.action:
    case 'allow':
      return success  // passed + confidence >= ADEQUATE
    case 're-verify':
      run additional oracles from decision.additionalOracles
      recompute verification confidence
      if new composite >= ADEQUATE: return success
      else: continue  // retry with updated working memory
    case 'retry':
      record failure + confidence in working memory
      continue
    case 'escalate':
      break inner loop, escalate to next routing level
    case 'refuse':
      if level < MAX_ROUTING_LEVEL: escalate
      else: return failed with reason
// exhausted: escalate routing level (unchanged)
```

### Re-verification detail

When `action === 're-verify'`, the system does NOT re-run the full pipeline. Instead:

1. Identify which oracles have NOT yet run (e.g., test oracle may have been skipped at L1)
2. Run those additional oracles against the SAME mutations
3. Merge new verdicts into the existing verdict set
4. Recompute verification confidence
5. If new composite >= ADEQUATE: allow
6. Else: count as a retry, record in working memory

**Budget:** Re-verification counts against the retry budget. A task with `maxRetries: 3` can use at most 1 re-verification before falling back to retry. This prevents infinite re-verification loops.

### Low-confidence success tracking

```typescript
// In core-loop.ts, when decision.action === 'allow' but composite < ADEQUATE:
// (borderline allow — above RE_VERIFY but below ADEQUATE)
if (pipelineConfidence.composite < CONFIDENCE_THRESHOLDS.ADEQUATE) {
  deps.bus?.emit('pipeline:low_confidence_success', {
    taskId: input.id,
    pipelineConfidence,
    routingLevel: routing.level,
    // Flag for shadow validation at higher priority
    shadowPriority: 'high',
  });
}
```

### Persistent low confidence across retries

If 2+ retries produce low-confidence success (0.5 ≤ composite < 0.7), escalate:

```typescript
// Track across retries within a routing level
let lowConfidenceSuccessCount = 0;

// Inside retry loop, after decision:
if (decision.action === 'allow' && pipelineConfidence.composite < CONFIDENCE_THRESHOLDS.ADEQUATE) {
  lowConfidenceSuccessCount++;
  if (lowConfidenceSuccessCount >= 2 && routing.level < MAX_ROUTING_LEVEL) {
    // Escalate despite passing — uncertainty warrants deeper analysis
    deps.bus?.emit('task:escalate', {
      taskId: input.id,
      fromLevel: routing.level,
      toLevel: routing.level + 1,
      reason: `Persistent low confidence: ${lowConfidenceSuccessCount} consecutive low-confidence successes`,
    });
    break; // break inner loop to escalate
  }
}
```

---

## 7. ExecutionTrace Extensions

### New fields on ExecutionTrace

```typescript
interface ExecutionTrace {
  // ... all existing fields unchanged ...

  /** Pipeline-level compound confidence. Present when routing.level >= 1. */
  pipelineConfidence?: PipelineConfidence;

  /** Confidence-driven decision for this iteration. */
  confidenceDecision?: {
    action: 'allow' | 're-verify' | 'retry' | 'escalate' | 'refuse';
    confidence: number;
    reason?: string;
  };
}
```

### SQLite schema extension for trace_store

```sql
-- New columns on execution_traces table (nullable for backward compatibility)
ALTER TABLE execution_traces ADD COLUMN pipeline_confidence_composite REAL;
ALTER TABLE execution_traces ADD COLUMN pipeline_confidence_json TEXT;
ALTER TABLE execution_traces ADD COLUMN confidence_decision TEXT;

-- Index for querying low-confidence successes
CREATE INDEX idx_traces_low_confidence ON execution_traces(
  pipeline_confidence_composite
) WHERE outcome = 'success' AND pipeline_confidence_composite < 0.7;
```

### Sleep Cycle integration

The Sleep Cycle (Phase 2.4) can mine pipeline confidence data for patterns:

```sql
-- Pattern: tasks that frequently produce low-confidence successes
SELECT task_type_signature,
       COUNT(*) as low_conf_count,
       AVG(pipeline_confidence_composite) as avg_confidence
FROM execution_traces
WHERE outcome = 'success'
  AND pipeline_confidence_composite < 0.7
  AND pipeline_confidence_composite IS NOT NULL
GROUP BY task_type_signature
HAVING COUNT(*) >= 5
ORDER BY avg_confidence ASC;
```

This enables the Evolution Engine to generate rules like: "For task type `refactor::ts::medium`, always require test oracle (the task type has a 60% low-confidence success rate)."

---

## 8. Observable Events

### New bus events

```typescript
interface VinyanBusEvents {
  // ... existing events ...

  /** Emitted after pipeline confidence is computed for a task iteration. */
  'pipeline:confidence_computed': {
    taskId: string;
    pipelineConfidence: PipelineConfidence;
    routingLevel: RoutingLevel;
    iteration: number;  // retry number within routing level
  };

  /** Emitted when oracles pass but pipeline confidence is below ADEQUATE threshold. */
  'pipeline:low_confidence_success': {
    taskId: string;
    pipelineConfidence: PipelineConfidence;
    routingLevel: RoutingLevel;
    /** Shadow validation should run at elevated priority. */
    shadowPriority: 'normal' | 'high';
  };

  /** Emitted when pipeline confidence drives a routing level escalation. */
  'pipeline:confidence_escalation': {
    taskId: string;
    fromLevel: RoutingLevel;
    toLevel: RoutingLevel;
    compositeConfidence: number;
    weakestStep: string;
    weakestStepConfidence: number;
  };

  /** Emitted when pipeline confidence is below REFUSE threshold. */
  'pipeline:confidence_refuse': {
    taskId: string;
    compositeConfidence: number;
    formula: string;
    routingLevel: RoutingLevel;
  };

  /** Emitted when re-verification is triggered by low-confidence success. */
  'pipeline:re_verify': {
    taskId: string;
    originalConfidence: number;
    additionalOracles: string[];
    routingLevel: RoutingLevel;
  };
}
```

### Prometheus metrics (for `src/observability/`)

```typescript
// Counter: pipeline confidence decisions by action type
vinyan_pipeline_confidence_decisions_total{action="allow|re_verify|retry|escalate|refuse"}

// Histogram: pipeline confidence composite distribution
vinyan_pipeline_confidence_composite{routing_level="0|1|2|3"}

// Gauge: running average of pipeline confidence per task type
vinyan_pipeline_confidence_avg{task_type_signature="..."}

// Counter: low-confidence successes
vinyan_pipeline_low_confidence_success_total{routing_level="0|1|2|3"}
```

---

## 9. Performance Budget

### Latency analysis per routing level

| Level | Current Budget | Pipeline Confidence Overhead | Acceptable? |
|-------|---------------|------------------------------|-------------|
| L0 | 100ms | **SKIP** — L0 is reflex path, no pipeline confidence | Yes |
| L1 | 15,000ms | ~2ms (arithmetic only, no LLM calls) | Yes (0.01%) |
| L2 | 30,000ms | ~5ms (arithmetic + re-verify decision logic) | Yes (0.02%) |
| L3 | 120,000ms | ~10ms (arithmetic + re-verify + additional oracle dispatch) | Yes (0.008%) |

### Re-verification latency

When `action === 're-verify'`, additional oracle calls add latency:

| Oracle | Typical Duration | When Added |
|--------|-----------------|------------|
| lint | 500ms | verification < 0.6 |
| test | 2-10s | verification < 0.6 |
| type | 1-3s | generation < 0.5 |

**Worst case:** Re-verification adds up to ~10s at L2. This is within the 30s L2 budget since the initial verification would have been fast (otherwise the confidence would be higher).

### Memory overhead

PipelineConfidence is ~200 bytes per task iteration. For a task with 3 retries across 4 routing levels (12 iterations max), that's ~2.4KB. Negligible.

### L0 exemption

L0 reflex path (< 100ms budget) explicitly skips pipeline confidence computation. The L0 path already has no prediction, no planning, no critic, and minimal verification (hash-only). Pipeline confidence would be meaningless.

```typescript
// In core-loop.ts:
if (routing.level === 0) {
  // L0 reflex: skip pipeline confidence, use binary pass/fail
  // A3: this is a deterministic governance decision, not an optimization shortcut
}
```

---

## 10. Backward Compatibility

### Graceful degradation table

| Condition | Behavior |
|-----------|----------|
| No prediction available (L0-L1) | `prediction = 0.5`, `metaPrediction = 0.5` (neutral) |
| No planning available (L0-L1) | `planning = 1.0` (trust: no decomposition needed) |
| No critic engine | `critic = 1.0` (trust: critic not required) |
| No oracle confidence reported | Use `verified ? 1.0 : 0.0` as confidence |
| L0 reflex path | Skip pipeline confidence entirely; binary pass/fail |
| Phase 0 gate (library mode) | `PipelineConfidence` not computed; gate returns binary |

### Interface changes summary

| Interface | Change | Breaking? |
|-----------|--------|-----------|
| `TaskDecomposer.decompose()` | Add optional `prediction?` parameter | No |
| `OracleGate.verify()` | Add optional `hints?` parameter | No |
| `VerificationResult` | Type unchanged; confidence extracted from verdicts | No |
| `ExecutionTrace` | Add optional `pipelineConfidence?`, `confidenceDecision?` | No |
| `WorkingMemoryState` | No change (uncertainties already supported) | No |
| `VinyanBusEvents` | Add 5 new event types | No (additive) |

### Migration path

1. **Phase A:** Add `PipelineConfidence` type and `computePipelineConfidence()` to a new module `src/orchestrator/pipeline-confidence.ts`. Compute but do not act on it — emit events only.
2. **Phase B:** Wire confidence into retry/escalation decisions. Add re-verify path. Enable `pipeline:low_confidence_success` triggering shadow validation.
3. **Phase C:** Wire prediction into decomposer. Populate working memory uncertainties. Instrument prompt assembler.
4. **Phase D:** Add SQLite columns. Enable Sleep Cycle pattern mining on confidence data.

---

## 11. Example Walkthroughs

### Scenario A: Cold Start — New Task Type

**Context:** First time seeing `refactor::ts::medium`, 0 observations.

```
Step 1 (Perceive): 3 target files, 2 type errors, blast radius = 8
Step 2 (Predict):  confidence=0.5, metaConfidence=0.29, basis=static-heuristic
                   uncertainAreas=["type-errors-present", "low-task-type-observations"]
                   forceMinLevel=2 (S1: totalObservations < 50)

→ Propagate to working memory:
  addUncertainty("type-errors-present", 0.5, "Address type errors before functional changes")
  addUncertainty("low-task-type-observations", 0.5, "Use conservative approach")
  addHypothesis("Self-model expects pass outcome (confidence: 0.50, basis: static-heuristic)", 0.29, "self-model")

Step 3 (Plan):    Decomposer receives prediction → adds granularity guidance
                  DAG validated (not fallback), planning=0.8 * 0.8 (cold penalty) = 0.64

Step 4 (Generate): Worker sees uncertainties in prompt → flags 1 uncertainty
                   generation=0.8 - 0.1 (1 uncertainty) = 0.7

Step 5 (Verify):   AST oracle: verified=true, confidence=1.0 (deterministic)
                   Type oracle: verified=true, confidence=1.0 (deterministic)
                   Dep oracle: verified=true, confidence=0.9 (heuristic)
                   Test oracle: verified=true, confidence=0.8 (probabilistic)
                   verification = weighted mean = ~0.93

                   Critic: approved=true, confidence=0.85
                   critic = 0.85

Pipeline confidence:
  prediction=0.5, meta=0.29, planning=0.64, generation=0.7, verification=0.93, critic=0.85
  composite = 0.5^0.10 * 0.29^0.05 * 0.64^0.15 * 0.7^0.15 * 0.93^0.40 * 0.85^0.15
            = 0.933 * 0.942 * 0.936 * 0.948 * 0.971 * 0.976
            ≈ 0.726

Decision: composite(0.726) >= ADEQUATE(0.7) → ALLOW
Emit: pipeline:confidence_computed

Step 6 (Learn):   trace.pipelineConfidence stored
                  predictionError computed
                  Self-model observes: prediction 0.5 vs composite 0.726 → under-predicted → calibrate
```

### Scenario B: Normal Operation — 200+ Observations

**Context:** `fix::ts::single`, 250 observations, predictionAccuracy=0.82.

```
Step 2 (Predict):  confidence=0.82, metaConfidence=0.67, basis=trace-calibrated
                   uncertainAreas=[] (no type errors, low blast radius)

→ Working memory: no uncertainties to add
  addHypothesis("Self-model expects pass outcome (confidence: 0.82, basis: trace-calibrated)", 0.67, "self-model")

Step 3 (Plan):    DAG validated, no fallback, planning=0.95

Step 4 (Generate): Worker produces clean output, no uncertainties
                   generation=0.8 (base)

Step 5 (Verify):   All oracles pass, verification=0.98
                   No critic (L1 task), critic=1.0

Pipeline confidence:
  prediction=0.82, meta=0.67, planning=0.95, generation=0.8, verification=0.98, critic=1.0
  composite ≈ 0.903

Decision: composite(0.903) >= ADEQUATE(0.7) → ALLOW

Step 6: trace.pipelineConfidence={..., composite: 0.903}
```

### Scenario C: Low-Confidence Success — Oracles Pass But System Is Uncertain

**Context:** `add::tsx::large`, 30 observations, adding React component.

```
Step 2 (Predict):  confidence=0.55, metaConfidence=0.35, basis=hybrid
                   uncertainAreas=["high-blast-radius"]

Step 3 (Plan):    DAG validated but with low-confidence guidance → 6 nodes (extra granularity)
                  planning=0.85

Step 4 (Generate): Worker flags 3 uncertainties (new component patterns)
                   generation=0.8 - 0.3 (3 uncertainties) = 0.5

Step 5 (Verify):   AST: pass (1.0), Type: pass (1.0), Dep: pass (0.7), Test: pass (0.6)
                   verification = 0.82  (test oracle has low confidence — tests cover base case only)
                   Critic: approved=true, confidence=0.65
                   critic=0.65

Pipeline confidence:
  prediction=0.55, meta=0.35, planning=0.85, generation=0.5, verification=0.82, critic=0.65
  composite = 0.55^0.10 * 0.35^0.05 * 0.85^0.15 * 0.5^0.15 * 0.82^0.40 * 0.65^0.15
            = 0.942 * 0.949 * 0.976 * 0.901 * 0.921 * 0.937
            ≈ 0.656

Decision: composite(0.656) is between RE_VERIFY(0.5) and ADEQUATE(0.7) → RE-VERIFY
Additional oracles: ["test"] (verification is the weakest high-weight step)

Re-verification:
  Run test oracle with extended timeout → test passes with confidence 0.75
  New verification = 0.87
  New composite ≈ 0.69 — still below ADEQUATE

  This counts as a retry. On next iteration:
    Worker adjusts approach based on working memory feedback
    New generation=0.7, new verification=0.91
    New composite ≈ 0.75 → ALLOW

Emit: pipeline:low_confidence_success (first iteration)
Emit: pipeline:re_verify (first iteration)
Emit: pipeline:confidence_computed (both iterations)
```

---

## 12. Open Questions

### Q1: Should pipeline confidence influence model selection?

Currently, routing level determines model (L1=haiku, L2=sonnet, L3=opus). Could low pipeline confidence within a level trigger an upgrade to a more powerful model without changing routing level?

**Tentative answer:** No. Model selection is a routing decision (A3: deterministic governance). Pipeline confidence should influence the retry/escalate decision, which in turn affects routing level, which in turn selects the model. Adding a second path for model selection creates non-deterministic governance.

### Q2: How does pipeline confidence interact with the Evolution Engine's rule generation?

Sleep Cycle could mine `pipeline_confidence_composite` as a feature for rule conditions:

```typescript
condition: {
  filePattern: "*.tsx",
  pipelineConfidenceBelow: 0.6, // NEW condition type
}
action: "require-oracle",
parameters: { oracleName: "test" }
```

This is a Phase 3+ concern. The design here is compatible — just needs a new condition field in `EvolutionaryRule.condition`.

### Q3: Should the composite formula weights be adaptive?

The fixed weights (verification=0.40, etc.) are reasonable defaults, but task types may vary. A self-healing system could adjust weights per task type based on which steps correlate most with actual outcomes.

**Tentative answer:** Defer to Phase 4+. The fixed weights are a known starting point. Adaptive weights require significant trace data and introduce non-determinism in governance (A3 tension). If implemented, the adaptation must be transparent and auditable (store learned weights per task type signature).

### Q4: What about multi-mutation tasks?

A task with 10 file mutations has per-file oracle verdicts. Should pipeline confidence be per-file or per-task?

**Answer:** Per-task. The pipeline confidence captures the compound uncertainty of the entire pipeline run. Per-file confidence is already captured in the oracle verdicts. If a task has 10 files and 9 pass with high confidence but 1 fails, the binary `passed=false` already handles this. Pipeline confidence adds value when all files pass but the system is uncertain about the overall quality.

### Q5: How should pipeline confidence interact with the A2A protocol?

When sharing verdicts across instances (Phase 5+), should pipeline confidence be included? A receiving instance needs to know: "This fact was verified with pipeline confidence 0.65" vs "This fact was verified with pipeline confidence 0.95."

**Tentative answer:** Yes. Pipeline confidence should be included in ECP messages as an envelope-level field. The receiving instance applies its own tier-clamping (existing `tier-clamp.ts`) to the reported confidence. This is a natural extension of the existing `confidence` field on `OracleVerdict`.

### Q6: What happens when pipeline confidence disagrees with QualityScore?

`QualityScore.composite` and `PipelineConfidence.composite` measure different things:
- QualityScore: how good is the output? (architectural compliance, efficiency, simplification)
- PipelineConfidence: how certain are we about the output? (epistemic state)

They can diverge: a task might produce high-quality output (QualityScore=0.9) but with low certainty (PipelineConfidence=0.5) — e.g., the worker produced elegant code but the system hasn't seen this task type before.

**Answer:** Both are stored in the trace. They serve different consumers:
- QualityScore drives skill formation (Phase 2.5) — "this approach is good"
- PipelineConfidence drives retry/escalation — "we trust this result"

No reconciliation is needed; they are orthogonal dimensions.
