# Vinyan ENS — Technical Design Document

> **Version**: 3.0 | **Phase**: 0–5 | **Audience**: AI Agent (Copilot/Claude)
>
> **This document owns**: Implementation contracts, interface definitions, schemas, algorithms, test criteria.
> **Concept docs own**: Vision, axioms rationale, theoretical foundations, academic citations.
> **Cross-reference**: [vinyan-concept.md](vinyan-concept.md) §1 (vision), [vinyan-architecture.md](vinyan-architecture.md) §1 (thesis), [vinyan-theory.md](vinyan-theory.md) §3 (theory), [vinyan-implementation-plan.md](vinyan-implementation-plan.md) (phased roadmap).

---

## How to Read This Document

| Symbol | Meaning |
|--------|---------|
| `[Phase 0]` | Fully specified — implement now |
| `[Phase 1]` | Design-level spec — implement after Phase 0 validation |
| `[TBD Phase 2+]` | Placeholder — not yet designed |
| `→ concept §X` | Cross-reference to concept.md section X |
| `→ arch DX` | Cross-reference to architecture.md Decision X |

**Section dependency order**: §1 → §2 (interfaces) → §3 (transport) → §4–§9 (Phase 0 components) → §10–§12 (Phase 1 lifecycle/model) → §12B (Evolution Engine) → §12C (Failure Modes) → §13 (testing) → §14 (project structure) → §15 (open questions) → **§16–§19 (Phase 1 Core Agent spec)** → **§20–§23 (Phase 5 Self-Hosted ENS spec)**

---

## §1. System Overview

> **Architectural thesis**: Vinyan is a **standalone Epistemic Nervous System (ENS)** engine — not a plugin or extension of any host agent. §4–§7 define host-independent core capabilities (reasoning engines, world graph, risk router, guardrails). §8 defines a thin, replaceable **host integration adapter** that connects the engine to a specific host (Claude Code or compatible host in Phase 0). In Phase 1, the Orchestrator (§16) replaces the adapter as the primary entry point, making Vinyan a fully autonomous agent.

### Architecture Diagram

```
┌──────────────────────────────────────────────────────────────────┐
│  Vinyan Orchestrator (rule-based, non-LLM TypeScript/Bun)        │
│                                                                  │
│  Core Loop: Perceive → Predict → Plan → Generate → Verify → Learn│
│                                                                  │
│  ┌───────────────────────────────────────────────────────────┐   │
│  │ Perceive: PerceptualHierarchy + WorkingMemory assembly    │   │
│  │ Predict:  Self-Model forward prediction                   │   │
│  │ Plan:     Task Decomposer (iterative DAG + 5 criteria)    │   │
│  │ Generate: Dispatch to LLM Worker (Generator Engine)       │   │
│  │ Verify:   Oracle Gate (AST, Type, Dep, Test, Lint)        │   │
│  │ Learn:    Trace + PredictionError + WorkingMemory update  │   │
│  └───────────────────────────────────────────────────────────┘   │
│                                                                  │
│  ┌───────────┐  ┌──────────────┐  ┌────────────┐  ┌───────────┐  │
│  │Risk Router│  │ Tool Executor│  │ World Graph│  │ Self-Model│  │
│  │(4-level)  │  │ (file, shell,│  │ (Truth DB) │  │ (predict) │  │
│  │           │  │  search)     │  │            │  │           │  │
│  └───────────┘  └──────────────┘  └────────────┘  └───────────┘  │
└─────────────────────┬────────────────────┬───────────────────────┘
                      │                    │
         ┌────────────▼──────────┐   ┌─────▼───────────────────┐
         │  Execution Layer      │   │ External Interface      │
         │  Worker 1 (LLM Gen.)  │   │ (MCP Bridge, Phase 1B)  │
         │  Worker 2 (LLM Gen.)  │   │ MCP Client + MCP Server │
         │  Shadow Sandbox       │   └─────────────────────────┘
         └────────────┬──────────┘
                      │
         ┌────────────▼──────────┐
         │  LLM Providers        │
         │  Claude │ GPT │ Local │
         └───────────────────────┘

Phase 0 (host bridge — proven, 253 tests):
┌─────────────────────────────────────────────────────────────────┐
│  Host Agent (Claude Code or compatible host)                    │
│  vinyan-oracle-gate hooks: before_tool_call, after_tool_call,   │
│  before_prompt_build, before_model_resolve                      │
│  → Oracles, World Graph, Risk Router, Guardrails                │
└─────────────────────────────────────────────────────────────────┘
```

### Component Inventory

| Component | Package | Phase | Status | Axiom |
|-----------|---------|:-----:|--------|-------|
| Host Adapter (Oracle Gate) | `@vinyan/oracle-gate` | 0 | ✅ Proven | A1, A6 |
| AST Oracle | `@vinyan/oracle` | 0 | ✅ Proven | A1, A5 |
| Type Oracle | `@vinyan/oracle` | 0 | ✅ Proven | A1, A5 |
| Test Oracle | `@vinyan/oracle` | 0 | ✅ Proven | A1, A5 |
| Lint Oracle | `@vinyan/oracle` | 0 | ✅ Proven | A1, A5 |
| Dep Oracle | `@vinyan/oracle` | 0 | ✅ Proven | A1, A4 |
| World Graph | `@vinyan/world-graph` | 0 | ✅ Proven | A4 |
| Risk Router | `@vinyan/oracle-gate` | 0 | ✅ Proven | A3, A6 |
| Guardrails | `@vinyan/oracle-gate` | 0 | ✅ Proven | A6 |
| CLI | `@vinyan/cli` | 0 | ✅ Proven | — |
| **Orchestrator Core Loop** | `@vinyan/orchestrator` | 1 | ✅ Implemented | A3, A6 |
| **LLM Generator Engine** | `@vinyan/orchestrator` | 1 | ✅ Implemented | A1, A2 |
| **Tool Execution Layer** | `@vinyan/orchestrator` | 1 | ✅ Implemented | A6 |
| Self-Model | `@vinyan/self-model` | 1 | ✅ Implemented | A7 |
| MCP External Interface | `@vinyan/mcp-bridge` | 1B | Design (§19) | A2 |
| Evolution Engine | `@vinyan/evolution` | 2–3 | ✅ Implemented | A7 |
| **Fleet Governance** | `@vinyan/orchestrator` | 4 | ✅ Implemented | A3, A6 |
| Critic Engine | `@vinyan/orchestrator` | 1B | Stub (§17.6) | A1 |
| Test Generator | `@vinyan/orchestrator` | 1B | Stub (§17.7) | A1 |

> **Status key**: ✅ Proven = implemented + tested. Spec = TDD section exists, not yet implemented. Design = design-level description only.

### 7 Core Axioms (→ concept §1.1)

| # | Axiom | Principle | TDD Sections |
|---|-------|-----------|-------------|
| A1 | Epistemic Separation | Generation ≠ verification. No engine evaluates its own output. | §4, §8, §17 |
| A2 | First-Class Uncertainty | "I don't know" is a valid protocol state. | §2 (`OracleVerdict.type`), §3, §17, §19 |
| A3 | Deterministic Governance | Orchestrator routing/verification/commit decisions are rule-based and state-reproducible — no LLM in governance path. LLMs used for generation + task decomposition only. | §6, §10, §16 |
| A4 | Content-Addressed Truth | Facts bound to content hash → auto-invalidate on change. | §5 |
| A5 | Tiered Trust | Deterministic > heuristic > probabilistic evidence. | §4 |
| A6 | Zero-Trust Execution | Workers propose; Orchestrator disposes. Zero execution privileges. | §7, §8, §16, §18 |
| A7 | Prediction Error as Learning | Improvement = delta(predicted, actual), not just success/failure. | §12 |

---

## §2. Canonical Interface Registry

> **Single source of truth for all TypeScript interfaces.** Other documents reference this section.
> Organized by layer: L0 (infrastructure) → L3 (cognitive).
> **Phase 0 interfaces** are fully specified for implementation. **Phase 1+ interfaces** are design-level references.

### L0 — Infrastructure Layer `[Phase 0]`

#### World Graph Schema

```typescript
/** Content hash of (target + pattern + evidence) */
interface Fact {
  id: string;
  target: string;           // file path or symbol
  pattern: string;          // what was verified
  evidence: Evidence[];     // file:line references
  oracle_name: string;      // which oracle produced this
  source_file: string;      // path to the source file that was analyzed
  file_hash: string;        // SHA-256 of source at verification time
  verified_at: number;      // Unix timestamp
  session_id?: string;
  confidence: number;       // 1.0 deterministic, <1.0 heuristic
}

interface FileHash {
  path: string;
  current_hash: string;
  updated_at: number;
}

interface Evidence {
  file: string;
  line: number;
  snippet: string;
  contentHash?: string;         // SHA-256 of source file — A4 compliance [Phase 0 optional, Phase 1 required]
}
```

### L1 — Epistemic Protocol Layer `[Phase 0]`

#### HypothesisTuple (→ arch D3)

```typescript
/** Input: written to oracle's stdin as JSON */
interface HypothesisTuple {
  target: string;           // "src/auth/login.ts" or "AuthService.validate"
  pattern: string;          // "function accepts exactly 2 parameters"
  context?: Record<string, unknown>;
  workspace: string;        // absolute path to workspace root
}
```

#### OracleVerdict (→ arch D3)

```typescript
/** Output: read from oracle's stdout as JSON */
interface OracleVerdict {
  verified: boolean;
  type: 'known' | 'unknown' | 'uncertain' | 'contradictory';  // A2: full epistemic state taxonomy
    // 'known'         — deterministic oracle produced definitive result (Phase 0)
    // 'unknown'       — oracle could not determine answer (Phase 0)
    // 'uncertain'     — heuristic/probabilistic result with confidence < 1.0 (Phase 1+)
    // 'contradictory' — produced by conflict resolution when oracles disagree (Phase 1+)
  confidence: number;           // 1.0 for deterministic oracles, <1.0 for heuristic/probabilistic
  evidence: Evidence[];         // provenance chain with optional per-item contentHash
  falsifiable_by?: string[];    // conditions that would invalidate this verdict (→ concept §2.2)
  fileHashes: Record<string, string>;  // path → SHA-256
  reason?: string;              // human-readable when !verified
  errorCode?: 'TIMEOUT' | 'PARSE_ERROR' | 'TYPE_MISMATCH'
    | 'SYMBOL_NOT_FOUND' | 'ORACLE_CRASH';
  oracleName?: string;          // attached by oracle runner (not set by oracle process)
  duration_ms: number;
  qualityScore?: QualityScore;
  // Phase 1+ ECP extensions (→ concept §13)
  deliberation_request?: {      // engine requests more compute budget
    reason: string;
    suggestedBudget: number;    // additional tokens/time requested
  };
  temporal_context?: {          // evidence validity window
    valid_from: number;         // Unix timestamp
    valid_until: number;        // TTL — after this, re-verify
    decay_model: 'linear' | 'step' | 'none';
  };
}
```

> **Phase 0 implementation note:** Phase 0 oracles return `type: 'known'|'unknown'`, `confidence: 1.0`, and omit `falsifiable_by`, `deliberation_request`, `temporal_context`. The Zod schema provides defaults (`type: 'known'`, `confidence: 1.0`) so Phase 0 oracles need not emit these fields explicitly. Phase 1 activates the full type taxonomy when Generator Engines (§17) and Critic Engines are registered.

#### RiskFactors (→ arch D4)

```typescript
interface RiskFactors {
  blastRadius: number;      // files affected (from dep-oracle) — raw count, normalized by calculateRiskScore()
  dependencyDepth: number;  // max depth in import chain — raw count, normalized by calculateRiskScore()
  testCoverage: number;     // 0.0–1.0
  fileVolatility: number;   // git commits in last 30 days — raw count, normalized by calculateRiskScore()
  irreversibility: number;  // 0.0–1.0 (see Irreversibility Scoring Rules in §6)
  hasSecurityImplication: boolean;
  environmentType: 'development' | 'staging' | 'production';
}
```

### L2 — Quality & Execution Layer `[Phase 0–1]`

#### QualityScore (→ arch D10)

```typescript
/** Multi-dimensional quality signal */
interface QualityScore {
  architecturalCompliance: number;  // import depth, circular deps (0.0–1.0)
  efficiency: number;               // tokens/quality achieved (0.0–1.0)
  simplificationGain?: number;      // reduction in cyclomatic complexity (0.0–1.0) [Phase 1]
  testMutationScore?: number;       // % injected faults caught [Phase 1]
  composite: number;                // weighted combination (see §12 computeComposite)
  dimensions_available: number;     // how many dimensions were actually computed (2 in Phase 0)
  phase: 'phase0' | 'phase1' | 'phase2';  // which dimensions are trustworthy
}
```

**Phase-gated dimensions:**

| Dimension | Phase 0 | Phase 1 | Phase 2+ |
|-----------|:-------:|:-------:|:--------:|
| `architecturalCompliance` | ✅ | ✅ | ✅ |
| `efficiency` | ✅ | ✅ | ✅ |
| `simplificationGain` | — | ✅ | ✅ |
| `testMutationScore` | — | ✅ | ✅ |

> **Note**: `computeComposite()` in §12 determines weighting based on which dimensions are present (undefined = Phase 0, all present = Phase 1+). The computation logic owns phase awareness, not the data interface.

> **Phase 0 collection responsibility**: The oracle pipeline MUST populate `architecturalCompliance` (from dep-oracle blast radius + ast-oracle structural checks) and `efficiency` (tokens consumed / verification passes) on every `OracleVerdict.qualityScore`. This data seeds Phase 1 Self-Model calibration — without it, Phase 1 cold-starts with zero signal. Phase 0 computation: `composite = (architecturalCompliance * 0.6) + (efficiency * 0.4)`.

#### ExecutionTrace (→ arch D6) `[Phase 1–4]`

```typescript
/** Recorded after each task for Self-Model calibration and Evolution Engine.
 *  Source of truth: src/orchestrator/types.ts — this is the canonical definition.
 *  See §12B for Evolution Engine usage context. */
interface ExecutionTrace {
  id: string;
  taskId: string;
  session_id?: string;                       // Session grouping for multi-step tasks
  worker_id?: string;                        // Which worker executed this step
  timestamp: number;
  routingLevel: RoutingLevel;
  action?: string;                           // Specific action taken (e.g., 'file_write', 'refactor')
  approach: string;                          // Brief description of the approach
  approach_description?: string;             // Detailed explanation for Evolution Engine
  risk_score?: number;                       // Risk score at time of execution
  task_type_signature?: string;              // [Phase 2] Sleep Cycle grouping key
  oracleVerdicts: Record<string, boolean>;   // oracle_name → pass/fail
  qualityScore?: QualityScore;
  prediction?: SelfModelPrediction;
  predictionError?: PredictionError;         // [Phase 1] Full prediction error (A7)
  success_pattern_tag?: string;              // Tag for pattern extraction
  model_used: string;
  tokens_consumed: number;
  duration_ms: number;
  outcome: 'success' | 'failure' | 'timeout' | 'escalated';
  failure_reason?: string;
  affected_files: string[];
  shadow_validation?: ShadowValidationResult;  // [Phase 2] async, post-commit
  validation_depth?: 'structural' | 'structural_and_tests' | 'full_shadow';
  exploration?: boolean;                     // [Phase 3] epsilon-greedy exploration flag
  framework_markers?: string[];              // [Phase 4] detected frameworks
  workerSelectionAudit?: WorkerSelectionResult; // [Phase 4] worker selection audit trail
}
```

#### EvolutionaryRule (→ arch D6) `[Phase 2+]`

```typescript
/** Evolution Engine output — pattern-mined rules [Phase 2+] */
interface EvolutionaryRule {
  id: string;
  source: 'sleep-cycle' | 'manual';
  condition: {
    file_pattern?: string;
    oracle_name?: string;
    risk_above?: number;
    model_pattern?: string;
  };
  action: 'escalate' | 'require-oracle' | 'prefer-model' | 'adjust-threshold' | 'assign-worker';  // [Phase 4] assign-worker for fleet routing
  parameters: Record<string, unknown>;
  status: 'probation' | 'active' | 'retired';
  created_at: number;
  effectiveness: number;
  specificity: number;          // computed: count of non-null condition fields
  superseded_by?: string;       // rule ID that replaced this one via conflict resolution
}
```

### L3 — Cognitive Layer `[Phase 1]`

#### PerceptualHierarchy (→ arch D8)

```typescript
/** Replaces flat StateVector — structured perception per routing level */
interface PerceptualHierarchy {
  taskTarget: {
    file: string;
    symbol?: string;
    description: string;
  };
  dependencyCone: {
    directImporters: string[];
    directImportees: string[];
    transitiveBlastRadius: number;
    transitiveImporters?: string[];     // Level 2–3 only
    affectedTestFiles?: string[];       // Level 2–3 only
  };
  diagnostics: {
    lintWarnings: Array<{ file: string; line: number; message: string }>;
    typeErrors: Array<{ file: string; line: number; message: string }>;
    failingTests: string[];
  };
  verifiedFacts: Array<{
    target: string;
    pattern: string;
    verified_at: number;
    hash: string;
  }>;
  runtime: {
    nodeVersion: string;
    os: string;
    availableTools: string[];
  };
}
```

#### WorkingMemoryState (→ arch D8)

```typescript
/** Orchestrator-maintained — 4 components */
interface WorkingMemoryState {
  failedApproaches: Array<{
    approach: string;
    oracleVerdict: string;      // which oracle rejected + evidence
    timestamp: number;
  }>;
  activeHypotheses: Array<{
    hypothesis: string;
    confidence: number;         // Self-Model predicted success probability
    source: string;             // which Reasoning Engine proposed this
  }>;
  unresolvedUncertainties: Array<{
    area: string;
    selfModelConfidence: number;
    suggestedAction: string;
  }>;
  scopedFacts: Array<{
    target: string;
    pattern: string;
    verified: boolean;
    hash: string;
  }>;
}
```

#### SelfModelPrediction (→ arch D11)

```typescript
interface SelfModelPrediction {
  taskId: string;
  timestamp: number;
  expectedTestResults: 'pass' | 'fail' | 'partial';
  expectedBlastRadius: number;
  expectedDuration: number;
  expectedQualityScore: number;
  uncertainAreas: string[];
  confidence: number;           // prediction confidence (0.0–1.0)
  metaConfidence: number;       // confidence-in-prediction based on sample size (→ concept §9.2)
    // With < 10 observations for this task pattern, forced to < 0.3 → triggers conservative fallback
  basis: 'static-heuristic' | 'trace-calibrated' | 'hybrid';
  calibrationDataPoints: number;
}
```

#### PredictionError (→ arch D11)

```typescript
/** A7: Primary learning signal — delta(predicted, actual) */
interface PredictionError {
  taskId: string;
  predicted: SelfModelPrediction;
  actual: {
    testResults: 'pass' | 'fail' | 'partial';
    blastRadius: number;
    duration: number;
    qualityScore: number;
  };
  error: {
    testResultMatch: boolean;
    blastRadiusDelta: number;
    durationDelta: number;
    qualityScoreDelta: number;
    composite: number;
  };
}
```

#### DagValidationCriteria (→ arch D7) `[Phase 1]`

```typescript
/** 5 machine-checkable criteria for task decomposition */
interface DagValidationCriteria {
  no_orphans: boolean;              // no disconnected nodes in the task DAG
  no_scope_overlap: boolean;        // subtask file sets don't intersect
  coverage: boolean;                // union(subtask targets) ⊇ blast radius
  valid_dependency_order: boolean;  // topological sort succeeds
  verification_specified: boolean;  // every leaf has oracle(s) assigned
}
```

#### RoutingConfig (→ arch D4, Config §5) `[Phase 0]`

```typescript
/** 4-level routing thresholds — stored in vinyan.json */
interface RoutingConfig {
  l0_max_risk: number;    // ≤ this → Level 0 (Reflex), default 0.2
  l1_max_risk: number;    // ≤ this → Level 1 (Heuristic), default 0.4
  l2_max_risk: number;    // ≤ this → Level 2 (Analytical), default 0.7
  // > l2_max_risk → Level 3 (Deliberative)
  l0_l1_model: string;    // fast model for L0–L1
  l2_model: string;       // balanced model for L2
  l3_model: string;       // powerful model for L3
  l1_budget_tokens: number;
  l2_budget_tokens: number;
  l3_budget_tokens: number;
  latency_budgets_ms: {   // design constraints, not aspirations (→ concept §7)
    l0: number;           // default 100ms
    l1: number;           // default 2000ms
    l2: number;           // default 10000ms
    l3: number;           // default 60000ms
  };
}
```

#### RoutingDecision (→ arch D4) `[Phase 0]`

```typescript
interface RoutingDecision {
  level: 0 | 1 | 2 | 3;
  model: string | null;       // null for L0 (cached/skip)
  budgetTokens: number;
  latencyBudget_ms: number;
  mandatoryOracles?: string[];       // [Phase 2] require-oracle rules add entries here
  riskThresholdOverride?: number;    // [Phase 2] adjust-threshold rules set this
  riskScore?: number;                // Computed risk score (0.0–1.0)
  workerId?: string;                 // [Phase 4] selected worker profile ID
}
```

#### ECPEvidence (→ concept §3.4, arch D13) `[Phase 1]`

```typescript
/** Tool results wrapped as ECP evidence before entering World Graph */
interface ECPEvidence {
  source: string;               // tool or MCP server that produced this
  type: 'known' | 'uncertain';  // tool results are 'known' (deterministic) or 'uncertain' (MCP)
  confidence: number;           // 1.0 for built-in tools, 0.5 default for MCP tools
  data: unknown;                // raw tool output
  timestamp: number;
  contentHash?: string;         // SHA-256 of data for A4 compliance
  provenance: {
    file?: string;
    tool: string;
    workspace: string;
  };
}
```

#### PlannerInterface (→ concept §8, arch D7) `[Phase 1]`

```typescript
/**
 * Task decomposition is LLM-assisted, not deterministic (→ concept §8).
 * The Planner uses an LLM Generator Engine to propose DAGs;
 * the Orchestrator validates through Oracles and rule-based criteria.
 * LLMs generate candidate decompositions; the Orchestrator validates and commits them.
 */
interface PlannerInterface {
  /** Generate a candidate task DAG using LLM Generator Engine (§17) */
  generatePlan(task: TaskInput, context: PerceptualHierarchy): Promise<TaskDAG>;
  /** Validate DAG against 5 machine-checkable criteria (rule-based, not LLM) */
  validatePlan(dag: TaskDAG): DagValidationCriteria;
}

interface TaskDAG {
  nodes: Array<{
    id: string;
    description: string;
    targetFiles: string[];
    dependencies: string[];   // IDs of nodes this depends on
    assignedOracles: string[]; // which oracle(s) validate output
  }>;
}
```

---

## §3. Epistemic Communication Protocol (ECP)

> → concept §2 | → arch D3

ECP is more than a transport layer — it defines the **epistemic semantics** that make Vinyan an ENS rather than a generic tool runner. Every message flowing through ECP carries meaning about the system's knowledge state. ECP is a **semantic extension** of JSON-RPC that adds epistemic state as first-class data — not a fundamentally different wire protocol (→ concept §2.3 for the full ECP vs MCP capability comparison).

**Three ECP channels** (→ concept §2.1):

| Channel | Parties | Purpose | Transport |
|:--------|:--------|:--------|:----------|
| **Epistemic Query** | Orchestrator ↔ Reasoning Engines | Hypothesis verification, confidence calibration | ECP (internal) |
| **Delegation** | Orchestrator ↔ Workers | Task assignment with trust contracts, isolation budgets | ECP (internal) |
| **External Interface** | Vinyan ↔ Host / Other Agents | Tool access via MCP, inter-agent via A2A | MCP / A2A |

| Semantic Layer | What It Defines | Phase |
|----------------|----------------|:-----:|
| **Epistemic State** | `type` (known/unknown), `confidence`, `evidence` chain, `falsifiability` criteria | 0–1 |
| **Protocol Envelope** | `protocolVersion`, request/response schemas, error codes | 0 |
| **Transport** | stdin/stdout JSON (Phase 0), JSON-RPC (Phase 1+) | 0 |

Phase 0 implements the Protocol Envelope and Transport layers. The full Epistemic State layer is progressively activated in Phase 1 (→ §17, §19).

### Phase 0: Plain JSON over stdio `[Phase 0]`

**Transport**: One JSON object per line on stdin/stdout. Newline-delimited. No framing protocol — each oracle process receives exactly one request on stdin and writes exactly one response on stdout.

> **Why not JSON-RPC?** Phase 0 oracles are child processes with 1:1 request/response — no multiplexing, no service discovery, no batch requests. JSON-RPC adds overhead without benefit. Consider upgrading to JSON-RPC in Phase 1 if remote transport or multiplexing is needed.

#### Request Format (stdin → oracle)

```json
{
  "target": "src/auth/login.ts",
  "pattern": "function accepts exactly 2 parameters",
  "workspace": "/home/dev/project"
}
```

#### Response Format (oracle → stdout)

```json
{
  "verified": true,
  "type": "known",
  "confidence": 1.0,
  "evidence": [
    { "file": "src/auth/login.ts", "line": 42, "snippet": "export function login(username: string, password: string)" }
  ],
  "fileHashes": { "src/auth/login.ts": "a1b2c3..." },
  "duration_ms": 125
}
```

> **Note:** `type` and `confidence` have Zod defaults (`"known"` and `1.0`), so Phase 0 deterministic oracles may omit them. The runner normalizes all output through `OracleVerdictSchema.parse()` which applies defaults.

#### Error / Timeout Response

When an oracle encounters an unrecoverable error or is killed by timeout, the **oracle runner** (not the oracle itself) produces a synthetic verdict:

```json
{
  "verified": false,
  "type": "unknown",
  "evidence": [],
  "fileHashes": {},
  "reason": "Oracle timeout exceeded (30000ms)",
  "errorCode": "TIMEOUT",
  "duration_ms": 30000
}
```

#### Malformed Output Handling

If oracle stdout is not valid JSON or doesn't match `OracleVerdict` schema:
- Oracle runner treats it as `verified: false` with reason `"malformed oracle output"`
- Raw stdout is logged for debugging (truncated to 4KB)
```

#### Epistemic Response Types

**Phase 0** — Oracles produce binary `verified: boolean` verdicts. Classification is derived at the runner level:

| Type | Criteria (Phase 0) | Example |
|------|---------------------|----------|
| `known` | `verified: true` — deterministic pass | ast-oracle confirms function exists |
| `unknown` | Oracle cannot run (missing parser, binary file) | dep-oracle can't parse binary file |
| `contradictory` | Multiple oracles disagree on same hypothesis `[Phase 1+]` | type-oracle pass + test-oracle fail |

**Phase 1+** adds `uncertain` (probabilistic confidence 0.5–0.95) and `contradictory` (oracle conflict resolution) types. No Phase 0 mechanism produces `contradictory` — it requires the multi-oracle conflict resolution pipeline (§5 Conflict Resolution).

#### Timeout Semantics

| Scope | Default | Configurable | Phase |
|-------|---------|:------------:|:-----:|
| Per-oracle | 30s | `vinyan.json` → `oracles.*.timeout_ms` | 0 |
| Worker process L1 | 60s | `vinyan.json` → `isolation.l1_timeout_ms` | 1 |
| Worker process L2 | 300s | `vinyan.json` → `isolation.l2_timeout_ms` | 2 |
| Token budget L1 | 10K tokens | `routing.l1_budget_tokens` | 0 |
| Token budget L2 | 50K tokens | `routing.l2_budget_tokens` | 0 |
| Token budget L3 | 100K tokens | `routing.l3_budget_tokens` | 0 |

### Phase 1: Remote Transport + JSON-RPC `[TBD Phase 1]`

Candidates: JSON-RPC 2.0 over HTTP/SSE, gRPC, WebSocket. JSON-RPC adds value when multiplexing multiple oracle requests over a single transport or running oracles as remote services. Decision deferred until Phase 0 performance data available.

---

## §4. Reasoning Engine Framework — Oracles (`@vinyan/oracle`)

> → arch D3 | Axioms: A1 (separation), A5 (tiered trust)

Vinyan's Reasoning Engines are the epistemic core — they produce **evidence-based verdicts** about code artifacts. The concept (→ concept §3) defines four engine roles; Phase 0 focuses on the Verifier role.

| Role | Purpose | Phase | TDD Section |
|------|---------|:-----:|------------|
| **Verifier** | Validate claims against artifacts (AST, types, deps) | 0 | §4 (this section) |
| **Predictor** | Forecast outcomes before execution (blast radius, risk) | 1 | §12, §16 |
| **Generator** | Produce code/artifacts under epistemic constraints | 1 | §17 |
| **Critic** | Evaluate quality beyond pass/fail (style, efficiency) | 1 | §16 |

> **Phase 0 scope**: All oracles in this section are **Verifier-class** engines. They answer "is this claim true?" with deterministic evidence. Multi-role engines are specified in §16–§17.

### Oracle Lifecycle

```
Register (startup)
    ↓
Receive HypothesisTuple (stdin JSON)
    ↓
Execute verification (read actual code artifacts)
    ↓
Return OracleVerdict (stdout JSON)
    ↓
Timeout? → return verified:false (fail-closed, A6) → Oracle Gate blocks
```

### Oracle Registration `[Phase 0]`

```typescript
interface OracleConfig {
  name: string;              // unique identifier: "ast", "type", "test", "lint", "dep"
  command: string;           // executable path or shell command
  languages: string[];       // supported: ["typescript", "python"]
  timeout_ms: number;        // per-invocation timeout (default: 30000)
  timeout_behavior: 'block' | 'warn';  // fail-closed (default) or fail-open per oracle
  tier: 'deterministic' | 'heuristic' | 'probabilistic' | 'speculative';  // 4-tier registry (→ concept §3.1, A5)
    // deterministic: compiler, type checker, tests — confidence ≥ 0.95
    // heuristic:     complexity metrics, lint rules — confidence 0.5–0.95
    // probabilistic: LLM reasoning, statistical models — confidence 0.1–0.9 [Phase 1+]
    // speculative:   creative generators, counterfactual — confidence < 0.5 [Phase 2+]
  role?: 'verifier' | 'predictor' | 'generator' | 'critic';  // Reasoning Engine role (→ concept §3) [Phase 1+]
  enabled: boolean;
}

// Loaded from vinyan.json at startup
interface VinyanConfig {
  version: number;
  oracles: Record<string, OracleConfig>;
  routing: RoutingConfig;
  isolation: IsolationConfig;
  escalation: EscalationConfig;
}
```

### 5 Built-in Oracles `[Phase 0]`

#### 1. AST Oracle (`ast-oracle`)

| Field | Value |
|-------|-------|
| **Input** | `HypothesisTuple` with target file + pattern (symbol existence, signature) |
| **Output** | `OracleVerdict` with `evidenceStrength: 'deterministic'` |
| **Tool** | tree-sitter (multi-language AST parsing) |
| **Verifies** | Symbol existence, function signatures, import relationships, class structure |
| **Timeout** | 5s (AST is fast) |
| **Phase** | 0 |

**Implementation notes:**
- Parse target file with tree-sitter
- Walk AST to verify pattern claim
- Return evidence with exact file:line of matching/non-matching node
- Does NOT execute code — pure static analysis

#### 2. Type Oracle (`type-oracle`)

| Field | Value |
|-------|-------|
| **Input** | `HypothesisTuple` with workspace path |
| **Output** | `OracleVerdict` with type errors as counter-evidence |
| **Tool** | `tsc --noEmit` (TypeScript) / `pyright` (Python) |
| **Verifies** | Type correctness of proposed changes |
| **Timeout** | 30s (full project type-check can be slow) |
| **Phase** | 0 |

**Implementation notes:**
- Run type-checker on workspace
- Parse stdout for errors in affected files
- `verified: true` only when zero type errors in blast radius
- Returns error locations as `counterEvidence`

#### 3. Test Oracle (`test-oracle`)

| Field | Value |
|-------|-------|
| **Input** | `HypothesisTuple` with affected test files |
| **Output** | `OracleVerdict` with test pass/fail results |
| **Tool** | `bun test` / `vitest` (TypeScript) / `pytest` (Python) |
| **Verifies** | Tests pass for affected code paths |
| **Timeout** | 30s (configurable per project) |
| **Phase** | 0 |

**Implementation notes:**
- Run only tests in `affectedTestFiles` (from dep-oracle), not full suite
- Parse exit code + stdout for pass/fail count
- `verified: true` when all affected tests pass
- Returns failing test names + error messages as evidence

**Stdout parsing (Phase 0):**
```typescript
// Exit code is primary signal:
//   0 → all pass, non-zero → failures
// For evidence extraction, parse runner-specific output:
//   bun test:  "✗ test name" lines + summary "X pass, Y fail"
//   vitest:    JSON reporter (--reporter=json) → { testResults: [{ name, status }] }
//   pytest:    JSON plugin (--json-report) → { tests: [{ nodeid, outcome }] }
interface TestOracleEvidence {
  totalTests: number;
  passed: number;
  failed: number;
  failedTests: Array<{ name: string; error: string }>;
}
```

#### 4. Lint Oracle (`lint-oracle`)

| Field | Value |
|-------|-------|
| **Input** | `HypothesisTuple` with affected files |
| **Output** | `OracleVerdict` with lint violations |
| **Tool** | ESLint (TypeScript) / Ruff (Python) |
| **Verifies** | Code style + lint rule compliance |
| **Timeout** | 10s |
| **Phase** | 0 |

**Implementation notes:**
- Run linter on affected files only
- Parse JSON output for violations
- `verified: true` when zero violations (or only warnings below threshold)
- Distinguishes errors vs warnings — errors block, warnings inform

**Stdout parsing (Phase 0):**
```typescript
// ESLint: run with --format=json → Array<{ filePath, messages: [{ ruleId, severity, message, line }] }>
//   severity 2 = error (blocks), severity 1 = warning (info only)
// Ruff:   run with --output-format=json → Array<{ filename, code, message, location: { row } }>
interface LintOracleEvidence {
  totalViolations: number;
  errors: number;    // blocks
  warnings: number;  // info only
  violations: Array<{ file: string; line: number; rule: string; message: string; severity: 'error' | 'warning' }>;
}
```

#### 5. Dep Oracle (`dep-oracle`)

| Field | Value |
|-------|-------|
| **Input** | `HypothesisTuple` with target file |
| **Output** | `OracleVerdict` + blast radius data |
| **Tool** | tree-sitter import graph traversal |
| **Verifies** | Dependency relationships, blast radius computation |
| **Timeout** | 10s |
| **Phase** | 0 |

**Blast radius algorithm:**

```typescript
function computeBlastRadius(
  targetFile: string,
  importGraph: Map<string, string[]>  // file → files it imports
): BlastRadiusResult {
  const reverseGraph = buildReverseGraph(importGraph);  // file → files that import it
  const visited = new Set<string>();
  const queue: string[] = [targetFile];
  const affectedFiles: string[] = [];

  // BFS from target through reverse import graph
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (visited.has(current)) continue;
    visited.add(current);
    affectedFiles.push(current);

    const importers = reverseGraph.get(current) ?? [];
    for (const importer of importers) {
      if (!visited.has(importer)) {
        queue.push(importer);
      }
    }
  }

  // Find affected test files
  const testFiles = affectedFiles.filter(f =>
    f.includes('.test.') || f.includes('.spec.') || f.includes('__tests__')
  );

  return {
    blastRadius: affectedFiles.length,
    transitiveImporters: affectedFiles.filter(f => f !== targetFile),
    affectedTestFiles: testFiles,
    dependencyDepth: computeMaxDepth(targetFile, reverseGraph),
  };
}

interface BlastRadiusResult {
  blastRadius: number;
  transitiveImporters: string[];
  affectedTestFiles: string[];
  dependencyDepth: number;
}
```

### Oracle Conflict Resolution `[Phase 0]`

**Phase 0 rule**: Any oracle fail = block. Conservative — prevents false negatives.

```typescript
function resolveConflicts(verdicts: OracleVerdict[]): ConflictResolution {
  // Phase 0: strict any-fail
  const failures = verdicts.filter(v => !v.verified);
  if (failures.length > 0) {
    return {
      decision: 'block',
      reason: formatOracleFailures(failures),
      verdicts,
    };
  }
  return { decision: 'allow', verdicts };
}
```

**Timeout semantics**: Oracle timeout defaults to **fail-closed** (block) per A6 (zero-trust). A timed-out oracle returns `verified: false` with reason `"timeout"`. This is configurable per-oracle via `timeout_behavior: 'warn'` in `vinyan.json` for oracles where blocking on timeout hurts developer experience (e.g., slow `tsc --noEmit` on large projects). When set to `'warn'`, the timed-out oracle is excluded from conflict resolution (treated as absent).

**False positive tracking** `[Phase 0]`: The gate logger records every `decision: 'block'` verdict in the session JSONL log. To support Phase 1 weighted conflict resolution design, the log entry includes a `blocked_verdicts` array (which oracles blocked) and a `mutation_hash` (content hash of the proposed change). When a developer manually applies a blocked change and it succeeds (detectable via subsequent `after_tool_call` success on same target), the session analyzer flags it as a **false positive candidate** for offline review. Target: collect ≥50 FP candidates before Phase 1 conflict resolution design.

**Phase 1: 5-Step Deterministic Contradiction Resolution** (→ concept §3.2) `[Phase 1]`:

Replaces "any-fail = block" with a structured decision tree:

1. **Domain separation** — if oracles verify different domains (e.g., type-oracle vs lint-oracle), no contradiction exists; both results stand
2. **Confidence comparison** — higher-tier oracle wins (deterministic > heuristic > probabilistic, per A5)
3. **Evidence weight** — if same tier, oracle with more evidence items (provenance chain length) wins
4. **Historical accuracy** — if still tied, oracle with higher historical accuracy (tracked by Evolution Engine) wins
5. **Escalation** — if unresolvable, produce `type: 'contradictory'` verdict and escalate to human

Implementation contract: `resolveConflicts()` must produce a deterministic result for the same input verdicts (A3). The decision tree is rule-based — no LLM is involved in conflict resolution.

### Oracle Circuit Breaker `[Phase 0]`

An oracle that crashes or times out repeatedly should not drain latency on every subsequent call. The oracle runner tracks consecutive failures per oracle and temporarily disables broken oracles.

```typescript
interface OracleCircuitBreaker {
  failureCount: number;       // consecutive failures (reset on success)
  lastFailureAt: number;      // Unix ms timestamp
  state: 'closed' | 'open' | 'half-open';
}

// Defaults (configurable per-oracle in vinyan.json)
const CIRCUIT_BREAKER_DEFAULTS = {
  failureThreshold: 3,        // consecutive failures to trip open
  resetTimeout_ms: 60_000,    // how long to stay open before half-open
};
```

**State transitions:**

| From | Event | To | Behavior |
|------|-------|----|---------|
| `closed` | oracle success | `closed` | Reset `failureCount = 0` |
| `closed` | oracle fail/timeout | `closed` or `open` | `failureCount++`; if ≥ threshold → `open` |
| `open` | `resetTimeout_ms` elapsed | `half-open` | Allow 1 probe request |
| `half-open` | probe success | `closed` | Reset circuit |
| `half-open` | probe fail | `open` | Restart timer |

When circuit is `open`, the oracle runner **skips** the oracle and logs a `circuit_open` event. The oracle is excluded from conflict resolution (same as `timeout_behavior: 'warn'`). This prevents a single broken oracle from degrading every gate check.

> **Phase 1 extension:** This section covers Verifier-class engines. Phase 1 extends the framework to multi-role Reasoning Engines — Predictor (§12, §16), Generator (§17), and Critic (§16). The `OracleConfig` interface gains a `role` field and role-specific configuration.

---

## §5. World Graph (`@vinyan/world-graph`)

> → arch D2 | Axiom: A4 (content-addressed truth)

### SQLite DDL `[Phase 0]`

```sql
-- Enable WAL mode for read concurrency (workers get read-only handle)
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- Schema versioning
CREATE TABLE schema_version (
  version   INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL DEFAULT (datetime('now'))
);
INSERT INTO schema_version (version) VALUES (1);

-- Verified facts (A4: bound to content hash)
CREATE TABLE facts (
  id          TEXT PRIMARY KEY,    -- SHA-256 of (target || pattern || evidence_json)
  target      TEXT NOT NULL,       -- file path or symbol
  pattern     TEXT NOT NULL,       -- what was verified
  evidence    TEXT NOT NULL,       -- JSON array of Evidence[]
  oracle_name TEXT NOT NULL,
  source_file TEXT NOT NULL,       -- path to the source file that was analyzed
  file_hash   TEXT NOT NULL,       -- SHA-256 of source file at verification time
  verified_at INTEGER NOT NULL,    -- Unix ms timestamp
  session_id  TEXT,
  confidence  REAL NOT NULL DEFAULT 1.0
);

CREATE INDEX idx_facts_target ON facts(target);
CREATE INDEX idx_facts_source_file ON facts(source_file);
CREATE INDEX idx_facts_file_hash ON facts(file_hash);
CREATE INDEX idx_facts_session ON facts(session_id);

-- Denormalized evidence file references (for fast cascade invalidation)
-- Populated on INSERT into facts — one row per unique file in evidence[]
CREATE TABLE fact_evidence_files (
  fact_id   TEXT NOT NULL REFERENCES facts(id) ON DELETE CASCADE,
  file_path TEXT NOT NULL
);
CREATE INDEX idx_fef_file_path ON fact_evidence_files(file_path);

-- File hash tracking (for cascade invalidation)
CREATE TABLE file_hashes (
  path         TEXT PRIMARY KEY,
  current_hash TEXT NOT NULL,
  updated_at   INTEGER NOT NULL
);

-- Execution traces — defer to Phase 1 (no Orchestrator in Phase 0 to populate)
-- Schema will be added via migration when Orchestrator is implemented.
-- See §10 for ExecutionTrace interface and §11 for Orchestrator architecture.
```

### Cascade Invalidation Algorithm `[Phase 0]`

```typescript
/**
 * A4: When source file changes, all facts verified against old hash become invalid.
 * Triggered by chokidar file watcher detecting modification.
 */
async function onFileChanged(filePath: string, newHash: string): Promise<void> {
  const db = getDatabase();

  db.transaction(() => {
    // 1. Update file hash
    db.prepare(`
      INSERT INTO file_hashes (path, current_hash, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(path) DO UPDATE SET
        current_hash = excluded.current_hash,
        updated_at = excluded.updated_at
    `).run(filePath, newHash, Date.now());

    // 2. Delete facts whose source_file is this file and hash is stale
    //    (covers both file-path targets AND symbol targets from this file)
    db.prepare(`
      DELETE FROM facts
      WHERE source_file = ? AND file_hash != ?
    `).run(filePath, newHash);

    // 3. Invalidate facts that referenced this file in their evidence
    //    Uses denormalized fact_evidence_files for indexed lookups (no LIKE scan)
    db.prepare(`
      DELETE FROM facts WHERE id IN (
        SELECT fact_id FROM fact_evidence_files
        WHERE file_path = ?
      ) AND source_file != ?
    `).run(filePath, filePath);
  })();
}
```

**Bounded Propagation Depth `[Phase 1+]`**

Phase 0 invalidation is single-hop: a file change invalidates facts that directly reference it. Multi-file scalability (concept §6) requires bounded cascading through the dependency graph:

```typescript
/**
 * Phase 1+: Cascade invalidation with configurable depth bound.
 * Prevents infinite loops in circular dependency graphs (A4 + concept §6).
 *
 * @param maxDepth - Maximum propagation hops (default: 3, configurable via vinyan.json)
 */
async function cascadeInvalidation(
  filePath: string,
  newHash: string,
  maxDepth: number = 3,
): Promise<{ invalidatedCount: number; depth: number }> {
  const db = getDatabase();
  let totalInvalidated = 0;
  const visited = new Set<string>();

  db.transaction(() => {
    // Update the changed file's hash
    upsertFileHash(db, filePath, newHash);

    // BFS through dependency graph with depth bound
    let frontier = [filePath];
    let currentDepth = 0;

    while (frontier.length > 0 && currentDepth < maxDepth) {
      const nextFrontier: string[] = [];

      for (const file of frontier) {
        if (visited.has(file)) continue;
        visited.add(file);

        // Invalidate facts referencing this file with stale hashes
        const deleted = invalidateFactsForFile(db, file);
        totalInvalidated += deleted;

        // Find downstream dependents (files whose facts reference this file)
        const dependents = db.prepare(`
          SELECT DISTINCT f.source_file FROM facts f
          JOIN fact_evidence_files fef ON f.id = fef.fact_id
          WHERE fef.file_path = ? AND f.source_file != ?
        `).all(file, file) as { source_file: string }[];

        for (const dep of dependents) {
          if (!visited.has(dep.source_file)) {
            nextFrontier.push(dep.source_file);
          }
        }
      }

      frontier = nextFrontier;
      currentDepth++;
    }
  })();

  return { invalidatedCount: totalInvalidated, depth: Math.min(visited.size, maxDepth) };
}
```

> **Design rationale:** The 3-hop default bounds worst-case invalidation to O(degree³) rather than O(|V|) for the full graph. Projects with deep dependency chains can increase the limit, but circular dependencies (common in large TS codebases) are inherently safe due to the `visited` set. Lazy invalidation (concept §6a) is achieved by only recomputing hashes for files in the active dependency cone — files outside the cone are untouched.

### `onFileDeleted()` — File Deletion Handler `[Phase 0]`

```typescript
/**
 * When a file is deleted, invalidate ALL facts about it or referencing it.
 */
async function onFileDeleted(filePath: string): Promise<void> {
  const db = getDatabase();

  db.transaction(() => {
    // Remove file hash record
    db.prepare('DELETE FROM file_hashes WHERE path = ?').run(filePath);

    // Remove all facts whose source is this file
    db.prepare('DELETE FROM facts WHERE source_file = ?').run(filePath);

    // Remove facts that referenced this file in evidence
    //   (ON DELETE CASCADE on fact_evidence_files cleans up junction rows)
    db.prepare(`
      DELETE FROM facts WHERE id IN (
        SELECT fact_id FROM fact_evidence_files
        WHERE file_path = ?
      )
    `).run(filePath);
  })();
}
```

### Retention Policy `[Phase 0]`

Facts accumulate indefinitely without cleanup — stale entries from deleted files, old sessions, and invalidated oracles degrade SQLite performance at scale. The retention policy runs periodically (on startup + every N gate checks) and removes facts beyond configurable thresholds.

```typescript
interface RetentionConfig {
  maxAgeDays: number;          // delete facts older than N days (default: 30)
  keepLastSessions: number;    // always keep facts from last N sessions (default: 10)
  maxFactCount: number;        // hard cap — oldest first (default: 50_000)
  runEveryNChecks: number;     // cleanup frequency (default: 100)
}
```

```sql
-- Retention cleanup: delete facts older than max_age, preserving recent sessions
DELETE FROM facts
WHERE verified_at < (strftime('%s','now') - :max_age_seconds) * 1000
  AND session_id NOT IN (
    SELECT DISTINCT session_id FROM facts
    ORDER BY verified_at DESC LIMIT :keep_sessions
  );

-- Hard cap: if count exceeds maxFactCount, delete oldest
DELETE FROM facts WHERE id IN (
  SELECT id FROM facts
  ORDER BY verified_at ASC
  LIMIT MAX(0, (SELECT COUNT(*) FROM facts) - :max_fact_count)
);
```

**Configuration** in `vinyan.json`:

```jsonc
{
  "worldGraph": {
    "retention": {
      "maxAgeDays": 30,
      "keepLastSessions": 10,
      "maxFactCount": 50000,
      "runEveryNChecks": 100
    }
  }
}
```

### File Watcher Setup `[Phase 0]`

```typescript
import chokidar from 'chokidar';
import { createHash } from 'crypto';
import { readFile } from 'fs/promises';

function startFileWatcher(workspacePath: string): void {
  const watcher = chokidar.watch(workspacePath, {
    ignored: ['**/node_modules/**', '**/.git/**', '**/dist/**'],
    persistent: true,
    awaitWriteFinish: { stabilityThreshold: 200 },
  });

  watcher.on('change', async (filePath) => {
    const content = await readFile(filePath);
    const hash = createHash('sha256').update(content).digest('hex');
    await onFileChanged(filePath, hash);
  });

  watcher.on('unlink', async (filePath) => {
    // File deleted — invalidate all facts about it
    await onFileDeleted(filePath);
  });
}
```

### Migration Strategy

Versioned schema with `schema_version` table. Each migration:

```typescript
const migrations: Record<number, string> = {
  1: '-- initial schema (above)',
  2: '-- [TBD Phase 1] add skill_templates table',
};

function migrateDatabase(db: Database): void {
  const current = db.prepare('SELECT MAX(version) as v FROM schema_version').get();
  for (const [version, sql] of Object.entries(migrations)) {
    if (Number(version) > (current?.v ?? 0)) {
      db.exec(sql);
      db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(Number(version));
    }
  }
}
```

> **Phase 1 extension:** Phase 1 adds an `execution_traces` table to World Graph for Self-Model capacity tracking (→ §12, §16). The schema migration system (above) handles the upgrade path.

---

## §6. Risk Router

> → arch D4 | Axioms: A3 (deterministic governance), A6 (zero-trust)

### `calculateRiskScore()` Algorithm `[Phase 0]`

```typescript
function calculateRiskScore(factors: RiskFactors): number {
  // Normalize unbounded factors to 0.0–1.0
  const normBlast = Math.min(1.0, factors.blastRadius / 50);
  const normDepth = Math.min(1.0, factors.dependencyDepth / 10);
  const normVolatility = Math.min(1.0, factors.fileVolatility / 30);

  const base =
    (normBlast * 0.25) +
    (normDepth * 0.10) +
    ((1 - factors.testCoverage) * 0.15) +
    (normVolatility * 0.10) +
    (factors.irreversibility * 0.20) +
    (factors.hasSecurityImplication ? 0.10 : 0) +
    (factors.environmentType === 'production' ? 0.10 : 0);

  // A6 Guardrail: production + non-reversible → force Level 3
  if (factors.environmentType === 'production' && factors.irreversibility > 0.5) {
    return Math.max(0.9, base);
  }

  return Math.min(1.0, base);
}
```

**Weight rationale:** Normalized inputs ensure all factors contribute proportionally. blastRadius highest (0.25) = scope of damage. irreversibility (0.20) = recoverability. testCoverage (0.15) = safety net. Normalization bounds: blast/50 files, depth/10 levels, volatility/30 commits (≈daily over a month). Projects exceeding these bounds saturate at 1.0.

### Routing Thresholds `[Phase 0]`

| Level | Name | Risk Range | Model | Token Budget | Execution |
|:-----:|------|:----------:|-------|:------------:|-----------|
| 0 | Reflex | < 0.2 | None (cached) | 0 | Instant lookup |
| 1 | Heuristic | 0.2–0.4 | Haiku (fast) | 10K | Single pass |
| 2 | Analytical | 0.4–0.7 | Sonnet | 50K | Multi-pass + full Oracle |
| 3 | Deliberative | > 0.7 | Opus | 100K | Parallel PHE + shadow |

**4-level routing** (→ concept §8, arch D4): Maps risk score to routing level with per-level model, token budget, and latency constraints.

```typescript
function routeByRisk(riskScore: number, config: RoutingConfig): RoutingDecision {
  if (riskScore <= config.l0_max_risk) {
    return { level: 0, model: null, budgetTokens: 0, latencyBudget_ms: config.latency_budgets_ms.l0 };
  }
  if (riskScore <= config.l1_max_risk) {
    return { level: 1, model: config.l0_l1_model, budgetTokens: config.l1_budget_tokens, latencyBudget_ms: config.latency_budgets_ms.l1 };
  }
  if (riskScore <= config.l2_max_risk) {
    return { level: 2, model: config.l2_model, budgetTokens: config.l2_budget_tokens, latencyBudget_ms: config.latency_budgets_ms.l2 };
  }
  return { level: 3, model: config.l3_model, budgetTokens: config.l3_budget_tokens, latencyBudget_ms: config.latency_budgets_ms.l3 };
}
```

**Latency budgets are design constraints** (→ concept §7): L0 < 100ms, L1 < 2s, L2 < 10s, L3 < 60s. If Oracle verification cannot meet the budget, the Oracle is optimized, made asynchronous, or excluded from that level's pipeline.

### Escalation Trigger `[Phase 0]`

After N consecutive failures (default: 3) at current level:

```
Level 0 → Level 1 → Level 2 → Level 3 → Human escalation with context package
```

Context package for human escalation includes: task description, failed approaches (from WorkingMemory), oracle verdicts, risk assessment.

### Irreversibility Scoring Rules

| Operation | Score | Reason |
|-----------|:-----:|--------|
| File modification (code) | 0.0 | Git-revertible |
| Configuration change (env-var) | 0.3 | Quick revert |
| API call with side effects | 0.7 | External state mutation |
| Database schema change | 0.8 | Migration may not reverse |
| Deployment to production | 0.9 | Takes time to rollback |
| Database data DELETE | 0.95 | Data loss — often unrecoverable |

> **Note:** 4-level routing (L0–L3) is the canonical design from Phase 0 onward (→ concept §8, arch D4). The `calculateRiskScore()` algorithm feeds directly into the 4-level routing thresholds. Phase 1 adds metacognitive routing via the Self-Model (→ §16.2).

### Routing-Level Phase Mapping (→ concept §7, arch D4)

Not every mutation requires all four phases of the Asymmetric Mutation Protocol. The Orchestrator selects phases based on the task's routing level:

| Routing Level | Phase 1 (Intent) | Phase 2 (Blast Radius) | Phase 3 (Shadow) | Phase 4 (Commit) | Latency Budget |
|:---|:---|:---|:---|:---|:---|
| **L0 (Reflex)** | ✅ | ❌ skip | ❌ skip | ✅ (hash-verified) | < 100ms |
| **L1 (Heuristic)** | ✅ | ✅ (lightweight) | ❌ skip | ✅ | < 2s |
| **L2 (Analytical)** | ✅ | ✅ (full) | Conditional\* | ✅ | < 10s |
| **L3 (Deliberative)** | ✅ | ✅ (full) | ✅ (mandatory) | ✅ | < 60s† |

\*L2 Shadow Execution triggers only when blast radius exceeds a configurable threshold (default: 5 affected files or risk score > 0.7).

†**L3 60s applies to the online response path** (single worker, structural oracle verification). Phase 2.2 shadow validation (full test suite + optional PHE workers) runs asynchronously with a separate budget (default: 300s, configurable via `isolation.shadow_budget_ms`).

**Phase implementation by phase:**

```typescript
interface MutationPhaseConfig {
  /** Phase 1: Intent verification — parse hypothesis, validate target exists */
  intentVerification: boolean;
  /** Phase 2: Blast radius analysis — dep-oracle transitive impact */
  blastRadiusAnalysis: 'skip' | 'lightweight' | 'full';
  /** Phase 3: Shadow execution — run mutation in isolated env before commit */
  shadowExecution: 'skip' | 'conditional' | 'mandatory';
  /** Phase 4: Commit — apply mutation with hash verification */
  commitStrategy: 'hash-only' | 'full-oracle';
}

// Phase 2 artifact commit: paths validated using same workspace containment
// checks as tool execution (§18.1 check 2) — reject absolute paths, symlinks,
// and paths that escape workspace root after realpath resolution.

const PHASE_CONFIG: Record<RoutingLevel, MutationPhaseConfig> = {
  0: { intentVerification: true, blastRadiusAnalysis: 'skip',        shadowExecution: 'skip',        commitStrategy: 'hash-only' },
  1: { intentVerification: true, blastRadiusAnalysis: 'lightweight', shadowExecution: 'skip',        commitStrategy: 'full-oracle' },
  2: { intentVerification: true, blastRadiusAnalysis: 'full',        shadowExecution: 'conditional', commitStrategy: 'full-oracle' },
  3: { intentVerification: true, blastRadiusAnalysis: 'full',        shadowExecution: 'mandatory',   commitStrategy: 'full-oracle' },
};
```

> **Latency budgets are design constraints**, not aspirations — if Oracle verification cannot meet the budget for a given routing level, the Oracle is either optimized, made asynchronous (non-blocking verification that can roll back), or excluded from that level's pipeline.

---

## §7. Operational Guardrails (A6)

> → arch D4 (guardrails table) | Axiom: A6 (zero-trust execution)

### Prompt Injection Defense `[Phase 0]`

#### Detection Patterns

```typescript
const INJECTION_PATTERNS: RegExp[] = [
  // Direct instruction override
  /IGNORE\s+(ALL\s+)?PREVIOUS/i,
  /SKIP\s+(ORACLE|VALIDATION)/i,
  /BYPASS\s+(CHECKS|VERIFICATION)/i,
  /FORGET\s+(ALL\s+)?CONSTRAINTS/i,
  /OVERRIDE.*RULE/i,
  /EXECUTE.*DIRECTLY/i,
  // System prompt / role injection
  /\bsystem\s*:\s*/i,
  /\b(new|updated)\s+system\s+prompt/i,
  /\byou\s+are\s+now\b/i,
  /\bact\s+as\b.*\b(admin|root|system)\b/i,
  // Delimiter escape attempts
  /```\s*(system|assistant|user)\b/i,
  /<\|?(system|im_start|endoftext)\|?>/i,
  // Encoding evasion
  /\\u00[0-9a-f]{2}/i,
  /&#x?[0-9a-f]+;/i,
  /base64\s*:/i,
  // Indirect instruction injection
  /\bthe\s+(true|real|actual)\s+(instructions?|prompt|rules?)\b/i,
  /\bprevious\s+instructions?\s+(are|were)\s+(wrong|outdated|replaced)/i,
];

function detectPromptInjection(content: string): boolean {
  return INJECTION_PATTERNS.some(pattern => pattern.test(content));
}
```

> **Note**: These patterns form a baseline defense layer. Production deployments should augment with project-specific patterns and regularly update based on emerging attack vectors. The patterns are intentionally conservative (prefer false positives over false negatives for security-critical operations).
```

#### Input Sanitization

```typescript
function sanitizeWorkerInput(content: string): string {
  let sanitized = content;
  for (const pattern of INJECTION_PATTERNS) {
    sanitized = sanitized.replace(pattern, '[FILTERED]');
  }
  return sanitized;
}
```

### Worker Output Bypass Detection `[Phase 0]`

```typescript
const BYPASS_PATTERNS: string[] = [
  'skip Oracle',
  'bypass validation',
  'ignore checks',
  'force commit',
  'suppress errors',
];

function containsBypassAttempt(workerOutput: string): boolean {
  return BYPASS_PATTERNS.some(p =>
    workerOutput.toLowerCase().includes(p.toLowerCase())
  );
}
```

If detected → block output, log violation, return error to Orchestrator.

### Oracle Independence Guarantee

- Oracles verify **actual code artifacts**, never worker claims about code
- AST Oracle reads file directly via tree-sitter
- Type Oracle runs `tsc --noEmit` on actual source
- Test Oracle runs actual test suite
- Workers **cannot influence** Oracle inputs — Orchestrator provides file paths, not worker-provided content

### Production Boundary Escalation Matrix `[Phase 0 — simplified]`

**Phase 0 implements only the first 3 rows below.** Security oracle routing and on-call notification are deferred to Phase 1.

| Condition | Action | Phase |
|-----------|--------|:-----:|
| `environmentType: 'production'` + any mutation | Minimum Level 2 | 0 |
| `environmentType: 'production'` + `irreversibility > 0.5` | Level 3 + human approval | 0 |
| `environmentType: 'production'` + `irreversibility > 0.8` | Level 3 + explicit human approval | 0 |
| `hasSecurityImplication` + `risk > 0.6` | Route to security oracle | 1 |
| `fileVolatility > 5 commits/week` + `risk > 0.5` | Notify on-call | 1 |

### Environment Detection Logic `[Phase 0]`

```typescript
function detectEnvironment(): 'development' | 'staging' | 'production' {
  // Check common environment indicators
  const env = process.env.NODE_ENV ?? process.env.VINYAN_ENV ?? 'development';
  if (env === 'production' || env === 'prod') return 'production';
  if (env === 'staging' || env === 'stg') return 'staging';
  return 'development';
}
```

> **Phase 1 extension:** Phase 1 adds context-aware sanitization — separating user-facing content from code artifacts to prevent false positive filtering (→ §18).

---

## §8. Host Integration Adapter (`@vinyan/oracle-gate`)

> → arch D1 | Axioms: A1 (separation), A6 (zero-trust)
> 
> **Scope note:** This section specifies the **thin, replaceable adapter** that connects Vinyan's engine (§4–§7) to a specific host agent. The current adapter targets Claude Code (or compatible host) as the Phase 0 test host. The adapter proves the ENS thesis in production but is **not** architecturally central — the core engine operates independently. In Phase 1+, the Orchestrator (§16) replaces this adapter as the primary entry point.

### Host Registration `[Phase 0]`

```typescript
import type { HostPluginApi } from '@vinyan/host-adapter';  // Claude Code or compatible host SDK

export default {
  id: 'vinyan-oracle-gate',
  version: '0.1.0',

  register(api: HostPluginApi) {
    api.on('before_tool_call', handleBeforeToolCall);
    api.on('after_tool_call', handleAfterToolCall);
    api.on('before_prompt_build', handleBeforePromptBuild);
    api.on('before_model_resolve', handleBeforeModelResolve);
  },
};
```

### Tool Mutation Classification `[Phase 0]`

```typescript
/** Tools that modify filesystem or external state */
const MUTATING_TOOLS = new Set([
  'write_file', 'create_file', 'replace_in_file', 'insert_in_file',
  'delete_file', 'rename_file', 'run_terminal_command',
  'apply_diff',
]);

/** Read-only tools — skip oracle validation */
const READONLY_TOOLS = new Set([
  'read_file', 'search_files', 'list_directory', 'grep_search',
  'get_diagnostics',
]);

function isMutatingTool(toolName: string): boolean {
  if (MUTATING_TOOLS.has(toolName)) return true;
  if (READONLY_TOOLS.has(toolName)) return false;
  // Unknown tools default to mutating (conservative — A6)
  return true;
}
```

### Hook Implementations `[Phase 0]`

#### `before_tool_call` — Gate Keeper

```typescript
async function handleBeforeToolCall(event: ToolCallEvent): Promise<GateResult> {
  // Step 1: Prompt injection detection (A6)
  if (detectPromptInjection(JSON.stringify(event.params))) {
    return { block: true, blockReason: 'Prompt injection detected' };
  }

  // Step 2: Skip read-only tools
  if (!isMutatingTool(event.toolName)) return {};

  // Step 3: Risk assessment
  const riskScore = await assessRisk(event);
  if (riskScore > config.escalation.risk_threshold) {
    return { block: true, blockReason: `Risk ${riskScore} exceeds threshold` };
  }

  // Step 4: Run Epistemic Oracles
  const verdicts = await runOracles(event.toolName, event.params);
  if (verdicts.some(v => !v.verified)) {
    return { block: true, blockReason: formatOracleFailures(verdicts) };
  }

  return {};  // allow
}
```

#### `assessRisk()` — RiskFactors Assembly `[Phase 0]`

```typescript
/** Compute RiskFactors from a tool call event */
async function assessRisk(event: ToolCallEvent): Promise<number> {
  const targetFile = extractTargetFile(event.params);
  if (!targetFile) return 0;  // no file target → minimal risk

  const blastResult = await depOracle.computeBlastRadius(targetFile);
  const testCoverage = await worldGraph.getTestCoverageEstimate(targetFile);
  const fileVolatility = await worldGraph.getFileVolatility(targetFile);

  const factors: RiskFactors = {
    blastRadius: blastResult.blastRadius,
    dependencyDepth: blastResult.dependencyDepth,
    testCoverage,
    fileVolatility,
    irreversibility: getIrreversibilityScore(event.toolName),
    hasSecurityImplication: isSecurityRelated(targetFile),
    environmentType: detectEnvironment(),
  };

  return calculateRiskScore(factors);
}
```

#### Helper Functions — `assessRisk` Dependencies

##### `getTestCoverageEstimate(file: string): Promise<number>`

Returns 0.0–1.0. Phase 0 heuristic — does **not** parse coverage reports.

```typescript
/** Heuristic test coverage estimate from file naming conventions */
async function getTestCoverageEstimate(file: string): Promise<number> {
  const testVariants = [
    file.replace(/\.ts$/, '.test.ts'),
    file.replace(/\.ts$/, '.spec.ts'),
    file.replace(/^src\//, 'tests/'),
  ];
  const hasTest = testVariants.some(t => existsSync(t));
  return hasTest ? 0.7 : 0.0;  // coarse: has-test / no-test
  // Phase 1: parse c8/istanbul JSON for line coverage
}
```

##### `getFileVolatility(file: string): Promise<number>`

Returns raw commit count in last 30 days. Normalized by `calculateRiskScore()`.

```typescript
/** Git commit frequency as volatility proxy */
async function getFileVolatility(file: string): Promise<number> {
  const { stdout } = await exec(`git log --oneline --since="30 days ago" -- "${file}" | wc -l`);
  return parseInt(stdout.trim(), 10) || 0;
}
```

##### `isSecurityRelated(file: string): boolean`

Path-based heuristic. No content analysis in Phase 0.

```typescript
const SECURITY_PATTERNS = [
  /auth/i, /credential/i, /secret/i, /token/i, /password/i,
  /encrypt/i, /decrypt/i, /\.env/, /permission/i, /rbac/i,
  /security/i, /csrf/i, /xss/i, /sanitiz/i,
];

function isSecurityRelated(file: string): boolean {
  return SECURITY_PATTERNS.some(p => p.test(file));
}
```

##### `getIrreversibilityScore(toolName: string): number`

Maps tool names to irreversibility scores using the table in §6.

```typescript
/** Static mapping — see §6 Irreversibility Scoring Rules for rationale */
const IRREVERSIBILITY_MAP: Record<string, number> = {
  // File operations — git-revertible
  'write_file': 0.0, 'edit_file': 0.0, 'create_file': 0.0,
  'delete_file': 0.3,   // recoverable but disruptive
  // Config / env
  'update_env': 0.3, 'update_config': 0.3,
  // External side effects
  'api_call': 0.7, 'http_request': 0.7,
  // Database
  'run_sql': 0.8,        // schema change assumed
  'deploy': 0.9,
};
const DEFAULT_IRREVERSIBILITY = 0.5;  // unknown tools → moderate (A6 conservative)

function getIrreversibilityScore(toolName: string): number {
  return IRREVERSIBILITY_MAP[toolName] ?? DEFAULT_IRREVERSIBILITY;
}
```

##### `formatOracleFailures(verdicts: OracleVerdict[]): string`

Formats failed oracle verdicts into a structured block reason for `GateResult.blockReason`.

```typescript
function formatOracleFailures(verdicts: OracleVerdict[]): string {
  const failures = verdicts.filter(v => !v.verified);
  return failures
    .map(v => `[${v.oracleName}] ${v.reason ?? 'verification failed'} (${v.duration_ms}ms)`)
    .join('; ');
}
// Example output:
// "[type-oracle] Type error in line 42 (1200ms); [test-oracle] 3 tests failed (8500ms)"
```

#### `after_tool_call` — World Graph Update

```typescript
async function handleAfterToolCall(event: ToolCallResult): Promise<void> {
  if (event.error) return;
  // Record successful mutation as verified fact in World Graph
  await worldGraph.recordToolResult(event.toolName, event.params, event.result);
  // Update file hashes for affected files
  for (const file of getAffectedFiles(event)) {
    await worldGraph.refreshFileHash(file);
  }
}
```

#### `before_prompt_build` — Context Injection `[Phase 0 simplified]`

```typescript
/** Phase 0: inject verified facts + approach blacklist (no full PerceptualHierarchy) */
async function handleBeforePromptBuild(event: PromptEvent): Promise<PromptModification> {
  const sanitized = sanitizeWorkerInput(event.userMessage);

  // Phase 0: simplified context — verified facts + failed approaches only
  const verifiedFacts = await worldGraph.getFactsForTarget(event.targetFile);
  const failedApproaches = getSessionFailedApproaches(event.taskId);

  return {
    systemPromptSuffix: formatPhase0Context(verifiedFacts, failedApproaches),
  };
}

// Phase 1: upgrade to full PerceptualHierarchy + WorkingMemory injection
// async function handleBeforePromptBuildV2(...) { ... }
```

#### `before_model_resolve` — Risk-Based Model Routing

```typescript
async function handleBeforeModelResolve(event: ModelEvent): Promise<ModelOverride> {
  const risk = await estimateTaskRisk(event.prompt);
  if (risk <= config.routing.l0_max_risk) {
    return { modelOverride: config.routing.l0_l1_model };  // L0 Reflex
  }
  if (risk <= config.routing.l1_max_risk) {
    return { modelOverride: config.routing.l0_l1_model };  // L1 Heuristic
  }
  if (risk <= config.routing.l2_max_risk) {
    return { modelOverride: config.routing.l2_model };     // L2 Analytical
  }
  return { modelOverride: config.routing.l3_model };       // L3 Deliberative
}
```

### Event Flow Diagram `[Phase 0]`

```
Tool Call Requested
    ↓
[1] detectPromptInjection() → BLOCK if positive
    ↓
[2] isMutatingTool()? → SKIP oracles if read-only
    ↓
[3] assessRisk() → compute RiskFactors + calculateRiskScore()
    ↓
[4] riskScore > threshold? → BLOCK with escalation context
    ↓
[5] runOracles() → ast, type, test, lint, dep (parallel)
    ↓
[6] Any oracle !verified? → BLOCK with evidence
    ↓
[7] ALLOW execution
    ↓
[8] Tool executes → captures result
    ↓
[9] updateWorldGraph() → record facts + refresh file hashes
```

### Error Handling `[Phase 0]`

| Scenario | Phase 0 Behavior | Phase 1 Behavior |
|----------|-----------------|-----------------|
| Oracle timeout | Block by default (fail-closed, A6); configurable to `'warn'` per oracle | Block (fail-closed) |
| Oracle crash | Allow with warning + disable oracle for session | Block + restart oracle |
| World Graph write failure | Log error, continue | Retry with backoff |
| File watcher lag | Accept slight staleness | Explicit hash verification |

---

## §9. CLI (`@vinyan/cli`)

> → arch D1

### `vinyan init` Command `[Phase 0]`

```typescript
async function init(workspacePath: string): Promise<void> {
  // 1. Detect project type
  const projectType = await detectProjectType(workspacePath);

  // 2. Generate vinyan.json with smart defaults
  const config = generateDefaultConfig(projectType);

  // 3. Write config file
  await writeFile(
    join(workspacePath, 'vinyan.json'),
    JSON.stringify(config, null, 2)
  );

  // 4. Initialize World Graph database
  await initializeWorldGraph(join(workspacePath, '.vinyan', 'world.db'));

  console.log(`✅ Vinyan initialized for ${projectType.language} project`);
}
```

### Project Detection Logic `[Phase 0]`

```typescript
interface ProjectType {
  language: 'typescript' | 'python' | 'mixed';
  packageManager: 'bun' | 'npm' | 'yarn' | 'pnpm' | 'pip';
  testRunner: string;
  linter: string;
  typeChecker: string;
}

async function detectProjectType(dir: string): Promise<ProjectType> {
  const hasPackageJson = await exists(join(dir, 'package.json'));
  const hasPyproject = await exists(join(dir, 'pyproject.toml'));
  const hasBunLock = await exists(join(dir, 'bun.lockb'));

  if (hasPackageJson && !hasPyproject) {
    return {
      language: 'typescript',
      packageManager: hasBunLock ? 'bun' : 'npm',
      testRunner: hasBunLock ? 'bun test' : 'npx vitest',
      linter: 'npx eslint',
      typeChecker: 'tsc --noEmit',
    };
  }

  if (hasPyproject && !hasPackageJson) {
    return {
      language: 'python',
      packageManager: 'pip',
      testRunner: 'python -m pytest',
      linter: 'ruff check',
      typeChecker: 'pyright',
    };
  }

  return {
    language: 'mixed',
    packageManager: hasBunLock ? 'bun' : 'npm',
    testRunner: 'bun test',
    linter: 'npx eslint',
    typeChecker: 'tsc --noEmit',
  };
}
```

### Default Configuration `[Phase 0]`

```jsonc
// vinyan.json — generated by `vinyan init`
{
  "version": 1,
  "oracles": {
    "ast":  { "enabled": true, "languages": ["typescript"], "timeout_ms": 5000 },
    "type": { "enabled": true, "command": "tsc --noEmit", "timeout_ms": 30000 },
    "test": { "enabled": true, "command": "bun test", "timeout_ms": 30000 },
    "lint": { "enabled": true, "command": "npx eslint", "timeout_ms": 10000 },
    "dep":  { "enabled": true, "timeout_ms": 10000 }
  },
  "routing": {
    "l0_max_risk": 0.2,
    "l1_max_risk": 0.4,
    "l2_max_risk": 0.7,
    "l0_l1_model": "claude-haiku",
    "l2_model": "claude-sonnet",
    "l3_model": "claude-opus",
    "l1_budget_tokens": 10000,
    "l2_budget_tokens": 50000,
    "l3_budget_tokens": 100000,
    "latency_budgets_ms": { "l0": 100, "l1": 2000, "l2": 10000, "l3": 60000 }
  },
  "isolation": {
    "l0_max_risk": 0.2,
    "l1_max_risk": 0.7
  },
  "escalation": {
    "max_retries_before_human": 3,
    "risk_threshold": 0.8,
    "channel": "terminal"
  },
  "worldGraph": {
    "dbPath": ".vinyan/world.db",
    "watchIgnore": ["node_modules", ".git", "dist"]
  }
}
```

---

## §10. Execution Lifecycle `[Phase 1]`

> → arch D9 | Axiom: A3 (deterministic governance)

### Adaptive Lifecycle State Machine

```
                    ┌──────────┐
                    │ PERCEIVE │ ← PerceptualHierarchy assembly
                    └────┬─────┘
                         │
                    ┌────▼─────┐
              ┌─NO──┤ Level≥2? ├──YES─┐
              │     └──────────┘      │
              │                  ┌────▼─────┐
              │                  │ PREDICT  │ ← Self-Model forward prediction
              │                  └────┬─────┘
              │                       │
              │                  ┌────▼─────┐
              │                  │  PLAN    │ ← Iterative DAG + 5 criteria
              │                  └────┬─────┘
              │                       │
         ┌────▼───────────────────────▼─────┐
         │           GENERATE               │ ← Worker execution
         └─────────────┬────────────────────┘
                       │
                  ┌────▼─────┐
                  │ VERIFY   │ ← Oracles + QualityScore
                  └────┬─────┘
                       │
              ┌────────▼────────┐
              │ Oracle Pass?    │
              ├── YES ──────────┤
              │           ┌─────▼──────┐
              │           │   LEARN    │ ← Record trace + PredictionError
              │           └─────┬──────┘
              │                 │
              │           ┌─────▼──────┐
              │           │    DONE    │
              │           └────────────┘
              │
              ├── NO ───────────┤
              │           ┌─────▼──────┐
              │           │  REPLAN    │ ← Update WorkingMemory
              │           └─────┬──────┘
              │                 │
              │           ┌─────▼───────┐
              │           │ retries<N?  │
              │           ├── YES → PLAN│
              │           ├── NO ──┐    │
              │           └────────┘    │
              │                    ┌────▼──────┐
              │                    │ ESCALATE  │ → Human
              │                    └───────────┘
              └─────────────────────────────────┘
```

### Lifecycle Steps per Routing Level

| Step | Level 0 | Level 1 | Level 2 | Level 3 |
|------|:-------:|:-------:|:-------:|:-------:|
| Perceive | Minimal | Basic | Full cone | Full + cross-domain |
| Predict | — | — | ✅ | ✅ |
| Plan | — | — | ✅ iterative | ✅ parallel PHE |
| Generate | Cached | Single pass | Multi-pass | Parallel workers |
| Verify | Hash only | Oracles | Oracles + QS | Oracles + QS + shadow |
| Learn | — | Trace | Trace + PE | Trace + PE + rules |

### Iterative Task Decomposition (→ arch D7) `[Phase 1]`

**Decomposition is LLM-assisted, not deterministic** (concept §8). The `planner.generatePlan()` call delegates to an LLM in its **Generator Engine** role (§4 Reasoning Engine registry, tier: `probabilistic`). The Orchestrator's governance of decomposition is deterministic: it validates each candidate DAG through 5 machine-checkable criteria, enforces structural constraints, and rejects invalid plans. LLMs generate candidate decompositions; the Orchestrator validates and commits them — consistent with A3 (rule-based governance over probabilistic generation).

```typescript
async function decomposeTask(task: Task): Promise<TaskDAG> {
  for (let iteration = 0; iteration < 3; iteration++) {
    // planner.generatePlan() uses LLM Generator Engine (probabilistic tier)
    // to produce a candidate DAG from the task description
    const plan = await planner.generatePlan(task);

    // Orchestrator validates deterministically (rule-based, no LLM)
    const validation = await validateDAG(plan);

    if (allCriteriaMet(validation)) {
      return plan;
    }

    // Replan with validation feedback — LLM receives structured error
    task = enrichWithFeedback(task, validation);
  }

  // 3 failures → escalate to human (concept §12 escalation policy)
  throw new EscalationError('Task decomposition failed after 3 iterations');
}

function allCriteriaMet(v: DagValidationCriteria): boolean {
  return v.no_orphans
    && v.no_scope_overlap
    && v.coverage
    && v.valid_dependency_order
    && v.verification_specified;
}
```

### 10.4 Parallel DAG Execution `[Phase 5]`

When a validated DAG contains subtasks with no unmet dependencies, they execute in parallel via a bounded executor pool.

**Execution model:**

```typescript
interface ParallelExecutorConfig {
  maxParallelSubtasks: number;        // default: 4 — limits concurrent subtask dispatch
  failureStrategy: 'fail-fast' | 'fail-independent';
}

// Default strategy selection (rule-based, A3-compliant):
// - Subtasks with sideEffect: false → 'fail-independent' (continue siblings)
// - Subtasks with sideEffect: true  → 'fail-fast' (cancel siblings on first failure)
```

**Algorithm:**

1. Build a ready-queue of subtasks whose `dependencies` are all resolved
2. Dispatch up to `maxParallelSubtasks` concurrently via `WorkerPool`
3. On subtask completion:
   - Mark resolved → re-scan DAG for newly unblocked subtasks → enqueue
   - On failure + `fail-fast`: cancel all in-flight siblings, propagate error
   - On failure + `fail-independent`: record failure, continue remaining subtasks
4. DAG completes when all subtasks resolved (success or independent-failure)

**Failure output:**

```typescript
interface DAGExecutionResult {
  status: 'success' | 'partial_failure' | 'aborted';
  subtask_results: Map<string, TaskResult>;     // keyed by subtask ID
  failed_subtasks: string[];                     // IDs of failed subtasks
  cancelled_subtasks: string[];                  // IDs cancelled by fail-fast
}
```

**Constraints:**
- `maxParallelSubtasks` ≤ `WorkerPool.maxWorkers` — executor pool cannot exceed worker capacity
- Each parallel subtask gets its own `ExecutionTrace` entry, linked to the parent task via `parent_task_id`
- Deterministic ordering: when multiple subtasks become ready simultaneously, dispatch in DAG declaration order (stable, reproducible)

---

## §11. Orchestrator Architecture `[Phase 1]`

> → arch D7 | Axiom: A3 (deterministic governance)

### Component Layout `[Phase 1]`

```
Vinyan Orchestrator (standalone TypeScript/Bun process)
├── TaskDecomposer        — iterative planning + DAG validation
├── RiskAssessmentEngine  — calculateRiskScore() + routing
├── WorkerPoolManager     — fork/kill, budget enforcement
│   ├── Worker L0 (in-process)
│   ├── Worker L1 (child_process.fork, JSON stdio)
│   └── Worker L2 (Docker container) [TBD Phase 2]
├── SelfModel             — forward predictor + calibration loop
├── PerceptionAssembler   — builds PerceptualHierarchy per routing level
├── WorldGraphManager     — SQLite + file watcher + cascade invalidation
├── TraceCollector        — records ExecutionTrace for Evolution Engine
└── EventBus              — deterministic message routing
```

### Worker IPC: JSON via stdio `[Phase 1]`

> **Note:** These interfaces are superseded by §16 `WorkerInput`/`WorkerOutput` in `src/orchestrator/types.ts`.
> The canonical definitions include `routingLevel`, `workingMemory: WorkingMemoryState`, `allowedPaths`,
> `isolationLevel`, and `proposedMutations`/`proposedToolCalls`/`uncertainties` on output.
> Zod schemas for IPC validation are in `src/orchestrator/protocol.ts`.

```typescript
// Orchestrator → Worker (stdin) — see src/orchestrator/types.ts WorkerInput
interface WorkerInput {
  taskId: string;
  goal: string;
  routingLevel: RoutingLevel;
  perception: PerceptualHierarchy;
  workingMemory: WorkingMemoryState;
  plan?: TaskDAG;
  budget: {
    maxTokens: number;
    timeoutMs: number;
  };
  allowedPaths: string[];
  isolationLevel: IsolationLevel;
}

// Worker → Orchestrator (stdout) — see src/orchestrator/types.ts WorkerOutput
interface WorkerOutput {
  taskId: string;
  proposedMutations: Array<{
    file: string;
    content: string;
    explanation: string;
  }>;
  proposedToolCalls: ToolCall[];
  uncertainties: string[];
  tokensConsumed: number;
  duration_ms: number;
}
```

### Worker Budget Enforcement

```typescript
interface WorkerBudget {
  maxTokens: number;
  maxDurationMs: number;
  maxFileWrites: number;
  allowedPaths: string[];     // sandbox — worker can only touch these
}
```

Workers exceeding budget are killed. Orchestrator records timeout in ExecutionTrace.

### Health Checks `[TBD Phase 1]`

- Worker heartbeat interval: 5s
- Orchestrator process supervision: restart on crash
- World Graph integrity check: on startup, verify all file hashes still match

---

## §12. Self-Model + QualityScore `[Phase 1]`

> → arch D10, D11 | Axiom: A7 (prediction error as learning signal)

### Self-Model Cold-Start Heuristics

| Prediction | Heuristic | Expected Accuracy |
|-----------|-----------|:-----------------:|
| Test results | File has ≥3 tests + coverage >70% → `'pass'` | ~60% |
| Blast radius | dep-oracle transitive count | ~80% |
| Duration | Historical mean for similar file count | ~40% |
| Quality score | Baseline from project's last 20 traces | ~50% |

### QualityScore Composite Formula

```typescript
function computeComposite(qs: QualityScore): number {
  const hasPhase1Dimensions =
    qs.simplificationGain !== undefined && qs.testMutationScore !== undefined;

  if (!hasPhase1Dimensions) {
    // Phase 0: only 2 dimensions available
    return (qs.architecturalCompliance * 0.6) + (qs.efficiency * 0.4);
  }

  // Phase 1+: 4 dimensions
  return (
    (qs.architecturalCompliance * 0.30) +
    (qs.efficiency * 0.20) +
    (qs.simplificationGain! * 0.25) +
    (qs.testMutationScore! * 0.25)
  );
}
```

### Calibration Loop `[Phase 1]`

```
Predict (SelfModelPrediction)
    ↓
Execute (Worker runs task)
    ↓
Observe (Actual results from Oracles)
    ↓
Compare (PredictionError = Δ predicted vs actual)
    ↓
Update (Adjust heuristic weights based on composite error)
    ↓
Store (ExecutionTrace with prediction_error field)
```

**Target calibration curve:** ~50–60% accuracy at cold start → >75% by 200 sessions.

### Cold-Start Safeguards (→ concept §9.2)

To prevent bad predictions from poisoning the calibration loop during early operation:

| # | Safeguard | Mechanism | Config Key | Default |
|:---|:---|:---|:---|:---|
| **S1** | Conservative override period | Self-Model routing is advisory only; Orchestrator forces L2 minimum | `self_model.conservative_override_tasks` | 50 |
| **S2** | Meta-uncertainty | `metaConfidence` forced < 0.3 when < 10 observations for task pattern → conservative fallback | `self_model.min_observations_for_confidence` | 10 |
| **S3** | Human audit sampling | 10% of routing decisions flagged for optional human review during calibration | `self_model.audit_sample_rate` | 0.1 (first 100 tasks) |
| **S4** | Monotonic trust ramp | Self-Model influence increases only as calibration error decreases — cannot gain authority faster than accuracy improves | — (algorithmic invariant) | — |

**Hard routing floor** (immutable invariant): Self-Model cannot route below L1 for any task with blast radius > 1 file. This is enforced in the Orchestrator routing logic, not in the Self-Model itself — the Self-Model can *recommend* L0, but the Orchestrator overrides based on structural analysis.

```typescript
/** Cold-start guard applied after Self-Model prediction (Phase 1) */
function applyRoutingFloor(
  prediction: SelfModelPrediction,
  blastRadius: number,
  taskCount: number,
  config: { conservative_override_tasks: number },
): RoutingLevel {
  let level = prediction.suggestedLevel;

  // S1: Conservative override during calibration
  if (taskCount < config.conservative_override_tasks) {
    level = Math.max(level, 2) as RoutingLevel; // L2 minimum
  }

  // Hard floor: blast radius > 1 file → L1 minimum (immutable)
  if (blastRadius > 1) {
    level = Math.max(level, 1) as RoutingLevel;
  }

  // S2: Low meta-confidence → bump one level
  if (prediction.metaConfidence < 0.3) {
    level = Math.min(level + 1, 3) as RoutingLevel;
  }

  return level;
}
```

### `[TBD Phase 1]` Items

- Calibration algorithm detail (gradient vs. exponential moving average)
- Dedicated storage schema for Self-Model parameters
- Cross-project transfer learning for heuristics
- Audit sampling UI/UX for human review (S3)

---

## §12B. Evolution Engine `[Phase 2–3]`

> → concept §10 | Axiom: A7 (prediction error as learning signal)

The Evolution Engine transforms accumulated execution traces into operational improvements. It operates at **two speeds** (concept §10):

1. **Fast loop** (in-session): approach blacklist prevents retrying failed strategies within the same task
2. **Slow loop** (between-session): Sleep Cycle analyzes traces to extract patterns → new rules

### Interfaces

> **Note:** `ExecutionTrace` is defined in §2 (canonical definition). See `src/orchestrator/types.ts`.

```typescript
/** Pattern extracted by Sleep Cycle analysis */
interface ExtractedPattern {
  id: string;
  type: 'anti-pattern' | 'success-pattern' | 'worker-performance';  // [Phase 4] worker-performance type
  description: string;
  frequency: number;                     // occurrence count in traces
  confidence: number;                    // Wilson score lower bound
  taskTypeSignature: string;             // task pattern for matching
  approach?: string;                     // for success patterns: the winning approach
  comparedApproach?: string;             // for success patterns: the losing approach
  qualityDelta?: number;                 // composite improvement
  sourceTraceIds: string[];              // provenance
  createdAt: number;
  expiresAt?: number;                    // decay TTL
  decayWeight: number;                   // current weight after exponential decay
  routingLevel?: number;                 // [Phase 3] level at which failure occurred
  oracleName?: string;                   // [Phase 3] oracle that flagged the issue
  riskAbove?: number;                    // [Phase 3] risk threshold context
  modelPattern?: string;                 // [Phase 3] model that exhibited the pattern
  derivedFrom?: string;                  // [Phase 3] parent pattern ID (lineage tracking)
  workerId?: string;                     // [Phase 4] worker that exhibited the pattern
  comparedWorkerId?: string;             // [Phase 4] worker compared against
}

/** Sleep Cycle configuration */
interface SleepCycleConfig {
  interval_sessions: number;             // default: 20 (from vinyan.json)
  min_traces_for_analysis: number;       // minimum traces before analysis runs
  pattern_min_frequency: number;         // minimum occurrences to extract pattern
  pattern_min_confidence: number;        // statistical threshold (Wilson LB)
  decay_half_life_sessions: number;      // pattern relevance decay
}
```

### Sleep Cycle Algorithm `[Phase 2]`

```
Trigger: Every N sessions (configurable, default: 20)
    ↓
Collect: All ExecutionTraces since last cycle
    ↓
Analyze: Frequency-based pattern detection
    - Group traces by task type signature
    - Identify anti-patterns: approach X fails on task type Y in ≥80% of cases
    - Identify success patterns: approach A outperforms approach B by ≥25% composite
    ↓
Filter: Statistical significance test (min frequency + confidence threshold)
    ↓
Extract: Generate ExtractedPattern records with provenance
    ↓
Decay: Reduce weight of old patterns (exponential decay with configurable half-life)
    ↓
Apply: Update operational rules (Oracle configs, risk thresholds, routing)
```

> **Honest complexity assessment** (concept §10): Phase 2 mechanism is frequency-based pattern detection — implementable but limited to high-frequency patterns with clear signals. Full pattern mining across diverse task types is a **research problem** (Phase 3+), requiring sufficient data volume (hundreds of tasks minimum), a relevance model for pattern decay, and evaluation methodology for mined rules.

### Bounded Self-Modification (Safety Invariants)

The Evolution Engine may modify operational rules but **cannot** modify these immutable invariants:

| Invariant | Rationale |
|:---|:---|
| Human escalation triggers | Safety-critical decisions always reach a human |
| Security policies (injection defense, production boundary) | Cannot disable guardrails through learning |
| Budget hard limits (token, latency) | Cost containment cannot be self-modified |
| Minimum test requirements | Cannot skip verification through optimization |
| Rollback capability | Must always be able to revert mutations |
| Routing hard floor (L1 min for blast radius > 1) | Cannot route multi-file changes to L0 |

### Cached Solution Patterns (Skill Formation) `[Phase 2]`

When the same task pattern succeeds repeatedly with the same approach, that approach is cached as a Level 0 Reflex shortcut:

```typescript
interface CachedSkill {
  taskSignature: string;          // pattern hash
  approach: string;               // proven strategy
  successRate: number;            // must be ≥ min_effectiveness (default: 0.7)
  status: 'probation' | 'active' | 'demoted';
  probationRemaining: number;     // sessions until promotion (default: 10)
  usageCount: number;
  riskAtCreation: number;                    // risk score when skill was formed
  depConeHashes: Record<string, string>;     // file → hash at skill creation time
  lastVerifiedAt: number;                    // timestamp of last full re-verification (Sleep Cycle)
  verificationProfile: 'hash-only' | 'structural' | 'full'; // determined by riskAtCreation
}
```

Promotion rules: probation (10 sessions) → active (if effectiveness ≥ 0.7) → demoted (if effectiveness drops below threshold). This is simple memoization, not hierarchical skill composition.

**Verification profiles by risk** (replaces blanket hash-only check):

| Skill Risk | Hash | Dep Cone Freshness | Structural Oracle | Test Oracle |
|------------|:----:|:------------------:|:-----------------:|:-----------:|
| Low (< 0.2) | ✓ | — | — | — |
| Medium (0.2–0.4) | ✓ | direct deps | ast | — |
| High (> 0.4) | ✓ | transitive | ast + type | ✓ |

If dep cone has changed since skill creation → demote to L1, re-evaluate. Verification fail → `status = 'demoted'`.

### Evolution Rule Conflict Resolution `[Phase 2]`

Rules with the same `action` type on overlapping conditions can conflict. Resolution is **3-step deterministic** (modeled after Oracle conflict resolution in §4):

1. **Action type separation** — rules with different action types never conflict
2. **Specificity wins** — higher `specificity` (count of non-null condition fields) wins. Ties: higher `effectiveness` wins. Still tied: more conservative rule wins (higher escalation, stricter oracle requirement)
3. **Safety floor** — unresolvable conflict → stricter action always wins. Cannot relax safety through evolution (per bounded self-modification invariants above)

Implementation: `resolveRuleConflicts(rules: EvolutionaryRule[]): EvolutionaryRule[]` — deterministic for same input (A3).

### Data Sufficiency Gates `[Phase 2]`

Phase 2 sub-features activate progressively via `DataGate` checks, not a single phase-wide prerequisite:

| Feature | Gate Conditions |
|---------|----------------|
| 2.1–2.3 (infrastructure) | None |
| 2.4 Sleep Cycle | `trace_count ≥ 100 AND distinct_task_types ≥ 5` |
| 2.5 Skill Formation | 2.4 active + `patterns_extracted ≥ 1` |
| 2.6 Evolution Engine | `trace_count ≥ 200 AND active_skills ≥ 1 AND sleep_cycles_run ≥ 3` |

Gate thresholds are configurable via `evolution.*` config fields.

### Shadow Job Queue `[Phase 2]`

L3 shadow validation is mandatory execution (TDD §6 routing table). To survive orchestrator crashes, shadow jobs are persisted to SQLite **before** the online response returns:

```sql
CREATE TABLE IF NOT EXISTS shadow_jobs (
  id           TEXT PRIMARY KEY,
  task_id      TEXT NOT NULL,
  status       TEXT NOT NULL CHECK(status IN ('pending','running','done','failed')),
  enqueued_at  INTEGER NOT NULL,
  started_at   INTEGER,
  completed_at INTEGER,
  result       TEXT,          -- JSON ShadowValidationResult
  retry_count  INTEGER DEFAULT 0,
  max_retries  INTEGER DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_shadow_jobs_status ON shadow_jobs(status);
```

**Invariant**: Orchestrator must INSERT `ShadowJob` (status: `'pending'`) before returning `TaskResult` with `status: 'completed'`. On startup, scan `shadow_jobs WHERE status IN ('pending', 'running')` → re-dispatch.

### `[TBD Phase 2–3]` Items

- Sleep Cycle implementation and storage schema
- Pattern decay model (exponential vs. power-law)
- Cross-project pattern transfer
- Counterfactual generation (Phase 3+ research)
- Evaluation methodology for mined rules

---

## §12C. Failure Modes & Recovery (→ concept §14)

No system is immune to failure. This section documents the top failure scenarios and their recovery strategies.

| # | Failure Mode | Cause | Impact | Recovery Strategy |
|:---|:---|:---|:---|:---|
| **F1** | Oracle false negative (rejects correct code) | tree-sitter grammar bug, tsc version mismatch, overly strict pattern matching | Valid mutation blocked; developer friction | Configurable override: human can force-commit with audit trail. Oracle accuracy tracked — systematic false negatives trigger Oracle review (§12B Evolution Engine). Phase 0 metric: false positive rate < 10%. |
| **F2** | Oracle false positive (accepts incorrect code) | Verification scope gap (§6) — structural check passes but semantic error exists | Incorrect code committed to codebase | Mitigated by tiered verification: no single Oracle is the sole gate. Multi-dimensional QualityScore provides additional signal. Semantic errors are explicitly out of scope for deterministic Oracles — they require test coverage or human review. |
| **F3** | World Graph inconsistency | Race condition between file watcher and mutation; crash during graph update | Stale or contradictory facts used for verification | SQLite WAL mode + write-ahead journaling. On detected inconsistency: invalidate the entire dependency cone of affected files and rebuild from source. Content-hash binding (A4) ensures inconsistency is always detectable — a hash mismatch triggers automatic revalidation. |
| **F4** | Self-Model miscalibration cascade | Bad initial predictions → wrong routing → poor outcomes → feedback reinforces bad model | Systematic resource waste (over/under-routing) | Cold-start safeguards (§12 S1–S4): conservative override period, meta-uncertainty, monotonic trust ramp. Hard floor: Self-Model cannot route below L1 for any task with blast radius > 1 file. |
| **F5** | Risk scoring systematically miscalibrated | Heuristic weights don't match actual project risk profile | High-risk tasks under-protected; low-risk tasks over-verified | Evolution Engine (§12B) adjusts risk weights based on prediction error (A7). Immutable safety floor: any mutation touching production systems is always ≥ L3 regardless of risk score. Human can override risk assessment upward (never downward without audit). |

**Design principle:** Failure recovery follows a consistent pattern: **detect** (content hashes, prediction error, accuracy tracking) → **contain** (invalidate affected scope, not the whole system) → **recover** (rebuild from source of truth) → **learn** (feed failure into Evolution Engine).

---

## §13. Testing & Verification Strategy

### Phase 0 Success Criteria (→ arch §10, concept §12.1)

**Experimental Protocol:**

| Parameter | Value |
|:---|:---|
| **Baseline** | Claude Code performing N tasks without oracle gate |
| **Treatment** | Same agent + oracle gate hooks |
| **Task set** | ≥ 30 TypeScript mutation tasks, stratified: 10 simple (rename, add field), 10 moderate (refactor function, change interface), 10 complex (cross-module change) |
| **Primary metric** | Structural error rate: broken imports, type errors, wrong signatures, non-existent symbol references |
| **Minimum effect size** | ≥ 25% reduction in structural error rate (treatment vs baseline) |
| **Secondary metrics** | False positive rate (oracle rejects correct code) < 10%; latency overhead < 3s per mutation (L1 budget) |
| **Statistical test** | Paired comparison (same tasks, with/without oracle); Wilcoxon signed-rank test, α = 0.05 |
| **Go/No-Go** | Primary metric met AND false positive rate acceptable → proceed to Phase 1. Otherwise → analyze failure modes, iterate oracle design, or stop. |

> This is a pre-registered experimental design. Adjusting success criteria after observing results invalidates the experiment.

**Additional Operational Criteria:**

| Criterion | Target | Measurement |
|-----------|--------|-------------|
| Guardrails injection defense | 100% of test cases | Run injection pattern suite |
| Gate cycle latency | p50 ≤ 500ms, p99 ≤ 2,000ms | Measure end-to-end gate check per tool call |

**Per-Oracle Latency Budget:**

| Oracle | p99 Target | Rationale |
|--------|:----------:|----------|
| `ast-oracle` | ≤ 200ms | tree-sitter = fast, single-file parse |
| `type-oracle` | ≤ 1,500ms | `tsc --noEmit` on full project; configurable `timeout_behavior: 'warn'` |
| `dep-oracle` | ≤ 500ms | BFS import graph traversal |
| `test-oracle` | ≤ 5,000ms | Test execution is inherently slower; `timeout_behavior: 'warn'` recommended |
| `lint-oracle` | ≤ 1,000ms | Linter on target file(s) |

> **Enforcement**: If gate cycle p99 exceeds 2,000ms consistently (≥10% of calls over 5 sessions), the slowest oracle should be profiled and either optimized or switched to `timeout_behavior: 'warn'`.

### Test Harness Design `[Phase 0]`

```typescript
interface MutationTest {
  name: string;
  targetFile: string;
  mutation: string;            // what to change
  expectedOracleResult: 'block' | 'allow';
  oracles: string[];           // which oracles should catch this
}

const MUTATION_SUITE: MutationTest[] = [
  {
    name: 'wrong-param-count',
    targetFile: 'src/auth/login.ts',
    mutation: 'add third parameter to login()',
    expectedOracleResult: 'block',
    oracles: ['ast-oracle', 'type-oracle'],
  },
  {
    name: 'broken-import',
    targetFile: 'src/utils/index.ts',
    mutation: 'import non-existent module',
    expectedOracleResult: 'block',
    oracles: ['type-oracle', 'dep-oracle'],
  },
  {
    name: 'passing-lint',
    targetFile: 'src/config.ts',
    mutation: 'add unused import',
    expectedOracleResult: 'block',
    oracles: ['lint-oracle'],
  },
  // ... expand to ≥30 mutations for statistical significance
];
```

### Benchmark Methodology `[Phase 0]`

1. Define 20 representative coding tasks (mix of simple, moderate, complex)
2. Run each task twice: (a) with oracle-gate verification, (b) without
3. Measure: tokens consumed, success rate, time to completion, number of retries
4. Statistical comparison: paired t-test for token reduction, chi-square for success rate

### Phase 1 Success Criteria `[Phase 1]`

| Criterion | Target | Notes |
|-----------|--------|-------|
| PredictionError decrease | Composite error < 0.3 after 200 sessions | Track calibration curve |
| QualityScore correlation | r > 0.6 with human rating | Manual evaluation of 50 samples |
| Task decomposition success | DAG passes 5 criteria in ≤2 iterations | 90th percentile |
| Working Memory utilization | Failed approach reuse > 0 | Track approach blacklist hits |

---

## §14. Project Structure

### Flat `src/` Directory Layout

> **Note**: The project uses a flat `src/` structure (not the originally planned monorepo `packages/` layout).
> The key constraint is maintaining dependency direction: gate/orchestrator → oracle + world-graph, never the reverse.

```
vinyan-agent/
├── src/
│   ├── core/                      # EventBus, core types (HypothesisTuple, OracleVerdict, Evidence, Fact)
│   ├── oracle/                    # Reasoning Engine infrastructure
│   │   ├── ast/                   # AST oracle (tree-sitter: symbol-exists, function-signature)
│   │   ├── type/                  # Type oracle (tsc --noEmit)
│   │   ├── dep/                   # Dependency oracle (import graph, blast radius)
│   │   ├── test/                  # Test oracle (auto-detect runner: bun/vitest/pytest)
│   │   └── lint/                  # Lint oracle (ESLint/Ruff)
│   ├── gate/                      # Verification pipeline (risk-router, quality-score, tool-classifier)
│   ├── guardrails/                # Prompt injection + bypass detection (regex-based)
│   ├── orchestrator/              # Phase 1 Core Loop
│   │   ├── llm/                   # LLM provider abstraction (registry, OpenRouter, Anthropic, mock)
│   │   ├── tools/                 # Tool execution layer (file, shell, search, validation)
│   │   └── worker/                # Worker process management (subprocess isolation, artifact commit)
│   ├── world-graph/               # Content-addressed fact store (SQLite + file watcher + cascade)
│   ├── evolution/                  # Rule generator, backtester, safety invariants [Phase 2+]
│   ├── sleep-cycle/               # Pattern mining (Wilson CI, exponential decay, backtest) [Phase 2+]
│   ├── db/                        # SQLite stores (pattern, shadow, skill, rule, trace, worker)
│   ├── bus/                       # Event listeners (audit, cli-progress, trace)
│   ├── config/                    # Configuration loader + schema
│   ├── cli/                       # CLI entry points (vinyan gate, vinyan analyze, vinyan run)
│   └── observability/             # Health checks, system metrics [Phase 3+]
│
├── tests/                         # Mirrors src/ structure
│   ├── core/
│   ├── oracle/
│   ├── gate/
│   ├── orchestrator/
│   ├── world-graph/
│   ├── evolution/
│   ├── sleep-cycle/
│   └── db/
│
├── docs/                          # Design documents
│   ├── vinyan-concept.md
│   ├── vinyan-architecture.md
│   ├── vinyan-tdd.md             # ← this document
│   ├── vinyan-implementation-plan.md
│   └── vinyan-gap-analysis.md
│
├── vinyan.json                    # Project config (generated by CLI)
├── package.json
├── tsconfig.json
└── bunfig.toml
```

### Dependency Inventory

| Dependency | Purpose | Phase |
|-----------|---------|:-----:|
| `bun:sqlite` | SQLite persistence (zero-dependency, built-in) | 0+ |
| `zod` | Schema validation (IPC, config, oracle I/O) | 0+ |
| `chokidar` | File watching (World Graph invalidation) | 0+ |

### Build Configuration

```jsonc
// package.json
{
  "name": "vinyan-agent",
  "private": true,
  "scripts": {
    "test": "bun test",
    "lint": "tsc --noEmit"
  }
}
```

```jsonc
// tsconfig.json
{
  "compilerOptions": {
    "target": "ESNext",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "noEmit": true,
    "esModuleInterop": true,
    "paths": {
      "@vinyan/*": ["./src/*"]
    }
  },
  "include": ["src"]
}

---

## §15. Open Questions

| # | Question | Current Assumption | Impact if Wrong | Status |
|---|----------|-------------------|-----------------|--------|
| 1 | Oracle disagreements (ast pass, type fail)? | ~~Any-fail = block~~ 5-step contradiction resolution | Over-blocking valid changes | ✅ **Resolved** — Phase 4.5 WP-1 `conflict-resolver.ts` implements concept §3.2 |
| 2 | World Graph concurrent access? | Single writer (Orchestrator), read-only copies per worker | Race conditions if multiple writers | ⚠️ **Phase 5** — multi-instance requires local World Graph per instance + async merge (concept §11.5) |
| 3 | PHE depth for Level 3? | 2–3 levels of dependency analysis | Over/under-investment in perception | ✅ **Resolved** — depth tied to routing level: L0=0 (skip), L1=1 (direct deps), L2=2 (transitive), L3=2 + World Graph enrichment. Implemented in `perception-assembler.ts` |
| 4 | When does Orchestrator need LLM? | Task decomposition + Critic (Level 2+) | Wasted LLM calls or insufficient planning | ✅ **Resolved** — Phase 4.5 WP-2 LLM-as-Critic activates at L2+ |
| 5 | MCP "I don't know" representation? | Return empty result with epistemic metadata in JSON | Other agents can't parse epistemic state | ⚠️ Phase 5 PH5.5 — §19 specifies translation |
| 6 | Tool call batching / parallel execution? | Sequential by default, parallel for independent reads | Performance bottleneck on I/O-heavy tasks | ✅ **Resolved** — §10.4 specifies parallel DAG execution (bounded pool, `maxParallelSubtasks: 4`). Tool calls within a single subtask remain sequential (worker isolation), subtasks execute in parallel |
| 7 | L2 isolation: VM or Docker? | Docker for MVP | Insufficient isolation for security-critical | ⚠️ **Deferred** — L0-L2 use subprocess isolation (`Bun.spawn`), sufficient for current Phase 1-4 scope. L3 container isolation (Docker/microVM) deferred to Phase 5+ implementation. Decision: benchmark at L3 implementation time, not pre-decided |
| 8 | Self-Model calibration speed? | ~50–60% initial → >75% by 200 sessions | Slow calibration → Self-Model is overhead | ✅ **Resolved** — Phase 3 Self-Model implements 4 cold-start safeguards: (1) Bayesian prior (0.5 base), (2) sample size gate (≥5 traces before prediction), (3) EMA decay (α=0.3), (4) cross-task transfer. Calibration tracked via `PredictionError` in traces — systematic miscalibration triggers `selfmodel:recalibrate` event |
| 9 | Minimum QualityScore dims for Skill Formation? | 3 dimensions (arch + efficiency + complexity) | Premature skill formation from thin data | ✅ **Resolved** — Skill formation requires Wilson CI lower bound ≥ 0.6 on success rate with ≥10 matching traces. QualityScore dimensions are oracle-derived (not fixed count) — skill forms when pattern has sufficient statistical evidence regardless of dimension count. DataGate (`sleep_cycle_ready`) enforces ≥100 traces before any pattern mining |

---

# Phase 1 — Core Agent Specification

> **Context:** Phase 0 proved that epistemic verification works (253 tests, A1/A3/A4/A5/A6 validated). Sections §16–§19 specify what transforms Vinyan from a verification library into a **complete autonomous AI agent**. These sections are implementation contracts with interfaces, algorithms, and test criteria — not design-level direction.
>
> **Dependency:** §16 (Orchestrator Core Loop) ← §10 (Lifecycle) + §11 (Orchestrator). §17 (Generator) ← §16. §18 (Tools) ← §16. §19 (MCP) ← §17 + §18.

---

## §16. Orchestrator Core Loop `[Phase 1]`

> → arch D7, D9 | Axiom: A3 (deterministic governance), A6 (zero-trust execution)

The Orchestrator Core Loop is the **central nervous system** of Vinyan — the single deterministic process that owns the entire task lifecycle. It receives a task, orchestrates all subsystems (Generator, Verifier, Tools, World Graph), and produces a verified result.

### 16.1 Core Loop Entry Point

```typescript
interface TaskInput {
  id: string;
  source: 'cli' | 'api' | 'mcp';
  goal: string;                           // Natural language task description
  targetFiles?: string[];                 // Optional explicit scope
  constraints?: string[];                 // User-specified constraints
  budget: {
    maxTokens: number;                    // Total tokens for this task
    maxDurationMs: number;                // Wall-clock timeout
    maxRetries: number;                   // Default: 3 per routing level
  };
  acceptanceCriteria?: string[];          // User-provided machine-checkable criteria (Phase 1+)
                                          // e.g., ["all tests pass", "no new lint warnings", "function X returns Y for input Z"]
}

interface TaskResult {
  id: string;
  status: 'completed' | 'failed' | 'escalated' | 'uncertain';  // A2: 'uncertain' when all workers below capability threshold
  mutations: Array<{
    file: string;
    diff: string;                         // Unified diff
    oracleVerdicts: Record<string, OracleVerdict>;
  }>;
  trace: ExecutionTrace;
  qualityScore?: QualityScore;
  escalationReason?: string;              // If status === 'escalated'
  notes?: string[];                       // [Phase 4] audit notes (e.g., probation-shadow-only, uncertain)
}
```

### 16.2 Core Loop Algorithm

```typescript
async function executeTask(input: TaskInput): Promise<TaskResult> {
  const workingMemory = WorkingMemoryState.create(input.id);
  let routingLevel = await riskRouter.assessInitialLevel(input);

  for (let escalation = 0; escalation < 4; escalation++) {   // L0 → L1 → L2 → L3 → human
    const retryBudget = input.budget.maxRetries;

    for (let retry = 0; retry < retryBudget; retry++) {
      // ── PERCEIVE ──────────────────────────────────────────
      const perception = await perceptionAssembler.assemble(input, routingLevel);
      // Injects: dependency cone, diagnostics, verified facts, runtime context

      // ── PREDICT (Level 2-3 only) ─────────────────────────
      let prediction: SelfModelPrediction | undefined;
      if (routingLevel >= 2) {
        prediction = await selfModel.predict(input, perception);
        workingMemory.addUncertainties(prediction.uncertainAreas);
      }

      // ── PLAN (Level 2-3 only) ─────────────────────────────
      let plan: TaskDAG | undefined;
      if (routingLevel >= 2) {
        plan = await taskDecomposer.decompose(input, perception, workingMemory);
        // Validates: no orphans, no overlap, coverage, topo sort, verification specified
      }

      // ── GENERATE ──────────────────────────────────────────
      const workerInput = assembleWorkerInput(input, perception, workingMemory, plan);
      const workerOutput = await workerPool.dispatch(workerInput, routingLevel);
      // Worker calls LLM (Generator Engine, §17) and proposes tool calls + mutations

      // ── TOOL EXECUTION (Orchestrator-mediated) ────────────
      const toolResults = await toolExecutor.executeProposedTools(
        workerOutput.toolCalls,
        routingLevel,
        input.targetFiles ?? [],
      );

      // ── VERIFY ────────────────────────────────────────────
      const verdicts = await oracleGate.verify(workerOutput.proposal, perception);
      const qualityScore = computeQualityScore(verdicts, workerOutput);

      // ── CRITIC (Level 2-3 only, after structural oracles pass) ──
      // Semantic verification: LLM-as-Critic reviews the proposal for correctness
      // beyond what structural oracles can catch. Returns 'uncertain' type verdicts.
      // See §17.6 Critic Engine for implementation details.
      let criticPassed = true;
      if (routingLevel >= 2 && allOraclesPass(verdicts)) {
        const criticResult = await criticEngine.review(
          workerOutput.proposal,
          input,
          perception,
          input.acceptanceCriteria,
        );
        if (!criticResult.approved) {
          criticPassed = false;
          workingMemory.recordFailedApproach({
            approach: workerOutput.proposal.explanation,
            oracleVerdict: `Critic rejection: ${criticResult.reason}`,
            timestamp: Date.now(),
          });
        }
        // Critic verdicts are appended with type: 'uncertain'
        Object.assign(verdicts, criticResult.verdicts);
      }

      // ── TEST GENERATION (Level 2-3 only, if Critic passes) ──────
      // Generate targeted test cases for the proposed changes, run them,
      // and use failures as semantic signal. See §17.7 Test Generation.
      if (routingLevel >= 2 && criticPassed && allOraclesPass(verdicts)) {
        const testGenResult = await testGenerator.generateAndRun(
          workerOutput.proposal,
          perception,
        );
        if (testGenResult.failures.length > 0) {
          criticPassed = false;
          workingMemory.recordFailedApproach({
            approach: workerOutput.proposal.explanation,
            oracleVerdict: `Generated test failures: ${testGenResult.failures.map(f => f.name).join(', ')}`,
            timestamp: Date.now(),
          });
        }
      }

      if (allOraclesPass(verdicts) && criticPassed) {
        // ── LEARN (success) ─────────────────────────────────
        const predictionError = prediction
          ? computePredictionError(prediction, verdicts, qualityScore)
          : undefined;

        await traceCollector.record({
          taskId: input.id,
          outcome: 'success',
          routingLevel,
          oracleVerdicts: verdicts,
          qualityScore,
          predictionError,
          tokensUsed: workerOutput.tokensUsed,
        });

        await worldGraph.commitFacts(verdicts);

        return {
          id: input.id,
          status: 'completed',
          mutations: workerOutput.proposal.files.map(f => ({
            file: f.path,
            diff: f.diff,
            oracleVerdicts: verdicts,
          })),
          trace: traceCollector.getTrace(input.id),
          qualityScore,
        };
      }

      // ── LEARN (failure → replan with evidence) ────────────
      workingMemory.recordFailedApproach({
        approach: workerOutput.proposal.explanation,
        oracleVerdict: formatFailures(verdicts),
        timestamp: Date.now(),
      });

      await traceCollector.record({
        taskId: input.id,
        outcome: 'failure',
        routingLevel,
        oracleVerdicts: verdicts,
        failureReason: formatFailures(verdicts),
      });

      // Re-enter at PLAN step (not GENERATE) with updated WorkingMemory
    }

    // All retries exhausted at this routing level → escalate
    routingLevel = Math.min(routingLevel + 1, 3) as RoutingLevel;
    if (routingLevel > 3) break;
  }

  // Level 3 exhausted → human escalation
  return {
    id: input.id,
    status: 'escalated',
    mutations: [],
    trace: traceCollector.getTrace(input.id),
    escalationReason: `Failed after ${input.budget.maxRetries} retries across all routing levels. WorkingMemory contains ${workingMemory.failedApproaches.length} failed approaches.`,
  };
}
```

### 16.3 Worker Pool Management

```typescript
interface WorkerPoolManager {
  // Dispatch task to a worker at the appropriate isolation level
  dispatch(input: WorkerInput, level: RoutingLevel): Promise<WorkerOutput>;

  // Fork a new worker process (L1) or container (L2)
  fork(level: IsolationLevel): Promise<WorkerProcess>;

  // Kill a worker (timeout, budget exceeded, stuck detection)
  kill(workerId: string, reason: string): void;

  // Get pool status
  status(): { active: number; idle: number; killed: number };
}

interface WorkerProcess {
  id: string;
  pid: number;
  isolationLevel: 0 | 1 | 2;
  startedAt: number;
  budget: WorkerBudget;
  status: 'idle' | 'running' | 'killed';
}
```

**Worker lifecycle for L1 (default):**
1. Orchestrator forks child process via `child_process.fork()`
2. Writes `WorkerInput` to worker's stdin as JSON
3. Worker reads input, calls LLM Generator (§17), proposes tool calls
4. Worker writes `WorkerOutput` to stdout as JSON
5. Worker exits with code 0 (success) or 1 (error)
6. Orchestrator reads output, validates, runs Oracle verification
7. If worker exceeds `budget.timeoutMs` → `SIGKILL` + record timeout

### 16.4 Acceptance Criteria

| # | Criterion | Test |
|:--|:----------|:-----|
| 1 | Orchestrator completes a simple file edit task end-to-end | Given a task "add export to function X" → generates code → passes ast-oracle → commits mutation |
| 2 | Failed approach recorded in WorkingMemory | Given Oracle rejection → WorkingMemory.failedApproaches.length increases → next generation receives constraint |
| 3 | Routing escalation works | Given Level 1 task fails 3 times → auto-escalates to Level 2 → re-enters with planning |
| 4 | Worker timeout enforced | Given worker exceeds budget.timeoutMs → killed within 1s → trace records "timeout" |
| 5 | Same input → same dispatch plan (A3) | Given identical TaskInput + identical WorkingMemory → produces identical routing, plan, and worker assignment |
| 6 | Zero-trust tool execution | Given worker proposes file_write at L0 → rejected → worker proposes at L1 → allowed within allowedPaths |
| 7 | Human escalation on exhaustion | Given all routing levels fail → returns status:'escalated' with full WorkingMemory context |
| 8 | World Graph updated on success | Given task completes → new verified facts appear in World Graph with correct file hashes |

---

## §17. LLM Generator Engine `[Phase 1]`

> → arch D12 | Axiom: A1 (epistemic separation — LLM generates, Oracles verify), A2 (LLM output wrapped with uncertainty)

The LLM Generator Engine wraps LLM providers as **Generator-class Reasoning Engines**. LLMs propose solutions; they never verify their own output. All LLM responses are wrapped in ECP with `type: 'uncertain'` before entering the Verification Gate.

### 17.1 Provider Registry

```typescript
interface LLMProviderRegistry {
  // Register a new provider
  register(provider: LLMProvider): void;

  // Select provider based on routing level and budget
  selectProvider(level: RoutingLevel, budget: TokenBudget): LLMProvider;

  // List registered providers
  list(): LLMProvider[];
}

interface LLMProvider {
  id: string;                              // "anthropic/claude-sonnet", "openai/gpt-4o", "ollama/llama3"
  type: 'cloud' | 'local';
  tier: 'fast' | 'balanced' | 'powerful';
  capabilities: ('code-generation' | 'planning' | 'critique')[];
  costPerMToken: number;                   // Normalized cost in Vinyan Credits
  maxContextTokens: number;
  supportsToolUse: boolean;                // Can the model call tools natively?
  supportsStreaming: boolean;

  generate(request: LLMRequest): Promise<LLMResponse>;
}

interface LLMRequest {
  systemPrompt: string;                    // Orchestrator-assembled
  userPrompt: string;                      // Task + context
  maxTokens: number;
  temperature: number;
  tools?: ToolDefinition[];                // Available tools (§18)
  responseFormat?: 'text' | 'json' | 'diff'; // Expected output format
}

interface LLMResponse {
  content: string;
  toolCalls?: ToolCall[];                  // Proposed tool calls (NOT yet executed)
  tokensUsed: { input: number; output: number };
  model: string;
  stopReason: 'end_turn' | 'max_tokens' | 'tool_use';  // Anthropic API naming convention
}
```

### 17.2 Prompt Construction Pipeline

```typescript
interface PromptAssembler {
  /**
   * Assemble a complete prompt from Orchestrator context.
   * System prompt = perception + constraints + output format
   * User prompt = task + working memory + plan
   */
  assemble(
    task: TaskInput,
    perception: PerceptualHierarchy,
    memory: WorkingMemoryState,
    plan?: TaskDAG,
  ): { systemPrompt: string; userPrompt: string };
}
```

**System prompt structure:**

```
[ROLE] You are a coding worker in the Vinyan ENS. You generate code proposals.
       Your output will be verified by external oracles — do NOT self-evaluate.

[PERCEPTION] Current state of relevant files:
  - {dependency cone files with content}
  - {diagnostics: lint warnings, type errors}
  - {verified facts from World Graph}

[CONSTRAINTS]
  - Do NOT try these approaches (failed before): {WorkingMemory.failedApproaches}
  - Allowed file scope: {allowedPaths}
  - Available tools: {toolDefinitions}

[OUTPUT FORMAT]
  Respond with structured JSON: { explanation, files: [{ path, diff }], toolCalls: [...] }
```

**User prompt structure:**

```
[TASK] {goal}
[PLAN] {plan steps, if Level 2-3}
[HYPOTHESES] {WorkingMemory.activeHypotheses}
[UNCERTAINTIES] {WorkingMemory.unresolvedUncertainties}
```

### 17.3 ECP Wrapping

```typescript
function wrapLLMResponse(
  response: LLMResponse,
  selfModelConfidence: number,
  verificationCriteria: string[],
): ECPResponse {
  return {
    type: 'uncertain',                     // ALWAYS — LLM output is never verified
    confidence: selfModelConfidence,       // From Self-Model, NOT from LLM self-assessment
    evidence_chain: [],                    // LLM provides no verified evidence
    falsifiable_by: verificationCriteria,  // What oracles will check
  };
}
```

**Key invariant:** `confidence` comes from the Self-Model's prediction (§12), NEVER from the LLM's own claim of certainty. This is the operational core of A1 (Epistemic Separation).

### 17.4 Provider Routing

| Routing Level | Default Tier | Temperature | Token Budget | Use Case |
|:-------------|:------------|:-----------:|:------------:|:---------|
| Level 0 (Reflex) | fast | 0.0 | 5K | Cached pattern retrieval + minor adaptation |
| Level 1 (Heuristic) | fast | 0.1 | 10K | Single-pass generation, straightforward tasks |
| Level 2 (Analytical) | balanced | 0.3 | 50K | Multi-pass with planning, moderate complexity |
| Level 3 (Deliberative) | powerful | 0.5 | 100K | Parallel hypothesis exploration, complex tasks |

**Configuration:** Provider routing is project-configurable via `vinyan.json`:

```jsonc
{
  "llm": {
    "providers": {
      "default-fast": { "id": "anthropic/claude-haiku", "tier": "fast" },
      "default-balanced": { "id": "anthropic/claude-sonnet", "tier": "balanced" },
      "default-powerful": { "id": "anthropic/claude-opus", "tier": "powerful" }
    },
    "routing": {
      "level0": "default-fast",
      "level1": "default-fast",
      "level2": "default-balanced",
      "level3": "default-powerful"
    }
  }
}
```

### 17.5 Acceptance Criteria

| # | Criterion | Test |
|:--|:----------|:-----|
| 1 | Provider registry supports ≥3 providers | Register Claude, GPT, Ollama → all accessible via `selectProvider()` |
| 2 | Prompt contains WorkingMemory constraints | Given 2 failed approaches → system prompt contains "Do NOT try" for both |
| 3 | LLM response wrapped as `type: 'uncertain'` | ANY LLM response → ECPResponse.type === 'uncertain' |
| 4 | Confidence from Self-Model, not LLM | LLM says "I'm 95% confident" → ECPResponse.confidence = Self-Model's prediction (e.g., 0.6) |
| 5 | Token budget enforced | Request exceeds budget → provider call truncated or rejected BEFORE sending |
| 6 | Provider routing respects config | Level 2 task → uses `default-balanced` from vinyan.json |
| 7 | Tool calls proposed but NOT executed | LLM returns toolCalls → WorkerOutput contains them → Orchestrator executes (not worker) |

### 17.6 Critic Engine (Semantic Verification) `[Phase 1]`

> → concept §6 (Semantic Verification Strategy) | Axiom: A1 (LLM generates, separate LLM criticizes — never self-evaluation)

The Critic Engine implements **LLM-as-Critic** — a second LLM call that reviews the Generator's output for semantic correctness. It catches issues that structural oracles cannot: logic errors, misunderstood requirements, incomplete implementations, subtle behavioral regressions.

**Key constraint (A1 compliance):** The Critic Engine MUST use a **different LLM call** from the Generator. Same provider is acceptable; same conversation context is NOT. The Critic receives the proposal and the original task — it does not receive the Generator's reasoning chain.

```typescript
interface CriticEngine {
  review(
    proposal: WorkerProposal,
    task: TaskInput,
    perception: PerceptualHierarchy,
    acceptanceCriteria?: string[],        // From TaskInput.acceptanceCriteria
  ): Promise<CriticResult>;
}

interface CriticResult {
  approved: boolean;
  reason?: string;                        // Why rejected — injected into WorkingMemory
  verdicts: Record<string, OracleVerdict>;  // Keyed by 'critic-<aspect>'
  confidence: number;                     // Critic's meta-confidence
  aspects: Array<{
    name: string;                         // e.g., 'logic-correctness', 'requirement-coverage'
    passed: boolean;
    explanation: string;
  }>;
  tokensUsed: { input: number; output: number };
}
```

**Critic Rubric:** The Critic is prompted with a structured rubric, NOT free-form review:

| Aspect | Question | Signal |
|:-------|:---------|:-------|
| Requirement coverage | Does the change address ALL stated goals? | TaskInput.goal + acceptanceCriteria |
| Logic correctness | Are there off-by-one errors, null derefs, or incorrect conditionals? | Proposal code + perception diagnostics |
| Side effects | Does the change break anything outside its stated scope? | PerceptualHierarchy.dependencyCone |
| Completeness | Are there TODO/FIXME markers or half-finished implementations? | Proposal code |
| Consistency | Does the change follow existing patterns in the codebase? | Perception.verifiedFacts |

**ECP compliance:** Critic verdicts are registered as `probabilistic` tier reasoning engine output. All verdicts carry `type: 'uncertain'` because Critic is an LLM. Critic confidence is bounded by Self-Model calibration data (not self-assessed).

**Activation:** Critic step is only invoked at **L2+ routing levels** and only **after structural oracles pass**. L0-L1 tasks skip the Critic entirely — deterministic oracles are sufficient for low-risk changes.

### 17.7 Test Generation Strategy `[Phase 1]`

> → concept §6 (test generation as semantic signal) | Axiom: A4 (generated tests produce content-addressed evidence)

After code generation, the system generates targeted test cases for the proposed changes, runs them, and uses failures as a semantic verification signal. This is a **generative verification** strategy — it creates new tests, not just runs existing ones.

```typescript
interface TestGenerator {
  generateAndRun(
    proposal: WorkerProposal,
    perception: PerceptualHierarchy,
  ): Promise<TestGenResult>;
}

interface TestGenResult {
  generatedTests: Array<{
    name: string;
    code: string;
    targetFunction: string;
    category: 'happy-path' | 'edge-case' | 'regression' | 'acceptance';
  }>;
  results: Array<{
    name: string;
    passed: boolean;
    error?: string;
    duration_ms: number;
  }>;
  failures: Array<{
    name: string;
    error: string;
    evidence: Evidence;                   // A4 compliance — test failure is evidence
  }>;
  tokensUsed: { input: number; output: number };
}
```

**Generation strategy:**
1. **Acceptance criteria tests:** If `TaskInput.acceptanceCriteria` is provided, generate one test per criterion
2. **Boundary tests:** Generate edge-case tests for any new/modified functions (null inputs, empty arrays, boundary values)
3. **Regression tests:** If the proposal modifies existing functions, generate tests that verify existing behavior is preserved

**Activation:** Same as Critic — L2+ only, after structural oracles and Critic pass. Tests run in the worker's isolation context (child_process for L1-L2, Docker for L3).

**Failure handling:** Generated test failures do NOT immediately reject the proposal. Instead:
- Failures are recorded in WorkingMemory as evidence
- The proposal re-enters the lifecycle at PLAN step with test failure context
- The Generator receives "test X failed with error Y — fix the implementation or explain why the test expectation is wrong"

---

## §18. Tool Execution Layer `[Phase 1]`

> → arch D13 | Axiom: A6 (zero-trust execution — workers propose, Orchestrator executes)

The Tool Execution Layer provides the **environment interaction** capability that makes Vinyan a complete agent. Workers propose tool calls; the Orchestrator validates permissions and executes tools in the appropriate isolation context.

### 18.1 Tool Interface

```typescript
interface Tool {
  name: string;
  description: string;
  parameters: Record<string, ToolParameter>;
  minIsolationLevel: 0 | 1 | 2;
  category: 'read' | 'write' | 'execute' | 'observe' | 'external';

  execute(args: Record<string, unknown>, context: ToolContext): Promise<ToolResult>;
}

interface ToolParameter {
  type: 'string' | 'number' | 'boolean' | 'array';
  description: string;
  required: boolean;
}

interface ToolContext {
  workspaceRoot: string;
  allowedPaths: string[];                 // From WorkerBudget
  isolationLevel: 0 | 1 | 2;
  taskId: string;
}

interface ToolResult {
  callId: string;                         // References ToolCall.id
  tool: string;                           // Tool name that was executed
  status: 'success' | 'error' | 'denied'; // Denied = permission/isolation rejection
  output?: unknown;                       // Tool-specific output
  error?: string;                         // Error message if status !== 'success'
  evidence?: Evidence;                    // A4 compliance — file tools produce content hashes
  duration_ms: number;
}

interface ToolCall {
  id: string;                             // Unique call identifier
  tool: string;
  parameters: Record<string, unknown>;    // Renamed from 'arguments' for consistency with code
}
```

### 18.2 Built-in Tools

```typescript
const BUILTIN_TOOLS: Tool[] = [
  // ── READ TOOLS ────────────────────────────────────────────
  {
    name: 'file_read',
    description: 'Read file contents (full or line range)',
    parameters: {
      path: { type: 'string', description: 'Relative file path', required: true },
      startLine: { type: 'number', description: 'Start line (1-indexed)', required: false },
      endLine: { type: 'number', description: 'End line (1-indexed)', required: false },
    },
    minIsolationLevel: 0,
    category: 'read',
  },
  {
    name: 'directory_list',
    description: 'List directory contents',
    parameters: {
      path: { type: 'string', description: 'Relative directory path', required: true },
    },
    minIsolationLevel: 0,
    category: 'read',
  },
  {
    name: 'search_grep',
    description: 'Search for text pattern in workspace files',
    parameters: {
      pattern: { type: 'string', description: 'Search pattern (regex)', required: true },
      includePattern: { type: 'string', description: 'Glob pattern for files', required: false },
    },
    minIsolationLevel: 0,
    category: 'read',
  },

  // ── WRITE TOOLS ───────────────────────────────────────────
  {
    name: 'file_write',
    description: 'Create or overwrite a file',
    parameters: {
      path: { type: 'string', description: 'Relative file path', required: true },
      content: { type: 'string', description: 'File content', required: true },
    },
    minIsolationLevel: 1,
    category: 'write',
  },
  {
    name: 'file_edit',
    description: 'Edit a file by replacing a string',
    parameters: {
      path: { type: 'string', description: 'Relative file path', required: true },
      oldString: { type: 'string', description: 'Exact string to replace', required: true },
      newString: { type: 'string', description: 'Replacement string', required: true },
    },
    minIsolationLevel: 1,
    category: 'write',
  },

  // ── EXECUTE TOOLS ─────────────────────────────────────────
  {
    name: 'shell_exec',
    description: 'Execute a shell command (allowlist enforced at L1)',
    parameters: {
      command: { type: 'string', description: 'Shell command', required: true },
      cwd: { type: 'string', description: 'Working directory', required: false },
      timeoutMs: { type: 'number', description: 'Timeout in ms', required: false },
    },
    minIsolationLevel: 1,
    category: 'execute',
  },

  // ── OBSERVE TOOLS ─────────────────────────────────────────
  {
    name: 'git_status',
    description: 'Get git status of workspace',
    parameters: {},
    minIsolationLevel: 0,
    category: 'observe',
  },
  {
    name: 'git_diff',
    description: 'Get git diff (staged or unstaged)',
    parameters: {
      staged: { type: 'boolean', description: 'Show staged changes', required: false },
    },
    minIsolationLevel: 0,
    category: 'observe',
  },
];
```

### 18.3 Permission Validation

```typescript
interface ToolExecutor {
  /**
   * Validate and execute proposed tool calls.
   * Returns results for each call, with denied calls returning error ToolResults.
   */
  executeProposedTools(
    calls: ToolCall[],
    isolationLevel: IsolationLevel,
    allowedPaths: string[],
  ): Promise<ToolResult[]>;
}

function validateToolCall(
  call: ToolCall,
  tool: Tool,
  isolationLevel: IsolationLevel,
  allowedPaths: string[],
): { allowed: boolean; reason?: string } {
  // 1. Check isolation level
  if (isolationLevel < tool.minIsolationLevel) {
    return { allowed: false, reason: `${tool.name} requires isolation level ${tool.minIsolationLevel}, current: ${isolationLevel}` };
  }

  // 2. Check path permissions (for file operations)
  if (tool.category === 'write' && call.parameters.path) {
    const path = call.parameters.path as string;
    if (!allowedPaths.some(p => path.startsWith(p))) {
      return { allowed: false, reason: `Path ${path} not in allowed paths` };
    }
  }

  // 3. Check shell command allowlist (L1 only — L2 has full sandbox)
  if (tool.name === 'shell_exec' && isolationLevel === 1) {
    const cmd = call.parameters.command as string;
    if (!SHELL_ALLOWLIST.some(allowed => cmd.startsWith(allowed))) {
      return { allowed: false, reason: `Command '${cmd}' not in L1 shell allowlist` };
    }
  }

  // 4. Check for bypass/injection patterns (A6 guardrail)
  if (containsBypassPattern(JSON.stringify(call.parameters))) {
    return { allowed: false, reason: 'Tool call contains bypass/injection pattern' };
  }

  return { allowed: true };
}

const SHELL_ALLOWLIST = [
  'tsc', 'bun test', 'bun run', 'ruff', 'eslint', 'prettier',
  'git status', 'git log', 'git diff', 'git show',
  'node', 'python', 'cat', 'head', 'tail', 'wc', 'grep', 'find',
];
```

### 18.4 Tool Result → ECP Evidence

```typescript
function toolResultToEvidence(result: ToolResult, call: ToolCall): ECPEvidence {
  return {
    source: `tool://${call.tool}`,
    file: result.evidence?.file,
    contentHash: result.evidence?.contentHash,
    timestamp: result.evidence?.timestamp ?? Date.now(),
    confidence: result.success ? 1.0 : 0.0,  // Tool results are deterministic facts
    raw: result.output,
  };
}
```

### 18.5 Acceptance Criteria

| # | Criterion | Test |
|:--|:----------|:-----|
| 1 | file_read works at L0 | Worker at L0 proposes file_read → executed successfully → returns content |
| 2 | file_write blocked at L0 | Worker at L0 proposes file_write → rejected with reason |
| 3 | file_write works at L1 within allowedPaths | Worker at L1 proposes file_write to allowed path → executed |
| 4 | file_write blocked outside allowedPaths | Worker at L1 proposes file_write to `/etc/passwd` → rejected |
| 5 | shell_exec allowlist enforced at L1 | `tsc --noEmit` → allowed; `rm -rf /` → rejected |
| 6 | Bypass pattern detected and blocked | Tool call containing "skip validation" → rejected by guardrail |
| 7 | Tool results have content hash (A4) | file_write → result.evidence.contentHash = SHA-256 of written content |
| 8 | All tool results wrapped as ECP evidence | Each ToolResult → ECPEvidence with source, timestamp, confidence |

---

## §19. MCP External Interface `[Phase 1B]`

> → arch D14 | Axiom: A2 (MCP results lack epistemic metadata — bridge must add uncertainty markers)

Phase 1B extension. Vinyan as both **MCP client** (consume external tools from other MCP servers) and **MCP server** (expose Oracles and World Graph to other agents like Claude Code, HiClaw). Not required for Phase 1A core agent — Vinyan is fully functional with built-in tools (§18).

### 19.1 MCP Client — Consume External Tools

```typescript
interface MCPClientBridge {
  // Connect to an MCP server (stdio or HTTP)
  connect(server: MCPServerConfig): Promise<void>;

  // Discover available tools from connected servers
  discoverTools(): Promise<ToolDefinition[]>;

  // Execute a tool on an MCP server, wrapping result in ECP
  executeTool(server: string, call: ToolCall): Promise<ECPResponse>;

  // Disconnect from a server
  disconnect(server: string): void;
}

interface MCPServerConfig {
  id: string;                              // "github-mcp", "db-mcp", etc.
  transport: 'stdio' | 'http';
  command?: string;                        // For stdio: command to launch server
  url?: string;                            // For HTTP: server URL
  trustLevel: 'untrusted' | 'semi-trusted' | 'trusted';
}
```

**ECP wrapping for MCP results:**

```typescript
function wrapMCPToolResult(
  result: MCPToolResult,
  serverConfig: MCPServerConfig,
): ECPResponse {
  const confidence = {
    'untrusted': 0.3,
    'semi-trusted': 0.5,
    'trusted': 0.7,                        // Never 1.0 — only Oracles produce verified facts
  }[serverConfig.trustLevel];

  return {
    type: 'uncertain',                     // MCP tools have no epistemic guarantees
    confidence,
    evidence_chain: [{
      source: `mcp://${serverConfig.id}/${result.tool}`,
      raw: result.content,
      timestamp: Date.now(),
    }],
    falsifiable_by: ['oracle-verification'],
  };
}
```

### 19.2 MCP Server — Expose Oracles

```typescript
const VINYAN_MCP_TOOLS = [
  {
    name: 'vinyan_ast_verify',
    description: 'Verify symbol existence, function signatures, import relationships via tree-sitter AST analysis',
    inputSchema: {
      type: 'object',
      properties: {
        target: { type: 'string', description: 'File path or symbol (e.g., "src/auth.ts::login")' },
        pattern: { type: 'string', description: 'What to verify (e.g., "function accepts 2 parameters")' },
        workspace: { type: 'string', description: 'Workspace root path' },
      },
      required: ['target', 'pattern', 'workspace'],
    },
  },
  {
    name: 'vinyan_type_check',
    description: 'Run TypeScript type checker on workspace and verify specific hypothesis',
    inputSchema: {
      type: 'object',
      properties: {
        target: { type: 'string', description: 'File or symbol to check' },
        pattern: { type: 'string', description: 'Type assertion to verify' },
        workspace: { type: 'string', description: 'Workspace root path' },
      },
      required: ['target', 'workspace'],
    },
  },
  {
    name: 'vinyan_blast_radius',
    description: 'Calculate which files are affected by changing a target file/symbol',
    inputSchema: {
      type: 'object',
      properties: {
        target: { type: 'string', description: 'File or symbol being changed' },
        workspace: { type: 'string', description: 'Workspace root path' },
        depth: { type: 'number', description: 'Max traversal depth (default: 5)' },
      },
      required: ['target', 'workspace'],
    },
  },
  {
    name: 'vinyan_query_facts',
    description: 'Query verified facts from World Graph for a target',
    inputSchema: {
      type: 'object',
      properties: {
        target: { type: 'string', description: 'File or symbol to query facts about' },
        workspace: { type: 'string', description: 'Workspace root path' },
      },
      required: ['target', 'workspace'],
    },
  },
];
```

### 19.3 ECP↔MCP Bridge Translation

| Direction | Source | Translation | Destination |
|:----------|:-------|:------------|:------------|
| MCP → ECP | MCP tool result (raw string/JSON) | Wrap with `type: 'uncertain'`, confidence from trustLevel, require Oracle verification | ECPResponse |
| ECP → MCP | OracleVerdict (verified: bool, evidence[], confidence) | Flatten to MCP tool result: JSON with `{ verified, evidence, confidence }` in result content | MCP tool result |
| ECP → MCP | `type: 'unknown'` (Oracle doesn't know) | Return MCP result with `{ verified: null, reason: "insufficient evidence" }` | MCP tool result |

### 19.4 Configuration

```jsonc
{
  "mcp": {
    "client": {
      "servers": [
        {
          "id": "github",
          "transport": "stdio",
          "command": "npx -y @modelcontextprotocol/server-github",
          "trustLevel": "semi-trusted"
        }
      ]
    },
    "server": {
      "enabled": true,
      "transport": "stdio",
      "exposedTools": ["vinyan_ast_verify", "vinyan_type_check", "vinyan_blast_radius", "vinyan_query_facts"]
    }
  }
}
```

### 19.5 Acceptance Criteria

| # | Criterion | Test |
|:--|:----------|:-----|
| 1 | MCP client connects to stdio server | Connect to mock MCP server → discover tools → execute tool → receive result |
| 2 | MCP results wrapped with uncertainty | MCP tool returns raw string → ECPResponse.type === 'uncertain', confidence ≤ 0.7 |
| 3 | Trust level affects confidence | 'untrusted' server → confidence 0.3; 'trusted' → 0.7 |
| 4 | MCP server exposes 4 Vinyan tools | External MCP client lists tools → sees vinyan_ast_verify, vinyan_type_check, vinyan_blast_radius, vinyan_query_facts |
| 5 | Oracle verdict flows through MCP | External agent calls vinyan_ast_verify → receives JSON with `{ verified, evidence, confidence }` |
| 6 | "I don't know" handled gracefully | Oracle returns type:'unknown' → MCP result contains `{ verified: null, reason }` |

> **Note:** Open questions previously mixed into this table have been relocated to §15 Open Questions.

---

---

# Phase 5 — Self-Hosted ENS Specification

> **Context:** Phases 0–4 proved the Vinyan thesis: verification works, the Orchestrator drives autonomous tasks, pattern mining compresses experience, and fleet governance selects workers. Sections §20–§23 specify what transforms Vinyan from a CLI agent into a **standalone platform** with multi-instance coordination and cross-language support. These sections are implementation contracts with interfaces, algorithms, and test criteria.
>
> **Dependency:** §20 (Migration) ← all Phase 5 components. §21 (Plugin System) ← §20. §22 (API + Session) ← §20. §23 (Coordinator) ← §22 + [vinyan-a2a-protocol.md](vinyan-a2a-protocol.md).

---

## §20. Schema Migration Framework `[Phase 5]`

> → arch D18 | Axiom: A4 (content-addressed truth must survive migration)

**Prerequisite for all Phase 5 components.** Replaces `CREATE TABLE IF NOT EXISTS` pattern with versioned forward-only migrations.

### 20.1 Schema Version Table

```sql
CREATE TABLE IF NOT EXISTS schema_version (
  version    INTEGER PRIMARY KEY,
  applied_at INTEGER NOT NULL DEFAULT (unixepoch()),
  description TEXT NOT NULL
);
```

### 20.2 Migration Runner Interface

```typescript
interface Migration {
  version: number;
  description: string;
  up(db: Database): void;         // forward-only — no down()
}

interface MigrationRunner {
  /** Get current schema version. Returns 0 if no migrations applied. */
  getCurrentVersion(db: Database): number;

  /** Apply all pending migrations in order. Idempotent. */
  migrate(db: Database, migrations: Migration[], options?: {
    dryRun?: boolean;              // default: false — if true, return pending migrations without applying
  }): {
    applied: number[];             // versions applied in this run (empty if dryRun)
    current: number;               // final version after migration (unchanged if dryRun)
    pending: number[];             // versions that would be applied (always populated)
  };
}
```

### 20.3 Migration Directory Structure

```
src/db/migrations/
  001_initial_schema.ts           // Phase 0-4 baseline (CREATE TABLE IF NOT EXISTS → versioned)
  002_add_dependency_edges.ts     // World Graph edges (WP-3)
  003_add_session_tables.ts       // Phase 5: session_store, session_task
  004_add_instance_registry.ts    // Phase 5: multi-instance identity
```

### 20.4 Migration Constraints

- **Forward-only:** No `down()` method. Rollback = restore from backup
- **Additive-only:** `ALTER TABLE ADD COLUMN` permitted. No column drops, renames, or type changes
- **Atomic per-migration:** Each migration runs in a transaction. On failure → rollback that migration, stop
- **Startup execution:** Run before any database access in `VinyanDB` constructor
- **A4 preservation:** File hashes, evidence chains, fact_evidence_files, and cascade invalidation triggers must survive all migrations unchanged

### 20.5 Acceptance Criteria

| # | Criterion | Test |
|:--|:----------|:-----|
| 1 | Fresh install applies all migrations | Empty DB → `migrate()` → all tables exist, schema_version tracks applied |
| 2 | Existing Phase 4 DB upgrades without data loss | Pre-populated DB → `migrate()` → all existing facts, traces, rules intact |
| 3 | Idempotent re-run | Run `migrate()` twice → second run applies 0 migrations |
| 4 | Failed migration rolls back | Migration 3 throws → DB has migrations 1-2 only, schema_version = 2 |
| 5 | World Graph integrity preserved | Existing facts with file hashes → migration → queryFacts returns same results |

---

## §21. Plugin System `[Phase 5]`

> → arch D16 | Axiom: A3 (plugins cannot bypass governance), A6 (plugin code never runs in Orchestrator process)

### 21.1 Plugin Manifest Schema

```typescript
interface PluginManifest {
  name: string;                    // unique identifier, e.g., "vinyan-python-oracle"
  version: string;                 // semver, e.g., "1.0.0"
  vinyan_version: string;          // minimum compatible Vinyan version
  provides: {
    oracles?: PluginOracleConfig[];
    tools?: PluginToolConfig[];
    providers?: PluginProviderConfig[];
  };
}

interface PluginOracleConfig {
  name: string;                    // oracle name, e.g., "pyright"
  command: string;                 // spawn command, e.g., "python -m vinyan_pyright_oracle"
  languages: string[];             // ["python"]
  patterns: string[];              // hypothesis patterns: ["type-check", "import-exists"]
  tier: "deterministic" | "heuristic" | "probabilistic";
  timeout_ms?: number;             // default: 30_000
}

interface PluginToolConfig {
  name: string;                    // tool name, e.g., "lint_python"
  command: string;                 // spawn command
  category: "file" | "shell" | "search" | "network";
  sideEffect: boolean;
  minIsolationLevel: 0 | 1 | 2 | 3;
  description: string;
  parameters: Record<string, { type: string; description: string; required?: boolean }>;
}

interface PluginProviderConfig {
  id: string;                      // provider ID, e.g., "plugin/local-llm"
  tier: "fast" | "balanced" | "powerful";
  loader: string;                  // module path for dynamic import
}
```

### 21.2 Plugin Loading

```typescript
interface PluginLoader {
  /** Discover plugins from config directory (~/.vinyan/plugins/) */
  discover(): PluginManifest[];

  /** Register plugin's oracles, tools, and providers with existing registries */
  register(manifest: PluginManifest, deps: {
    oracleRegistry: OracleRegistry;
    toolClassifier: ToolClassifier;
    providerRegistry: LLMProviderRegistry;
  }): void;

  /** Validate manifest against schema. Returns errors. */
  validate(manifest: PluginManifest): string[];
}
```

**Safety constraints:**
- Plugin oracles enter as `heuristic` tier maximum — admin must promote to `deterministic`
- Plugin tools inherit Orchestrator permission model (D13)
- Plugin providers are zero-trust (A6) — same as any LLM provider
- No plugin can modify immutable invariants (I1–I17)

### 21.3 Acceptance Criteria

| # | Criterion | Test |
|:--|:----------|:-----|
| 1 | Valid manifest loads and registers | Plugin with 1 oracle → `oracleRegistry` contains it |
| 2 | Invalid manifest rejected | Missing `name` field → `validate()` returns error |
| 3 | Plugin oracle invokable | Registered plugin oracle → `runner.runOracle()` spawns configured command |
| 4 | Plugin oracle tier ceiling | Plugin declares `deterministic` → registered as `heuristic` |
| 5 | Plugin tool respects permissions | Plugin tool with `sideEffect: true` → requires L1+ isolation |

---

## §22. API Server & Session Manager `[Phase 5]`

> → implementation-plan PH5.1 | Axiom: A3 (API is thin adapter), A6 (API tasks have zero-trust constraints), A7 (session compaction feeds Sleep Cycle)

### 22.1 API Server Interface

```typescript
interface VinyanAPIServer {
  /** Start HTTP server on configured port. */
  start(config: APIConfig): Promise<void>;

  /** Graceful shutdown — drain in-flight requests, close connections. */
  stop(): Promise<void>;
}

interface APIConfig {
  port: number;                    // default: 3927
  bindAddress: string;             // default: "127.0.0.1"
  authRequired: boolean;           // default: true for mutations
  corsOrigins?: string[];          // for web dashboard
}
```

### 22.2 HTTP Endpoints

| Method | Path | Auth | Description |
|:-------|:-----|:----:|:-----------|
| POST | `/api/v1/tasks` | Yes | Submit task (sync: wait for result) |
| POST | `/api/v1/tasks/async` | Yes | Submit task (async: returns task ID) |
| GET | `/api/v1/tasks/:id` | No | Poll task status and result |
| DELETE | `/api/v1/tasks/:id` | Yes | Cancel in-flight task |
| GET | `/api/v1/tasks/:id/events` | No | SSE stream of bus events for task |
| POST | `/api/v1/sessions` | Yes | Create session |
| GET | `/api/v1/sessions/:id` | No | Get session state |
| POST | `/api/v1/sessions/:id/compact` | Yes | Trigger session compaction |
| GET | `/api/v1/health` | No | Health check + system metrics |
| GET | `/api/v1/metrics` | No | Detailed metrics (fleet, oracle, self-model) |
| GET | `/api/v1/facts/:target` | No | Query World Graph facts |
| GET | `/api/v1/workers` | No | List worker profiles |
| GET | `/api/v1/rules` | No | List active evolution rules |

### 22.3 Session Manager Interface

```typescript
interface SessionManager {
  /** Create a new session. */
  create(source: string): Session;

  /** Get session by ID. */
  get(sessionId: string): Session | undefined;

  /** Add task to session. Links WorkingMemory. */
  addTask(sessionId: string, taskInput: TaskInput): void;

  /** Trigger compaction for a session. */
  compact(sessionId: string): CompactionResult;

  /** Recover pending sessions on restart. */
  recover(): Session[];
}

interface Session {
  id: string;
  source: string;                  // "cli" | "api" | "a2a"
  created_at: number;
  task_ids: string[];
  working_memory: WorkingMemory;   // shared across session tasks
  status: "active" | "compacted" | "archived";
}
```

### 22.4 Session Compaction Algorithm

Compaction produces a **supplementary summary** — the full audit trail is never deleted (I16).

**Trigger conditions** (any one):
1. Task count exceeds threshold (default: 20 tasks per session)
2. Session age exceeds threshold (default: 60 minutes)
3. Token budget: total tokens consumed exceeds 500K

**Compaction algorithm (rule-based, A3-compliant):**
```
1. Collect all traces for session tasks
2. Extract:
   a. Approach sequences (what was tried, in order)
   b. Failed approaches with oracle evidence (why each failed)
   c. Successful patterns (what worked, which oracles passed)
   d. Files modified (union of all mutations)
   e. Routing level distribution (how many L0/L1/L2/L3)
3. Produce CompactionResult:
   - episode_summary: structured JSON (not LLM-generated)
   - key_failures: top-5 failures by frequency
   - successful_patterns: patterns that led to completion
   - statistics: { taskCount, completedCount, escalatedCount, avgDuration }
4. Store CompactionResult in session_store
5. Feed CompactionResult to Sleep Cycle as first-class input
6. Mark session status = "compacted"
```

**Why rule-based, not LLM-generated:** Compaction summaries feed the Evolution Engine. LLM-generated summaries would violate A3 (non-deterministic governance input) and introduce hallucination risk in the learning pipeline. Rule-based extraction from structured traces is deterministic and auditable.

### 22.5 Checkpoint Recovery

```typescript
interface CheckpointManager {
  /** Persist session + in-progress task state. Called after each task completion. */
  checkpoint(session: Session): void;

  /** Recover all sessions with pending tasks. Called on startup. */
  recover(): Array<{ session: Session; pendingTasks: TaskInput[] }>;
}
```

**Schema (new table in `session-schema.ts`):**
```sql
CREATE TABLE IF NOT EXISTS session_store (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  working_memory_json TEXT,
  compaction_json TEXT,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS session_tasks (
  session_id TEXT NOT NULL REFERENCES session_store(id),
  task_id TEXT NOT NULL,
  task_input_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  result_json TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (session_id, task_id)
);
```

### 22.6 Rate Limiting `[Phase 5]`

Token-bucket rate limiting protects the API server from abuse and ensures fair resource sharing.

```typescript
interface RateLimitConfig {
  defaultBucketSize: number;          // default: 100 tokens
  defaultRefillRate: number;          // default: 10 tokens/second
  endpointOverrides: Record<string, {
    bucketSize: number;
    refillRate: number;
  }>;
  // Per-endpoint category defaults:
  // task_submit:   bucketSize=20,  refillRate=2/s   (expensive — LLM + oracle execution)
  // task_query:    bucketSize=100, refillRate=20/s   (cheap reads)
  // session_mgmt:  bucketSize=50,  refillRate=5/s
  // health_status: unlimited (no rate limit)
}
```

**Behavior:**
- Rate limiting keyed by API key (from `Authorization: Bearer <key>`)
- When bucket exhausted → `429 Too Many Requests` with `Retry-After` header (seconds until next token)
- Unauthenticated endpoints (`/health`, `/metrics`) are not rate-limited
- Rate limit state is in-memory only — resets on server restart (acceptable for single-instance)

### 22.7 Graceful Shutdown Protocol `[Phase 5]`

```typescript
interface ShutdownProtocol {
  /** Initiate graceful shutdown. Returns when all cleanup complete or deadline exceeded. */
  stop(deadlineMs?: number): Promise<void>;   // default: 30_000ms
}
```

**Shutdown sequence:**

1. **Stop accepting** — HTTP server stops accepting new connections, returns `503 Service Unavailable` for new requests
2. **Drain in-flight** — Wait for all in-flight task executions to complete (up to `deadlineMs`)
3. **Persist sessions** — Flush all active sessions to SQLite (`session_store.status = 'suspended'`)
4. **Disconnect peers** — Send `disconnect` message to all VIIP peers (A2A protocol §3)
5. **Close resources** — Close SQLite connections, EventBus, file watchers
6. **Force terminate** — If deadline exceeded, cancel remaining tasks with `TaskResult.status = 'error'`, log warning

**Signals:** `SIGTERM` and `SIGINT` trigger `stop()`. Second signal forces immediate exit.

### 22.8 Acceptance Criteria

| # | Criterion | Test |
|:--|:----------|:-----|
| 1 | Sync task submission | POST /api/v1/tasks → 200 with TaskResult |
| 2 | Async task submission | POST /api/v1/tasks/async → 202 with task ID → GET → result |
| 3 | SSE event stream | Subscribe to /tasks/:id/events → receive bus events as SSE |
| 4 | Session compaction | 25 tasks in session → compact → CompactionResult produced |
| 5 | Audit preservation (I16) | After compaction → original JSONL audit file unchanged |
| 6 | Checkpoint recovery | Kill server mid-session → restart → pending tasks resumed |
| 7 | Auth enforcement (I15) | POST /tasks without token → 401. GET /health → 200 (no auth) |
| 8 | API = CLI equivalence | Same 50 tasks via CLI vs API → identical TaskResult |

---

## §23. Instance Coordinator `[Phase 5]`

> → implementation-plan PH5.8, [vinyan-a2a-protocol.md](vinyan-a2a-protocol.md) | Axiom: A3 (advisory coordination), A1 (cross-instance: A generates, B verifies), A6 (delegated results re-verified locally)

### 23.1 Coordinator Interface

```typescript
interface InstanceCoordinator {
  /** Register with configured peers. Exchanges InstanceDescriptors. */
  connect(): Promise<void>;

  /** Graceful disconnect from all peers. */
  disconnect(): Promise<void>;

  /** Find peer with matching capability for task delegation. */
  findPeerForTask(fingerprint: TaskFingerprint, requiredCapabilities: string[]): PeerInstance | undefined;

  /** Delegate task to peer. Returns result or undefined on timeout. */
  delegateTask(peerId: string, input: TaskInput, perception: PerceptualHierarchy, timeout_ms: number): Promise<TaskResult | undefined>;

  /** Request remote oracle verification. */
  requestRemoteVerification(peerId: string, hypothesis: HypothesisTuple, oracleTypes: string[]): Promise<Record<string, OracleVerdict>>;

  /** Share knowledge with peers during Sleep Cycle. */
  shareKnowledge(items: AbstractPatternExport[]): Promise<void>;

  /** Get connected peers. */
  getPeers(): PeerInstance[];
}

interface PeerInstance {
  id: string;
  descriptor: InstanceDescriptor;  // from concept §11.2
  trust_level: "untrusted" | "semi-trusted" | "trusted";
  connection_state: "connected" | "disconnected" | "circuit_open";
  stats: {
    delegations_sent: number;
    delegations_success: number;
    verdicts_requested: number;
    verdicts_accurate: number;     // for trust scoring (Wilson LB)
    knowledge_imported: number;
    last_seen: number;
  };
}
```

### 23.2 Coordinator State Machine

```
                    ┌──────────────────┐
                    │    Isolated      │  ← startup default
                    │ (no peers)       │
                    └────────┬─────────┘
                             │ connect()
                    ┌────────▼─────────┐
              ┌────►│   Discovering    │◄───────────────┐
              │     │ (handshake peers)│                 │
              │     └────────┬─────────┘                 │
              │              │ ≥1 peer connected          │
              │     ┌────────▼─────────┐                 │
              │     │   Coordinating   │  ← normal mode  │
              │     │ (active peers)   │                 │
              │     └────────┬─────────┘                 │
              │              │ all peers lost             │
              │     ┌────────▼─────────┐                 │
              └─────┤   Degraded       │─────────────────┘
                    │ (retry connect)  │  reconnect success
                    └──────────────────┘
```

**State transitions:**
- `Isolated → Discovering`: On `connect()` call (startup if `instances.enabled`)
- `Discovering → Coordinating`: At least 1 peer handshake succeeds
- `Coordinating → Degraded`: All peers disconnected or circuit-open
- `Degraded → Discovering`: Retry timer fires (exponential backoff, 5s → 30s max)
- Any state: `disconnect()` → `Isolated`

**In all states:** The local Orchestrator continues processing tasks. Coordination is additive, never blocking.

### 23.3 Trust Scoring

Remote instances earn trust empirically, using the same Wilson Lower Bound mechanism as `WorkerLifecycle`:

```typescript
// Trust scoring for remote instance
trustScore = wilsonLowerBound(stats.verdicts_accurate, stats.verdicts_requested, alpha=0.05)

// Trust level thresholds
if (trustScore >= 0.7) trust_level = "trusted"
else if (trustScore >= 0.4) trust_level = "semi-trusted"
else trust_level = "untrusted"
```

Trust level determines allowed operations (see [vinyan-a2a-protocol.md](vinyan-a2a-protocol.md) §4.4).

### 23.4 Safety Invariants (I12–I17)

| # | Invariant | Enforcement in Coordinator |
|:--|:----------|:--------------------------|
| I12 | No remote governance bypass | `delegateTask()` result always passes through local oracle verification |
| I13 | Remote verdict confidence ceiling | `requestRemoteVerification()` caps all verdicts at confidence < 0.95 |
| I14 | Cross-instance knowledge enters probation | `shareKnowledge()` receiver sets `status: 'probation'` regardless of source status |
| I15 | API auth for mutations | Coordinator uses authenticated WebSocket (mTLS or signed messages) |
| I16 | Session audit preservation | Delegation audit trail logged locally (never depends on remote audit) |
| I17 | Speculative sandbox mandatory | Remote speculative-tier results treated as L2+ isolation required |

### 23.5 Distributed Tracing — correlationId Propagation `[Phase 5]`

All cross-instance operations carry a `correlationId` that links traces across instances for end-to-end debugging.

```typescript
// Extended ExecutionTrace (addition to existing trace schema)
interface ExecutionTrace {
  // ... existing fields ...
  correlationId?: string;             // UUIDv7 — set by originating instance, propagated through delegation chain
  sourceInstanceId?: string;          // instance that created this trace entry
}
```

**Propagation rules:**

1. **Origin:** When Orchestrator starts a task with no existing `correlationId`, generate a new UUIDv7
2. **Delegation:** `task_delegate` message includes `correlationId` in `VIIPEnvelope.correlation_id` (A2A protocol §2.2). The receiving instance MUST use the same `correlationId` for all traces generated from the delegated task
3. **Oracle requests:** `oracle_request` message propagates `correlationId`. Response `oracle_verdict` echoes it
4. **Knowledge sharing:** Not correlated (knowledge transfer is not task-scoped)
5. **Trace query:** `TraceStore.queryByCorrelationId(id)` returns all local traces for a given correlation chain

**Cross-instance trace assembly:**
- Each instance stores traces locally with `correlationId` + `sourceInstanceId`
- Full distributed trace is assembled by querying each participating instance (no centralized trace store)
- Observability endpoint: `GET /api/v1/traces/:correlationId` returns local traces for that correlation

### 23.6 World Graph Federation `[Phase 5]`

Each instance maintains its own local World Graph (SQLite). Remote facts are advisory, not authoritative.

```typescript
interface WorldGraphFederation {
  /** Query facts from connected peer instances. Best-effort, non-blocking. */
  queryRemoteFacts(
    query: FactQuery,
    timeoutMs?: number               // default: 3_000ms
  ): Promise<RemoteFact[]>;
}

interface RemoteFact {
  fact: Fact;                         // standard Fact with confidence × 0.8 degradation
  sourceInstanceId: string;
  sourceTimestamp: number;
  staleness: 'fresh' | 'stale';      // stale if > 5 minutes old
}
```

**Federation rules** (see also concept.md §11.7):

1. **Local facts are authoritative** — remote facts supplement but never override
2. **Confidence degradation** — remote fact confidence multiplied by 0.8 on receipt
3. **No shared writes** — instances never write to each other's World Graph
4. **File hash invalidation is local-only** — `chokidar` watches are per-instance; remote instances cannot invalidate local facts
5. **Conflict resolution** — if local and remote facts contradict, local takes precedence. Remote conflicting fact is logged but discarded
6. **Usage pattern** — `queryRemoteFacts()` is called during `Perceive` phase as optional enrichment. Timeout failure → proceed with local facts only (fail-open)

### 23.7 Acceptance Criteria

| # | Criterion | Test |
|:--|:----------|:-----|
| 1 | Peer discovery | 2 instances → handshake → both see each other in `getPeers()` |
| 2 | Task delegation | Instance A delegates Python task to Instance B → receives verified result |
| 3 | Re-verification (A6) | Delegated result from B → Instance A re-verifies with local oracles |
| 4 | Confidence cap (I13) | Remote oracle returns confidence 1.0 → local receives ≤ 0.95 |
| 5 | Knowledge probation (I14) | Rule `active` on A → shared to B → enters B as `probation` |
| 6 | Partition tolerance | Kill network between A and B → both continue processing independently |
| 7 | Partition recovery | Restore network → instances reconnect, exchange Sleep Cycle summaries |
| 8 | Trust scoring | Remote instance provides 10 accurate verdicts → trust_level upgrades |
| 9 | Graceful degradation | All peers lost → Coordinator enters `Degraded`, Orchestrator unaffected |

---

## Architecture Decisions Summary (D1–D18)

Quick reference linking each decision to its TDD section:

| D# | Decision | TDD Section | Phase |
|:--:|----------|:-----------:|:-----:|
| D1 | Phase 0 Host Strategy — Prove ENS in Production | §8 | 0 |
| D2 | World Graph — SQLite + File Hash Binding | §5 | 0 |
| D3 | Reasoning Engine Gateway — ECP | §3, §4 | 0 |
| D4 | Risk Router — 4-Level Routing + Phase Mapping | §6, §7 | 0 |
| D5 | Worker Isolation — Progressive Levels | §11 | 1–2 |
| D6 | Evolutionary Engine — Trace-Based | §12B | 2+ |
| D7 | Multi-Agent Coordination — Two-Tier | §10 | 1 |
| D8 | Perceptual Hierarchy + Working Memory | §2 (L3 interfaces) | 1 |
| D9 | Adaptive Execution Lifecycle | §10 | 1 |
| D10 | QualityScore as First-Class Contract | §2 (L2), §12 | 0–2 |
| D11 | Self-Model — Forward Prediction + Cold-Start Safeguards | §12 | 1 |
| D12 | Four-Phase Commit Mapping per Routing Level | §6 | 0–1 |
| D13 | Failure Modes & Recovery Strategies (F1–F5) | §12C | 0+ |
| D14 | Bounded Self-Modification (Immutable Invariants) | §12B | 2+ |
| D15 | Cross-Language Oracle Process Model | §21 | 5 |
| D16 | Plugin System Architecture | §21 | 5 |
| D17 | Async EventBus for Multi-Instance | §23 | 5 |
| D18 | Schema Migration Framework | §20 | 5 |
