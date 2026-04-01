# Design: Oracle Integrity & Abstention Protocol

**Status:** Draft
**Author:** Oracle Integrity & Abstention Designer
**Date:** 2026-04-01
**Affects:** src/core, src/gate, src/oracle/*, src/orchestrator/core-loop, src/world-graph

---

## 1. Problem Statement

Four critical epistemic deficits undermine the trustworthiness of Vinyan's oracle pipeline. Each deficit causes the system to report higher confidence than the evidence warrants — violating A2 (First-Class Uncertainty), A5 (Tiered Trust), and A7 (Prediction Error as Learning).

### C1: Confidence Laundering at Source

`buildVerdict()` in `src/core/index.ts:17-28` defaults to `type: "known"` and `confidence: 1.0`. Any oracle that omits these fields silently claims absolute certainty. The type oracle (`src/oracle/type/type-verifier.ts:125-132`) reports `confidence: 1.0` when tsc finds zero errors — but "no type errors" only means "type-safe within tsc's analysis," not "correct code." The AST oracle (`src/oracle/ast/ast-verifier.ts:196-202`) similarly omits confidence on success, inheriting 1.0 from the default for a result whose scope is strictly syntactic.

**Impact:** Every oracle that uses `buildVerdict({...})` without explicit confidence silently launders uncertainty into certainty.

**Callers affected:** 66 call sites across 24 files. Of these, approximately 30 call sites in production oracle code omit `confidence`, inheriting 1.0.

### C3: Absence Treated as Evidence

Three locations equate "checked nothing" with "everything is fine":

1. **`src/gate/quality-score.ts:45-46`**: `if (entries.length === 0) architecturalCompliance = 1.0` — zero oracles ran, yet compliance is perfect.
2. **`src/oracle/test/test-verifier.ts:58-66`**: No test file found returns `verified: true, confidence: 0.5` — absence of tests is treated as passing, not as an unverifiable state.
3. **`src/oracle/lint/lint-verifier.ts:100-109`**: No linter configured returns `verified: true, confidence: 0.5` — inability to lint is treated as clean.

**Impact:** The gate can report "allow" with quality score 1.0 when zero verification actually occurred.

### C4: Circular Oracle Accuracy

`src/gate/gate.ts:42-55`: `updateOracleAccuracy()` computes oracle "accuracy" by checking whether each oracle's verdict agrees with the final gate decision. But the gate decision is itself derived from the oracle verdicts. This is circular: an oracle that always agrees with the majority will appear maximally "accurate" even if the majority is wrong.

**Impact:** The conflict resolver's Step 4 (historical accuracy comparison) relies on a metric that measures agreement, not correctness. A perpetually-agreeing oracle gains unearned authority.

### M4: World Graph Confidence Inflation

`src/orchestrator/core-loop.ts:713-728`: After verification passes, facts are stored in the World Graph at `confidence: 1.0` regardless of actual oracle confidence values. An oracle that passed with confidence 0.6 contributes to a fact stored at 1.0.

**Impact:** The World Graph overstates the reliability of every stored fact, defeating the purpose of the temporal decay and confidence systems.

---

## 2. buildVerdict() Redesign

### Analysis of Options

| Option | Change | Compile-time safety | Migration burden | Future-proof |
|--------|--------|---------------------|-----------------|--------------|
| A: Remove defaults | Force all callers to provide confidence + type | Highest — missing fields are type errors | 66 call sites | Best for new oracle authors |
| B: Vacuous default | Default to `confidence: 0.5, type: "uncertain"` | None — silent defaults still possible | 0 call sites | New oracles can still forget |
| C: Two functions | `buildKnownVerdict(confidence, ...)` + `buildAbstainedVerdict(...)` | High — function name signals intent | 66 call sites | Clear but more API surface |

### Recommendation: Option A (Remove defaults) with a migration bridge

Option A is the only approach that makes confidence laundering a compile-time error. Option B merely changes the default from a bad value to a less-bad value — future oracle authors can still forget. Option C adds API surface without adding safety beyond Option A.

### New Type Signature

```typescript
/**
 * Build an OracleVerdict. All epistemic fields are REQUIRED.
 *
 * Rationale: confidence and type must be a conscious choice by the oracle author.
 * The old default of confidence=1.0 caused confidence laundering (C1 deficit).
 */
export function buildVerdict(
  fields: Omit<OracleVerdict, "oracleName" | "qualityScore" | "origin" | "deliberationRequest"> & {
    oracleName?: string;
    qualityScore?: QualityScore;
    origin?: "local" | "a2a" | "mcp";
    deliberationRequest?: OracleVerdict["deliberationRequest"];
  },
): OracleVerdict {
  return {
    ...fields,
    confidenceReported: true,
  };
}
```

Key changes:
- `confidence` and `type` are now **required** fields (no defaults).
- `confidenceReported` is always set to `true` when using `buildVerdict()`. If an oracle verdict arrives via external transport without this flag, it signals the remote oracle did not explicitly report confidence.
- The function becomes a thin wrapper that adds `confidenceReported: true` and enforces the type contract.

### Migration Strategy

Every existing call site that currently omits `confidence` or `type` must be updated. The TypeScript compiler will surface all of them immediately.

**Call sites that already provide both fields:** No change needed (approximately 36 of 66 calls).

**Call sites that omit `confidence` on success paths:** Must add explicit confidence per the Per-Oracle Confidence Standards table (Section 6). Example for AST oracle:

```typescript
// BEFORE (ast-verifier.ts:196)
return buildVerdict({
  verified: result.found,
  evidence: result.evidence,
  fileHashes,
  reason: ...,
  durationMs: ...,
});

// AFTER
return buildVerdict({
  verified: result.found,
  type: "known",
  confidence: 1.0,  // AST: deterministic symbol lookup, scope=syntax only
  evidence: result.evidence,
  fileHashes,
  reason: ...,
  durationMs: ...,
});
```

**Interaction with Subjective Logic (SL):** If a future SL designer introduces `SubjectiveOpinion { belief, disbelief, uncertainty, atomicity }`, `buildVerdict()` should accept an optional `opinion` field alongside scalar `confidence`. The scalar confidence maps to the SL projected probability: `P = belief + atomicity * uncertainty`. The `buildVerdict()` contract does not conflict with SL — it merely ensures that whatever confidence representation is chosen, the oracle must provide it explicitly.

---

## 3. Oracle Abstention Protocol

### Motivation

Currently, all oracles MUST return an `OracleVerdict`. But sometimes the honest answer is "I cannot evaluate this." The test oracle returning `verified: true` for "no test files" is a symptom of missing abstention support. The lint oracle returning `verified: true` for "no linter" is the same.

### New Type

```typescript
/**
 * Formal oracle abstention — the oracle declares it cannot evaluate the hypothesis.
 * Distinct from failure (oracle tried and found problems) and unknown (oracle errored).
 *
 * In Subjective Logic terms, abstention is a vacuous opinion: { b=0, d=0, u=1, a=0.5 }.
 * It contributes zero evidence weight in fusion.
 */
export interface OracleAbstention {
  type: "abstained";
  reason: AbstentionReason;
  oracleName: string;
  durationMs: number;
  /** Optional: what would need to be true for this oracle to run. */
  prerequisites?: string[];
}

export type AbstentionReason =
  | "no_test_files"         // test oracle: no test file found for target
  | "no_linter_configured"  // lint oracle: no linter detected in workspace
  | "out_of_domain"         // oracle cannot evaluate this file type or pattern
  | "insufficient_data"     // not enough information to form a verdict
  | "timeout"               // oracle timed out before producing a verdict
  | "circuit_open"          // circuit breaker is open for this oracle
  | "target_not_found";     // target file does not exist
```

### Updated Oracle Return Type

```typescript
/** An oracle can return either a verdict or an abstention. */
export type OracleResponse = OracleVerdict | OracleAbstention;

/** Type guard for abstention. */
export function isAbstention(response: OracleResponse): response is OracleAbstention {
  return response.type === "abstained";
}
```

### Handling Rules

Each downstream consumer must handle abstentions explicitly:

#### 3.1 Gate Pipeline (`gate.ts`)

```typescript
// After oracle execution, partition results:
const verdicts: Record<string, OracleVerdict> = {};
const abstentions: Record<string, OracleAbstention> = {};

for (const { name, result } of results) {
  if (!result) continue;
  if (isAbstention(result)) {
    abstentions[name] = result;
  } else {
    verdicts[name] = result;
  }
}

// Abstentions are recorded in GateVerdict for observability but do NOT count
// as pass or fail.
```

The `GateVerdict` type gains a new field:

```typescript
export interface GateVerdict {
  decision: GateDecision;
  reasons: string[];
  oracle_results: Record<string, OracleVerdict>;
  oracle_abstentions: Record<string, OracleAbstention>;  // NEW
  durationMs: number;
  qualityScore?: QualityScore;
  riskScore?: number;
}
```

#### 3.2 Conflict Resolver

Abstentions are excluded from conflict resolution entirely. They are not passed to `resolveConflicts()`. An oracle that abstains has no opinion, so it cannot conflict with another oracle.

#### 3.3 Quality Score

Abstentions reduce the evidence count but do not affect compliance:

```typescript
// BEFORE: entries.length === 0 → architecturalCompliance = 1.0
// AFTER:
if (verdictEntries.length === 0) {
  architecturalCompliance = NaN;  // No evidence — compliance is indeterminate
}
```

The `QualityScore` type gains:

```typescript
export interface QualityScore {
  // ... existing fields ...
  /** True if no oracles produced verdicts (all abstained or none ran). */
  unverified: boolean;  // NEW
}
```

#### 3.4 Gate Decision with All Abstentions

If ALL oracles abstain (no verdicts at all), the gate decision depends on risk level:

```typescript
if (Object.keys(verdicts).length === 0 && Object.keys(abstentions).length > 0) {
  // All oracles abstained — no evidence either way.
  // Conservative: "allow" only for L0 (intentional skip), "block" for L1+.
  if (riskTieringActive && riskScore !== undefined && riskScore < 0.2) {
    // L0 reflex — intentional skip, abstention is expected
    decision = "allow";
    reasons.push("L0 reflex: all oracles abstained (intentional skip)");
  } else {
    decision = "block";
    reasons.push("All oracles abstained — insufficient evidence to allow");
  }
}
```

#### 3.5 SL Fusion

In Subjective Logic terms, an abstention is a vacuous opinion `w = { b=0, d=0, u=1, a=0.5 }`. Under cumulative belief fusion (CBF), a vacuous opinion acts as a neutral element — it does not change the fused result. This is exactly the correct behavior: an abstaining oracle contributes zero information.

### Oracle Migration

| Oracle | Current behavior | New behavior |
|--------|-----------------|--------------|
| test | `verified: true, confidence: 0.5` when no test file | `type: "abstained", reason: "no_test_files"` |
| lint | `verified: true, confidence: 0.5` when no linter | `type: "abstained", reason: "no_linter_configured"` |
| lint | `verified: true, confidence: 0.5` when target not found | `type: "abstained", reason: "target_not_found"` |
| ast | `verified: false` when context.symbolName missing | `type: "abstained", reason: "insufficient_data"` |
| dep | `verified: false` when target file not found | `type: "abstained", reason: "target_not_found"` |

---

## 4. Zero-Oracle Compliance Fix

### Current Problem

`src/gate/quality-score.ts:45-46`:
```typescript
if (entries.length === 0) architecturalCompliance = 1.0;
```

Zero oracles ran, but compliance is 1.0. This occurs in two distinct scenarios:

1. **L0 reflex (intentional skip):** Risk score < 0.2, all oracles are filtered out by risk tiering. This is a deliberate design choice.
2. **Circuit-breaker skip:** All oracles have open circuit breakers due to repeated failures.

These scenarios have different epistemic meanings.

### Recommendation: Distinguish intentional skip from failure skip

```typescript
if (verdictEntries.length === 0) {
  // Mark as unverified — consumers must check this flag
  architecturalCompliance = NaN;
  unverified = true;
} else if (oracleTiers) {
  // ... existing tier-weighted computation ...
}
```

For the gate decision logic:

| Scenario | architecturalCompliance | unverified | Gate behavior |
|----------|------------------------|-----------|---------------|
| L0 reflex (intentional) | NaN | true | Allow — hash-only by design |
| All circuit-breaker skip | NaN | true | Block — evidence was expected but unavailable |
| All abstained | NaN | true | Block at L1+ — see Section 3.4 |
| Normal oracles ran | computed | false | Standard pass/fail logic |

The `QualityScore.composite` formula handles NaN:

```typescript
// If architecturalCompliance is NaN, composite is NaN — signals indeterminate quality
if (Number.isNaN(architecturalCompliance)) {
  return {
    architecturalCompliance: NaN,
    efficiency,
    composite: NaN,
    dimensionsAvailable: dims,
    phase,
    unverified: true,
  };
}
```

### Alternative Considered: 0.5 for circuit-breaker skip

Using 0.5 (neutral) for circuit-breaker skip masks the real problem. If all oracles are in circuit-breaker failure, the system needs to escalate or halt — not silently assign a middling score. NaN + `unverified: true` forces consumers to handle the case explicitly.

---

## 5. Oracle Accuracy Tracking (Post-Hoc Design)

### Current Problem

`updateOracleAccuracy()` in `src/gate/gate.ts:42-55` defines "correct" as "agrees with final gate decision." This is circular because the gate decision is derived from the oracle verdicts themselves. An oracle that always votes with the majority appears 100% accurate.

### Replacement: Ground-Truth Retrospective Accuracy

Oracle accuracy should be measured against **outcomes that happen after the gate decision**, not against the decision itself.

#### 5.1 Ground Truth Sources

| Source | Signal | Availability | Latency |
|--------|--------|-------------|---------|
| Test failure after commit | Committed code broke tests | Within minutes | Low |
| Revert detected | Git revert of committed change | Within hours | Medium |
| Bug report linked to change | External signal of defect | Days | High |
| Still passing after 24h | No negative signal observed | 24h+ | High |

#### 5.2 Outcome Classification

For each oracle verdict on a gate run:

```typescript
type VerdictOutcome =
  | "confirmed_correct"   // oracle said pass, and no negative signal within window
  | "confirmed_wrong"     // oracle said pass, but later failure/revert detected
  | "correctly_rejected"  // oracle said fail, and later evidence supports rejection
  | "false_alarm"         // oracle said fail, but manual override succeeded
  | "pending"             // within observation window, no outcome yet
  | "indeterminate";      // insufficient data to determine outcome
```

#### 5.3 Storage Schema

Extend the existing trace store (which already persists `ExecutionTrace`):

```typescript
interface OracleAccuracyRecord {
  /** Unique per gate invocation + oracle name. */
  id: string;
  oracleName: string;
  /** Gate invocation ID (links to trace). */
  gateRunId: string;
  /** What the oracle said. */
  verdict: "pass" | "fail";
  /** Raw confidence from the oracle. */
  confidence: number;
  /** Oracle tier at time of verdict. */
  tier: string;
  /** Time of verdict. */
  timestamp: number;
  /** Files affected by this gate run. */
  affectedFiles: string[];
  /** Retrospective outcome — updated asynchronously. */
  outcome: VerdictOutcome;
  /** When outcome was determined. */
  outcomeTimestamp?: number;
  /** Source that determined the outcome. */
  outcomeSource?: "test_failure" | "revert" | "bug_report" | "time_window_passed" | "manual_override";
}
```

SQLite table:

```sql
CREATE TABLE oracle_accuracy (
  id TEXT PRIMARY KEY,
  oracle_name TEXT NOT NULL,
  gate_run_id TEXT NOT NULL,
  verdict TEXT NOT NULL CHECK (verdict IN ('pass', 'fail')),
  confidence REAL NOT NULL,
  tier TEXT NOT NULL,
  timestamp INTEGER NOT NULL,
  affected_files TEXT NOT NULL,  -- JSON array
  outcome TEXT NOT NULL DEFAULT 'pending',
  outcome_timestamp INTEGER,
  outcome_source TEXT,
  UNIQUE(gate_run_id, oracle_name)
);

CREATE INDEX idx_oracle_accuracy_name ON oracle_accuracy(oracle_name);
CREATE INDEX idx_oracle_accuracy_outcome ON oracle_accuracy(outcome);
CREATE INDEX idx_oracle_accuracy_timestamp ON oracle_accuracy(timestamp);
```

#### 5.4 Outcome Resolution Algorithm

Outcomes are resolved by the event bus, reacting to events that already exist in the system:

```typescript
// On task completion with test results:
bus.on("task:complete", (event) => {
  const trace = event.result.trace;
  if (trace?.oracleVerdicts) {
    const gateRunId = trace.id;
    const testFailed = /* extract from trace */;

    for (const [oracleName, passed] of Object.entries(trace.oracleVerdicts)) {
      updateOutcome(gateRunId, oracleName, testFailed);
    }
  }
});

// On file revert detected (world-graph file watcher):
bus.on("file:reverted", (event) => {
  // Find all pending accuracy records for this file
  resolveAsConfirmedWrong(event.filePath, "revert");
});

// Periodic sweep: mark "pending" records older than 24h with no negative signal as "confirmed_correct"
function sweepStaleRecords(windowMs: number = 24 * 60 * 60 * 1000): void {
  const cutoff = Date.now() - windowMs;
  db.query(`
    UPDATE oracle_accuracy
    SET outcome = 'confirmed_correct',
        outcome_timestamp = ?,
        outcome_source = 'time_window_passed'
    WHERE outcome = 'pending' AND timestamp < ?
  `).run(Date.now(), cutoff);
}
```

#### 5.5 Accuracy Computation

Replace the in-memory `oracleAccuracyTracker` with a query against the accuracy store:

```typescript
function computeOracleAccuracy(
  oracleName: string,
  windowDays: number = 7,
): { accuracy: number; total: number; confidenceWeightedAccuracy: number } | null {
  const cutoff = Date.now() - windowDays * 24 * 60 * 60 * 1000;

  const rows = db.query(`
    SELECT verdict, confidence, outcome
    FROM oracle_accuracy
    WHERE oracle_name = ? AND timestamp > ?
      AND outcome NOT IN ('pending', 'indeterminate')
  `).all(oracleName, cutoff);

  if (rows.length < 10) return null;  // Insufficient data — don't use accuracy in conflict resolution

  let correct = 0;
  let weightedCorrect = 0;
  let totalWeight = 0;

  for (const row of rows) {
    const isCorrect = (row.outcome === "confirmed_correct" || row.outcome === "correctly_rejected") ? 1 : 0;
    correct += isCorrect;
    weightedCorrect += isCorrect * row.confidence;
    totalWeight += row.confidence;
  }

  return {
    accuracy: correct / rows.length,
    total: rows.length,
    confidenceWeightedAccuracy: totalWeight > 0 ? weightedCorrect / totalWeight : 0,
  };
}
```

#### 5.6 Integration with Conflict Resolver

The conflict resolver Step 4 (`src/gate/conflict-resolver.ts:245-266`) currently takes `oracleAccuracy` from the circular tracker. Replace with:

```typescript
// In gate.ts, before calling resolveConflicts:
const oracleAccuracy: Record<string, OracleAccuracyRecord> | undefined =
  deps.accuracyStore
    ? Object.fromEntries(
        Object.keys(oracleResults)
          .map(name => {
            const acc = deps.accuracyStore.computeAccuracy(name, 7);
            return acc ? [name, { total: acc.total, correct: Math.round(acc.accuracy * acc.total) }] : null;
          })
          .filter(Boolean) as Array<[string, OracleAccuracyRecord]>,
      )
    : undefined;
```

The existing Step 4 algorithm does not change — only its input data source changes from circular (gate agreement) to ground-truth (retrospective outcomes).

#### 5.7 Time Windows

| Window | Use case | Minimum data |
|--------|----------|-------------|
| 24h | Real-time routing decisions | 10 verdicts |
| 7d | Conflict resolver Step 4 | 25 verdicts |
| 30d | Long-term oracle reliability reporting | 50 verdicts |

---

## 6. Per-Oracle Confidence Standards

Each oracle type has a defined scope and must report confidence within that scope. Confidence does NOT represent "probability of correct code." It represents "certainty within my evaluation domain."

### 6.1 Standards Table

| Oracle | Tier | verified=true means | Confidence (pass) | Confidence (fail) | Scope limitation |
|--------|------|---------------------|-------------------|-------------------|------------------|
| AST | deterministic | Symbol/import/signature found in AST | 1.0 | 1.0 (deterministic: symbol is absent) | Syntax structure only. No semantic analysis. |
| Type | deterministic | `tsc --noEmit` reports 0 diagnostics for target | 0.95 (scope: type safety only, not logic) | 1.0 (type error is definitive) | TypeScript type system. Does not check logic, runtime behavior, or test correctness. |
| Dep | deterministic | All relative imports resolve to existing files | 1.0 (fully resolved) | 1.0 (unresolvable import found) | Import graph structure. Does not check runtime availability. |
| Dep | deterministic | Blast radius computed | 0.8 (partial: only static imports) | N/A (informational oracle) | Cannot detect dynamic imports, re-exports through barrels, or bundler aliases. |
| Test | probabilistic | Test runner reports exit code 0 | 0.8 (tests may be flaky, incomplete coverage) | 0.95 (test failure is strong evidence) | Coverage-dependent. Flaky tests reduce signal. |
| Lint | heuristic | Linter reports 0 errors (warnings excluded) | 0.9 (lint rules are heuristic) | 0.95 (lint error is well-defined pattern) | Style and pattern rules only. No logic analysis. |

### 6.2 Scope-Adjusted Confidence

Should confidence be reduced based on partial file coverage? Example: type oracle passes but only covers 3 of 5 modified files.

**Recommendation: Yes, with a linear adjustment.**

```typescript
/**
 * Adjust oracle confidence by coverage ratio.
 * If the oracle only evaluated a subset of affected files, confidence is proportionally reduced.
 */
function adjustByCoverage(baseConfidence: number, filesEvaluated: number, totalFilesAffected: number): number {
  if (totalFilesAffected === 0) return baseConfidence;
  const coverageRatio = Math.min(1.0, filesEvaluated / totalFilesAffected);
  // Floor at 50% of base confidence — evaluating even one file provides some signal
  return baseConfidence * (0.5 + 0.5 * coverageRatio);
}
```

This adjustment is applied after the base confidence is determined but before tier clamping.

### 6.3 Asymmetric Pass/Fail Confidence

Note that several oracles have **asymmetric** confidence for pass vs fail:

- **Type oracle:** Pass confidence (0.95) < fail confidence (1.0) because "no errors found" is less certain than "errors found" (absence vs presence of evidence).
- **Test oracle:** Pass confidence (0.8) < fail confidence (0.95) because a passing test may have low coverage, but a failing test definitively shows a problem.

This asymmetry correctly encodes that **absence of failure is weaker evidence than presence of failure** — a fundamental epistemic principle.

---

## 7. Temporal Context Design

### Current State

The `temporalContext` field exists on `OracleVerdict` (`src/core/types.ts:100-105`) with `validFrom`, `validUntil`, and `decayModel`. The `temporal-decay.ts` module computes decayed confidence. However, **no local oracle populates this field**. All verdicts have `temporalContext: undefined`, meaning they never expire.

### TTL Design Per Oracle

| Oracle | TTL | Decay model | Invalidation trigger | Rationale |
|--------|-----|-------------|---------------------|-----------|
| AST | Until file change | step | File hash change → immediate invalidity | AST is exact for a given file state. After file change, AST facts become uncertain (step decay to 50%) rather than completely invalid, because structural changes may not affect the verified symbol. |
| Type | Until file or dep change | step | File hash change OR dependent file hash change | Type errors can cascade from imported modules. |
| Dep | Until file or dep change | step | File hash change OR any import target change | Import graph is structural — changes propagate through edges. |
| Test | 30 min | linear | File change → immediate invalidity; time → gradual decay | Tests can become flaky over time even without code changes (external dependencies, timing). Linear decay reflects decreasing confidence in test freshness. |
| Lint | Until file change | step | File hash change → immediate invalidity | Lint is deterministic per file state. |

### Implementation

Each oracle populates `temporalContext` in its verdict:

```typescript
// Example: type-verifier.ts
return buildVerdict({
  verified: targetDiags.length === 0,
  type: "known",
  confidence: targetDiags.length === 0 ? 0.95 : 1.0,
  evidence,
  fileHashes,
  durationMs: ...,
  temporalContext: {
    validFrom: Date.now(),
    validUntil: Date.now() + Infinity,  // Never time-expires; invalidated by file hash change
    decayModel: "step",
  },
});

// Example: test-verifier.ts
return buildVerdict({
  verified: true,
  type: "known",
  confidence: 0.8,
  evidence,
  fileHashes,
  durationMs: ...,
  temporalContext: {
    validFrom: Date.now(),
    validUntil: Date.now() + 30 * 60 * 1000,  // 30 minutes
    decayModel: "linear",
  },
});
```

For "until file change" TTL, the `validUntil` can be set to a far-future sentinel (e.g., `Number.MAX_SAFE_INTEGER`), and the world-graph's existing file hash invalidation mechanism handles the actual expiry. The temporal decay system then handles time-based expiry for oracles like test.

### Interaction with World Graph

When `core-loop.ts` stores a fact, it should propagate the oracle's `temporalContext` into the fact:

```typescript
deps.worldGraph.storeFact({
  ...factFields,
  confidence: computedFactConfidence,  // See Section 9
  validUntil: minValidUntil,           // Minimum across oracle temporalContexts
  decayModel: mostConservativeDecay,   // "linear" if any oracle uses linear; else "step"
});
```

---

## 8. Unknown Tier Default Policy

### Current Problem

Three locations default unknown/unrecognized tiers to the **highest** trust level:

1. **`src/oracle/tier-clamp.ts:43`**: `TIER_CAPS[tier] ?? 1.0` — unknown tier has no confidence cap.
2. **`src/gate/conflict-resolver.ts:211`**: `oracleTiers[name] ?? "deterministic"` — unknown oracle is treated as maximally trustworthy.
3. **`src/gate/quality-score.ts:51`**: `oracleTiers[name] ?? "deterministic"` — unknown oracle gets full weight.

This violates A5 (Tiered Trust): an unrecognized oracle should be distrusted until proven otherwise.

### Recommendation: Default to "heuristic" for internal, "speculative" for external

| Oracle origin | Default tier | Cap | Rationale |
|---------------|-------------|-----|-----------|
| Internal (registered in `ORACLE_ENTRIES`) | "heuristic" (cap 0.9) | 0.9 | Internal oracles are known code but may lack explicit tier configuration. Heuristic is a safe middle ground. |
| External (A2A peer, MCP tool) | "speculative" (cap 0.4) | 0.4 | External oracles have unverified implementation. Speculative until empirical accuracy is established. |
| Polyglot (custom command oracle) | "probabilistic" (cap 0.7) | 0.7 | Custom oracles are user-provided but local. Less trust than internal, more than remote. |

### Code Changes

```typescript
// tier-clamp.ts
const DEFAULT_INTERNAL_CAP = 0.9;  // heuristic
const DEFAULT_EXTERNAL_CAP = 0.4;  // speculative

export function clampByTier(confidence: number, tier?: string, origin?: "local" | "a2a" | "mcp"): number {
  if (!tier) {
    // No tier specified — apply conservative default based on origin
    const cap = origin === "a2a" || origin === "mcp"
      ? DEFAULT_EXTERNAL_CAP
      : DEFAULT_INTERNAL_CAP;
    return Math.min(confidence, cap);
  }
  const cap = TIER_CAPS[tier] ?? DEFAULT_INTERNAL_CAP;
  return Math.min(confidence, cap);
}

// conflict-resolver.ts
const DEFAULT_TIER = "heuristic";  // Was: "deterministic"
const passTier = config.oracleTiers[passName] ?? DEFAULT_TIER;
const failTier = config.oracleTiers[failName] ?? DEFAULT_TIER;

// quality-score.ts
const DEFAULT_TIER = "heuristic";  // Was: "deterministic"
const tier = oracleTiers[name] ?? DEFAULT_TIER;
const weight = TIER_WEIGHTS[tier] ?? 0.7;  // Was: ?? 1.0
```

### Tier Promotion

External oracles can be promoted from "speculative" to higher tiers based on retrospective accuracy (Section 5). When an A2A oracle accumulates 50+ verdicts with >80% accuracy over 30 days, its effective tier can be promoted to "probabilistic." This is done through the peer trust system (`PEER_TRUST_CAPS`) rather than changing the tier itself.

---

## 9. World Graph Confidence Computation

### Current Problem

`src/orchestrator/core-loop.ts:726`: `confidence: 1.0` — every fact is stored at maximum confidence regardless of oracle verdicts.

### Recommendation: Minimum oracle confidence (conservative)

Three options were considered:

| Method | Formula | Pros | Cons |
|--------|---------|------|------|
| Weighted mean | `sum(c_i * w_i) / sum(w_i)` | Smooth, uses all data | High-confidence oracles mask low ones |
| Minimum | `min(c_i for passing oracles)` | Conservative, safe | May understate when one oracle is uncertain |
| SL projected probability | `P = b + a * u` from fused opinion | Theoretically optimal | Requires SL implementation |

**Recommendation: Minimum confidence** — the most conservative option, aligned with the epistemic principle that a chain of evidence is only as strong as its weakest link. This also requires no SL infrastructure.

### Implementation

```typescript
// core-loop.ts — replace confidence: 1.0

function computeFactConfidence(
  verdicts: Record<string, OracleVerdict>,
): number {
  const passingConfidences = Object.values(verdicts)
    .filter(v => v.verified)
    .map(v => v.confidence);

  if (passingConfidences.length === 0) {
    // No passing oracles — should not be storing a fact
    return 0;
  }

  return Math.min(...passingConfidences);
}

// In the fact storage block:
const factConfidence = computeFactConfidence(verification.verdicts);

deps.worldGraph.storeFact({
  target: file,
  pattern: "oracle-verified",
  evidence: Object.entries(verification.verdicts).map(([oracle, v]) => ({
    file,
    line: 0,
    snippet: `${oracle}: ${v.verified ? "pass" : "fail"} (c=${v.confidence.toFixed(2)})`,
  })),
  oracle_name: "orchestrator",
  source_file: file,
  file_hash: hash,
  verified_at: Date.now(),
  session_id: input.id,
  confidence: factConfidence,  // Was: 1.0
  validUntil: computeFactValidUntil(verification.verdicts),
  decayModel: computeFactDecayModel(verification.verdicts),
});
```

### Helper: Fact Temporal Context from Oracle Verdicts

```typescript
function computeFactValidUntil(verdicts: Record<string, OracleVerdict>): number | undefined {
  const validUntils = Object.values(verdicts)
    .filter(v => v.verified && v.temporalContext?.validUntil)
    .map(v => v.temporalContext!.validUntil);

  if (validUntils.length === 0) return undefined;
  return Math.min(...validUntils);  // Fact expires when first oracle's evidence expires
}

function computeFactDecayModel(
  verdicts: Record<string, OracleVerdict>,
): "linear" | "step" | "none" {
  const models = Object.values(verdicts)
    .filter(v => v.verified && v.temporalContext?.decayModel)
    .map(v => v.temporalContext!.decayModel);

  // Most conservative decay model wins
  if (models.includes("linear")) return "linear";
  if (models.includes("step")) return "step";
  return "none";
}
```

---

## 10. Naming Corrections

### testMutationScore

**Current:** `quality-score.ts:78-85` — field named `testMutationScore`, documented as "% of injected faults caught by tests" (`types.ts:36`).

**Reality:** No mutation testing is performed. The heuristic checks:
- Tests exist + pass → 0.7
- Tests exist + fail → 0.3
- No tests → 0.4

**Rename to:** `testPresenceHeuristic`

```typescript
// types.ts
export interface QualityScore {
  // ...
  /** Heuristic: test existence and pass/fail state (0.0-1.0). NOT actual mutation testing. */
  testPresenceHeuristic?: number;
  // ...
}
```

**Migration:** The field name appears in:
- `src/core/types.ts` (definition)
- `src/gate/quality-score.ts` (computation)
- Tests referencing the field

The rename is backward-compatible if the old field is kept as a deprecated alias during a transition period, but since this is an internal type (not serialized to external APIs), a clean rename is preferred.

### architecturalCompliance

**Current name is acceptable** but the documentation should clarify what it actually measures: "weighted oracle pass ratio" — not true architectural compliance analysis. Add a JSDoc comment:

```typescript
/**
 * Weighted ratio of passing oracle verdicts (A5 tier-weighted).
 * Named "architecturalCompliance" for historical reasons; does not perform
 * true architectural analysis (layer violations, coupling metrics, etc.).
 */
architecturalCompliance: number;
```

---

## 11. Migration Plan

Ordered for backward compatibility. Each step can be deployed independently.

### Phase 1: Non-Breaking Additions (can ship immediately)

| Step | Change | Risk | Blocked by |
|------|--------|------|-----------|
| 1.1 | Add `OracleAbstention` type and `isAbstention()` guard to `src/core/types.ts` | None — additive | Nothing |
| 1.2 | Add `unverified` field to `QualityScore` (optional, defaults false) | None — additive | Nothing |
| 1.3 | Add `oracle_abstentions` field to `GateVerdict` (optional, defaults `{}`) | None — additive | Nothing |
| 1.4 | Create `oracle_accuracy` table in SQLite store | None — new table | Nothing |
| 1.5 | Rename `testMutationScore` → `testPresenceHeuristic` in types + quality-score | Low — internal type only | Nothing |

### Phase 2: Default Corrections (minor behavioral change)

| Step | Change | Risk | Blocked by |
|------|--------|------|-----------|
| 2.1 | Change unknown tier defaults to "heuristic" in tier-clamp, conflict-resolver, quality-score | Low — makes unknown oracles slightly less trusted | 1.1 |
| 2.2 | Change zero-oracle `architecturalCompliance` from 1.0 to NaN + `unverified: true` | Medium — consumers must handle NaN | 1.2 |

### Phase 3: Oracle Abstention (behavioral change)

| Step | Change | Risk | Blocked by |
|------|--------|------|-----------|
| 3.1 | Update test-verifier to return `OracleAbstention` for no-test-files | Medium — gate logic must handle | 1.1, 1.3 |
| 3.2 | Update lint-verifier to return `OracleAbstention` for no-linter | Medium — same | 1.1, 1.3 |
| 3.3 | Update gate.ts to partition verdicts and abstentions | Medium — core pipeline change | 3.1, 3.2 |
| 3.4 | Update conflict resolver to exclude abstentions | Low | 3.3 |
| 3.5 | Update quality-score to handle abstentions + NaN compliance | Low | 2.2, 3.3 |

### Phase 4: buildVerdict() Redesign (breaking change)

| Step | Change | Risk | Blocked by |
|------|--------|------|-----------|
| 4.1 | Remove defaults from `buildVerdict()` — confidence + type required | High — 30+ call sites break at compile time | 3.1, 3.2 |
| 4.2 | Update all oracle call sites with explicit confidence per Standards Table | High — must be done atomically with 4.1 | 4.1 |
| 4.3 | Update all test call sites | Medium | 4.1 |

### Phase 5: Accuracy & Confidence Propagation

| Step | Change | Risk | Blocked by |
|------|--------|------|-----------|
| 5.1 | Implement post-hoc accuracy tracking + event bus integration | Low — additive | 1.4 |
| 5.2 | Remove circular `updateOracleAccuracy()` from gate.ts | Low — replaced by 5.1 | 5.1 |
| 5.3 | Wire retrospective accuracy into conflict resolver | Low | 5.1, 5.2 |
| 5.4 | Fix World Graph confidence: use `min(oracle.confidence)` instead of 1.0 | Medium — stored facts get lower confidence | 4.2 |
| 5.5 | Add temporalContext to all oracle verdicts | Low — additive | 4.2 |
| 5.6 | Propagate temporalContext into stored facts | Low | 5.4, 5.5 |

---

## 12. Test Strategy

### New Tests Required

#### 12.1 buildVerdict() Tests

```typescript
describe("buildVerdict redesigned", () => {
  test("requires confidence field — compile-time enforcement", () => {
    // This test verifies the TypeScript type contract, not runtime behavior.
    // The test is that the following code does NOT compile:
    // buildVerdict({ verified: true, evidence: [], fileHashes: {}, durationMs: 0 });
    // ^ Error: Property 'confidence' is missing

    // Runtime test: explicit confidence is passed through
    const v = buildVerdict({
      verified: true, type: "known", confidence: 0.8,
      evidence: [], fileHashes: {}, durationMs: 0,
    });
    expect(v.confidence).toBe(0.8);
    expect(v.confidenceReported).toBe(true);
  });

  test("requires type field — compile-time enforcement", () => {
    const v = buildVerdict({
      verified: true, type: "uncertain", confidence: 0.5,
      evidence: [], fileHashes: {}, durationMs: 0,
    });
    expect(v.type).toBe("uncertain");
  });
});
```

#### 12.2 Abstention Tests

```typescript
describe("OracleAbstention", () => {
  test("test oracle abstains when no test files exist", async () => {
    const result = await testVerify({ target: "nonexistent.ts", pattern: "test-pass", workspace: tmpDir });
    expect(isAbstention(result)).toBe(true);
    if (isAbstention(result)) {
      expect(result.reason).toBe("no_test_files");
    }
  });

  test("lint oracle abstains when no linter configured", async () => {
    const result = await lintVerify({ target: "file.ts", pattern: "lint-clean", workspace: tmpDir });
    expect(isAbstention(result)).toBe(true);
    if (isAbstention(result)) {
      expect(result.reason).toBe("no_linter_configured");
    }
  });

  test("gate handles all-abstention case", async () => {
    // Setup: workspace with no tests, no linter, no AST context
    const verdict = await runGate({ tool: "write_file", params: { ... } });
    expect(verdict.oracle_abstentions).toBeDefined();
    expect(Object.keys(verdict.oracle_results).length).toBe(0);
    // L1+ with all abstentions should block
    expect(verdict.decision).toBe("block");
  });

  test("abstention is vacuous in conflict resolution", () => {
    // Abstentions should not be passed to resolveConflicts
    // Verify that gate.ts filters them out before calling resolver
  });
});
```

#### 12.3 Zero-Oracle Compliance Tests

```typescript
describe("zero-oracle compliance", () => {
  test("no oracles → architecturalCompliance is NaN + unverified=true", () => {
    const qs = computeQualityScore({}, 100);
    expect(Number.isNaN(qs.architecturalCompliance)).toBe(true);
    expect(qs.unverified).toBe(true);
  });

  test("composite is NaN when architecturalCompliance is NaN", () => {
    const qs = computeQualityScore({}, 100);
    expect(Number.isNaN(qs.composite)).toBe(true);
  });
});
```

#### 12.4 Unknown Tier Default Tests

```typescript
describe("unknown tier defaults", () => {
  test("clampByTier defaults unknown tier to heuristic cap (0.9)", () => {
    expect(clampByTier(1.0, "unknown_tier")).toBe(0.9);
  });

  test("clampByTier defaults external oracle to speculative cap (0.4)", () => {
    expect(clampByTier(1.0, undefined, "a2a")).toBe(0.4);
  });

  test("conflict resolver treats unknown tier as heuristic", () => {
    // Two oracles with unknown tier should have equal priority (heuristic=3)
    // Not elevated to deterministic (4)
  });
});
```

#### 12.5 Post-Hoc Accuracy Tests

```typescript
describe("oracle accuracy tracking", () => {
  test("record verdict and resolve outcome", () => {
    store.recordVerdict({ oracleName: "type", verdict: "pass", confidence: 0.95, ... });
    store.resolveOutcome(gateRunId, "type", "confirmed_correct", "time_window_passed");

    const acc = store.computeAccuracy("type", 7);
    expect(acc.accuracy).toBe(1.0);
  });

  test("circular tracker removed — accuracy not self-referential", () => {
    // Verify that updateOracleAccuracy() no longer exists or is replaced
  });

  test("insufficient data returns null", () => {
    const acc = store.computeAccuracy("new_oracle", 7);
    expect(acc).toBeNull();
  });
});
```

#### 12.6 World Graph Confidence Tests

```typescript
describe("world graph confidence propagation", () => {
  test("fact confidence = min of passing oracle confidences", () => {
    const verdicts = {
      type: { verified: true, confidence: 0.95, ... },
      lint: { verified: true, confidence: 0.9, ... },
      test: { verified: true, confidence: 0.8, ... },
    };
    expect(computeFactConfidence(verdicts)).toBe(0.8);
  });

  test("fact confidence ignores failing oracles", () => {
    const verdicts = {
      type: { verified: true, confidence: 0.95, ... },
      lint: { verified: false, confidence: 1.0, ... },  // fail with high confidence
    };
    expect(computeFactConfidence(verdicts)).toBe(0.95);
  });

  test("fact validUntil = min of oracle validUntils", () => {
    // type oracle: validUntil = Infinity (file change)
    // test oracle: validUntil = now + 30min
    // fact should get now + 30min
  });
});
```

#### 12.7 Per-Oracle Confidence Standards Tests

```typescript
describe("per-oracle confidence standards", () => {
  test("type oracle reports 0.95 on pass, 1.0 on fail", async () => {
    const pass = await typeVerify(cleanHypothesis);
    expect(pass.confidence).toBe(0.95);

    const fail = await typeVerify(brokenHypothesis);
    expect(fail.confidence).toBe(1.0);
  });

  test("test oracle reports 0.8 on pass, 0.95 on fail", async () => {
    const pass = await testVerify(passingHypothesis);
    expect(pass.confidence).toBe(0.8);
  });

  test("AST oracle reports 1.0 on both pass and fail", () => {
    // Deterministic: symbol either exists or doesn't
    const pass = astVerify(existingSymbolHypothesis);
    expect(pass.confidence).toBe(1.0);

    const fail = astVerify(missingSymbolHypothesis);
    expect(fail.confidence).toBe(1.0);
  });
});
```

---

## 13. Open Questions

### Q1: SL Integration Boundary

When the Subjective Logic designer introduces `SubjectiveOpinion`, should `buildVerdict()` accept an `opinion` field alongside scalar `confidence`? Or should the SL layer be a post-processing step that converts scalar confidence to opinions?

**Recommendation:** Post-processing. `buildVerdict()` stays simple with scalar confidence. A separate `toSubjectiveOpinion(verdict)` function converts based on tier and scope metadata. This keeps the oracle API simple and avoids forcing SL concepts on oracle authors.

### Q2: Abstention vs Low-Confidence Verdict

Is there a meaningful difference between `OracleAbstention { reason: "no_test_files" }` and `OracleVerdict { verified: true, confidence: 0.0, type: "uncertain" }`? Both encode "I have no information."

**Answer:** Yes. An abstention says "I could not run at all" — the oracle's domain is irrelevant to this hypothesis. A low-confidence verdict says "I ran and the evidence is weak." The distinction matters for:
- Conflict resolution: abstentions are excluded; low-confidence verdicts participate
- Quality score: abstentions don't count against compliance; low-confidence verdicts reduce it
- Observability: abstentions surface missing infrastructure (no tests, no linter)

### Q3: Retroactive Accuracy for Abstentions

Should abstentions be tracked in the accuracy store? If the test oracle abstains because no tests exist, and the code later causes a production bug, was the abstention "wrong"?

**Recommendation:** Track abstentions separately as a coverage metric, not an accuracy metric. "% of gate runs where oracle abstained" is useful for identifying missing test coverage, but it is categorically different from "% of verdicts that matched outcomes."

### Q4: NaN Composite Score and Downstream Consumers

`core-loop.ts` uses `qualityScore.composite` for trace recording and the SelfModel's EMA calibration. What happens when composite is NaN?

**Recommendation:** Guard all consumers:
```typescript
if (!Number.isNaN(qualityScore.composite)) {
  selfModel.calibrate(qualityScore.composite);
}
```
The SelfModel should not learn from unverified runs — that would let unverified work calibrate predictions.

### Q5: Accuracy Store Bootstrap Problem

The post-hoc accuracy system needs 10+ verdicts before it provides data to the conflict resolver. During bootstrap (first days of operation), Step 4 will have no data. Is the current behavior (skip Step 4 when no accuracy data) sufficient?

**Answer:** Yes. The conflict resolver already handles `config.oracleAccuracy === undefined` by skipping Step 4. The algorithm proceeds to Step 5 (escalation/conservative block). This is safe — the system is more conservative during bootstrap.

### Q6: L0 Reflex and the Abstention Protocol

L0 reflex intentionally skips all oracles. Should this be modeled as "all oracles abstained (reason: L0 skip)" or as a separate code path that never invokes oracles at all?

**Recommendation:** Separate code path. L0 is a deliberate routing decision by the risk router, not an oracle-level inability. The gate should set `decision: "allow"` with a reason like "L0 reflex: hash-only verification" and set `unverified: true` on the quality score. No abstention records should be created — abstentions model oracle-level conditions, not routing-level decisions.
