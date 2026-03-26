# Vinyan — Architecture Design Decisions

> **Document boundary**: This document owns the **concrete architecture, component design, and technology decisions** for building Vinyan.
> For vision/philosophy, see [vinyan-concept.md](vinyan-concept.md). For gap analysis vs. competitors, see [vinyan-gap-analysis.md](vinyan-gap-analysis.md).

---

## 1. Architectural Thesis

**Core Decision:** Vinyan is NOT another agent framework. It is a **Deterministic Governance Layer** that wraps existing LLM runtimes with epistemic validation, risk-based routing, and evolutionary telemetry.

This means:
- Phase 0–1: Vinyan runs as plugins/hooks inside OpenClaw (reuse channels, tools, session management)
- Phase 2+: Vinyan grows its own Orchestrator process that coordinates multiple runtimes
- Never: Vinyan does NOT reinvent channel integration, tool protocols, or session persistence

**Rationale from source code analysis:**
- OpenClaw's `runEmbeddedPiAgent()` is a 1,800-line function with deeply integrated retry, compaction, failover, and hook systems. Replacing it is a multi-year effort with diminishing returns.
- HiClaw proved that a governance layer (Manager) on top of OpenClaw agents works in production.
- Claude Code's hooks system proves deterministic scripts can intercept LLM decisions without modifying the runtime.
- Claude Cowork proves the **"same agentic SDK, different UX surface"** pattern — built in ~1.5 weeks on top of Claude Code's SDK, serving knowledge workers instead of developers. This validates that Vinyan's orchestrator core can power multiple frontends (CLI, VS Code extension, web dashboard) without architectural changes.

---

## 2. System Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                     Human Interface Layer                        │
│   OpenClaw Channels (20+) │ Matrix (multi-agent) │ API/CLI      │
└─────────────────────┬───────────────────────────────────────────┘
                      │
┌─────────────────────▼───────────────────────────────────────────┐
│                  Vinyan Governance Layer                          │
│  ┌──────────┐  ┌──────────────┐  ┌────────────┐  ┌───────────┐ │
│  │ Epistemic│  │ Risk Router  │  │ World Graph│  │ Evolution │ │
│  │ Oracle   │  │ (Sys1/Sys2)  │  │ (Truth DB) │  │ Engine    │ │
│  │ Gateway  │  │              │  │            │  │           │ │
│  └─────┬────┘  └──────┬───────┘  └─────┬──────┘  └─────┬─────┘ │
│        │              │                │                │       │
│  ┌─────▼──────────────▼────────────────▼────────────────▼─────┐ │
│  │              Orchestrator Core (Event Bus)                  │ │
│  └─────────────────────┬───────────────────────────────────────┘ │
└─────────────────────────┼───────────────────────────────────────┘
                          │
┌─────────────────────────▼───────────────────────────────────────┐
│                   Execution Substrate                            │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌────────────────┐  │
│  │ Worker 1 │  │ Worker 2 │  │ Worker N │  │ Shadow Sandbox │  │
│  │ (process)│  │ (process)│  │ (process)│  │ (Docker/microVM)│  │
│  └──────────┘  └──────────┘  └──────────┘  └────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
```

---

## 3. Key Design Decisions

### Decision 1: OpenClaw as Foundation, Not Fork

**Choice:** Build Vinyan as OpenClaw plugins (Phase 0–1), then as a sidecar governance process (Phase 2+).

**Alternatives considered:**
| Option | Pros | Cons | Verdict |
|--------|------|------|---------|
| Fork OpenClaw | Full control | 336k-star maintenance burden, divergence | ❌ Rejected |
| Build from scratch | Clean design | Years to reach channel/tool parity | ❌ Rejected |
| **Plugin + sidecar** | Instant production use, incremental migration | Constrained by hook points | ✅ Chosen |

**Implementation:**
- `before_tool_call` hook → Epistemic Oracle Gateway (validate hypothesis before execution)
- `after_tool_call` hook → World Graph update (record verified facts)
- `before_model_resolve` hook → Risk Router (select model tier based on task risk)
- `before_prompt_build` hook → Context injection (inject StateVector from World Graph)
- Separate process → Orchestrator Core (manages workers, tracks evolution)

**Source code evidence:** OpenClaw's hook system is production-hardened. `createHookRunner()` supports priority ordering, `block=true` terminal semantics, and sequential chaining. The `before_tool_call` hook can modify params OR block execution — exactly what Oracles need.

---

### Decision 2: World Graph — SQLite + File Hash Binding

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

### Decision 3: Epistemic Oracle — Pluggable Child Process Architecture

**Choice:** Each Oracle is a standalone executable that receives a HypothesisTuple on stdin and returns an OracleVerdict on stdout.

**Rationale:**
- Oracles must be deterministic — they MUST NOT call LLMs
- Child process isolation prevents a crashing oracle from taking down the orchestrator
- Any language can implement an oracle (TypeScript, Python, Rust, shell script)
- Timeout enforcement per oracle (kill child process after N seconds)

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
interface OracleVerdict {
  verified: boolean;
  evidence: Array<{
    file: string;
    line: number;
    snippet: string;
  }>;
  fileHashes: Record<string, string>;  // path → SHA-256
  reason?: string;          // human-readable explanation when !verified
  duration_ms: number;
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

**Choice:** Numeric risk score from static analysis, with threshold-based routing to System 1 or System 2.

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
  reversibility: number;    // 0.0–1.0 (additive=1.0, destructive=0.0)
  hasSecurityImplication: boolean;  // touches auth/crypto/env files
}

function calculateRiskScore(factors: RiskFactors): number {
  const base =
    (factors.blastRadius * 0.25) +
    (factors.dependencyDepth * 0.15) +
    ((1 - factors.testCoverage) * 0.20) +
    (factors.fileVolatility * 0.10) +
    ((1 - factors.reversibility) * 0.20) +
    (factors.hasSecurityImplication ? 0.10 : 0);

  return Math.min(1.0, base);
}

// Routing thresholds (configurable per project)
const SYSTEM_1_THRESHOLD = 0.4;   // below → System 1 (fast, cheap)
const SYSTEM_2_THRESHOLD = 0.7;   // above → System 2 (MCTS, expensive)
// between → System 1 with human notification
```

**System 1 (Linear Execution):**
- Single worker, sequential tool calls
- Fast model (e.g., Claude Haiku, GPT-4o-mini)
- No shadow execution — direct commit after Oracle validation
- Budget cap: 10K tokens per task

**System 2 (Branching Execution):**
- Multiple workers explore in parallel (MCTS-inspired)
- Powerful model (e.g., Claude Opus, o3)
- Shadow execution in Docker sandbox before commit
- Budget cap: 100K tokens per task, with early termination on Oracle pass
- Selection: choose the branch where ALL Oracles pass with highest test coverage

**System 2 is NOT traditional MCTS.** Classical MCTS requires a simulation function and reward signal. For code mutations, the "simulation" is shadow execution and the "reward" is Oracle pass rate. The tree is shallow (typically 2–3 levels: approach selection → implementation → validation).

---

### Decision 5: Worker Isolation — Progressive Levels

**Choice:** Three isolation levels based on risk score, not one-size-fits-all.

| Level | When | Mechanism | Overhead |
|-------|------|-----------|----------|
| **L0: In-process** | Risk < 0.2 (read-only operations) | Same Node.js process, restricted tool set | ~0ms |
| **L1: Child process** | Risk 0.2–0.7 (standard mutations) | `child_process.fork()`, IPC via stdio | ~50ms |
| **L2: VM / Container** | Risk > 0.7 (destructive/security-sensitive) | VM (Apple VZVirtualMachine) or Docker container with mounted workspace copy | ~2–5s |

**Rationale:** HiClaw uses containers for everything (500ms+ startup per worker). OpenClaw uses in-process with optional sandbox. Claude Cowork validates that **full VM isolation** (via Apple Virtualization Framework's `VZVirtualMachine`) is production-viable for agent workloads — giving a hard OS boundary rather than Docker's shared kernel. Vinyan's progressive model matches isolation cost to actual risk: Docker for standard high-risk tasks, VM for security-critical operations where kernel-level isolation is required.

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
    └── if fail → log, route to System 2 or escalate
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
}
```

**Sleep Cycle (background analysis):**

1. **Trigger:** Every N sessions or on idle (cron-like)
2. **Analysis:** Query traces for recurring failure patterns:
   - Same oracle failing >3x on similar file patterns → generate rule
   - System 2 consistently succeeding where System 1 fails → adjust threshold
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

**Choice:** Vinyan Orchestrator (deterministic, non-LLM) coordinates LLM workers. NOT an LLM managing other LLMs.

**HiClaw's flaw:** Manager is an LLM. It can hallucinate task assignments, forget to @mention workers, misjudge task complexity. The whole multi-agent system inherits the Manager's cognitive failures.

**Vinyan's approach:**

```
Human (or API)
    ↓
Vinyan Orchestrator (deterministic TypeScript process)
    ├── Task decomposition: uses dep-oracle to identify affected subsystems
    ├── Risk assessment: calculates per-subtask risk scores
    ├── Worker assignment: matches subtask to worker profile (capability registry)
    ├── Execution: dispatches to workers (parallel where independent)
    ├── Validation: Oracle verification per subtask
    └── Aggregation: merges results, runs integration oracles
```

**Why NOT LLM-as-orchestrator:**
- Deterministic orchestration is reproducible — same input → same dispatch plan
- No token cost for coordination logic
- No hallucinated task decomposition
- Can be tested with unit tests (deterministic code, not prompt engineering)

**When LLM IS needed for task decomposition:**
- For ambiguous human requests, use a single "Planner" LLM call to produce a structured task DAG
- The Planner output is validated against the dependency oracle before execution
- This is a one-shot call, not an ongoing LLM process managing workers

---

### Decision 8: Ambient Sensor Matrix — StateVector Assembly

**Choice:** Deterministic script that assembles a StateVector before every worker dispatch.

**Implementation:**

```typescript
interface StateVector {
  // Git state
  git: {
    branch: string;
    uncommittedFiles: string[];
    recentCommits: Array<{ hash: string; message: string; files: string[] }>;
  };

  // Dependency graph (relevant to task)
  dependencies: {
    directImporters: string[];    // files that import the target
    directImportees: string[];    // files the target imports
    transitiveBlastRadius: number; // total files in dependency cone
  };

  // Code health
  diagnostics: {
    lintWarnings: number;
    typeErrors: number;
    failingTests: string[];
  };

  // World Graph summary (relevant verified facts)
  verifiedFacts: Array<{
    target: string;
    pattern: string;
    verified_at: number;
  }>;

  // Runtime context
  runtime: {
    nodeVersion: string;
    os: string;
    availableTools: string[];
  };
}
```

**Assembly cost:** StateVector is assembled ONCE per worker dispatch, using cached results where possible:
- Git state: `git status` + `git log -5` (~50ms)
- Dependencies: Cached import graph, invalidated on file change (~10ms cache hit, ~500ms cold)
- Diagnostics: Last lint/type-check results from World Graph (~5ms)
- Facts: SQLite query filtered by task target (~10ms)

---

## 4. Technology Stack

| Component | Technology | Rationale |
|-----------|-----------|-----------|
| **Language** | TypeScript (Bun runtime) | Same as OpenClaw → plugin compatibility, Bun = fast startup for workers |
| **World Graph** | SQLite (via `better-sqlite3`) | Zero-dependency, WAL mode for read concurrency |
| **AST parsing** | tree-sitter (via `node-tree-sitter`) | Multi-language, proven in every major IDE |
| **Type checking** | `tsc` CLI / Pyright CLI | Existing tools, deterministic |
| **Worker isolation** | `child_process.fork()` → Docker (progressive) | Match isolation to risk |
| **File watching** | `chokidar` | Proven, handles macOS FSEvents |
| **IPC** | JSON over stdio (child process) / mounted volume (Docker) | Crash-only design |
| **Configuration** | `vinyan.json` in workspace root | Per-project config (thresholds, oracle selection) |
| **OpenClaw integration** | Plugin hooks + custom extension | Non-invasive, upgradeable |

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

  // Risk routing thresholds
  "routing": {
    "system1_max_risk": 0.4,
    "system2_min_risk": 0.7,
    "system1_model": "claude-haiku",
    "system2_model": "claude-opus",
    "system1_budget_tokens": 10000,
    "system2_budget_tokens": 100000
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

## 6. Phase 0 Implementation — Vinyan as OpenClaw Plugin

**Goal:** Prove that deterministic Oracle validation reduces hallucinated execution in production.

**Deliverables:**
1. OpenClaw plugin: `vinyan-oracle-gate` — intercepts `before_tool_call` and `after_tool_call`
2. Oracle framework: `@vinyan/oracle` — pluggable oracle interface with built-in AST + type oracles
3. World Graph: `@vinyan/world-graph` — SQLite fact store with file hash invalidation
4. CLI: `vinyan init` — generates `vinyan.json` for a project

**Plugin hook integration:**

```typescript
// OpenClaw plugin entry point
export default {
  id: "vinyan-oracle-gate",
  register(api: OpenClawPluginApi) {
    // Before any tool call: validate hypothesis if mutation is proposed
    api.on("before_tool_call", async (event) => {
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

    // Before prompt: inject StateVector
    api.on("before_prompt_build", async (event) => {
      const stateVector = await assembleStateVector(event);
      return {
        systemPromptSuffix: formatStateVector(stateVector),
      };
    });

    // Before model selection: route based on risk
    api.on("before_model_resolve", async (event) => {
      const risk = await estimateTaskRisk(event.prompt);
      if (risk > config.routing.system2_min_risk) {
        return { modelOverride: config.routing.system2_model };
      }
      if (risk < config.routing.system1_max_risk) {
        return { modelOverride: config.routing.system1_model };
      }
      return {};
    });
  }
};
```

**What this proves:**
- Does Oracle validation catch errors that LLM self-evaluation misses?
- Does risk-based model routing reduce cost without reducing quality?
- Does the World Graph reduce context window degradation?

**What this does NOT solve (deferred to Phase 1+):**
- Multi-worker coordination (single agent in Phase 0)
- Full shadow execution (uses OpenClaw's existing sandbox)
- Evolutionary governance (traces collected but not analyzed in Phase 0)

---

## 7. Phase 1 Implementation — Vinyan Orchestrator

**Goal:** Standalone orchestrator process that coordinates multiple workers with risk routing.

**New components:**
- `vinyan-orchestrator` — long-running TypeScript process
- Worker pool management (fork/kill child processes)
- System 1/System 2 routing with budget tracking
- Task DAG decomposition (single LLM call → validated by dep-oracle)
- Telemetry collection for Evolution Engine

**Architecture change from Phase 0:**

```
Phase 0:                          Phase 1:
OpenClaw → Vinyan plugin          Vinyan Orchestrator (standalone)
    ↓                                 ↓                    ↓
Single agent                      Worker 1 (process)   Worker 2 (process)
                                  (OpenClaw runtime)   (OpenClaw runtime)
```

---

## 8. Phase 2+ — Full Vision

| Phase | Milestone | Key Capability |
|-------|-----------|---------------|
| Phase 2 | VM / Container isolation | L2 workers in VM (VZVirtualMachine) or Docker, Shadow Execution for System 2 |
| Phase 3 | Evolution Engine | Sleep Cycle, automated rule generation, probation → promotion |
| Phase 4 | Fleet Governance | Meritocratic worker profiles, capability-based routing |
| Phase 5 | Self-hosted Orchestrator | No dependency on OpenClaw runtime |

---

## 9. What Vinyan Takes From Each Framework

| Framework | What we take | What we avoid |
|-----------|-------------|---------------|
| **OpenClaw** | Plugin hooks, channel layer, session JSONL, tool definitions, prompt caching | Monolithic agent loop, self-evaluation, no risk routing |
| **HiClaw** | Credential isolation pattern, MinIO-like file IPC, task directory convention | LLM-as-orchestrator, chat-based coordination, Manager hallucinations |
| **Claude Code** | Hooks as deterministic scripts, permission model, subagent parallelism | Human-authored rules only (no self-evolution), no blast radius |
| **Claude Cowork** | VM-first isolation (VZVirtualMachine validates L2 VM approach), file-based auditable plugin system (inspiration for user-defined Oracles), sub-agent parallel decomposition with progress visibility, scheduled recurring task automation (validates Sleep Cycle concept), folder-scoped 3-tier permission model | LLM-only orchestration (no deterministic validation), no cross-session World Graph, desktop-must-stay-awake constraint, no risk routing or blast radius calculation, no self-evolution |
| **OpenHands** | EventStream architecture (inspiration for telemetry), Docker sandbox patterns | Single agent per task, no validation gate |

---

## 10. Success Criteria

### Phase 0 (Vinyan Oracle Gate plugin)
- Oracle validation catches ≥30% of mutations that would have failed (measured against baseline without plugin)
- Risk-based routing reduces token cost by ≥20% without reducing task success rate
- Zero false positives from Oracle blocking in first 100 sessions (tune thresholds)

### Phase 1 (Orchestrator)
- Multi-worker tasks complete ≥2x faster than single-worker equivalent
- System 2 (MCTS branching) succeeds on tasks where System 1 fails ≥50% of the time
- World Graph reduces redundant tool calls by ≥25% (agent reads verified facts instead of re-exploring)

### Phase 2+ (Full vision)
- Evolution Engine generates ≥5 useful rules per 1000 sessions
- Meritocratic fleet governance demotes underperforming configurations within 20 sessions
- Human escalation rate drops below 10% of total tasks

---

## 11. Open Questions (Deferred to Implementation)

| Question | Current Assumption | When to Resolve |
|----------|-------------------|-----------------|
| How to decompose ambiguous tasks into a DAG? | Single LLM "Planner" call, validated by dep-oracle | Phase 1 prototype |
| How to handle Oracle disagreements? (ast-oracle passes, type-oracle fails) | Any-fail = block. May need weighted voting later. | Phase 0 data collection |
| How to share World Graph across workers without race conditions? | Read-only copy per worker, merge on return. Orchestrator is single writer. | Phase 1 implementation |
| What's the right MCTS depth for System 2? | 2–3 levels (approach → implementation → validation). Deeper exploration unlikely to help for code. | Phase 2 experiments |
| When does the Orchestrator itself need an LLM? | Task decomposition only. All other coordination is deterministic. | Phase 1 — validate this assumption |
| Should L2 use VM (VZVirtualMachine-style) or Docker? | Docker for Phase 2 MVP. VM for security-critical ops (Cowork proves VM overhead is acceptable for agent workloads). | Phase 2 — benchmark overhead vs. isolation guarantees |
| Should Vinyan support scheduled recurring tasks (like Cowork's `/schedule`)? | Yes — maps to Evolution Engine's Sleep Cycle. But Vinyan's version is self-directed (pattern mining + rule generation), not human-scheduled. | Phase 3 — when Evolution Engine is implemented |
