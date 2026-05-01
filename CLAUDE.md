# Vinyan — Epistemic Orchestration

## What This Project Is

Vinyan is an **autonomous task/workflow orchestrator** built on the **Epistemic Orchestration** paradigm — the thesis that AGI-grade reliability emerges from correct epistemic architecture, not from larger LLMs. Its verification layer is an **Epistemic Nervous System (ENS)**: a rule-based substrate that connects heterogeneous Reasoning Engines via the Epistemic Communication Protocol (ECP). LLMs are one component among many, NOT the brain.

Code capability is Vinyan's first and most critical capability — not because Vinyan is a code tool, but because a system that can modify its own code can evolve without limits or downtime.

**Core thesis:** Generation and verification MUST be performed by different components. No engine evaluates its own output. Orchestrator routing/verification/commit decisions are rule-based and state-reproducible — no LLM in the governance path.

**Identity hierarchy:** Epistemic Orchestration (paradigm) → Vinyan (system) → ENS (verification substrate) → ECP (wire protocol)

## "Agent" — five distinct things in this codebase

The word *agent* is overloaded. **Always disambiguate:**

| # | Canonical name | What it is | Trust |
|---|---|---|---|
| 1 | **Persona** | Internal Vinyan role (developer, reviewer, coordinator) — `src/orchestrator/agents/` | internal-trusted |
| 2 | **Worker** | Vinyan agentic-worker subprocess (Phase 6) — `src/orchestrator/worker/` | zero-trust (A6) |
| 3 | **CLI Delegate** | External coding CLI Vinyan **spawns** (Claude Code, Copilot) — `src/orchestrator/external-coding-cli/` | zero-trust (A6 + A1) |
| 4 | **Host CLI** | The Claude Code (or other tool) the **developer uses to BUILD Vinyan** — outside `src/` entirely | dev-time, human-reviewed |
| 5 | **Peer** | A2A peer Vinyan instance — `src/a2a/` | earned via PeerTrustLevel |

**Crucial #3 vs #4 distinction:** Claude Code CLI is the same binary in both. Vinyan-as-runtime spawning Claude Code (#3) is unrelated to a developer using Claude Code to write Vinyan source (#4). When reading prompts that mention "Claude Code", classify by intent (use it vs talk about it vs the dev-toolchain identity).

Full taxonomy, code anchors, branded ID types, and migration RFCs: **`docs/foundation/agent-vocabulary.md`**. Branded types live in `src/core/agent-vocabulary.ts`.

**Naming rule:** new code uses `persona` / `worker` / `cliDelegate` / `peer` — never bare `agent` / `agentId`. User-facing strings (governance reasons, errors, prompts, UI) MUST use the canonical name; "Agent failed" is forbidden, "Worker subprocess failed" or "Persona `developer` failed" is required.

## 7 Core Axioms (Non-Negotiable)

| # | Axiom | Principle |
|---|-------|-----------|
| A1 | Epistemic Separation | Generation ≠ verification at three layers (Understanding, Planning, Execution). No engine evaluates its own output. |
| A2 | First-Class Uncertainty | "I don't know" is a valid protocol state (`type: 'unknown'`), not an error. |
| A3 | Deterministic Governance | Orchestrator routing/verification/commit = rule-based, no LLM in governance path. |
| A4 | Content-Addressed Truth | Facts bound to SHA-256 file hash → auto-invalidate on change. |
| A5 | Tiered Trust | Deterministic > heuristic > probabilistic evidence; confidence traces record oracle independence assumptions. |
| A6 | Zero-Trust Execution | Workers propose; Orchestrator disposes. Zero execution privileges for workers. |
| A7 | Prediction Error as Learning | Improvement = delta(predicted, actual), not just success/failure. |

### Proposed Core Extensions (RFC, staged — not yet load-bearing)

Three additional invariants are under evaluation as official axioms. They are documented here so design work can begin referencing them, but they are NOT yet binding contracts. Promotion to A8-A10 official requires landing the minimum runtime slice for each (trace-level provenance for A8, declared degradation strategy for A9, runtime re-grounding hooks for A10).

| # | Proposed Axiom | Principle | Status |
|---|----------------|-----------|--------|
| A8 | Traceable Accountability | Every governance/action/verdict must be replayable from evidence, provenance link, actor identity, policy version, and timestamp. Decision-level provenance, not just file-level hashes. | Proposed — concrete current implementation scope landed; broader coverage/enforcement is future backlog, not a current-plan blocker |
| A9 | Resilient Degradation | Component failure must degrade capability, not corrupt state or cascade. Fallback, circuit breaker, retry, and SLO behavior are governance contracts, not ad-hoc per-call defenses. | Proposed — concrete current implementation scope landed; broader enforcement coverage is future backlog, not a current-plan blocker |
| A10 | Goal-and-Time Grounding | Every execution phase must remain bound to root intent and evidence freshness. Stale or goal-drifted state downgrades confidence or triggers re-grounding/clarification. | Proposed — concrete current implementation scope landed; broader re-grounding policy coverage is future backlog, not a current-plan blocker |

Adversarial robustness remains a **corollary** of A6 + A8 + A9, not a separate axiom.

Use axioms to resolve architectural conflicts — not as a checklist for every line edit.

## Tech Stack

- **Runtime:** Bun (TypeScript, strict mode) — no npm/yarn/pnpm
- **Dependencies:** zod, chokidar — intentionally minimal
- **Database:** SQLite (via `bun:sqlite`)
- **Path alias:** `@vinyan/*` → `./src/*`
- **Lint/Format/Type:** Biome + tsc — `bun run check` runs both

## Project Structure (top-level)

```
src/
  core/           # EventBus, core types (HypothesisTuple, OracleVerdict, Evidence, Fact)
  oracle/         # RE infrastructure + per-language oracles (ast, type, dep, test, lint, go, python, rust, goal-alignment)
  gate/           # Verification pipeline (risk-router, quality-score, tool-classifier)
  guardrails/     # Prompt injection + agent contract enforcement (K1)
  orchestrator/   # Core Loop, phases, RE abstraction (llm/), fleet/, critic/, test-gen/, tools/, worker/
  world-graph/    # Content-addressed fact store
  evolution/      # Rule generator, backtester, safety invariants
  sleep-cycle/    # Pattern mining (Wilson CI, exponential decay)
  economy/        # Cost accounting, budget, market (Vickrey auction)
  db/, bus/, config/, cli/, mcp/, a2a/, api/, security/, observability/, dashboard/, hms/, tui/
tests/            # Mirrors src/ + integration/, ecp-conformance/, property/, benchmark-fixtures/, experiment/
```

For sub-module detail, read directories directly.

## Phase Status

> Verify against code before relying on this — drifts over time. Last reviewed: 2026-04-30.

Legend: **✅ Active** = wired in default `vinyan run` | **🔧 Built** = code+tests exist, needs config/data | **📋 Designed** = partial/stub

| Phase | Scope | Status | Activation Condition |
|-------|-------|--------|---------------------|
| 0 | Oracle Gate | ✅ Active | Always |
| 1 | Autonomous Agent | ✅ Active | Wired always; LLM dispatch requires `ANTHROPIC_API_KEY` or `OPENROUTER_API_KEY` (no key → empty provider registry, L0 no-op) |
| 6 | Agentic Worker Protocol | ✅ Active | Deps wired by default (`factory.ts:setAgentLoopDeps`); invoked at L2+ (`phase-generate.ts`). L0/L1 use single-shot dispatch. |
| K1 | Kernel Hardening | ✅ Active | Always |
| 2 | Evolution Engine | 🔧 Built | DB + ≥100 traces |
| 3 | Self-Model | 🔧 Built | DB; SelfModelStub fallback |
| 4 | Fleet Governance | 🔧 Built | DB + multiple LLM providers |
| 5 | ENS (API, TUI, A2A) | 🔧 Built | `vinyan serve` / `network.instances.enabled` |
| K2 | Trust-Weighted Dispatch | 🔧 Built | Provider trust data |
| E1-E4 | Economy OS | 🔧 Built | `economy.enabled: true` |
| O1-O5 | Agent Ecosystem | 🔧 Built | `ecosystem.enabled: true` — see `docs/design/vinyan-os-ecosystem-plan.md` §10 |

## Core Loop (high level)

```
Task → Intent Resolution → [conversational | direct-tool | agentic-workflow | full-pipeline]

full-pipeline: Budget → Perceive → Comprehend (L2+) → Predict → Plan → Generate → Verify → Learn
              ↑ escalation L0→L3 on verification fail (labeled `routingLoop:`, no double-escalation)
              ↑ L3 contradiction = terminal failure (no infinite retry)
```

Wiring lives in `src/orchestrator/factory.ts` + `core-loop.ts`. Full phase contracts: `docs/architecture/vinyan-os-architecture.md`.

**Protocols:**
- **ECP (internal):** JSON-RPC + epistemic semantics (confidence, evidence_chain, falsifiable_by, temporal_context)
- **MCP (external only):** tool access to outside world. NOT used for internal communication.
- **Oracle I/O:** stdin(HypothesisTuple JSON) → child process → stdout(OracleVerdict JSON)

**Reasoning Engine abstraction:**
- `ReasoningEngine` interface (`src/orchestrator/types.ts`) — primary abstraction for any generator (LLM, symbolic, AGI, external)
- `LLMReasoningEngine` adapter wraps `LLMProvider`
- `ReasoningEngineRegistry` — capability-first selection, tier-based fallback
- **Constraint:** subprocess path (L2/L3 isolation) is LLM-only. Non-LLM REs dispatch in-process with a warning.

## Risk Routing (4 Levels)

L0 Reflex (hash-only, <100ms) → L1 Heuristic (structural oracles, <2s) → L2 Analytical (all oracles, <10s) → L3 Deliberative (+shadow exec, <60s).

Thresholds + scoring: `src/gate/risk-router.ts` (`ROUTING_THRESHOLDS`, `calculateRiskScore()`).

## Coding Conventions

Biome enforces naming + format (`biome.json`): single quotes, 2-space, 120 cols, trailing commas. File names kebab-case; DB columns snake_case; types PascalCase; functions/vars camelCase.

**Architecture patterns:**
- Zod for all external boundaries (IPC, config, oracle I/O, API)
- EventBus for cross-module communication (FIFO, synchronous, type-safe)
- Dependency injection in `core-loop.ts` — wired by `factory.ts`
- Circuit breaker per oracle (failureThreshold=3, resetTimeout=60s)
- **Crash-safety invariant:** ShadowJob persisted BEFORE online TaskResult returns

## Quality Gates (enforced by review)

- **Wiring verification** — no component is "done" until its function appears in a runtime trace. Build + wire + verify in same PR.
- **Behavior tests only** — `toHaveProperty` alone is forbidden. Every test must call a function and verify output/side-effects.
- **Benchmark gate** — run `bun run test:benchmark` before merging changes to core orchestrator (phases, core-loop, perception, agent-loop).
- **Smoke test gate** — run `bun run test:smoke` with a real API key before declaring any session "done". Mock-only tests do NOT prove the system works.
- **HMS integration** — hallucination analysis runs in phase-verify after oracle verification. Confidence is attenuated by HMS risk score.
- **Honest status** — a feature is ✅ Active ONLY when it runs in default `vinyan run` without extra config.

## Known Gaps

```bash
grep -rn "TODO\|FIXME\|HACK" src/ --include="*.ts"
```

Architectural gaps: `docs/architecture/decisions.md` and `docs/spec/tdd.md` §15 (Open Questions).

Currently open:
- L3 container isolation (Phase 3 target)
- Synchronous four-phase commit for L2/L3 — shadow execution currently runs async post-return (`shadow-runner.ts:enqueue`); concept §7 specifies blocking Shadow → Commit. Acceptable for Phase 0/1; must become blocking before Phase 2 container hardening.
- Active task resumption (auto-abandons on restart)
- Biome lint cleanup
- A8/A9/A10 broader enforcement coverage (MVPs landed; see §1.1.1 in concept.md for promotion gates)

## Concurrent Sessions

Multiple Claude sessions may operate this workspace in parallel. Commit gating (`touch ~/.claude/.commit-authorized && git commit ...`) lives in `~/.claude/CLAUDE.md`. If `git status --short` shows files you didn't touch this turn, another session may be writing — diff before staging.

## Commands

```bash
bun run test                # Unit tests (~5s)
bun run test:integration    # Gate/oracle/orchestrator (~30s)
bun run test:all            # Unit + integration (~140s)
bun run check               # tsc + biome
bun run test:benchmark      # E2E with phase timing
bun run test:smoke          # Real LLM (needs API key)
bun run build:worker        # Bundle worker-entry.ts
```

### Terminal Execution Rules (MUST follow)

- **NEVER run `bun test` or `bun run test*` with `2>&1`** — redirecting stderr merges Bun's TTY progress output and hangs the terminal.
- **NEVER pipe test commands** (`bun test | tee`, `| cat`) — same hang issue.
- **Always scope tests** to specific files: `bun test tests/path/to/file.test.ts`. Full-suite only when shared types change.
- **For long output**, use the runner's filters (`--reporter`, `-t <pattern>`) instead of shell pipes.
- **Timeout** — wrap with explicit `--timeout 30000` if hang suspected; do not retry in a tight loop.

## Design Documents (read before major changes)

- `docs/foundation/concept.md` — Vision, axioms, ECP protocol, RE model
- `docs/architecture/decisions.md` — Decisions D1-D8
- `docs/spec/tdd.md` — Implementation contracts, schemas, algorithms
- `docs/architecture/vinyan-os-architecture.md` — Authoritative architecture doc (v5)
- `docs/design/implementation-plan.md` — Phased roadmap
- `docs/design/multi-agent-hardening-roadmap.md` — Deferred items from the multi-agent honesty contract (provider fallback, semaphore, recursion guard, threshold tuning, mid-stream cancel)

## Key Design Principles

1. **Reuse first** — search existing code before creating modules
2. **Backwards compatible** — don't break Phase 0 when building Phase 1
3. **Data gates** — Phase 2 features auto-activate when data sufficient (≥100 traces, ≥5 task types)
4. **Statistical rigor** — Wilson CI, backtesting before rule promotion, exponential decay
5. **Progressive isolation** — L0=in-process, L1-L2=subprocess, L3=container (Phase 3)
6. **Protocol honesty** — `type:'unknown'` over hallucination
