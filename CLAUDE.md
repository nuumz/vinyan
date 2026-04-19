# Vinyan — Epistemic Orchestration

## What This Project Is

Vinyan is an **autonomous task/workflow orchestrator** built on the **Epistemic Orchestration** paradigm — the thesis that AGI-grade reliability emerges from correct epistemic architecture, not from larger LLMs. Its verification layer is an **Epistemic Nervous System (ENS)**: a rule-based substrate that connects heterogeneous Reasoning Engines via the Epistemic Communication Protocol (ECP). LLMs are one component among many, NOT the brain.

Code capability is Vinyan's first and most critical capability — not because Vinyan is a code tool, but because a system that can modify its own code can evolve without limits or downtime (add oracles, fix bugs, create tools, optimize itself).

**Core thesis:** Generation and verification MUST be performed by different components. No engine evaluates its own output. The Orchestrator's routing, verification, and commit decisions are rule-based and state-reproducible — no LLM is in the decision path for governance actions.

**Identity hierarchy:** Epistemic Orchestration (paradigm) → Vinyan (system) → ENS (verification substrate) → ECP (wire protocol)

## 7 Core Axioms (Non-Negotiable)

| # | Axiom | Principle |
|---|-------|-----------|
| A1 | Epistemic Separation | Generation ≠ verification at three layers: Understanding (goal → alignment oracle), Planning (DAG → validator), Execution (code → oracle gate). No engine evaluates its own output. |
| A2 | First-Class Uncertainty | "I don't know" is a valid protocol state (`type: 'unknown'`), not an error. |
| A3 | Deterministic Governance | Orchestrator routing/verification/commit = rule-based, no LLM in governance path. |
| A4 | Content-Addressed Truth | Facts bound to SHA-256 file hash → auto-invalidate on change. |
| A5 | Tiered Trust | Deterministic > heuristic > probabilistic evidence. |
| A6 | Zero-Trust Execution | Workers propose; Orchestrator disposes. Zero execution privileges for workers. |
| A7 | Prediction Error as Learning | Improvement = delta(predicted, actual), not just success/failure. |

**Every code change must satisfy at least one axiom. If it can't justify itself through an axiom, it doesn't belong.**

## Tech Stack

- **Runtime:** Bun (TypeScript, strict mode)
- **Dependencies:** zod (validation), chokidar (file watching) — intentionally minimal
- **Database:** SQLite (via bun:sqlite) — zero-dependency, portable
- **Path alias:** `@vinyan/*` → `./src/*`
- **Testing:** `bun run test` (built-in test runner)
- **No npm/yarn/pnpm** — Bun only

## Project Structure

```
src/
  core/           # EventBus, core types (HypothesisTuple, OracleVerdict, Evidence, Fact)
  oracle/         # Reasoning Engine infrastructure (protocol, registry, runner, circuit-breaker)
    ast/          # AST oracle (tree-sitter: symbol-exists, function-signature, import-exists)
    type/         # Type oracle (tsc --noEmit)
    dep/          # Dependency oracle (import graph, blast radius)
    test/         # Test oracle (auto-detect runner: bun/vitest/pytest)
    lint/         # Lint oracle (ESLint/Ruff)
    go/           # Go oracle (go vet/build output mapper)
    python/       # Python oracle (pyright output mapper)
    rust/         # Rust oracle (cargo output mapper)
    goal-alignment/ # Goal alignment verifier (L2+ comprehend phase)
  gate/           # Verification pipeline (risk-router, quality-score, tool-classifier, complexity)
  guardrails/     # Prompt injection + bypass detection + agent contract enforcement (K1)
  orchestrator/   # Core Loop: Perceive → Comprehend (L2+) → Predict → Plan → Generate → Verify → Learn
    phases/       # Phase implementations (perceive, predict, plan, generate, verify, learn)
    llm/          # RE abstraction layer: LLMProvider, ReasoningEngine, ReasoningEngineRegistry, LLMReasoningEngine adapter
    prediction/   # Forward predictor, causal predictor, calibration engine, file-stats cache
    thinking/     # Thinking policy compiler, uncertainty computer (risk × uncertainty → thinking depth)
    intent-resolver.ts # LLM-powered pre-routing intent classification (4 strategies: conversational, direct-tool, agentic-workflow, full-pipeline)
    understanding/ # Task understanding engine, entity resolver, historical profiler, understanding calibrator
    fleet/        # Fleet governance (capability model, worker lifecycle, worker selector, fleet coordinator/evaluator)
    critic/       # LLM-as-critic semantic verification (§17.6)
    test-gen/     # LLM-based test generation for generative verification (§17.7)
    tools/        # Tool execution layer (file, shell, search)
    worker/       # Worker process management; WorkerPool dispatches via ReasoningEngineRegistry (in-process) or LLMProviderRegistry (subprocess L2/L3)
  world-graph/    # Content-addressed fact store (SQLite + file watcher + cascade invalidation)
  evolution/      # Rule generator, backtester, safety invariants
  sleep-cycle/    # Pattern mining (Wilson CI, exponential decay, backtest 80/20)
  economy/        # Cost accounting, budget enforcement, market mechanism (Vickrey auction), federation economy
    market/       # Auction engine, settlement, bid accuracy, anti-gaming (collusion detection)
  db/             # SQLite stores (pattern, shadow, skill, rule, trace)
  bus/            # Event listeners (audit, cli-progress, trace)
  config/         # Configuration loader + schema
  cli/            # CLI entry points (vinyan gate, vinyan analyze, vinyan run)
  mcp/            # MCP client pool (MCPClientPool, callToolVerified through Oracle Gate)
  a2a/            # Agent-to-Agent protocol (peer discovery, delegation, InstanceCoordinator)
  api/            # HTTP + WebSocket API with ECP validation (Zod schemas on all handlers)
  security/       # Authorization, rate limiting, security policies
  observability/  # Health checks, system metrics
  dashboard/      # TUI dashboard components
  hms/            # Hallucination Mitigation System (claim grounding, cross-validation, overconfidence detection, risk scoring)
  tui/            # Terminal UI (blessed-based)
tests/            # Mirrors src/ structure + integration/, ecp-conformance/, property/, benchmark-fixtures/, experiment/
```

## Phase Status

Status legend: **✅ Active** = wired + called in default `vinyan run` path | **🔧 Built** = code + tests exist but requires config/data to activate | **📋 Designed** = interfaces defined, partial/stub implementation

| Phase | Scope | Status | Activation Condition |
|-------|-------|--------|---------------------|
| 0 | Oracle Gate (verification library) | ✅ Active | Always — wired in phase-verify |
| 1 | Autonomous Agent (Orchestrator + LLM + Tools) | ✅ Active | Needs `ANTHROPIC_API_KEY` or `OPENROUTER_API_KEY` |
| 6 | Agentic Worker Protocol (multi-turn tool loop, session overlay) | ✅ Active | Runs via agent-loop.ts in default path |
| K1 | Kernel Hardening (guardrails, agent contracts, tool auth) | ✅ Active | Always — wired in core-loop |
| 2 | Evolution Engine (Sleep Cycle + skill cache + rule promotion) | 🔧 Built | Needs DB + ≥100 traces for meaningful rules |
| 3 | Self-Model (trace-calibrated prediction, cross-task patterns) | 🔧 Built | Needs DB; uses SelfModelStub without it |
| 4 | Fleet Governance (worker profiles, capability routing) | 🔧 Built | Needs DB + multiple LLM providers registered |
| 5 | ENS (API, TUI, A2A coordination, cross-language oracles) | 🔧 Built | API via `vinyan serve`; A2A needs `network.instances.enabled` |
| K2 | Trust-Weighted Multi-Agent Dispatch (engine selector, MCP) | 🔧 Built | Needs provider trust data from completed tasks |
| E1-E4 | Economy OS (cost accounting, budget, market, federation) | 🔧 Built | Needs `economy.enabled: true` in vinyan.json |
| O1-O5 | Agent Ecosystem (runtime FSM, commitments, departments, volunteer, coordinator) | 🔧 Built | Needs `ecosystem.enabled: true` in vinyan.json — see `docs/design/vinyan-os-ecosystem-plan.md` §10 for activation recipe |

## Architecture: How Components Connect

```
Task → Intent Resolution (pre-pipeline, LLM-powered):
  resolveIntent() → ExecutionStrategy:
    conversational  → direct LLM answer (skip pipeline)
    direct-tool     → single tool execution (skip pipeline)
    agentic-workflow → rewrite goal with workflow prompt → enter pipeline
    full-pipeline   → continue to Core Loop below
  Skipped when: code-mutation domain OR targetFiles present
  Fallback: regex-based classification when LLM unavailable

Task → Orchestrator Core Loop (full-pipeline strategy only):
  ⓪ Budget:     BudgetEnforcer.canProceed() → block/degrade if over budget
                DynamicBudgetAllocator adjusts per-task budget based on priority + history
  ① Perceive:    PerceptualHierarchy (dep-cone, World Graph facts, diagnostics)
  ①½ Comprehend: TaskUnderstanding → Goal Alignment Oracle (L2+ only; L0-L1 skip)
  ② Predict:     SelfModel (per-task-type EMA, 4 cold-start safeguards)
                 CostPredictor.predict() estimates token/cost before dispatch
  ③ Plan:        TaskDecomposer (LLM → DAG, validated by 5 machine-checkable criteria)
  ④ Generate:    EngineSelector (trust-weighted, Wilson LB ranking) → WorkerPool dispatch
                 ConcurrentDispatcher for batch tasks (file-lock conflict resolution)
                 In-process: any ReasoningEngine type (LLM, symbolic, AGI, external)
                 Subprocess L2/L3: LLM-only (worker-entry.ts reconstructs provider from env vars)
  ⑤ Verify:      OracleGate (parallel oracle execution, circuit-breaker protected)
                 AgentContract enforcement (K1.2) + authorizeToolCall() (K1.3)
  ⑥ Learn:       TraceCollector → PredictionError → SelfModel.calibrate()
                 CostPredictor.calibrate() with actual cost data
                 ProviderTrustStore records per-(provider, capability) trust

Escalation: If verification fails → increment routing level (L0→L3) → retry with stronger engine + deeper verification
           Labeled `routingLoop:` prevents double-escalation (K1 fix)
           L3 contradiction → terminal failure (no infinite retry)
```

**Key Protocols:**
- **ECP (internal):** JSON-RPC + epistemic semantics (confidence, evidence_chain, falsifiable_by, temporal_context)
- **MCP (external only):** Tool access to outside world. NOT used for internal communication.
- **Oracle I/O:** stdin(HypothesisTuple JSON) → child process → stdout(OracleVerdict JSON)

**Reasoning Engine (RE) Abstraction:**
- `ReasoningEngine` interface (`src/orchestrator/types.ts`) — primary abstraction for any generator: LLM, symbolic solver, AGI, external system
- `LLMReasoningEngine` adapter (`src/orchestrator/llm/llm-reasoning-engine.ts`) — wraps `LLMProvider` as a `ReasoningEngine`
- `ReasoningEngineRegistry` — capability-first selection; tier-based as fallback
- `OrchestratorConfig.engineRegistry` — inject custom REs without changing core loop
- **Design constraint:** subprocess path (L2/L3 isolation) is LLM-only. Non-LLM REs dispatch in-process with a warning.

**K2 Additions:**
- `EngineSelector` (`src/orchestrator/engine-selector.ts`) — trust-weighted engine selection using Wilson LB, per-level trust thresholds
- `ConcurrentDispatcher` (`src/orchestrator/concurrent-dispatcher.ts`) — round-based parallel dispatch with `AdvisoryFileLock` conflict resolution
- `MCPClientPool` (`src/mcp/client.ts`) — lifecycle-managed MCP client with `callToolVerified()` routing results through Oracle Gate
- `ProviderTrustStore` (`src/db/provider-trust-store.ts`) — per-(provider, capability) composite trust tracking with evidence_hash

**Economy Layer:**
- `BudgetEnforcer` — pre-routing budget check (warn/block/degrade). Wired in core-loop before routing.
- `DynamicBudgetAllocator` — replaces fixed budget with priority + history-based allocation
- `CostPredictor` — EMA-based cost prediction, calibrated after each task completion
- `costAwareScore()` — wired in worker-selector scoring formula
- `FederationCostRelay` — cross-instance cost sharing via EventBus subscription

## Risk Routing (4 Levels)

Risk score → routing level mapping is defined in `src/gate/risk-router.ts`. The 4 levels:

| Level | Behavior |
|-------|----------|
| L0 Reflex | No oracles, hash-only verify, zero tokens, < 100ms |
| L1 Heuristic | Structural oracles (AST + Type + Dep + Lint), < 2s |
| L2 Analytical | All oracles including tests, < 10s |
| L3 Deliberative | All oracles + shadow execution, < 60s |

See `ROUTING_THRESHOLDS` and `calculateRiskScore()` in risk-router.ts for exact thresholds and weights.

## Coding Conventions

### Naming (enforced by Biome)

| Element | Convention | Example |
|---------|-----------|---------|
| Functions/methods | camelCase | `detectLinter()`, `resolveConflicts()` |
| Variables | camelCase / CONSTANT_CASE / PascalCase (Zod schemas) | `riskScore`, `MAX_RETRIES`, `OracleConfigSchema` |
| Types/interfaces | PascalCase | `GateVerdict`, `TaskInput` |
| Enum members | PascalCase / CONSTANT_CASE | `Deterministic`, `PARSE_ERROR` |
| Class properties | camelCase | `this.circuitBreaker` |
| Object literal props | camelCase / snake_case / CONSTANT_CASE | `budgetTokens`, `task_id` |
| Type properties | camelCase / snake_case | `taskId`, `created_at` |
| File names | kebab-case | `risk-router.ts`, `worker-entry.ts` |
| DB columns | snake_case | `task_id`, `created_at` |

### Linting & Formatting

- **Biome** for linting + formatting (`biome.json`). Run: `bun run lint` / `bun run lint:fix`
- **tsc --noEmit** for type checking. Combined: `bun run check`
- Single quotes, 2-space indent, 120 char line width, trailing commas

### Architecture Patterns

- **Zod for all external boundaries** (IPC, config, oracle I/O, API responses)
- **EventBus for cross-module communication** — FIFO, synchronous, type-safe
- **Dependency injection** in core-loop.ts — all components are interfaces, wired by factory.ts
- **SQLite for persistence** — dual-write pattern (memory + SQLite, best-effort DB)
- **Circuit breaker per oracle** — failureThreshold=3, resetTimeout=60s
- **Crash-safety invariant:** ShadowJob persisted BEFORE online TaskResult returns

### Quality Gates (enforced by review)

- **Wiring verification**: No component is "done" until its function appears in a runtime trace. Build + wire + verify in the same PR.
- **Behavior tests only**: `toHaveProperty` alone is forbidden — every test must call a function and verify output/side-effects.
- **Benchmark gate**: Run `bun run test:benchmark` before merging changes to core orchestrator (phases, core-loop, perception, agent-loop).
- **Smoke test gate**: Run `bun run test:smoke` with a real API key before declaring any session "done". Mock-only tests do NOT prove the system works.
- **HMS integration**: Hallucination analysis runs in phase-verify after oracle verification. Confidence is attenuated by HMS risk score.
- **Honest status**: Phase Status uses 3 tiers (✅ Active / 🔧 Built / 📋 Designed). A feature is ✅ Active ONLY when it runs in the default `vinyan run` path without extra config.

## Known Issues

Tracked in code comments (`TODO`, `FIXME`, `HACK`) and design docs. Before working on a module, grep for these markers:

```bash
grep -r "TODO\|FIXME\|HACK" src/ --include="*.ts" -n
```

Key architectural gaps documented in `docs/architecture/decisions.md` and `docs/spec/tdd.md` §15 (Open Questions).

**Resolved (K1-K2-CR):** confidence_source governance, agent contract wiring, tool authorization, concurrent dispatch, A2A activation, crash recovery (MVP).
**Resolved (Quality Sprint):** HMS wired into phase-verify (was orphaned), perception context expanded 6K→24K, stall detection tightened, phase timing instrumentation added.
**Note:** CriticEngine and TestGenerator are NOT orphaned — both wired in factory.ts and called from core-loop.ts.
**Remaining gaps:** L3 container isolation, active task resumption (currently auto-abandons), Biome lint cleanup.

## Commands

```bash
bun run test                                # Unit tests only (~5s)
bun run test:integration                    # Gate/oracle/orchestrator tests (~30s, spawns tsc)
bun run test:slow                           # Benchmark + experiment (~90s)
bun run test:all                            # Unit + integration (~140s)
bun run lint                                # Biome lint check
bun run lint:fix                            # Biome lint + auto-fix
bun run format                              # Biome format (auto-fix)
bun run check                               # tsc + biome (full check)
bun run build:worker                        # Bundle worker-entry.ts → dist/worker-entry.js
bun run test:benchmark                      # E2E orchestrator benchmarks with phase timing
bun run test:smoke                          # Real LLM smoke test (needs API key, skip-safe)
```

### Terminal Execution Rules (MUST follow)

- **NEVER run `bun test` or `bun run test*` with `2>&1`** — redirecting stderr merges Bun's TTY progress output and hangs the terminal. Let stderr stream separately.
- **NEVER pipe test commands into another process on the same line** (e.g. `bun test | tee`, `bun test | cat`) — same hang issue.
- **Always scope test runs** to specific files: `bun test tests/path/to/file.test.ts`. Full-suite runs only when shared types/interfaces change.
- **For long output**, use the test runner's own filters (`--reporter`, `-t <pattern>`) instead of shell pipes.
- **Timeout**: wrap any test command with an explicit timeout (e.g. `--timeout 30000`) if a hang is suspected; do not retry the same command in a tight loop.

## Design Documents (read before major changes)

- `docs/foundation/concept.md` — Vision, axioms, ECP protocol, Reasoning Engine model
- `docs/architecture/decisions.md` — Concrete decisions D1-D8, component design
- `docs/spec/tdd.md` — Implementation contracts, interface definitions, schemas, algorithms
- `docs/design/implementation-plan.md` — Phased roadmap
- `docs/architecture/vinyan-os-architecture.md` — Complete architecture doc (v5, authoritative)
- `docs/analysis/gap-analysis.md` — Competitive landscape

## Key Design Principles

1. **Reuse first** — search existing code before creating new modules
2. **Backwards compatible** — don't break Phase 0 when building Phase 1
3. **Data gates** — Phase 2 features auto-activate only when data sufficient (≥100 traces, ≥5 task types)
4. **Statistical rigor** — Wilson CI for pattern detection, backtesting before rule promotion, exponential decay
5. **Progressive isolation** — L0=in-process, L1-L2=subprocess, L3=container (Phase 3)
6. **Protocol honesty** — `type:'unknown'` over hallucination, confidence reflects evidence tier
