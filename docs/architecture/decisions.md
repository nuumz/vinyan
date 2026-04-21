# Vinyan — Architecture Design Decisions

> **Document boundary**: This document owns the **concrete architecture, component design, and technology decisions** for building Vinyan.
> For vision/philosophy/protocol design, see [concept.md](../foundation/concept.md). For theoretical foundations, see [theory.md](../foundation/theory.md). For competitive landscape, see [gap-analysis.md](../analysis/gap-analysis.md).

---

## 1. Architectural Thesis

**Core Decision:** Vinyan is an **autonomous task orchestrator** built on the **Epistemic Orchestration** paradigm — the thesis that AGI-grade reliability emerges from correct epistemic architecture, not from larger LLMs. Its verification layer is an **Epistemic Nervous System (ENS)** substrate — a rule-based, non-LLM-driven verification layer that connects heterogeneous Reasoning Engines via the Epistemic Communication Protocol (ECP). LLMs are one component, not the brain. The Orchestrator's routing, verification, and commit decisions are rule-based and state-reproducible — no LLM is in the decision path for governance actions (see [concept.md A3](../foundation/concept.md) for the precise definition of "deterministic governance"). Stochastic components (LLMs) are used for generation and initial task decomposition, but operate within deterministic constraints. See [concept.md §1-3](../foundation/concept.md) for the full vision, ECP specification, and Reasoning Engine model. All architectural decisions below implement the 7 Core Axioms defined in [concept.md §1.1](../foundation/concept.md).

**Implementation strategy — Prove, then Build:**
- Phase 0: Prove epistemic verification works by deploying Oracle Gate inside an existing agent host (Claude Code or compatible host). Claude Code is the **test host**, not Vinyan's identity — like testing a new engine in an existing car before building the vehicle around it.
- Phase 1: **Vinyan as Autonomous Agent** — standalone rule-based Orchestrator + LLM-powered Generator Engines + Tool Execution layer + MCP External Interface. Vinyan receives tasks, plans, generates code via LLM, executes tools, and verifies results as a complete agent system. The Orchestrator is rule-based, non-LLM code — LLMs are Generator Engines that propose; Oracles verify; the Orchestrator decides. See Decisions 7, 9, 12, 13, 14.
- Phase 2: Multi-worker isolation + pattern-based optimization (Sleep Cycle extracts failure patterns → threshold adjustments + skill cache). Not self-evolving — frequency-based pattern detection with probation/promotion lifecycle.
- Phase 3+: Full self-improvement (research-grade pattern mining + counterfactual generation + trace-calibrated Self-Model)
- Phase 5: Complete ENS — standalone platform (API + TUI + Web + VS Code), multi-instance coordination (ECP/network, advisory peer mesh), cross-language oracles (Python/Go/Rust), plugin system, schema migrations. See Decisions 15–18.

**Rationale from source code analysis:**
- Claude Code's `runEmbeddedPiAgent()` is a 1,800-line function with deeply integrated retry, compaction, failover, and hook systems. Replacing it is a multi-year effort with diminishing returns.
- HiClaw proved that a governance layer (Manager) on top of OpenClaw agents works in production.
- Claude Code's hooks system proves deterministic scripts can intercept LLM decisions without modifying the runtime.
- Claude Cowork proves the **"same agentic SDK, different UX surface"** pattern — built in ~1.5 weeks on top of Claude Code's SDK, serving knowledge workers instead of developers. This validates that Vinyan's orchestrator core can power multiple frontends (CLI, VS Code extension, web dashboard) without architectural changes.

---

## 2. System Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│                     Human Interface Layer                        │
│   CLI │ API │ VS Code Extension │ Web Dashboard                  │
└─────────────────────┬────────────────────────────────────────────┘
                      │
┌─────────────────────▼──────────────────────────────────────────────────┐
│              Vinyan Orchestrator (rule-based, non-LLM)                 │
│  ┌──────────────────────────────────────────────────────────────────┐  │
│  │         Intent Resolver (LLM, advisory → strategy routing)       │  │
│  │  conversational│direct-tool│agentic-workflow → short-circuit     │  │
│  │  full-pipeline → ↓                                               │  │
│  │ Core Loop: Perceive → Predict → Plan → Generate → Verify → Learn │  │
│  └─────────┬───────────┬─────────────┬────────────┬─────────────────┘  │
│            │           │             │            │                    │
│  ┌─────────▼─┐  ┌──────▼─────┐  ┌────▼────┐  ┌────▼─────┐              │
│  │ Risk      │  │ Task       │  │ Self-   │  │ Tool     │              │
│  │ Router    │  │ Decomposer │  │ Model   │  │ Executor │              │
│  │ (4-level) │  │ (iter DAG) │  │ (pred)  │  │ (perm)   │              │
│  └───────────┘  └────────────┘  └─────────┘  └──────────┘              │
│                                                                        │
│  ┌────────────────────────────────────────────────────────────┐        │
│  │ Verification Gate (Reasoning Engines / Oracles)            │        │
│  │ ast-oracle │ type-oracle │ dep-oracle │ test-oracle │ lint │        │
│  └────────────────────────────────────────────────────────────┘        │
│                                                                        │
│  ┌────────────────────────────────────────────────────────────┐        │
│  │ World Graph (SQLite + file watcher)                        │        │
│  └────────────────────────────────────────────────────────────┘        │
└─────────────────────────┬───────────────┬──────────────────────────────┘
                          │               │
┌─────────────────────────▼───┐    ┌──────▼─────────────────┐
│  Execution Layer            │    │ External Interface     │
│  (Worker child processes)   │    │ (MCP Bridge, Phase 1B) │
│  ┌─────────────────────┐    │    │ ┌────────────────────┐ │
│  │ Worker 1 (LLM Gen.) │    │    │ │ MCP Client         │ │
│  │ Worker 2 (LLM Gen.) │    │    │ │ (consume tools)    │ │
│  │ Shadow Sandbox      │    │    │ ├────────────────────┤ │
│  └─────────────────────┘    │    │ │ MCP Server         │ │
│           │                 │    │ │ (expose Oracles)   │ │
└───────────┼─────────────────┘    │ └────────────────────┘ │
            │                      └────────────────────────┘
  ┌─────────▼───────────────┐
  │   LLM Providers         │
  │ Claude │ GPT │ Local    │
  └─────────────────────────┘
```

---

## 3. Key Design Decisions

### Decision 1: Phase 0 Host Strategy — Prove ENS in Production

> **Axioms: A1, A3** — Epistemic Separation (verify the epistemic approach in production before building the full platform) + Deterministic Governance (plugin hooks = deterministic intercept points for proof-of-concept)

**Choice:** Use Claude Code (or compatible host) as a **test host** for Phase 0 to prove epistemic verification works. Phase 0 Vinyan is a **verification library** (not an agent or a nervous system); Claude Code is the first environment where verification components are validated. The ENS label describes the architectural vision (Phase 1+), not Phase 0's deliverable.

**Alternatives considered for Phase 0 validation:**
| Option | Pros | Cons | Verdict |
|--------|------|------|----------|
| Fork Claude Code | Full control | 336k-star maintenance burden, divergence | ❌ Rejected |
| Build full ENS from day 1 | Clean design, no identity confusion | Years to prove core thesis works in production | ❌ Rejected |
| **Test host (plugin) → standalone** | Prove epistemic verification fast, then build independently | Phase 0 constrained by host's hook points | ✅ Chosen |

**Implementation:**
- `before_tool_call` hook → Epistemic Oracle Gateway (validate hypothesis before execution)
- `after_tool_call` hook → World Graph update (record verified facts)
- `before_model_resolve` hook → Risk Router (select model tier based on task risk)
- `before_prompt_build` hook → Context injection (inject PerceptualHierarchy + WorkingMemory)
- Separate process → Orchestrator Core (manages workers, tracks evolution)

**Source code evidence:** Claude Code's hook system is production-hardened. `createHookRunner()` supports priority ordering, `block=true` terminal semantics, and sequential chaining. The `before_tool_call` hook can modify params OR block execution — exactly what Oracles need.

---

### Decision 2: World Graph — SQLite + File Hash Binding

> **Axioms: A4, A5** — Content-Addressed Truth (file hash binding) + Tiered Trust (deterministic > heuristic > probabilistic evidence)

**Choice:** SQLite database with content-addressed facts, not a vector DB.

**Rationale:**
- Vector DBs (Chroma, Pinecone) store semantic similarity — but Vinyan needs **provenance and invalidation**
- A fact "function X has 3 parameters" is meaningless if file X was modified since verification
- SQLite is zero-dependency, portable, and supports WAL for concurrent reads

**Schema:**

```sql
CREATE TABLE facts (
  id          TEXT PRIMARY KEY,    -- content hash of (target + pattern + evidence)
  target      TEXT NOT NULL,       -- file path or symbol
  pattern     TEXT NOT NULL,       -- what was verified
  evidence    TEXT NOT NULL,       -- JSON array of file:line references
  oracle_name TEXT NOT NULL,       -- which oracle produced this
  file_hash   TEXT NOT NULL,       -- SHA-256 of source file at verification time
  verified_at INTEGER NOT NULL,    -- Unix timestamp
  session_id  TEXT,                -- which session produced this
  confidence  REAL DEFAULT 1.0     -- 1.0 for deterministic oracles, <1.0 for heuristic
);

CREATE INDEX idx_facts_target ON facts(target);
CREATE INDEX idx_facts_file_hash ON facts(file_hash);

CREATE TABLE file_hashes (
  path         TEXT PRIMARY KEY,
  current_hash TEXT NOT NULL,
  updated_at   INTEGER NOT NULL
);

-- Trigger: when file_hashes.current_hash changes, invalidate dependent facts
CREATE TRIGGER invalidate_facts_on_file_change
AFTER UPDATE OF current_hash ON file_hashes
BEGIN
  DELETE FROM facts WHERE file_hash != NEW.current_hash AND target = NEW.path;
END;
```

**File watcher:** Use `fs.watch()` (Node.js) or `chokidar` to detect file mutations → update `file_hashes` → cascade invalidation via trigger.

**Why not Neo4j/graph DB:** Overkill for Phase 0–1. Facts have simple relationships (file → facts). If graph queries become needed (dependency chain traversal), migrate the schema — SQLite's portability makes this low-risk.

---

### Decision 3: Reasoning Engine Gateway — ECP-Based Pluggable Architecture

> **Axioms: A1, A2, A5** — Epistemic Separation (pluggable engines ≠ self-evaluation) + First-Class Uncertainty (ECP carries confidence) + Tiered Trust (engine registry ranked by evidence tier)

**Choice:** Each Reasoning Engine communicates with the Orchestrator via the Epistemic Communication Protocol (ECP). Phase 0 transport: JSON-RPC over stdio (same as MCP local). Engines are standalone executables that receive a HypothesisTuple and return an OracleVerdict with epistemic metadata (confidence, evidence chain, falsifiability). See [concept.md §2-3](../foundation/concept.md) for the full ECP specification and Reasoning Engine model. For ECP vs MCP capability comparison, see [concept.md §2.3](../foundation/concept.md) — ECP is a semantic extension of JSON-RPC that adds epistemic state as first-class data; MCP is used only for the External Interface channel (Decision 14).

**Rationale:**
- Deterministic Reasoning Engines (Verifiers) MUST NOT call LLMs — they are the epistemic ground truth
- Heuristic/Probabilistic engines (Predictors, Critics) may use LLMs but declare confidence < 1.0
- Process isolation prevents a crashing engine from taking down the orchestrator
- Any language can implement a Reasoning Engine (TypeScript, Python, Rust, shell script)
- ECP carries epistemic metadata (confidence, evidence chains) that plain stdio JSON lacks
- For external tool integration, MCP Servers bridge into the ecosystem via the External Interface channel
- Timeout enforcement per engine (kill child process after N seconds)

**Interface:**

```typescript
// Input: written to oracle's stdin as JSON
interface HypothesisTuple {
  target: string;           // "src/auth/login.ts" or "AuthService.validate"
  pattern: string;          // "function accepts exactly 2 parameters"
  context?: Record<string, unknown>;  // additional context for the oracle
  workspace: string;        // absolute path to workspace root
}

// Output: read from oracle's stdout as JSON
// Aligns with concept.md §2.2 ECPResponse — epistemic metadata is first-class
interface OracleVerdict {
  verified: boolean;
  confidence: number;           // 1.0 for deterministic oracles, <1.0 for heuristic (maps to ECPResponse.confidence)
  evidence: Array<{              // provenance chain (maps to ECPResponse.evidence)
    file: string;
    line: number;
    snippet: string;
    contentHash: string;        // SHA-256 of source file — A4 compliance
  }>;
  falsifiable_by: string[];     // conditions that would invalidate this verdict (maps to ECPResponse.falsifiable_by)
  fileHashes: Record<string, string>;  // path → SHA-256
  reason?: string;              // human-readable explanation when !verified
  duration_ms: number;
  qualityScore?: QualityScore;  // multi-dimensional quality signal (see Decision 10)
}
```

**Built-in Oracles (Phase 0):**

| Oracle | Tool | What it verifies |
|--------|------|-----------------|
| `ast-oracle` | tree-sitter | Symbol existence, function signatures, import relationships |
| `type-oracle` | `tsc --noEmit` / Pyright | Type correctness of proposed changes |
| `test-oracle` | vitest / pytest | Test pass/fail for affected code paths |
| `lint-oracle` | ESLint / Ruff | Style and lint rule compliance |
| `dep-oracle` | Import graph analysis | Blast radius — which files are affected by a change |

**Oracle execution flow:**

```
Worker proposes: "I'll add parameter `timeout` to function `fetchData`"
    ↓
Orchestrator constructs HypothesisTuple:
  { target: "src/api.ts::fetchData", pattern: "can-add-parameter", workspace: "/..." }
    ↓
dep-oracle: "fetchData is called in 14 files" → blast_radius = 14
ast-oracle: "fetchData currently has 2 params" → verified
type-oracle: (runs tsc on shadow copy with change applied) → pass/fail
    ↓
If all pass → commit mutation
If any fail → reject with evidence, return to worker
```

---

### Decision 4: Risk Router — Static Analysis Score, Not ML

> **Axiom: A3** — Deterministic Governance (risk routing uses rule-based heuristics, not ML models)

**Choice:** Numeric risk score from static analysis, with threshold-based routing to a 4-level continuum: L0 Reflex, L1 Heuristic, L2 Analytical, L3 Deliberative (see [concept.md §8](../foundation/concept.md)).

**Rationale:**
- ML-based risk scoring needs training data we don't have yet
- Static analysis is deterministic, explainable, and instant
- Thresholds can be tuned per-project via config

**Risk Score Formula:**

```typescript
interface RiskFactors {
  blastRadius: number;      // files affected (from dep-oracle)
  dependencyDepth: number;  // max depth in import chain
  testCoverage: number;     // 0.0–1.0, % of affected code with tests
  fileVolatility: number;   // git commits in last 30 days for affected files
  irreversibility: number;  // 0.0–1.0 (DB writes, external API calls, deployments that can't git-revert)
  hasSecurityImplication: boolean;  // touches auth/crypto/env files
  environmentType: 'development' | 'staging' | 'production';  // deployment target
}

function calculateRiskScore(factors: RiskFactors): number {
  const base =
    (factors.blastRadius * 0.25) +
    (factors.dependencyDepth * 0.10) +
    ((1 - factors.testCoverage) * 0.15) +
    (factors.fileVolatility * 0.10) +
    (factors.irreversibility * 0.20) +
    (factors.hasSecurityImplication ? 0.10 : 0) +
    (factors.environmentType === 'production' ? 0.10 : 0);
  // Weights sum to 1.0: 0.25 + 0.10 + 0.15 + 0.10 + 0.20 + 0.10 + 0.10

  // Operational Guardrail (A6): production + non-reversible → force Level 3 + human approval
  if (factors.environmentType === 'production' && factors.irreversibility > 0.5) {
    return Math.max(0.9, base);
  }

  return Math.min(1.0, base);
}

// 4-Level routing thresholds (configurable per project)
// Maps risk score → routing level per concept.md §8
const ROUTING_THRESHOLDS = {
  L0_MAX: 0.2,    // ≤ 0.2 → Level 0 (Reflex): cached/trivial, < 100ms budget
  L1_MAX: 0.4,    // ≤ 0.4 → Level 1 (Heuristic): single worker, < 2s budget
  L2_MAX: 0.7,    // ≤ 0.7 → Level 2 (Analytical): full verification, < 10s budget
  // > 0.7 → Level 3 (Deliberative): parallel hypothesis, shadow exec, < 60s budget
};
```

**Latency budgets are design constraints, not aspirations** (per [concept.md §7](../foundation/concept.md)). If Oracle verification cannot meet the budget for a routing level, the Oracle is either optimized, made asynchronous (non-blocking with rollback capability), or excluded from that level's pipeline.

**Operational Guardrails (A6) — Prompt Injection + Production Boundary:**

| Guardrail | Mechanism | Phase |
|-----------|-----------|-------|
| Input sanitization | Content entering worker prompts stripped of instruction-like patterns at perception boundary | Phase 0 |
| Oracle independence | Oracles verify actual code artifacts, never worker claims about code | Phase 0 |
| Auto-reject bypass | Worker output referencing "skip Oracle" / "bypass validation" rejected by Orchestrator | Phase 0 |
| Production escalation | `environmentType: 'production'` AND `irreversibility > 0.5` → auto-escalate to Level 3 + human approval | Phase 0 |
| Non-reversible gate | `irreversibility > 0.8` requires separate approval regardless of environment | Phase 1 |

**Routing Level Execution Profiles:**

| Level | Workers | Model Tier | Shadow Exec | Token Budget | Mutation Phases (concept.md §7) |
|:------|:--------|:-----------|:------------|:-------------|:-------------------------------|
| **L0 (Reflex)** | Cached/skip | — | ❌ | — | Intent → Commit (skip blast radius + shadow) |
| **L1 (Heuristic)** | Single worker | fast (Haiku) | ❌ | 10K | Intent → Blast Radius (lightweight) → Commit |
| **L2 (Analytical)** | Single worker | balanced | Conditional* | 50K | Intent → Blast Radius (full) → Conditional Shadow → Commit |
| **L3 (Deliberative)** | Parallel (PHE) | powerful (Opus) | ✅ mandatory | 100K per branch | All 4 phases mandatory |

*L2 Shadow Execution triggers only when blast radius exceeds a configurable threshold (default: 5 affected files or risk score > 0.7).

**Parallel Hypothesis Evaluation (L3 — PHE):**
- Multiple workers explore in parallel
- Early termination on Reasoning Engine pass
- Selection: choose the branch where ALL engines pass with highest composite quality score

**PHE is NOT traditional MCTS.** Software engineering search spaces are combinatorially explosive without clean reward signals (unlike game playing). PHE uses **parallel hypothesis generation with structured selection** (closer to beam search). The "simulation" is shadow execution; the "reward" is composite quality score from Reasoning Engines (§3.1 tiered registry). The tree is shallow (typically 2–3 levels: approach selection → implementation → validation).

---

### Decision 5: Worker Isolation — Progressive Levels

> **Axiom: A6** — Zero-Trust Execution (workers propose, orchestrator disposes; progressive isolation matches trust level)

**Choice:** Three isolation levels based on risk score, not one-size-fits-all.

| Level | When | Mechanism | Overhead |
|-------|------|-----------|----------|
| **L0: In-process** | Risk < 0.2 (read-only operations) | Same Node.js process, restricted tool set | ~0ms |
| **L1: Child process** | Risk 0.2–0.7 (standard mutations) | `child_process.fork()`, IPC via stdio | ~50ms |
| **L2: VM / Container** | Risk > 0.7 (destructive/security-sensitive) | VM (Apple VZVirtualMachine) or Docker container with mounted workspace copy | ~2–5s |

**Rationale:** HiClaw uses containers for everything (500ms+ startup per worker). Claude Code uses in-process with optional sandbox. Claude Cowork validates that **full VM isolation** (via Apple Virtualization Framework's `VZVirtualMachine`) is production-viable for agent workloads — giving a hard OS boundary rather than Docker's shared kernel. Vinyan's progressive model matches isolation cost to actual risk: Docker for standard high-risk tasks, VM for security-critical operations where kernel-level isolation is required.

**Worker lifecycle (L1 — the common case):**

```
Orchestrator                           Worker (child process)
    │                                       │
    ├── fork() ──────────────────────────►  │ (new process)
    ├── write intent.json to workspace ──►  │
    │                                       ├── read intent.json
    │                                       ├── execute (tool calls via stdio IPC)
    │                                       ├── write result.json + telemetry.jsonl
    │                                       └── exit(0)
    ├── read result.json ◄──────────────    │ (process dead)
    ├── Oracle validation
    ├── if pass → commit to canonical
    └── if fail → log, escalate routing level or escalate to human
```

**Filesystem contract (replaces shared memory):**

```
workspace/
├── .vinyan/
│   ├── intent.json       # Orchestrator → Worker (read-only for worker)
│   ├── state-vector.json # Ambient sensor data (deps, git, lint)
│   ├── result.json       # Worker → Orchestrator
│   ├── telemetry.jsonl   # Worker appends execution traces
│   └── facts.db          # World Graph (read-only copy for worker)
├── src/                  # Working copy (L1: actual files, L2: copy-on-write)
└── ...
```

---

### Decision 6: Evolutionary Engine — Trace-Based Pattern Mining

> **Axiom: A7** — Prediction Error as Learning Signal (trace deltas drive rule generation, not task success/failure alone)

**Choice:** Structured failure traces → periodic batch analysis → rule generation.

**NOT:** Vector similarity search on conversations. NOT: Fine-tuning on past sessions.

**Rationale:**
- LLM conversations are noisy — extracting actionable rules from them requires... an LLM (circular)
- Structured traces (Oracle verdicts, risk scores, retry counts) are machine-parseable
- Rules generated by the Evolution Engine are reviewed by Oracles before activation (the system validates its own evolution)

**Trace schema:**

```typescript
interface ExecutionTrace {
  session_id: string;
  task_id: string;
  timestamp: number;
  worker_id: string;
  action: "propose" | "validate" | "commit" | "reject" | "retry" | "escalate";
  risk_score: number;
  oracle_verdicts: Record<string, boolean>;  // oracle_name → pass/fail
  model_used: string;
  tokens_consumed: number;
  duration_ms: number;
  outcome: "success" | "failure" | "timeout" | "escalated";
  failure_reason?: string;
  affected_files: string[];
  // QualityScore + Skill Formation infrastructure (A4, A7)
  approach_description: string;       // natural-language summary of what was attempted
  quality_score?: QualityScore;       // multi-dimensional quality signal (see Decision 10)
  success_pattern_tag?: string;       // set by Evolution Engine during Sleep Cycle
  prediction_error?: PredictionError; // Self-Model prediction vs actual outcome (see Decision 11)
}
```

**Sleep Cycle (background analysis):**

1. **Trigger:** Every N sessions or on idle (cron-like)
2. **Analysis:** Query traces for recurring failure patterns:
   - Same oracle failing >3x on similar file patterns → generate rule
   - Level 2-3 consistently succeeding where Level 0-1 fails → adjust routing thresholds
   - Specific model failing >50% on certain file types → route away
3. **Rule generation:** Produce candidate rules as structured JSON (not prose)
4. **Validation:** Each candidate rule is tested against historical traces — only rules that would have prevented past failures AND wouldn't have blocked past successes are promoted
5. **Activation:** Rules start in "probation" — logged but not enforced for 10 sessions, then promoted if no false positives

**Rule format:**

```typescript
interface EvolutionaryRule {
  id: string;
  source: "sleep-cycle" | "manual";
  condition: {
    file_pattern?: string;       // glob pattern
    oracle_name?: string;
    risk_above?: number;
    model_pattern?: string;
  };
  action: "escalate" | "require-oracle" | "prefer-model" | "adjust-threshold";
  parameters: Record<string, unknown>;
  status: "probation" | "active" | "retired";
  created_at: number;
  effectiveness: number;  // 0.0–1.0, calculated over probation period
}
```

---

### Decision 7: Multi-Agent Coordination — Two-Tier Model

> **Axioms: A3, A6** — Deterministic Governance (orchestrator coordinates deterministically) + Zero-Trust Execution (workers have zero execution privileges)

**Choice:** Vinyan Orchestrator (rule-based, non-LLM-driven — see [concept.md A3](../foundation/concept.md)) coordinates LLM workers. NOT an LLM managing other LLMs.

**HiClaw's flaw:** Manager is an LLM. It can hallucinate task assignments, forget to @mention workers, misjudge task complexity. The whole multi-agent system inherits the Manager's cognitive failures.

**Vinyan's approach:**

```
Human (or API)
    ↓
Vinyan Orchestrator (rule-based TypeScript process, non-LLM governance)
    ├── Task decomposition: LLM-assisted with Oracle validation at each level (see concept.md §8)
    ├── Risk assessment: calculates per-subtask risk scores
    ├── Worker assignment: matches subtask to worker profile (capability registry)
    ├── Execution: dispatches to workers (parallel where independent)
    ├── Validation: Oracle verification per subtask
    └── Aggregation: merges results, runs integration oracles
```

**Why NOT LLM-as-orchestrator (for governance):**
- Rule-based orchestration is reproducible — same input state → same routing/verification/commit decision
- No token cost for governance logic (routing, verification gating, commit decisions)
- Task decomposition IS LLM-assisted (see below), but the Orchestrator validates decomposition output through Oracles — the governance of decomposition is rule-based, even when inputs come from probabilistic sources
- Can be tested with unit tests (rule-based code, not prompt engineering)

**Iterative Task Decomposition (replaces one-shot planning):**

**Decomposition is LLM-assisted, not deterministic** (see [concept.md §8](../foundation/concept.md)). The initial task decomposition — breaking a user request into a high-level DAG — uses an LLM in its Generator Engine role (Decision 12). The Orchestrator does not decompose tasks through rules alone — natural language understanding requires an LLM. However, the Orchestrator's **governance** of decomposition is rule-based: it validates each decomposition level through Oracles, enforces structural constraints, and rejects invalid DAGs. **LLMs generate candidate decompositions; the Orchestrator validates and commits them.** This is consistent with A3 — governance decisions are rule-based, even when inputs come from probabilistic sources.

Planning loop: `Planner LLM (Generator Engine) → dep-oracle (structural) → coverage-validator (rule-based) → accept or replan (max 3 iterations)`

**Machine-checkable acceptance criteria** (all deterministic):
1. **No orphan leaf nodes** — every leaf in the task DAG has a parent
2. **No scope overlap** — subtask file sets don't intersect (or intersection is explicitly annotated as shared dependency)
3. **Coverage** — union of subtask targets ⊇ blast radius of original request
4. **Valid dependency order** — topological sort of the DAG succeeds
5. **Verification specified** — every leaf node specifies which oracle(s) will validate its output

**Two-tier validation** (preserves A5 Tiered Trust):
- **Deterministic tier**: dep-oracle, coverage-validator — MUST pass, has veto power
- **Heuristic tier**: Critic (LLM-as-judge) — advisory only, confidence < 1.0, logged but cannot override a deterministic pass. Active at Level 3 only.

**Planning depth scales with routing level:**
- Level 0-1 (Reflex/Heuristic): no planning — single task, direct execution
- Level 2 (Analytical): single-pass plan + deterministic validation (no Critic)
- Level 3 (Deliberative): iterative plan + Critic + full validation loop (max 3 iterations, then escalate to human)

---

### Decision 8: Perceptual Hierarchy + Working Memory

> **Axioms: A2, A4** — First-Class Uncertainty (Working Memory tracks failed approaches, active hypotheses, unresolved uncertainties) + Content-Addressed Truth (PerceptualHierarchy assembled from content-hashed sources)

**Choice:** Replace the flat StateVector with two distinct constructs: a **PerceptualHierarchy** (what the worker sees) and a **WorkingMemory** (what the Orchestrator tracks across retries).

**Why not keep StateVector?** StateVector assembles everything indiscriminately. A 50-file blast radius dumps 50 files of context regardless of what matters. PerceptualHierarchy filters by deterministic salience — dep-oracle traverses the dependency cone from task target, filtered by routing level depth.

**PerceptualHierarchy** — replaces StateVector. Salience is **deterministic** (preserving A3):
- Level 0-1 (Reflex/Heuristic): shallow — direct imports + diagnostics only
- Level 2-3 (Analytical/Deliberative): deep — transitive deps + World Graph facts + historical failure patterns

```typescript
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
    transitiveImporters?: string[];     // Level 2-3 only
    affectedTestFiles?: string[];       // Level 2-3 only
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

**WorkingMemory** — maintained by Orchestrator (not worker). Workers are stateless; they receive a snapshot and produce output. Working Memory turns "retry" into "replan with evidence":

```typescript
interface WorkingMemory {
  // Failed approaches — injected as hard constraints ("do NOT try X again")
  failedApproaches: Array<{
    approach: string;           // natural-language description
    oracleVerdict: string;      // which oracle rejected, with evidence
    timestamp: number;
  }>;

  // What the current plan is testing (for tracking and post-hoc analysis)
  activeHypotheses: Array<{
    hypothesis: string;         // "adding timeout parameter will fix race condition"
    confidence: number;         // Self-Model's predicted success probability
    source: string;             // which Reasoning Engine proposed this
  }>;

  // Things Self-Model flagged as low-confidence predictions
  unresolvedUncertainties: Array<{
    area: string;               // "test coverage for async paths"
    selfModelConfidence: number; // how confident Self-Model is in its own prediction
    suggestedAction: string;    // "run full test suite before commit"
  }>;

  // Verified facts from World Graph, scoped to current task's dependency cone
  scopedFacts: Array<{
    target: string;
    pattern: string;
    verified: boolean;
    hash: string;
  }>;
}
```

**Strategy escalation trigger:** After N failures on same task (configurable, default 3) → auto-escalate routing level. Level 1 → Level 2, Level 2 → Level 3, Level 3 → human escalation. Failed approaches from Working Memory are preserved across escalation.

**Assembly cost comparison:**

| Metric | Old StateVector | New PerceptualHierarchy |
|--------|----------------|------------------------|
| Git state | Always (~50ms) | Always (~50ms) |
| Dependency cone | Full blast radius | Filtered by routing level (~10-500ms) |
| Diagnostics | All warnings/errors | Cone-filtered only (~5ms) |
| Facts | All relevant facts | Cone-filtered + hash-verified (~10ms) |
| Working Memory | N/A | Orchestrator lookup (~1ms) |

---

### Decision 9: Adaptive Execution Lifecycle

> **Axioms: A3, A7** — Deterministic Governance (lifecycle steps are rule-based and fixed per routing level) + Prediction Error as Learning Signal (execution outcomes feed back into Self-Model calibration)

**Choice:** Replace the implicit generate→verify→retry flow with an **adaptive execution lifecycle** that scales with routing level. This is NOT one-size-fits-all — Level 0 tasks skip prediction/planning entirely; Level 3 tasks run the full cognitive pipeline.

**Lifecycle per routing level:**

| Step | Level 0 (Reflex) | Level 1 (Heuristic) | Level 2 (Analytical) | Level 3 (Deliberative) |
|------|----------|------------|-------------|---------------|
| **Perceive** | Cached skill lookup | PerceptualHierarchy (shallow) | PerceptualHierarchy (deep) | PerceptualHierarchy (deep) |
| **Predict** | — | — | Self-Model prediction | Self-Model prediction |
| **Plan** | — | — | Single-pass + deterministic validation | Iterative + Critic + full validation |
| **Generate** | Return cached result | Single worker | Single worker | Parallel workers (PHE) |
| **Verify** | Hash check only | Oracle validation | Oracle validation + QualityScore | Oracle + QualityScore + shadow execution |
| **Learn** | — | Trace recording | Trace + PredictionError | Trace + PredictionError + approach tagging |

**"Retry" is demoted to "replan with evidence":**

On Oracle rejection → record failure in `WorkingMemory.failedApproaches` → re-enter lifecycle at **Plan** step (not Generate) with blacklisted approach → re-generate with new plan. After N replans (configurable, default 3) → escalate routing level. This means:
- Level 1 failure (no planning) → escalate to Level 2 (adds planning + prediction)
- Level 2 failure after 3 replans → escalate to Level 3 (adds Critic + PHE)
- Level 3 failure after 3 replans → escalate to human

**Lifecycle state machine:**

```
START → Perceive → [Level ≥ 2?] → Predict → Plan → Validate Plan
                     │                                    │
                     │ no                          [pass?] │
                     ↓                              yes ↓  no → replan (max N)
                  Generate → Verify → [pass?] → Learn → DONE
                     ↑                   │
                     │                   no
                     └── replan with evidence (update WorkingMemory)
```

**Key invariant:** The Orchestrator controls lifecycle progression — workers never decide their own routing level, retry strategy, or escalation. Workers receive a `PerceptualHierarchy` + `WorkingMemory` snapshot and produce output. All governance state transitions are rule-based and state-reproducible (A3).

---

### Decision 10: Quality Signal — QualityScore as First-Class Contract

> **Axioms: A2, A7** — First-Class Uncertainty (quality is multi-dimensional, not binary) + Prediction Error as Learning Signal (QualityScore enables Self-Model calibration and Evolution Engine learning)

**Choice:** Extend Oracle verdicts from binary pass/fail to multi-dimensional quality signals. QualityScore is the prerequisite for Self-Model prediction, Evolution Engine learning, and future Skill Formation.

**Why this matters:** Binary pass/fail tells you "it works" but not "it's good." A function that passes all tests but doubles cyclomatic complexity is technically correct but architecturally harmful. Without quality signal, the Evolution Engine can only learn "what fails" — never "what succeeds well."

```typescript
interface QualityScore {
  architecturalCompliance: number;  // import depth, circular deps, layer violations (0.0–1.0)
  efficiency: number;               // tokens consumed / quality achieved (0.0–1.0)
  simplificationGain?: number;      // reduction in cyclomatic complexity (0.0–1.0). extended+.
  testMutationScore?: number;       // % of injected faults caught by tests. extended+.

  composite: number;                // weighted combination → single scalar for ranking
  dimensions_available: number;     // how many dimensions were actually computed
  phase: 'basic' | 'extended' | 'full';  // which dimensions are trustworthy
}
```

**Phase-gated rollout:**

| Dimension | Phase 0 | Phase 1 | Phase 2+ |
|-----------|---------|---------|----------|
| `architecturalCompliance` | ✅ (import analysis via dep-oracle) | ✅ | ✅ |
| `efficiency` | ✅ (tokens / task outcome) | ✅ | ✅ |
| `simplificationGain` | ❌ | ✅ (AST diff via tree-sitter) | ✅ |
| `testMutationScore` | ❌ | ✅ (mutation testing infra) | ✅ |
| `composite` reliability | Low (2 dimensions) | Medium (4 dimensions) | High (+ user feedback) |

**Impact on existing components:**
- **OracleVerdict** (Decision 3): optional `qualityScore` field added
- **ExecutionTrace** (Decision 6): `quality_score` field added for Evolution Engine consumption
- **Level 3 PHE** (Decision 4): multiple passing branches → select by highest `composite`
- **Self-Model** (Decision 11): predicts expected `composite`; PredictionError = |predicted - actual|
- **Skill Formation** (Phase 2): promotion criteria require minimum `composite` across N traces

---

### Decision 11: Self-Model — Forward Prediction + Calibration Loop

> **Axioms: A2, A7** — First-Class Uncertainty (Self-Model predictions carry explicit confidence) + Prediction Error as Learning Signal (PredictionError is the primary calibration signal)

**Choice:** Promote Self-Model from theoretical construct to Phase 1 implementation contract. The Self-Model predicts outcomes BEFORE execution; PredictionError after execution drives calibration.

**Cold-start honesty:** Phase 1 prediction accuracy will be **~50-60%** with static heuristic rules. This is acceptable — the value is in starting the calibration loop early, not in accurate Phase 1 predictions. Architecture consumers MUST NOT treat Self-Model predictions as reliable until Phase 2 calibration data exists.

**Cold-start safeguards** (per [concept.md §9.2](../foundation/concept.md)) to prevent bad predictions from poisoning the calibration loop:

| Safeguard | Mechanism | Configuration |
|:----------|:----------|:-------------|
| **Conservative override period** | During first N tasks, Self-Model routing is advisory only — Orchestrator defaults to L2 (Analytical) minimum regardless of prediction | `coldStart.overridePeriod: 50` |
| **Meta-uncertainty** | Self-Model outputs confidence-in-prediction based on sample size. With < 10 observations for a task pattern, meta-confidence forced to < 0.3, triggering conservative fallback | Automatic |
| **Human audit sampling** | During calibration (first 100 tasks), 10% of routing decisions flagged for optional human review — provides ground truth for miscalibration cases | `coldStart.auditSampleRate: 0.1` |
| **Monotonic trust ramp** | Self-Model's influence on routing increases monotonically as calibration error decreases — cannot gain authority faster than accuracy improves | `coldStart.trustRampEnabled: true` |
| **Hard routing floor** | Self-Model cannot route below L1 for any task with blast radius > 1 file | Immutable invariant |

**Self-Model specification:**

```typescript
interface SelfModelPrediction {
  taskId: string;
  timestamp: number;

  // Prediction targets
  expectedTestResults: 'pass' | 'fail' | 'partial';  // will tests pass?
  expectedBlastRadius: number;                        // how many files affected?
  expectedDuration: number;                           // ms
  expectedQualityScore: number;                       // predicted composite QualityScore
  uncertainAreas: string[];                            // what Self-Model is least confident about

  // Confidence metadata
  confidence: number;           // 0.0–1.0, how confident Self-Model is in these predictions
  basis: 'static-heuristic' | 'trace-calibrated' | 'hybrid';  // what generated this prediction
  calibrationDataPoints: number; // how many historical traces informed this prediction
}

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
    blastRadiusDelta: number;    // actual - predicted
    durationDelta: number;       // actual - predicted
    qualityScoreDelta: number;   // actual - predicted
    composite: number;           // normalized aggregate error
  };
}
```

**Cold-start heuristics (Phase 1):**

| Prediction Target | Heuristic Rule | Expected Accuracy |
|-------------------|---------------|-------------------|
| Test results | File has ≥3 tests + test coverage >70% → predict 'pass' | ~60% |
| Blast radius | dep-oracle transitive count | ~80% (deterministic) |
| Duration | Historical mean for similar file count | ~40% |
| Quality score | Baseline from project's last 20 traces | ~50% |

**Integration points:**
- **Before worker dispatch** (Level 2-3): Self-Model predicts outcomes → injected into `WorkingMemory.unresolvedUncertainties`
- **After Oracle verification**: PredictionError computed → stored in `ExecutionTrace.prediction_error`
- **Evolution Engine**: consumes PredictionError to calibrate routing thresholds and refine heuristics
- **Routing escalation**: if Self-Model confidence < 0.3 for a Level 1 task → auto-escalate to Level 2

---

### Decision 12: LLM Runtime Integration — Generator Engine

> **Axioms: A1, A2** — Epistemic Separation (LLM generates, separate engines verify — LLM never evaluates its own output) + First-Class Uncertainty (LLM outputs are wrapped with confidence as ECPResponse, never treated as verified facts)

**Choice:** LLMs are integrated as **Generator-class Reasoning Engines** via a provider-agnostic registry. The Orchestrator constructs prompts, dispatches to the appropriate provider, and wraps responses as ECP payloads. LLMs NEVER act as the brain — they are one source of hypotheses among many.

**Provider Registry:**

```typescript
interface LLMProvider {
  id: string;                           // "claude-opus", "gpt-4o", "ollama-llama3"
  type: 'cloud' | 'local';
  tier: 'fast' | 'balanced' | 'powerful';
  capabilities: string[];               // ["code-generation", "planning", "critique"]
  costPerMToken: number;                // normalized Vinyan Credits
  maxContextTokens: number;
  supportsStreaming: boolean;

  // Core API — all providers implement this
  generate(request: LLMRequest): Promise<LLMResponse>;
}

interface LLMRequest {
  systemPrompt: string;                 // Orchestrator-assembled (PerceptualHierarchy + constraints)
  userPrompt: string;                   // Task intent + WorkingMemory context
  maxTokens: number;
  temperature: number;                  // Lower for Level 0-1, higher for Level 3 exploration
  stopSequences?: string[];
  tools?: ToolDefinition[];             // Available tools for this task (see D13)
}

interface LLMResponse {
  content: string;
  toolCalls?: ToolCall[];               // Proposed tool calls (validated by Orchestrator before execution)
  tokensUsed: { input: number; output: number };
  model: string;
  stopReason: 'end_turn' | 'max_tokens' | 'tool_use';  // Anthropic API naming convention
}
```

**Prompt Construction Pipeline:**

```
1. PerceptualHierarchy assembly (→ D8)
   ├── Dependency cone (from dep-oracle)
   ├── Diagnostics (lint, type errors)
   ├── Verified facts (from World Graph)
   └── Runtime context

2. WorkingMemory injection (→ D8)
   ├── failedApproaches → "Do NOT try these again: [...]"
   ├── activeHypotheses → "Current plan: [...]"
   └── unresolvedUncertainties → "Caution areas: [...]"

3. Task intent
   ├── What to accomplish
   ├── Allowed file scope (from D5 permission model)
   └── Available tools (from D13 tool set)

4. System constraints
   ├── Output format requirements (structured JSON / diff)
   ├── Token budget
   └── Safety invariants (immutable rules)
```

**ECP Wrapping:** LLM responses are NEVER committed directly. They are wrapped as:

```typescript
// LLM output → ECPResponse wrapping
const ecpResponse: ECPResponse = {
  type: 'uncertain',                    // LLM output is ALWAYS uncertain until verified
  confidence: selfModel.predictedConfidence,  // Self-Model's prediction, NOT LLM's self-assessment
  evidence: [],                          // Empty — LLM provides no verified evidence
  falsifiable_by: plan.verificationCriteria,  // What oracles will check this against
};
```

**Provider Routing by Risk Level:**

| Risk Level | Default Provider Tier | Temperature | Budget |
|:-----------|:---------------------:|:-----------:|:------:|
| Level 0-1 (Reflex/Heuristic) | fast | 0.0-0.1 | 10K tokens |
| Level 2 (Analytical) | balanced | 0.2-0.4 | 50K tokens |
| Level 3 (Deliberative) | powerful | 0.3-0.7 | 100K tokens |
| Level 3 PHE (exploration) | powerful | 0.5-0.8 | 100K per branch |

**What this enables:** Vinyan can now generate code, plans, and solutions autonomously — while maintaining the core A1 invariant that the Generator never verifies its own work. Every LLM output flows through the Verification Gate (Oracles) before any state mutation occurs.

---

### Decision 19: ReasoningEngine — RE-Agnostic Generator Abstraction

> **Axioms: A1, A3, A6** — Epistemic Separation (any RE generates, Orchestrator governs) + Deterministic Governance (routing never depends on RE type) + Zero-Trust Execution (RE proposes; Orchestrator disposes)

**Problem:** Decision 12 defines `LLMProvider` as the dispatch boundary, coupling `WorkerPool` to LLM-flavored vocabulary (`generate()`, `stopReason: 'end_turn'`, `ThinkingConfig`, `cacheControl`). Any future Reasoning Engine — symbolic solver, local code model, AGI system — must conform to LLM-shaped APIs or require core loop changes.

**Choice:** Introduce `ReasoningEngine` as the primary generator abstraction above `LLMProvider`. `LLMProvider` is not removed; `LLMReasoningEngine` wraps it as a backward-compatible adapter.

**Interface:**

```typescript
interface ReasoningEngine {
  id: string;
  engineType: 'llm' | 'symbolic' | 'oracle' | 'hybrid' | 'external';
  capabilities: string[];    // PRIMARY routing selector — replaces tier-only selection
  tier?: 'fast' | 'balanced' | 'powerful';  // advisory, backward compat
  execute(request: RERequest): Promise<REResponse>;
}

// RERequest: prompt fields + providerOptions bag (LLM-specific: ThinkingConfig, cacheControl)
// REResponse: content + toolCalls + tokensUsed + engineId + terminationReason (generic naming)
```

**ReasoningEngineRegistry:**
- `selectByCapability(required: string[])` — capability-first, preferred for new REs
- `selectForRoutingLevel(level)` — tier-based fallback for backward compat
- `selectById(id)` — prefix-match resolution (same as LLMProviderRegistry)
- `fromLLMRegistry(llmReg)` — wraps existing registry; zero migration cost

**Dispatch path:**

| Path | RE Type | Isolation |
|------|---------|-----------|
| L1 in-process | Any `ReasoningEngine` | None (A6 warning in non-test mode) |
| L2/L3 in-process (no Docker) | Any `ReasoningEngine` | None |
| L2/L3 subprocess | **LLM-only** — `worker-entry.ts` reconstructs `LLMProviderRegistry` from env vars | Subprocess |
| L2/L3 container | **LLM-only** — same constraint | Docker |

**Design constraint:** Non-LLM REs dispatched at L2/L3 receive an isolation-degraded warning and fall back to in-process execution. This is intentional — serializing a non-LLM RE for subprocess reconstruction requires a protocol not yet defined.

**Plugging in a future AGI:**
```typescript
const agiFuture: ReasoningEngine = {
  id: 'agi-v1',
  engineType: 'external',
  capabilities: ['code-generation', 'reasoning', 'formal-proof'],
  execute: async (req) => { ... }
};
const engineRegistry = new ReasoningEngineRegistry();
engineRegistry.register(agiFuture);
createOrchestrator({ workspace, engineRegistry });
```
Core loop, risk router, oracle gate, and world graph require **zero changes**.

**What this achieves:** `WorkerPool` dispatch is decoupled from LLM vocabulary. Future REs register capabilities declaratively. The 7 axioms — especially A1, A3, A6 — remain invariant regardless of which RE executes.

---

### Decision 13: Tool Execution Model — Orchestrator-Mediated Environment Interaction

> **Axiom: A6** — Zero-Trust Execution (workers propose tool calls, Orchestrator validates and executes. Workers NEVER interact with the environment directly.)

**Choice:** The Orchestrator provides a sandboxed tool execution layer. Workers propose tool calls as structured requests; the Orchestrator validates permissions per risk level, executes the tool, and returns results as ECP evidence.

**Tool Categories & Permission Model:**

| Tool | Permission | L0 (in-process) | L1 (child proc) | L2 (container) |
|:-----|:-----------|:---:|:---:|:---:|
| `file_read` | Read file contents | ✅ | ✅ | ✅ |
| `file_write` | Create/edit file | ❌ | ✅ allowedPaths only | ✅ copy-on-write |
| `directory_list` | List directory | ✅ | ✅ | ✅ |
| `search_grep` | Text search in workspace | ✅ | ✅ | ✅ |
| `search_semantic` | Semantic code search | ✅ | ✅ | ✅ |
| `shell_exec` | Execute shell command | ❌ | ✅ allowlist only | ✅ sandboxed |
| `git_read` | Git status/log/diff/show | ✅ | ✅ | ✅ |
| `git_write` | Git add/commit/push | ❌ | ❌ | ❌ (human only) |
| `http_get` | Read-only HTTP | ❌ | ✅ allowlist | ✅ allowlist |

**Tool Call Flow:**

```
Worker proposes:   { tool: "file_write", path: "src/auth.ts", content: "..." }
        ↓
Orchestrator validates:
  1. Is file_write allowed for this risk level? (L1+ only)
  2. Is src/auth.ts in worker's allowedPaths? (D5 filesystem contract)
  3. Does content contain bypass/injection patterns? (D4 guardrails)
        ↓
If valid → Execute tool → Return result as ECP evidence:
  { type: 'known', confidence: 1.0, evidence: [{ file: "src/auth.ts", ... }] }
        ↓
If invalid → Reject with reason → Worker receives ECP denial:
  { type: 'unknown', confidence: 0.0, reason: "file_write not permitted at L0" }
```

**Tool Interface:**

```typescript
interface ToolDefinition {
  name: string;                         // "file_read", "shell_exec", etc.
  description: string;
  parameters: Record<string, { type: string; description: string; required: boolean }>;
  minIsolationLevel: 0 | 1 | 2;        // Minimum worker isolation level required
  requiresApproval: boolean;            // Human approval needed? (git_write = always)
}

interface ToolCall {
  id: string;                           // Unique call identifier
  tool: string;
  parameters: Record<string, unknown>;  // Standardized with code (was 'arguments')
}

interface ToolResult {
  callId: string;                       // References ToolCall.id
  tool: string;                         // Tool name that was executed
  status: 'success' | 'error' | 'denied'; // Denied = permission/isolation rejection
  output?: unknown;                     // Tool-specific output
  error?: string;
  evidence?: Evidence;                  // A4 compliance — file tools produce content hashes
  duration_ms: number;
}
```

**Shell Execution Allowlist (L1):**

```typescript
const SHELL_ALLOWLIST = [
  'tsc --noEmit',           // Type checking
  'bun test',               // Test execution
  'ruff check',             // Linting
  'eslint',                 // Linting
  'prettier --check',       // Formatting check
  'git status', 'git log', 'git diff', 'git show',  // Read-only git
];
// Any command not in allowlist → requires L2 (container) or human approval
```

**Rationale:** This is the missing piece that turns Vinyan from "verification engine" to "autonomous agent." Workers can now read files, write code, run tests, search the codebase — but always through the Orchestrator's permission layer, never directly. Combined with D12 (LLM Generator), Vinyan has the complete Generate→Tool→Verify loop.

---

### Decision 14: MCP External Interface — Tool Consumption & Oracle Exposure

> **Axiom: A2** — First-Class Uncertainty (MCP tool results lack epistemic metadata — the bridge must add confidence, evidence provenance, and uncertainty markers before MCP results enter Vinyan's ECP world)

**Choice:** Phase 1B extension. Vinyan acts as both **MCP client** (consume external tools) and **MCP server** (expose Oracles to other agents). The ECP↔MCP bridge translates between epistemic and non-epistemic protocols.

**Phase 1A vs 1B split:**
- **Phase 1A (core agent):** Built-in tools only (file I/O, shell, search per D13). No MCP dependency. Vinyan is a functional autonomous agent.
- **Phase 1B (interoperability):** MCP client + server. Extends Vinyan's tool ecosystem and makes Oracles consumable by Claude Code, HiClaw, etc.

**MCP Client — Consume External Tools:**

```typescript
interface MCPToolBridge {
  // Discover tools from connected MCP servers
  discoverTools(): Promise<ToolDefinition[]>;

  // Execute an MCP tool, wrapping result in ECP
  executeTool(call: ToolCall): Promise<ECPResponse>;
}

// Bridge: MCP result → ECP wrapping
function wrapMCPResult(mcpResult: MCPToolResult): ECPResponse {
  return {
    type: 'uncertain',                  // MCP tools have no epistemic guarantees
    confidence: 0.5,                    // Default — unknown reliability until calibrated
    evidence: [{
      source: `mcp://${mcpResult.server}/${mcpResult.tool}`,
      raw: mcpResult.content,
      timestamp: Date.now(),
    }],
    falsifiable_by: ['oracle-verification'],  // Must be verified before trusted
  };
}
```

**MCP Server — Expose Oracles:**

```typescript
// Vinyan exposes its Oracles as MCP tools for other agents to consume
const VinyanMCPServer = {
  tools: [
    {
      name: "vinyan_ast_verify",
      description: "Verify symbol existence, function signatures, import relationships via AST",
      inputSchema: HypothesisTupleSchema,
      handler: (input) => astOracle.verify(input),
    },
    {
      name: "vinyan_type_check",
      description: "Run type checker (tsc/pyright) on workspace",
      inputSchema: HypothesisTupleSchema,
      handler: (input) => typeOracle.verify(input),
    },
    {
      name: "vinyan_blast_radius",
      description: "Calculate which files are affected by a change",
      inputSchema: { target: "string" },
      handler: (input) => depOracle.analyze(input),
    },
    {
      name: "vinyan_world_query",
      description: "Query verified facts from World Graph",
      inputSchema: { target: "string", pattern: "string" },
      handler: (input) => worldGraph.query(input),
    },
  ],
};
```

**ECP↔MCP Bridge Design:**

| Direction | What flows | Translation |
|:----------|:-----------|:------------|
| MCP → ECP (consuming tools) | Raw tool result | Wrap with `confidence: 0.5`, mark `type: 'uncertain'`, require Oracle verification before trust |
| ECP → MCP (exposing Oracles) | OracleVerdict | Flatten to MCP tool result format, embed `confidence` and `evidence` as JSON in result content |

**Research question (deferred):** MCP has no concept of "I don't know." When an Oracle returns `type: 'unknown'`, what should the MCP server respond? Options: (a) return empty result with metadata, (b) MCP error code, (c) propose MCP protocol extension for epistemic states. This is tracked in the Open Questions.

---

### Decision 15: Cross-Language Oracle Process Model `[Phase 5]`

> **Axioms: A1, A4** — Epistemic Separation (cross-language verification maintains generation ≠ verification) + Content-Addressed Truth (file hashes work regardless of language)

**Choice:** Cross-language oracles run as external processes communicating via **stdin/stdout JSON-RPC** (same contract as existing oracles). `OracleConfig.command` (already declared in `config/schema.ts:14`) activates polyglot oracles.

**Alternatives considered:**

| Option | Pros | Cons | Verdict |
|--------|------|------|---------|
| Language-specific oracles as native processes | Natural toolchain per language, fastest execution | Each needs own stdin/stdout JSON mapping | ✅ Chosen |
| All oracles in TypeScript (shelling out) | Single toolchain, consistent | Double process overhead, harder to maintain language-specific logic | ❌ Rejected |
| LSP integration (gopls, pyright, rust-analyzer) | Rich diagnostics, incremental | Complex lifecycle management, LSP is stateful | ❌ Deferred (Phase 5+) |

**Oracle contract (unchanged):**
```
stdin: HypothesisTuple (JSON) → oracle process → stdout: OracleVerdict (JSON)
```

**Implementation:**
- `oracle/runner.ts:41` currently hardcodes `Bun.spawn(["bun", "run", oraclePath])`. When `OracleConfig.command` is set, spawn that command instead
- `oracle/registry.ts` gains `registerOracle(name, config)` for runtime registration
- Language detection: `package.json` → TypeScript, `pyproject.toml` → Python, `go.mod` → Go, `Cargo.toml` → Rust
- All language oracles share: circuit breaker, timeout handling, Zod validation (`oracle/protocol.ts`)
- **Concurrency:** Replace `Promise.all()` in `oracle/runner.ts` with bounded concurrency (semaphore, configurable `maxConcurrency`). Heavier cross-language oracles need throttling

**Per-language commands:**
| Language | Command | Tool | Tier |
|----------|---------|------|------|
| TypeScript | `bun run` (default) | tsc, tree-sitter | deterministic |
| Python | `python -m vinyan_pyright_oracle` | pyright | deterministic |
| Go | `vinyan-go-oracle` | `go vet` + `go build` | deterministic |
| Rust | `vinyan-rust-oracle` | `cargo check --message-format=json` | deterministic |

---

### Decision 16: Plugin System Architecture `[Phase 5]`

> **Axiom: A3** — Deterministic Governance (plugins cannot bypass oracle verification or inject governance decisions)

**Choice:** Plugins are **declarative manifests** that register additional oracles, tools, and LLM providers at startup. No plugin code executes inside the Orchestrator process.

**Plugin manifest schema:**
```typescript
interface PluginManifest {
  name: string;                           // unique identifier
  version: string;                        // semver
  vinyan_version: string;                 // minimum compatible Vinyan version
  provides: {
    oracles?: Array<{
      name: string;
      command: string;                    // process to spawn
      languages: string[];
      patterns: string[];                 // hypothesis patterns supported
      tier: "deterministic" | "heuristic" | "probabilistic";
    }>;
    tools?: Array<{
      name: string;
      command: string;
      category: "file" | "shell" | "search" | "network";
      sideEffect: boolean;
      minIsolationLevel: number;
    }>;
    providers?: Array<{
      id: string;
      tier: "fast" | "balanced" | "powerful";
      loader: string;                     // module path to dynamic import
    }>;
  };
}
```

**Loading:** `LLMProviderRegistry` gains `loadFromConfig(manifestPath)` for dynamic provider registration. `OracleRegistry` gains `registerFromManifest(manifest)`. `ToolClassifier` gains extension point for plugin-provided tools.

**Safety constraints:**
- Plugin oracles enter as `heuristic` tier maximum (never `deterministic` without explicit admin promotion)
- Plugin tools inherit the existing permission model (D13: Orchestrator-mediated)
- Plugin providers are treated as any other LLM provider (A6: zero-trust execution)
- Plugins cannot modify immutable invariants (I1–I17)

---

### Decision 17: Async EventBus for Multi-Instance `[Phase 5]`

> **Axiom: A3** — Deterministic Governance (local bus remains synchronous; async is additive for remote)

**Choice:** Dual-mode EventBus — local delivery remains synchronous FIFO (current behavior); cross-instance delivery uses async queued transport.

**Alternatives considered:**

| Option | Pros | Cons | Verdict |
|--------|------|------|---------|
| Replace bus with fully async | Uniform behavior | Breaks all existing subscribers, non-trivial migration | ❌ Rejected |
| **Dual-mode: sync local + async remote** | Zero breaking changes, incremental | Two code paths | ✅ Chosen |
| Separate remote event service | Clean separation | Different API for local vs remote events | ❌ Rejected |

**Implementation:**
- `src/core/bus.ts` interface unchanged. `VinyanBus.emit()` remains synchronous
- New `src/core/remote-bus.ts`: `RemoteBusAdapter` subscribes to local bus events, forwards configured subset to peers via ECP network transport (§2.4)
- Remote event delivery: at-least-once with idempotency (per [a2a-protocol.md](../spec/a2a-protocol.md) §6)
- Configurable event filter: only `sleep:cycleComplete`, `evolution:rulePromoted`, `evolution:ruleRetired`, `skill:outcome`, `fleet:convergence_warning` forwarded by default
- Bus event types extensible for plugins: `VinyanBus.registerEventType(name, schema)` for plugin-defined events

---

### Decision 18: Schema Migration Framework `[Phase 5]`

> **Axiom: A4** — Content-Addressed Truth (migration must preserve fact integrity and hash bindings)

**Choice:** Versioned forward-only migrations with a `schema_version` table. Replaces `CREATE TABLE IF NOT EXISTS` pattern.

**Alternatives considered:**

| Option | Pros | Cons | Verdict |
|--------|------|------|---------|
| Continue with CREATE IF NOT EXISTS | Zero migration code | Cannot alter columns, no rollback, no version tracking | ❌ Rejected |
| **Versioned migrations with schema_version table** | Track applied versions, ALTER TABLE support, auditable | Must implement migration runner | ✅ Chosen |
| ORM migration tool (Drizzle, Prisma) | Auto-generated migrations | Heavy dependency, Bun compatibility uncertain | ❌ Rejected |

**Implementation:**
```sql
CREATE TABLE IF NOT EXISTS schema_version (
  version INTEGER PRIMARY KEY,
  applied_at INTEGER NOT NULL DEFAULT (unixepoch()),
  description TEXT NOT NULL
);
```

- Migration runner in `src/db/migration-runner.ts`: reads `schema_version`, applies pending migrations in order
- Migrations are TypeScript files in `src/db/migrations/`: `001_initial.ts`, `002_add_dependency_edges.ts`, etc.
- Each migration exports `{ version: number, description: string, up(db: Database): void }`
- **Forward-only:** No down migrations. Rollback = restore from backup
- **Additive-only for Phase 5:** `ALTER TABLE ADD COLUMN` only. No column drops or renames
- Run at startup before any database access. Idempotent (skip already-applied versions)

**Critical constraint:** Migration must preserve World Graph fact integrity. File hashes, evidence chains, and hash-invalidation triggers must survive migration unchanged (A4).

---

### Decision 20: SKILL.md as ECP-Verified Capability Package `[Wave 1–4]`

> **Axioms: A1, A5, A7** — Epistemic Separation (skills are generated; Oracle Gate + Critic verify) + Tiered Trust (imported skills enter at `speculative`, promote on evidence) + Prediction Error as Learning Signal (autonomous skill creation fires on sustained PredictionError reduction, not success streaks)

**Context.** The agentic ecosystem is converging on `SKILL.md`-style portable capability artifacts (Hermes, Claude Code Skills, `agentskills.io`). The current Vinyan `CachedSkill` lifecycle is internal-only and keyed on trace similarity — it cannot import a third-party skill or export one, and its promotion logic leans on success count, which is a **streak signal**, not a **calibration signal** (A7 violation).

**Choice.** Adopt `SKILL.md` as Vinyan's capability artifact format with YAML frontmatter for the epistemic fields Vinyan already ledgers (`confidence_tier`, `content_hash`, `expected_error_reduction`, `backtest_id`). Every imported skill — whether from a hub, a peer, or autonomous creation — must pass the **Oracle Gate + Critic dry-run** before it can promote out of `speculative` quarantine. Autonomous skill creation fires on **sustained PredictionError reduction across a cluster of related traces**, not on a win streak.

**Alternatives considered:**

| Option | Pros | Cons | Verdict |
|--------|------|------|---------|
| Keep CachedSkill internal only | Zero new surface area | Cedes ecosystem to Hermes / agentskills.io; no import/export | ❌ Rejected |
| Adopt SKILL.md but promote on success count (Hermes-style) | Matches ecosystem expectations | Violates A7 — success count is streak noise, not calibration; imports would pollute memory | ❌ Rejected |
| **SKILL.md + Oracle Gate + PredictionError-delta promotion** | Matches ecosystem surface; raises the epistemic bar; imports cannot outrun the verifier | More rollout work (parser, schema, quarantine pipeline) | ✅ Chosen |

**Consequences.**
- Migration `004_skill_artifact.ts` adds `confidence_tier`, `skill_md_path`, `content_hash`, `expected_error_reduction`, `backtest_id`, `quarantined_at` to `cached_skills` (reserved in [w1-contracts §2](../spec/w1-contracts.md)).
- `skill-registry` is a `single (active)` plugin category (w1-contracts §5). Hub becomes the active provider once ready; the built-in `CachedSkill` store remains the fallback.
- Autonomous creation code path must read from `prediction_ledger + prediction_outcomes` — not `execution_traces` alone. Drafts carry `evidenceTier: 'probabilistic'`; post-Oracle they move to `heuristic`; post-backtest they may reach `deterministic` only if bound to a content hash.
- Skills Hub becomes an epistemic, not just a security, surface. This is flagship differentiator #2.

---

### Decision 21: Messaging Gateway = Adapter-Only, Core Loop Unchanged `[Wave 2–5]`

> **Axioms: A3, A6** — Deterministic Governance (every ingress path converges on one rule-based entry) + Zero-Trust Execution (adapters never execute; they only publish to the bus)

**Context.** The comparison reference (Hermes Agent from Nous Research) ships a messaging surface (Telegram, Slack, Discord, WhatsApp, Signal, Email, cron) as a first-class capability. The straightforward way to match this is to let each adapter call the relevant subsystem directly. That is exactly what we must not do — it creates N entry points to the governance pipeline and makes crash-safety, redaction, and audit N-way problems.

**Choice.** Every messaging adapter (Telegram, Slack, Discord, WhatsApp, Signal, Email) plus NL cron, ACP inbound, A2A peer, MCP bridge, CLI, and HTTP API **all** call the single `executeTask(input: TaskInput)` defined in [w1-contracts §4](../spec/w1-contracts.md). Adapters publish to the EventBus with **zero execution privilege** — they cannot read files, invoke oracles, or persist memory. They only turn a transport envelope into a `TaskInput` and hand it off.

**Alternatives considered:**

| Option | Pros | Cons | Verdict |
|--------|------|------|---------|
| Adapters call orchestrator subsystems directly | Lower latency, simpler adapter code | N entry points to governance, N-way audit, crash-safety fence violated | ❌ Rejected |
| Each adapter has its own mini-Orchestrator | Independent evolution | Massive duplication; impossible to keep A3 invariants consistent | ❌ Rejected |
| **Adapter-only: all paths converge on `executeTask`** | One rule-based entry, one audit trail, crash-safety preserved | Adapters slightly heavier (envelope translation) | ✅ Chosen |

**Consequences.**
- `TaskInput.source` enum enumerates all gateway paths (`gateway-telegram`, `gateway-slack`, `gateway-discord`, `gateway-whatsapp`, `gateway-signal`, `gateway-email`, `gateway-cron`, `acp`, `a2a`, `cli`, `api`, `internal`). Adding a new transport means extending this enum and amending w1-contracts, not adding an entry point.
- `originEnvelope` field carries the reply-routing context opaquely through the Core Loop so gateways can respond without re-parsing.
- Interrupt-and-redirect (H5) is *not* a second entry point. It is an evidence-delta Perceive re-run against the in-flight task (honoring the crash-safety fence in w1-contracts §4).
- ACP adapter (W5) is gateway-only. Internal A2A peer comms stay on ECP — we do not let an external protocol set confidence on internal records (clamp rule, w1-contracts §1).
- NL cron becomes a `ScheduledHypothesisTuple` row; the scheduler only *fires* `executeTask`; it does not execute.

---

### Decision 22: MemoryProvider Plugin Interface + Tiered Retrieval `[Wave 1–2]`

> **Axioms: A5, A7** — Tiered Trust (retrieval weights by evidence tier) + Prediction Error as Learning Signal (historical prediction error penalizes low-signal memories at retrieval time)

**Context.** The current built-in memory store is tightly coupled to the orchestrator — it is not swappable, and it ranks retrieval by cosine similarity plus recency alone. That ranker is tier-blind: a speculative inbound fact and a deterministic Oracle-verified fact compete as equals. It is also blind to whether a memory has previously been *evidence in a turn whose prediction was wrong* (a signal that something in that memory misled the model).

**Choice.** Refactor built-in memory behind a `MemoryProvider` plugin interface. Category cardinality is `single (active) + fallback chain` (w1-contracts §5). The retrieval ranker scores every candidate as:

```
score = similarity · tierWeight(evidenceTier) · recency(createdAt) − predErrorPenalty(memoryId)
```

where `tierWeight` prefers `deterministic > heuristic > probabilistic > speculative`, and `predErrorPenalty` accumulates from `prediction_outcomes` rows in which this memory appeared in `evidence_chain`.

**Alternatives considered:**

| Option | Pros | Cons | Verdict |
|--------|------|------|---------|
| Keep built-in memory; add more weights | Lower churn | Still not swappable; third parties cannot ship a provider | ❌ Rejected |
| Pure vector DB with external ranker | Ecosystem-standard | Loses provenance, invalidation, tier awareness | ❌ Rejected |
| **MemoryProvider interface + tier/predError-aware ranker** | Swappable; preserves A4/A5; compounds on A7 data | Small migration; ranker must be explainable | ✅ Chosen |

**Consequences.**
- Migration `003_memory_records.ts` creates `memory_records` + FTS5 `memory_records_fts` (w1-contracts §2) with mandatory `profile` column (w1-contracts §3).
- The ranker is part of observable routing (D23 / Differentiator #4) — it must emit its weight breakdown so users can see *why* a memory surfaced.
- `session_search` (W4) is an FTS5 tool over the same table, so FTS and vector retrieval share a row identity.
- Fallback chain means a failing plugin degrades to the default provider rather than taking the agent offline.
- This decision is what makes Differentiator #3 (dialectic USER.md) possible — USER.md is just a special-shaped set of `MemoryRecord`s consumed by the Critic.

---

### Decision 23: PredictionError-Tagged Trajectory Export as Flagship Data Asset `[Wave 1, 4]`

> **Axioms: A4, A7** — Content-Addressed Truth (trajectory manifest hash covers redacted payload; bypassing redaction shows as a manifest diff) + Prediction Error as Learning Signal (per-turn Brier/CRPS + OracleVerdict + evidence_chain are the signal, not the noise)

**Context.** The agentic ecosystem exports trajectories in ShareGPT / OpenAI-messages shape — chat-only, no epistemic metadata. Vinyan already ledgers per-turn `PredictionError`, per-turn `OracleVerdict`, and per-turn `evidence_chain`. Exporting those as JSONL alongside the chat tokens produces a training signal no other framework can generate: **behavior cloning data weighted by verified prediction error**. This is Vinyan's single biggest data moat.

**Choice.** Define an **ECP-enriched** trajectory format. Row identity is `trace_id` from `execution_traces.id` (w1-contracts §6). Each exported row carries, per turn:

- standard chat fields (messages, tool calls, tool results)
- Brier score + CRPS on every registered prediction
- `OracleVerdict` summary + verdict type (`verified | falsified | uncertain | unknown | contradictory`)
- `evidence_chain` (hash-rooted)
- `routingLevel` + the inputs that produced it (observable-routing payload)

Redaction of PII, secrets, and workspace paths runs **before** the manifest hash. Bypassing redaction therefore produces a **visible manifest diff** — tamper-evident by construction.

**Alternatives considered:**

| Option | Pros | Cons | Verdict |
|--------|------|------|---------|
| Export ShareGPT-only | Drop-in for existing tooling | Discards the moat (per-turn prediction error) | ❌ Rejected (as final state; acceptable as W1 MVP canary) |
| Export ECP-enriched + hash after (post-redaction) | Signature becomes meaningless under redaction edits | Tamper-evidence lost | ❌ Rejected |
| **ECP-enriched + hash redacted payload** | Preserves moat, tamper-evident, safe to publish | Larger rows; consumers must opt-in to enriched fields | ✅ Chosen |

**Consequences.**
- Migration `005_trajectory_export.ts` stores manifest pointers only; artifacts live on disk (w1-contracts §2).
- W1 ships the ShareGPT MVP as the canary that proves the join graph (`execution_traces ⋈ prediction_ledger ⋈ oracle_accuracy_store ⋈ session_turns`) already answers the learning-loop question — no new join keys.
- W4 ships the full ECP-enriched format once observable routing (same wave) produces a stable explainer payload to embed.
- This is Differentiator #1. Ownership of a public ECP-enriched trajectory dataset is downstream leverage (fine-tuning, benchmarking, research partnerships) that no Hermes-class framework can produce.

---

## 4. Technology Stack

| Component | Technology | Rationale |
|-----------|-----------|-----------|
| **Language** | TypeScript (Bun runtime) | Bun = fast startup for workers, broad ecosystem for Reasoning Engines |
| **World Graph** | SQLite (via `better-sqlite3`) | Zero-dependency, WAL mode for read concurrency |
| **AST parsing** | tree-sitter (via `node-tree-sitter`) | Multi-language, proven in every major IDE |
| **Type checking** | `tsc` CLI / Pyright CLI | Existing tools, deterministic |
| **Worker isolation** | `child_process.fork()` → Docker (progressive) | Match isolation to risk |
| **File watching** | `chokidar` | Proven, handles macOS FSEvents |
| **IPC** | JSON over stdio (child process) / mounted volume (Docker) | Crash-only design |
| **Configuration** | `vinyan.json` in workspace root | Per-project config (thresholds, oracle selection) |
| **Phase 0 host bridge** | Plugin hooks (Phase 0 only) | Proves ENS thesis before standalone orchestrator |
| **LLM providers** | Anthropic/OpenAI SDK, ollama | Multi-provider Generator Engine (D12) |
| **Tool execution** | Bun built-ins + child_process | File I/O, shell, search via Orchestrator-mediated permission model (D13) |
| **MCP bridge** | `@modelcontextprotocol/sdk` | External Interface — consume tools + expose Oracles (D14, Phase 1B) |

---

## 5. Configuration

```jsonc
// vinyan.json — project root
{
  "version": 1,

  // Oracle configuration
  "oracles": {
    "ast": { "enabled": true, "languages": ["typescript", "python"] },
    "type": { "enabled": true, "command": "tsc --noEmit" },
    "test": { "enabled": true, "command": "bun test", "timeout_ms": 30000 },
    "lint": { "enabled": true, "command": "ruff check" },
    "dep":  { "enabled": true }
  },

  // 4-level routing thresholds (concept.md §8)
  "routing": {
    "l0_max_risk": 0.2,
    "l1_max_risk": 0.4,
    "l2_max_risk": 0.7,
    // > l2_max_risk → Level 3 (Deliberative)
    "l0_l1_model": "claude-haiku",
    "l2_model": "claude-sonnet",
    "l3_model": "claude-opus",
    "l1_budget_tokens": 10000,
    "l2_budget_tokens": 50000,
    "l3_budget_tokens": 100000,
    "latency_budgets_ms": { "l0": 100, "l1": 2000, "l2": 10000, "l3": 60000 }
  },

  // Worker isolation
  "isolation": {
    "l0_max_risk": 0.2,
    "l1_max_risk": 0.7,
    // l2 (container) for everything above
    "container_image": "vinyan-sandbox:latest"
  },

  // Evolution engine
  "evolution": {
    "enabled": true,
    "sleep_cycle_interval_sessions": 20,
    "probation_sessions": 10,
    "min_effectiveness": 0.7
  },

  // Escalation
  "escalation": {
    "max_retries_before_human": 3,
    "risk_threshold_for_notification": 0.8,
    "channel": "matrix"  // or "slack", "stdout"
  }
}
```

---

## 6. Phase 0 Implementation — Proving Epistemic Verification

**Goal:** Prove the verification thesis — rule-based Oracle validation reduces **structural** hallucination (hallucinated symbols, wrong types, broken imports) in LLM-generated code. Phase 0 is a **verification library** inside a host agent, not an autonomous system. It proves A1 (epistemic separation) and A4 (content-addressed truth). See [concept.md §12.1](../foundation/concept.md) for the pre-registered experimental protocol. Claude Code (or compatible host) serves as the test host.

**Deliverables:**
1. Host bridge: `vinyan-oracle-gate` — deployed as Claude Code plugin, intercepts `before_tool_call` and `after_tool_call`
2. Oracle framework: `@vinyan/oracle` — pluggable oracle interface with built-in AST + type oracles
3. World Graph: `@vinyan/world-graph` — SQLite fact store with file hash invalidation
4. Operational guardrails: prompt injection defense + production boundary enforcement (A6)
5. CLI: `vinyan init` — generates `vinyan.json` for a project

**Plugin hook integration:**

```typescript
// Claude Code plugin entry point
export default {
  id: "vinyan-oracle-gate",
  register(api: HostPluginApi) {    // HostPluginApi = Claude Code or compatible host SDK
    // Before any tool call: sanitize + validate hypothesis (A6 Operational Guardrails)
    api.on("before_tool_call", async (event) => {
      // Guardrail: reject prompt injection patterns in tool parameters
      if (detectPromptInjection(event.params)) {
        return { block: true, blockReason: "Prompt injection pattern detected in tool parameters" };
      }

      // Guardrail: auto-reject worker attempts to bypass Oracle validation
      if (containsBypassAttempt(event.params)) {
        return { block: true, blockReason: "Worker attempted to bypass Oracle validation" };
      }

      if (!isMutatingTool(event.toolName)) return {};  // read-only → pass through

      const riskScore = await assessRisk(event);
      if (riskScore > config.escalation.risk_threshold_for_notification) {
        return { block: true, blockReason: `Risk score ${riskScore} exceeds threshold` };
      }

      // Run relevant oracles
      const verdicts = await runOracles(event.toolName, event.params);
      if (verdicts.some(v => !v.verified)) {
        return {
          block: true,
          blockReason: formatOracleFailures(verdicts),
        };
      }

      return {};  // allow execution
    });

    // After tool call: update World Graph with new facts
    api.on("after_tool_call", async (event) => {
      if (event.error) return;
      await updateWorldGraph(event.toolName, event.params, event.result);
    });

    // Before prompt: sanitize inputs + inject PerceptualHierarchy + WorkingMemory
    api.on("before_prompt_build", async (event) => {
      const sanitizedEvent = sanitizeInputPatterns(event);  // strip instruction-like patterns (A6)
      const perception = await assemblePerceptualHierarchy(sanitizedEvent);
      const workingMemory = await getWorkingMemory(event.taskId);
      return {
        systemPromptSuffix: formatPerception(perception, workingMemory),
      };
    });

    // Before model selection: route based on 4-level risk continuum (concept.md §8)
    api.on("before_model_resolve", async (event) => {
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
    });
  }
};
```

**What this proves:**
- Does Oracle validation catch errors that LLM self-evaluation misses?
- Does risk-based model routing reduce cost without reducing quality?
- Does the World Graph reduce context window degradation?
- Do operational guardrails (prompt injection defense, production boundary) prevent unsafe execution?

**What this does NOT solve (deferred to Phase 1+):**
- Multi-worker coordination (single agent in Phase 0)
- Full shadow execution (uses Claude Code's existing sandbox)
- Evolutionary governance (traces collected but not analyzed in Phase 0)

---

## 7. Phase 1 Implementation — Vinyan as Autonomous Agent

**Goal:** Vinyan becomes a complete AI agent that receives tasks, plans, generates code, executes tools, and verifies results — all coordinated by a rule-based, non-LLM Orchestrator. No host agent dependency.

**New components:**
- `vinyan-orchestrator` — long-running TypeScript process with core Perceive→Plan→Generate→Verify→Learn loop
- LLM Generator Engine — multi-provider registry, prompt construction from PerceptualHierarchy + WorkingMemory, response parsing + ECP wrapping (Decision 12)
- Tool Execution layer — file I/O, shell, search with Orchestrator-mediated permission model (Decision 13)
- Worker pool management (fork/kill child processes) with budget enforcement (Decision 5)
- 4-level adaptive routing (Reflex/Heuristic/Analytical/Deliberative) with budget tracking (Decision 4)
- Iterative task DAG decomposition with machine-checkable validation (Decision 7)
- PerceptualHierarchy assembly + WorkingMemory management (Decision 8)
- Self-Model prediction + PredictionError calibration loop (Decision 11)
- QualityScore computation: `architecturalCompliance` + `efficiency` + `simplificationGain` + `testMutationScore` (Decision 10)
- Telemetry collection for Evolution Engine (Decision 6)

**Phase 1B extension:**
- MCP External Interface — client for consuming external tools + server for exposing Oracles (Decision 14)

**Architecture change from Phase 0:**

```
Phase 0 (proof-of-concept):       Phase 1 (autonomous agent):
Claude Code (test host)           Vinyan Orchestrator (rule-based, non-LLM)
    ↓                                 ├── Perceive (World Graph + PerceptualHierarchy)
Vinyan Oracle Gate (host bridge)      ├── Predict (Self-Model)
    ↓                                 ├── Plan (Task Decomposer + dep-oracle)
Single agent w/ verification          ├── Generate (LLM Workers via D12)
                                      │   └── Tool Execution (D13)
                                      ├── Verify (Oracle Gate — AST, Type, Dep, Test)
                                      └── Learn (Trace + PredictionError + WorkingMemory)
```

**The critical shift:** Phase 0 deploys Vinyan's epistemic verification components inside Claude Code (test host to prove the thesis). Phase 1 makes Vinyan the complete agent loop — the Orchestrator owns the entire Perceive→Learn cycle. Oracle verification, World Graph, and Risk Routing (proven in Phase 0) are wired into the loop as first-class steps, not hooks.

---

## 8. Phase 2+ — Full Vision

| Phase | Milestone | Key Capability |
|-------|-----------|---------------|
| Phase 1B | MCP External Interface | MCP client (consume external tools) + MCP server (expose Oracles). Extends Phase 1A tool ecosystem. (Decision 14) |
| Phase 2 | Container Isolation + Pattern-Based Optimization | L2 workers in Docker, Shadow Execution for L3, **pattern detection** (Sleep Cycle extracts failure patterns → threshold adjustments + skill cache with probation/promotion). Realistic: 2–3 anti-patterns per 200 tasks. |
| Phase 3 | Full Self-Improvement (Research) | Full pattern mining + counterfactual generation, trace-calibrated Self-Model (replaces static heuristics), bounded rule modification |
| Phase 4 | Fleet Governance | Meritocratic worker profiles, capability-based routing |
| Phase 5 | Complete ENS | Standalone system, multi-instance coordination, cross-language support |

---

## 9. What Vinyan Takes From Each Framework

| Framework | What we take | What we avoid |
|-----------|-------------|---------------|
| **Claude Code (host)** | Plugin hooks, channel layer, session JSONL, tool definitions, prompt caching | Monolithic agent loop, self-evaluation, no risk routing |
| **HiClaw** | Credential isolation pattern, MinIO-like file IPC, task directory convention | LLM-as-orchestrator, chat-based coordination, Manager hallucinations |
| **Claude Code** | Hooks as deterministic scripts, permission model, subagent parallelism | Human-authored rules only (no self-evolution), no blast radius |
| **Claude Cowork** | VM-first isolation (VZVirtualMachine validates L2 VM approach), file-based auditable plugin system (inspiration for user-defined Oracles), sub-agent parallel decomposition with progress visibility, scheduled recurring task automation (validates Sleep Cycle concept), folder-scoped 3-tier permission model | LLM-only orchestration (no deterministic validation), no cross-session World Graph, desktop-must-stay-awake constraint, no risk routing or blast radius calculation, no self-evolution |
| **OpenHands** | EventStream architecture (inspiration for telemetry), Docker sandbox patterns | Single agent per task, no validation gate |

---

## 10. Success Criteria

> **Axiom Validation Gate:** Each phase's success criteria map to proving specific Core Axioms ([concept.md §1.1](../foundation/concept.md)). A phase is not complete until its axiom-mapped metrics pass.

### Phase 0 (Verification Library) — *Proves A1, A4; partially validates A5, A6*

Per the pre-registered experimental protocol in [concept.md §12.1](../foundation/concept.md):

- **Primary metric:** ≥25% reduction in structural error rate (broken imports, type errors, wrong signatures, non-existent symbol references) — treatment (agent + oracle gate) vs baseline (agent without oracle gate), measured over ≥30 TypeScript mutation tasks stratified by complexity
- **False positive rate:** Oracle rejects correct code < 10% of the time
- **Latency overhead:** < 3s per mutation (L1 budget)
- **Statistical test:** Paired comparison, Wilcoxon signed-rank test, α = 0.05
- Risk-based routing reduces token cost by ≥20% without reducing task success rate
- Operational guardrails block 100% of prompt injection test cases and production boundary violations
- **Go/No-Go:** Primary metric met AND false positive rate acceptable → proceed to Phase 1. Otherwise → analyze failure modes, iterate oracle design, or stop.

### Phase 1 (Autonomous Agent) — *Proves A1, A2, A3, A6, A7*
- Vinyan completes coding tasks end-to-end without host agent dependency
- Multi-worker tasks complete ≥2x faster than single-worker equivalent
- Level 2-3 (PHE parallel hypothesis) succeeds on tasks where Level 0-1 fails ≥50% of the time
- World Graph reduces redundant tool calls by ≥25% (agent reads verified facts instead of re-exploring)
- Iterative planning produces valid DAGs (passes all 5 machine-checkable criteria) in ≤2 iterations for >80% of tasks
- Self-Model PredictionError decreases by ≥20% over first 100 sessions (calibration loop working)
- QualityScore `composite` correlates with human quality judgment at r≥0.6
- LLM Generator Engine successfully wraps ≥3 providers (Claude, GPT, local) with identical ECP interface
- Tool Execution layer handles ≥10 tool types with zero permission violations over 100 sessions

### Phase 2 (Pattern-Based Optimization) — *Hardens A3, A6*
- Sleep Cycle detects ≥2 actionable anti-patterns from first 200 tasks
- Skill cache hit rate ≥30% for recurring task types after 100+ cached skills
- Container isolation blocks ≥99% of unauthorized state mutations
- Human escalation rate drops below 15% of total tasks

### Phase 3+ (Research) — *Validates A7 at scale*
- Full pattern mining produces rules that outperform random threshold adjustment (measured via backtesting)
- Trace-calibrated Self-Model prediction accuracy ≥75% (up from ~55% cold-start)
- Fleet governance demotes underperforming configurations within 20 sessions

---

## 11. Open Questions (Deferred to Implementation)

| Question | Current Assumption | When to Resolve |
|----------|-------------------|-----------------|
| ~~How to decompose ambiguous tasks into a DAG?~~ | **Resolved**: Iterative planning loop with 5 machine-checkable criteria (Decision 7) | — |
| How to handle Oracle disagreements? (ast-oracle passes, type-oracle fails) | Any-fail = block. May need weighted voting later. | Phase 0 data collection |
| How to share World Graph across workers without race conditions? | Read-only copy per worker, merge on return. Orchestrator is single writer. | Phase 1 implementation |
| What's the right PHE depth for Level 3? | 2–3 levels (approach → implementation → validation). | Phase 2 experiments |
| When does the Orchestrator itself need an LLM? | Task decomposition (all levels) + Critic (Level 3 only). All governance (routing, verification gating, commit) is rule-based. See Decision 7 and [concept.md §8](../foundation/concept.md). | Phase 1 — validate this assumption |
| Should L2 use VM (VZVirtualMachine-style) or Docker? | Docker for Phase 2 MVP. VM for security-critical ops. | Phase 2 — benchmark overhead vs. isolation guarantees |
| How fast does Self-Model calibrate from static heuristics? | ~50-60% initial accuracy, improving with PredictionError feedback. Target: >75% by 200 sessions. | Phase 1 — track calibration curve |
| What's the minimum QualityScore dimensions needed for useful Skill Formation? | Hypothesis: 3 dimensions (architectural + efficiency + simplificationGain). | Phase 2 — when Skill Formation cache activates |

---

## 12. Failure Modes & Recovery Strategies

For the complete failure mode analysis (F1–F5), see [concept.md §14](../foundation/concept.md). Key failure scenarios and their architectural mitigations:

| Failure Mode | Architecture Mitigation |
|:-------------|:-----------------------|
| **Oracle false negative** (rejects correct code) | Configurable human override with audit trail. Oracle accuracy tracked — systematic false negatives trigger Evolution Engine review (Decision 6). Phase 0 metric: false positive rate < 10%. |
| **Oracle false positive** (accepts incorrect code) | Tiered verification (A5) — no single Oracle is sole gate. Multi-dimensional QualityScore (Decision 10) provides additional signal. Semantic errors explicitly out of scope for deterministic Oracles — require test coverage or human review. |
| **World Graph inconsistency** | SQLite WAL mode + write-ahead journaling (Decision 2). On inconsistency: invalidate entire dependency cone and rebuild from source. Content-hash binding (A4) ensures inconsistency is always detectable. |
| **Self-Model miscalibration cascade** | Cold-start safeguards (Decision 11): conservative override period, meta-uncertainty, monotonic trust ramp. Hard floor: cannot route below L1 for blast radius > 1 file. |
| **Risk scoring miscalibration** | Evolution Engine (Decision 6) adjusts risk weights based on prediction error (A7). Immutable safety floor: production mutations always ≥ L3 regardless of risk score. |

**Design principle:** detect (content hashes, prediction error, accuracy tracking) → contain (invalidate affected scope) → recover (rebuild from source of truth) → learn (feed failure into Evolution Engine).
