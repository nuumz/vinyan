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

### Phase 4+: Outline (Detail When Phase 3 Completes)

### Phase 4 — Fleet Governance (DRAFT Guideline)

> **Status:** Draft brief. Detail after Phase 3 results are in.
> **Prerequisite:** Phase 3 complete + PH3.7 readiness gate passed.
> **Type:** Engineering-heavy, with one high-risk research component (PH4.6).

#### Vision

Phase 3 proves Vinyan can learn from its own data: trace-calibrated predictions, pattern-mined rules, effectiveness-scored skills. But Phase 3 treats the worker fleet as a fixed, static mapping: `RoutingLevel -> tier ("fast"|"balanced"|"powerful") -> single provider`. The Orchestrator has no concept of a worker's *empirical track record* or *domain capability* — it selects by tier alone.

Phase 4 introduces **empirical worker identity**. Each worker configuration (model + temperature + tool set + system prompt variant) becomes a first-class entity with an observed performance profile. The Orchestrator stops routing by tier and starts routing by *measured capability against task characteristics*. Workers earn their workload through deterministic quality gates — not by label or default position.

What changes: the `LLMProviderRegistry.selectForRoutingLevel()` call in `worker-pool.ts:115` becomes a multi-factor capability match. The `RoutingDecision.model` field becomes a `workerId` pointing to a tracked configuration. The `ExecutionTrace.model_used` field becomes the primary input to worker evaluation.

#### Sub-Components

##### PH4.1 — Worker Profile Registry `[M]`

**Purpose:** Define the `WorkerProfile` as a first-class entity — a specific configuration (model ID, temperature, tool allowlist, system prompt template) paired with empirical statistics computed from `ExecutionTrace` data.

**Key concepts to design:**
- `WorkerProfile` interface: `{ id, config: WorkerConfig, stats: WorkerStats, status: "probation"|"active"|"demoted", createdAt, promotedAt? }`
- `WorkerConfig`: `{ modelId, temperature, toolAllowlist, systemPromptTemplate?, maxContextTokens }`
- `WorkerStats`: aggregated from traces — `{ totalTasks, successRate, avgQualityScore, avgDuration, avgTokenCost, taskTypeBreakdown: Record<taskSig, { count, successRate, avgQuality }> }`
- `WorkerProfileStore` (SQLite table) for persistence
- Registration API: create profile, initial stats = zero, status = probation

**Dependencies on Phase 3:** `ExecutionTrace` schema already carries `model_used` (PH3.1 improves task signatures). Self-Model per-task-type parameters (PH3.2) provide the baseline to compare worker performance against.

**Open questions:**
- What constitutes a "different worker"? Whether temperature alone (e.g., `claude-sonnet@0.3` vs `claude-sonnet@0.7`) warrants separate profiles, or only model-level granularity.
- How to handle model version changes (e.g., `claude-sonnet-4-20250514` vs a future version)? Version-aware identity or reset stats?
- Should profiles be global (across projects) or project-scoped? Phase 4 scope says single-project, but the data model should not block Phase 5 multi-project.

##### PH4.2 — Worker Lifecycle (Probation/Promotion/Demotion) `[M]`

**Purpose:** Deterministic state machine governing worker status transitions. New configurations start on probation (logging-only, shadowed). Promotion requires statistically significant quality. Demotion is automatic on sustained underperformance.

**Key concepts to design:**
- State machine: `probation -> active -> demoted` (and `demoted -> probation` for re-evaluation)
- Promotion gate: minimum N tasks on probation (explore: 20? 50?), Wilson score lower bound on success rate > threshold, average quality score >= project baseline
- Demotion trigger: rolling window (explore: last 30 tasks) where success rate drops below threshold OR quality score drops below active-worker median by > K sigma
- Probation behavior: worker is dispatched alongside the "incumbent" worker for the same task. Only the incumbent's output is committed. Probation worker's output is scored but not applied. Reuses the existing `ShadowValidationResult.pheAlternatives` pattern from `orchestrator/types.ts`.
- Safety invariant extension: a promoted worker cannot bypass oracle verification. Extend `checkSafetyInvariants()` to cover worker lifecycle rules.

**Dependencies on Phase 3:** Wilson score lower bound (PH3.3 fix). `EvolutionMetrics` framework (PH3.7) provides the scoring infrastructure.

**Open questions:**
- Minimum task count before promotion decisions are statistically meaningful? Depends on variance observed in Phase 3 data.
- Should demotion be permanent or time-boxed (e.g., re-evaluate after 50 sessions)?
- How does the probation shadow interact with Phase 2's existing shadow execution? Avoid doubling compute cost.

##### PH4.3 — Capability Tagging & Task Fingerprinting `[L]`

**Purpose:** Build a matching system between task characteristics and worker demonstrated strengths. "This worker empirically succeeds at React refactoring tasks" — derived from trace data, not declared.

**Key concepts to design:**
- Task fingerprint: extends PH3.1's `task_type_signature` with additional dimensions — framework markers (detected from imports/deps), oracle failure patterns, code complexity bucket
- Worker capability vector: per-task-fingerprint-dimension success rates, built from `WorkerStats.taskTypeBreakdown`
- Capability inference: after N traces per worker per task fingerprint dimension, compute a capability score. Explore: simple success rate, or quality-weighted score?
- Negative capabilities: "this worker consistently fails at test-writing tasks" — equally valuable for routing exclusion

**Dependencies on Phase 3:** Task signature quality (PH3.1), cross-task pattern correlation (PH3.5) — if PH3.5 finds meaningful cross-task patterns, those become candidate capability dimensions.

**Open questions:**
- How many task fingerprint dimensions are meaningful? Too few = no differentiation. Too many = insufficient data per cell.
- Should capability be binary (can/cannot) or continuous (score 0-1)?
- Cold-start for new task fingerprint dimensions? Fall back to tier-based routing until data accumulates.

##### PH4.4 — Capability-Based Router `[L]`

**Purpose:** Replace the current `RoutingLevel -> tier -> provider` mapping with a multi-factor worker selection. The core architectural change — empirically-grounded worker assignment decisions.

**Key concepts to design:**
- New interface replacing `LLMProviderRegistry.selectForRoutingLevel()`: `selectWorker(taskFingerprint, routingLevel, budget) -> WorkerProfile`
- Selection algorithm (must be deterministic per A3):
  1. Filter: only `status: "active"` workers at or above required routing level
  2. Filter: worker's tool allowlist covers task requirements
  3. Score: capability match (PH4.3) × quality track record (PH4.1) × cost efficiency
  4. Tiebreak: lowest token cost (or deterministic ordering)
- Fallback: if no worker has sufficient capability data for this task fingerprint, fall back to tier-based selection (backward compatible with Phase 3)
- Integration point: `core-loop.ts` — after `riskRouter.assessInitialLevel()`, before `workerPool.dispatch()`. The `RoutingDecision` gains a `workerId` field.

**Dependencies on Phase 3:** PH3.6 counterfactual analysis feeds "would a different worker have done better?" analysis.

**Open questions:**
- Scoring formula: weighted sum vs priority-based filter chain? Must be deterministic and auditable.
- Exploration vs exploitation: extend PH3.6's epsilon-greedy to worker selection?
- Token cost as first-class factor or tiebreak only?
- Transition period: gradual rollout starting with 1 task fingerprint dimension, expand as data accumulates.

##### PH4.5 — Fleet Evaluation & Evolution Integration `[M]`

**Purpose:** Extend Sleep Cycle and Evolution Engine to reason about worker performance. Generate rules like "for React refactoring, prefer worker X over worker Y."

**Key concepts to design:**
- New pattern type: `"worker-performance"` added to `ExtractedPattern.type`
- Worker comparison during Sleep Cycle: for each task fingerprint with sufficient data across multiple workers, compare quality distributions. If one worker is statistically better (Wilson LB), generate a `prefer-model` rule.
- New evolution rule action: `"assign-worker"` — directly maps a task fingerprint to a worker ID. Subject to all existing safety invariants.
- Fleet-level metrics extension to `EvolutionMetrics` (PH3.7): worker utilization distribution, capability coverage, fleet diversity score

**Dependencies on Phase 3:** Evolution pipeline (PH3.3), evaluation framework (PH3.7), pattern mining (PH3.5).

**Open questions:**
- Should worker-preference rules go through the same probation pipeline as other evolution rules?
- How to prevent the fleet from collapsing to a single "best" worker? Diversity incentives or minimum allocation floors.

##### PH4.6 — Cross-Project Pattern Transfer `[L/XL]` (Research)

**Purpose:** Abstract patterns learned in one project so they can seed behavior in a new project. "React refactoring patterns learned in Project A apply to Project B."

**Key concepts to design:**
- Pattern abstraction layer: strip project-specific details (file paths, symbol names) from `ExtractedPattern` and `CachedSkill`, retain structural characteristics (framework, task type, complexity class)
- Portable pattern format: `AbstractPattern { taskFingerprint, approach, qualityRange, sourceProjectCount, confidence }`
- Import/export mechanism: serialize patterns to a transferable format, import into a new project's pattern store with `status: "probation"` and reduced confidence
- Similarity metric for cross-project applicability: whether two projects are "similar enough" for transfer

**Open questions (many — highest uncertainty component):**
- Is cross-project transfer even feasible with the data available? Depends entirely on Phase 3 findings.
- How to measure whether a transferred pattern is helping vs introducing noise?
- Minimum project similarity threshold: hand-crafted heuristic or learned?
- Should transfer be manual (human selects) or automatic?
- Explore whether this should be deferred to Phase 5 (multi-instance coordination).

**Size:** L/XL — highest research risk. May be descoped to "design the abstraction layer, defer actual transfer" based on Phase 3 findings.

#### Dependency Graph

```
PH4.1 (Worker Profiles) ──┬── PH4.2 (Lifecycle)
                           │
                           ├── PH4.3 (Capability Tagging) ── PH4.4 (Capability Router)
                           │                                        │
                           └── PH4.5 (Fleet Evolution) ────────────┘
                                                                    │
                                                            PH4.6 (Cross-Project) [independent, research]
```

**Parallel streams:**
- Stream A (critical path): PH4.1 → PH4.3 → PH4.4
- Stream B: PH4.1 → PH4.2 (parallel with Stream A)
- Stream C: PH4.4 + PH4.2 → PH4.5
- Stream D: PH4.6 (independent, can start after PH4.1, may be descoped)

#### Data Prerequisites

Phase 4 decisions are only as good as the trace data they consume. Before starting:

| Prerequisite | Minimum | Ideal | Source |
|:-------------|:--------|:------|:-------|
| Total execution traces | 500 | 1000+ | Phase 3 burn-in + validation |
| Distinct task type signatures | 10 | 20+ | PH3.1 improved signatures |
| Traces with >1 distinct `model_used` | 100 | 300+ | Need multi-model data for worker comparison |
| Active evolution rules | 3 | 10+ | PH3.3 promotion pipeline |
| Self-Model per-type accuracy >75% | 5 task types | 10+ | PH3.2 adaptive EMA |
| Sleep cycles completed | 10 | 25+ | PH3.5 pattern mining maturity |

**Critical gap:** Current system uses a single model per tier. Phase 4 needs traces from *multiple worker configurations per routing level* to compare. Phase 3 validation (PH3.8) should deliberately run with 2-3 model configs to seed this data.

#### Key Design Decisions (Open)

1. **Worker identity granularity.** Is `(modelId, temperature)` sufficient, or does `(modelId, temperature, systemPromptVariant, toolAllowlist)` define a distinct worker?
2. **Routing integration point.** Options: (a) extend `RoutingDecision` with `workerId`, (b) add `workerSelector` dependency between risk router and worker pool, (c) make worker selection internal to `WorkerPoolImpl`.
3. **Probation compute budget.** Probation workers run in shadow mode. Explore: run on random subset (e.g., 20%) rather than all tasks to limit cost.
4. **Capability vector representation.** Dense (one score per dimension per worker) vs sparse (only store dimensions with sufficient data).
5. **Fleet size governance.** Cap on active worker configurations? Dynamic cap tied to trace volume.
6. **Backward compatibility.** Must degrade gracefully to Phase 3 tier-based behavior when worker data is insufficient.

#### Risk Assessment

| Component | Risk Type | Level | Notes |
|:----------|:----------|:-----:|:------|
| PH4.1 Worker Profiles | Engineering | Low | Data modeling. Follows existing store patterns. |
| PH4.2 Lifecycle | Engineering | Low-Med | State machine straightforward. Thresholds need tuning from Phase 3 data. |
| PH4.3 Capability Tagging | Eng + Research | Medium | Depends on Phase 3 finding meaningful task fingerprint dimensions. |
| PH4.4 Capability Router | Engineering | Medium | Core loop integration is highest-risk engineering change. |
| PH4.5 Fleet Evolution | Engineering | Low-Med | Extends existing evolution infrastructure. |
| PH4.6 Cross-Project Transfer | Research | **High** | May be infeasible. Depends on Phase 3 abstractable patterns. |

**Biggest unknown:** Whether single-project trace data provides enough statistical power for meaningful worker differentiation. Phase 3 should measure trace-per-task-type distribution to inform this.

#### Critical Files for Implementation
- `src/orchestrator/types.ts` — WorkerProfile, WorkerConfig, WorkerStats interfaces
- `src/orchestrator/worker/worker-pool.ts` — Primary integration point: `selectForRoutingLevel()` becomes capability-based
- `src/orchestrator/llm/provider-registry.ts` — Current tier-based selection becomes fallback path
- `src/evolution/safety-invariants.ts` — Extend with fleet governance invariants
- `src/orchestrator/core-loop.ts` — RoutingDecision gains `workerId`, worker selection step added

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
                                                           Pre-Phase 3 (Hardening + Burn-in, ~3 wk)
                                                                               │
                                                           Phase 3 (Evolution + Self-Model, ~4-5 wk)
                                                                               │
                                                           Phase 4 (Fleet Governance, ~6-8 wk)
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
- **Vinyan 4.0** — Phase 4 → empirical worker identity + capability-based routing

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
| Capability-based routing (PH4.4) | Engineering | Medium | Core loop integration risk. Tier-based fallback ensures backward compatibility. |
| Worker differentiation data (PH4.3) | Research | Medium | Depends on trace volume per worker-task-type cell. Phase 3 should seed multi-model traces. |
| Cross-project transfer (PH4.6) | Research | **High** | May be infeasible. Depends on Phase 3 finding abstractable patterns. Descope to design-only if data insufficient. |
