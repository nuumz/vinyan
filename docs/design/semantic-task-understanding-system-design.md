# Semantic Task Understanding — System Design

> **Document boundary**: This document owns the system design for Vinyan's layered semantic task understanding architecture — from the current rule-based extraction through structural resolution and LLM-assisted semantic parsing.
> For core axioms and identity → [concept.md](../foundation/concept.md).
> For architecture decisions → [decisions.md](../architecture/decisions.md).
> For memory & prompt architecture → [memory-prompt-architecture-system-design.md](memory-prompt-architecture-system-design.md).
> For Extensible Thinking (orthogonal: ambiguity axis) → [extensible-thinking-system-design.md](extensible-thinking-system-design.md).

**Date:** 2026-04-06
**Status:** Design Draft
**Confidence:** MEDIUM — architecture grounded in axiom analysis + codebase verification; no empirical data yet (Phase A will calibrate)
**Prerequisites:** 20-gap analysis and implementation (TaskUnderstanding IR, unified fingerprinting, perception fixes, prompt enrichment, cross-task learning) — all `[IMPLEMENTED]`

---

## 1. Problem Statement

### 1.1 Current State

Vinyan's `TaskUnderstanding` (`src/orchestrator/task-understanding.ts`) is purely rule-based:

| Component | Mechanism | Limitation |
|-----------|-----------|------------|
| Verb extraction | 16-verb hardcoded list, `includes()` scan | "make auth faster" → `unknown` |
| Category classification | 4 verb sets + regex fallbacks | "improve test coverage" → `mutation` (debatable) |
| Symbol extraction | Backtick regex + PascalCase.dot regex | "fix the auth service" → `undefined` |
| Framework detection | 15 import-path regexes on dependency cone | Only structural, no goal-text awareness |
| Constraints/criteria | Pass-through from `TaskInput` | No implicit constraint inference |

### 1.2 Failure Modes

| Goal | Current Understanding | Correct Understanding |
|------|----------------------|----------------------|
| "make auth faster" | verb=`unknown`, category=`mutation` (fallback) | verb=`optimize`, intent=`performance-optimization`, target=`src/auth/` |
| "fix the login flow" | verb=`fix`, symbol=`undefined` | verb=`fix`, resolvedPaths=`[src/auth/login.ts, src/ui/login-form.tsx]` |
| "why is the test flaky" | verb=`unknown`, category=`analysis` (fallback) | verb=`investigate`, intent=`flaky-test-diagnosis`, recurring=`true` (3 prior attempts) |
| "refactor auth like we did for payments" | verb=`refactor`, no historical context | verb=`refactor`, priorPattern=`payments refactor trace #247`, implicit=`follow same approach` |
| "add rate limiting" | verb=`add`, no implicit constraints | verb=`add`, implicit=`[don't break existing API, add config for limits]` |
| "สวัสดี" (greeting) | verb=`unknown`, category=`analysis` → LLM dispatch → output echoes system prompt instructions | domain=`conversational` → no tool access, LLM responds naturally (echo detection rejects parroted output) |
| "ช่วยถ่ายรูป screenshot" (non-code request) | verb=`unknown`, category=`analysis` → LLM proposes `shell_exec which gnome-screenshot` → **executed via step 5½** (A6 violation) | domain=`general-reasoning` → no tool access, LLM explains limitation naturally (A6 tool stripping as defense-in-depth) |

### 1.3 What "Understanding" Means for an Epistemic Orchestrator

In Vinyan's framework, understanding is not a black-box neural representation — it is a set of **verifiable epistemic claims** about a task. Each claim has:

- A **confidence** reflecting extraction certainty
- An **evidence tier** (deterministic, heuristic, probabilistic) per Axiom A5
- A **falsification condition** — what would invalidate the claim
- A **confidence source** — `evidence-derived` or `llm-self-report`

> **Core thesis:** Understanding is a **perception enrichment step**, not a governance action. It produces features that feed deterministic routing rules. The governance boundary is enforced by the type system: `confidenceSource: 'llm-self-report'` claims are excluded from routing/gating decisions (A3).

### 1.4 Established Precedent

The `TaskDecomposer` (`src/orchestrator/task-decomposer.ts`) already uses LLM in the enrichment path at L2+:

```
LLM generates TaskDAG → validateDAG() checks 5 machine-enforceable criteria → retry if invalid
```

The LLM shapes *what gets attempted*; deterministic oracles decide *whether it passes*. Semantic understanding follows the same pattern: LLM shapes *how the task is interpreted*; deterministic rules decide *how it's routed and verified*.

---

## 2. Design Principles

8 principles derived from Vinyan's 7 axioms:

| # | Principle | Axiom | Constraint |
|---|-----------|-------|-----------|
| P1 | Understanding is enrichment, not governance | A3 | No understanding claim influences routing unless `confidenceSource = 'evidence-derived'` |
| P2 | Understanding claims are epistemic objects | A5 | Each claim carries tier, confidence, evidence — same as `OracleVerdict` |
| P3 | LLM-derived understanding is `llm-self-report` | A3+A5 | Hardcoded in type system, not policy. Enters prompts, never routing |
| P4 | Generator ≠ verifier for understanding | A1 | Understanding Engine produces claims; existing oracles verify them |
| P5 | Each layer optional and additive | — | Layer 0 always runs. Higher layers enrich if budget allows. Graceful degradation |
| P6 | Understanding accuracy is calibrated | A7 | Post-task comparison: predicted intent vs actual behavior → `SelfModel.calibrate()` |
| P7 | "I don't know what this means" is valid | A2 | `type: 'unknown'` understanding is a protocol state, not an error |
| P8 | Content-addressed understanding (Layer 0-1) | A4 | Same goal + same codebase state → same Layer 0/1 understanding (deterministic). Layer 2 is "best-effort consistent" (temperature=0.1), NOT content-addressed — LLM output is inherently non-deterministic across calls |

---

## 3. Architecture Overview

### 3.1 4-Layer Understanding Model

```
                    ┌──────────────────────────────────────────────────────────────┐
                    │                    GOVERNANCE BOUNDARY                       │
                    │   (only evidence-derived / self-model-calibrated enter)      │
                    ├──────────────────────────────────────────────────────────────┤
                    │                                                              │
  Layer 0           │   ┌──────────────────────┐                                  │
  SYNTACTIC         │   │  task-understanding   │  Rule-based extraction           │
  [IMPLEMENTED]     │   │  .ts                  │  verb, category, symbol, regex   │
  tier=1.0          │   └──────────┬───────────┘                                  │
                    │              │                                               │
  Layer 1           │   ┌──────────▼───────────┐                                  │
  STRUCTURAL        │   │  entity-resolver.ts   │  WorldGraph + path fuzzy match  │
  [DESIGNED]        │   │  historical-profiler   │  SelfModel + trace history      │
  tier=0.9          │   │  .ts                  │  Deterministic queries           │
                    │   └──────────┬───────────┘                                  │
  ══════════════════╪══════════════╪═══════════════════════════════════════════════╡
                    │              │                                               │
  Layer 2           │   ┌──────────▼───────────┐                                  │
  SEMANTIC          │   │  understanding-engine │  Lightweight LLM (fast tier)     │
  [DESIGNED]        │   │  .ts                  │  Structured output → parse       │
  tier=0.4          │   └──────────┬───────────┘                                  │
                    │              │ (prompt-only, never routing)                  │
  Layer 3           │   ┌──────────▼───────────┐                                  │
  DEEP              │   │  task-decomposer.ts   │  Full LLM (existing, L2+)       │
  [IMPLEMENTED]     │   └──────────────────────┘                                  │
                    └──────────────────────────────────────────────────────────────┘
```

**Governance boundary:** Layers 0–1 produce `confidenceSource: 'evidence-derived'` claims that can influence routing. Layers 2–3 produce `confidenceSource: 'llm-self-report'` claims that enrich prompts only. This is enforced by the type system in `src/core/types.ts` line 165:

```typescript
confidenceSource?: 'evidence-derived' | 'self-model-calibrated' | 'llm-self-report';
// Only 'evidence-derived' and 'self-model-calibrated' enter routing/gating.
// 'llm-self-report' is logged for A7 analysis only, excluded from governance.
```

### 3.2 Data Flow

```
TaskInput.goal
  │
  ├──[Layer 0]──→ buildTaskUnderstanding()           cost: 0     latency: <1ms
  │                verb, category, symbol, constraints
  │                ↓
  ├──[Domain]───→ classifyTaskDomain()               cost: 0     latency: <0.1ms
  │                conversational | general-reasoning → no tool access
  │                code-mutation | code-reasoning
  │                ↓
  ├──[Layer 1]──→ resolveEntities() + profileHistory() cost: 0   latency: <50ms
  │                NL→paths, recurring detection, prior failures
  │                ↓
  ├──[Layer 2]──→ understandingEngine.execute()      cost: ~500 tokens  latency: <2s
  │  (budget-     intent, implicit constraints, ambiguities
  │   gated)      ↓
  │            ┌──[Verify]──→ oracle cross-check     cost: 0     latency: <100ms
  │            │   claim "affects auth/" → does src/auth/ exist?
  │            │   claim "target symbol" → AST oracle: symbol-exists?
  │            └──→ upgrade/downgrade confidence
  │
  ▼
  SemanticTaskUnderstanding (with taskDomain)
  │
  ├──→ Tool Scoping (domain → filter availableTools in prompt; conversational/general = none)
  ├──→ RiskRouter (Layer 0-1 claims only, governance-eligible)
  ├──→ PromptSectionRegistry (domain-filtered tools, all layers)
  ├──→ SelfModel.predict() (enriched signature → per-intent learning)
  ├──→ CrossTaskLoader (intent-aware approach matching)
  └──→ TraceCollector (understanding snapshot for calibration)
```

### 3.3 Component Topology

| Component | File | Layer | New/Existing |
|-----------|------|-------|-------------|
| `buildTaskUnderstanding()` | `src/orchestrator/task-understanding.ts` | 0 | `[IMPLEMENTED]` |
| `classifyTaskDomain()` | `src/orchestrator/task-understanding.ts` | 0 | `[IMPLEMENTED]` — rule-based domain classifier |
| `enrichWithPerception()` | `src/orchestrator/task-understanding.ts` | 0 | `[IMPLEMENTED]` |
| `EntityResolver` | `src/orchestrator/entity-resolver.ts` | 1 | `[DESIGNED]` — new file |
| `HistoricalProfiler` | `src/orchestrator/historical-profiler.ts` | 1 | `[DESIGNED]` — new file |
| `UnderstandingEngine` | `src/orchestrator/understanding-engine.ts` | 2 | `[DESIGNED]` — new file, implements `ReasoningEngine` |
| `UnderstandingVerifier` | `src/orchestrator/understanding-verifier.ts` | verify | `[DESIGNED]` — new file |
| `UnderstandingCalibrator` | `src/orchestrator/understanding-calibrator.ts` | learn | `[DESIGNED]` — new file |
| `PromptSectionRegistry` | `src/orchestrator/llm/prompt-section-registry.ts` | prompt | `[IMPLEMENTED]` — extend with new sections |
| `SelfModel.calibrate()` | `src/orchestrator/self-model.ts` | learn | `[IMPLEMENTED]` — extend signature |
| `core-loop executeTask()` | `src/orchestrator/core-loop.ts` | wire | `[IMPLEMENTED]` — extend pipeline |

---

## 4. Data Contracts

### 4.1 `SemanticTaskUnderstanding` — extended IR

```typescript
interface SemanticTaskUnderstanding extends TaskUnderstanding {
  // ── Layer 0: Domain Classification ─────────────────────
  /** Task domain — drives tool access scope and A2 capability boundary. */
  taskDomain: TaskDomain; // 'code-mutation' | 'code-reasoning' | 'general-reasoning' | 'conversational'

  // ── Layer 1: Structural ────────────────────────────────
  /** NL references resolved to code entities. */
  resolvedEntities: ResolvedEntity[];
  /** Historical profile from SelfModel traces. */
  historicalProfile?: HistoricalProfile;
  /** Understanding depth achieved (budget may limit). */
  understandingDepth: 0 | 1 | 2 | 3;

  // ── Layer 2: Semantic (optional, budget-gated) ─────────
  /** Fine-grained intent from LLM parsing. */
  semanticIntent?: SemanticIntent;

  // ── Verification results ───────────────────────────────
  /** Oracle-verified understanding claims. */
  verifiedClaims: VerifiedClaim[];

  // ── Content-addressing (P8) ───────────────────────────
  /** SHA-256 fingerprint = hash(goal + sorted(resolvedPaths) + taskSignature).
   *  Enables: cache lookup, trace dedup, Phase E fact key.
   *  Computed after Layer 1; updated after Layer 2 if resolved paths change. */
  understandingFingerprint: string;
}
```

### 4.2 `ResolvedEntity` — NL → code path mapping

```typescript
interface ResolvedEntity {
  /** The reference as it appears in the goal (e.g., "auth service"). */
  reference: string;
  /** Resolved file paths in the codebase. */
  resolvedPaths: string[];
  /** Resolution strategy used. */
  resolution: 'exact' | 'fuzzy-path' | 'fuzzy-symbol' | 'dependency-inferred';
  /** Confidence in the resolution. */
  confidence: number;
  /** Evidence tier — always deterministic for Layer 1. */
  confidenceSource: 'evidence-derived';
}
```

### 4.3 `HistoricalProfile` — SelfModel-derived context

```typescript
interface HistoricalProfile {
  /** Task type signature (e.g., "fix::ts::small"). */
  signature: string;
  /** Number of prior observations for this signature. */
  observationCount: number;
  /** Historical failure rate (0-1). */
  failRate: number;
  /** Oracles that most commonly reject this task type. */
  commonFailureOracles: string[];
  /** Average duration per file (ms). */
  avgDurationPerFile: number;
  /** SelfModel basis quality. */
  basis: 'static-heuristic' | 'hybrid' | 'trace-calibrated';
  /** Is this a recurring issue (same file + verb seen ≥3 times)? */
  isRecurring: boolean;
  /** Number of prior attempts on similar tasks. */
  priorAttemptCount: number;
}
```

### 4.4 `SemanticIntent` — LLM-derived understanding

```typescript
/** Closed vocabulary for primaryAction — prevents signature fragmentation.
 *  LLM output is canonicalized to one of these values post-parse.
 *  New values require a code change — intentional friction to avoid unbounded growth. */
const PRIMARY_ACTION_VOCAB = [
  'add-feature', 'bug-fix', 'security-fix', 'performance-optimization',
  'refactor', 'api-migration', 'dependency-update', 'test-improvement',
  'documentation', 'configuration', 'investigation', 'flaky-test-diagnosis',
  'accessibility', 'other',                    // catch-all for genuinely novel intents
] as const;
type PrimaryAction = typeof PRIMARY_ACTION_VOCAB[number];

interface SemanticIntent {
  /** Fine-grained intent canonicalized to PRIMARY_ACTION_VOCAB. */
  primaryAction: PrimaryAction;
  /** Secondary actions implied by the goal. */
  secondaryActions: string[];
  /** Natural-language scope description. */
  scope: string;
  /** Implicit constraints not stated in the goal.
   *  Polarity distinguishes positive ("must do X") from negative ("must not do Y") constraints.
   *  Enables prompt rendering with `MUST:` / `MUST NOT:` prefixes to prevent the generator
   *  from treating prohibitions as suggestions. */
  implicitConstraints: Array<{ text: string; polarity: 'must' | 'must-not' }>;
  /** Ambiguities with possible interpretations. */
  ambiguities: Array<{
    aspect: string;
    interpretations: string[];
    selectedInterpretation?: string;
    confidence: number;
  }>;
  /** Always probabilistic — hardcoded, not configurable. */
  confidenceSource: 'llm-self-report';
  /** Always below heuristic threshold. */
  tierReliability: 0.4;
}
```

### 4.5 Understanding as ECP-Compatible Claims

Each understanding claim is structurally compatible with `OracleVerdict` (`src/core/types.ts`):

```typescript
interface VerifiedClaim {
  /** The claim being made (e.g., "task affects src/auth/"). */
  claim: string;
  /** Epistemic type — same 4-state taxonomy as OracleVerdict. */
  type: 'known' | 'unknown' | 'uncertain' | 'contradictory';
  /** Verification confidence (post-oracle). */
  confidence: number;
  /** Which oracle verified (or null if unverified). */
  verifiedBy?: string;
  /** ECP confidence source — determines governance eligibility. */
  confidenceSource: 'evidence-derived' | 'llm-self-report';
  /** A5 tier reliability. */
  tierReliability: number;
  /** What would invalidate this claim. */
  falsifiableBy: string[];
  /** Evidence chain. */
  evidence: Array<{ file: string; line?: number; snippet?: string }>;
}
```

**Tier assignment rules:**

| Source | `tierReliability` | Governance-eligible |
|--------|------------------|-------------------|
| Layer 0 regex extraction | 1.0 | Yes |
| Layer 1 exact path match | 0.95 | Yes |
| Layer 1 fuzzy path match | 0.85 | Yes |
| Layer 1 dependency inference | 0.75 | Yes |
| Layer 1 historical profile | 0.9 (`self-model-calibrated`) | Yes |
| Layer 2 LLM intent | 0.4 (`llm-self-report`) | **No** |
| Layer 2 LLM implicit constraints | 0.35 (`llm-self-report`) | **No** |

### 4.6 Schema Migration — Trace Enrichment

```sql
-- Migration 011: Add understanding snapshot to execution_traces
ALTER TABLE execution_traces ADD COLUMN understanding_depth INTEGER;
ALTER TABLE execution_traces ADD COLUMN understanding_intent TEXT;    -- JSON
ALTER TABLE execution_traces ADD COLUMN resolved_entities TEXT;       -- JSON
ALTER TABLE execution_traces ADD COLUMN understanding_verified INTEGER DEFAULT 0;
ALTER TABLE execution_traces ADD COLUMN understanding_primary_action TEXT;  -- denormalized from JSON
CREATE INDEX idx_primary_action ON execution_traces(understanding_primary_action);
```

The `understanding_primary_action` column is denormalized from `understanding_intent` JSON to enable indexed queries. Calibration (§5.5) aggregates by primary action — `json_extract()` in SQLite forces full-table scans, while a TEXT column supports `CREATE INDEX idx_primary_action ON execution_traces(understanding_primary_action)`. Written at insert time alongside the JSON blob.

This enables A7 calibration: compare `understanding_intent` at trace time with actual task outcome.

---

## 5. Component Design

### 5.1 Entity Resolver (Layer 1)

**File:** `src/orchestrator/entity-resolver.ts`
**Dependencies:** WorldGraph, file system (glob)

**Algorithm — NL reference → code path resolution:**

```
Input: goal tokens (e.g., ["fix", "auth", "service"])
       targetFiles from TaskInput (if provided)

Step 1: Exact match
  - If targetFiles provided, they ARE the resolved entities (confidence 1.0)

Step 2: Per-token fuzzy match (NOT sequential glob)
  - Tokenize non-verb words from goal → candidate tokens
  - List all source files (glob: **/*.{ts,tsx,js,py} — cached per session)
  - For each file path, score:
      matchedTokens = tokens.filter(t => pathLower.includes(t.toLowerCase()))
      score = (matchedTokens.length / tokens.length)
             × pathSpecificityBonus(depth)           // deeper = more specific
             × (1 + 0.1 × consecutiveTokenBonus)     // "auth_service" > random match
  - Threshold: score ≥ 0.6
  - Why not sequential glob: NL token order ≠ path segment order.
    "fix the auth service" → tokens ["auth", "service"] should match
    `src/services/authentication.ts` (substring partial match),
    not only `*auth*service*.ts` (exact sequence).

Step 3: Symbol search (if targetSymbol from Layer 0)
  - Query WorldGraph: queryFacts(targetSymbol)
  - If found: resolve sourceFile from fact evidence
  - If not found: grep codebase for symbol definition

Step 4: Dependency inference
  - If Step 2 found candidate files, expand via WorldGraph.queryDependents()
  - If goal mentions relationships ("imports", "calls", "depends on"):
    expand via WorldGraph.queryDependencies()
  - Confidence: 0.75 (inferred, not directly stated)

Output: ResolvedEntity[] sorted by confidence DESC
```

**Perception expansion safety gate:** Resolved entities are used in two ways: (1) prompt annotation (always safe — advisory text), and (2) perception expansion (loading file contents into the dependency cone). Only entities with `confidence ≥ 0.8` may expand perception. Lower-confidence entities appear as prompt annotations only:

```typescript
const PERCEPTION_EXPANSION_THRESHOLD = 0.8;

// In enrichUnderstanding(), after entity resolution:
const perceptionEntities = resolved.filter(e => e.confidence >= PERCEPTION_EXPANSION_THRESHOLD);
const annotationOnlyEntities = resolved.filter(e => e.confidence < PERCEPTION_EXPANSION_THRESHOLD);

// perceptionEntities → added to perception.fileContents (loaded)
// annotationOnlyEntities → added to prompt as "[LOW CONFIDENCE] may relate to: ..."
```

This prevents a fuzzy match at 0.6 confidence from loading 20 unrelated files into context, which would degrade generation quality and waste tokens.

**Key constraint:** No LLM invocation. All operations are deterministic (A3-safe, P8-compliant).

**File list cache scope:** The glob result (`**/*.{ts,tsx,js,py}`) is cached per-task lifecycle on the `EntityResolver` instance, not globally. The `forceRefresh` option (used by re-comprehend, §5.6) invalidates the glob cache alongside the entity cache, forcing a fresh filesystem scan. This prevents stale resolution when files are created or deleted during retries.

### 5.2 Historical Profiler (Layer 1)

**File:** `src/orchestrator/historical-profiler.ts`
**Dependencies:** SelfModel, TraceStore, RejectedApproachStore

```typescript
function profileHistory(
  input: TaskInput,
  selfModel: SelfModel,
  traceStore: TraceStore,
  rejectedStore?: RejectedApproachStore,
): HistoricalProfile {
  const signature = computeTaskSignature(input);
  const params = selfModel.getParams(signature);

  // Recurring issue detection: same file + verb seen ≥3 times
  // Uses existing TraceStore.findByTaskType() (trace-store.ts:87)
  // which queries: SELECT * FROM execution_traces WHERE task_type_signature = ? LIMIT ?
  const priorTraces = traceStore.findByTaskType(signature, 50);
  const targetFile = input.targetFiles?.[0];
  const sameFileTraces = targetFile
    ? priorTraces.filter(t => t.affectedFiles.includes(targetFile))
    : [];
  const isRecurring = sameFileTraces.length >= 3;

  // Common failure oracles
  const failedTraces = priorTraces.filter(t => t.outcome === 'failure');
  const oracleFailCounts = new Map<string, number>();
  for (const t of failedTraces) {
    for (const [oracle, passed] of Object.entries(t.oracleVerdicts)) {
      if (!passed) oracleFailCounts.set(oracle, (oracleFailCounts.get(oracle) ?? 0) + 1);
    }
  }
  const commonFailureOracles = [...oracleFailCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([name]) => name);

  return {
    signature,
    observationCount: params?.observationCount ?? 0,
    failRate: params?.failRate ?? 0,
    commonFailureOracles,
    avgDurationPerFile: params?.avgDurationPerFile ?? 0,
    basis: params?.basis ?? 'static-heuristic',
    isRecurring,
    priorAttemptCount: sameFileTraces.length,
  };
}
```

**Key constraint:** Reads from existing stores only. No new persistence. Deterministic.

### 5.3 Understanding Engine (Layer 2)

> **⚠️ Preliminary specification.** Layer 2 design depth is intentionally limited. Implementation detail (prompt wording, schema fields, budget thresholds) is pending Phase A measurement results. If Layer 0+1 achieves ≥80% entity resolution accuracy in Phase A, Layer 2 investment may be significantly reduced or deferred. Do not over-invest in this section until Phase A data justifies it.

**File:** `src/orchestrator/understanding-engine.ts`
**Implements:** `ReasoningEngine` interface (`src/orchestrator/types.ts` line 793)

```typescript
class UnderstandingEngine implements ReasoningEngine {
  id = 'vinyan-understanding-engine';
  engineType: REEngineType = 'llm';
  capabilities = ['task-understanding', 'intent-extraction'];
  tier: 'fast' = 'fast';  // Always use fast tier — budget-conscious
  maxContextTokens = 4_000;

  constructor(private provider: LLMProvider) {}

  async execute(request: RERequest): Promise<REResponse> {
    return this.provider.generate({
      systemPrompt: request.systemPrompt,
      userPrompt: request.userPrompt,
      maxTokens: 500,       // Structured output is compact
      temperature: 0.1,     // Near-deterministic for consistency (P8)
    });
  }
}
```

**Structured output prompt:**

```
You are a task understanding engine for an autonomous code orchestrator.
Given a task goal and codebase context, extract structured understanding.
Output ONLY valid JSON — no explanation, no markdown fences.

Schema:
{
  "primaryAction": "one of: add-feature | bug-fix | security-fix | performance-optimization | refactor | api-migration | dependency-update | test-improvement | documentation | configuration | investigation | flaky-test-diagnosis | accessibility | other",
  "secondaryActions": ["string — implied follow-up actions"],
  "scope": "string — natural-language scope description",
  "implicitConstraints": [{"text": "string — constraint", "polarity": "must | must-not"}],
  "ambiguities": [{"aspect": "string", "interpretations": ["string"], "confidence": 0.0-1.0}]
}

Context:
- Goal: "{goal}"
- Target files: {files}
- Frameworks: {frameworks}
- Action verb (rule-based): {verb}
- Category (rule-based): {category}
- Resolved entities: {entities}
- Historical profile: {profile}
- Recent failures: {failures}
```

**Few-shot examples:** The prompt includes 1-2 few-shot examples (~200 tokens each) selected from a static set of 5 canonical goals spanning different `primaryAction` categories. Examples are hardcoded (not dynamically selected) to maintain prompt template determinism. If the total prompt would exceed `maxContextTokens - 500` (reserving 500 for output), examples are dropped first before truncating context.

**Budget gating (core-loop integration):**

```typescript
// In executeTask(), after Layer 1:
const LAYER2_MIN_BUDGET_TOKENS = 2000;
const LAYER2_TIMEOUT_MS = 2000;

const remainingBudget = input.budget.maxTokens - totalTokensConsumed; // NOT the original budget
if (remainingBudget >= LAYER2_MIN_BUDGET_TOKENS && understanding.understandingDepth < 2) {
  const semanticIntent = await understandingEngine.execute(buildUnderstandingRequest(understanding));
  understanding.semanticIntent = parseSemanticIntent(semanticIntent.content);
  understanding.semanticIntent.confidenceSource = 'llm-self-report'; // HARDCODED — A3
  understanding.semanticIntent.tierReliability = 0.4;                // HARDCODED — A5
  understanding.understandingDepth = 2;
}
```

**Critical A3 enforcement:** `confidenceSource` and `tierReliability` are **hardcoded after parsing**, not read from LLM output. The LLM cannot escalate its own trust level.

**Circuit breaker:** Layer 2 invocation is wrapped with the existing `OracleCircuitBreaker` pattern (`src/oracle/circuit-breaker.ts`). If the LLM provider fails 3 consecutive times, the circuit opens and Layer 2 is skipped with graceful degradation to Layer 0+1 — same state machine (closed → open → half-open) as oracle processes, registered as `'understanding-engine'` in the shared breaker registry.

**Result caching:** Layer 2 results are cached by `sha256(goal + JSON.stringify(resolvedEntities) + signature)` within the task lifecycle. If `enrichUnderstandingL2()` is called multiple times for the same task (e.g., after level escalation re-enters `executeTask`), the cached result is returned unless `forceRefresh` is set. Cache scope is per-task (in-memory Map), not cross-task — cross-task caching would require staleness management that contradicts P8.

**Parse fallback:** If `parseSemanticIntent()` fails (JSON truncation, malformed output), the entire Layer 2 result is discarded and `understandingDepth` remains at its pre-Layer-2 value. This is logged as a warning but not an error — Layer 2 is always optional. The schema is intentionally flat: `ambiguities` uses single-string descriptions (e.g., `"OAuth2 provider: Auth0 vs custom"`) rather than nested arrays to minimize token usage and reduce truncation risk.

**Post-parse canonicalization:** The LLM may return free-text instead of a vocabulary value. Normalize before consumption:

```typescript
function canonicalizePrimaryAction(raw: string): PrimaryAction {
  const normalized = raw.toLowerCase().replace(/[\s_]+/g, '-');
  if (PRIMARY_ACTION_VOCAB.includes(normalized as PrimaryAction)) return normalized as PrimaryAction;

  // Fuzzy fallback: Levenshtein ≤ 3 to closest vocab entry
  const best = PRIMARY_ACTION_VOCAB
    .map(v => ({ v, d: levenshtein(normalized, v) }))
    .sort((a, b) => a.d - b.d)[0]!;
  if (best.d <= 3) return best.v;

  return 'other'; // Genuinely novel → catch-all, tracked for A7 review
}
```

This prevents signature fragmentation: `"performance optimization"`, `"perf-optimization"`, `"optimize-performance"` all canonicalize to `"performance-optimization"`. The `other` bucket is reviewed periodically — if a pattern emerges, a new vocabulary entry is added.

**Implicit constraint verification:** Before `implicitConstraints` enter the prompt, each is cross-checked against codebase evidence:

```typescript
// Post-parse, before prompt injection:
for (const constraint of intent.implicitConstraints) {
  // Patterns like "use X" where X is an external dependency
  const useMatch = constraint.text.match(/\buse\s+(\w+)/i);
  if (useMatch) {
    const dep = useMatch[1]!.toLowerCase();
    const inDeps = packageJson.dependencies?.[dep] || packageJson.devDependencies?.[dep];
    if (!inDeps) {
      // Strip unverifiable dependency constraints
      intent.implicitConstraints = intent.implicitConstraints.filter(c => c !== constraint);
      // Log for A7 calibration
      claims.push({ claim: constraint.text, type: 'contradictory', verifiedBy: 'package.json' });
    }
  }
}
// Remaining unverified constraints rendered with polarity prefix + caveat:
// "MUST: [UNVERIFIED] consider rate limiting" or "MUST NOT: [UNVERIFIED] break existing API"
```

This prevents the Generator from acting on hallucinated dependency constraints (e.g., LLM says "use Redis" but Redis is not in `package.json`).

### 5.4 Understanding Verifier (A1)

**File:** `src/orchestrator/understanding-verifier.ts`
**Dependencies:** WorldGraph, Goal Alignment Oracle (`src/oracle/goal-alignment/goal-alignment-verifier.ts`), file system

**Design decision:** The Understanding Verifier **reuses** existing Goal Alignment Oracle check functions (`checkTargetSymbolCoverage`, `checkFileScope`) rather than reimplementing symbol/file verification. This prevents parallel verification code for the same concern. The Verifier extends these with entity-specific checks (path existence, scope-vs-evidence contradiction).

Cross-checks understanding claims against existing oracle infrastructure:

```typescript
async function verifyUnderstandingClaims(
  understanding: SemanticTaskUnderstanding,
  worldGraph: WorldGraph,
  workspace: string,
): Promise<VerifiedClaim[]> {
  const claims: VerifiedClaim[] = [];

  // Verify resolved entities exist
  for (const entity of understanding.resolvedEntities) {
    for (const path of entity.resolvedPaths) {
      const exists = existsSync(join(workspace, path));
      claims.push({
        claim: `File ${path} exists (referenced as "${entity.reference}")`,
        type: exists ? 'known' : 'contradictory',
        confidence: exists ? 0.99 : 0.01,
        verifiedBy: 'fs',
        confidenceSource: 'evidence-derived',
        tierReliability: 1.0,
        falsifiableBy: ['file-deleted', 'file-renamed'],
        evidence: [{ file: path }],
      });
    }
  }

  // Verify symbol claims via WorldGraph facts
  if (understanding.targetSymbol) {
    const facts = worldGraph.queryFacts(understanding.targetSymbol);
    const verified = facts.length > 0;
    claims.push({
      claim: `Symbol ${understanding.targetSymbol} exists in codebase`,
      type: verified ? 'known' : 'unknown',
      confidence: verified ? facts[0]!.confidence : 0.3,
      verifiedBy: verified ? facts[0]!.oracleName : undefined,
      confidenceSource: 'evidence-derived',
      tierReliability: verified ? 0.95 : 0.5,
      falsifiableBy: ['symbol-renamed', 'file-modified'],
      evidence: verified
        ? facts.map(f => ({ file: f.sourceFile, snippet: f.pattern }))
        : [{ file: 'goal', snippet: understanding.rawGoal }],
    });
  }

  // Verify semantic intent claims (Layer 2) against structural evidence
  if (understanding.semanticIntent) {
    const intent = understanding.semanticIntent;
    // If LLM says "affects auth/" but no resolved entities in auth/ → flag
    const claimsAuthScope = intent.scope.toLowerCase().includes('auth');
    const hasAuthEntities = understanding.resolvedEntities
      .some(e => e.resolvedPaths.some(p => p.includes('auth')));
    if (claimsAuthScope && !hasAuthEntities) {
      claims.push({
        claim: `Semantic scope "${intent.scope}" references auth but no auth files resolved`,
        type: 'contradictory',
        confidence: 0.7,
        confidenceSource: 'evidence-derived', // The contradiction is evidence-derived
        tierReliability: 0.8,
        falsifiableBy: ['entity-resolution-expanded'],
        evidence: [{ file: 'goal', snippet: intent.scope }],
      });
    }
  }

  return claims;
}
```

**Key principle (A1):** The Understanding Engine (Layer 2) generates claims. The Verifier (this component) evaluates them using different tools (file system, WorldGraph, oracles). No component evaluates its own output.

### 5.5 Understanding Calibrator (A7)

**File:** `src/orchestrator/understanding-calibrator.ts`
**Dependencies:** SelfModel, TraceStore

After task completion, compare predicted understanding with actual outcome:

```typescript
interface UnderstandingCalibration {
  /** Predicted intent at task start. */
  predictedIntent?: string;
  /** Actual behavior observed (from oracle verdicts + mutations). */
  actualBehavior: string;
  /** Did entity resolution find the right files? */
  entityAccuracy: number;
  /** Did the task actually match the predicted category? */
  categoryMatch: boolean;
}

function calibrateUnderstanding(
  understanding: SemanticTaskUnderstanding,
  trace: ExecutionTrace,
): UnderstandingCalibration {
  // Entity accuracy: fraction of resolved paths that were actually affected
  const resolvedPaths = understanding.resolvedEntities.flatMap(e => e.resolvedPaths);
  const actualFiles = trace.affectedFiles;
  const overlap = resolvedPaths.filter(p => actualFiles.includes(p));
  const entityAccuracy = resolvedPaths.length > 0
    ? overlap.length / resolvedPaths.length
    : 1.0; // No predictions = no error

  // Category match: did mutations happen if we predicted mutation?
  const hadMutations = trace.affectedFiles.length > 0;
  const categoryMatch = understanding.expectsMutation === hadMutations;

  return {
    predictedIntent: understanding.semanticIntent?.primaryAction,
    actualBehavior: trace.outcome,
    entityAccuracy,
    categoryMatch,
  };
}
```

**Signature enrichment — unlocks per-intent learning:**

Current signature: `"fix::ts::small"` (all fix tasks grouped)

Enriched signature: `"fix::ts::small::security-fix"` (separated by intent)

```typescript
function computeEnrichedSignature(input: TaskInput, understanding: SemanticTaskUnderstanding): string {
  const base = computeTaskSignature(input); // existing: "fix::ts::small"
  const intent = understanding.semanticIntent?.primaryAction;
  // Only enrich when:
  // 1. Intent was computed (Layer 2 ran)
  // 2. Intent has enough historical observations (≥10) to avoid signature explosion
  if (intent && selfModel.getParams(`${base}::${intent}`)?.observationCount >= 10) {
    return `${base}::${intent}`;
  }
  return base; // Fall back to base signature if insufficient data
}
```

This avoids **signature explosion**: new intent categories start in the base group and only split off when they have enough observations for reliable learning.

### 5.6 Re-Comprehend on Retry (In-Flight Correction)

If understanding is wrong (e.g., resolved wrong file, misidentified intent), the pipeline generates wrong code, Oracle Gate catches structural errors, and retries. But the current design only corrects understanding **post-task** via calibration (§5.5). There is no **in-flight correction**.

**Mechanism:** When `retryCount ≥ 2` AND oracle failures don't match the predicted understanding profile (e.g., failures are in files not in `resolvedEntities`), trigger a re-comprehend:

```typescript
// In retry branch of core-loop:
if (retryCount >= 2 && !failuresMatchUnderstanding(understanding, oracleVerdicts)) {
  // Re-run Layer 0+1 with additional context: actual error messages
  understanding = await enrichUnderstanding(input, deps, {
    additionalContext: formatOracleFailures(oracleVerdicts),
    forceRefresh: true,  // Skip cached entity resolution
  });
  // Log re-comprehend event for A7 calibration
  trace.recomprehendCount = (trace.recomprehendCount ?? 0) + 1;
}

function failuresMatchUnderstanding(
  understanding: SemanticTaskUnderstanding,
  verdicts: OracleVerdict[],
): boolean {
  const failedFiles = extractFailedFiles(verdicts);
  const resolvedFiles = understanding.resolvedEntities.flatMap(e => e.resolvedPaths);
  // If majority of failures are in files we didn't predict → understanding was wrong
  const overlap = failedFiles.filter(f => resolvedFiles.includes(f));
  return overlap.length >= failedFiles.length * 0.5;
}
```

**Budget constraint:** Re-comprehend costs 0 tokens (Layer 0+1 only). Layer 2 is NOT re-run on retry (too expensive). Max 1 re-comprehend per task.

---

## 6. Integration Points

### 6.1 Core Loop Pipeline Position

Understanding runs early in `executeTask()`, encapsulated as two functions to avoid polluting the core loop:

```typescript
/** Layer 0+1: deterministic, pre-routing. Always runs. Cost: 0 tokens. */
async function enrichUnderstanding(
  input: TaskInput,
  deps: { worldGraph: WorldGraph; selfModel: SelfModel; traceStore: TraceStore; rejectedStore?: RejectedApproachStore },
  opts?: { additionalContext?: string; forceRefresh?: boolean },
): Promise<SemanticTaskUnderstanding> {
  const base = buildTaskUnderstanding(input);             // Layer 0 (existing)
  const entities = resolveEntities(input, deps.worldGraph, opts); // Layer 1
  const profile = profileHistory(input, deps.selfModel, deps.traceStore, deps.rejectedStore);
  return { ...base, resolvedEntities: entities, historicalProfile: profile, understandingDepth: 1, verifiedClaims: [] };
}

/** Layer 2 + verification: LLM, post-routing, budget-gated. Optional. */
async function enrichUnderstandingL2(
  understanding: SemanticTaskUnderstanding,
  deps: { understandingEngine: UnderstandingEngine; worldGraph: WorldGraph; workspace: string },
  budget: { maxTokens: number; timeoutMs: number },
): Promise<SemanticTaskUnderstanding> {
  if (budget.maxTokens < LAYER2_MIN_BUDGET_TOKENS) return understanding; // Skip
  const intent = await deps.understandingEngine.execute(buildUnderstandingRequest(understanding));
  const parsed = parseSemanticIntent(intent.content);
  if (!parsed) return understanding; // Parse failure → degrade gracefully
  parsed.primaryAction = canonicalizePrimaryAction(parsed.primaryAction);
  parsed.confidenceSource = 'llm-self-report'; // HARDCODED — A3
  parsed.tierReliability = 0.4;                // HARDCODED — A5
  const claims = await verifyUnderstandingClaims({ ...understanding, semanticIntent: parsed }, deps.worldGraph, deps.workspace);
  return { ...understanding, semanticIntent: parsed, understandingDepth: 2, verifiedClaims: claims };
}
```

Pipeline position in `executeTask()`:

```
executeTask(input, deps)
  │
  ├── 1. enrichUnderstanding(input, deps)        ← SINGLE ENTRY POINT
  │      └─ Layer 0: buildTaskUnderstanding(input)    ← existing
  │      └─ Domain: classifyTaskDomain()              ← NEW (rule-based, A3-safe)
  │      └─ Layer 1: resolveEntities() + profileHistory()
  │      └─ (Layer 2 deferred to post-routing)
  │
  ├── 2. Risk routing                              ← EXISTING (uses Layer 0-1 claims)
  │      riskRouter.route(input, perception)
  │
  ├── 3. enrichUnderstandingL2(understanding, budget)
  │      └─ Layer 2 semantic (if budget >= LAYER2_MIN)
  │      └─ Verify understanding claims
  │      └─ Verify implicit constraints against codebase
  │
  ├── 4. Perceive / Plan / Generate / Verify       ← EXISTING
  │      (understanding flows through all steps)
  │      Prompt assembly: tools filtered by taskDomain
  │
  ├── 4½. Reasoning Quality Gate                    ← NEW
  │      - Instruction echo detection (≥2 prompt fragments → reject)
  │      - A6 tool stripping (non-mutation domains → filter mutating tools)
  │
  └── 5. calibrateUnderstanding (via EventBus)
         bus.emit('task:complete', {understanding, trace})
```

**Encapsulation rationale:** The core loop (`core-loop.ts`) is the most critical file in the system. Adding 4 separate wiring points (Layer 1, Layer 2, verify, calibrate) directly into it would increase complexity and debugging surface area. Instead:
- `enrichUnderstanding()` handles Layer 0+1 (deterministic, pre-routing)
- `enrichUnderstandingL2()` handles Layer 2 + verification (post-routing, budget-gated)
- Calibration runs as an EventBus listener (`bus/understanding-calibration.ts`), consistent with the existing trace/audit listener pattern
```

**Why Layer 2 is post-routing:** It requires budget awareness (the router determines the budget envelope). It also cannot influence routing (P1/P3), so the ordering is semantically correct.

### 6.2 Prompt Assembly — New Sections

Additions to `PromptSectionRegistry` (`src/orchestrator/llm/prompt-section-registry.ts`):

```typescript
// Priority 22: After [TASK] (20), before [ACCEPTANCE CRITERIA] (25)
registry.register({
  id: 'semantic-context',
  target: 'user',
  cache: 'ephemeral',
  priority: 22,
  render: (ctx) => {
    if (!ctx.understanding?.resolvedEntities?.length && !ctx.understanding?.semanticIntent) {
      return null;
    }
    const lines = ['[SEMANTIC CONTEXT]'];

    // Resolved entities
    for (const entity of ctx.understanding?.resolvedEntities ?? []) {
      lines.push(`  "${entity.reference}" → ${entity.resolvedPaths.join(', ')} (${entity.resolution})`);
    }

    // Historical profile
    const profile = ctx.understanding?.historicalProfile;
    if (profile?.isRecurring) {
      lines.push(`  ⚠ Recurring issue — ${profile.priorAttemptCount} prior attempts`);
      lines.push(`  Common failure oracles: ${profile.commonFailureOracles.join(', ')}`);
    }

    // Semantic intent (Layer 2)
    const intent = ctx.understanding?.semanticIntent;
    if (intent) {
      lines.push(`  Intent: ${intent.primaryAction} — ${intent.scope}`);
      if (intent.implicitConstraints.length > 0) {
        lines.push(`  Implicit constraints: ${intent.implicitConstraints.join('; ')}`);
      }
      if (intent.ambiguities.length > 0) {
        for (const a of intent.ambiguities) {
          lines.push(`  ⚠ Ambiguity: ${a.aspect} — ${a.interpretations.join(' / ')}`);
        }
      }
    }

    // Render implicit constraints with polarity prefix
    if (intent?.implicitConstraints?.length) {
      for (const c of intent.implicitConstraints) {
        const prefix = c.polarity === 'must-not' ? 'MUST NOT:' : 'MUST:';
        lines.push(`  ${prefix} ${c.text}`);
      }
    }

    // Caveat when L0 classification conflicts with L2 semantic intent
    if (intent && ctx.understanding?.actionCategory) {
      const l0Category = ctx.understanding.actionCategory;
      const l2Action = intent.primaryAction;
      const CATEGORY_ACTION_MAP: Record<string, string[]> = {
        mutation: ['add-feature', 'bug-fix', 'security-fix', 'refactor', 'api-migration', 'dependency-update', 'configuration', 'performance-optimization', 'accessibility'],
        analysis: ['documentation'],
        investigation: ['investigation', 'flaky-test-diagnosis'],
        qa: ['test-improvement'],
      };
      const expectedActions = CATEGORY_ACTION_MAP[l0Category] ?? [];
      if (!expectedActions.includes(l2Action) && l2Action !== 'other') {
        lines.push(`  [CAVEAT] Rule-based classification (${l0Category}) differs from semantic analysis (${l2Action}). Prefer the structural classification for safety.`);
      }
    }

    // Behavioral rule for ambiguities: tell the generator what to do with them
    if (intent?.ambiguities?.length) {
      lines.push('');
      lines.push('  INSTRUCTION: Where ambiguities exist, choose the SAFEST interpretation');
      lines.push('  (smallest scope, fewest side effects). If unsafe to proceed, note the');
      lines.push('  ambiguity in a code comment and implement the conservative option.');
    }

    return lines.join('\n');
  },
});
```

**Why behavioral rules matter:** Without them, the generator sees `"⚠ Ambiguity: OAuth2 provider — Auth0 / custom"` but has no guidance on what to do. It may pick the more complex interpretation or ignore the ambiguity entirely. The behavioral rule ensures the generator defaults to the safest option, which the Oracle Gate can then verify — consistent with A6 (zero-trust: propose the conservative option, let governance decide if it's sufficient).

#### Tool Scoping by Domain `[IMPLEMENTED]`

The `reasoning-tools` section in `PromptSectionRegistry` filters available tools based on `taskDomain`:

| Domain | Tools in Prompt | Rationale |
|--------|----------------|-----------|
| `code-mutation` | All tools | Full capability needed for code changes |
| `code-reasoning` | `READONLY_TOOLS` only (`file_read`, `search_grep`, `directory_list`, `git_status`, `git_diff`, `web_search`) | Analysis doesn't need mutation tools — A6 defense-in-depth |
| `general-reasoning` | No tools | Pure reasoning — tools would be noise/risk |
| `conversational` | No tools | Greetings/casual interaction — LLM responds naturally |

This is the **first layer** of tool defense. The core-loop reasoning quality gate provides a **second layer** — stripping any mutating tool calls from non-mutation domains post-generation (defense-in-depth per A6).

### 6.3 SelfModel — Enriched Signatures

`computeTaskSignature` (`src/orchestrator/self-model.ts` line 70) gains an optional enrichment:

```typescript
// Current: "fix::ts::small"
// Enriched: "fix::ts::small::security-fix" (when intent has ≥10 observations)
```

The `calibrate()` method (line 179) receives the enriched signature, automatically creating per-intent learning buckets in the `self_model_params` table without schema changes.

### 6.4 Cross-Task Learning — Intent-Aware

`loadPriorFailedApproaches` (`src/orchestrator/cross-task-loader.ts`) gains an additional filter dimension:

```
Current:  match by (fileTarget, taskType, actionVerb)
Enhanced: match by (fileTarget, taskType, actionVerb, primaryAction)
```

When `primaryAction` mismatches, the confidence downgrade factor increases from 0.7 to 0.4 (same pattern as the existing verb-mismatch logic).

### 6.5 Trace Recording — Understanding Snapshot

The `TraceCollector` records understanding metadata for A7 calibration:

```typescript
// In trace emission (core-loop.ts, learn phase):
trace.understandingDepth = understanding.understandingDepth;
trace.understandingIntent = JSON.stringify(understanding.semanticIntent);
trace.resolvedEntities = JSON.stringify(understanding.resolvedEntities);
trace.understandingVerified = understanding.verifiedClaims.every(c => c.type === 'known') ? 1 : 0;
```

### 6.6 Observability — Bus Events & Metrics

Understanding emits bus events at each layer boundary, consistent with the existing `MetricsCollector` pattern (`src/observability/metrics.ts`):

```typescript
// Bus event types (add to src/core/bus.ts EventMap):
'understanding:layer0_complete': { taskId: string; durationMs: number; verb: string; category: string };
'understanding:layer1_complete': { taskId: string; durationMs: number; entitiesResolved: number; isRecurring: boolean };
'understanding:layer2_complete': { taskId: string; durationMs: number; tokensUsed: number; primaryAction: string };
'understanding:layer2_skipped':  { taskId: string; reason: 'budget' | 'timeout' | 'parse-failure' };
'understanding:verification':    { taskId: string; claimsTotal: number; claimsVerified: number; contradictions: number };
'understanding:recomprehend':    { taskId: string; retryCount: number; reason: string };
'understanding:calibration':     { taskId: string; entityAccuracy: number; categoryMatch: boolean };
```

**MetricsCollector integration:**

```typescript
// In MetricsCollector.attach() — add alongside existing event subscriptions:
bus.on('understanding:layer1_complete', () => this.inc('understanding.layer1'));
bus.on('understanding:layer2_complete', () => this.inc('understanding.layer2'));
bus.on('understanding:layer2_skipped',  () => this.inc('understanding.layer2_skip'));
bus.on('understanding:recomprehend',    () => this.inc('understanding.recomprehend'));
```

**Timing metrics** are emitted per-layer via the bus events (not aggregated in-process) — consistent with existing trace-based observability. The Prometheus exporter (`api/server.ts`) exposes these as `vinyan_understanding_*` gauges.

---

## 7. Axiom Compliance Matrix

| Axiom | Principle | How This Design Satisfies It | Enforcement Mechanism |
|-------|-----------|------------------------------|----------------------|
| **A1** Epistemic Separation | Generation ≠ verification | Understanding Engine (Layer 2) generates claims; Understanding Verifier checks them via oracles. Reasoning quality gate (instruction echo detection) verifies LLM output post-generation. | Separate components, separate files |
| **A2** First-Class Uncertainty | "I don't know" is valid | `type: 'unknown'` on unresolvable entities; ambiguities surfaced, not hidden. Domain classifier identifies `conversational` and `general-reasoning` tasks — all tasks proceed through LLM dispatch (Vinyan is a general-purpose orchestrator per concept §1), with tool access scoped by domain | `VerifiedClaim.type` field; `classifyTaskDomain()` |
| **A3** Deterministic Governance | No LLM in governance | Layer 2 hardcoded as `confidenceSource: 'llm-self-report'` — type system excludes from routing. Domain classification is rule-based (same input → same domain) | Hardcoded after parse; `classifyTaskDomain()` uses regex + verb sets |
| **A4** Content-Addressed Truth | Reproducible understanding | Layer 0-1 are deterministic (same input → same output). Layer 2 is best-effort consistent — not content-addressed. `temperature=0.1` reduces but does not eliminate stochasticity | Deterministic algorithms (L0-1); best-effort + parse fallback (L2) |
| **A5** Tiered Trust | Deterministic > heuristic > probabilistic | Tier 1.0 (regex) > 0.9 (structural) > 0.4 (LLM). Governance boundary at 0.5 | `tierReliability` field per claim |
| **A6** Zero-Trust Execution | Workers propose, orchestrator disposes | Understanding claims are proposals; Verifier and oracle pipeline are disposers. **Defense-in-depth tool scoping**: reasoning tasks see only domain-appropriate tools in prompt AND core-loop strips mutating tool calls post-generation | Verification step; `READONLY_TOOLS` filter in prompt + core-loop |
| **A7** Prediction Error as Learning | Improvement from delta | Post-task calibration: predicted intent vs actual outcome → enriched SelfModel signatures | `UnderstandingCalibrator`, trace snapshot |

---

## 8. Non-Goals

- **No custom NLU model training.** Entity resolution uses deterministic text matching and existing WorldGraph queries. No ML training pipeline.
- **No interactive user disambiguation (Phase A-D).** Ambiguities are surfaced in the prompt as `[UNCERTAINTIES]`. Phase E adds optional user clarification when comprehension confidence < threshold — consistent with concept.md §4 Intent Verification constraint.
- **No new oracle types.** Verification uses existing AST, type, dep, and WorldGraph oracles.
- **No breaking changes to `TaskUnderstanding`.** `SemanticTaskUnderstanding` extends the existing interface. All existing consumers continue to work.
- **No cross-session understanding persistence** (Phase A-D scope). Understanding is per-task. Phase E explores WorldGraph storage for cross-task understanding transfer.
- **No understanding for non-code tasks.** The entity resolver targets code files. Reasoning-only tasks get Layer 0 + Layer 2 (no Layer 1 structural resolution).

---

## 9. Success Criteria

| Criterion | Measurement | Baseline (A0) | Target | Phase |
|-----------|------------|---------------|--------|-------|
| Entity resolution recall | % of actual affected files resolved from goal text | _(measure in A0)_ | ≥ 60% (tasks with ≥3 files) | A |
| Entity resolution precision | % of resolved paths that were actually affected | _(measure in A0)_ | ≥ 70% | A |
| Recurring issue detection | % of re-submitted tasks correctly identified as recurring | _(measure in A0)_ | ≥ 80% | A |
| Zero governance contamination | `llm-self-report` claims never in `RiskRouter` input | N/A (binary) | 100% (type-system enforced) | B |
| Semantic latency budget | Layer 2 engine execution time (p95) | N/A | < 2 seconds | B |
| Layer 2 token budget (input) | Prompt tokens to understanding engine | N/A | < 2000 tokens | B |
| Layer 2 token budget (output) | Completion tokens from understanding engine | N/A | < 500 tokens | B |
| Verification coverage | % of Layer 2 claims with oracle cross-checks | N/A | ≥ 50% | C |
| Calibration improvement | Brier score improvement: enriched vs base signatures (100+ traces) | _(measure in A0)_ | ≥ 5% improvement | D |
| No regression | All existing tests pass (`bun run test`) | 0 failures | 0 new failures | A-E |

---

## 10. Phased Implementation Plan

### Phase A0: Baseline Measurement `[DESIGNED]`

**Scope:** Offline accuracy measurement on existing traces — establishes the "before" for all success criteria.

| Step | File | Description |
|------|------|-------------|
| A0.1 | `scripts/baseline-understanding.ts` | Offline script: run `buildTaskUnderstanding()` on last 100 historical traces, compare `targetFiles` vs `affectedFiles` in trace. Output: entity resolution recall/precision for Layer 0 only |
| A0.2 | `scripts/baseline-understanding.ts` | Measure recurring issue detection: for traces where same `(file, verb)` appeared ≥3 times, did current system flag them? |
| A0.3 | — | Record baseline numbers in this document (update §9 table with "Baseline" column) |

**Success gate:** Baseline numbers recorded. These are the numbers that Phase A-D must improve upon. Without this measurement, success criteria are unmeasurable.

**Estimated effort:** 0.5 days

### Phase A: Layer 1 — Structural Understanding `[DESIGNED]`

**Scope:** Entity resolver + historical profiler. Zero LLM cost.

| Step | File | Description |
|------|------|-------------|
| A1 | `src/orchestrator/entity-resolver.ts` | Implement NL → code path resolution (fuzzy path match, symbol search, dependency inference) |
| A2 | `src/orchestrator/historical-profiler.ts` | Implement SelfModel + trace history integration |
| A3 | `src/orchestrator/types.ts` | Add `SemanticTaskUnderstanding`, `ResolvedEntity`, `HistoricalProfile` types |
| A4 | `src/orchestrator/core-loop.ts` | Wire Layer 1 into pipeline (after Layer 0, before routing) |
| A5 | `tests/orchestrator/entity-resolver.test.ts` | Test: exact match, fuzzy match, symbol resolution, dependency inference |
| A6 | `tests/orchestrator/historical-profiler.test.ts` | Test: recurring detection, failure oracle ranking, empty history |

**Success gate:** Entity resolution tests pass. Historical profiler correctly identifies recurring issues in test traces.

**Estimated effort:** 2-3 days

### Phase B: Layer 2 — Semantic Understanding `[DESIGNED]`

**Scope:** Understanding Engine as ReasoningEngine. Budget-gated. LLM-self-report enforced.

| Step | File | Description |
|------|------|-------------|
| B1 | `src/orchestrator/understanding-engine.ts` | Implement `ReasoningEngine` for structured intent extraction |
| B2 | `src/orchestrator/core-loop.ts` | Wire Layer 2 (post-routing, budget-gated) |
| B3 | `src/orchestrator/llm/prompt-section-registry.ts` | Add `[SEMANTIC CONTEXT]` section (priority 22) |
| B4 | `src/orchestrator/types.ts` | Add `SemanticIntent` type |
| B5 | `tests/orchestrator/understanding-engine.test.ts` | Test: structured output parsing, budget gating, confidenceSource enforcement |

**Success gate:** Understanding engine produces valid `SemanticIntent`. Budget gating correctly skips when insufficient. `confidenceSource` is always `llm-self-report`.

**Estimated effort:** 3-4 days

### Phase C: Understanding Verification `[DESIGNED]`

**Scope:** Oracle cross-checking of understanding claims.

| Step | File | Description |
|------|------|-------------|
| C1 | `src/orchestrator/understanding-verifier.ts` | Implement claim verification via WorldGraph + file system + AST oracle |
| C2 | `src/orchestrator/core-loop.ts` | Wire verification after Layer 2, before prompt assembly |
| C3 | `tests/orchestrator/understanding-verifier.test.ts` | Test: entity existence, symbol verification, contradictory claim detection |

**Success gate:** Verified claims correctly upgrade/downgrade confidence. Contradictions flagged.

**Estimated effort:** 2 days

### Phase D: Calibration Loop `[DESIGNED]`

**Scope:** A7 learning from understanding accuracy.

| Step | File | Description |
|------|------|-------------|
| D1 | `src/db/migrations/011_add_understanding_trace.ts` | Schema migration: understanding columns on `execution_traces` |
| D2 | `src/orchestrator/understanding-calibrator.ts` | Post-task comparison: predicted intent vs actual outcome |
| D3 | `src/orchestrator/self-model.ts` | Extend `computeTaskSignature` with optional intent enrichment |
| D4 | `src/orchestrator/core-loop.ts` | Wire calibration in learn phase |
| D4.5 | `src/orchestrator/understanding-calibrator.ts` | Handle NULL understanding columns for pre-migration traces: all calibration queries must use `WHERE understanding_depth IS NOT NULL` or `COALESCE()`. The offline baseline script (A0) is immune — it computes understanding ad-hoc rather than reading stored values. |
| D5 | `tests/orchestrator/understanding-calibrator.test.ts` | Test: entity accuracy, category match, signature enrichment threshold |

**Success gate:** Traces record understanding snapshots. Calibrator produces meaningful prediction errors. Enriched signatures split only after 10+ observations.

**Estimated effort:** 2 days

### Phase E: Understanding as WorldGraph Facts `[ASPIRATIONAL]`

**Scope:** Persist verified understanding for cross-task transfer.

| Step | File | Description |
|------|------|-------------|
| E1 | `src/world-graph/world-graph.ts` | `storeUnderstandingFact()`: persist verified claims as Facts (A4: content-addressed) |
| E2 | `src/orchestrator/entity-resolver.ts` | Query prior understanding facts to accelerate resolution |
| E3 | `src/orchestrator/core-loop.ts` | Wire fact storage for verified understanding claims |

**Success gate:** Cross-task understanding transfer: a second "fix auth" task resolves entities faster by reading prior understanding facts.

**Estimated effort:** 1-2 days

---

## 11. Risks & Mitigations

| Risk | Severity | Mitigation |
|------|----------|-----------|
| **LLM understanding leaks into governance** | Critical (A3 violation) | `confidenceSource: 'llm-self-report'` hardcoded post-parse, not read from LLM output. Type system enforces exclusion from `RiskRouter`. Automated test verifies no `llm-self-report` claim reaches routing. |
| **Entity resolution false positives pollute perception** | Medium | Resolution confidence threshold (≥ 0.6). Perception expansion gated at ≥ 0.8 — lower-confidence entities are prompt annotations only, never loaded into context (§5.1). Verification step cross-checks with file system. |
| **Layer 2 latency blows task budget** | Medium | Hard timeout (2s). Budget gate (skip if < 2000 tokens remaining). Fast-tier model only. Structured output (≤ 500 tokens). Entire Layer 2 is optional — failure degrades to Layer 0+1. |
| **Signature explosion from intent enrichment** | Medium | Intent enrichment only when per-intent group has ≥ 10 observations. New intents aggregate in base signature until threshold. Prevents sparse data dilution. |
| **Semantic understanding is wrong** | Expected | This is explicitly handled: Layer 2 is `llm-self-report` / tier 0.4. Wrong understanding affects prompt quality (advisory) but never routing or verification (governance). A7 calibration corrects over time. |
| **WorldGraph has no text search** | Architectural | Entity resolver uses caller-side fuzzy matching (glob + tokenization) rather than requiring WorldGraph changes. Phase E may add `LIKE` queries if needed. |
| **Layer 2 LLM provider outage** | Medium | Wrapped with existing circuit breaker pattern (3 failures → open → skip Layer 2). Graceful degradation to Layer 0+1. Registered as `'understanding-engine'` in shared breaker registry. |
| **Layer 2 non-determinism across retries** | Medium | Results cached by `sha256(goal + resolvedEntities + signature)` within task lifecycle. Same task re-entering `enrichUnderstandingL2()` gets cached result unless `forceRefresh`. |

---

## Appendix A: Comparison with Current System

| Dimension | Before (Rule-Based Only) | After (4-Layer) |
|-----------|-------------------------|-----------------|
| Verb extraction | 16-verb `includes()` scan | Same (Layer 0) + fine-grained intent (Layer 2) |
| Entity resolution | Backtick regex + PascalCase regex | + fuzzy path, symbol search, dep inference (Layer 1) |
| Historical context | None | Recurring detection, failure oracle ranking (Layer 1) |
| Implicit constraints | None | LLM-inferred, tagged `llm-self-report` (Layer 2) |
| Ambiguity handling | Silently picks first match | Surfaces alternatives in prompt (Layer 2) |
| Governance safety | Rule-based claims only | Same — LLM claims excluded by type system (P3) |
| Learning granularity | `"fix::ts::small"` (all fix tasks) | `"fix::ts::small::security-fix"` (per-intent, when data sufficient) |
| Cross-task matching | file + type + verb | + intent (Phase D) |
| Calibration | Composite prediction error | + understanding accuracy (entity, category, intent) |
