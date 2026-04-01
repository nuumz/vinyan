# Vinyan Implementation Plan

> Generated: 2026-03-29 | Updated: 2026-03-31 (Phase 5 gap closure) | Branch: `feature/main`
> Source of truth: [vinyan-concept.md](vinyan-concept.md) §12, [vinyan-tdd.md](vinyan-tdd.md) §4–§19, [vinyan-architecture.md](vinyan-architecture.md)

---

## Phase 0: Oracle Gate MVP — ✅ Complete

### Overall Status: 100% Complete (57 test files, 0 type errors)

| Component | TDD § | Status | Completion | Notes |
|:----------|:-----:|:------:|:----------:|:------|
| ECP Transport (stdio JSON) | §3 | ✅ Done | 100% | Circuit breaker, `timeout_behavior`, runner timeout consumption |
| Oracle Registry & Config | §4 | ✅ Done | 100% | 5 oracles (ast/type/dep/test/lint), `tier` + `timeout_behavior` in schema |
| World Graph (SQLite) | §5 | ✅ Done | 100% | `fact_evidence_files` table, retention policy (30d/10 sessions/50K facts) |
| Risk Scoring + 4-Level Routing | §6 | ✅ Done | 100% | `calculateRiskScore`, `routeByRisk`, `RiskFactors` with normalization |
| Operational Guardrails | §7 | ✅ Done | 100% | Injection/bypass detection, environment detection |
| Host Strategy (Gate Pipeline) | §8 | ✅ Done | 100% | `after_tool_call` hook, `isMutatingTool()`, risk-integrated gate |
| Session Logging | §9 | ✅ Done | 100% | `mutation_hash`, `blocked_verdicts`, FP candidate detection |

### What Works (57 test files, 0 type errors)

- Oracle pipeline: guardrails → config → 5 oracles (ast/type/dep/test/lint) → aggregate → verdict → JSONL log
- World Graph: SQLite + WAL mode, content-hash binding, cascade invalidation via trigger, `fact_evidence_files` junction, retention policy
- Risk Router: weighted risk scoring with normalization, 4-level routing (L0-L3)
- Circuit Breaker: 3-failure threshold, 60s reset, half-open probe
- Benchmark: 100% TPR on 30 mutation cases, 0% FPR
- Experiment: 100% structural error reduction on 50 A/B tasks
- Guardrails: 100% injection/bypass detection, 0% false positives

### Phase 0 Completion Gaps — ✅ All Resolved

| # | Gap | Status | Implementation |
|:--|:----|:------:|:---------------|
| **P0-1** | `calculateRiskScore()` + `routeByRisk()` + `RiskFactors`/`RoutingDecision` | ✅ | `src/gate/risk-router.ts` — weighted sum with normalization; types in `src/orchestrator/types.ts` |
| **P0-2** | `fact_evidence_files` junction table | ✅ | `src/world-graph/schema.ts` — table + index; used in `world-graph.ts` INSERT |
| **P0-3** | `OracleCircuitBreaker` (3 failures → open, 60s reset) | ✅ | `src/oracle/circuit-breaker.ts` — 9 test cases covering all states |
| **P0-4** | `OracleConfig.tier` + `timeout_behavior` fields | ✅ | `src/config/schema.ts` — enum + schema defaults; wired in `cli/init.ts` |
| **P0-5** | `QualityScore` computation | ✅ | `src/gate/quality-score.ts` — 2-4 dimensions (arch, efficiency, simplification, testMutation) |
| **P0-6** | `test-oracle` (P99 ≤ 5,000ms) | ✅ | `src/oracle/test/test-verifier.ts` + `index.ts` + tests |
| **P0-7** | `lint-oracle` (P99 ≤ 1,000ms) | ✅ | `src/oracle/lint/lint-verifier.ts` + `index.ts` + tests |
| **P0-8** | `after_tool_call` hook | ✅ | `src/gate/hooks.ts` — stores verified verdicts as facts, invalidates files |
| **P0-9** | `isMutatingTool()` classification | ✅ | `src/gate/tool-classifier.ts` — READONLY_TOOLS set; used in gate decision |
| **P0-10** | World Graph retention policy | ✅ | `src/world-graph/retention.ts` — maxAgeDays=30, keepLastSessions=10, maxFactCount=50K |
| **P0-11** | `blocked_verdicts` + `mutation_hash` | ✅ | `src/gate/logger.ts` — both fields in interface; populated in gate.ts |
| **P0-12** | Oracle config `timeout_ms` consumption | ✅ | `src/oracle/runner.ts` reads `options.timeout_ms`; `gate.ts` reads from oracleConf |

### Items Originally Deferred — Now Implemented in Phase 1/2

| Item | Phase | Status |
|:-----|:-----:|:------:|
| `QualityScore.simplificationGain`, `testMutationScore` | 1C.3 | ✅ Done |
| Self-Model / PredictionError / ExecutionTrace | 1C.1, 2.3 | ✅ Done |
| Orchestrator Core Loop | 1A.7 | ✅ Done |
| Task Decomposer + DAG Validation | 1C.2 | ✅ Done |
| Event Bus | 1C.4 | ✅ Done |
| Sleep Cycle + Wilson scoring | 2.4 | ✅ Done |
| Skill Formation (CachedSkill lifecycle) | 2.5 | ✅ Done |
| Evolution Engine (rules, backtester, resolver, safety) | 2.6 | ✅ Done |

### Items Still Deferred

- ~~`uncertain`/`contradictory` verdict types in actual oracle output~~ ✅ Resolved by Phase 4.5 WP-4 (oracles now emit `type: 'uncertain'` for degraded conditions)
- ~~5-step Contradiction Resolution~~ ✅ Resolved by Phase 4.5 WP-1 (`src/gate/conflict-resolver.ts`)
- `deliberation_request` and `temporal_context` ECP extensions → Phase 5 PH5.7
- ~~Bounded cascade invalidation (`cascadeInvalidation` with `maxDepth`)~~ ✅ Resolved by Phase 4.5 WP-3 (`queryDependents(file, maxDepth=3)`)
- MCP External Interface (Client Bridge + Server) → Phase 5 PH5.5
- `before_prompt_build` with `PerceptualHierarchy` → Phase 1 (already implemented via `perception.ts`)
- `before_model_resolve` with Self-Model routing → Phase 1 (already implemented via `self-model.ts` + `risk-router-adapter.ts`)

---

### Phase 0→1 Transition Guide

Phase 0 runs as a verification library inside a host agent. Phase 1 replaces the host — Vinyan IS the agent. TDD §8 defines Phase 0 as a "thin, replaceable host integration adapter"; §16 specifies the Orchestrator as its replacement.

`runGate(request: GateRequest): Promise<GateVerdict>` is generic — callable from both host hooks and the Phase 1 Orchestrator internally. No redesign needed.

| Phase 0 Component | Phase 1 Disposition | Notes |
|:---|:---|:---|
| `src/gate/gate.ts` (`runGate`) | **Reuse as-is** | Orchestrator calls `runGate()` in Verify step |
| `src/oracle/*` (ast/type/dep) | **Reuse as-is** | Oracles are transport-agnostic |
| `src/world-graph/*` | **Reuse as-is** | Orchestrator commits facts via existing API |
| `src/guardrails/*` | **Reuse + extend** | Add `sanitizeWorkerInput()` for Phase 1 worker prompts |
| `src/config/schema.ts` | **Extend** | Add Orchestrator config (routing thresholds, worker budgets) |
| `src/gate/logger.ts` (JSONL) | **Wrap** | Phase 1 adds `ExecutionTrace` (SQLite) alongside JSONL session logs |
| `src/cli/index.ts` | **Extend** | Add `vinyan run` command (1A.8) |
| Host-specific hooks (`before_tool_call`) | **Deprecate** | Replaced by Orchestrator lifecycle; remove after Phase 1 stable |

**Breaking changes:** None for Phase 0 consumers. Phase 1 adds new entry points without removing existing ones.

---

## Phase 1: Autonomous Agent — ✅ 1A/1C Complete, 1B Deferred

> **Goal:** Transform Vinyan from a verification library into a complete autonomous AI agent.
> **Prerequisite:** ~~Phase 0 completion gaps P0-1 through P0-5 (minimum).~~ ✅ All prerequisites met.

### Sub-Phase 1A: Foundation (Orchestrator Core Loop) — ✅ Complete

All 8 items implemented with tests. See individual sections below for implementation details.

#### Dependency Graph

```
1A.1 (Types) ──┬── 1A.2 (Perception + WorkingMemory) ──┐
               │                                         ├── 1A.6 (Worker Pool) ── 1A.7 (Core Loop) ── 1A.8 (CLI)
               ├── 1A.3 (Risk Router) ─────────────────┤
               │                                         │
               ├── 1A.4 (Tool Execution) ───────────────┤
               │                                         │
               └── 1A.5 (LLM Generator Engine) ────────┘
```

**Parallel work streams:**
- Stream A: 1A.1 → 1A.2 → 1A.3
- Stream B: 1A.1 → 1A.4 → 1A.5 → 1A.6
- Merge: 1A.7 (requires both streams)

---

#### 1A.1 — ECP Types and Interfaces `[S]` ✅

**What:** Define the Phase 1 type system. `src/core/types.ts` owns shared primitives used across phases; `src/orchestrator/types.ts` owns Phase 1+ Orchestrator-specific interfaces.

**Key types to add:**
- `RoutingLevel` (0 | 1 | 2 | 3), `IsolationLevel`, `RiskFactors`, `RoutingDecision` → `src/core/types.ts` (shared with Phase 0 risk scoring)
- `TaskInput`, `TaskResult` (§16.1) → `src/orchestrator/types.ts`
- `PerceptualHierarchy`, `WorkingMemory` (arch D8) → `src/orchestrator/types.ts`
- `WorkerInput`, `WorkerOutput`, `WorkerBudget` (§11, §16.3) → `src/orchestrator/types.ts`
- `LLMProvider`, `LLMRequest`, `LLMResponse` (§17.1) → `src/orchestrator/types.ts`
- `Tool`, `ToolCall`, `ToolResult`, `ToolContext` (§18.1) → `src/orchestrator/types.ts`
- `TaskDAG`, `DagValidationCriteria` (§10) → `src/orchestrator/types.ts`
- `ECPProtocolVersion` = 1 (literal constant) — added to ECP request/response for future backward compatibility

**Implementation:**
1. Add `RoutingLevel`, `IsolationLevel`, `ECPProtocolVersion` to `src/core/types.ts`
2. Create `src/orchestrator/types.ts` with Phase 1 interfaces (re-exports shared types from core)
3. Create Zod schemas in `src/orchestrator/protocol.ts` for IPC boundaries (`WorkerInput`/`WorkerOutput`)

**Tests:** `tsc --noEmit` + Zod round-trip tests for IPC schemas.

---

#### 1A.2 — Working Memory + Perception Assembler `[M]` ✅

**What:** WorkingMemory tracks failed approaches across retries. PerceptionAssembler builds the `PerceptualHierarchy` per routing level.

**Key files:**
- `src/orchestrator/working-memory.ts` — per-task in-memory store for failed approaches, hypotheses, uncertainties
- `src/orchestrator/perception.ts` — assembles perception by querying dep-oracle + World Graph + diagnostics

**Implementation:**
1. WorkingMemory: simple class with `recordFailedApproach()`, `addUncertainties()`, `getSnapshot()`
2. PerceptionAssembler:
   - **Dependency cone**: call `depVerify()` → use `directDeps` array for L0-L1, add `transitiveDeps` for L2-L3
   - **World Graph query**: `SELECT * FROM facts WHERE source_file IN (?)` with dependency cone file paths as bind params
   - **Diagnostics**: run `Bun.spawn(['tsc', '--noEmit', '--pretty', 'false'])`, parse stdout for errors in cone files
   - **Output**: `PerceptualHierarchy { depCone, facts, diagnostics, routingLevel }`
3. Filter depth by routing level: L0-L1 = `directDeps` only, L2-L3 = `directDeps` ∪ `transitiveDeps`

**Dependencies:** 1A.1, existing dep-oracle, existing World Graph

**Tests:** Unit for WorkingMemory ops. Integration test: small TS project → verify L1 perception (direct deps only) vs L2 (transitive included).

---

#### 1A.3 — Risk Router `[M]` ✅

**What:** Calculate risk score and determine initial routing level (L0-L3). Upgrades the ~~missing~~ Phase 0 risk scoring (P0-1) with blast radius, file classification, and historical data.

**Key files:**
- `src/orchestrator/risk-router.ts` — `calculateRiskScore()`, `assessInitialLevel()`

**Implementation:**
1. `calculateRiskScore(factors: RiskFactors): number` — weighted sum of blast radius, file sensitivity, irreversibility, historical failure rate
2. `assessInitialLevel()` — map score to level using config thresholds (`l0_max_risk`, `l1_max_risk`, `l2_max_risk`)
3. Apply hard routing floor: blast radius > 1 file → minimum L1

**Dependencies:** 1A.1, existing dep-oracle, config schema (thresholds already defined)

**Tests:** Threshold boundary tests. Hard floor invariant. Various file/dependency combinations.

---

#### 1A.4 — Tool Execution Layer `[L]` ✅

**What:** Workers propose tool calls; Orchestrator validates permissions and executes. This is what makes Vinyan an actual agent.

**Key files:**
- `src/orchestrator/tools/types.ts` — interfaces
- `src/orchestrator/tools/validator.ts` — 4-check validation (isolation level, path, shell allowlist, bypass)
- `src/orchestrator/tools/executor.ts` — `ToolExecutor` class
- `src/orchestrator/tools/builtins/` — `file-read`, `file-write`, `file-edit`, `directory-list`, `search-grep`, `shell-exec`, `git-status`, `git-diff`

**Implementation:**
1. Define `Tool` interface with `name`, `parameters`, `minIsolationLevel`, `category`, `execute()`
2. Implement `validateToolCall()`: isolation level check → path permission → shell allowlist → bypass detection (reuse `containsBypassAttempt()`)
3. Implement 8 built-in tools using Bun APIs + `Bun.spawn()` for shell
4. `ToolExecutor` iterates proposed calls, validates, executes allowed ones
5. `toolResultToEvidence()` per TDD §18.4

**Dependencies:** 1A.1, existing guardrails

**Tests:** TDD §18.5 acceptance criteria (8 test cases). Per-tool integration tests.

---

#### 1A.5 — LLM Generator Engine `[L]` ✅

**What:** Wraps LLM providers as Generator-class Reasoning Engines. Constructs prompts, dispatches to provider, wraps response in ECP.

**Key files:**
- `src/orchestrator/generator/registry.ts` — `LLMProviderRegistry`
- `src/orchestrator/generator/providers/anthropic.ts`, `openai.ts`, `ollama.ts`
- `src/orchestrator/generator/prompt-assembler.ts` — builds system/user prompt from perception + memory
- `src/orchestrator/generator/ecp-wrapper.ts` — wraps LLM response with `type: 'uncertain'`

**Implementation:**
1. Add deps: `@anthropic-ai/sdk`, `openai`
2. `LLMProviderRegistry` — register/select providers by tier, map routing level → provider
3. Anthropic provider: `messages.create()` with tool_use → `ToolCall[]`; OpenAI: `function_call` → normalize to `ToolCall[]`
4. `PromptAssembler`: ROLE + PERCEPTION + CONSTRAINTS (failed approaches) + OUTPUT FORMAT sections. Output format per TDD §17.2: structured JSON `{ explanation, files: [{ path, diff }], toolCalls: [...] }`
5. `wrapLLMResponse()`: always `type: 'uncertain'`, confidence from Self-Model (not LLM self-assessment)
6. **Error handling for unparseable LLM output**: if response is not valid JSON or missing required fields → wrap as `WorkerOutput` with `proposal.action: 'parse_error'`, count as failed attempt in WorkingMemory, retry within same routing level budget

**Dependencies:** 1A.1, 1A.2 (WorkingMemory for prompt constraints)

**Tests:** TDD §17.5 (7 test cases). Mock providers for unit tests; real provider tests behind env-var gate. Additional: malformed LLM response → verify error handling + retry.

---

#### 1A.6 — Worker Pool Manager `[L]` ✅

**What:** Manage worker processes. L0 = in-process, L1 = `child_process.fork()` with JSON IPC.

**Key files:**
- `src/orchestrator/worker/pool.ts` — `WorkerPoolManager`
- `src/orchestrator/worker/worker-entry.ts` — L1 child process entry point

**Implementation:**
1. L0 dispatch: direct function call (generator + tool execution in same process)
2. L1 dispatch: `Bun.spawn()` with `WorkerInput` JSON on stdin → `WorkerOutput` JSON on stdout (reuse pattern from `src/oracle/runner.ts`)
3. Budget enforcement: `setTimeout` → `proc.kill()` on exceed
4. Worker lifecycle tracking: active/idle/killed counts

**Dependencies:** 1A.1, 1A.4, 1A.5

**Tests:** L0/L1 dispatch round-trip. Timeout enforcement. Pool status tracking.

---

#### 1A.7 — Orchestrator Core Loop `[XL]` ✅

**What:** The central nervous system. 6-step lifecycle: Perceive → Predict → Plan → Generate → Verify → Learn.

**Key files:**
- `src/orchestrator/core-loop.ts` — `executeTask(input: TaskInput): Promise<TaskResult>`
- `src/orchestrator/trace-collector.ts` — records `ExecutionTrace` to SQLite
- `src/orchestrator/index.ts` — wires components, exports `Orchestrator`

**Implementation:**
1. Constructor: inject all dependencies (perception, risk router, worker pool, oracle gate, world graph, trace collector)
2. Nested loop: outer = routing level escalation (L0→L1→L2→L3→human), inner = retry within level (max 3)
3. Each iteration: Perceive → Predict (L2+ only, stub initially) → Plan (L2+ only, stub initially) → Generate → Tool Execute → Verify → Learn
4. On Oracle rejection: record in WorkingMemory, re-enter at Plan step
5. On retry exhaustion: escalate routing level, preserve WorkingMemory
6. On L3 exhaustion: return `status: 'escalated'`
7. On success: record trace, commit facts to World Graph

**Verify step detail (per TDD §16.2):**
- After worker returns `WorkerOutput` with proposed tool calls → Orchestrator executes tools (1A.4)
- For each executed tool: `toolResultToEvidence()` (§18.4) wraps result as ECP evidence with content hash
- Call `oracleGate.verify(proposal, perception)` → aggregate verdicts using existing `runGate()` (any-fail = block)
- Compute `QualityScore` from verdicts (Phase 0 proxy: oracle pass ratio + latency efficiency)
- **Rejection after tool execution**: Phase 1 does NOT roll back file writes — the next retry uses WorkingMemory ("approach X failed because...") to generate a corrective proposal. Phase 2 containers (2.1) enable true rollback via ephemeral workspace copies.

**Learn step detail (per TDD §16.2):**
- **On success**: `traceCollector.record({ taskId, outcome: 'success', routingLevel, oracleVerdicts, qualityScore, predictionError, tokensUsed })` → `worldGraph.commitFacts(verdicts)` converts oracle verdicts to `Fact` records in World Graph
- **On failure**: `workingMemory.recordFailedApproach({ approach: proposal.explanation, oracleVerdict: formatFailures(verdicts), timestamp })` → `traceCollector.record({ outcome: 'failure', failureReason })` → re-enter at Plan step (not Generate)

**Latency budget**: total task budget per TDD §13: L0 < 100ms, L1 < 2s, L2 < 10s, L3 < 60s. Inner retry loop tracks cumulative time; budget exceed → escalate routing level.

**Dependencies:** ALL of 1A.1–1A.6

**Tests:** TDD §16.4 (8 acceptance criteria). End-to-end task flow. Failed approach → retry. Routing escalation. Worker timeout. Human escalation. Oracle rejection after tool execution → verify WorkingMemory records + no rollback.

---

#### 1A.8 — CLI Agent Mode `[S]` ✅

**What:** `vinyan run "task description" --file src/foo.ts --budget 50000`

**Implementation:** Parse args → construct `TaskInput` → call `executeTask()` → print `TaskResult`.

**Dependencies:** 1A.7

---

### Sub-Phase 1B: Interoperability (MCP External Interface) — ❌ Deferred

> Can ship independently after 1A. Adds tool consumption from MCP servers and Oracle exposure to other agents.
> **Status:** Not implemented. No `src/mcp/` directory exists. Deferred until external integration is needed.

#### 1B.1 — MCP Client Bridge `[M]`

**What:** Connect to external MCP servers, discover tools, execute with ECP wrapping.

**Key files:** `src/mcp/client.ts`, `src/mcp/ecp-bridge.ts`

**Implementation:**
1. Add `@modelcontextprotocol/sdk`
2. `MCPClientBridge`: connect (stdio/HTTP), discover tools, execute tool, disconnect
3. Trust level → confidence mapping: untrusted=0.3, semi-trusted=0.5, trusted=0.7 (never 1.0)
4. Register MCP tools in ToolExecutor as `category: 'external'`, `minIsolationLevel: 1`

---

#### 1B.2 — MCP Server (Oracle Exposure) `[M]`

**What:** Expose 4 Vinyan tools: `vinyan_ast_verify`, `vinyan_type_check`, `vinyan_blast_radius`, `vinyan_query_facts`.

**Key files:** `src/mcp/server.ts`, `src/mcp/server-entry.ts`

**Implementation:** Uses `@modelcontextprotocol/sdk` Server. Each handler calls existing oracle functions. Handle `type: 'unknown'` → `{ verified: null, reason }`.

**Tests:** TDD §19.5 acceptance criteria (6 test cases).

---

### Sub-Phase 1C: Intelligence Layer — ✅ Complete

> Makes the Orchestrator smarter. 1A works with stubs; 1C replaces them. Can ship incrementally.
> **Status:** All 4 items implemented. Stubs remain as fallbacks when LLM/DB unavailable.

#### 1C.1 — Self-Model (Heuristic Predictor) `[L]` ✅

**What:** Predict outcomes before execution. Compare predictions vs actuals. Start with ~50-60% accuracy.

**Key files:** `src/orchestrator/self-model/predictor.ts`, `calibration.ts`, `routing-floor.ts`

**Implementation:**
1. Cold-start heuristics per TDD §12: test results (~60%), blast radius (~80%), duration (~40%), quality score (~50%)
2. `metaConfidence`: < 10 observations → forced < 0.3
3. `applyRoutingFloor()`: S1 (conservative override first 50 tasks), hard floor (blast > 1 → L1 min), S2 (low meta-confidence → bump level)
4. SQLite `self_model_observations` table

---

#### 1C.2 — Task Decomposer (LLM-Assisted Planning) `[L]` ✅

**What:** Break complex tasks into `TaskDAG` using LLM + deterministic validation. Active at L2-L3 only.

**Key files:** `src/orchestrator/planner/decomposer.ts`, `validator.ts`

**Implementation:**
1. Call generator with planning-specific prompt → parse as `TaskDAG`
2. `validateDAG()`: 5 machine-checkable criteria (no orphans, no overlap, coverage, valid deps, verification specified)
3. Iterative: up to 3 attempts with structured feedback → `EscalationError` on failure

---

#### 1C.3 — QualityScore Phase 1 Dimensions `[M]` ✅

**What:** Activate `simplificationGain` (AST complexity diff) and `testMutationScore` (mutation testing).

**Implementation:** tree-sitter complexity comparison + basic mutation testing (inject faults, run tests, count caught).

---

#### 1C.4 — Event Bus `[S]` ✅

**What:** Deterministic message routing between Orchestrator components.

**Implementation:** Typed EventEmitter. Events: `task:start`, `task:complete`, `worker:dispatch`, `oracle:verdict`, `trace:record`. Three listeners: audit, CLI progress, trace.

---

## Phase 2: Multi-Worker Isolation + Skill Formation — ⚠️ Mostly Complete

> **Goal:** Harden execution model, begin self-improvement loop.
> **Prerequisite:** Phase 1 complete. Sub-features activate progressively via data gates:
>
> | Feature | Gate Conditions |
> |---------|----------------|
> | 2.1–2.3 (infrastructure) | None — available immediately |
> | 2.4 Sleep Cycle | `trace_count ≥ 100 AND distinct_task_types ≥ 5` |
> | 2.5 Skill Formation | 2.4 active + `patterns_extracted ≥ 1` |
> | 2.6 Evolution Engine | `trace_count ≥ 200 AND active_skills ≥ 1 AND sleep_cycles_run ≥ 3` |
>
> Each gate is checked by `checkDataGate(feature, stats, config): DataGate` before feature activation.

### 2.1 — Worker Isolation L2 (Container) `[L]` ⚠️ Partial

**What:** Docker container isolation for high-risk tasks. Two-layer mount strategy: workspace read-only + writable overlay for mutations.

**Approach:**
- `vinyan-sandbox` Docker image (Bun + tree-sitter + tsc)
- WorkerPoolManager L2 dispatch (two-layer mount):
  ```
  docker run --rm \
    --user 1000:1000 \
    --cap-drop=ALL \
    --security-opt=no-new-privileges \
    --network=none \
    --pids-limit=256 \
    --memory=1g \
    -v $WORKSPACE:/workspace:ro \
    -v $(mktemp -d)/vinyan-overlay-$TASK_ID:/overlay:rw \
    -v $(mktemp -d)/vinyan-ipc-$TASK_ID:/ipc:rw \
    vinyan-sandbox:latest
  ```
- **Container hardening** (minimum profile for POC): non-root user, drop all capabilities, no-new-privileges, no network access, PID/memory limits. seccomp/apparmor profiles deferred to production hardening phase.
- `/workspace` is **read-only** — the real project files are never directly mutated by the container
- `/overlay` is the **writable layer** — worker writes all mutations here (never to `/workspace`)
- `/ipc` is the **IPC channel** — `intent.json` in, `result.json` + `artifacts/` out
- `docker kill` on budget exceed

**Artifact Commit Protocol:**
1. Worker writes mutations to `/overlay`, copies final artifacts to `/ipc/artifacts/`
2. Orchestrator reads `/ipc/result.json` + `/ipc/artifacts/*`
3. **On oracle pass**: Orchestrator applies artifacts to real workspace (hash-verified via A4) after path safety checks:
   - All artifact paths must be relative (reject absolute paths)
   - `realpath(resolve(workspace, artifactPath))` must start with `workspace + '/'`
   - Reject symlinks (`lstat` → reject if symlink)
   - Reject paths containing `..` segments before resolution
   - **Reuse**: extract `validateWorkspacePath()` from existing `tool-validator.ts:42-46` containment check
4. **On oracle fail or timeout**: Orchestrator deletes temp dirs — zero-cost rollback
5. Config: `overlay_strategy: 'tmpdir' | 'docker-tmpfs'` (default: `tmpdir` — works on macOS Docker Desktop)

**Risks:** Docker startup overhead (2-5s), macOS volume permissions, dangling container cleanup, temp dir leak on orchestrator crash (mitigated by OS-level /tmp cleanup).

### 2.2 — Shadow Execution `[L]` ⚠️ Partial

**What:** L3 tasks split into online path (user-facing, subject to 60s budget) and offline shadow validation (async, separate budget). PHE workers run in the offline path.

**Approach (Online/Offline Split):**

**Online path (≤ 60s, subject to L3 latency budget):**
- Single L2 worker generates candidate mutation
- Structural oracle verification only (ast + type + dep)
- Returns to caller with `validation_depth: 'structural'`
- This preserves the L3 < 60s design constraint from TDD §6

**Offline shadow validation (async, ≤ 300s):**
- **Must-enqueue-before-response invariant**: Orchestrator inserts `ShadowJob` (status: `'pending'`) into SQLite **before** returning online `TaskResult`. This ensures crash-safety — if the orchestrator dies after online commit, the shadow job survives in the database.
- **Startup recovery**: On orchestrator restart, scan `shadow_jobs WHERE status IN ('pending', 'running')` → re-dispatch.
- Shadow = **mandatory execution**, not mandatory pass. Shadow failure → flag for human review, not auto-revert.
- Runs in background:
  1. Full test suite in shadow container
  2. Optional 1-2 additional PHE workers exploring alternatives (scale to available docker capacity, not a fixed count)
  3. Results written to `ExecutionTrace.shadow_validation`
  4. If shadow fails: flag trace for human review via escalation channel
- **No auto-revert from shadow failure**: the online path already committed structurally-verified code. Shadow failure is a signal for human review, not automatic rollback (which would surprise users after "completed" status).
- Budget: `shadow_budget_ms` (default: 300,000ms = existing L2 worker timeout)
- PHE max workers: `shadow_phe_max_workers` (default: 2, max: 5)

**Risks:** 2-3x LLM cost multiplier for PHE. Test suite flakiness producing false shadow failures. User receives `validation_depth: 'structural'` (not full) — must be clearly communicated.

### 2.3 — Execution Trace Storage Schema `[S]` ✅

**What:** Formalize `ExecutionTrace` storage in SQLite with indexes for Sleep Cycle queries.

**Approach:** Add `execution_traces` table with explicit column contract aligned to `ExecutionTrace` interface. QualityScore dimensions denormalized as columns (not JSON blob) for efficient Sleep Cycle queries:

```sql
CREATE TABLE IF NOT EXISTS execution_traces (
  id                     TEXT PRIMARY KEY,
  task_id                TEXT NOT NULL,
  session_id             TEXT,
  worker_id              TEXT,
  timestamp              INTEGER NOT NULL,
  routing_level          INTEGER NOT NULL,
  task_type_signature    TEXT NOT NULL,     -- Sleep Cycle grouping key
  approach               TEXT NOT NULL,     -- pattern extraction target
  approach_description   TEXT,
  risk_score             REAL,
  quality_composite      REAL,             -- denormalized QualityScore.composite
  quality_arch           REAL,             -- architecturalCompliance
  quality_efficiency     REAL,             -- efficiency
  quality_simplification REAL,             -- simplificationGain (Phase 1+)
  model_used             TEXT NOT NULL,
  tokens_consumed        INTEGER NOT NULL,
  duration_ms            INTEGER NOT NULL,
  outcome                TEXT NOT NULL CHECK(outcome IN ('success','failure','timeout','escalated')),
  failure_reason         TEXT,
  oracle_verdicts        TEXT NOT NULL,    -- JSON Record<string, boolean>
  affected_files         TEXT NOT NULL,    -- JSON string[]
  prediction_error       TEXT,            -- JSON PredictionError (Phase 1+)
  validation_depth       TEXT,            -- structural | structural_and_tests | full_shadow
  shadow_validation      TEXT             -- JSON ShadowValidationResult
);

CREATE INDEX IF NOT EXISTS idx_et_task_type ON execution_traces(task_type_signature);
CREATE INDEX IF NOT EXISTS idx_et_outcome ON execution_traces(outcome);
CREATE INDEX IF NOT EXISTS idx_et_timestamp ON execution_traces(timestamp);
CREATE INDEX IF NOT EXISTS idx_et_quality ON execution_traces(quality_composite);
CREATE INDEX IF NOT EXISTS idx_et_approach ON execution_traces(task_type_signature, approach);
```

Query functions for pattern analysis (Sleep Cycle + Evolution Engine consumers).

### 2.4 — Sleep Cycle (Pattern Detection) `[L]` ✅

**What:** Periodic background analysis of traces → extract anti-patterns and success patterns. Frequency-based detection (Phase 2 scope).

**Prerequisite:** 1C.3 (QualityScore Phase 1 Dimensions) must produce continuous quality signals BEFORE Sleep Cycle can extract meaningful patterns. Binary pass/fail alone is insufficient — the cycle needs gradient data ("approach A is 30% better than B") to distinguish success patterns from noise.

**Approach per TDD §12B:**
1. Trigger every N sessions (default: 20)
2. Group traces by task type signature
3. Anti-pattern: approach X fails on task Y ≥80% → extract
4. Success pattern: approach A beats B by ≥25% composite → extract
5. Statistical significance: Wilson score lower bound (α = 0.05)
   - Anti-pattern: Wilson lower bound of failure rate ≥ 0.6 (not raw ≥80%)
   - Success pattern: Wilson lower bound of improvement ≥ 0.15 (not raw ≥25%)
   - Minimum support: ≥ 5 observations per pattern (cold-start suppression)
   - Minimum distinct sessions: ≥ 3 (prevents single-session anomaly)
   - Exponential decay applied to observation weights (configurable half-life)
6. Store as `ExtractedPattern` records

**Risks:** **Highest research risk in Phase 2.** Most patterns too rare to detect with < 200 tasks. Realistic expectation: 2-3 high-frequency anti-patterns.

### 2.5 — Skill Formation (Level 0 Cache) `[M]` ✅

**What:** Cache repeatedly successful approaches as L0 Reflex shortcuts. Probation → active → demoted lifecycle.

**Approach:**
- Sleep Cycle identifies success patterns → create `CachedSkill` in "probation"
- After 10 successful uses with effectiveness ≥ 0.7 → promote to "active"
- Effectiveness drops → "demoted"
- L0 execution: match task → check risk-tiered verification profile before applying:

  | Skill Risk | Hash | Dep Cone Freshness | Structural Oracle | Test Oracle |
  |------------|:----:|:------------------:|:-----------------:|:-----------:|
  | Low (< 0.2) | ✓ | — | — | — |
  | Medium (0.2–0.4) | ✓ | direct deps | ast | — |
  | High (> 0.4) | ✓ | transitive | ast + type | ✓ |

- "Dep Cone Freshness": check if any file in the skill's `depConeHashes` has changed since last verification. If changed → demote to L1, re-evaluate.
- Verification fail → `skill.status = 'demoted'`, fall through to normal routing
- CachedSkill stores `riskAtCreation`, `depConeHashes`, and `verificationProfile` for this check

- **Periodic re-verification**: During each Sleep Cycle (every N sessions), re-check dep cone freshness for ALL active skills. Skills with stale dep cones are demoted to L1 re-evaluation. This catches gradual drift without adding per-invocation cost to low-risk skills.

**Risks:** Over-caching (semantic mismatch). Mitigated: risk-tiered verification profiles ensure proportional checking. Dep cone freshness catches upstream API/behavior changes. Periodic re-verification during Sleep Cycle provides additional safety net for low-risk skills.

### 2.6 — Evolution Engine Basics `[XL]` ✅

**What:** Generate `EvolutionaryRule` records from patterns. Rules adjust oracle configs, risk thresholds, routing. All start in probation.

**Approach:**
- Rule types: `escalate`, `require-oracle`, `prefer-model`, `adjust-threshold`
- Backtest against historical traces before activation:
  - Temporal split policy: 80% oldest traces for pattern mining, 20% newest for validation
  - Anti-lookahead: validation window must be strictly newer than training window
  - Candidate rule must prevent ≥ 50% of historical failures in validation set WITHOUT blocking any historical successes
  - Probation activation criteria: rule must match ≥ 1 task during probation period to remain active. 0 matches after 10 sessions → `'retired'` (dead rule cleanup)
- Probation: 10 sessions logging-only
- **Bounded self-modification**: enforce immutable invariants (human escalation, security policies, budget limits, test requirements, rollback, routing hard floor)

**Rule Conflict Resolution (3-step deterministic):**
1. **Action type separation** — rules with different action types (`escalate`, `require-oracle`, `prefer-model`, `adjust-threshold`) never conflict. Only rules with the same action type on overlapping conditions can conflict.
2. **Specificity wins** — more specific condition wins (specificity = count of non-null condition fields). Ties broken by: higher `effectiveness` score wins. If still tied: the more conservative rule wins (higher escalation level, stricter oracle requirement).
3. **Safety floor** — if contradicting rules cannot be resolved by specificity or effectiveness, the more conservative action always wins. This aligns with the immutable invariant that safety cannot be relaxed by evolution (TDD §12B bounded self-modification).

Implementation: `resolveRuleConflicts(rules: EvolutionaryRule[]): EvolutionaryRule[]` — must be deterministic for the same input (A3 compliance).

**Risks:** **Highest overall risk.** Overfitting from limited data. Rule conflicts (mitigated by 3-step resolution above). Strict backtesting + probation mitigate.

---

## Pre-Phase 3: Hardening, Integration & Data Readiness

> **Goal:** Close the gap between "Phase 2 components exist" and "Phase 3 research can start safely."
> Phase 2.1–2.6 are implemented and unit-tested (635 tests, 0 failures). But they were built on an architecture-design branch — several integration seams, production-readiness gaps, and data prerequisites must be addressed before Phase 3's research-grade pattern mining and trace-calibrated Self-Model can operate on trustworthy data.
>
> **Guiding principle:** Phase 3 consumes *data*. If that data is noisy, sparse, or structurally incomplete, every Phase 3 component (cross-task pattern mining, counterfactual replay, EMA calibration) will produce garbage. Pre-Phase 3 exists to ensure the data pipeline is clean end-to-end.

### Dependency Graph

```
P3.0 (Audit) ──┬── P3.1 (Container Real) ── P3.2 (Shadow Real) ──┐
               │                                                    │
               ├── P3.3 (QualityScore Enrichment) ─────────────────┤
               │                                                    │
               ├── P3.4 (Complexity Context) ──────────────────────┤
               │                                                    ├── P3.8 (Burn-in)
               ├── P3.5 (Sleep→Skill→Rule E2E) ───────────────────┤
               │                                                    │
               ├── P3.6 (Observability) ───────────────────────────┤
               │                                                    │
               └── P3.7 (Self-Model Data Pipeline) ────────────────┘
```

**Parallel streams:**
- Stream A (Infrastructure): P3.0 → P3.1 → P3.2
- Stream B (Data quality): P3.0 → P3.3 → P3.4
- Stream C (Feedback loops): P3.0 → P3.5
- Stream D (Observability): P3.0 → P3.6 → P3.7
- Merge: P3.8 (requires all streams)

---

### P3.0 — Spec-vs-Implementation Audit `[M]` ✅

**What:** Systematic delta between TDD spec and current code. Fix discrepancies before building on top.

**Known deltas from code review (2026-03-30):**

| Area | Spec | Current Code | Status |
|:-----|:-----|:-------------|:-------|
| Core loop `complexityContext` | QualityScore should include `simplificationGain` (1C.3) | `buildComplexityContext()` wired into core-loop.ts | ✅ Fixed (WU-2/WU-3) |
| Shadow processNext | Shadow jobs enqueued but never processed in main loop | Fire-and-forget in core-loop.ts + setInterval in factory.ts | ✅ Fixed (WU-5) |
| Sleep Cycle trigger | Should run every N sessions (default: 20) | Session counter in factory.ts triggers run | ✅ Fixed (prior commit) |
| Evolution rule types | Spec: `escalate`, `require-oracle`, `prefer-model`, `adjust-threshold` | All 4 action types handled in core-loop.ts | ✅ Fixed (WU-1) |
| Skill dep cone hashes | `createFromPattern()` should receive real dep cone hashes | Real hashes computed from affected files in sleep-cycle.ts | ✅ Fixed (WU-4) |
| Backtester integration | Rules should be backtested before activation | Two-phase: insert as probation → backtest → activate in sleep-cycle.ts | ✅ Fixed (prior commit) |
| Factory stubs | CalibratedSelfModel and TaskDecomposerImpl available | Startup log confirms active components | ✅ Fixed (WU-MISC) |
| PredictionError capture | calibrate() return should populate trace | Return value captured and trace re-recorded | ✅ Fixed (WU-7) |

**Deliverable:** All deltas fixed + regression tests added. Track via checklist.

**Tests:** `tests/orchestrator/rule-action-types.test.ts` (6 tests), `tests/gate/complexity-context.test.ts` (5 tests), `tests/sleep-cycle/dep-cone-hashes.test.ts` (2 tests), `tests/observability/metrics.test.ts` (4 tests).

---

### P3.1 — Container Isolation End-to-End `[L]`

**What:** Connect L2 worker dispatch to real Docker containers. Current `WorkerPoolImpl` dispatches to subprocess — Docker path is specified in plan (2.1) but not wired.

**Key work:**
1. Create `docker/vinyan-sandbox/Dockerfile` — Bun + tree-sitter + tsc runtime
2. Implement `ContainerDispatcher` in `src/orchestrator/worker/container-dispatch.ts`:
   - `docker run --rm` with two-layer mount (workspace read-only + overlay writable)
   - Security hardening: `--user 1000:1000 --cap-drop=ALL --security-opt=no-new-privileges --network=none --pids-limit=256 --memory=1g`
   - IPC via temp dirs: `intent.json` → container → `result.json` + `artifacts/`
   - Timeout: `docker kill` on budget exceed
3. Implement `ArtifactCommitProtocol` in `src/orchestrator/worker/artifact-commit.ts`:
   - Path safety: reject absolute paths, `..` segments, symlinks
   - Reuse `validateWorkspacePath()` from `tool-validator.ts:42-46`
   - Hash-verify artifacts (A4) before applying to real workspace
4. Wire into `WorkerPoolImpl`: L0-L1 = subprocess, L2+ = container dispatch
5. Add `overlay_strategy` config: `tmpdir` (default, macOS) | `docker-tmpfs`

**Dependencies:** Docker Desktop / OrbStack installed on dev machine

**Tests:**
- Unit: artifact path validation (reject `../`, symlinks, absolute)
- Integration: build sandbox image → dispatch simple task → verify overlay isolation → verify artifact commit
- Timeout: container killed on budget exceed

**Risks:** Docker startup latency (2-5s). macOS volume permission issues. Mitigate: pre-pull image, test on both Docker Desktop and OrbStack.

---

### P3.2 — Shadow Execution Integration `[M]`

**What:** Wire shadow validation into the running system. Current `ShadowRunner.processNext()` works but is never called.

**Key work:**
1. Add background shadow processing loop in `factory.ts`:
   - After orchestrator creation, start `setInterval` (10s) calling `shadowRunner.processNext()`
   - Expose `startShadowLoop()` / `stopShadowLoop()` on Orchestrator interface
2. Wire shadow results back to traces:
   - On shadow completion: update `ExecutionTrace.shadow_validation` + `validation_depth`
   - On shadow failure: emit `shadow:failure` event → bus listener logs for human review
3. When container dispatch (P3.1) is ready: shadow runner uses container for test execution instead of bare `Bun.spawn`

**Dependencies:** P3.0 (audit fixes), P3.1 (optional — subprocess fallback works)

**Tests:**
- Enqueue → processNext → verify trace updated with shadow result
- Shadow timeout → verify failure recorded, not auto-reverted
- Crash recovery: kill mid-shadow → restart → verify job re-processed

---

### P3.3 — QualityScore Enrichment `[M]`

**What:** Activate `simplificationGain` and `testMutationScore` dimensions (1C.3). Phase 0 only computes 2 of 4 dimensions — Sleep Cycle needs gradient data ("approach A is 30% better than B"), not just binary pass/fail.

**Key work:**
1. `simplificationGain` — AST complexity diff:
   - Use tree-sitter to compute cyclomatic complexity before and after mutation
   - `simplificationGain = 1.0 - (complexityAfter / complexityBefore)` clamped to [0, 1]
   - Add `computeComplexityContext()` in `src/oracle/ast/complexity.ts`
2. `testMutationScore` — basic mutation testing:
   - Inject N faults into the mutated file (negate conditions, swap operators)
   - Run test suite per fault
   - `testMutationScore = faultsCaught / faultsInjected`
   - Add `src/oracle/test/mutation-tester.ts`
3. Wire into core loop: replace `undefined` complexityContext at core-loop.ts:268

**Dependencies:** P3.0 (audit), existing tree-sitter + test-oracle

**Tests:**
- Complexity: simple function → add nested loop → verify gain < 0
- Complexity: nested function → simplify → verify gain > 0
- Mutation: inject 5 faults → run tests → verify score reflects catch rate
- QualityScore composite: verify 4-dimension weighted output

**Risks:** Mutation testing is slow (runs test suite N times). Mitigate: limit to 3-5 faults, only on L2+ tasks, async when possible.

---

### P3.4 — Complexity Context in Core Loop `[S]`

**What:** Feed AST complexity data from P3.3 into QualityScore computation.

**Key work:**
1. After worker returns mutations (Step 4), compute `complexityContext` via tree-sitter:
   - Read original file → compute complexity
   - Read mutated content → compute complexity
   - Pass delta to `computeQualityScore()`
2. Store enriched QualityScore in ExecutionTrace

**Dependencies:** P3.3

**Tests:** End-to-end: task that simplifies a function → verify `simplificationGain > 0` in trace.

---

### P3.5 — Sleep→Skill→Rule End-to-End Pipeline `[L]`

**What:** Fix all broken wiring so the self-improvement feedback loop actually works.

**Key work:**
1. **Sleep Cycle trigger:** Add session counter to core loop. After every `sleep_cycle_interval` completed tasks, call `sleepCycleRunner.run()`:
   ```
   core-loop.ts: on task:complete → sessionCount++ → if sessionCount % interval === 0 → sleepCycleRunner.run()
   ```
   Or: add CLI command `vinyan sleep-cycle` for manual trigger during development.

2. **Real dep cone hashes:** When Sleep Cycle creates skill from pattern:
   - Extract `affected_files` from source traces
   - Compute current hashes via `skillManager.computeCurrentHashes(files)`
   - Pass real hashes to `createFromPattern()`

3. **Backtest before insert:** In Sleep Cycle, after `generateRule()` (sleep-cycle.ts:138-140):
   - Fetch relevant traces from `traceStore`
   - Call `backtestRule(rule, traces)`
   - Only `ruleStore.insert()` if backtest passes

4. **All rule action types in core loop** (core-loop.ts:139-155 currently only handles `escalate`):
   - `require-oracle`: add specific oracle to verification requirements
   - `prefer-model`: override routing model selection
   - `adjust-threshold`: modify risk thresholds for this task

> **Note (2026-03-31 audit):** Items previously listed here — skill outcome tracking (`recordOutcome()`) and `activeSkills` hardcode fix — have been verified as already implemented in the current codebase (`core-loop.ts:354,370` and `sleep-cycle.ts:374` respectively).

**Dependencies:** P3.0 (audit), P3.3 (quality enrichment for meaningful patterns)

**Tests:**
- Full pipeline integration test with synthetic traces:
  1. Insert 150 traces (100+ required for gate) with deliberate anti-pattern
  2. Run sleep cycle → verify anti-pattern extracted
  3. Verify skill created with real dep cone hashes
  4. Verify rule generated + backtested
  5. Run new task matching pattern → verify rule applied
  6. Run task matching skill → verify skill shortcut + outcome recorded
  7. After enough successes → verify skill promoted to active

---

### P3.6 — Observability Layer `[M]`

**What:** TDD audit scored Observability 62/100 — lowest dimension. Phase 3 research needs metrics to evaluate Evolution Engine effectiveness.

**Key work:**
1. **Metrics dashboard data:** Add `src/observability/metrics.ts`:
   - `getSystemMetrics()`: trace count, success rate, avg quality score, routing distribution, active skills, active rules, sleep cycles run
   - `getPhaseStatus()`: which data gates are open, which features are active
   - `getHealthCheck()`: DB size, circuit breaker states, shadow queue depth

2. **Structured logging:** Enhance bus listeners to emit structured JSON for:
   - Every routing decision (level, reason, risk score)
   - Every rule application (which rule, what it changed)
   - Every skill match/miss (signature, verification result)
   - Shadow validation results

3. **CLI observability commands:**
   - `vinyan status` — system health + data gate status
   - `vinyan metrics` — trace summary + quality trends
   - `vinyan rules` — active/probation/retired rule inventory
   - `vinyan skills` — active/probation/demoted skill inventory

**Dependencies:** P3.0

**Tests:** Metrics accuracy tests: insert known traces → verify computed metrics match.

---

### P3.7 — Self-Model Data Pipeline `[M]`

**What:** Ensure CalibratedSelfModel receives clean, continuous calibration data. Phase 3 replaces static heuristics with EMA-learned weights — garbage in = garbage out.

**Key work:**
1. **Verify calibration flow:** After every task completion, core loop already calls `selfModel.calibrate(prediction, trace)` — verify this path produces real `PredictionError` records in `self_model_observations` table.

2. **Prediction coverage audit:** Ensure predictions cover all 4 dimensions:
   - `expectedTestResults`: requires test-oracle results in trace
   - `expectedBlastRadius`: requires dep-oracle results
   - `expectedDuration`: requires wall-clock timing
   - `expectedQualityScore`: requires enriched QualityScore (P3.3)

3. **Meta-confidence progression:** Verify `metaConfidence` increases with observation count:
   - < 10 observations → forced < 0.3
   - 10-50 → proportional increase
   - > 50 → approaches 1.0 based on prediction accuracy

4. **S1/S3 safeguard verification:**
   - S1: first 50 tasks → conservative override (higher routing level)
   - S3: 10% audit sampling for first 100 tasks → verify audit traces recorded

**Dependencies:** P3.3 (enriched QualityScore), P3.5 (traces flowing through full pipeline)

**Tests:**
- Cold start: 0 observations → verify metaConfidence < 0.3 + S1 active
- Warm-up: 50 observations → verify metaConfidence increase + S1 deactivated
- Calibration accuracy: inject traces with known outcomes → verify prediction error decreases

---

### P3.8 — Burn-in Validation `[XL]`

**What:** Run Vinyan against real tasks to accumulate traces and validate the full pipeline before Phase 3 research begins.

**Acceptance criteria (data gates for Phase 3):**
- `trace_count ≥ 200` with real LLM-generated mutations (not synthetic)
- `distinct_task_types ≥ 10`
- `sleep_cycles_run ≥ 3` with at least 1 pattern extracted per cycle
- `active_skills ≥ 1` (promoted through full lifecycle)
- `active_rules ≥ 1` (backtested + survived probation)
- Self-Model `metaConfidence > 0.3` for at least 3 task type signatures
- QualityScore 4-dimension coverage on ≥ 80% of traces
- Shadow validation executed on ≥ 50% of L2+ tasks
- Zero safety invariant violations across all runs

**Approach:**
1. Select a real TypeScript project as test target (suggest: this repo itself)
2. Craft 20 task types covering: refactor, bug fix, new feature, test writing, type fix, etc.
3. Run each task type 10+ times to accumulate traces
4. After every 20 tasks, verify sleep cycle fires + produces patterns
5. Monitor all metrics via P3.6 observability
6. Fix any issues discovered → re-run affected task types

**Burn-in phases:**
| Phase | Tasks | Focus | Exit Criteria |
|:------|:------|:------|:--------------|
| Burn-in α | 50 | Core loop + oracle gate + basic traces | ≥50 traces, S1 safeguard active, no crashes |
| Burn-in β | 100 | Sleep cycle + skill formation | ≥1 sleep cycle run, ≥1 pattern extracted |
| Burn-in γ | 50+ | Evolution rules + full pipeline | ≥1 active rule, ≥1 active skill, all gates open |

**Dependencies:** ALL of P3.0–P3.7

**Risks:** LLM cost for 200+ real tasks. Mitigate: use `claude-haiku` for L0-L1, `claude-sonnet` for L2, reserve `claude-opus` for L3 only. Estimate: ~$50-100 for full burn-in.

---

### Pre-Phase 3 Critical Path

```
P3.0 (Audit, 1d)
    ├── P3.1 (Container, 3d) ── P3.2 (Shadow, 2d) ──┐
    ├── P3.3 (Quality, 3d) ── P3.4 (Complexity, 1d) ──┤
    ├── P3.5 (Pipeline E2E, 3d) ───────────────────────┤── P3.8 (Burn-in, 5-7d)
    ├── P3.6 (Observability, 2d) ──────────────────────┤
    └── P3.7 (Self-Model Pipeline, 2d) ────────────────┘
```

**Estimated total:** ~3 weeks (P3.0-P3.7 parallel: ~1.5 weeks, P3.8 burn-in: ~1-1.5 weeks)

**Single biggest blocker:** P3.5 (Pipeline E2E) — touches the most files and has the highest integration risk. P3.8 (Burn-in) is the longest wall-clock but is mostly execution time.

---

## Phase 3: Full Evolution Engine + Self-Model

> **Goal:** Prove that Vinyan can improve itself from its own execution data — trace-calibrated predictions, pattern-mined rules, and measured quality improvement.
> **Type:** Research + Engineering. Negative results are valid — they narrow the design space for Phase 4.
> **Prerequisite:** Pre-Phase 3 complete (P3.0–P3.8). All data gates satisfied: ≥200 real traces, ≥10 task types, ≥3 sleep cycles, ≥1 active skill, ≥1 active rule, Self-Model metaConfidence >0.3 for ≥3 signatures.

### Dependency Graph

```
PH3.1 (Self-Model Foundation) ─────────────────────────────────────────────────
  │                                                                             │
  ├── PH3.2 (Adaptive EMA) ──── PH3.5 (Pattern Mining v2) ── PH3.6 (Counterfactual Lite)
  │                            │                                                │
  │                            └── PH3.7 (Eval Framework) ─────────────────────┘
  │                                                                             │
  ├── PH3.3 (Evolution Enhancement) ──────────────────────────────────────────┘
  │                                                                             │
  └── PH3.4 (Skill Generalization) ── independent, only needs PH3.1 ─────────┘
                                                                                │
                                                                         PH3.8 (Validation)
```

**Parallel streams:**
- Stream A (critical path): PH3.1 → PH3.2 → PH3.5 → PH3.6 → PH3.8
- Stream B: PH3.1 → PH3.3 (runs in parallel with Stream A)
- Stream C: PH3.1 → PH3.4 (runs in parallel with Stream A)
- Stream D: PH3.2 + PH3.3 → PH3.7
- Merge: PH3.8 (requires all streams)

---

#### PH3.1 — Self-Model Foundation `[L]` — Engineering ✅

**What:** Fix 4 structural defects that prevent the Self-Model from calibrating. Without this, every downstream Phase 3 component consumes garbage data.

**Key issues in current code:**

| Issue | Location | Problem |
|:------|:---------|:--------|
| PredictionError discarded | `core-loop.ts:317-319` | `calibrate()` return value not stored → `trace.predictionError` always null |
| No failure prediction | `self-model.ts:166-169` | Returns only `"pass"` or `"partial"`, never `"fail"` → systematic prediction bias |
| Coarse task signature | `self-model.ts:171-176` | Directory-only grouping → unrelated tasks pooled together |
| Premature basis transition | `self-model.ts:108` | Transitions at 10 obs regardless of accuracy → false "trace-calibrated" claim |

**Implementation:**

1. **PredictionError persistence:** Capture `calibrate()` return → assign to `trace.predictionError`. This is a 3-line fix but unlocks the entire calibration data pipeline.

2. **Failure prediction:** Track pass/fail/partial distribution per task type signature. If >50% of observed outcomes are `"fail"`, predict `"fail"`. If >30% `"partial"`, predict `"partial"`. Else predict `"pass"`.

3. **Improved task signature:** Replace directory-stripping with composite key:
   ```
   {action_verb}::{file_extensions}::{blast_radius_bucket}
   ```
   Example: `"refactor::ts::medium"`. Provides meaningful grouping without making each task unique.

4. **Basis field honesty:**
   - `"static-heuristic"`: observationCount < 10 OR predictionAccuracy < 0.4
   - `"hybrid"`: 10 ≤ observationCount < 50 AND predictionAccuracy ≥ 0.4
   - `"trace-calibrated"`: observationCount ≥ 50 AND predictionAccuracy ≥ 0.6

**Files:** `src/orchestrator/self-model.ts`, `src/orchestrator/core-loop.ts:~317`

**Tests:**
- After 50 tasks: `predictionError` non-null on >95% of L2+ traces
- Self-Model predicts `"fail"` ≥10% of the time on task types with >30% actual failure rate
- `basis` transitions correctly through `static-heuristic` → `hybrid` → `trace-calibrated`
- Task signatures group similar tasks (no more than 3x variation in group size vs directory-based)

---

#### PH3.2 — Adaptive EMA + Parameter Storage `[L]` — Engineering + Research

**What:** Replace the global fixed EMA (alpha=0.1) with per-task-type parameter sets and an adaptive learning rate. This is the core "trace-calibrated Self-Model" deliverable.

**Research question resolved:** EMA with adaptive alpha is sufficient at this data scale. Gradient descent requires loss function design and is overkill for 200–1000 observations — deferred.

**Implementation:**

1. **Per-task-type parameter storage.** New SQLite table replacing the single JSON blob:

   ```sql
   CREATE TABLE IF NOT EXISTS self_model_params (
     task_type_signature   TEXT PRIMARY KEY,
     observation_count     INTEGER NOT NULL DEFAULT 0,
     avg_quality_score     REAL NOT NULL DEFAULT 0.5,
     avg_duration_per_file REAL NOT NULL DEFAULT 2000,
     prediction_accuracy   REAL NOT NULL DEFAULT 0.5,
     fail_rate             REAL NOT NULL DEFAULT 0.0,
     partial_rate          REAL NOT NULL DEFAULT 0.1,
     last_updated          INTEGER NOT NULL,
     basis                 TEXT NOT NULL DEFAULT 'static-heuristic'
   );
   ```

2. **Adaptive alpha.** Learning rate varies by observation count:
   ```
   alpha = max(0.05, min(0.3, 1 / (1 + observationCount * 0.1)))
   ```
   - Early observations (count < 10): α ≈ 0.3 (fast adaptation)
   - After 30+ observations: α ≈ 0.05 (slow drift tracking)
   - Solves the fixed α=0.1 problem (~23 obs to react to a shift)

3. **Global fallback.** For unseen task types, use project-wide average as prior (weighted by total observation count). New types start with the project average, not hardcoded 0.5.

4. **Parameter migration.** On startup, if old `model_parameters` table exists with single-blob data, decompose into per-task-type rows using existing `taskTypeObservations` counts.

**Files:** `src/orchestrator/self-model.ts` (major rewrite), `src/db/trace-schema.ts`, `src/db/vinyan-db.ts`

**Tests:**
- Per-task-type prediction accuracy >60% for task types with 20+ observations
- Global prediction accuracy >65% by 100 tasks, >75% by 200 tasks
- New task types converge within 5 observations (not 23)
- `basis` transitions to `"trace-calibrated"` for ≥3 task types by 200 tasks
- Parameters survive process restart (persisted to SQLite)

**Risks:** If adaptive alpha causes oscillation, cap at 0.15 and increase observation threshold. Fallback: revert to fixed alpha=0.1 with per-task-type storage only.

---

#### PH3.3 — Evolution Pipeline Enhancement `[L]` — Engineering

**What:** Enhance the Evolution Engine beyond the baseline fixes done in Pre-Phase 3. Pre-Phase 3 P3.5 handles backtester wiring and action type expansion. This phase adds rule lifecycle management, proportional escalation, statistical rigor, and richer rule conditions.

> **Note (2026-03-31 audit):** 3 items originally listed here were moved to Pre-Phase 3 P3.5 (backtest wiring, 4 action types) or confirmed already done in code (`activeSkills` query). See audit notes in P3.5.

**4 enhancements:**

1. **Rule promotion loop.** New `promoteRules()` called during each Sleep Cycle:
   - Query all `status = "probation"` rules older than `PROBATION_SESSIONS * interval` time
   - Re-run backtest against latest traces
   - Pass → `ruleStore.activate(rule.id)` + update effectiveness
   - Fail → `ruleStore.retire(rule.id)`
   - Emit `evolution:rule_promoted` or `evolution:rule_retired` bus events

2. **Fix toLevel proportionality.** `rule-generator.ts:62` hardcodes `toLevel: 2`. Change to `min(3, failedAtLevel + 1)`. Requires adding `routingLevel` to `ExtractedPattern`.

3. **Fix success-pattern Wilson LB.** `sleep-cycle.ts:283-285` is broken — `wins` always equals `totalPairs` because winner is structurally always the higher-quality approach. Replace with real pairwise comparison: for each pair of traces (one from winner, one from loser), count how many times winner's quality exceeds loser's. Apply Wilson LB to `(actualWins, totalPairs)`.

4. **Multi-condition rule generation.** Extend `generateEscalationRule()` and `generatePreferenceRule()` to populate `oracle_name`, `risk_above`, `model_pattern` conditions when pattern data provides them. Currently only `file_pattern` is ever set.

**Files:** `src/sleep-cycle/sleep-cycle.ts`, `src/evolution/rule-generator.ts`, `src/orchestrator/types.ts`, `src/db/rule-store.ts`

**Tests:**
- ≥1 rule transitions `probation → active` within 60 sessions
- Success-pattern Wilson LB correctly rejects patterns where quality difference is not statistically significant (synthetic data test with overlapping distributions)
- Multi-condition rules are generated when pattern data includes oracle/risk/model info

---

#### PH3.4 — Cross-Task Skill Generalization `[S]` — Research-lite

**What:** Extend Skill Formation with fuzzy matching across task types. The basic feedback loop (outcome tracking + approach injection) is already implemented — `recordOutcome()` at `core-loop.ts:354,370` and `workingMemory.addHypothesis()` at `core-loop.ts:207-213`.

> **Note (2026-03-31 audit):** Items 1 and 2 originally listed here (wire `recordOutcome`, inject skill approach) were verified as already implemented in the current codebase.

**Implementation:**

1. **Cross-task fuzzy matching.** When no exact skill match exists, attempt fuzzy matching: same action verb + overlapping file extensions. If a fuzzy match has `successRate > 0.8`, inject it as a lower-confidence hypothesis (`confidence: 0.4`). This is the minimal viable version of GAP-C "cross-task generalization."

**Files:** `src/orchestrator/skill-manager.ts`

**Tests:**
- Fuzzy skill match triggers at least once in integration test (e.g., `"refactor::ts::small"` matches skill from `"refactor::ts::medium"`)
- Fuzzy match injected as lower confidence (0.4) vs exact match (skill.successRate)
- No false fuzzy matches across unrelated task types (e.g., `"bugfix::py"` does not match `"refactor::ts"`)

---

#### PH3.5 — Pattern Mining v2 `[XL]` — Research + Engineering

**What:** Move beyond single-task-type frequency analysis to cross-task-type pattern correlation. This is the primary research component of Phase 3.

**Research questions addressed:**
- Can we find patterns that span task types? (e.g., "all refactoring tasks on files with >5 dependencies fail at L1")
- Does power-law decay outperform exponential?

**Implementation:**

1. **Time-windowed trace analysis.** Replace `queryRecentTraces(10000)` with time-bounded query: only analyze traces from the last 5 sleep cycle windows. Uses existing `TraceStore.queryByTimeRange()`.

2. **Cross-task-type correlation.** New `src/sleep-cycle/cross-task-analyzer.ts`:
   - Group traces by shared attributes (model, routing level, blast radius bucket, oracle verdict pattern) instead of just task type signature
   - Identify attribute combinations correlated with failure: e.g., `{model: "gpt-4o-mini", blast_radius: ">5", oracle: "type"} → 70% failure`
   - Generate rules with multi-condition matching from these correlations
   - Minimum viable: identify at least 1 cross-task pattern in the burn-in dataset

3. **Pattern decay experiment.** Implement both decay models, run side-by-side:
   - Exponential (existing): `weight = 0.5 ^ (ageCycles / halfLife)`
   - Power-law (new): `weight = 1 / (1 + ageCycles / halfLife)`
   - After 5 cycles, compare: which model's surviving patterns have better backtest scores?
   - Auto-select winner. New `src/sleep-cycle/decay-experiment.ts`.

4. **Pattern provenance chain.** Add `derivedFrom?: string` to `ExtractedPattern`. When a pattern refines an earlier one, track lineage. Enables pattern evolution analysis.

**New files:** `src/sleep-cycle/cross-task-analyzer.ts`, `src/sleep-cycle/decay-experiment.ts`

**Files modified:** `src/sleep-cycle/sleep-cycle.ts`, `src/orchestrator/types.ts`, `src/db/pattern-store.ts`

**Tests:**
- Time-windowed analysis produces different (more recent) patterns than unbounded analysis
- ≥1 cross-task-type pattern identified that single-task analysis would miss
- Cross-task rules pass backtesting at comparable rate to single-task rules (within 20%)
- Decay experiment produces a measurable winner after 5 sleep cycles

**Risks:** **Highest research risk.** If cross-task correlation finds nothing with 200 traces, the output is still valuable: "200 traces insufficient for cross-task mining, minimum N estimated." Fall back to improved single-task mining with multi-condition rules from PH3.3.

---

#### PH3.6 — Counterfactual Lite `[L]` — Research

**What:** Answer "what would have happened if we used approach B?" without building full replay infrastructure. Scoped down from the original spec's "historical codebase snapshots" requirement.

**Key insight:** We do not need codebase snapshots if we reframe the question. Instead of replaying tasks against historical code, use **retrospective routing analysis**: "given what we know now, would a different routing decision have produced better results?"

**Implementation:**

1. **Retrospective routing analyzer.** New `src/evolution/counterfactual.ts`:
   - For each completed trace, compute: "if this task had been routed to level N instead of level M, what is the expected quality score?" using Self-Model's per-task-type parameters
   - Compare actual quality score with counterfactual expected score
   - If counterfactual routing consistently outperforms actual routing for a task type, generate an `adjust-threshold` rule

2. **Epsilon-greedy exploration.** During the core loop's routing decision, with probability ε (default: 0.05), route to a random level instead of the calculated one.
   - **Safety constraint:** exploration only routes UP (sideways or higher), never down. If random level < calculated level, skip exploration for this task.
   - Track exploration traces with `trace.exploration = true`
   - Provides natural variation data for counterfactual analysis without requiring replay

3. **What-if analysis for rules.** Before applying a rule, compute: "if this rule had been active during the last 50 traces, what would the aggregate quality score have been?" Extends backtester from binary pass/fail to expected quality impact.

**New files:** `src/evolution/counterfactual.ts`

**Files modified:** `src/orchestrator/core-loop.ts`, `src/orchestrator/types.ts`, `src/evolution/backtester.ts`

**Tests:**
- Retrospective analyzer identifies ≥1 task type where different routing would improve quality by >10%
- Epsilon exploration produces ≥10 exploration traces per 200 tasks (5% rate)
- No safety invariant violated during exploration (exploration never lowers routing level)
- What-if quality predictions correlate (r > 0.3) with actual outcomes when rules are applied

**Risks:** If retrospective analysis is inconclusive (possible with homogeneous routing), the A/B exploration data remains useful for future analysis. If epsilon exploration is too disruptive, reduce to 0.02 or disable. Fallback: counterfactual analysis becomes a monitoring report rather than a rule generator.

---

#### PH3.7 — Evaluation Framework `[M]` — Engineering

**What:** Answer the meta-question: "Is the Evolution Engine actually making Vinyan better?" Without this, Phase 3 has no way to measure its own success.

**Implementation:**

1. **Metrics data layer.** New `src/observability/metrics.ts`:

   ```typescript
   interface EvolutionMetrics {
     // Self-Model
     predictionAccuracyGlobal: number;
     predictionAccuracyByTaskType: Record<string, number>;
     basisDistribution: Record<string, number>;
     calibrationVelocity: number;  // sessions to reach 75% accuracy

     // Evolution Engine
     rulesGenerated: number;
     rulesPromoted: number;
     rulesRetired: number;
     ruleEffectivenessAvg: number;
     backtestPassRate: number;

     // Skill Formation
     skillsCreated: number;
     skillsPromoted: number;
     skillsDemoted: number;
     skillHitRate: number;  // tasks matching a skill / total tasks

     // Overall
     qualityScoreTrend: number[];  // rolling average over last N sessions
     routingEfficiency: number;    // tasks completed at initial routing level
     escalationRate: number;       // tasks that escalate / total tasks
   }
   ```

2. **Rule effectiveness scoring.** After a rule is activated, track its impact:
   - For each trace where the rule applied: compare quality with pre-rule average for that task type
   - `effectiveness = (avg_quality_with_rule - avg_quality_before) / avg_quality_before`
   - Update `rule.effectiveness` after each Sleep Cycle
   - Rules with effectiveness < 0 for 3 consecutive cycles → auto-retire

3. **Self-Model accuracy dashboard.** Computed during each Sleep Cycle:
   - Per-task-type: `(predicted quality - actual quality)` over last N traces
   - Overall: fraction of traces where composite error < 0.3
   - Trend: compare last 50 traces vs previous 50 — is accuracy improving?

4. **Phase 4 readiness signal.** Composite gate:
   - metaConfidence > 0.5 for ≥ 5 task types
   - ≥ 3 active rules with effectiveness > 0.3
   - ≥ 2 active skills with successRate > 0.7
   - Self-Model global accuracy > 70%

**New files:** `src/observability/metrics.ts`, `src/observability/phase3-report.ts`

**Files modified:** `src/sleep-cycle/sleep-cycle.ts`, `src/db/rule-store.ts`

**Tests:** Metrics computed after every Sleep Cycle; quality trend trackable as time series; rule effectiveness reflects actual impact (positive for helpful rules, negative for harmful ones).

---

#### PH3.8 — Integration Validation `[L]` — Engineering

**What:** Demonstrate that all Phase 3 components work together and produce measurable improvement over Phase 2 baseline.

**Approach:**

1. **End-to-end demonstration.** Run 200+ additional tasks (on top of Pre-Phase 3 burn-in) with all Phase 3 components active. Track PH3.7 metrics throughout.

2. **Before/after comparison:**
   - Quality score composite: first 100 tasks (Phase 2 baseline) vs last 100 tasks (Phase 3 active)
   - Escalation rate: should decrease as Self-Model improves routing
   - Task completion rate: should increase as skills provide shortcuts
   - Rule count and effectiveness: should show growing, effective rule set

3. **Graceful degradation test.** Disable Phase 3 components one at a time:
   - Without PH3.2 (adaptive EMA): falls back to fixed EMA, accuracy degrades but system functions
   - Without PH3.3 (evolution pipeline): no rules promoted, Sleep Cycle still extracts patterns
   - Without PH3.5 (pattern mining v2): falls back to single-task-type analysis
   - Without PH3.6 (counterfactual): no exploration, system operates normally

4. **Phase 4 readiness gate.** Using PH3.7 metrics, assess fleet governance entry criteria.

**Phase 3 acceptance criteria (overall):**

| Criterion | Target |
|:----------|:-------|
| Self-Model accuracy | >75% for ≥3 task types |
| `basis` transitions | `"trace-calibrated"` for ≥3 task types |
| Rule promotion | ≥3 rules `probation → active` |
| Rule effectiveness | ≥1 rule with measured positive effectiveness (>0.1) |
| Skill usage | ≥1 active skill used in task execution |
| Quality trend | Upward slope over 200 sessions |
| Safety invariant violations | Zero |
| Graceful degradation | Disabling any single component doesn't crash the system |

---

### Safety & Failure Mode Guards

**F4 — Self-Model Miscalibration Cascade** (bad predictions → wrong routing → poor outcomes → reinforces bad model):

| Layer | Defense |
|:------|:--------|
| Detection | Prediction accuracy drops < 0.4 for 3 consecutive Sleep Cycles → emit `selfmodel:degradation` event |
| Containment | Freeze `calibrate()` calls. Predictions continue using last-known-good parameters. |
| Recovery | Re-initialize affected task types from last 50 traces, reset observation count to re-engage S1 safeguard. |
| Prevention | S4 monotonic trust ramp. Adaptive alpha bounded [0.05, 0.3]. `basis` honesty from PH3.1. |

**F5 — Risk Scoring Miscalibration:** `adjust-threshold` rules (PH3.3) + retrospective analysis (PH3.6) auto-correct. I6 safety invariant prevents worst case (high-risk tasks cannot be routed below L1).

**Max active rules cap:** 20. New rule displaces lowest-effectiveness rule if at cap.

### Research Questions Resolved

| # | Question (from TDD §12) | Phase 3 Answer |
|:--|:------------------------|:---------------|
| 1 | Calibration algorithm: gradient descent vs EMA? | **EMA with adaptive alpha (PH3.2).** Gradient deferred — insufficient data scale. |
| 2 | Dedicated storage schema for Self-Model? | **`self_model_params` table** with per-task-type rows (PH3.2). |
| 4 | Pattern decay model: exponential vs power-law? | **Experimentally determined (PH3.5).** Run both, auto-select winner after 5 cycles. |
| 5 | Counterfactual generation interfaces? | **Scoped to retrospective routing + epsilon exploration (PH3.6).** Full replay deferred indefinitely. |
| 6 | Evaluation methodology for mined rules? | **Effectiveness tracking + auto-retirement (PH3.7).** |
| 7 | How fast does Self-Model calibrate? | **Measured in PH3.8.** Target: >75% by 200 sessions. Calibration velocity metric tracks sessions-to-threshold. |
| 3 | Cross-project transfer learning? | **Deferred to Phase 4.** Phase 3 focuses on single-project calibration. |

### Phase 3 Critical Path

```
PH3.1 (Self-Model Foundation, ~3d)
  │
  ├── PH3.2 (Adaptive EMA, ~4d) ── PH3.5 (Pattern Mining, ~5d) ── PH3.6 (Counterfactual, ~4d) ─┐
  │                                │                                                                │
  │                                └── PH3.7 (Eval Framework, ~3d) ────────────────────────────────┤
  │                                                                                                 │
  ├── PH3.3 (Evolution Enhancement, ~3d) ──────────────────────────────────────────────────────────┤
  │                                                                                                 │
  └── PH3.4 (Skill Generalization, ~1d) ──────────────────────────────────────────────────────────┘
                                                                                                    │
                                                                                             PH3.8 (Validation, ~5-7d)
```

**Critical path:** PH3.1 → PH3.2 → PH3.5 → PH3.6 → PH3.8 (Stream A, ~3+4+5+4+6 = ~22d)
Stream B (PH3.3, ~3d) and Stream C (PH3.4, ~1d) run in parallel — not on critical path.

**Estimated total:** ~3.5-4 weeks (engineering phase ~2.5 weeks with parallelism, validation ~1-1.5 weeks)

### Phase 3 Risk Assessment

| Component | Risk Type | Level | Mitigation | Fallback |
|:----------|:----------|:-----:|:-----------|:---------|
| Adaptive EMA (PH3.2) | Engineering | Low | Bounded alpha [0.05, 0.3]. Monitor for oscillation. | Revert to fixed alpha=0.1 with per-task-type storage. |
| Evolution enhancement (PH3.3) | Engineering | Low | Each of 4 enhancements is independently testable. | Ship incrementally. |
| Cross-task mining (PH3.5) | Research | **High** | 200+ trace minimum. Design experiments that produce results even with limited data. | Report "N insufficient, estimate minimum." Fall back to single-task mining. |
| Counterfactual lite (PH3.6) | Research | Medium | Epsilon exploration never routes DOWN. Conservative ε=0.05. | Disable exploration. Counterfactual becomes monitoring report. |
| Miscalibration cascade (F4) | System | **High** | Layered defense: detection → containment → recovery → prevention. S1-S4 safeguards remain active. | Freeze Self-Model, revert to Phase 2 static heuristics. |
| Rule positive feedback loop | System | Medium | Rules re-backtested before promotion. Effectiveness tracking auto-retires bad rules. Cap at 20 active. | Manual review gate for first 10 promotions. |

---

### Phase 4: Fleet Governance — Empirical Worker Identity — ✅ Implemented

> **Status:** ✅ Fully implemented. 1047 tests pass, `tsc --noEmit` clean. All sub-phases (PH4.0-PH4.6) complete. 7 post-implementation review gaps identified and fixed.
> **Prerequisite:** Phase 3 complete + PH3.7 readiness gate passed + Phase 4 readiness gate (already implemented in `src/observability/phase3-report.ts:209-242`).
> **Type:** Engineering-heavy (PH4.0-PH4.5), with one scoped research component (PH4.6).
> **Estimated duration:** ~5-6 weeks (4 weeks engineering with parallelism + 1-2 weeks integration/validation).

#### Overall Status: 100% Complete (1047 tests, 0 type errors)

| Sub-Phase | Status | Key Files | Tests |
|:----------|:------:|:----------|:------|
| PH4.0 Multi-Model Data Seeding | ✅ Done | `types.ts`, `factory.ts`, `core-loop.ts`, `bus.ts`, `data-gate.ts`, `trace-schema.ts` | Existing core-loop + factory tests |
| PH4.1 Worker Profile Registry | ✅ Done | `worker-schema.ts`, `worker-store.ts`, `vinyan-db.ts`, `metrics.ts` | `worker-store.test.ts` |
| PH4.2 Worker Lifecycle | ✅ Done | `worker-lifecycle.ts`, `shadow-runner.ts`, `safety-invariants.ts` | `worker-lifecycle.test.ts` |
| PH4.3 Task Fingerprinting | ✅ Done | `task-fingerprint.ts`, `capability-model.ts`, `perception.ts` | `task-fingerprint.test.ts`, `capability-model.test.ts` |
| PH4.4 Capability-Based Router | ✅ Done | `worker-selector.ts`, `core-loop.ts`, `worker-pool.ts`, `provider-registry.ts` | `worker-selector.test.ts`, `core-loop-fleet.test.ts` |
| PH4.5 Fleet Evaluation | ✅ Done | `fleet-evaluator.ts`, `sleep-cycle.ts`, `rule-generator.ts`, `backtester.ts`, `phase3-report.ts` | `fleet-evaluator.test.ts`, `assign-worker-rule.test.ts` |
| PH4.6 Cross-Project Transfer | ✅ Done | `pattern-abstraction.ts`, `cli/patterns.ts`, `cli/index.ts` | `abstract-pattern.test.ts` |

---

#### Architectural Premise: From Task Learning to Worker Learning

Phase 3 proved that Vinyan can learn about *tasks* from its own execution data: trace-calibrated predictions, pattern-mined rules, and effectiveness-scored skills. But Phase 3 treats the worker fleet as a fixed, static mapping: `RoutingLevel → tier ("fast"|"balanced"|"powerful") → single provider` (see `LLMProviderRegistry.selectForRoutingLevel()` at `src/orchestrator/llm/provider-registry.ts`).

Phase 4 is a **metacognitive leap**. The system must model not just the external world (tasks, code) but its *internal capabilities* (which worker is good at what). This is the transition from a Self-Model that says "I will probably succeed at this task" to one that says "Worker X will probably succeed at this task better than Worker Y, given this task fingerprint, at this cost."

The key insight: **worker identity is not declared, it is earned from empirical evidence**. A `WorkerProfile` is a hypothesis: "this configuration produces good results for tasks matching these fingerprints." That hypothesis is subject to the same epistemic machinery (Wilson CI, backtesting, probation) that Phase 2-3 uses for patterns and rules.

**Terminology note:** In this section, "Worker" means a **Generator-class Reasoning Engine** (concept doc §3). The fleet governance model applies to LLM Generator engines specifically — Oracle/Verifier engine lifecycle governance is deferred to Phase 5. `TaskFingerprint` extends the concept doc's "task type" / "task pattern" vocabulary with additional queryable dimensions for worker matching.

What changes architecturally:
- `LLMProviderRegistry.selectForRoutingLevel()` in `worker-pool.ts` → multi-factor capability match via `WorkerSelector`
- `RoutingDecision.model` → `RoutingDecision.workerId` pointing to a tracked configuration
- `ExecutionTrace.model_used` → primary input to worker evaluation (already collected but unused)
- `ExecutionTrace.worker_id` → populated on every trace (field exists but never set)
- `WorkerPool.dispatch()` interface changes from `(input, level)` to `(input, routing)` to carry `workerId` — **breaking interface change** to `WorkerPool` contract

#### Axiom Compliance

| Axiom | Phase 4 Relevance |
|:------|:-----------------|
| A1 (Epistemic Separation) | Workers generate; Oracle Gate verifies. Worker selection does not bypass verification. Probation workers cannot commit artifacts. The LLM-as-Critic used for `QualityScore` (feeding `WorkerStats`) MUST be a different model instance from the worker being evaluated — A1 boundary preserved. |
| A2 (First-Class Uncertainty) | New worker configurations start with `basis: "unknown"`. The system explicitly says "I don't know if this worker is good at this task type" until sufficient traces exist. When no worker has capability > 0.3 for a fingerprint, the Orchestrator returns an ECP response with `type: 'unknown'` (not just a bus event) and triggers uncertainty reduction: escalation to human delegation per concept §2.2. The `task:uncertain` bus event is emitted alongside for observability. |
| A3 (Deterministic Governance) | Worker selection is a deterministic scoring function over empirical data. No LLM in the routing or selection path. Auditable selection trace (`WorkerSelectionResult.alternatives`) recorded for every dispatch. |
| A4 (Content-Addressed Truth) | `WorkerStats` are computed on-demand from `execution_traces` (never materialized as a blob), preserving derivability from content-hash-bound trace data. `WorkerProfile` metadata (`promotedAt`, `demotionCount`) are operational state, not verified facts — A4 applies to the source traces, not the derived statistics. Capability cache (60s TTL) is invalidated if new traces arrive for the relevant worker, preventing stale routing decisions. |
| A5 (Tiered Trust) | Worker capability scores inherit trust tiers: oracle-verified outcomes (deterministic) > quality score deltas (heuristic) > token cost proxies (probabilistic). |
| A6 (Zero-Trust Execution) | Probation workers execute in shadow mode only. Promoted workers still go through full oracle verification. Worker status transitions require passing safety invariants. |
| A7 (Prediction Error as Learning) | Worker selection produces a prediction: "Worker X will achieve quality Y on this task." The delta between predicted and actual quality calibrates the worker capability model. |

---

#### Phase 4 Readiness Gate

Before *any* Phase 4 component activates (already implemented in `src/observability/phase3-report.ts:209-242`):

| Gate | Threshold | Source |
|:-----|:----------|:-------|
| Active rules with effectiveness > 0.3 | ≥ 3 | `ruleStore.findActive()` |
| Active skills with successRate > 0.7 | ≥ 2 | `skillStore.findActive()` |
| Self-Model global accuracy | ≥ 0.70 | `phase3Report.selfModel.globalAccuracy` |
| Sleep cycles completed | ≥ 10 | `patternStore.countCycleRuns()` |

#### Per-Sub-Phase Data Gates

| Prerequisite | PH4.0 | PH4.1 | PH4.2 | PH4.3 | PH4.4 | PH4.5 |
|:-------------|:-----:|:-----:|:-----:|:-----:|:-----:|:-----:|
| Total traces | P3 gate | 500 | 500 | 750 | 750 | 1000 |
| Distinct task signatures | P3 gate | 10 | 10 | 15 | 15 | 20 |
| Traces with >1 distinct `worker_id` | 0 | 50 | 100 | 200 | 200 | 300 |
| Registered worker profiles | 0 | 0 | 2 | 3 | 3 | 3 |
| Workers with ≥20 traces each | 0 | 0 | 0 | 2 | 2 | 3 |

---

#### Sub-Components

##### PH4.0 — Multi-Model Data Seeding `[S]` — Engineering ✅

> **Why this sub-phase exists:** The original draft overlooked a chicken-and-egg problem. PH4.3-PH4.4 need multi-model trace data to compare workers, but the current system uses a single model per tier. Without deliberate seeding, the system accumulates 500+ traces all from the same worker per tier, making worker comparison statistically impossible.

**What:** Bootstrap Phase 4 data requirements by converting existing single-model-per-tier mappings into explicit `WorkerProfile` records, and extending epsilon-greedy exploration from routing-level (PH3.6) to worker selection.

**Implementation scope:**

1. **Auto-register existing models as WorkerProfiles.** On factory startup, for each provider in `LLMProviderRegistry`, create a `WorkerProfile` with `status: "active"` (grandfathered — these are proven models from Phase 3) and initial `stats` bootstrapped from existing traces filtered by `model_used`. This ensures backward compatibility — the system starts with the same behavior as Phase 3, but now with explicit worker identity.

2. **Worker-level epsilon exploration.** Extend the existing `EPSILON = 0.05` mechanism (currently at `core-loop.ts` for routing-level exploration) to include worker variation: with probability `epsilon_worker` (default: 0.10), select a *different* active worker than the scoring function would choose. Constraint: exploration never selects a probation or demoted worker. Exploration never routes DOWN (safety carried from PH3.6).

3. **Trace tagging.** `ExecutionTrace.worker_id` (field exists in `types.ts` and SQLite schema but is never populated) must be set on every trace with the selected WorkerProfile ID. This is the single most important change — it unlocks all downstream Phase 4 analysis.

**Files changed:**
- `src/orchestrator/types.ts` — add `WorkerProfile`, `WorkerConfig`, `WorkerStats` interfaces; add `workerSelectionAudit?: WorkerSelectionResult` to `ExecutionTrace`
- `src/orchestrator/factory.ts` — auto-register existing providers as worker profiles on startup
- `src/orchestrator/core-loop.ts` — populate `trace.worker_id` from `routing.workerId`
- `src/orchestrator/worker/worker-pool.ts` — change `dispatch()` signature from `(input, level)` to `(input, routing)` to carry `workerId`; update all callers
- `src/db/trace-schema.ts` — add `CREATE INDEX IF NOT EXISTS idx_et_worker_id ON execution_traces(worker_id)` (**critical for performance** — without this, every `WorkerStats` computation does a full table scan); add `worker_selection_audit TEXT` column

**Acceptance criteria:**
- Every new trace has `worker_id` non-null
- At least 2 worker profiles registered on startup (one per existing tier)
- After 100 traces, ≥ 10% have a different `worker_id` than the default selection would produce
- Backward-compatible: system runs identically to Phase 3 when epsilon exploration is disabled

---

##### PH4.1 — Worker Profile Registry `[M]` — Engineering ✅

**What:** Define `WorkerProfile` as a first-class entity and persist it in SQLite. A WorkerProfile pairs a specific configuration with empirical statistics computed from `ExecutionTrace` data.

**Design Decisions (all open questions from draft resolved):**

**D4.1-1: Worker identity granularity.** A worker is identified by `(modelId, temperature, systemPromptTemplate)`.
- `modelId` alone is too coarse — temperature significantly affects output quality for creative vs. precise tasks.
- `toolAllowlist` differences create distinct capability profiles and should differentiate workers.
- `systemPromptTemplate` is included because different system prompts produce qualitatively different behavior (e.g., a "concise" variant vs. a "thorough" variant).
- Model version changes within the same family (e.g., `claude-sonnet-4-20250514` vs a future point release) do **NOT** create new workers. `modelId` uses the base model name (`claude-sonnet`), not the full version string. Rationale: point releases are typically improvements; resetting stats on every version prevents data accumulation. A major generation change (e.g., `claude-sonnet` → `claude-opus`) IS a new worker.

**D4.1-2: Scope.** Profiles are **project-scoped**. The data model includes an optional `projectId` field (nullable, defaults to current project) so Phase 5 can extend to cross-project without migration. Aligns with existing per-project SQLite database pattern.

**D4.1-3: Stats computation.** `WorkerStats` is **NOT** stored as a materialized blob. It is computed on-demand from traces via SQL aggregates, cached in-memory with 60-second TTL. Rationale: storing a stats blob creates sync problems (stats diverge from traces); computing from traces is cheap with proper SQLite indexes.

**Key types (scope-level — implementor defines exact Zod schemas):**

```
WorkerProfile:
  id: string                      // "worker-{modelBase}-{tempBucket}-{hash(config)}"
  config: WorkerConfig
  status: "probation" | "active" | "demoted" | "retired"
  createdAt: number
  promotedAt?: number
  demotedAt?: number
  demotionReason?: string
  demotionCount: number           // track re-entries for permanent retirement

WorkerConfig:
  modelId: string                 // base model name, e.g., "claude-sonnet"
  modelVersion?: string           // optional specific version for audit trail
  temperature: number             // quantized to 0.1 increments
  toolAllowlist?: string[]        // if empty/undefined, all tools allowed
  systemPromptTemplate?: string   // template ID or "default"
  maxContextTokens?: number

WorkerStats (computed from traces, NOT stored):
  totalTasks: number
  successRate: number
  avgQualityScore: number
  avgDuration_ms: number
  avgTokenCost: number
  taskTypeBreakdown: Record<taskSig, {
    count: number
    successRate: number
    avgQuality: number
    avgTokens: number
  }>
  lastActiveAt: number
```

**New SQLite table:** `worker_profiles` — schema follows existing patterns (`rule_store`, `skill_store`):

```sql
CREATE TABLE IF NOT EXISTS worker_profiles (
  id                TEXT PRIMARY KEY,
  model_id          TEXT NOT NULL,
  model_version     TEXT,
  temperature       REAL NOT NULL DEFAULT 0.7,
  tool_allowlist    TEXT,          -- JSON array or null
  system_prompt_tpl TEXT DEFAULT 'default',
  max_context_tokens INTEGER,
  status            TEXT NOT NULL DEFAULT 'probation'
                    CHECK(status IN ('probation','active','demoted','retired')),
  created_at        INTEGER NOT NULL,
  promoted_at       INTEGER,
  demoted_at        INTEGER,
  demotion_reason   TEXT,
  demotion_count    INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_wp_status ON worker_profiles(status);
CREATE INDEX IF NOT EXISTS idx_wp_model ON worker_profiles(model_id);
```

Stats computed via trace aggregation:

```sql
SELECT worker_id, COUNT(*) as total_tasks,
  AVG(CASE WHEN outcome = 'success' THEN 1.0 ELSE 0.0 END) as success_rate,
  AVG(quality_composite) as avg_quality,
  AVG(tokens_consumed) as avg_tokens,
  AVG(duration_ms) as avg_duration
FROM execution_traces WHERE worker_id = ? GROUP BY worker_id;
```

**New files:**
- `src/db/worker-schema.ts` — schema SQL
- `src/db/worker-store.ts` — CRUD + stats queries (follows `rule-store.ts` pattern)

**Files modified:**
- `src/db/vinyan-db.ts` — add `WORKER_SCHEMA_SQL` to schema initialization
- `src/orchestrator/types.ts` — add `WorkerProfile`, `WorkerConfig`, `WorkerStats` interfaces
- `src/observability/metrics.ts` — add worker stats to `SystemMetrics`

**Failure modes:**

| Failure | Detection | Recovery |
|:--------|:----------|:---------|
| Worker profile DB corruption | SQLite integrity check on startup | Re-create table, re-derive profiles from trace data (`model_used` column) |
| Stats computation timeout | 5-second SQL timeout | Return stale cached stats; log warning |
| Worker ID format collision | Unique constraint violation on insert | Append random suffix; log warning |

**Safety invariants:**
- Worker profiles cannot be deleted, only demoted/retired. Audit trail is permanent.
- The `MODEL_ALLOWLIST_PREFIXES` from existing safety invariants (`safety-invariants.ts`) applies: workers can only reference models matching the allowlist.

**Acceptance criteria:**
- Worker profiles persist across process restarts
- Stats computation returns within 100ms for 1000 traces
- Backward-compatible: system runs identically to Phase 3 when no explicit worker profiles exist (falls through to tier-based selection)

---

##### PH4.2 — Worker Lifecycle (Probation/Promotion/Demotion) `[M]` — Engineering ✅

**What:** Deterministic state machine governing worker status transitions. New configurations start on probation. Promotion requires statistically significant quality. Demotion is automatic on sustained underperformance.

**Design Decisions (all open questions from draft resolved):**

**D4.2-1: Minimum task count before promotion.** **30 tasks** on probation. Rationale: Wilson lower bound at α=0.05 requires ~25 observations for meaningful confidence intervals. 30 provides margin for multiple task types. Higher than the draft's "explore: 20?" because we need statistical power across fingerprint dimensions, not just overall.

**D4.2-2: Demotion is time-boxed, not permanent.** Demoted workers re-enter probation after **50 sessions** (configurable). Rationale: model provider improvements, codebase changes, or task distribution shifts can make a previously-poor worker competitive. However, a worker demoted **3 times** is **permanently retired** (prevents oscillation). The `RETIRED` status has no return path.

**D4.2-3: Probation shadow interaction.** Probation worker shadow runs **REPLACE** the Phase 2 shadow test-suite run for that task, not ADD to it. The `ShadowValidationResult.pheAlternatives` field (already typed in `types.ts:223-227`) carries the probation worker's result. This bounds compute cost to 1 extra LLM call per probation worker, not 1 extra LLM call + 1 extra test suite run. The existing `ShadowRunner` (`src/orchestrator/shadow-runner.ts`) is extended with a `runAlternativeWorker()` method.

**D4.2-4: Probation dispatch frequency.** Probation workers are dispatched on **20%** of eligible tasks (not all tasks). "Eligible" means the task's routing level matches the probation worker's model tier. This limits cost increase to ~20% per probation worker.

**State machine:**

```
                    register()
     [new config] ────────────> PROBATION
                                    │
                      30+ tasks,    │   fail rate > 50% after 30 tasks
                      Wilson LB     │   OR quality < baseline − 2σ
                      success > T,  │
                      quality >= BL │
                                    │
               promote()            │ demote()
                   ┌────────────────┤────────────────┐
                   v                                  v
                ACTIVE                            DEMOTED
                   │                                  │
                   │  rolling 30 tasks:               │  after 50 sessions:
                   │  success < T − 0.1               │  re-enter probation
                   │  OR quality < median              │  (max 3 re-entries,
                   │     active worker − 2σ            │   then RETIRED)
                   │                                  │
                   └──────── demote() ────────────────┘
                                                      │
                                              3rd demotion:
                                                      v
                                                  RETIRED
                                              (permanent, no return)
```

**Promotion gate (deterministic, A3-compliant):**
1. `observationCount >= 30`
2. Wilson lower bound of success rate at α=0.05 > project-wide active-worker median success rate
3. Average quality score >= project-wide baseline (computed from all active workers' average quality)
4. Zero safety invariant violations during probation period

**Demotion trigger (checked per Sleep Cycle, NOT per-task — prevents oscillation):**
1. Rolling window of last 30 tasks: success rate drops below `activeWorkerMedianSuccessRate − 0.10`
2. OR quality score drops below `activeWorkerMedianQuality − 2 × stddev(activeWorkerQualities)`

**New files:**
- `src/orchestrator/worker-lifecycle.ts` — state machine, promotion/demotion logic, transition checks

**Files modified:**
- `src/orchestrator/shadow-runner.ts` — add `runAlternativeWorker()` for probation shadow dispatch
- `src/db/worker-store.ts` — status transition methods with audit logging
- `src/sleep-cycle/sleep-cycle.ts` — check worker lifecycle transitions during each sleep cycle
- `src/evolution/safety-invariants.ts` — add fleet governance invariants (I8-I11, see Safety section)

**Failure modes:**

| Failure | Detection | Recovery |
|:--------|:----------|:---------|
| Probation worker crashes repeatedly | 3 consecutive timeouts | Auto-demote; do not retry probation |
| All workers demoted (fleet collapse) | `activeWorkerCount < 1` | Emergency: re-activate the highest-performing demoted worker; emit `fleet:emergency_reactivation` event. **Invariant I8 prevents this.** |
| Promotion creates monoculture | Diversity metric drops below threshold | See PH4.5 diversity protection |

**Acceptance criteria:**
- State transitions logged to audit trail (bus events: `worker:promoted`, `worker:demoted`, `worker:reactivated`)
- A worker with genuinely better quality is promoted within ~50 sessions (20% dispatch rate → ~60 total sessions for 30 observations)
- A worker with declining quality is demoted within 3 Sleep Cycles of sustained underperformance
- Architecture success criterion met: **"Fleet governance demotes underperforming configurations within 20 sessions"** (from `vinyan-architecture.md` §10). Note: with `sleep_cycle_interval=20` sessions, the demotion trigger (rolling 30-task window checked per Sleep Cycle) can detect underperformance in 1-2 cycles (20-40 sessions). To meet the 20-session target, the implementor should ensure demotion checks run EVERY Sleep Cycle and that a single cycle's worth of data (≥20 tasks for an active worker) is sufficient to trigger the rolling-window threshold.
- Backward-compatible: with 0-1 worker profiles, system behaves identically to Phase 3

**Probation worker isolation level:** Probation workers inherit the task's routing level for isolation (L0/L1/L2/L3 as determined by `riskRouter`). They run in the same isolation context as the incumbent worker — the only difference is that their output is NOT committed (I10). For L3 tasks, probation shadow runs use the same container isolation as online L3 workers.

---

##### PH4.3 — Task Fingerprinting & Capability Modeling `[L]` — Engineering + Research ✅

**What:** Build a matching system between task characteristics and worker demonstrated strengths, derived from trace data, not declared. "This worker empirically succeeds at React refactoring tasks."

**Design Decisions (all open questions from draft resolved):**

**D4.3-1: Fingerprint dimensionality.** 5 dimensions — 3 always-active (reusing PH3.1 task signatures) + 2 that activate when data accumulates:

| Dimension | Type | Source | Activation Gate |
|:----------|:-----|:-------|:---------------|
| `actionVerb` | categorical | PH3.1 signature segment 1 | Always active |
| `fileExtensions` | categorical | PH3.1 signature segment 2 | Always active |
| `blastRadiusBucket` | ordinal (single/small/medium/large) | PH3.1 signature segment 3 | Always active |
| `frameworkMarkers` | set | Detected from imports in `PerceptualHierarchy.dependencyCone` | 200+ traces with import data |
| `oracleFailurePattern` | categorical | Most-frequently-failing oracle per task type | 500+ traces |

Rationale: PH3.1's existing task signature provides 3 meaningful dimensions. Framework markers capture domain-level capability (React vs Express vs testing library). Oracle failure pattern captures structural difficulty (type oracle failures = tasks needing strong type reasoning). More dimensions deferred until data proves they differentiate workers.

**D4.3-2: Continuous capability scores, not binary.** Each worker-fingerprint cell stores `capabilityScore: number` in [0, 1], computed as `wilsonLowerBound(successes, total)` at α=0.05. Conservative (underestimates true ability), which is correct for a selection system — you want to be *confident* a worker is good, not optimistic.

**D4.3-3: Cold-start.** When a worker has < 5 traces for a fingerprint dimension, capability is `null` (A2: "I don't know"). The router falls through to tier-based selection for that dimension. Match score uses only dimensions with non-null capability.

**D4.3-4: Negative capabilities.** Explicitly tracked. If `wilsonLowerBound(failures, total) > 0.6` for a worker-fingerprint cell (>60% failure with statistical confidence), the worker has a **negative capability**. Negative capabilities are **exclusionary**: the router will NOT assign a task to a worker with a negative capability for any matching fingerprint dimension, regardless of other scores.

**Key types:**

```
TaskFingerprint:
  actionVerb: string              // "refactor", "fix", "add", "test", etc.
  fileExtensions: string          // "ts", "ts,tsx", "py", etc.
  blastRadiusBucket: string       // "single", "small", "medium", "large"
  frameworkMarkers?: string[]     // ["react", "express"], detected from imports
  oracleFailurePattern?: string   // "type", "test", "ast", etc.
```

**Capability vector** — NOT a separate table. Computed from indexed traces:

```sql
SELECT task_type_signature, COUNT(*) as total,
  SUM(CASE WHEN outcome='success' THEN 1 ELSE 0 END) as successes
FROM execution_traces WHERE worker_id = ? GROUP BY task_type_signature;
```

Framework markers require new column: `framework_markers TEXT` in `execution_traces`, populated during perception assembly by scanning `PerceptualHierarchy.dependencyCone.directImportees` for known framework patterns (react, express, fastify, zod, prisma, etc.).

**New files:**
- `src/orchestrator/task-fingerprint.ts` — fingerprint computation from `TaskInput` + `PerceptualHierarchy`
- `src/orchestrator/capability-model.ts` — per-worker capability vector computation and querying

**Files modified:**
- `src/orchestrator/types.ts` — add `TaskFingerprint` interface
- `src/orchestrator/perception.ts` — detect framework markers during perception assembly
- `src/db/trace-schema.ts` — add `framework_markers TEXT` column to `execution_traces`
- `src/db/trace-store.ts` — add capability aggregation queries

**Failure modes:**

| Failure | Detection | Recovery |
|:--------|:----------|:---------|
| Fingerprint dimensionality too low (no differentiation) | All workers have same score for all fingerprints | Fall back to tier-based selection; log diagnostic |
| Fingerprint dimensionality too high (sparse data) | Most worker-fingerprint cells have < 5 traces | Collapse to 3 active dimensions only |
| Framework detection false positives | Manual monitoring; no automated detection | Framework pattern list is a configurable allowlist |

**Acceptance criteria:**
- Fingerprint computed for every task within 10ms
- At least 2 workers differentiated on at least 1 fingerprint dimension after 300 multi-model traces
- Negative capabilities correctly exclude workers from tasks they consistently fail at
- Capability scores are conservative (Wilson LB) and do not overestimate

---

##### PH4.4 — Capability-Based Router `[L]` — Engineering ✅

**What:** Replace `LLMProviderRegistry.selectForRoutingLevel()` with a multi-factor capability match. **The core architectural change of Phase 4.**

**Design Decisions (all open questions from draft resolved):**

**D4.4-1: Scoring formula.** Weighted product (not sum), fully deterministic:

```
score(worker, fingerprint, budget) =
  capabilityMatch(worker, fingerprint)^2        // dominant signal
  × qualityTrackRecord(worker)^1                // moderate signal
  × costEfficiency(worker, budget)^0.5          // minor signal (tiebreaker-weight)
  × (1 − negativeCapabilityPenalty(worker, fp)) // binary gate: 0 or 1
```

Where:
- `capabilityMatch` = average Wilson LB across matching fingerprint dimensions (null dimensions excluded)
- `qualityTrackRecord` = worker's overall `avgQualityScore` from WorkerStats
- `costEfficiency` = `1 − (worker.avgTokenCost / budget.maxTokens)` clamped to [0.1, 1.0]
- `negativeCapabilityPenalty` = 1 if ANY negative capability on matching dimension, else 0

Rationale for weighted product over sum: a zero in any factor (especially negative capability) completely excludes the worker. Exponents make capability match the dominant signal, quality secondary, and cost a tiebreaker. Rationale over priority-based filter chain: filter chain loses information — a worker that's 2nd-best on capability but 1st on cost would never be considered. Weighted product preserves multi-factor tradeoffs while remaining deterministic (A3).

**D4.4-2: Exploration.** Extend PH3.6's epsilon-greedy to worker selection. With probability `epsilon_worker` (default: 0.10), select a random active worker instead of the highest-scoring. Constraint: exploration never selects probation or demoted workers. Exploration traces tagged `exploration: true` (reusing existing field). This provides variation data for PH4.3 capability modeling.

**D4.4-3: Cost as a factor, not just tiebreak.** Cost matters for budget-constrained tasks but should not override quality. The 0.5 exponent makes cost a weak signal — a 2× cheaper worker gets only ~30% boost, easily overridden by 10% quality advantage. For budget-unlimited tasks, `costEfficiency` approaches 1.0 for all workers (irrelevant).

**D4.4-4: Gradual rollout via data gate.** The capability router activates through the existing data gate mechanism (`src/orchestrator/data-gate.ts`). New gate: `"fleet_routing"` with conditions:
- `active_workers >= 2`
- `worker_trace_diversity >= 100` (traces with >1 distinct `worker_id`)

Below thresholds → tier-based selection (backward compatible). Above → capability-based. Smooth transition, not a feature flag.

**New interface:**

```
WorkerSelector:
  selectWorker(
    fingerprint: TaskFingerprint,
    routingLevel: RoutingLevel,
    budget: { maxTokens: number; timeoutMs: number },
    excludeWorkerIds?: string[],  // for retry-with-different-worker
  ): WorkerSelectionResult

WorkerSelectionResult:
  workerId: string
  workerConfig: WorkerConfig
  selectionReason: "capability" | "tier-fallback" | "exploration"
  score: number
  alternatives: Array<{ workerId: string; score: number }>  // audit trail
```

**Integration point in core loop:** INSIDE the retry loop, after perception assembly (`perceptionAssembler.assemble()`) and risk assessment, but before `workerPool.dispatch()`. Worker selection requires `PerceptualHierarchy` for fingerprint computation (framework markers from `dependencyCone`), so it CANNOT be placed before perception. Approximate location: after `routing = riskRouter.assessInitialLevel(...)` inside the retry loop, before `workerPool.dispatch(workerInput, routing)`.

```
// Step 2½: SELECT WORKER (Phase 4)
if (deps.workerSelector) {
  const fingerprint = computeFingerprint(input, perception);
  const selection = deps.workerSelector.selectWorker(fingerprint, routing.level, input.budget);
  routing = { ...routing, workerId: selection.workerId, model: selection.workerConfig.modelId };
}
```

**Breaking interface change:** `WorkerPool.dispatch()` signature changes from `(input: WorkerInput, level: RoutingLevel)` to `(input: WorkerInput, routing: RoutingDecision)` to carry `workerId` and `model` through to the provider selection. All callers and the `WorkerPool` interface in types must be updated. The `RoutingDecision.workerId` field (already declared in `types.ts`) flows through to `WorkerPoolImpl.dispatch()`, which uses `routing.workerId` to call `providerRegistry.selectById(workerId)` (new method) instead of `selectForRoutingLevel(level)`.

**`WorkerSelectionResult` audit trail in `ExecutionTrace`:** Add new field `worker_selection_audit TEXT` (JSON) to `execution_traces` schema and `workerSelectionAudit?: WorkerSelectionResult` to `ExecutionTrace` type. This carries the full selection rationale (score, alternatives, reason) for every trace — required for A3 audit compliance.

**New files:**
- `src/orchestrator/worker-selector.ts` — `WorkerSelector` implementation with scoring function, exploration, diversity enforcement

**Files modified:**
- `src/orchestrator/core-loop.ts` — add worker selection step between risk assessment and dispatch
- `src/orchestrator/worker/worker-pool.ts` — use `routing.workerId` to select provider and configure dispatch instead of `selectForRoutingLevel()`
- `src/orchestrator/llm/provider-registry.ts` — add `selectById(workerId)` method; tier-based `selectForRoutingLevel()` becomes fallback
- `src/orchestrator/factory.ts` — wire `WorkerSelector` dependency
- `src/orchestrator/data-gate.ts` — add `fleet_routing` feature gate with `active_workers` and `worker_trace_diversity` conditions (wire the unmapped `DataGateMetric` entries already in `types.ts:243-244`)

**Failure modes:**

| Failure | Detection | Recovery |
|:--------|:----------|:---------|
| All workers score identically | Scores within 0.01 of each other | Random selection among tied; log diagnostic — insufficient data, not an error |
| Selected worker's provider unavailable | `CircuitBreaker.isOpen()` check | Exclude worker from candidates; re-select |
| Worker selection too slow | 50ms timeout | Return tier-based fallback; log diagnostic |
| Exploration consistently selects worse workers | Quality trend negative during high exploration | Reduce `epsilon_worker` to 0.03; minimum floor |

**Acceptance criteria:**
- Worker selection adds < 10ms to the routing path
- Selection is fully deterministic: same inputs → same output (no randomness except epsilon exploration, which is seeded and logged)
- With 2+ active workers and 200+ multi-model traces, the router assigns workers differentially (not always the same worker)
- Tier-based fallback activates cleanly when data gate is not met
- Selection audit trail (`WorkerSelectionResult.alternatives`) included in every `ExecutionTrace`

---

##### PH4.5 — Fleet Evaluation & Evolution Integration `[M]` — Engineering ✅

**What:** Extend Sleep Cycle and Evolution Engine to reason about worker performance. The system learns which worker is best for which task type and encodes that knowledge as deterministic rules.

**Design Decisions (all open questions from draft resolved):**

**D4.5-1: Worker-preference rules use the SAME probation pipeline.** Rationale: consistency and safety. A "prefer worker X for task type Y" rule is no different from an "escalate to L2 for file pattern Z" rule — both modify routing decisions and both can cause harm if wrong. Same backtesting, same probation period, same safety invariant checks.

**D4.5-2: New evolution rule action `"assign-worker"`.** Added to `EvolutionaryRule.action` union type. Parameters: `{ workerId: string, reason: string }`. Subject to all existing safety invariants PLUS fleet safety invariants (I8-I11). Applied at the same core-loop location as `prefer-model` — sets `routing.workerId`.

**D4.5-3: Fleet collapse prevention — 3-layer defense (the central design challenge):**

| Layer | Mechanism | Enforcement Point |
|:------|:----------|:-----------------|
| **A: Diversity Floor** | At least `min(3, activeWorkerCount)` workers must each receive ≥ 15% of tasks per Sleep Cycle window. If any active worker drops below 15%, increase `epsilon_worker` targeting that worker. | `WorkerSelector` in `worker-selector.ts` |
| **B: Exploration Budget** | Minimum 10% of tasks always dispatched via epsilon-worker exploration (never reduced below 10% even when scoring has a clear winner). Ensures continuous data flow to all active workers. | `WorkerSelector` configuration floor |
| **C: Staleness Penalty** | A worker's capability score decays if not dispatched recently. After 2 Sleep Cycles without new traces, cached stats get 0.9× penalty per cycle. Naturally rotates traffic to underserved workers. | `capability-model.ts` score computation |

**New pattern type:** `"worker-performance"` added to `ExtractedPattern.type`. **Requires extending `ExtractedPattern` with new fields:** `workerId?: string` and `comparedWorkerId?: string` (analogous to existing `approach`/`comparedApproach` but for worker identity). Generated during Sleep Cycle when:
- 2+ workers have ≥ 10 traces each for the same task fingerprint
- Quality distributions are statistically different (Wilson LB comparison)
- Better worker's Wilson LB quality > worse worker's Wilson UB quality (non-overlapping confidence intervals)

**New rule generation:** `rule-generator.ts` gains `generateWorkerAssignmentRule()`:
- Input: worker-performance pattern
- Output: `EvolutionaryRule` with `action: "assign-worker"`, `condition: { task fingerprint dimensions }`, `parameters: { workerId, qualityDelta, reason }`
- Status: `"probation"` (standard pipeline)

**Fleet-level metrics extension to `EvolutionMetrics`:**

```
fleetMetrics:
  activeWorkers: number
  probationWorkers: number
  demotedWorkers: number
  diversityScore: number           // Gini coefficient of task allocation (0 = equal, 1 = monoculture)
  capabilityCoverage: number       // fraction of fingerprint dimensions with ≥1 worker capability > 0.5
  avgWorkerSpecialization: number  // average variance of per-worker capability across dimensions
  workerUtilization: Record<workerId, number>  // fraction of total tasks
```

**Files modified:**
- `src/orchestrator/types.ts` — add `"assign-worker"` to `EvolutionaryRule.action` union; add `"worker-performance"` to `ExtractedPattern.type`; add `workerId?`/`comparedWorkerId?` fields to `ExtractedPattern`; add fleet metrics interface
- `src/db/rule-schema.ts` — **update `CHECK(action IN (...))` constraint** to include `"assign-worker"` (without this, SQLite rejects worker-assignment rules at INSERT)
- `src/db/pattern-schema.ts` — add `worker_id TEXT` and `compared_worker_id TEXT` columns for worker-performance patterns
- `src/sleep-cycle/sleep-cycle.ts` — add worker comparison analysis during sleep cycle; generate worker-performance patterns
- `src/evolution/rule-generator.ts` — add `generateWorkerAssignmentRule()` function
- `src/evolution/safety-invariants.ts` — add `"assign-worker"` branch to `checkSafetyInvariants()` switch; enforce I8-I11 fleet invariants
- `src/observability/phase3-report.ts` — extend `EvolutionMetrics` with `fleetMetrics`
- `src/orchestrator/worker-selector.ts` — implement diversity floor and staleness penalty

**Failure modes:**

| Failure | Detection | Recovery |
|:--------|:----------|:---------|
| Worker-performance pattern noise | Backtesting rejects pattern | Standard probation pipeline filters it |
| Fleet converges to single worker | `diversityScore > 0.8` (high Gini) | Increase `epsilon_worker` to 0.20; emit `fleet:convergence_warning` |
| Worker assignment rules conflict | Two rules assign different workers for same fingerprint | Standard `resolveRuleConflicts()` picks higher specificity/effectiveness |
| Sleep cycle too slow with worker analysis | Cycle > 60s | Worker analysis is optional; skip if time budget exceeded |

**Acceptance criteria:**
- At least 1 worker-performance pattern generated within 30 Sleep Cycles (given sufficient multi-model traces)
- Fleet diversity score < 0.7 (no monoculture) after 500 traces with 3+ active workers
- Worker assignment rules pass backtesting at comparable rate to other evolution rules
- All active workers receive ≥ 10% of tasks over any 5-Sleep-Cycle window
- **Architecture §10 criterion: "Fleet governance demotes underperforming configurations within 20 sessions"**

---

##### PH4.6 — Cross-Project Pattern Transfer `[L]` — Research (SCOPED DOWN) ✅

**What:** Design and implement the pattern abstraction layer. **Defer actual automatic cross-project transfer to Phase 5.**

**Rationale for scoping down:** The draft correctly identified this as highest uncertainty. Phase 4 should focus on proving single-project fleet governance works. The abstraction layer is valuable infrastructure even without active transfer — it enables pattern export/import as a manual, human-supervised operation.

**Decision: Implement the abstraction layer + manual export/import; defer automatic transfer.**

**Implementation scope:**

1. **AbstractPattern type.** Strips project-specific details from `ExtractedPattern`:

```
AbstractPattern:
  fingerprint: TaskFingerprint    // stripped of project-specific file paths
  approach: string                // generalized approach description
  qualityRange: { min: number; max: number }
  confidence: number              // Wilson LB from source, reduced by 50% on import
  sourceProjectId: string
  sourcePatternIds: string[]
  applicabilityConditions:
    frameworkMarkers: string[]    // must match for import eligibility
    languageMarkers: string[]    // must match
    complexityRange: string[]    // must overlap
```

2. **Pattern abstraction function.** `abstractPattern(pattern, traces) → AbstractPattern | null`:
   - Strips file paths from task signature, retains verb + extension + blast bucket
   - Generalizes approach description: replaces specific symbol names with type placeholders
   - Returns `null` if pattern is too project-specific (e.g., tied to a single file path with no generalizable characteristics)

3. **Export/Import CLI.** `vinyan patterns export --format json` and `vinyan patterns import --file patterns.json --status probation`. Imported patterns enter probation with confidence reduced by 50%.

4. **Project similarity metric.** Simple heuristic: fraction of shared framework + language markers. Threshold for import eligibility: ≥ 0.5 similarity. Intentionally crude — refined in Phase 5.

**New files:**
- `src/evolution/pattern-abstraction.ts` — abstraction function and `AbstractPattern` type
- `src/cli/patterns.ts` — export/import CLI commands

**This sub-phase does NOT:**
- Automatically transfer patterns between projects
- Run imported patterns without human invocation (`vinyan patterns import` is explicit)
- Claim to solve cross-domain transfer — code-to-code only

**Acceptance criteria:**
- At least 50% of generated patterns can be abstracted (non-null result)
- Exported patterns can be imported into a fresh project and enter probation
- Imported patterns pass backtesting at ≥ 50% the rate of locally-generated patterns (on a project with similar framework markers)

---

#### Gap Closure Analysis

##### GAP-A: World Graph ≠ World Model

**Phase 4 disposition: PARTIALLY ADDRESSED, remainder deferred.**

Phase 3 delivered the Self-Model (forward predictor for test results, blast radius, duration, quality). Phase 4 extends this by adding *worker-specific* predictions: "Worker X will achieve quality Y on this task." This is a deeper forward model — it predicts not just task outcomes but *agent-task interaction outcomes*.

Remaining gap — causal graph relationships in World Graph ("change to B causes C to break") — NOT addressed. Rationale: the dep-oracle already provides dependency-based blast radius (weak causal proxy), and true causal edges require observing actual cascading failures, not just predicting them. **Deferred to Phase 5** where multi-instance coordination provides observation data for causal inference.

##### GAP-C: Skill Formation vs Rules

**Phase 4 disposition: FURTHER ADDRESSED.**

Phase 2 implemented `CachedSkill` (L0 reflex shortcuts). Phase 3 added cross-task fuzzy matching. Phase 4 adds **worker-specific skills**: "for React refactoring tasks, Worker X with this approach at temperature 0.3 succeeds 90% of the time." Richer model because it binds approach to worker configuration, not just task type.

Remaining gap — hierarchical skill composition ("build auth system" = "implement JWT" + "implement middleware") — NOT addressed. Requires Task Decomposer to reason about skill composition. **Deferred to Phase 5.**

##### GAP-G: Cross-Domain Limitation

**Phase 4 disposition: EXPLICITLY DEFERRED.**

Phase 4 is code-only. All oracles remain code-specific. However, Phase 4's architecture is **domain-agnostic by design**: `TaskFingerprint` dimensions are extensible, `WorkerConfig` can specify domain-specific tools, and the `WorkerSelector` scoring function does not assume code-specific features. Phase 5 can add domain-specific fingerprint dimensions (e.g., "document type" for legal) without changing fleet governance architecture.

##### GAP-H: Multi-Agent Failure Mode Coverage

**Phase 4 disposition: 3 of 7 remaining gaps addressed.**

| Failure Mode | Status | Mechanism |
|:-------------|:-------|:----------|
| "Forgot earlier context" (UC-4) | PARTIALLY | WorkerProfile carries cross-task performance history. Not full cross-attempt memory, but worker-level memory of what works. |
| "Restarted randomly" (UC-6) | NOT ADDRESSED | Checkpoint recovery requires Phase 5 state persistence. |
| "Didn't ask when confused" (UC-7) | **ADDRESSED** | Worker capability model enables abstention: if no worker has capability > 0.3 for a task fingerprint, emit `task:uncertain` and request human guidance. **First implementation of A2 at fleet level.** |
| "Withheld information" (UC-9) | PARTIALLY | Worker selection audit trail (`WorkerSelectionResult.alternatives`) broadcasts capability comparison to the bus. Not a full Global Workspace, but oracle results + selection rationale are now available. |
| "Mismatch think vs do" (UC-11) | **ADDRESSED** | Phase 3 Self-Model + Phase 4 worker-level prediction. Capability score IS "think"; actual outcome IS "do." Delta = A7 learning signal. |

**Post-Phase 4 GAP-H coverage: 10/14** (up from 7/14 at Phase 2).

---

#### Safety Invariants — Fleet Governance Extensions

The 7 existing immutable invariants (in `src/evolution/safety-invariants.ts`) remain unchanged. Phase 4 adds 4 fleet-specific invariants:

| # | Invariant | Enforcement |
|:--|:----------|:-----------|
| I8 | **Minimum active workers.** Fleet must maintain ≥ 1 active worker at all times. If the last active worker would be demoted, **block the demotion**. | `worker-lifecycle.ts` checks before demotion |
| I9 | **Oracle verification bypass prohibition.** No worker configuration, regardless of status, can bypass oracle verification. `assign-worker` rules cannot include `skipOracles: true`. | Extended `checkSafetyInvariants()` |
| I10 | **Probation workers cannot commit.** Probation workers execute in shadow mode only. Output scored but **never applied** to workspace. | `core-loop.ts` probation dispatch path |
| I11 | **Worker diversity floor.** No single worker can receive > 70% of tasks over any 5-Sleep-Cycle window. If breached, `epsilon_worker` is forcibly increased. | `worker-selector.ts` diversity enforcement |

These invariants are checked by extending `checkSafetyInvariants()` in `safety-invariants.ts`. The function already handles all evolution rule types; adding `assign-worker` requires a **new branch** in the switch/conditional chain — without this, I8-I11 are never enforced for `assign-worker` rules.

#### Fleet Failure Modes (F6-F10)

Phase 4 introduces 5 new failure modes to the formal register (extending TDD §12C's F1-F5):

| # | Failure Mode | Cause | Detection | Recovery |
|:--|:-------------|:------|:----------|:---------|
| F6 | Fleet monoculture collapse | Scoring function consistently picks same worker; diversity mechanisms insufficient | `fleetMetrics.diversityScore > 0.8` | Force `epsilon_worker` to 0.20; emit `fleet:convergence_warning`; review scoring formula weights |
| F7 | Worker capability data sparsity | Fingerprint dimensions differentiate no workers; all scores equal | All workers score within 0.01 for all fingerprints | Fall back to tier-based selection; reduce to 3 always-active dimensions; log diagnostic |
| F8 | Probation compute amplification | Multiple simultaneous probation workers (each 20%) exceed budget | Compute cost tracking exceeds `budget.maxTokens × 1.5` | Limit to max 1 probation worker dispatched per task; queue excess probation work |
| F9 | Worker profile DB divergence | Stats cache serves stale data after trace correction/migration | Periodic consistency check (stats vs. fresh SQL aggregate) | Invalidate cache on any trace mutation; force recompute |
| F10 | Epsilon exploration quality degradation | Sustained exploration selects worse workers degrading overall quality | Quality trend negative over 5 Sleep Cycles during active exploration | Reduce `epsilon_worker` to floor (0.03); if trend persists, disable exploration temporarily |

---

#### Dependency Graph

```
PH4.0 (Data Seeding, ~2d) ── PH4.1 (Worker Profiles, ~4d)
                                    │
                                    ├── PH4.2 (Lifecycle, ~5d)
                                    │        │
                                    │        ├───────────────────────────────────┐
                                    │        │                                   │
                                    ├── PH4.3 (Fingerprinting, ~5d)             │
                                    │        │                                   │
                                    │        └── PH4.4 (Capability Router, ~6d) ─┤
                                    │                      │                     │
                                    │                      └── PH4.5 (Fleet Evolution, ~5d)
                                    │                                            │
                                    └──────── PH4.6 (Pattern Transfer, ~4d) ─────┘
                                              [independent, scoped research]
```

**Parallel streams:**
- **Stream A (critical path):** PH4.0 → PH4.1 → PH4.3 → PH4.4 → PH4.5 = **~22d**
- **Stream B:** PH4.1 → PH4.2 (parallel with PH4.3-PH4.4, not on critical path, ~5d)
- **Stream C:** PH4.6 (independent, starts after PH4.1, can be descoped, ~4d)
- **Merge:** PH4.5 requires PH4.2 + PH4.4

**Estimated total:** ~5-6 weeks (engineering ~4 weeks with parallelism, integration + validation ~1-2 weeks)

---

#### Phase 4 Acceptance Criteria (Overall)

| Criterion | Target | Measurement |
|:----------|:-------|:-----------|
| Worker differentiation | ≥ 2 workers with statistically different quality profiles for ≥ 1 task type | Wilson LB non-overlapping CIs |
| Demotion latency | Underperforming worker demoted within 20 sessions | Measured from quality degradation onset to demotion event |
| Quality improvement | Capability-based routing produces ≥ 5% higher avg quality than tier-based | A/B: 100 traces capability routing vs. 100 tier fallback |
| Fleet diversity | No single worker receives > 70% of tasks | `fleetMetrics.diversityScore < 0.7` |
| Safety invariant violations | Zero across all Phase 4 components | Audit log review |
| Backward compatibility | Graceful degradation to Phase 3 when worker data insufficient | Data gate `fleet_routing` correctly blocks activation |
| Pattern mining produces rules | ≥ 1 `assign-worker` rule promoted from probation within 30 Sleep Cycles | Rule store query |
| Latency overhead | Worker selection adds < 10ms to routing path | Performance benchmark |
| Data pipeline completeness | 100% of traces have non-null `worker_id` | SQL count check |
| Abstention protocol | System returns ECP `type: 'unknown'` + emits `task:uncertain` when max capability < 0.3 | Integration test: verify both ECP response and bus event |
| Abstention rate | Abstention triggers < 10% of tasks after 500+ traces (indicates capability coverage growth) | SQL: `COUNT(task:uncertain events) / total tasks` |
| WorkerProfile→LLMProvider resolution | Every `workerId` resolves to exactly 1 `LLMProvider` instance | Startup validation: all registered profiles have valid provider mapping |

---

#### Phase 4 Risk Assessment

| Component | Risk Type | Level | Mitigation | Fallback |
|:----------|:----------|:-----:|:-----------|:---------|
| PH4.0 Data Seeding | Engineering | **Low** | Register existing providers, tag traces. Simple bootstrap. | N/A — required prerequisite |
| PH4.1 Worker Profiles | Engineering | **Low** | Follows existing store patterns (`rule-store`, `skill-store`). | In-memory only if SQLite unavailable |
| PH4.2 Lifecycle | Engineering | **Low-Med** | State machine straightforward. Thresholds informed by Phase 3 data. | Conservative defaults: high promotion bar, slow demotion |
| PH4.3 Fingerprinting | Eng + Research | **Medium** | If dimensions don't differentiate, 3 always-active dimensions provide baseline. | Reduce to 3 dimensions; defer framework markers |
| PH4.4 Capability Router | Engineering | **Medium** | Core loop integration is highest-risk change. Tier-based fallback ensures safety. | Disable capability routing via data gate (zero code change) |
| PH4.5 Fleet Evolution | Engineering | **Low-Med** | Extends existing evolution pipeline. Same probation/backtest machinery. | Disable worker-performance patterns; fleet runs on PH4.4 scoring only |
| PH4.6 Pattern Transfer | Research | **Medium** (scoped down from High) | Abstraction layer only; no auto-transfer. Manual human-supervised. | Export/import is optional; fleet governance works without it |
| Fleet collapse to monoculture | System | **High** | 3-layer defense: diversity floor + exploration budget + staleness penalty. I11 invariant. | Emergency re-activation of demoted workers |
| Insufficient multi-model data | Data | **Medium** | PH4.0 seeds data via epsilon-worker (10% minimum). | Extend seeding period; delay PH4.3+ activation via data gates |

---

#### Configuration Schema Extension

Add `phase4` namespace to `VinyanConfigSchema` (in `src/config/schema.ts`):

```
phase4:
  worker_identity_granularity: "model" | "model+temp" | "full"  // default: "full"
  probation_min_tasks: number           // default: 30
  demotion_window_tasks: number         // default: 30
  demotion_max_reentries: number        // default: 3
  reentry_cooldown_sessions: number     // default: 50
  epsilon_worker: number                // default: 0.10, range: [0.03, 0.30]
  diversity_floor_pct: number           // default: 0.15, range: [0.05, 0.50]
  max_active_workers: number            // default: 10
  capability_min_traces: number         // default: 5
  negative_capability_threshold: number // default: 0.6
  staleness_penalty_per_cycle: number   // default: 0.9
```

#### Bus Events Extension

New events added to `VinyanBusEvents` (in `src/core/bus.ts`):

```
// Worker lifecycle (PH4.2)
"worker:registered": { profile: WorkerProfile }
"worker:promoted": { workerId: string; afterTasks: number; successRate: number }
"worker:demoted": { workerId: string; reason: string; permanent: boolean }
"worker:reactivated": { workerId: string; previousDemotionCount: number }

// Worker selection (PH4.4)
"worker:selected": { taskId: string; workerId: string; reason: string; score: number; alternatives: number }
"worker:exploration": { taskId: string; selectedWorkerId: string; defaultWorkerId: string }

// Fleet governance (PH4.5)
"fleet:convergence_warning": { giniScore: number; dominantWorkerId: string; allocation: number }
"fleet:emergency_reactivation": { workerId: string; reason: string }
"fleet:diversity_enforced": { workerId: string; boostAmount: number }

// Fleet-level uncertainty — GAP-H UC-7 (PH4.4)
"task:uncertain": { taskId: string; reason: string; maxCapability: number }
```

#### Critical Files for Implementation

| File | Changes |
|:-----|:--------|
| `src/orchestrator/types.ts` | Add `WorkerProfile`, `WorkerConfig`, `WorkerStats`, `TaskFingerprint`, `WorkerSelectionResult`. Extend `EvolutionaryRule.action` with `"assign-worker"`. Extend `ExtractedPattern` with `type: "worker-performance"`, `workerId?`, `comparedWorkerId?`. Add `workerSelectionAudit?` to `ExecutionTrace`. |
| `src/orchestrator/core-loop.ts` | Add worker selection step (Step 2½) INSIDE retry loop after perception assembly. Populate `trace.worker_id` and `trace.workerSelectionAudit`. Handle probation worker shadow dispatch. |
| `src/orchestrator/worker/worker-pool.ts` | **Breaking change:** `dispatch(input, level)` → `dispatch(input, routing)`. Use `routing.workerId` to select provider via `selectById()`. Fallback to `selectForRoutingLevel()`. |
| `src/orchestrator/llm/provider-registry.ts` | Add `selectById(workerId)` method. Resolution: `WorkerConfig.modelId` → match against `LLMProvider.id` prefix. If multiple providers share same `modelId`, disambiguate by `modelVersion`. Tier-based `selectForRoutingLevel()` becomes fallback. |
| `src/orchestrator/factory.ts` | Auto-register existing providers as worker profiles (validate against `MODEL_ALLOWLIST_PREFIXES`). Wire `WorkerSelector` dependency. |
| `src/orchestrator/data-gate.ts` | Add `fleet_routing` feature gate. Wire `active_workers` and `worker_trace_diversity` into `METRIC_TO_STAT` map and `DataGateStats` interface (currently unmapped — will cause `undefined >= threshold` → `false` if not wired). |
| `src/sleep-cycle/sleep-cycle.ts` | Worker comparison analysis. Worker-performance pattern generation. Lifecycle transition checks. |
| `src/evolution/rule-generator.ts` | Add `generateWorkerAssignmentRule()`. |
| `src/evolution/safety-invariants.ts` | Add `"assign-worker"` branch to `checkSafetyInvariants()`. Enforce I8-I11. Without this branch, fleet invariants are silently unenforced. |
| `src/db/rule-schema.ts` | **Update `CHECK(action IN (...))` constraint** to include `"assign-worker"`. |
| `src/db/trace-schema.ts` | Add `idx_et_worker_id` index. Add `worker_selection_audit TEXT` and `framework_markers TEXT` columns. |
| `src/db/pattern-schema.ts` | Add `worker_id TEXT` and `compared_worker_id TEXT` columns. |
| `src/observability/phase3-report.ts` | Extend `EvolutionMetrics` with `fleetMetrics`. |
| `src/config/schema.ts` | Add `phase4` config namespace with all Phase 4 parameters. |
| `src/core/bus.ts` | Add Phase 4 bus events. |

**New files to create:**
- `src/db/worker-schema.ts` — SQLite schema for `worker_profiles`
- `src/db/worker-store.ts` — CRUD + stats queries
- `src/orchestrator/worker-lifecycle.ts` — state machine, promotion/demotion logic
- `src/orchestrator/worker-selector.ts` — `WorkerSelector` with scoring, exploration, diversity
- `src/orchestrator/task-fingerprint.ts` — fingerprint computation
- `src/orchestrator/capability-model.ts` — per-worker capability vectors
- `src/evolution/pattern-abstraction.ts` — pattern abstraction + `AbstractPattern` type
- `src/cli/patterns.ts` — export/import CLI
- `src/orchestrator/fleet-evaluator.ts` — Gini coefficient, fleet health metrics (added beyond original plan)

---

#### Phase 4 Implementation Review — Post-Implementation Gap Fixes

A systematic review of the implementation against this design document identified **7 gaps** between the design specification and the initial code. All gaps were root-caused, fixed, and verified (1047 tests, tsc clean). Documented here for traceability.

| # | Gap | Severity | Root Cause | Fix | Verification |
|:--|:----|:---------|:-----------|:----|:-------------|
| **IG-1** | Framework markers not detected in perception | LOW | `perception.ts` built dep cone but did not call `detectFrameworkMarkers()` from `task-fingerprint.ts` | Added import + call in `perception.ts:assemble()`, set `hierarchy.frameworkMarkers`; added `frameworkMarkers?: string[]` to `PerceptualHierarchy` | tsc clean, existing perception tests pass |
| **IG-2** | `workerSelectionAudit` missing on timeout/escalation traces | LOW | `workerSelection` declared inside inner loop — not accessible from timeout (top of loop) or escalation (outside loop) traces | Hoisted `lastWorkerSelection` to outer scope, updated on each selection; used in timeout/escalation trace objects | `core-loop-fleet.test.ts` — escalation trace includes audit |
| **IG-3** | **I10 Probation no-commit not enforced** | **CRITICAL** | `OrchestratorDeps` missing `workerStore` field → factory never injected it → core-loop couldn't check worker status before commit | Added `workerStore?` to `OrchestratorDeps`; wired in `factory.ts`; added probation check in success path — returns empty mutations + shadow enqueue | `core-loop-fleet.test.ts` — probation worker result has 0 mutations + "probation-shadow-only" note |
| **IG-4** | **A2 uncertain abstention missing** | **CRITICAL** | `capability-model.ts:getMaxCapabilityForFingerprint()` existed but was never called; `WorkerSelectionResult` lacked `maxCapability`/`isUncertain` fields | Added uncertainty check in `worker-selector.ts:selectWorker()` (maxCapability < 0.3 → uncertain); added short-circuit in `core-loop.ts` returning `status: "uncertain"`; extended `TaskResult.status` with `"uncertain"` | `worker-selector.test.ts` — all workers below 0.3 → uncertain; `core-loop-fleet.test.ts` — uncertain short-circuits dispatch |
| **IG-5** | Staleness penalty (Layer C) not applied | MEDIUM | `WorkerStats.lastActiveAt` computed by `worker-store.ts` but never consumed in scoring | Added temporal decay `0.9^cyclesSinceActive` to `worker-selector.ts:scoreWorker()`; added `cycleDurationMs` config | `worker-selector.test.ts` — stale worker scored lower than active worker |
| **IG-6** | Exploration uniform random, not targeting underserved | MEDIUM | `exploreRandomWorker()` used uniform `Math.random()` instead of weighting by task deficit | Replaced with inverse-task-count weighted selection: `weight = 1/(stats.totalTasks + 1)` | `worker-selector.test.ts` — exploration selects non-default worker |
| **IG-7** | `assign-worker` rules always fail backtest | HIGH | `sleep-cycle.ts` only imported `backtestRule`, never routed `assign-worker` rules to `backtestWorkerAssignment()` | Added routing: `rule.action === "assign-worker" ? backtestWorkerAssignment(rule, traces) : backtestRule(rule, traces)` in both probation backtest and active rule re-evaluation | `assign-worker-rule.test.ts` — backtestWorkerAssignment returns quality-based pass/fail |

**Design deviations (intentional):**

| Deviation | Reason |
|:----------|:-------|
| `WorkerSelectionResult.workerId` → `selectedWorkerId` | More explicit naming, avoids collision with `WorkerProfile.id` |
| `WorkerSelectionResult.selectionReason` → `reason` | Shorter, consistent with other result types |
| `WorkerSelectionResult.workerConfig` field omitted | Config available via `workerStore.findById()`; duplicating it in every selection result is unnecessary |
| `fleet_min_worker_trace_diversity` = 100 in `factory.ts` (doc says 100 at line 1671) | Matches doc. Sleep-cycle uses threshold = 2 for its own gate (different scope). |
| Added `fleet-evaluator.ts` (not in original file list) | Fleet metrics (Gini coefficient, capability coverage) needed by `phase3-report.ts` for `fleetMetrics` field |
| `TaskResult.status` includes `"uncertain"` | Required by IG-4 (A2 abstention). Doc line 1312 specifies ECP `type: 'unknown'` response — `"uncertain"` is the TaskResult equivalent |
| `TaskResult.notes?: string[]` field added | Carries audit notes (probation-shadow-only, uncertain) without overloading existing fields |

---

### Phase 5 — Self-Hosted ENS

> **Status:** Final design. Prerequisite: Phase 4 complete + acceptance criteria met.
> **Type:** Mixed engineering (Pillar 1, Pillar 3), research (Pillar 2), and infrastructure (cross-cutting).

#### Vision

Phases 0-4 prove the Vinyan thesis incrementally: verification works (Phase 0), the Orchestrator drives autonomous tasks (Phase 1), pattern mining and skill formation compress experience (Phase 2-3), and empirical fleet governance — `WorkerProfile` state machines, `CapabilityModel` Wilson LB scoring, `TaskFingerprint`-based routing — selects the right worker for the right task (Phase 4). Through all these phases, Vinyan remains a **programmatic library invoked from a CLI**. It has no API server, no interactive UI, no way for multiple instances to share knowledge, and its oracle framework is locked to TypeScript despite transport-agnostic design.

Phase 5 transitions from **agent** to **platform**. Three pillars:

1. **Standalone System** — API server, terminal UI, web dashboard, VS Code extension, MCP bridge, A2A bridge, session management with compaction
2. **Multi-Instance Coordination** — ECP over network, instance coordination, cross-instance knowledge sharing
3. **Cross-Language Support** — Polyglot oracle framework, Python/Go/Rust oracle implementations

The architectural insight: **every Phase 5 component extends an existing Phase 0-4 abstraction**. The API server activates `TaskInput.source: 'api'` (declared in `types.ts:56`, never wired). Cross-language oracles consume `OracleConfig.command` (in `config/schema.ts:14`, unused by runner). Multi-instance coordination is ECP over network instead of stdio. Phase 4's `AbstractPatternExport` becomes the serialization format for cross-instance knowledge sharing. Phase 5 fills gaps; it does not redesign.

```
Phase 5 Architecture Extension:

┌──────────────────────────────────────────────────────────────┐
│               Human Interface Layer (NEW)                    │
│  Terminal UI │ HTTP API │ Web Dashboard │ VS Code Extension  │
└──────────────────┬───────────────────────────────────────────┘
                   │
┌──────────────────▼───────────────────────────────────────────┐
│          Vinyan Orchestrator (unchanged core loop)           │
│  ┌──────────────────────────────────────────────────────┐    │
│  │ Perceive → Predict → Plan → Generate → Verify → Learn│    │
│  └──────────────────────────────────────────────────────┘    │
│  ┌────────────┐ ┌──────────────┐ ┌──────────────────────┐    │
│  │ Polyglot   │ │ Instance     │ │ Protocol Bridges     │    │
│  │ Oracle     │ │ Coordinator  │ │ MCP + A2A + ECP/Net  │    │
│  │ Framework  │ │ (Pillar 2)   │ │ (Pillar 1 + 2)       │    │
│  │ (Pillar 3) │ │              │ │                      │    │
│  └────────────┘ └──────────────┘ └──────────────────────┘    │
└──────────────────────────────────────────────────────────────┘
```

#### Axiom Compliance

| Axiom | Phase 5 Relevance |
|:------|:-----------------|
| A1 | Multi-instance: Instance A generates, Instance B verifies. Creativity Protection Zone: speculative-tier workers generate freely but never self-verify. |
| A2 | Network transport introduces new uncertainty (latency, partition). ECP `temporal_context` and `type: 'unknown'` become operationally critical. Worker abstention (GAP-H FC7) gains explicit cross-instance delegation protocol. |
| A3 | API server, web dashboard, VS Code extension are thin input adapters. All routing/verification/commit decisions remain in the rule-based Orchestrator. No UI-driven governance bypass. |
| A4 | Cross-instance fact sharing requires project-scoped content hashes. World Graph gains `instance_id` provenance without changing hash-invalidation. |
| A5 | Remote oracle verdicts carry lower trust than local deterministic oracles. Speculative-tier engine outputs carry lowest confidence. |
| A6 | API tasks have identical zero-trust constraints as CLI tasks. Session compaction preserves audit trail (I16). |
| A7 | Cross-instance trace sharing enables richer prediction error. Session-level compaction feeds Sleep Cycle with compressed episode summaries. |

#### Readiness Gate

| Gate | Threshold | Source |
|:-----|:----------|:-------|
| Phase 4 acceptance criteria | All met | Phase 4 validation |
| Worker differentiation | ≥ 2 workers with statistically different Wilson LB profiles | `WorkerStore.findActive()` + `CapabilityModel` |
| Pattern abstraction functional | ≥ 5 `AbstractPattern` exported | `PatternStore` query |
| Total traces | ≥ 2000 | `TraceStore.count()` |
| Sleep cycles completed | ≥ 30 | `PatternStore.countCycleRuns()` |

#### Pre-Phase Cleanup (PH5.0) `[S]`

Before any Phase 5 sub-component, fix Phase 4 wiring gaps that affect Phase 5 foundations:

1. **Wire `fleet:convergence_warning` emission.** Event declared in `bus.ts` but never emitted. Add in `fleet-evaluator.ts` or `sleep-cycle.ts` when `diversityScore > 0.7` (Gini threshold). [A3: governance transparency] **Status: OPEN**
2. ~~**Complete audit listener event coverage.**~~ ✅ **Resolved by Phase 4.5 WP-5** — `ALL_EVENTS` in `audit-listener.ts` now covers all 62 events including Phase 4 fleet/commit events.
3. ~~**Wire `oracleFailurePattern` fingerprint dimension.**~~ ✅ **Resolved by Phase 4.5 WP-5** — `core-loop.ts:424` computes oracle failure pattern from failed oracle names. `task-fingerprint.ts` wired.
4. **Add `AbstractPatternExport.version` migration support.** Currently hardcoded `version: 1` in `pattern-abstraction.ts`. Add version validation + migration hook in `importPatterns()` for format evolution required by PH5.9. [Forward compatibility] **Status: OPEN**

---

#### Pillar 1: Standalone System

> **Goal:** Vinyan operates as a fully independent platform. Multiple human interfaces converge on the same Orchestrator core loop.

##### PH5.1 — API Server `[L]`

> **Interface contracts:** [vinyan-tdd.md §22](vinyan-tdd.md) specifies API endpoints, session manager interface, compaction algorithm, checkpoint recovery, and acceptance criteria.

**Purpose:** HTTP API accepting tasks, streaming progress, returning results. Foundation for all external interfaces. Includes session management with compaction and checkpoint recovery.

**Axiom justification:** A3 (API is thin adapter, Orchestrator governs), A6 (API tasks have zero-trust constraints), A7 (session compaction feeds Sleep Cycle)

**Key concepts to design:**

- **Task lifecycle over HTTP.** `executeTask()` (in `core-loop.ts`) returns `Promise<TaskResult>`. API needs: (1) sync execution (POST, wait), (2) async submission (POST → task ID → poll/subscribe), (3) progress streaming via SSE filtered by `taskId`. Reuses audit listener's `{ ts, event, payload }` JSONL format (`bus/audit-listener.ts`).
- **Session management with compaction.** Group multiple `TaskInput` submissions under a session. Session state includes shared `WorkingMemory`, cumulative trace history, and a **compaction pipeline**: after N tasks or M minutes, summarize the session transcript into a condensed episode (approach sequences, key failures, successful patterns). Compacted sessions feed Sleep Cycle as first-class input. [Closes GAP-3: session management]
- **Checkpoint recovery.** Persist session state and in-progress task state to SQLite (new `session_store` table following `WorkerStore` pattern from `db/worker-store.ts`). On restart, recover pending tasks and resume from last checkpoint. [Closes GAP-H FC6: "restarted randomly"]
- **Health and metrics.** Expose `SystemMetrics` (from `observability/metrics.ts`) and `FleetMetrics` (from `fleet-evaluator.ts`) via read-only HTTP endpoints.
- **Graceful shutdown.** `stop()` method drains in-flight requests (30s deadline), persists active sessions to SQLite, disconnects VIIP peers, then closes resources. See [vinyan-tdd.md §22.7](vinyan-tdd.md) for full shutdown protocol. `SIGTERM`/`SIGINT` handlers trigger graceful shutdown; second signal forces immediate exit.

**Extends:** `TaskInput.source: 'api'` (types.ts:56), `Orchestrator` interface (factory.ts), `WorkingMemory` (working-memory.ts)
**New files:** `src/api/server.ts`, `src/api/routes.ts`, `src/api/session-manager.ts`, `src/db/session-schema.ts`, `src/db/session-store.ts`
**Dependencies:** Phase 1 (core loop), Phase 2 (EventBus)

**Open questions:**
- Bun.serve() (zero-dep) vs. Hono (routing + middleware)
- WebSocket vs SSE for event streaming — reconnection tradeoffs
- Session compaction trigger: task count, time, or token budget
- Whether compacted summaries are LLM-generated or rule-based extraction
- API versioning (URL prefix vs. header)

##### PH5.2 — Terminal UI `[M]`

**Purpose:** Interactive terminal interface replacing minimal `vinyan run`. Real-time visibility into Orchestrator state, bus events, worker progress.

**Axiom justification:** A3 (read-only projection — no governance bypass)

**Key concepts to design:**

- **Bus event rendering.** Subscribe to `VinyanBus` and render all 39+ event types: task lifecycle (progress), worker dispatch/complete (status), oracle verdicts (pass/fail), fleet events (convergence warnings, demotions), evolution (rule promotion). Same event stream as API SSE endpoint.
- **JSONL audit replay.** Parse audit JSONL files (`audit-listener.ts` format) for post-mortem debugging. Same rendering pipeline as live events. [Partial observability replay — GAP-5]
- **Observability dashboard.** Render `SystemMetrics`, `EvolutionMetrics`, `FleetMetrics` in structured panels.
- **Interactive commands.** Submit task, cancel task, inspect trace, view worker profiles, trigger sleep cycle, export patterns.

**Extends:** `VinyanBusEvents` (bus.ts), audit JSONL format (audit-listener.ts)
**Dependencies:** PH5.1 (shared session/task management)

**Open questions:**
- TUI framework (Ink/React-terminal vs. blessed-like vs. raw ANSI)
- Separate process connecting to API vs. in-process with Orchestrator
- Layout (panels vs. scrolling log)

##### PH5.3 — Web Dashboard `[M]`

**Purpose:** Browser-based monitoring and task management interface. Covers "Web Dashboard" declared in architecture.md's Human Interface Layer diagram.

**Axiom justification:** A3 (pure client of API server — no direct Orchestrator access), A6 (dashboard proposes, Orchestrator disposes)

**Key concepts to design:**

- **API client.** Communicates exclusively with PH5.1 API server. Zero Orchestrator logic, zero SQLite access.
- **Real-time event stream.** SSE/WebSocket from PH5.1 renders bus events as live feed. Filterable by category (task, worker, oracle, fleet, evolution).
- **Fleet visualization.** Worker profiles, capability heatmap (from `CapabilityModel`), Gini diversity gauge (from `FleetMetrics`), worker lifecycle state machine view.
- **Trace explorer.** Browse `ExecutionTrace` history with filters (task type, worker, outcome, routing level). Drill into `PredictionError` (A7 visualization).
- **Session history.** View compacted session summaries from PH5.1 session manager. Replay session events.

**Extends:** API endpoints from PH5.1, `SystemMetrics` and `FleetMetrics` types
**Dependencies:** PH5.1 (API Server)

**Open questions:**
- Frontend framework (vanilla + SSE, or React/Preact for richer UX)
- Whether bundled with Vinyan or deployed separately
- Authentication model alignment with PH5.14

##### PH5.4 — VS Code Extension `[L]`

**Purpose:** Editor integration with contextual task submission, inline oracle verdicts, diagnostic overlays.

**Axiom justification:** A6 (extension proposes; Orchestrator disposes), A4 (inline fact validity via content hash)

**Key concepts to design:**

- **API client.** Communicates with PH5.1 via HTTP/WebSocket. Thin client — no Orchestrator logic, no SQLite access.
- **Contextual `TaskInput`.** Pre-populates `targetFiles` from editor file, `constraints` from active diagnostics, `source: 'api'`.
- **Oracle verdict overlay.** Map `OracleVerdict.evidence` (file + line + snippet) to VS Code `Diagnostic` positions. Display as inline annotations and gutter icons.
- **World Graph sidebar.** Verified facts for current file. Highlight stale facts (content hash mismatch). Makes A4 tangible.
- **Event stream panel.** Bus events in VS Code output channel, same format as TUI (PH5.2).

**Extends:** `TaskInput` (types.ts), `OracleVerdict` (core/types.ts), `Fact` (core/types.ts)
**Dependencies:** PH5.1 (API Server)

**Open questions:**
- Minimum VS Code version target
- Webview panels vs. native tree views
- Auto-start bundled server vs. connect to running instance
- LSP integration depth

##### PH5.5 — MCP Bridge `[M]`

**Purpose:** Implement MCP Client Bridge and MCP Server from TDD §19 (specified but never built). Vinyan consumes external MCP tools and exposes oracles to other agents.

**Axiom justification:** A5 (MCP tool results enter as `probabilistic` tier), A1 (external tools generate, local oracles verify)

**Key concepts to design:**

- **MCPClientBridge.** Connects to external MCP servers (stdio/HTTP per `MCPServerConfig.transport`), discovers tools, executes, wraps results as ECP evidence with confidence from `trustLevel` (`untrusted: 0.3`, `semi-trusted: 0.5`, `trusted: 0.7` — TDD §19.1).
- **MCPServer.** Exposes 4 oracle tools: `vinyan_ast_verify`, `vinyan_type_check`, `vinyan_blast_radius`, `vinyan_query_facts` (TDD §19.2). Other agents invoke Vinyan verification.
- **ECP-to-MCP translation.** Bidirectional mapping per TDD §19.3. `type: 'unknown'` → MCP: `{ verified: null, reason: "insufficient evidence" }`.

**Extends:** Oracle runner (`oracle/runner.ts`), tool execution layer (`orchestrator/tools/`)
**Dependencies:** Phase 0 oracle framework

**Open questions:**
- MCP SDK choice (@modelcontextprotocol/sdk vs. custom)
- Server lifecycle management
- Whether MCP server exposes additional tools beyond TDD's 4

##### PH5.6 — A2A Protocol Bridge `[M]`

**Purpose:** Implement the A2A (Agent-to-Agent) external interface channel declared in concept.md §2.1 and TDD §3. Enables interoperability with A2A-compatible agents (Google, Salesforce ecosystem).

**Axiom justification:** A2 (A2A lacks epistemic semantics — bridge injects uncertainty for all A2A-sourced inputs), A5 (A2A results enter as `probabilistic` tier, never `deterministic`)

**Key concepts to design:**

- **Agent Card.** Serve `.well-known/agent.json` declaring Vinyan capabilities: oracle types, supported languages, domain specialization, capacity. Maps from `listOracles()` (`oracle/registry.ts`) and `WorkerStore.countActive()`.
- **Task lifecycle mapping.** Map A2A `tasks/send` + `tasks/get` to `TaskInput` → `executeTask()` → `TaskResult`. A2A artifacts map to `TaskResult.mutations`. A2A streaming maps to bus event SSE projection.
- **Confidence injection.** All A2A-sourced task results enter with `confidence: 0.5` ceiling and `basis: 'probabilistic'`. A2A cannot trigger `type: 'deterministic'` evidence.
- **Discovery consumer.** Query remote agents' `.well-known/agent.json` for capability discovery. Used by PH5.8 Instance Coordinator for peer discovery.

**Extends:** `TaskInput.source` (add `'a2a'` variant in types.ts:56), API server (PH5.1)
**Dependencies:** PH5.1 (API Server), PH5.14 (Security Model)

**Open questions:**
- A2A SDK vs. custom HTTP/JSON-RPC implementation
- Scope: minimal bridge (task submit/receive) vs. full A2A v1.0 spec compliance
- Whether A2A bridge runs as separate process or integrated with API server
- Push notification support vs. poll-only

---

#### Pillar 2: Multi-Instance Coordination

> **Goal:** Multiple Vinyan instances act as peer Reasoning Engines via ECP over network, sharing verified knowledge and coordinating on cross-domain tasks.

##### PH5.7 — ECP Network Transport `[L]`

> **Design prerequisite:** [vinyan-a2a-protocol.md](vinyan-a2a-protocol.md) specifies the full wire protocol (VIIP), message envelope, delivery guarantees, and failure modes. [vinyan-concept.md §2.4](vinyan-concept.md) specifies network-aware ECP semantics and confidence degradation.

**Purpose:** Extend ECP from stdio (local process) to network boundaries. Preserves epistemic semantics (confidence, evidence chains, falsifiability, temporal context) across the network — no existing protocol does this natively.

**Axiom justification:** A2 (`temporal_context` mandatory for all cross-instance messages), A5 (remote verdicts always lower tier than local)

**Key concepts (now fully specified):**

- **Transport abstraction.** New `ECPTransport` interface: `send(message: ECPMessage): Promise<void>`, `onMessage(handler): void`. Implementations: `StdioTransport` (existing runner behavior), `NetworkTransport` (new). Oracle runner (`oracle/runner.ts`) becomes transport-agnostic.
- **Temporal context enforcement.** `temporal_context` (concept §13.2) becomes required on all cross-instance ECP messages. Receiving Orchestrator checks `valid_until` before trusting remote evidence. Stale evidence auto-degrades to `type: 'unknown'`.
- **`deliberation_request` support.** Implement concept §13.1: engines signal insufficient reasoning depth and request additional compute. Maps to routing level escalation in the receiving instance.
- **Instance discovery.** Static config (Phase 5 default) + `.well-known/vinyan.json` endpoint (concept §11.2). Declares oracle set, language coverage, domain tags, health, capacity.
- **Protocol versioning.** Extend `ECP_PROTOCOL_VERSION` (types.ts:24, currently `1`) with negotiation handshake per VIIP §2.3.

**Extends:** `oracle/runner.ts` (transport abstraction), `OracleConfig.command` (config/schema.ts:14), `ECP_PROTOCOL_VERSION` (types.ts:24)
**Dependencies:** PH5.14 (Security — mTLS/signing), PH5.1 (shares HTTP/WebSocket infra)

**Design decisions resolved (from gap analysis):**
- Wire protocol: **WebSocket** (persistent, bidirectional) with HTTP/2 SSE fallback (VIIP §2.1)
- Serialization: **JSON** (readable, debuggable) — optimize to MessagePack only if profiling shows bottleneck
- Auth: **Ed25519 message signatures** + optional mTLS (VIIP §4)
- Message ordering: **Causal per-instance** (UUIDv7 time-sortable), no global ordering (VIIP §6.2)
- Delivery: **At-least-once with idempotency** — 10K message dedup window (VIIP §6.1)

##### PH5.8 — Instance Coordinator `[XL]` (Research)

> **Design prerequisites:** [vinyan-a2a-protocol.md](vinyan-a2a-protocol.md) (wire protocol), [vinyan-concept.md §11](vinyan-concept.md) (coordination topology, partition tolerance), [vinyan-tdd.md §23](vinyan-tdd.md) (coordinator interface, state machine, acceptance criteria).

**Purpose:** Multiple Vinyan instances coordinate as peers. Each instance's Orchestrator remains sovereign. Includes Oracle/Verifier lifecycle governance (concept §13.4) and Creativity Protection Zone (concept §13.5).

**Axiom justification:** A3 (coordination is advisory, not mandatory), A1 (cross-instance: A generates, B verifies), A6 (delegated results re-verified locally)

**Key concepts to design:**

- **Peer topology.** No super-orchestrator. Coordination advisory: shared knowledge, optional delegation. `OrchestratorDeps` (core-loop.ts) gains optional `instanceCoordinator` field.
- **Task delegation.** Instance encountering out-of-domain task delegates via ECP. Delegating instance re-verifies result locally (A6). Message carries `TaskInput` + `PerceptualHierarchy` + `TaskFingerprint`.
- **Cross-instance verification.** Instance A sends `HypothesisTuple` to Instance B for oracle Instance A lacks. Remote `OracleVerdict` carries confidence capped at 0.95 (I13). Runner dispatches via `NetworkTransport` instead of `Bun.spawn()`.
- **Oracle/Verifier lifecycle governance.** Concept §13.4 deferred to Phase 5. Implement using Phase 4's `WorkerLifecycle` pattern (`worker-lifecycle.ts`): oracle instances get `OracleProfile` records with `probation → active → demoted → retired` state machine. Demotion triggers: false positive rate > threshold, systematic timeout, contradiction rate > threshold.
- **Creativity Protection Zone.** Concept §13.5: reserve exploration budget for speculative-tier workers. Extend Phase 4's epsilon-greedy (`explorationEpsilon` in core-loop.ts) with `speculative` tier (already in `OracleConfig.tier` at config/schema.ts:17). Speculative workers execute only in sandbox (L2+ isolation), require full verification before commit, feed Sleep Cycle. [Safety invariant I17]
- **Shared event forwarding.** Subset of bus events forwarded to peers: `sleep:cycleComplete`, `evolution:rulePromoted`, `skill:outcome`. NOT `worker:dispatch` or `trace:record`. Configurable filter.
- **Conflict resolution.** Cross-instance contradictions resolved by: (1) domain authority, (2) evidence tier (A5), (3) recency (`temporal_context`). Deterministic rules (A3).

**Extends:** `OrchestratorDeps` (core-loop.ts), `WorkerLifecycle` pattern (worker-lifecycle.ts), `OracleConfig.tier` (config/schema.ts:17)
**New files:** `src/orchestrator/instance-coordinator.ts`, `src/db/oracle-profile-schema.ts`, `src/db/oracle-profile-store.ts`
**Dependencies:** PH5.7 (ECP Network Transport), PH5.1 (API Server)

**Open questions:**
- Maximum peer instance count
- Delegation: fire-and-forget vs. blocking
- Instance specialization: manual config vs. inferred from registry + traces
- Cross-instance traces counting toward local data gates
- Consensus for shared rule promotion

##### PH5.9 — Cross-Instance Knowledge Sharing `[M]` (Research)

**Purpose:** Automated sharing of rules, patterns, skills, Self-Model parameters across instances. Distributed extension of PH4.6 pattern abstraction.

**Axiom justification:** A7 (cross-instance prediction error accelerates learning), A5 (imported knowledge enters probation — lower trust until locally validated)

**Key concepts to design:**

- **Knowledge export.** During Sleep Cycle, identify sharing candidates: rules (effectiveness > threshold), skills (high success rate), patterns (low project-specificity from `projectSimilarity()` Jaccard score in `pattern-abstraction.ts`). Format: `AbstractPatternExport` with protocol version negotiation (PH5.7).
- **Knowledge import pipeline.** Enters local probation. Confidence reduced 50% (same as PH4.6 `importPatterns()`). `AbstractPatternExport.version` checked; migration applied if mismatch.
- **Self-Model parameter sharing.** Instance A's calibrated EMA parameters warm-start Instance B (`basis: 'hybrid'`). Enters hybrid state until local traces corroborate.
- **Multi-instance `WorkerProfile` sharing.** When instances share the same `WorkerConfig.modelId`, capability scores from one bootstrap another's `WorkerSelector`. Shared profiles enter with reduced Wilson LB confidence.
- **Provenance chain.** Source `instance_id`, original IDs, transformation history, local probation status. Enables audit and rollback.

**Extends:** `AbstractPatternExport` (pattern-abstraction.ts), `importPatterns()` (pattern-abstraction.ts), `WorkerStore` (db/worker-store.ts), `CalibratedSelfModel` (self-model.ts)
**Dependencies:** PH5.7 (ECP Network Transport), PH5.8 (Instance Coordinator)

**Open questions:**
- Export frequency: every Sleep Cycle or demand-driven
- Push (broadcast) vs. pull (request) vs. hybrid
- Handling divergence: rule promotes on A, retires on B
- Privacy boundaries: opt-out per knowledge category
- Volume management: cap on incoming probation pipeline

---

#### Pillar 3: Cross-Language Support

> **Goal:** Extend oracle framework from TypeScript-only to Python, Go, Rust. Oracle runner is already transport-agnostic by design (stdin/stdout JSON); only implementations are language-specific.

##### PH5.10 — Polyglot Oracle Framework `[M]`

**Purpose:** Generalize oracle runner so `OracleConfig.command` (exists in `config/schema.ts:14`, unused by runner) activates polyglot oracles.

**Axiom justification:** A1 (cross-language verification maintains generation ≠ verification), A4 (content-addressed truth regardless of language)

**Key concepts to design:**

- **Runner generalization.** `oracle/runner.ts:41` hardcodes `Bun.spawn(["bun", "run", oraclePath])`. When `OracleConfig.command` is set, use that command instead. Example: `{ command: "python -m vinyan_pyright_oracle" }`. Contract unchanged: stdin `HypothesisTuple` → stdout `OracleVerdict`.
- **Dynamic oracle registration.** `oracle/registry.ts` has static `ORACLE_PATHS` (5 entries). Add `registerOracle(name, config)` for runtime registration with `command`, `languages`, `tier`.
- **Language detection.** Auto-detect from project files: `package.json` = TypeScript, `pyproject.toml` = Python, `go.mod` = Go, `Cargo.toml` = Rust. Maps to `OracleConfig.languages` (config/schema.ts:13).
- **Shared infrastructure.** All language oracles share circuit breaker (`oracle/circuit-breaker.ts`), timeout handling, Zod validation (`oracle/protocol.ts`). No per-language changes.

**Extends:** `oracle/runner.ts` (line 41), `oracle/registry.ts` (add dynamic registration), `OracleConfig` (config/schema.ts)
**Dependencies:** Phase 0 oracle framework

**Open questions:**
- Language detection: automatic vs. config-only
- Oracle distribution format: standalone binary, pip package, Docker image
- Multi-language projects: parallel oracle invocation strategy
- P99 latency targets per language oracle

**CI test strategy for cross-language oracles:**
- Each language oracle ships with a `test/` directory containing ≥30 test cases per language (type errors, valid code, edge cases)
- CI matrix: install language runtimes via GitHub Actions setup actions (`setup-python`, `setup-go`, `actions-rs/toolchain`)
- Oracle tests run in isolation via `oracle/runner.ts` — same stdin/stdout JSON contract, no framework-specific test harness needed
- Smoke test: each language oracle must pass `HypothesisTuple → OracleVerdict` round-trip in < 5s on CI runner
- Fallback: if a language runtime is unavailable in CI, skip that oracle's tests with clear warning (not a hard failure)

**Benchmark harness:**
- Benchmark suite in `tests/benchmarks/` — measures oracle latency, task throughput, Sleep Cycle duration
- Key benchmarks: (1) oracle round-trip per language (p50, p95, p99), (2) full task cycle (perceive → verify → learn), (3) DAG parallel execution throughput
- Run via `bun test tests/benchmarks/ --timeout 120000` — not part of default `bun test` (opt-in via CI flag)
- Baseline results committed to `tests/benchmarks/baseline.json` — CI compares against baseline, warns on >20% regression

##### PH5.11 — Python Oracle (Pyright) `[M]`

**Purpose:** First non-TypeScript oracle. Proves polyglot framework works.

**Key concepts to design:**

- **Oracle scope.** Mirror TypeScript type oracle: type checking (`pyright --outputjson`), symbol existence, import validation. Map Pyright JSON output to `OracleVerdict` format.
- **Python-specific patterns.** `"function-signature"`, `"import-exists"`, `"type-check"`, `"class-inherits"`. Account for decorators, metaclasses, dynamic attributes.
- **Virtual environment handling.** Respect `pyrightconfig.json` or `pyproject.toml` for Python interpreter and type stubs.

**Extends:** PH5.10 framework, `HypothesisTuple.pattern` vocabulary
**Dependencies:** PH5.10

**Open questions:**
- Oracle binary in Python (natural) or TypeScript (consistent)
- Pyright version pinning
- Handling unannotated code (strict vs. basic mode)

##### PH5.12 — Go Oracle (gopls) `[M]`

**Purpose:** Go-specific oracle for type checking, interface satisfaction, import verification.

**Key concepts to design:**

- **Oracle scope.** `go vet` + `go build -o /dev/null` for type checking. Go-specific patterns: `"interface-satisfies"`, `"goroutine-safety"`, `"module-tidy"`.
- **CLI vs. LSP.** CLI (`go vet` + `go build`) is simpler, matches subprocess model. gopls (LSP) provides richer diagnostics. Implementor evaluates both.

**Extends:** PH5.10 framework
**Dependencies:** PH5.10

**Open questions:**
- CLI vs. LSP approach
- Oracle binary in Go (single binary, fast startup) or TypeScript
- Race detector: deterministic or heuristic tier?

##### PH5.13 — Rust Oracle (rust-analyzer) `[M]`

**Purpose:** Rust-specific oracle for type checking, borrow checker, trait validation.

**Key concepts to design:**

- **Oracle scope.** `cargo check --message-format=json` maps directly to `OracleVerdict`. Patterns: `"borrow-check"`, `"lifetime-valid"`, `"trait-satisfies"`, `"unsafe-audit"`. Incremental compilation makes repeated checks fast.

**Extends:** PH5.10 framework
**Dependencies:** PH5.10

**Open questions:**
- `cargo check` (simple) vs. rust-analyzer LSP (richer)
- Oracle binary in Rust (zero-dep) or TypeScript
- Unsafe block detection as separate oracle or integrated

---

#### Cross-Cutting Concerns

##### PH5.14 — Security Model `[M]` — **TIER 0 PREREQUISITE**

> **HIGH (G5-012):** This component is now Tier 0 — must precede any network exposure (PH5.1 API, PH5.6 A2A, PH5.7 ECP Network). See [vinyan-a2a-protocol.md §4](vinyan-a2a-protocol.md) for inter-instance authentication.

**Purpose:** Security model for API server, multi-instance communication, remote oracle invocation.

**Axiom justification:** A6 (no API bypass of oracle verification), A3 (auth decisions are rule-based)

**Key concepts to design:**

- **API authentication.** Local-only: bearer token in `~/.vinyan/api-token`. Multi-instance: mTLS.
- **Instance identity.** Ed25519 keypair per instance for signing cross-instance messages (generated on first run, stored in `~/.vinyan/instance-key.pem`). Cryptographic provenance verification.
- **Trust bootstrapping.** New remote instances start `untrusted`. Trust earned empirically (Wilson LB on remote verdict accuracy) — same mechanism as `WorkerLifecycle` (`worker-lifecycle.ts`). See [vinyan-a2a-protocol.md §4.4](vinyan-a2a-protocol.md) for trust levels and allowed operations.
- **Authorization scoping.** Granular: read-only (facts, metrics), task submission, admin (config, instance management). Extensible via config.
- **Guardrails extension.** Existing `src/guardrails/` (injection/bypass detection) applies to API inputs identically.

**Extends:** `src/guardrails/`, `WorkerLifecycle` trust pattern
**Dependencies:** Phase 0-4 (all existing infrastructure). **PH5.1 and PH5.7 depend on this.**

**Design decisions resolved:**
- Token format: opaque bearer token (simple, no JWT dependency). Generated via `crypto.randomBytes(32).toString('hex')`
- Instance identity: Ed25519 keypair (per vinyan-a2a-protocol.md §4.1)
- Audit logging: extends existing JSONL audit trail (`audit-listener.ts` format)

##### PH5.15 — Observability Extension `[M]`

**Purpose:** Extend observability for multi-interface, multi-instance context. Includes audit replay and GAP-H failure mode detection.

**Axiom justification:** A7 (distributed prediction error), A3 (observability is read-only)

**Key concepts to design:**

- **Distributed tracing.** Extend `ExecutionTrace` with `parentInstanceId?` and `delegatedFrom?`. Trace IDs propagate across instances.
- **Audit replay.** Formal replay: parse JSONL audit files, reconstruct event timeline, render in TUI or web dashboard. Cross-instance event correlation. [GAP-5: observability/debugging UI]
- **Fleet-level metrics.** Cross-instance aggregation: fleet throughput, per-instance health, delegation success rate, knowledge adoption rate.
- **FC4 "Forgot earlier context" detection.** Monitor Working Memory eviction rate (from `working-memory.ts`). Emit `memory:eviction_warning` when repeated evictions correlate with task failure.
- **FC9 "Withheld information" detection.** Track oracle verdict propagation to workers. If oracle results available but not in worker context, emit `context:verdict_omitted`.
- **FC11 "Mismatch think vs do" detection.** Compare Self-Model predictions against actual outcomes (`PredictionError` in types.ts). Surface systematic miscalibration via `selfmodel:systematic_miscalibration` event.

**Extends:** `ExecutionTrace` (types.ts), `MetricsCollector` (metrics.ts), `VinyanBusEvents` (bus.ts)
**Dependencies:** PH5.1 (API metrics), PH5.8 (Instance Coordinator)

**Telemetry export format:**
- **Primary:** Prometheus-compatible `/metrics` endpoint (text exposition format) — industry standard, zero-dependency scraping
- **Metrics exposed:** `vinyan_tasks_total` (counter), `vinyan_task_duration_seconds` (histogram), `vinyan_oracle_latency_seconds` (histogram by oracle type), `vinyan_rules_active` (gauge), `vinyan_skills_active` (gauge), `vinyan_sleep_cycles_total` (counter), `vinyan_self_model_calibration` (gauge per task type), `vinyan_fleet_workers` (gauge by status)
- **Labels:** `instance_id`, `task_type`, `oracle_type`, `worker_id` (where applicable)
- **Endpoint:** `GET /api/v1/metrics` — no auth required (read-only, non-sensitive counters)
- **Alternative:** JSON format available at `GET /api/v1/metrics?format=json` for programmatic consumption

**Open questions resolved:**
- ✅ OpenTelemetry vs custom: Prometheus exposition format (lightweight, no OTEL dependency). OTEL export can be added later via adapter
- ✅ Metrics export: Prometheus primary, JSON secondary (same endpoint, format query param)
- ✅ Alert delivery: bus event (`observability:alert`) — subscribers (webhook, log, CLI) handle delivery. No built-in webhook client

##### PH5.16 — Data Migration & Backward Compatibility `[S]` — **TIER 0 PREREQUISITE**

> **CRITICAL (G5-019):** This component is now Tier 0 — execute FIRST before any other Phase 5 work. All schema changes depend on versioned migrations. See [vinyan-tdd.md §20](vinyan-tdd.md) for full interface contracts and [vinyan-architecture.md D18](vinyan-architecture.md) for design rationale.

**Purpose:** Phase 0-4 installations upgrade without data loss or behavioral changes.

**Key concepts (fully specified in TDD §20):**

- **SQLite migration framework.** Replace `VinyanDB` constructor's `CREATE TABLE IF NOT EXISTS` pattern (`db/vinyan-db.ts`) with versioned migrations. New `schema_version` table tracks applied migrations. `ALTER TABLE ADD COLUMN` for new fields (additive only).
- **Configuration migration.** `vinyan.json` gains `phase5` namespace. Existing configs without `phase5` work unchanged. Migration strategy: **additive namespaces** — new Phase 5 keys are nested under `phase5.*`, old flat keys preserved as-is for backward compatibility. Config loader reads both old and new paths with new path taking precedence (e.g., `oracle.timeout` still works, `phase5.oracle.timeout` overrides). No automated config rewrite — users migrate at their own pace.
- **Feature activation.** Phase 5 features activate through existing `DataGate` (`data-gate.ts`). New gates: `multi_instance` (requires `instance_registry.count >= 2`), `polyglot_oracle` (requires language enabled). No silent activation.
- **API server opt-in.** Not started by default. Activates when `phase5.api.enabled = true`. CLI-only remains default.

**Extends:** `VinyanDB` (db/vinyan-db.ts), `VinyanConfigSchema` (config/schema.ts), `DataGateStats` + `FEATURE_CONDITIONS` (data-gate.ts)
**Dependencies:** Phase 0-4 (all existing infrastructure)

**Design decisions resolved:**
- Migration strategy: in-place ALTER TABLE (additive-only, per D18)
- Downgrade support: forward-only — no down migrations. Rollback = restore from backup
- Schema versioning approach: `schema_version` table with integer version + description (TDD §20.1)

---

#### Safety Invariants — Phase 5 Extensions

The 7 existing immutable invariants (I1-I7) plus 4 Phase 4 fleet invariants (I8-I11) remain unchanged. Phase 5 adds:

| # | Invariant | Enforcement |
|:--|:----------|:-----------|
| I12 | **No remote governance bypass.** No cross-instance message can bypass local oracle verification. A remote instance cannot instruct the local Orchestrator to skip verification, commit without checking, or override safety invariants. | `InstanceCoordinator` message validation (PH5.8) |
| I13 | **Remote verdict confidence ceiling.** Remote oracle verdicts always carry confidence < 0.95, regardless of the remote oracle's declared confidence. Only local deterministic oracles can produce confidence ≥ 0.95. | ECP Network Transport confidence adjustment (PH5.7) |
| I14 | **Cross-instance knowledge enters probation.** Shared rules, patterns, and skills always start at `status: 'probation'` regardless of their status on the source instance. No shortcut to `active` via cross-instance sharing. | Knowledge import pipeline (PH5.9) |
| I15 | **API authentication mandatory for mutations.** Read-only API endpoints (health, metrics, fact queries) may operate without authentication. Any endpoint that creates tasks, modifies configuration, or triggers actions requires authentication. | API server middleware (PH5.1, PH5.14) |
| I16 | **Session audit preservation.** Session compaction produces supplementary summaries only. The full JSONL audit trail for every task is never deleted or overwritten by compaction. Compacted summaries reference original audit file offsets. | Session manager write path (PH5.1) |
| I17 | **Speculative sandbox mandatory.** Speculative-tier worker outputs (`OracleConfig.tier: 'speculative'`) execute only in L2+ isolation. Full oracle verification required before any commit action. Speculative results never bypass the verification pipeline. | Creativity Protection Zone gate (PH5.8) |

#### Dependency Graph

```
Tier 0 — Prerequisites (execute first):
  PH5.16 (Migration Framework) ─── prerequisite for ALL Phase 5 schema changes
           │
  PH5.0  (Pre-Phase Cleanup) ───── prerequisite for all Phase 5 components
           │
  PH5.14 (Security Model) ──────── prerequisite for any network exposure
           │
           ▼
Tier 1 — Standalone Foundation:
  PH5.1 (API Server + Session) ─┬── PH5.2 (Terminal UI)
                                 ├── PH5.3 (Web Dashboard)
                                 ├── PH5.4 (VS Code Extension)
                                 ├── PH5.5 (MCP Bridge)
                                 └── PH5.6 (A2A Bridge)

Tier 2 — Multi-Instance (requires A2A protocol spec — vinyan-a2a-protocol.md):
  PH5.7 (ECP Network Transport) ── PH5.8 (Instance Coordinator)
                                            │
                                            └── PH5.9 (Knowledge Sharing)

Tier 3 — Cross-Language (independent of Tier 1/2):
  PH5.10 (Polyglot Framework) ─┬── PH5.11 (Python/Pyright)
                                ├── PH5.12 (Go/gopls)
                                └── PH5.13 (Rust/rust-analyzer)

Tier 4 — ECP Ecosystem (2026-04-01 addition):
  PH5.17 (Oracle SDK) — packages for TS + Python oracle development
  PH5.18 (ECP Network Transport) — WebSocket + HTTP transport abstraction
  PH5.19 (ECP Spec Publication) — formalize ECP as standalone spec

Cross-Cutting:
  PH5.15 (Observability Extension) — parallel with any component
```

##### PH5.17 — Oracle SDK Packages `[M]` (2026-04-01 addition)

**Purpose:** Publish SDK packages that make it trivial for external developers to build ECP-compatible Reasoning Engines. Lower the barrier to Level 0 ECP conformance to ~15 lines of code.

**Deliverables:**
- `@vinyan/oracle-sdk` (npm) — TypeScript SDK: `HypothesisTupleSchema`, `OracleVerdictSchema`, `buildVerdict()`, test utilities
- `vinyan-oracle-sdk` (PyPI) — Python SDK: Pydantic models mirroring Zod schemas, `build_verdict()`, test utilities
- `vinyan oracle test <name>` CLI command for manual oracle testing

**Key files:** New `packages/oracle-sdk-ts/`, `packages/oracle-sdk-python/`
**Extends:** `src/oracle/protocol.ts` (extract schemas), `src/core/index.ts` (extract `buildVerdict`)
**Dependencies:** ECP spec finalized ([vinyan-ecp-spec.md](vinyan-ecp-spec.md))
**Design guide:** [vinyan-oracle-sdk.md](vinyan-oracle-sdk.md)

---

##### PH5.18 — ECP Network Transport `[L]` (2026-04-01 addition)

**Purpose:** Implement the transport abstraction layer so `OracleRunner` becomes transport-agnostic. Foundation for remote oracles and cross-instance communication.

**Key work:**
1. Define `ECPTransport` interface: `verify(hypothesis, timeout) → verdict`, `close()`, `transportType`
2. Extract current `Bun.spawn()` logic into `StdioTransport` class
3. Implement `WebSocketTransport` (persistent connection, heartbeat, reconnection)
4. Implement `HttpTransport` (stateless POST `/ecp/v1/verify`)
5. Add transport resolution in runner: `entry.transport` → resolve to correct `ECPTransport` implementation
6. Add `transport?: "stdio" | "websocket" | "http"` and `endpoint?: string` to `OracleRegistryEntry`

**Key files:**
- Modify: `src/oracle/runner.ts` (transport resolution)
- Modify: `src/oracle/registry.ts` (transport + endpoint fields)
- New: `src/oracle/transport/types.ts`, `src/oracle/transport/stdio.ts`, `src/oracle/transport/websocket.ts`, `src/oracle/transport/http.ts`

**Dependencies:** PH5.14 (Security — Ed25519 signing for network messages)
**Design spec:** [vinyan-ecp-spec.md](vinyan-ecp-spec.md) §5, [vinyan-protocol-architecture.md](vinyan-protocol-architecture.md) §2-§3

---

##### PH5.19 — ECP Specification Publication `[S]` (2026-04-01 addition)

**Purpose:** Formalize ECP as a standalone, publishable protocol specification. External developers and projects can implement ECP without depending on Vinyan source code.

**Deliverables:**
- Finalize [vinyan-ecp-spec.md](vinyan-ecp-spec.md) with community review
- Publish ECP conformance test suite (Level 0–3 validation)
- Add ECP version negotiation to `src/core/types.ts`

**Dependencies:** PH5.17 (Oracle SDK validates spec is implementable), PH5.18 (network transport validates spec §5)

---

**Execution order (dependency DAG) — Updated 2026-04-01:**
1. **PH5.16** → PH5.0 → PH5.14 (sequential — migration before cleanup before security)
2. **PH5.18** (ECP Transport, requires PH5.14) — foundation for remote oracles
3. **PH5.1** (requires PH5.14 for auth) → PH5.2 + PH5.3 + PH5.4 + PH5.5 + PH5.6 (parallel)
4. **PH5.17** (Oracle SDK, parallel with PH5.1)
5. **PH5.7** (requires PH5.18 for transport) → PH5.8 → PH5.9 (sequential — critical path)
6. **PH5.10** → PH5.11 + PH5.12 + PH5.13 (parallel, fully independent)
7. **PH5.19** (ECP Spec, requires PH5.17 + PH5.18 to validate)

**Key ordering changes (2026-04-01):**
- PH5.18 (ECP Transport) inserted as **Tier 1** prerequisite — transport abstraction is the foundation for everything
- PH5.17 (Oracle SDK) runs parallel with PH5.1 — independent deliverable
- PH5.19 (ECP Spec) is the final deliverable — validates that the spec is implementable

**Key ordering fixes (from gap analysis):**
- PH5.16 (Migration) moved from last to **first** — all schema changes depend on versioned migrations (G5-019 CRITICAL)
- PH5.14 (Security) moved from cross-cutting to **Tier 0** — must precede any network exposure (G5-012 HIGH)
- PH5.7/PH5.8 now reference [vinyan-a2a-protocol.md](vinyan-a2a-protocol.md) as design prerequisite (G5-001 CRITICAL)

#### Data Prerequisites

Phase 5 multi-instance features are only valuable with sufficient single-instance maturity:

| Prerequisite | Minimum | Ideal | Source |
|:-------------|:--------|:------|:-------|
| Total execution traces | 2000 | 5000+ | TraceStore.count() |
| Distinct task type signatures | 20 | 40+ | PH3.1 improved signatures |
| Active evolution rules | 10 | 25+ | RuleStore.countActive() |
| Worker profiles with distinct stats | 3 | 5+ | Phase 4 WorkerProfileStore |
| Patterns successfully abstracted | 5 | 15+ | PH4.6 AbstractPattern count |
| Sleep cycles completed | 30 | 50+ | PatternStore.countCycleRuns() |
| Self-Model accuracy >80% | 10 task types | 15+ | PH3.2 adaptive EMA |

**Critical gap:** Single-instance must be production-proven before multi-instance coordination adds value. Pillar 1 (Standalone) and Pillar 3 (Cross-Language) can proceed independently of this data requirement.

#### Phase 5 Acceptance Criteria

| # | Criterion | Target | Measurement |
|:--|:----------|:-------|:-----------|
| AC1 | PH5.0 cleanup complete | All 4 wiring gaps resolved, zero regression | `bun test` pass + `tsc --noEmit` clean |
| AC2 | API server operational | Tasks submitted via HTTP produce identical results to CLI | Comparison test: same 50 tasks via CLI vs API |
| AC3 | Session compaction functional | Compacted summaries produced, full audit preserved (I16) | Session with 20+ tasks compacts without audit data loss |
| AC4 | Terminal UI renders all event types | All 39+ bus event types rendered without crash | Manual review during 100-task run |
| AC5 | Web dashboard operational | Fleet visualization, trace explorer, session replay functional | Browser test against running API server |
| AC6 | VS Code extension functional | Task submission, verdict overlay, fact display working | Extension integration test suite |
| AC7 | MCP bridge bidirectional | Vinyan consumes external MCP tool AND exposes oracles to external client | Integration test with reference MCP server/client |
| AC8 | A2A bridge operational | Agent Card served, task submit/receive works, confidence ceiling enforced | A2A interop test with reference agent |
| AC9 | Cross-instance delegation | Instance A delegates task to Instance B, receives verified result | End-to-end test with 2 instances |
| AC10 | Cross-instance knowledge sharing | Rule promoted on Instance A enters probation on Instance B (I14) | Automated test across instance boundary |
| AC11 | Python oracle verification | Pyright-based oracle catches type errors in Python code | 30 Python hypothesis test cases |
| AC12 | Go oracle verification | Go oracle catches type/import errors | 30 Go hypothesis test cases |
| AC13 | Rust oracle verification | Rust oracle catches borrow/type errors | 30 Rust hypothesis test cases |
| AC14 | Security: no unauthenticated mutations | API mutation endpoints reject unauthenticated requests (I15) | Security test suite |
| AC15 | Backward compatibility | Phase 4 installation upgrades to Phase 5 with zero data loss | Migration test on existing `.vinyan/vinyan.db` |
| AC16 | Safety invariant violations | Zero I12-I17 violations across all Phase 5 components | Audit log review + invariant test suite |

#### GAP-H Failure Mode Coverage

Phase 5 addresses 5 of the 14 failure modes identified in the GAP-H analysis (gap-analysis.md):

| Failure Mode | Component | Detection Mechanism |
|:-------------|:----------|:-------------------|
| FC4 "Forgot earlier context" | PH5.15 | `memory:eviction_warning` event when Working Memory eviction correlates with task failure |
| FC6 "Restarted randomly" | PH5.1 | Checkpoint recovery: session + task state persisted to SQLite, resumed on restart |
| FC7 "Abstained from answering" | PH5.8 | Cross-instance delegation protocol: worker abstention triggers delegation to peer with matching capability |
| FC9 "Withheld information" | PH5.15 | `context:verdict_omitted` event when oracle results available but not propagated to worker context |
| FC11 "Mismatch think vs do" | PH5.15 | `selfmodel:systematic_miscalibration` event when PredictionError shows systematic bias over sliding window |

**Not addressed in Phase 5:** FC1 (hallucination — requires LLM-level intervention), FC2 (sycophancy), FC3 (wrong but confident — partially mitigated by A2/A5), FC5 (ignored instructions), FC8 (perseverated), FC10 (premature disengagement), FC12 (inconsistency over time), FC13 (wrong self-assessment — partially by A7), FC14 (planning failure — deferred beyond Phase 5).

#### Key Design Decisions (Open)

1. **API framework.** Bun.serve() (zero-dependency) vs. Hono (routing + middleware). Affects PH5.1.
2. **ECP network wire format.** JSON-RPC 2.0 + epistemic headers vs. custom binary protocol. Affects PH5.7.
3. **Instance discovery.** Static config (simple, requires manual setup) vs. dynamic discovery (complex, zero-config). Affects PH5.7-PH5.8.
4. **Oracle binary language.** Each language oracle implemented in its own language (natural, diverse toolchain) vs. all in TypeScript (consistent, single toolchain). Affects PH5.11-PH5.13.
5. **VS Code extension bundling.** Standalone (requires running server) vs. self-contained (bundles server, auto-starts). Affects PH5.4.
6. **Multi-instance topology.** Flat peer mesh vs. hierarchical (domain coordinators). Affects PH5.8.
7. **Knowledge sharing model.** Push (broadcast) vs. pull (request) vs. hybrid. Affects PH5.9.
8. **A2A scope.** Minimal bridge (task submit/receive only) vs. full A2A v1.0 spec compliance. Affects PH5.6.
9. **Web dashboard tech.** Vanilla HTML + SSE (zero-dep) vs. React/Preact (richer UX). Affects PH5.3.
10. **Session compaction method.** LLM-generated summaries (richer) vs. rule-based extraction (deterministic, A3-compliant). Affects PH5.1.

#### Configuration Schema Extension

Add `phase5` namespace to `VinyanConfigSchema` (in `src/config/schema.ts`):

```
phase5:
  api:
    enabled: boolean              // default: false
    port: number                  // default: 3927
    bind_address: string          // default: "127.0.0.1" (local only)
    auth_required: boolean        // default: true for mutation endpoints
    session_compaction_threshold: number  // default: 20 (tasks per session before compaction)

  instances:
    enabled: boolean              // default: false
    instance_id: string           // auto-generated UUID on first run
    discovery_endpoint: string    // default: "" (static config only)
    peers: Array<{
      url: string
      trust_level: string         // "untrusted" | "semi-trusted" | "trusted"
    }>
    knowledge_sharing: boolean    // default: false
    delegation_enabled: boolean   // default: false

  creativity:
    speculative_budget_pct: number  // default: 0.10 (10% of tasks)
    min_isolation_level: number     // default: 2 (L2+)
    sandbox_timeout_ms: number      // default: 120000

  polyglot:
    language_detection: string    // "auto" | "config"
    enabled_languages: string[]   // default: ["typescript"]
```

#### Bus Events Extension

New events added to `VinyanBusEvents`:

```
// API server (PH5.1)
"api:request"                  — { method, path, taskId?, sessionId? }
"api:response"                 — { taskId, status, duration_ms }
"session:created"              — { sessionId, source }
"session:compacted"            — { sessionId, taskCount, compactedSize }
"session:recovered"            — { sessionId, pendingTasks }

// A2A bridge (PH5.6)
"a2a:agent_discovered"         — { agentUrl, capabilities[] }
"a2a:task_received"            — { taskId, fromAgent }
"a2a:task_delegated"           — { taskId, toAgent }
"a2a:confidence_capped"        — { taskId, originalConfidence, cappedConfidence }

// Instance coordination (PH5.8)
"instance:connected"           — { peerId, capabilities[] }
"instance:disconnected"        — { peerId, reason }
"instance:delegated"           — { taskId, toPeerId, reason }
"instance:delegation_complete" — { taskId, fromPeerId, success }

// Knowledge sharing (PH5.9)
"knowledge:exported"           — { type, count, toPeerId }
"knowledge:imported"           — { type, count, fromPeerId }
"knowledge:rejected"           — { type, fromPeerId, reason }

// Polyglot (PH5.10-PH5.13)
"oracle:language_detected"     — { file, language }
"oracle:remote_invoked"        — { oracleName, peerId, duration_ms }

// GAP-H failure mode detection (PH5.15)
"memory:eviction_warning"      — { sessionId, evictionCount, correlatedFailures }
"context:verdict_omitted"      — { taskId, oracleName, available: true }
"selfmodel:systematic_miscalibration" — { taskType, errorDirection, windowSize }
```

#### Gap Closure Analysis

| Gap | Status | How |
|:----|:-------|:----|
| GAP-1 (No Channel/Integration Layer) | **Fully addressed** | API server (HTTP), VS Code extension (editor), Terminal UI (interactive CLI), Web Dashboard (browser), A2A bridge (agent interop). External channels (Slack, Matrix) achievable via API server. |
| GAP-2 (No Concrete Tool Protocol) | **Fully addressed** | PH5.5 implements MCP bridge (TDD §19). PH5.6 implements A2A bridge (concept §2.1). Vinyan becomes MCP client + server + A2A participant. |
| GAP-3 (No Session Management) | **Fully addressed** | PH5.1 session manager with compaction pipeline, checkpoint recovery, session-scoped Working Memory. Compacted summaries feed Sleep Cycle. |
| GAP-5 (No Observability/Debugging UI) | **Fully addressed** | Terminal UI, Web Dashboard, VS Code extension, API metrics endpoints, audit replay, GAP-H detection events. |
| GAP-G (Cross-Domain Limitation) | **Partially addressed** | Pillar 3 extends to Python, Go, Rust. True cross-domain (legal, financial) deferred. Polyglot framework (PH5.10) establishes extension pattern. |
| GAP-H (Failure Modes) | **Partially addressed** | 5 of 14 failure modes covered (FC4, FC6, FC7, FC9, FC11). Detection events surface via PH5.15 observability. Remaining modes require LLM-level or planning-level intervention. |
| GAP-H UC-6 (Restarted Randomly) | **Fully addressed** | API server checkpoint recovery (PH5.1) + cross-instance state delegation (PH5.8). |

#### Items Deferred from Phase 4 to Phase 5

- Automatic cross-project pattern transfer (PH4.6 implements abstraction layer only) → **PH5.9**
- Oracle/Verifier-class Reasoning Engine lifecycle governance (concept §13.4) → **PH5.8**
- Multi-instance `WorkerProfile` sharing via ECP (concept §11) → **PH5.9**
- ECP `temporal_context` for capability evidence aging (concept §13.2) → **PH5.7**
- ECP `deliberation_request` as capability signal input (concept §13.1) → **PH5.7**
- Cross-domain oracle framework (GAP-G) → **PH5.10**
- Checkpoint recovery for "restarted randomly" failure mode (GAP-H UC-6) → **PH5.1**

#### Items Remaining Beyond Phase 5

- Hierarchical skill composition (GAP-C remainder — requires Task Decomposer skill reasoning)
- Causal graph relationships in World Graph (GAP-A remainder)
- True cross-domain support beyond programming languages (legal, financial, scientific verification)
- Proactive Background Cognition (concept §13.3 — persistent background agents, resource model unresolved)
- Fleet-level consensus governance (beyond advisory peer coordination)
- L3 container isolation for full sandboxing (Phase 2 design, not implemented)
- FC14 "Planning failure" detection and mitigation (requires Task Decomposer + Self-Model integration)

#### Risk Assessment

| Component | Risk Type | Level | Notes |
|:----------|:----------|:-----:|:------|
| PH5.0 Pre-Phase Cleanup | Engineering | Low | 4 targeted wiring fixes in known locations. Low blast radius. |
| PH5.1 API Server | Engineering | Low | Well-understood HTTP server pattern. Bun has built-in HTTP server. Session compaction is the riskiest sub-feature. |
| PH5.2 Terminal UI | Engineering | Low | Rendering bus events is read-only. No complex state management. |
| PH5.3 Web Dashboard | Engineering | Medium | Frontend framework choice affects maintenance burden. Must align auth with PH5.14. |
| PH5.4 VS Code Extension | Engineering | Medium | VS Code extension API is stable but verbose. Must work across versions. |
| PH5.5 MCP Bridge | Engineering | Low-Med | TDD §19 fully specifies the interface. MCP SDK exists. |
| PH5.6 A2A Bridge | Engineering | Medium | A2A spec is newer; ecosystem maturity uncertain. Confidence ceiling logic is novel. |
| PH5.7 ECP Network Transport | Eng + Research | **High** | No existing protocol carries ECP semantics natively. Must design carefully. |
| PH5.8 Instance Coordinator | Research | **High** | Distributed coordination is inherently complex. Consensus, ordering, partition tolerance. Creativity Protection Zone is novel. |
| PH5.9 Knowledge Sharing | Research | Medium | Builds on PH4.6 abstraction. Main risk: shared knowledge harmful locally. |
| PH5.10 Polyglot Framework | Engineering | Low | Runner generalization is a small change (use `config.command`). |
| PH5.11-PH5.13 Language Oracles | Engineering | Low-Med | Each language tool has structured JSON output. |
| PH5.14 Security Model | Engineering | Medium | Security is easy to get wrong. Must not block legitimate use. |
| PH5.15 Observability Extension | Engineering | Low-Med | GAP-H detection events are novel but read-only. No governance impact. |
| PH5.16 Migration | Engineering | Low | Additive-only schema changes. SQLite handles this well. |
| Network partition handling | System | **High** | Distributed system fundamental challenge. All multi-instance features must degrade gracefully to single-instance mode. |

**Biggest unknown:** Whether multi-instance coordination provides enough value over single-instance to justify the distributed systems complexity. Phase 4 trace data (especially PH4.6 cross-project transfer results) should inform this before investing heavily in Pillar 2.

#### Performance Budgets (Phase 5)

Phase 5 introduces network latency. These budgets ensure Phase 0-4 performance targets are not violated:

| Component | Target | Notes |
|:----------|:-------|:------|
| L0 Reflex (local) | < 100ms | **Unchanged.** L0 never touches network. No Phase 5 regression |
| L1 Heuristic (local) | < 2s | **Unchanged.** Local oracles only |
| L2 Analytical (local + remote) | < 10s | Remote oracle adds ≤ 5s. Local oracles proceed in parallel |
| L3 Deliberative (local + remote) | < 60s | Remote delegation timeout = 60s. Shadow execution unchanged |
| API request → response (sync) | < L-level budget + 500ms | HTTP overhead adds ≤ 500ms over CLI |
| Cross-instance oracle request | < 5s | Network RTT + remote execution + confidence cap |
| Task delegation → result | < 60s | Configurable per-task timeout |
| Session compaction | < 5s | Rule-based extraction, no LLM |
| Knowledge transfer (batch) | < 10s | Up to 100 items per batch |
| Heartbeat interval | 15s | Configurable |
| Plugin oracle P99 | Language-specific | Python (pyright): < 10s. Go: < 5s. Rust (cargo check): < 15s |

#### Critical Files for Implementation

- `src/oracle/runner.ts` — Core change for polyglot oracles: switch from hardcoded `bun run` to `config.command` (PH5.10)
- `src/oracle/registry.ts` — Static `ORACLE_PATHS` → dynamic registration with `registerOracle()` (PH5.10)
- `src/orchestrator/factory.ts` — Wiring point for all new Phase 5 dependencies (API server, instance coordinator, polyglot oracles, A2A bridge)
- `src/orchestrator/core-loop.ts` — Wire `oracleFailurePattern` fingerprint dimension (PH5.0), optional `instanceCoordinator` (PH5.8)
- `src/core/bus.ts` — EventBus must gain network transport capability for cross-instance event forwarding (PH5.7)
- `src/orchestrator/types.ts` — All new interfaces (instance identity, cross-instance delegation, polyglot oracle config, session management)
- `src/config/schema.ts` — `phase5` config namespace with `api`, `instances`, `creativity`, `polyglot` sections
- `src/bus/audit-listener.ts` — Complete `ALL_EVENTS` coverage (PH5.0) + JSONL as cross-instance serialization format
- `src/observability/metrics.ts` — Fleet, API, and GAP-H detection metrics extensions (PH5.15)
- `src/orchestrator/worker-lifecycle.ts` — State machine pattern reused for `OracleProfile` lifecycle (PH5.8)
- `src/evolution/pattern-abstraction.ts` — `AbstractPatternExport.version` migration support (PH5.0) + cross-instance sharing format (PH5.9)
- `src/db/vinyan-db.ts` — Migration framework replacing `CREATE TABLE IF NOT EXISTS` (PH5.16)
- `docs/vinyan-tdd.md` §19 — MCP bridge specification that PH5.5 implements directly
- `docs/vinyan-concept.md` §2.1 — A2A protocol specification that PH5.6 implements

---

## Critical Path Analysis

```
Phase 0 Gaps (P0-1..P0-5)
    ↓
1A.1 (Types) ──┬── 1A.2 (Perception) ──── 1A.3 (Risk Router) ─┐
               │                                                 ├── 1A.7 (Core Loop) ── 1A.8 (CLI)
               └── 1A.4 (Tools) ── 1A.5 (Generator) ── 1A.6 (Pool) ┘
                                      │
                           1B (MCP) ←─┘   1C (Intelligence) ←─── requires 1A.7 for ExecutionTrace data
                                                │
                                    1C.3 (QualityScore) ── prerequisite for ──┐
                                                                               │
                                                           Phase 2 (Isolation + Skills)
                                                                               │
                                                           Pre-Phase 3 (Hardening + Burn-in, ~3 wk)
                                                                               │
                                                           Phase 3 (Evolution + Self-Model, ~4-5 wk)
                                                                               │
                                                           Phase 4 (Fleet Governance, ~5-6 wk)
                                                                               │
                                                           Phase 5 (Self-Hosted ENS)
```

**Single biggest blocker:** 1A.7 (Orchestrator Core Loop) — everything flows through it. However, it can start with L0-L1 scope and expand.

**Recommended delivery:**
- **Vinyan 0.x** — Complete Phase 0 gaps → ship as verification library
- **Vinyan 1.0** — 1A complete → minimum viable autonomous agent
- **Vinyan 1.1** — Add 1B (MCP) → interoperable agent
- **Vinyan 1.2** — Add 1C (Self-Model, Decomposer) → intelligent routing
- **Vinyan 2.0** — Phase 2 → hardened execution + self-improvement
- **Vinyan 2.1** — Pre-Phase 3 → integration hardening + burn-in validation (≥200 real traces)
- **Vinyan 3.0** — Phase 3 → full evolution engine + trace-calibrated self-model
- **Vinyan 4.0** — Phase 4 → empirical worker identity + capability-based routing + fleet governance + pattern abstraction
- **Vinyan 5.0** — Phase 5 Tier 0 (PH5.16 migration + PH5.0 cleanup + PH5.14 security) + Tier 1 (PH5.1 API server + PH5.2-PH5.4 UIs) + PH5.5-PH5.6 protocol bridges
- **Vinyan 5.1** — Phase 5 Tier 3 (PH5.10-PH5.13 polyglot oracles — Python, Go, Rust)
- **Vinyan 5.2** — Phase 5 Tier 2 (PH5.7-PH5.9 multi-instance coordination + cross-instance knowledge sharing)

---

## Risk Assessment

| Component | Risk Type | Level | Mitigation |
|:----------|:----------|:-----:|:-----------|
| Self-Model calibration (1C.1) | Research | Medium | Start with static heuristics, accept ~50-60%. Cold-start safeguards prevent damage. |
| Task Decomposer (1C.2) | Engineering + LLM | Medium | 3-iteration retry + deterministic validation. Test with multiple providers. |
| Sleep Cycle (2.4) | Research | High | Frequency-based is implementable but few patterns with <200 tasks. Expected: 2-3 anti-patterns. |
| Evolution Engine (2.6) | Research | High | Overfitting from limited data. Strict backtesting + probation. Most research-heavy component. |
| LLM Provider integration (1A.5) | Engineering | Low | Well-documented SDKs. Abstraction layer insulates from API changes. |
| Container isolation (2.1) | Engineering | Low-Med | Docker well-understood. macOS-specific risks (Docker Desktop vs Orbstack). |
| Shadow validation latency (2.2) | Engineering | Medium | Mitigated by online/offline split — 60s budget applies to online path only. Shadow validation async with 300s budget. |
| Cross-task pattern mining (PH3.5) | Research | **High** | 200+ trace minimum. Experiments designed to produce results even with limited data. Fall back to single-task mining. |
| Self-Model miscalibration cascade (PH3.2) | System | **High** | Layered defense: detection → containment → recovery → prevention. S1-S4 safeguards. Freeze + revert on degradation. |
| Counterfactual exploration (PH3.6) | Research | Medium | Epsilon exploration never routes DOWN. Conservative ε=0.05. Disable if disruptive. |
| Rule feedback loop (PH3.3) | System | Medium | Re-backtest before promotion. Auto-retire bad rules. Cap at 20 active rules. |
| Capability-based routing (PH4.4) | Engineering | Medium | Core loop integration is highest-risk Phase 4 change. Tier-based fallback via data gate ensures safety. Disable with zero code change. |
| Worker differentiation data (PH4.3) | Eng + Research | Medium | 3 always-active fingerprint dimensions provide baseline even if framework markers don't differentiate. |
| Cross-project transfer (PH4.6) | Research | Medium | Scoped down to abstraction layer + manual export/import only. Automatic transfer deferred to Phase 5. |
| Fleet collapse to monoculture (PH4.5) | System | **High** | 3-layer defense: diversity floor (15% minimum) + exploration budget (10% minimum) + staleness penalty. Safety invariant I11 caps single-worker allocation at 70%. |
| Multi-model data bootstrapping (PH4.0) | Data | Medium | PH4.0 auto-registers existing models + epsilon-worker exploration (10%) seeds diversity. Data gates block PH4.3+ until sufficient. |
| ECP Network Transport (PH5.7) | Eng + Research | **High** | No existing protocol carries ECP semantics natively. Start with HTTP/JSON-RPC + ECP headers, optimize later. |
| Instance Coordinator (PH5.8) | Research | **High** | Distributed coordination inherently complex. Creativity Protection Zone is novel. Start with 2-instance static topology. All features degrade to single-instance. |
| A2A Protocol Bridge (PH5.6) | Engineering | Medium | A2A spec is newer; ecosystem maturity uncertain. Confidence ceiling logic is novel. |
| Polyglot oracle framework (PH5.10) | Engineering | Low | Runner generalization is a small change. Oracle binary contract already implicit. |
| Network partition handling (PH5.8) | System | **High** | All multi-instance features must degrade gracefully to single-instance mode. Advisory-only coordination minimizes partition damage. |
