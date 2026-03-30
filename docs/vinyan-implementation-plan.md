# Vinyan Implementation Plan

> Generated: 2026-03-29 | Updated: 2026-03-30 | Branch: `main`
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

- `uncertain`/`contradictory` verdict types in actual oracle output
- 5-step Contradiction Resolution
- `deliberation_request` and `temporal_context` ECP extensions
- Bounded cascade invalidation (`cascadeInvalidation` with `maxDepth`)
- MCP External Interface (Client Bridge + Server)
- `before_prompt_build` with `PerceptualHierarchy`
- `before_model_resolve` with Self-Model routing

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

### P3.0 — Spec-vs-Implementation Audit `[M]`

**What:** Systematic delta between TDD spec and current code. Fix discrepancies before building on top.

**Known deltas from code review (2026-03-30):**

| Area | Spec | Current Code | Gap |
|:-----|:-----|:-------------|:----|
| Core loop `complexityContext` | QualityScore should include `simplificationGain` (1C.3) | `computeQualityScore()` called with `undefined` complexityContext (core-loop.ts:268) | No AST complexity diff computed |
| Skill match → outcome | Skill match should feed back into `recordOutcome()` | Core loop matches skill (L195-208) but never calls `skillManager.recordOutcome()` on task success/failure | Skills never promote or demote |
| Shadow processNext | Shadow jobs enqueued but never processed in main loop | `shadowRunner.processNext()` never called after enqueue | Shadow validation never executes |
| Sleep Cycle trigger | Should run every N sessions (default: 20) | `sleepCycleRunner.run()` never called from core loop or CLI | Pattern extraction never fires |
| Evolution rule types | Spec: `escalate`, `require-oracle`, `prefer-model`, `adjust-threshold` | Core loop only handles `escalate` action (L148) | 3 of 4 rule types ignored |
| Skill dep cone hashes | `createFromPattern()` should receive real dep cone hashes | Called with empty `{}` (sleep-cycle.ts:124) | Skills created without dep tracking |
| `activeSkills` in stats | Sleep Cycle gatherStats should query real skill count | Hardcoded `activeSkills: 0` (sleep-cycle.ts:335) | Data gate for evolution never opens |
| Backtester integration | Rules should be backtested before activation | `ruleStore.insert()` directly after `generateRule()` — no `backtestRule()` call | Rules enter probation without validation |
| Factory stubs | CalibratedSelfModel and TaskDecomposerImpl available | Factory falls back to stubs when no LLM/DB (acceptable), but never verifies which is active at startup | Silent degradation |

**Deliverable:** All deltas above fixed + regression tests added for each. Track via checklist.

**Tests:** One integration test per delta: "given trace data, sleep cycle fires → skill created with real hashes → rule backtested → core loop applies non-escalate rules."

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

2. **Skill outcome tracking:** After oracle verification in core loop:
   - On skill match + success: `skillManager.recordOutcome(skill, true)`
   - On skill match + failure: `skillManager.recordOutcome(skill, false)`
   - Demoted skill → fall through to normal routing (already designed, just unwired)

3. **Real dep cone hashes:** When Sleep Cycle creates skill from pattern:
   - Extract `affected_files` from source traces
   - Compute current hashes via `skillManager.computeCurrentHashes(files)`
   - Pass real hashes to `createFromPattern()`

4. **Backtest before insert:** In Sleep Cycle, after `generateRule()`:
   - Fetch relevant traces from `traceStore`
   - Call `backtestRule(rule, traces)`
   - Only `ruleStore.insert()` if backtest passes

5. **All rule action types in core loop:**
   - `escalate`: already implemented ✅
   - `require-oracle`: add specific oracle to verification requirements
   - `prefer-model`: override routing model selection
   - `adjust-threshold`: modify risk thresholds for this task

6. **Fix `activeSkills: 0` hardcode:** Query `skillStore.count()` filtered by `status = 'active'`

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

## Phase 3+: Outline (Detail When Phase 2 Completes)

### Phase 3 — Full Evolution Engine + Self-Model

| Component | Type | Description |
|:----------|:-----|:------------|
| Full pattern mining | Research | Cross-task-type pattern analysis beyond frequency. Requires hundreds of traces. |
| Counterfactual generation | Research | "What if we used approach B?" Requires replay infrastructure + historical codebase snapshots. |
| Trace-calibrated Self-Model | Engineering + Research | Replace static heuristics with learned weights. EMA over prediction errors. Target: >75% accuracy by 200 sessions. |
| Evaluation methodology | Research | How to measure Evolution Engine effectiveness? Metrics: success rate, QualityScore improvement, routing efficiency. |

### Phase 4 — Fleet Governance

| Component | Description |
|:----------|:------------|
| Meritocratic worker profiles | Each worker config (model + temp + tool set) tracked with empirical stats. Probation → promotion. |
| Capability-based routing | Match task characteristics to worker capabilities. "React task → React-skilled worker." |
| Cross-project pattern transfer | Abstract patterns from project-specific details. |

### Phase 5 — Self-Hosted ENS

| Component | Description |
|:----------|:------------|
| Standalone system | Own terminal UI, API server, VS Code extension. No external framework dependency. |
| Multi-instance coordination | Multiple Vinyan instances as peer Reasoning Engines via ECP. Domain specialization. |
| Cross-language support | Python (Pyright), Go (gopls), Rust (rust-analyzer). Oracle framework is language-agnostic; implementations are language-specific. |

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
                                                           Pre-Phase 3 (Hardening + Burn-in)
                                                                               │
                                                           Phase 3+ (Research)
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
