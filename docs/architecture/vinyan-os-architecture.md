# Vinyan OS — AGI Economy Operating System Architecture

> 🔧 **Status: Mixed (As-Is + To-Be).** O1 (runtime FSM) and the K1 + K2 kernels are wired. **O2–O5** (commitment ledger, departments, volunteer protocol, coordinator) are **🔧 Built — gated behind `ecosystem.enabled: true`**. The "2027 economy activation targets" + cross-instance economy described below are **To-Be**.

> **Document boundary**: This document owns the **OS identity and thesis, axiom-to-kernel mapping, current position assessment, K1/K2 roadmap, 2027 economy activation targets, competitive landscape, research tracks, and milestone gates**.
> For axiom definitions and paradigm vision → [concept.md](../foundation/concept.md).
> For academic foundations and LLM deadlocks → [theory.md](../foundation/theory.md).
> For concrete implementation decisions D1-D19 → [decisions.md](decisions.md).
> For K1/K2 implementable design → [k1-implementable-system-design.md](../design/k1-implementable-system-design.md).
> For ECP wire protocol → [ecp-spec.md](../spec/ecp-spec.md).
> For worker IPC and tool authorization → [agentic-worker-protocol.md](../design/agentic-worker-protocol.md).
> For A2A protocol → [a2a-protocol.md](../spec/a2a-protocol.md).
> For task classification and routing invariants → [task-routing-spec.md](../foundation/task-routing-spec.md).

**Date:** 2026-04-09
**Status:** v5 — K1 complete, K2 complete, Economy OS (E1-E4) implemented. All G0-G13 gates passing. LOC verified via `wc -l`.
**Audience:** Contributors, architecture reviewers, potential collaborators, future agents

---

## 1. What "AGI Economy Operating System" Means

Vinyan is not AGI. Vinyan does not claim to be AGI.

**Vinyan is an operating system kernel designed so that reasoning engines at any intelligence level — including future AGI-grade ones — can safely participate in a verified economy.** The kernel's correctness guarantees do not depend on any individual engine's intelligence. Whether the participants are current LLMs, symbolic solvers, proof assistants, humans, or future AGI engines, the economy remains trustworthy through architectural invariants — not through trusting any single engine.

The analogy: Linux doesn't need to understand what programs do. It provides process isolation, resource management, and security so that ANY program — including ones that haven't been written yet — can safely run. Vinyan does the same for reasoning engines.

Three properties make it an operating system, not a framework:

| Property | What It Means | Why It Matters |
|----------|--------------|----------------|
| **Kernel-space governance** | Routing, verification, and commit decisions are rule-based and state-reproducible. No probabilistic engine participates in governance (A3). | As engine intelligence increases, governance correctness doesn't degrade. A framework that uses an LLM to coordinate agents breaks when agents become smarter than the coordinator. |
| **Engine-agnostic scheduling** | The kernel schedules reasoning engines (LLMs, solvers, provers, humans) without knowing their internal architecture. All engines communicate through ECP. | New engine types enter the economy by implementing one interface (`ReasoningEngine`). The kernel requires zero changes ([D19](decisions.md)). |
| **Verified economy** | Every task outcome is independently verified. Trust is earned through verification, not declared. Reputation is content-addressed and tamper-evident. | The economy remains trustworthy even if individual engines are adversarial, unreliable, or unknown. |

"AGI Economy" describes the **design target**, not the current state. K1-K2 (2026) built the kernel primitives — contracts, trust scoring, concurrent dispatch, market mechanism (Vickrey auction + settlement) — that **enable** an economy. The economy infrastructure (E1-E4) is implemented and activates when agent population and trust data warrant competitive allocation. Until then, Vinyan is an **epistemic orchestration kernel with a verification layer and economy infrastructure**. This is an architectural claim about the kernel, not a capability claim about the engines.

### 1.1 The OS Analogy — Where It Holds and Where It Doesn't

| Traditional OS | Vinyan OS | Status |
|---|---|---|
| Schedules **processes** on CPUs | Schedules **reasoning engines** on tasks | **Holds** — both allocate heterogeneous compute to heterogeneous work |
| **Process isolation** — no process reads another's memory | **Epistemic separation (A1)** — no engine evaluates its own output | **Holds** — both prevent single-component corruption |
| **Ring 0 kernel mode** — deterministic, trusted | **Deterministic governance (A3)** — rule-based, no LLM in decision path | **Holds** — both keep governance outside untrusted code |
| **Capability-based security** (seL4) | **Capability scope** — agents get explicit operation authorization | **Holds as principle** — Vinyan lacks seL4's formal mathematical proof |
| **Content-addressed filesystem** (Git, IPFS) | **Content-addressed truth (A4)** — facts bound to SHA-256 file hash | **Holds** — both guarantee data integrity through content addressing |
| **System calls** — structured user/kernel boundary | **ECP** — epistemic protocol with confidence + evidence | **Holds** — both define the trusted/untrusted boundary |
| **Error handling** — `ENOENT`, `EPERM` | **First-class uncertainty (A2)** — `type: 'unknown'` is a valid state | **Holds** — both treat "I don't know" as information, not failure |
| **Adaptive scheduling** — runtime feedback | **Prediction error (A7)** — calibration from delta(predicted, actual) | **Holds** — both use runtime data to improve future decisions |
| **Hardware abstraction** — works on any CPU | **Engine abstraction** — `ReasoningEngine` interface accepts any engine type | **Holds as interface design** — only LLM engines currently implement it. `symbolic`, `oracle`, `hybrid`, `external` engine types are defined but untested. |
| Millions of production deployments | Pre-production (~53K LOC, 1,396 tests) | **Does not hold yet** |
| Formally verified (seL4) | Test-verified | **Does not hold** — tests ≠ proofs. Formal verification is a research target (§8.1) |

**Honest framing:** Vinyan applies OS design principles (isolation, deterministic governance, capability security) to reasoning engine orchestration. It is a kernel in the architectural sense — not the systems-programming sense. It doesn't manage hardware, CPUs, or memory. It runs as a userspace process inside Bun. The "kernel boundary" is a function-call boundary inside a single process, not a CPU privilege ring. The closest existing analogy is **Kubernetes for reasoning engines** — but with a verification layer that Kubernetes lacks, and an epistemic protocol (ECP) that no container orchestrator carries.

---

## 2. Architectural Thesis

### 2.1 The Core Insight

**AGI-grade reliability emerges from correct epistemic architecture, not from larger LLMs.**

This follows directly from a structural limitation of autoregressive language models: they process all tokens uniformly, making deterministic command-data separation unattainable through training alone [1]. Alignment techniques can reduce but cannot eliminate the risk of governance decisions being influenced by probabilistic reasoning.

Vinyan's response: **move governance out of the probabilistic engine entirely**. The kernel makes routing, verification, and commit decisions through deterministic rules. The engine generates; the kernel governs. This separation is enforced at every layer:

- **Understanding:** Task intent classification is rule-based (regex + frame analysis, [task-routing-spec.md](../foundation/task-routing-spec.md))
- **Routing:** Risk scoring uses a weighted formula with 7 static-analysis factors — no LLM ([D4](decisions.md))
- **Verification:** Oracle verdicts are independent of the generating engine — AST, type-check, test, lint, dep-analysis
- **Commit:** Artifact commit requires oracle approval — workers propose, kernel disposes (A6)
- **Learning:** Prediction error is computed from objective deltas, not LLM self-assessment

### 2.2 Independent Validation

The following research independently validates the same architectural principles, **published after** Vinyan's axioms were defined (2025):

| Vinyan Axiom | Independent Validation | Source | Status |
|---|---|---|---|
| **A3** Deterministic Governance | "Trustworthy Agentic AI Requires Deterministic Architectural Boundaries" — autoregressive LMs cannot provide deterministic command-data separation; governance must be architectural, not learned | arXiv:2602.09947 [1] | Preprint (Feb 2026) |
| **A6** Zero-Trust Execution | Same paper's "Trinity Defense Architecture" — action governance via finite action calculus + reference monitor, privilege separation | arXiv:2602.09947 [1] | Preprint (Feb 2026) |
| **Resource-bounded contracts** | "Agent Contracts" — formal framework for resource bounds with conservation laws. Motivated by real incident: agent in recursive clarification loop for 11 days, $47K API bill. Results: 90% token reduction, 525x lower variance | arXiv:2601.08815 [2] | **Peer-reviewed** (COINE/AAMAS 2026) |
| **Agent behavioral specs** | "Agent Behavioral Contracts (ABC)" — formal behavioral specifications with probabilistic compliance guarantees, drift detection | arXiv:2602.22302 [3] | Preprint (Feb 2026) |
| **Agent economies** | "Virtual Agent Economies" (Google DeepMind) — sandbox economy framework, auction mechanisms, systemic risk from AI economies | arXiv:2509.10147 [4] | Preprint (Sep 2025) |
| **Formal protocol verification** | "SentinelAgent" — TLA+ model checking verifies delegation chains across 2.7M states with zero safety violations | arXiv:2604.02767 [6] | Preprint (Apr 2026) |

**What these validations prove:** The principles underlying Vinyan's design converge with independent industry and academic research. **What they don't prove:** That Vinyan's specific implementation is correct, complete, or production-ready.

### 2.3 What Vinyan Has That No One Else Does

Based on systematic review of LangGraph, CrewAI, AutoGen, OpenAI Agents SDK, Microsoft Agent Governance Toolkit, Letta, PwC Agent OS (§9):

| Novel Contribution | Description | Why Novel |
|---|---|---|
| **ECP (Epistemic Communication Protocol)** | Wire protocol carrying confidence, evidence chains, falsifiability, and temporal context as first-class fields. 22 message types across 5 groups. | Builds on lessons from FIPA ACL (semantic richness, died from implementation weight) and A2A/MCP (lightweight transport, no epistemic semantics). ECP occupies the sweet spot: semantic richness on lightweight JSON-RPC. `confidence_source` field enforced in gate decisions (K1.0) — `llm-self-report` filtered from governance. |
| **Content-addressed truth with auto-invalidation** | SHA-256 fact binding + auto-invalidation (eager deletion on file hash change + lazy staleness check at query time) + cascade via dependency edges. | Content addressing itself is well-established (git, IPFS, Datomic). The novel combination is: content-addressed facts + file-hash-based auto-invalidation + cascade deletion for agent knowledge management. No competing agent framework tracks fact provenance this way. |
| **Wilson lower-bound trust progression** | Agent reputation computed via Wilson confidence interval — conservative for small samples, deterministic, proven in ranking systems. | Wilson LB is well-established in ranking systems (Reddit, Yelp, Stack Overflow since 2009). The novel application is to AI agent trust scoring — no published literature applies it in this context. A straightforward but effective domain transfer. |
| **Prediction error as learning signal (A7)** | Self-Model predicts task outcome before execution; delta(predicted, actual) drives EMA calibration of routing decisions. | Standard supervised learning concept (calibrate predictor from prediction error). Novel in agent orchestration context — no other agent OS uses prediction error to self-calibrate routing. Practical limitation: cold-start at ~50% accuracy, requires ~50 observations to reach `hybrid` basis, ~100+ for meaningful improvement. |
| **4-state epistemic decision** | Gate decisions are allow / allow-with-caveats / block / abstain — not binary pass/fail. | Other systems use binary verdicts. Richer than binary but not unprecedented — HTTP status codes have hundreds of states. The value is in the semantics: abstain means "insufficient evidence to decide" and triggers different orchestrator behavior than block. |
| **Subjective Logic fusion for oracle conflicts** | Josang K-threshold conflict detection with domain-separated cumulative fusion. Cross-domain conflicts resolve by tier precedence; same-tier conflicts resolve by SL algebra. | Josang's SL has been applied to trust management systems in academic literature. Novel in agent oracle conflict resolution — no competing framework uses formal uncertainty algebra for multi-oracle disagreements. |

---

## 3. The 7 Axioms as OS Kernel Primitives

Each axiom maps to a concrete kernel subsystem with running code. Full axiom definitions in [concept.md §1.1](../foundation/concept.md).

| # | Axiom | OS Primitive | Kernel Subsystem | Key Code | LOC | Maturity |
|---|-------|-------------|-----------------|----------|-----|----------|
| **A1** | Epistemic Separation | Process isolation | Oracle Gate — independent engines verify each layer | `gate/gate.ts`, `conflict-resolver.ts` | ~823 | Tested |
| **A2** | First-Class Uncertainty | Error codes (`EUNKNOWN`) | ECP — `type: 'unknown' | 'uncertain' | 'contradictory'` propagates | `core/types.ts`, `a2a/ecp-data-part.ts` | ~336 | Functional |
| **A3** | Deterministic Governance | Kernel mode (ring 0) | Core Loop — rule-based routing/verification/commit, zero LLM | `core-loop.ts`, `gate/risk-router.ts` | ~2,273 | Tested |
| **A4** | Content-Addressed Truth | Content-addressed FS | World Graph — SHA-256 content addressing + cascade invalidation | `world-graph/world-graph.ts` | ~436 | Functional |
| **A5** | Tiered Trust | Security levels | Confidence clamping per tier — deterministic > heuristic > probabilistic. `llm-self-report` filtered from gate decisions (K1.0). | `oracle/tier-clamp.ts`, `core/subjective-opinion.ts`, `gate/gate.ts` | ~683 | Tested |
| **A6** | Zero-Trust Execution | Sandboxing / jail | Worker isolation — propose/dispose via IPC, AgentContract (K1.2), `authorizeToolCall()` (K1.3), Docker sandbox | `worker/agent-loop.ts`, `worker/sandbox.ts`, `core/agent-contract.ts` | ~780 | Tested |
| **A7** | Prediction Error as Learning | Adaptive scheduling | Self-Model — per-task-type EMA calibration from delta(predicted, actual) | `orchestrator/self-model.ts` | ~673 | Functional |

**Total kernel code:** ~53K LOC across 336 source files. **Test suite:** 285 test files, 1,396 tests.

**Maturity legend:** "Tested" = passes its test suite with comprehensive coverage. "Functional" = working but less battle-tested. **Neither** means production-ready — production readiness requires real-world deployment, incident handling, and performance validation under load, none of which have occurred.

**A5 enforced (K1.0):** `confidence_source: 'llm-self-report'` verdicts are now filtered from gate decisions in `gate.ts`. Deterministic evidence is separated from probabilistic evidence as A5 requires.

**A6 enforced (K1.2+K1.3):** `createContract()` issues AgentContract at dispatch. `authorizeToolCall()` enforces capability scope in agent-loop. Guardrails block at entry (K1.5).

### 3.1 The Three-Tier Mental Model — Operator Vocabulary

> **Where it comes from:** adapted from the *Multi-Agent Orchestration* field guide
> (Soul Brews Studio, see [`book-integration-overview.md`](book-integration-overview.md)).
> The book's three-tier taxonomy is a *mental model for operators*, not a new subsystem.
> Vinyan already runs three distinct classes of agent — this section gives them a shared
> vocabulary so operators can say "that's a Tier 2 failure" in one sentence instead of
> three paragraphs of protocol jargon.

The kernel already distinguishes three classes of agent along the *governance trust*
axis. None of them are in-process subagents — Vinyan rejects Tier 1-as-coroutine because
it violates **A1** (Epistemic Separation requires the generator to be a separate
process). The three tiers are:

| Tier | What it is | Where it runs | Governance boundary | Axiom anchor |
|------|------------|---------------|---------------------|--------------|
| **Tier 1 — Worker** | A single agent loop that owns one task. Subprocess spawned by `runAgentLoop`, communicates over JSON-newline IPC, scoped by an `AgentContract`. | `src/orchestrator/worker/agent-loop.ts`, spawned via `Bun.spawn` | Contract-bounded: tool whitelist, token budget, turn cap, file scope | **A6** (zero-trust execution) |
| **Tier 2 — Swarm** | A group of Tier-1 workers coordinated by the orchestrator for one logical goal. DAG nodes execute in parallel via `ConcurrentDispatcher` with file-lock arbitration, or as a research swarm preset (Wave 1.2). | `src/orchestrator/concurrent-dispatcher.ts`, `task-decomposer-presets.ts`, `dag-executor.ts` | Rule-based scheduling: file-lock conflict detection, topological parallelism, no LLM in coordination path | **A3** (deterministic governance) |
| **Tier 3 — Fleet** | A population of workers (local and remote instances) that a `FleetCoordinator` routes across over time. Includes peer instances discovered via A2A, trust-weighted selection, and lifecycle transitions (probation → active → retired). | `src/orchestrator/fleet/`, `src/a2a/`, `src/orchestrator/instance-coordinator.ts` | Deterministic selection: Wilson LB scoring, capability matching, trust thresholds per level | **A1 + A3 + A5** (separation, governance, tiered trust) |

**How to use the vocabulary** (rules of thumb for operators):

1. *"Is it stuck?"* — one worker going silent is a **Tier 1** event. The guardrail that
   detects this is the silent-agent watchdog in `src/guardrails/silent-agent.ts` (Wave 1.1).
   Symptom: `guardrail:silent_agent` event on the bus.
2. *"Is the plan wrong?"* — the workers are fine individually but produce conflicting
   mutations. That's a **Tier 2** event — look at `ConcurrentDispatcher`'s file-lock
   arbitration or the DAG nodes. Symptom: repeated `commit:rejected` from the same
   task-group.
3. *"Is the population regressing?"* — individual tasks succeed but overall success rate
   is drifting. That's a **Tier 3** event. Look at `WorkerLifecycle` stats, sleep-cycle
   anti-pattern output, and `monitoring:silent_regression` alerts.

**What Vinyan rejects from the book's Tier 1 model:** in-process subagents — functions
called *inside* the orchestrator's own runtime. Vinyan requires the generator to live
in a separate subprocess so **A1** is enforced by the OS boundary, not by a comment in
the code. Any ergonomic gain from coroutines is not worth the epistemic-separation
regression.

---

## 4. Current Kernel State — Verified Against Code

Every claim in this section has been verified by reading source code as of 2026-04-09, not documentation.

### 4.1 Tested Subsystems (Comprehensive Test Coverage, Zero Production Deployment)

| Subsystem | LOC | Key Capabilities | Verified Limitations |
|---|---|---|---|
| **Core Loop** (`core-loop.ts`) | ~2,500 | Full 6-step lifecycle; dual routing/retry loop; STU layers 0-2; **LLM Intent Resolver** (pre-routing strategy classification with 4 strategies: `conversational`, `direct-tool`, `agentic-workflow`, `full-pipeline` — short-circuits non-pipeline tasks, skipped for code-mutation/targetFiles); ForwardPredictor; cross-task learning; delegation; approval gate; global budget cap; K2.2 engine selector integration; K2.3 `executeTaskBatch()` for concurrent dispatch | Critic engine and test generator are optional (skip if absent). Intent Resolver requires LLM provider; falls back to regex classification when unavailable. |
| **Oracle Gate** (`gate/gate.ts`) | 476 | 6 oracle types dispatched concurrently via `Promise.all`; circuit breaker (3 failures → open, 60s reset); risk-tier-based oracle filtering; SL cumulative fusion; 4-state epistemic decision (allow/allow-with-caveats/block/abstain); QualityScore | Risk tiering only active when `riskScore` explicitly passed by caller. Circuit breaker is module-level singleton — one flaky oracle affects all sessions until process restart. |
| **Risk Router** (`gate/risk-router.ts`) | 204 | 7-factor weighted risk formula; 4 routing levels (L0: null/0/100ms, L1: haiku/10K/15s, L2: sonnet/50K/30s, L3: opus/100K/120s); epistemic de-escalation (oracle confidence ≥ 0.85); ForwardPredictor escalation (break probability > 0.5 → L2 floor); production env → L2 floor | File mutation tools (write/create/replace) have irreversibility = 0.0. Risk depends on blast radius and other factors to reach meaningful scores. |
| **Conflict Resolver** (`conflict-resolver.ts`) | 347 | SL-based Josang K-threshold resolution; domain separation (structural/quality/functional); accuracy tiebreaker in ambiguous K zone (0.3-0.7); SL cumulative fusion for same-tier conflicts | Originally designed as a 5-step tree — actual code is a 3-path tree. SL fusion replaced the evidence-count step with a more principled approach. |
| **Worker Pool** (`worker-pool.ts`) | 967 | In-process L1+ dispatch via `LLMProviderRegistry`/`ReasoningEngineRegistry`; warm subprocess pool with `Bun.spawn` + JSON-newline IPC; per-level semaphores (L1=5, L2=3, L3=1); cache token tracking | Warm pool is for single-shot subprocess path only. Agentic loop (L2+ multi-turn) spawns fresh subprocess per session. |
| **Agent Loop** (`agent-loop.ts`) | 458 | Multi-turn agentic sessions (L2+); per-turn cap (`maxToolCallsPerTurn`) + session cap (`remainingToolCalls`); transcript compaction (fires at >70% token pressure, >5 turns); delegation via recursive `executeTask`; guardrail scan on every tool result; non-retryable error detection (401/403) | Always spawns fresh subprocess via `agent-worker-entry.ts`. Compaction is structure-preserving but not semantic. |
| **DAG Executor** (`dag-executor.ts`) | 162 | Topological parallelism per level via `Promise.all`; file conflict detection → full sequential fallback; cycle handling (catch-all level) | Binary parallel/sequential decision — no partial parallelism for mixed conflicts. Conservative by design. |
| **LLM Abstraction** (13 files) | ~2,234 | `ReasoningEngine` interface; `LLMReasoningEngine` adapter wrapping `LLMProvider`; 3 providers (Anthropic, OpenRouter, Mock); prompt assembler; thinking policy translator; perception compressor | Only LLM engines currently implement `ReasoningEngine`. `symbolic`, `oracle`, `hybrid`, `external` engine types are typed but have zero implementations. Non-LLM engines dispatch in-process only. |

### 4.2 Functional Subsystems (Working, Less Battle-Tested)

| Subsystem | LOC | Key Capabilities | Verified Limitations |
|---|---|---|---|
| **World Graph** (`world-graph.ts`) | 436 | SHA-256 content-addressed fact dedup; lazy hash-based staleness (LEFT JOIN excludes hash-mismatched facts); eager `falsifiable_by` deletion on file hash change; temporal decay at read time (linear/step/exponential/none); structural `dependency_edges` + observed `causal_edges` with BFS traversal; failed verdict archive | File watcher integration is in separate `file-watcher.ts`. `hot-fact-index.ts` and `dep-cone-index.ts` are external acceleration structures. WAL checkpoints on graceful close but not on crash (200-page autocheckpoint mitigates). |
| **Evolution Engine** (6 files) | ~1,273 | Rule generation: 4 types (escalation, prefer-model, assign-worker, require-oracle); backtester: 80/20 temporal split with anti-lookahead, effectiveness ≥ 0.5 + zero false positives; safety invariants; counterfactual analysis; pattern abstraction | Rules start in `probation` status. Promotion to `active` requires sleep cycle trigger. Minimum 100 traces before activation — weeks of real use. |
| **Sleep Cycle** | ~1,175 | Periodic trigger (every 20 sessions); Wilson LB pattern detection (anti-pattern LB ≥ 0.6, success LB ≥ 0.15); cross-task correlation analysis; exponential decay on pattern weights; rule promotion pipeline | In-memory state resets on process restart. 100-trace minimum means the system must run for weeks before self-improvement activates. |
| **A2A Layer** (31 files) | ~4,800 | `A2AManager` with 13 feature-flagged sub-managers; 20+ ECP message types routed; 4 transports (Stdio: subprocess oracle, HTTP: stateless POST, WebSocket: persistent with heartbeat/reconnect/dedup, A2A: full Google A2A JSON-RPC); peer discovery, trust attestation, gossip, negotiation, streaming, commitment tracking | Default-disabled (`network.instances.enabled` not set). No cross-instance integration test with real peer delegation. ~4,800 LOC for a default-disabled feature is significant maintenance overhead. |
| **ECP Protocol** (distributed) | ~858 | Full type hierarchy with Zod schemas (`types.ts` 193 + `ecp-data-part.ts` 143 + `subjective-opinion.ts` 522); 22 message types across 5 groups; `SubjectiveOpinion` tuple with cumulativeFusion, temporalDecay; 4 epistemic states; `confidence_source` taxonomy | `confidence_source` governance now enforced (K1.0) — `llm-self-report` verdicts filtered from gate decisions. |
| **Guardrails + Security** | ~808 | 25 detection patterns (13 injection + 12 bypass); Unicode NFC normalization; 3-tier RBAC; Bearer token auth; mTLS; Docker sandbox for L3; AgentContract capability enforcement (K1.2+K1.3); `authorizeToolCall()` wired in agent-loop | `validateInput()` blocks at `executeTask()` entry (K1.5). `authorizeToolCall()` enforces contract capabilities in agent-loop (K1.3). `sanitizeForPrompt()` retained as deprecated defense-in-depth. |

### 4.3 Architectural Constraints (Discovered in Code, Not in Docs)

| Constraint | Impact |
|---|---|
| Bun-only runtime (`Bun.spawn`, `bun:sqlite`, `import.meta.dir`) | Not Node.js-compatible without adaptation |
| L0 is truly a no-op — `model: null`, `budgetTokens: 0` | L0 value comes from cached skills only; oracle gate still runs |
| Oracle circuit breaker is module-level singleton in `gate.ts` | One flaky oracle can affect all sessions until process restart |
| STU Layer 2 re-runs per inner loop iteration at L2+ | Each retry re-runs LLM understanding enrichment, consuming tokens |
| Global token cap is 6× per-task budget | At L3 (100K), this means 600K tokens absolute maximum per task |
| SL fusion skips L0-L1 | Low routing levels use pure dominance rules, not SL algebra |
| ~~`confidence_source` not enforced~~ | **RESOLVED (K1.0)** — `llm-self-report` verdicts now filtered from gate decisions in `gate.ts` L330. A5 compliance restored. |
| ~~No crash recovery design~~ | **MVP implemented** — `TaskCheckpointStore` persists pre-dispatch state, startup recovery auto-abandons interrupted tasks, emits `task:recovered` events. Sleep cycle state still resets on restart. Active task resumption deferred. |

### 4.4 Remaining Blockers for Economy OS

| # | Blocker | Current State | Severity | Target |
|---|---|---|---|---|
| **B1** | ~~Guardrails strip-not-block~~ | **✅ RESOLVED** — `validateInput()` blocks at entry (K1.5). `authorizeToolCall()` wired in agent-loop (K1.3). | ~~CRITICAL~~ → **Resolved** | K1.5 ✅ + K1.3 ✅ |
| **B2** | ~~No cross-task concurrent dispatch~~ | **✅ RESOLVED** — `ConcurrentDispatcher` + `AdvisoryFileLock` + `executeTaskBatch()` (K2.3). 3+ tasks concurrent, wall-clock < sum (G8 passing). | ~~HIGH~~ → **Resolved** | K2.3 ✅ |
| **B3** | ~~A2A default-disabled~~ | **✅ RESOLVED** — A2A integration tested (K2.4). `InstanceCoordinator` delegation wired in phase-predict. 15 gate tests passing. | ~~MEDIUM~~ → **Resolved** | K2.4 ✅ |
| **B4** | ~~Agent Contract not wired~~ | **✅ RESOLVED** — `createContract()` called in core-loop. Contract flows through dispatch → agent-loop. `authorizeToolCall()` enforces capabilities (K1.2+K1.3). | ~~HIGH~~ → **Resolved** | K1.2 ✅ + K1.3 ✅ |
| **B5** | ~~`confidence_source` A5 violation~~ | **✅ RESOLVED** — `gate.ts` filters `llm-self-report` verdicts from gate decisions (K1.0). A5 compliance restored. | ~~CRITICAL~~ → **Resolved** | K1.0 ✅ |

---

## 5. K1: Kernel Hardening (2026 Q2-Q3)

> **Goal:** Make the kernel trustworthy enough that multiple agents can safely operate within it.

K1 resolves security blockers and adds primitives required before multi-agent operation. Full implementation design in [k1-implementable-system-design.md](../design/k1-implementable-system-design.md).

### 5.1 Deliverables

| ID | Deliverable | Status | Key Files | Completed |
|---|---|---|---|---|
| **K1.0** | `confidence_source` enforcement | **✅ Done** | `gate/gate.ts` L330 | `llm-self-report` verdicts filtered from gate decisions. A5 violation resolved. |
| **K1.5** | Guardrails: block-not-strip | **✅ Done** | `guardrails/index.ts`, `core-loop.ts` | `validateInput()` blocks at `executeTask()` entry. |
| **K1.1** | Contradiction escalation wiring | **✅ Done** | `core-loop.ts` | Labeled loop `routingLoop:` + `continue routingLoop`. L3 contradiction is terminal. |
| **K1.2** | Agent Contract wiring | **✅ Done** | `core/agent-contract.ts`, `core-loop.ts`, `agent-loop.ts` | `createContract()` called after routing, contract flows through dispatch. |
| **K1.3** | Tool-level capability scope | **✅ Done** | `security/tool-authorization.ts`, `agent-loop.ts` | `authorizeToolCall()` enforced in agent-loop with violation policy. |
| **K1.4** | ECP validation middleware | **✅ Done** | `a2a/*-transport.ts`, `oracle/runner.ts`, API schemas | Zod schemas on HTTP+WS endpoints, oracle runner. |

**Key insight:** K1.2 + K1.3 are **one wiring task**, not two. Both require threading `AgentContract` through the dispatch path to the agent loop. Doing K1.2 unblocks K1.3 for free.

### 5.2 Implementation Priority (Risk-Ordered)

1. **K1.0** — `confidence_source` enforcement. ~20 LOC in `gate.ts`: filter oracle results where `confidenceSource === 'llm-self-report'` from gate decisions. Closes A5 violation immediately. No architectural risk.
2. **K1.2 + K1.3** — Contract wiring. Call `createContract()` after routing in `executeTask()`, pass contract through dispatch, replace `fromRouting()` with `fromContract()`, add `authorizeToolCall()` before tool execution. Design aligned with Agent Contracts paper [2].
3. **K1.1** — Contradiction escalation. Wire `hasContradiction` → auto-escalation in core loop.
4. **K1.4** — ECP validation middleware across all 4 transports.

### 5.3 K1 Gate (Exit: End of 2026 Q3)

All criteria are boolean. ALL must pass before K2 begins. **Status: ALL PASSING ✅**

| # | Criterion | Status | Test Method |
|---|---|---|---|
| G0 | `llm-self-report` confidence excluded from gate decisions | **✅ PASS** | Unit: oracle with `confidenceSource: 'llm-self-report'` → excluded from epistemic decision |
| G1 | Contradiction at L1 → auto-escalate to L2 | **✅ PASS** | Integration: contradictory oracle verdicts at L1 → core loop escalates |
| G2 | Agent contract wired: `createContract()` called at dispatch | **✅ PASS** | Integration: contract flows from core-loop → worker-pool → agent-loop |
| G3 | Agent without `file_write` capability → REJECTED | **✅ PASS** | Unit: unauthorized tool call → error response, not silent strip |
| G4 | All 4 transports reject messages missing `ecp_version` | **✅ PASS** | Unit: per-transport validation test |
| G5 | Injection detected at `executeTask()` entry → REJECT | **✅ PASS** | Unit: injection pattern → rejection + audit, input never reaches LLM |
| G6 | All existing tests pass | **✅ PASS** | `bun run test` — 1,396 tests, 0 failures |
| G7 | Zero type errors | **✅ PASS** | `tsc --noEmit` passes |

---

## 6. K2: Trust-Weighted Multi-Agent Dispatch (2026 Q3-Q4)

> **Goal:** Enable multiple reasoning engines to work on independent tasks concurrently, with trust-weighted selection.

K2 depends on K1. Without Agent Contracts (K1.2) and capability scope (K1.3), the kernel can't enforce resource bounds on concurrent agents.

### 6.1 Scope Decision: Trust-Weighted Routing First, Market Auction Later

The v2 architecture proposed a full bid-based auction market with collateral staking, bid accuracy decay, and dynamic pricing. **This is premature for the current agent population.**

| Full Market Auction | Trust-Weighted Routing (K2) |
|---|---|
| Agents submit bids with estimated cost/quality | Kernel selects engine by historical trust + capability match |
| Anti-gaming mechanisms (collateral slashing, bid accuracy decay) required | No adversarial assumptions — engines are kernel-registered |
| Meaningful with ≥10 competing external agents | Meaningful with ≥2 internal engines (different providers) |
| Game-theoretic correctness is notoriously hard to verify | Deterministic scoring formula is trivially verifiable (A3) |
| Research actively ongoing [4][5][11] | Proven pattern (reputation-weighted selection) |

**Decision:** K2 implements trust-weighted routing. Market auction activates in 2027 Q2 when agent population and trust data warrant competitive allocation. The infrastructure built in K1-K2 (Trust Ledger, AgentContract, A2A) is prerequisite for either approach.

**Why not market from the start:** Game-theoretic mechanisms have a well-documented history of being hard to get right [11]. LLM agents in market settings learn collusive pricing without explicit instruction (arXiv:2601.11369). Anti-gaming mechanisms require empirical tuning with real adversarial pressure. Building market infrastructure for <10 agents is over-engineering. Trust-weighted routing delivers 80% of the value at 20% of the risk.

### 6.2 Trust Ledger — Wilson Lower Bound

Wilson LB is already implemented in `sleep-cycle/wilson.ts` (44 LOC, production-ready). K2 applies it to per-agent, per-capability trust scoring.

```sql
CREATE TABLE agent_trust (
  agent_id       TEXT NOT NULL,
  capability     TEXT NOT NULL,      -- e.g., 'code-mutation', 'test-generation'
  successes      INTEGER DEFAULT 0,
  failures       INTEGER DEFAULT 0,
  total_tasks    INTEGER DEFAULT 0,
  trust_score    REAL DEFAULT 0.0,   -- Wilson lower bound (z=1.96, 95% CI)
  last_updated   TEXT NOT NULL,
  evidence_hash  TEXT NOT NULL,      -- SHA-256 of latest evidence (A4)
  PRIMARY KEY (agent_id, capability)
);
```

**Trust dynamics:**
- New agent: Wilson LB with 0/0 → ~0.0 (conservative)
- After 10 successes, 0 failures → ~0.72 (still cautious)
- After 100 successes, 2 failures → ~0.93 (well-proven)
- Decay: exponential when inactive (reuses `decay-experiment.ts` from sleep cycle)
- Update: oracle-verified outcome → increment successes or failures → recalculate → store evidence hash

**Why Wilson LB:** Correctly handles small sample sizes (new agents get conservative scores). Deterministic (A3). Already proven in Vinyan's pattern mining. No new math — direct reuse.

### 6.3 Trust-Weighted Engine Selection

```
task arrives → risk router determines routing level → engine selector:

  1. Filter: agent.capabilities ⊇ task.required_capabilities
  2. Filter: agent.trust_score ≥ minimum_trust_for_level
  3. Rank:
       score = trust_weight × trust_score
             + cost_weight × (1 - normalized_cost)
             + experience_weight × task_type_familiarity
  4. Weights are kernel parameters (A3 — not LLM-decided)
  5. Tie-break: agent with more task-type-specific completions
  6. Winner receives AgentContract (K1.2)
```

**Evolution from current code:**
- `risk-router.ts` remains the **routing level** source (risk assessment → level)
- New `engine-selector.ts` uses trust data to **select which engine** at that level
- `worker-pool.ts` dispatches to the selected engine

### 6.4 Cross-Task Concurrent Dispatch

```
Current:  caller → core-loop.executeTask(task) → wait → next task
          (within task: subtasks run in parallel via DAG executor ✓)

K2:       TaskQueue → ConcurrentDispatcher:
            - Accepts multiple TaskInput concurrently
            - Semaphore: max N concurrent top-level tasks (default 4)
            - Each task: own AgentContract (K1.2)
            - Each task's subtasks: existing DAG executor (unchanged)
            - Cross-task file conflicts: advisory file locks (new)
```

**What already works (do not rebuild):** DAG executor subtask parallelism, per-level semaphores (L1=5, L2=3, L3=1), warm pool subprocess management, file conflict detection within DAG.

**New components:** `orchestrator/task-queue.ts` (bounded queue + concurrent dispatch), `worker/file-lock.ts` (advisory locks for cross-task write conflicts).

### 6.5 A2A Activation

**Current state:** 30 files in `src/a2a/`, 28 test files, 4 transports, `A2AManager` wired in `serve.ts`. Substantial infrastructure — default config just doesn't activate it.

**K2 scope:**
1. `config/schema.ts` — default `network.instances.enabled` to `true` (graceful fallback if no peers)
2. Engine selector integration — delegate to peer instance when local engines are fully loaded
3. Trust sharing — attestations exchanged across trusted peers with trust-of-trust dampening
4. Integration test — two instances, task delegation, result return, trust exchange

### 6.6 MCP Client — Bidirectional Integration

**Current:** MCP server exists (read-only oracle queries). Agents need tool access from the MCP ecosystem — building 40+ tools in-house is not viable when 10,000+ MCP servers exist [MCP Report, Zuplo 2026].

**K2 scope:** Add MCP client. Agent requests tool → kernel checks capability token (K1.3) → routes to MCP server → validates result through Oracle Gate → returns verified result. Vinyan adds value by **verifying** tool results, not by reimplementing tools.

### 6.7 K2 Deliverables

| ID | Deliverable | Status | Key Files | Implementation |
|---|---|---|---|---|
| K2.1 | Trust Ledger | **✅ Done** | `db/provider-trust-store.ts` | Per-(provider, capability) composite PK, `evidence_hash` column (A4), `getProviderCapability()`, `getProvidersByCapability()`. Backward-compatible migration. |
| K2.2 | Trust-Weighted Engine Selection | **✅ Done** | `orchestrator/engine-selector.ts` (new) | Wilson LB ranking, trust thresholds per level (L0=0, L1=0.3, L2=0.5, L3=0.7), market scheduler integration point. Wired in phase-predict.ts. |
| K2.3 | Cross-Task Concurrent Dispatch | **✅ Done** | `orchestrator/concurrent-dispatcher.ts` (new), `worker/file-lock.ts` (new) | Iterative round-based parallel dispatch with advisory file locks. `executeTaskBatch()` exported from core-loop. |
| K2.4 | A2A Activation | **✅ Done** | `orchestrator/instance-coordinator.ts`, integration tests | Delegation wired in phase-predict. 15 gate tests (G8-G13) passing. |
| K2.5 | MCP Client | **✅ Done** | `mcp/client.ts` (new) | `MCPClientPool` with lifecycle management, `callToolVerified()` routes results through Oracle Gate (G12). |

### 6.8 K2 Gate (Exit: End of 2026 Q4) — **ALL PASSING ✅**

| # | Criterion | Status | Test Method |
|---|---|---|---|
| G8 | ≥3 independent tasks execute concurrently | **✅ PASS** | Integration: 3 `TaskInput`s dispatched, wall-clock < sum |
| G9 | Trust-weighted selection: higher-trust agent wins | **✅ PASS** | Unit: 2 agents, different trust → deterministic selection |
| G10 | Trust updates correctly after success/failure | **✅ PASS** | Unit: per-capability trust matches Wilson LB calculation |
| G11 | A2A: peer delegation round-trip | **✅ PASS** | Integration: InstanceCoordinator delegation protocol verified |
| G12 | MCP client calls external server → result verified | **✅ PASS** | Integration: MCPClientPool.callToolVerified() → oracle gate |
| G13 | All K1 gates still pass | **✅ PASS** | Regression: G0-G7 green, 1,396 tests passing |

### 6.9 Economy Layer (E1-E4) — Implemented

The Economy Operating System provides cost awareness, budget enforcement, market mechanism, and federation economics. ~2,015 LOC across 24 source files, 123 tests.

| Layer | Scope | Key Files | Status |
|---|---|---|---|
| **E1: Cost Accounting** | Rate-card resolution, cost-ledger (dual-write), budget-enforcer (warn/block/degrade) | `economy/cost-ledger.ts`, `economy/budget-enforcer.ts` | ✅ Wired in trace-collector + core-loop |
| **E2: Cost-Aware Intelligence** | Cost-predictor (EMA), cost-aware scoring (wired in worker-selector), dynamic budget allocator | `economy/cost-predictor.ts`, `economy/cost-aware-scorer.ts`, `economy/dynamic-budget-allocator.ts` | ✅ Wired in worker-selector + factory |
| **E3: Market Mechanism** | Vickrey auction, settlement engine, bid accuracy tracking, anti-gaming (collusion detection) | `economy/market/auction-engine.ts`, `economy/market/settlement-engine.ts`, `economy/market/market-scheduler.ts` | ✅ Implemented, activates when data sufficient |
| **E4: Federation Economy** | Cross-instance cost relay, shared budget pool, peer pricing, economic consensus | `economy/federation-cost-relay.ts`, `economy/federation-budget-pool.ts`, `economy/peer-pricing.ts` | ✅ Wired via bus events |

**Activation:** E1-E2 are active when `economy.enabled = true` in config. E3 market activates automatically when cost data ≥ 200 records and ≥ 2 bidders. E4 federation activates when `economy.federation.cost_sharing_enabled = true`.

---

## 7. 2027 Roadmap: Economy Activation

### 7.1 Quarterly Targets

| Quarter | Focus | Key Deliverables | Exit Criteria |
|---|---|---|---|
| **Q1** | Heterogeneous Engines + Protocol Spec | Register ≥2 non-LLM engine types (Z3 constraint solver, human-in-loop ECP bridge) via `ReasoningEngine` interface; TLA+ specification of core loop invariants (A3, A6) model-checked | ≥2 non-LLM engines passing verification through Oracle Gate; TLA+ spec with zero safety violations across ≥100K states |
| **Q2** | Market Activation | **Infrastructure already implemented (E3):** Vickrey auction, settlement engine, bid accuracy tracking, anti-gaming. Needs: sufficient trust data (≥200 cost records), ≥3 engine types bidding, production tuning of auction parameters. | Market scheduler active for ≥3 engine types; bid accuracy decay observable |
| **Q3** | Federation | Cross-instance economy: shared trust attestations over A2A, task delegation between ≥2 Vinyan instances, trust-of-trust dampening | ≥2 instances cooperating on shared workload; trust propagation verified |
| **Q4** | Self-Evolution Validation | Evolution engine with sufficient data (≥500 traces); measure prediction error reduction; validate rule promotion pipeline end-to-end | Prediction error ↓ trend over 30-day window without manual intervention; ≥5 rules promoted from probation |

### 7.2 Success Properties

| Property | Measurement | Rationale |
|---|---|---|
| **Multi-agent concurrent** | ≥5 agents active simultaneously | Proves concurrent dispatch at reasonable scale |
| **Heterogeneous engines** | ≥2 non-LLM engine types in production | Monoculture = single point of failure; proves engine-agnostic design |
| **Trust-based economy** | Trust earned through verification, revoked on violation | Core safety mechanism for multi-agent operation |
| **Self-improvement** | Measurable prediction error reduction over 30 days | A7 must be demonstrable, not theoretical |
| **Protocol interop** | ≥1 external system using ECP for verification | Proves ECP as a viable standard |
| **Audit trail** | Every governance decision reproducible from trace + evidence | EU AI Act compliance readiness (full enforcement Aug 2026 [8]) |
| **Protocol safety** | Core invariants specified and model-checked in TLA+ | Moves beyond test-verified toward formally-specified |

### 7.3 Changes from v2 Targets

| v2 Target | v3 Change | Reason |
|---|---|---|
| ≥10 agents concurrent | **→ ≥5** | 5 is meaningful proof; 10 is optimization |
| ≥3 non-LLM engine types | **→ ≥2** | 2 is sufficient proof of engine-agnostic design |
| Lean4 proof oracle in Q1 | **→ Research track** | Lean4 agents achieve <1% end-to-end proof success (VeriBench). Not production-grade. |
| EU AI Act certification | **→ Removed** | Legal/regulatory process, not engineering deliverable. Architecture supports it (A3+A4). |
| Formal kernel verification | **→ Research track** | seL4-equivalent proofs took a decade. TLA+ protocol spec is feasible; full Lean4 verification is not. |
| ≥1 third-party agent on ECP | **→ ≥1 external system using ECP** | Broader: could be a tool, service, or agent. Ecosystem adoption is outside our control. |
| Full market auction in K2 | **→ Market in 2027 Q2** | Trust-weighted routing first; market when data + agent population warrant it. |
| Throughput > 5x baseline | **→ > 3x** | More realistic for heterogeneous engine mix with verification overhead |

### 7.4 What 2027 Explicitly Does NOT Require

| Item | Why Deferred | Trigger to Revisit |
|---|---|---|
| Formal kernel verification (Lean4/Coq proof of A3) | seL4 took a decade with a specialized team. TLA+ protocol spec delivers 80% value. | If Lean4 tooling matures to >10% proof success rate |
| EU AI Act certification | Certification is legal/regulatory, not engineering. Architecture supports it. | When market demands or regulatory mandate |
| Lean4 production proof oracle | <1% end-to-end success rate (VeriBench 2026). Research frontier. | When automated theorem proving reaches >50% success |
| Full collateral/slashing mechanism | Game-theoretic mechanisms need adversarial pressure to tune. <10 agents = no adversaries. | When agent population > 10 with external participants |
| Third-party marketplace | Requires stable API, docs, onboarding — premature before ECP is proven. | When ECP has ≥3 production integrations |
| Cross-domain expansion (non-code) | Code capability is bootstrap — "a system that modifies its own code can evolve without limits." Cross-domain needs domain-specific oracles. | When code verification is mature and demand exists |

### 7.5 Value Demonstration — Why Vinyan Over Raw LLM

The architecture document must answer: **does Vinyan + LLM produce measurably better results than LLM alone?**

**What exists:** Phase 0 A/B experiment on ≥30 TypeScript mutation tasks showed "100% structural error reduction" (no structural errors with oracle verification vs. baseline structural error rate without). This is a strong but narrow result on a small sample without independent replication.

**What doesn't exist:** Production-scale demonstration. Side-by-side comparison on large, diverse task sets. Independent verification of the Phase 0 results. Cost-per-verified-output analysis.

**What would constitute proof:**
1. Side-by-side: 100 diverse code tasks, Vinyan+Claude vs Claude alone — measure structural error rate, test pass rate, cost per verified output
2. Verification ROI: show that oracle gate verification catches errors that would have reached production, and quantify saved cost
3. Self-Model value: demonstrate that routing accuracy improves after 100+ tasks vs. fixed routing

Until this proof exists, Vinyan is an architecture thesis, not a proven system. The thesis is well-grounded (A1 + A3 + verification-first design), but unproven at scale.

### 7.6 Team and Resources

**Current reality:** Single contributor. The project directory is `POC/` (Proof of Concept). ~53K LOC and 1,396 tests represent substantial work, but the bus factor is 1.

**Achievability by team size:**

| Phase | Solo achievable? | Why |
|---|---|---|
| **K1** (Q2-Q3 2026) | **Yes — COMPLETE** | All K1 deliverables done. G0-G7 gates passing. |
| **K2** (Q3-Q4 2026) | **Yes — COMPLETE** | All K2 deliverables done. G8-G13 gates passing. Economy OS (E1-E4) implemented as bonus. |
| **2027 Q1-Q2** | **No** | TLA+ formal spec requires PL expertise. Market mechanism requires game theory analysis. Both are specialist work. |
| **2027 Q3-Q4** | **No** | Federation requires distributed systems expertise. Self-evolution validation requires sustained production usage. |

**What this means:** K1 and K2 are complete. 2027 economy activation requires at minimum 2-3 contributors with complementary skills (distributed systems, formal methods, DevOps/production).

### 7.7 Crash Recovery (Implemented — MVP)

**Implemented:** `TaskCheckpointStore` (`src/db/task-checkpoint-store.ts`) provides pre-dispatch persistence and startup recovery.

**How it works:**
1. **Before dispatch:** `phase-generate.ts` persists task checkpoint to SQLite (task_id, input, routing_level, plan, perception, attempt_count)
2. **On completion/failure:** Bus listener on `task:complete` marks checkpoint as completed or failed
3. **On restart:** `factory.ts` queries `findDispatched()` → marks interrupted tasks as abandoned → emits `task:recovered` event
4. **Periodic cleanup:** Completed/failed/abandoned checkpoints older than 24h are purged on startup

**What's covered:**
- Pre-dispatch checkpoint persistence (crash between dispatch and completion is detected)
- Startup recovery with abandoned task notification via EventBus
- Concurrent dispatch crash impact mitigated (each task checkpointed independently)
- 10 unit tests covering save/complete/fail/abandon/cleanup/factory-recovery patterns

**What's deferred:**
- L3 container cleanup — Docker sandbox not yet in production use; cleanup on startup would scan for orphaned containers
- Active task resumption — currently auto-abandons interrupted tasks; future: offer resume from checkpoint
- Session overlay persistence — session overlay is file-level (already exists); session state (working memory, approach history) not yet checkpointed

---

## 8. Research Tracks (2027+)

High-value directions currently infeasible as engineering deliverables but actively informing architecture decisions.

### 8.1 Formal Verification of Kernel Properties

Tests prove "this scenario works." Formal verification proves "ALL scenarios work." For an OS kernel, the difference is existential.

**What's realistic now:**
- **TLA+ for protocol safety/liveness** — SentinelAgent [6] verified 2.7M states of agent delegation chains with zero violations. Vinyan should specify core loop invariants in TLA+: "routing decisions are state-reproducible (A3)", "no worker directly commits artifacts (A6)", "contradiction at L3 is terminal (K1.1)." **Target: 2027 Q1.**
- **Lean4 for rule correctness** — "Type-Checked Compliance" [7] uses Lean4 for agent guardrails. Vinyan could formalize oracle tier precedence (A5) and conflict resolution determinism. **Target: 2027 Q3+ if tooling matures.**
- **seL4-equivalent kernel proof** — Not feasible near-term. seL4's proof took >10 years with a specialized team and the seL4 kernel is ~10K LOC. Vinyan is ~48K LOC. Meaningful formal verification requires reducing the trusted kernel surface. **Target: Long-term research.**

### 8.2 Non-LLM Reasoning Engines

The `ReasoningEngine` interface ([D19](decisions.md)) is engine-agnostic. Any engine producing `ECPResponse` participates. Candidates:

| Engine | Integration Complexity | Feasibility | Target |
|---|---|---|---|
| **Z3 SMT solver** | Medium — constraint encoding needed | Feasible | 2027 Q1 |
| **Tree-sitter as full RE** | Low — already used in AST oracle | Feasible now | K2 or earlier |
| **Human-in-the-loop** | Medium — UI/CLI for ECP verdict input | Feasible | 2027 Q1 |
| **Custom domain oracles** | Low — plugin system (D16) | Feasible | 2027 Q1+ |
| **Lean4 proof assistant** | High — <1% success rate for automated use | Research-grade | 2027 Q3+ |

### 8.3 Self-Evolution Safety (Bounded Autopoiesis)

The Evolution Engine generates rules from trace patterns and promotes them through backtesting. This is bounded autopoiesis — self-modification within safety invariants. Darwin Gödel Machine (Sakana AI, 2025) demonstrates LLM-based self-improvement is practically possible.

**Open questions:**
- Who defines the immutable safety invariants? Currently: humans in code. Future: formal specification in Lean4/TLA+.
- How to detect emergent behaviors that individually pass safety checks but collectively degrade the system? (Requires cross-rule interaction analysis.)
- What is the minimum audit trail for self-modification to satisfy EU AI Act Article 14 (human oversight) [8]?

### 8.4 Sandbox Evolution: Docker → WebAssembly

Current L3 sandbox uses Docker containers (non-root, drop ALL caps, no network, 512m memory). Industry is moving toward WebAssembly for agent sandboxing:
- **Wassette** (Microsoft, Aug 2025): Security-oriented Wasm runtime for agent tool execution
- **Cloudflare Dynamic Workers**: Sub-10ms cold starts for Wasm isolates vs. ~500ms for containers
- Wasm provides mathematically verifiable sandboxing with capability-based security

**Target:** Evaluate Wasm as L2 sandbox (lower overhead than Docker) while keeping Docker for L3 (maximum isolation). Not a 2027 commitment — depends on Bun/Wasm runtime maturity.

---

## 9. Competitive Landscape

### 9.1 Agent Orchestration Platforms (2026)

| System | Approach | What They Have That Vinyan Lacks | What Vinyan Has That They Lack |
|---|---|---|---|
| **LangGraph** | Directed graph, conditional edges, checkpointing | Production-proven (~90M monthly downloads), ecosystem, community, stability guarantees | Verification layer (Oracle Gate), epistemic protocol (ECP), self-calibration |
| **CrewAI** | Role-based crews, hub-and-spoke | Lowest learning curve (~20 lines), large user base | Independent verification of outputs, conflict resolution, trust scoring |
| **OpenAI Agents SDK** | Explicit handoffs, single-process | Lowest latency, simplest model, OpenAI ecosystem | Multi-engine support, subprocess isolation, formal trust |
| **AutoGen / MS Agent Framework** | Conversational GroupChat, actor model | Flexible, event-driven, async, Microsoft backing | Governance without LLM in decision path (A3); token efficiency |
| **Letta (MemGPT)** | OS-inspired memory hierarchy, "sleep-time compute" | Production deployment, background reorganization, user base | Formal verification pipeline, prediction error learning (A7) |

**Honest assessment:** All competitors above are production-deployable today. Vinyan is not. The single most important dimension — "can you actually use this?" — favors every competitor. Vinyan's advantage is **technical depth in epistemic verification**, not breadth or production readiness.

### 9.2 Closest Competitor: Microsoft Agent Governance Toolkit

Released April 3, 2026 (MIT license). Both share the "deterministic governance" thesis. Key differences:

| Dimension | MS Agent Governance Toolkit | Vinyan |
|---|---|---|
| **Architecture** | Stateless policy engine (Agent OS) + mesh + runtime | Stateful kernel with world graph + trust ledger + self-model |
| **Governance** | Static policy evaluation per action | Epistemic decision (4-state: allow/caveats/block/abstain) |
| **Protocol** | Framework-specific hooks (LangChain callbacks, CrewAI decorators) | ECP — engine-agnostic protocol with confidence + evidence |
| **Trust** | Not implemented (policy-based, no reputation) | Wilson LB trust progression from verified outcomes |
| **Knowledge** | Stateless — no fact tracking | Content-addressed World Graph with auto-invalidation |
| **Learning** | Static policies — no self-improvement | Prediction error → Self-Model calibration (A7) |
| **Verification** | 10 OWASP risk checks | 6 oracle types with SL fusion + conflict resolution |
| **Scale** | Multi-framework integration, Microsoft distribution | Single-kernel depth, small team |

**Risk:** AGT has Microsoft's distribution and multi-framework integration (LangChain, CrewAI, Google ADK, MS Agent Framework). If AGT adds epistemic semantics and trust scoring, Vinyan's differentiation narrows. **Mitigation:** ECP formalization, trust-weighted economy, and self-calibration are technical depth advantages — but not "head starts" in the competitive sense. AGT was built in months by a large team. Vinyan's advantage is architectural specificity, not development lead time.

### 9.3 Market Context

- Multi-agent systems market: $7.6B (2025) → projected $182B+ (2030) (Gartner, Deloitte)
- 40% of enterprise apps will embed task-specific agents by end 2026 (Gartner)
- Agent coordination failure rate: 41-86.7% without formal orchestration (Galileo, 1,642 traces)
- Verification gap accounts for 21% of multi-agent failures (hallucinated info in shared memory poisons downstream)
- EU AI Act full enforcement for high-risk AI: August 2, 2026 — requires audit trails, human oversight, risk classification
- Inflection point for needing an agent OS is typically 15-20 agents (coordination complexity grows exponentially)

---

## 10. Non-Goals

| Non-Goal | Why Not | Who Should Build It |
|---|---|---|
| IDE integration (VS Code, Cursor) | Kernel focus. UX is a layer above. | Community / `vscode-extension/` stub |
| Cloud hosting / SaaS | OS ≠ hosting. Users deploy where they want. | Infrastructure team / third-party |
| SWE-bench ranking | Vinyan verifies, not generates. LLM quality is the engine's problem. | Engine developers |
| 40+ built-in tools | MCP ecosystem has 10,000+ servers. Build the hub, not every tool. | MCP server authors |
| Web dashboard UI | TUI + API first. UI layered on top. | Frontend developers |
| Fine-tuning / training LLMs | Vinyan uses LLMs, doesn't train them. | LLM providers |
| General-purpose app framework | Vinyan is a kernel, not a framework. Applications use Vinyan's API. | App developers |
| Human-in-the-loop for every decision | Defeats autonomy. Humans set invariants; kernel enforces. | N/A — design principle |
| Competing with LangGraph/CrewAI on DX | Different layer. They build agent apps; Vinyan makes agent apps trustworthy. | Framework authors |

---

## 11. 2027 Gate (Exit: End of 2027)

| # | Criterion | Test Method |
|---|---|---|
| G14 | ≥2 non-LLM engine types active in production | `vinyan status` shows active engine types |
| G15 | Throughput > 3x single-agent baseline | Benchmark: concurrent economy vs sequential |
| G16 | Federation: ≥2 instances cooperate on shared workload | Integration: cross-instance task completion |
| G17 | Prediction error reduction measurable | 30-day trend shows ↓ without manual intervention |
| G18 | ≥1 external system using ECP | External integration test or partner demo |
| G19 | All decisions reproducible from trace + evidence | Audit: replay trace → same decisions |
| G20 | TLA+ spec of core invariants model-checked | TLA+ model checker: zero safety violations |
| G21 | Market scheduler operational (≥3 engine types bidding) | Integration: bid submission → trust-weighted selection → ex-post settlement |
| G22 | All K1 + K2 gates still pass | Regression: G1-G13 green |

---

## 12. Architecture Diagram (2027 Target)

```
╔══════════════════════════════════════════════════════════════════╗
║                   VINYAN OS — ECONOMY KERNEL                     ║
║                                                                  ║
║  ┌──────────────── REASONING ENGINE SPACE ───────────────────┐   ║
║  │                                                           │   ║
║  │  ┌─────────┐  ┌─────────┐  ┌─────────┐  ┌─────────┐      │   ║
║  │  │  LLM    │  │   Z3    │  │ Domain  │  │  Human  │  ... │   ║
║  │  │ Engine  │  │ Solver  │  │ Oracle  │  │ Expert  │      │   ║
║  │  └────┬────┘  └────┬────┘  └────┬────┘  └────┬────┘      │   ║
║  │       │            │            │            │            │   ║
║  │  ┌────┴────────────┴────────────┴────────────┴────────┐   │   ║
║  │  │       ECP — Epistemic Communication Protocol       │   │   ║
║  │  │  confidence │ evidence_chain │ falsifiable_by │     │   │   ║
║  │  │  temporal_context │ type: known/unknown/uncertain  │   │   ║
║  │  └────────────────────────┬───────────────────────────┘   │   ║
║  └───────────────────────────┼───────────────────────────────┘   ║
║                              │                                   ║
║  ════════════════════════════╪════════════════════════════════    ║
║              KERNEL BOUNDARY (A3: deterministic, no LLM)         ║
║  ════════════════════════════╪════════════════════════════════    ║
║                              │                                   ║
║  ┌───────────────────────────┼───────────────────────────────┐   ║
║  │             VINYAN KERNEL (Deterministic)                 │   ║
║  │                                                           │   ║
║  │  ┌──────────────┐  ┌──────────────┐  ┌────────────────┐   │   ║
║  │  │  SCHEDULER   │  │  VERIFIER    │  │  MEMORY MGR    │   │   ║
║  │  │              │  │              │  │                │   │   ║
║  │  │ Risk Router  │  │ Oracle Gate  │  │ World Graph    │   │   ║
║  │  │ + Trust-     │  │ + SL Fusion  │  │ (SHA-256       │   │   ║
║  │  │   Weighted   │  │ + Conflict   │  │  content-      │   │   ║
║  │  │   Selection  │  │   Resolution │  │  addressed)    │   │   ║
║  │  │ + Market     │  │ + 4-state    │  │ + Trust Ledger │   │   ║
║  │  │   (2027 Q2)  │  │   Epistemic  │  │ + Fact Store   │   │   ║
║  │  └──────┬───────┘  └──────┬───────┘  └───────┬────────┘   │   ║
║  │         │                 │                  │            │   ║
║  │  ┌──────┴─────────────────┴──────────────────┴──────┐     │   ║
║  │  │            TRUST ENGINE (A5 + A6)                │     │   ║
║  │  │ AgentContract │ Capability Scope │ Wilson LB Trust│     │   ║
║  │  └──────────────────────┬───────────────────────────┘     │   ║
║  │                         │                                 │   ║
║  │  ┌──────────────────────┴───────────────────────────┐     │   ║
║  │  │            EVOLUTION ENGINE (A7)                 │     │   ║
║  │  │ Self-Model │ Sleep Cycle │ Rule Promotion │      │     │   ║
║  │  │ Backtester │ Pattern Mining │ Safety Invariants  │     │   ║
║  │  └──────────────────────────────────────────────────┘     │   ║
║  │                                                           │   ║
║  │  ┌──────────────────────────────────────────────────┐     │   ║
║  │  │            ECONOMY LAYER (E1-E4)                 │     │   ║
║  │  │ Cost Ledger │ Budget Enforcer │ Cost Predictor   │     │   ║
║  │  │ Market (Vickrey) │ Settlement │ Anti-Gaming      │     │   ║
║  │  │ Federation Cost Relay │ Peer Pricing             │     │   ║
║  │  └──────────────────────────────────────────────────┘     │   ║
║  └───────────────────────────────────────────────────────────┘   ║
║                                                                  ║
║  ┌────────────────── INTEGRATION LAYER ──────────────────────┐   ║
║  │ MCP Hub │ A2A Gateway │ Tool Registry │ Sandbox │ TLA+ Spec│   ║
║  └───────────────────────────────────────────────────────────┘   ║
╚══════════════════════════════════════════════════════════════════╝
```

---

## Appendix A: Citation Index

All citations verified against arXiv or primary sources as of 2026-04-09.

| ID | Title | Source | Status |
|---|---|---|---|
| [1] | "Trustworthy Agentic AI Requires Deterministic Architectural Boundaries" | arXiv:2602.09947 | Preprint (Feb 2026) |
| [2] | "Agent Contracts: Formal Framework for Resource-Bounded Autonomous AI Systems" | arXiv:2601.08815 | **Peer-reviewed** — oral at COINE 2026 (AAMAS) |
| [3] | "Agent Behavioral Contracts (ABC)" | arXiv:2602.22302 | Preprint (Feb 2026) |
| [4] | "Virtual Agent Economies" (Google DeepMind) | arXiv:2509.10147 | Preprint (Sep 2025) |
| [5] | "From Competition to Coordination: Market Making for Multi-Agent LLM Systems" | arXiv:2511.17621 | Preprint (Nov 2025) |
| [6] | "SentinelAgent: TLA+ Verification for Agent Delegation Chains" | arXiv:2604.02767 | Preprint (Apr 2026) |
| [7] | "Type-Checked Compliance: Lean 4 for Agent Guardrails" | arXiv:2604.01483 | Preprint (Apr 2026) |
| [8] | "AI Agents Under EU Law: Compliance Architecture for AI Providers" | arXiv:2604.04604 | Preprint (Apr 2026) |
| [9] | "Holos: Scalable LLM Multi-Agent System for Agentic Web" | arXiv:2604.02334 | Preprint (Apr 2026) — performance claims unverified |
| [10] | Microsoft Agent Governance Toolkit | github.com/microsoft/agent-governance-toolkit | OSS, MIT (Apr 2026) |
| [11] | "Institutional AI: Governing LLM Collusion in Multi-Agent Markets" | arXiv:2601.11369 | Preprint (Jan 2026) |
| [12] | seL4: Formal Verification of an OS Kernel | SOSP 2009, CACM 2010 | **Peer-reviewed** |
| [13] | ECMA-430 to ECMA-434 (NLIP Agent Communication Standard) | Ecma International | **Ratified** (Dec 2025) |
| [14] | Google A2A Protocol v1.0.0 | Linux Foundation AAIF | Production (Mar 2026) |

---

## Appendix B: Tier ↔ Transport Mapping

> Companion to §3.1 (Three-Tier mental model). Source: book-integration
> Wave 3.3. This table is load-bearing for operator diagnostics — when
> something misbehaves, the first question is "which tier?" and the second
> is "which transport?". Having both answers on one page closes the gap
> between the code layout and the runtime mental model.

Every tier in §3.1 communicates through a specific set of transports. The
transports are not interchangeable — each one exists because the axioms
require it:

| Tier | Transport | What moves across it | Axiom justification | Key code |
|------|-----------|----------------------|---------------------|----------|
| **Tier 1 — Worker** | JSON-newline stdio | `OrchestratorTurn` / `WorkerTurn` protocol frames between the agent loop and the subprocess it spawned | **A1** — the subprocess boundary is the epistemic-separation barrier; a function-call boundary would not be | `src/orchestrator/protocol.ts`, `src/orchestrator/worker/agent-session.ts`, `src/a2a/stdio-transport.ts` |
| **Tier 1 — Worker** | In-process bus | Turn-level observability events (`agent:tool_executed`, `agent:turn_complete`, etc.) | **A3** — purely observational, no governance reads from here | `src/core/bus.ts` |
| **Tier 2 — Swarm** | Advisory file lock + task queue | Scheduling decisions (who runs now, who waits) | **A3** — deterministic graph on file intersections; no LLM in the decision path | `src/orchestrator/concurrent-dispatcher.ts`, `src/orchestrator/worker/file-lock.ts` |
| **Tier 2 — Swarm** | Session overlay | Proposed mutations from multiple workers staged before commit | **A6** — workers propose, orchestrator disposes; overlay is the "propose" half | `src/orchestrator/worker/session-overlay.ts` |
| **Tier 3 — Fleet** | A2A JSON-RPC (HTTP / WebSocket) | Task delegation, peer health, knowledge exchange between Vinyan instances | **A1 + A5** — remote peers run their own generator / verifier loops; trust is Wilson-LB clamped per peer | `src/a2a/a2a-manager.ts`, `src/a2a/http-transport.ts`, `src/a2a/websocket-transport.ts` |
| **Tier 3 — Fleet** | ECP data parts | Confidence-carrying payloads embedded inside A2A messages — heartbeats, verdicts, knowledge offers | **A2 + A5** — transports carry structured uncertainty as first-class data | `src/a2a/ecp-data-part.ts`, `src/a2a/peer-health.ts` |
| **Tier 3 — Fleet** | Gossip layer | Eventual-consistency distribution of trust / capability updates | **A3** — gossip delivery itself is not a governance decision; the receiving side re-applies deterministic rules | `src/a2a/gossip.ts`, `src/a2a/capability-updates.ts` |

**Operator rules of thumb** (paired with §3.1):

1. A Tier 1 anomaly = something on the JSON-newline stdio channel or the
   in-process bus. Look at `guardrail:silent_agent` (Wave 1.1) and
   `agent:*` events via `vinyan tui peek <task-id>` (Wave 3.1).
2. A Tier 2 anomaly = a scheduling conflict or an overlay rejection. Look
   at `dag:executed` events and `commit:rejected` — the conflict plan
   from `computeConflictPlan` is deterministic so an "impossible" group
   usually means a bug in `targetFiles` derivation, not a race.
3. A Tier 3 anomaly = a peer health or trust transition. Look at
   `peer:*` events, `a2a:knowledge*` events, and the instance coordinator
   log. Trust regressions surface as `worker:demoted` on the local
   fleet because the lifecycle state machine is the same shape regardless
   of whether the worker is local or remote.

**What this table is NOT:** it is not a wire-format spec. For
byte-level details see [`ecp-spec.md`](../spec/ecp-spec.md) and
[`a2a-protocol.md`](../spec/a2a-protocol.md). This table is a *map* — it
tells you where to look, not what to decode.
