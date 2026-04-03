---
type: concept
audience: all
single-source-of-truth-for: Vinyan vision, Epistemic Orchestration paradigm, ENS protocol design
related:
  - theory.md (theoretical foundations, academic citations)
  - ../architecture/decisions.md (concrete implementation decisions)
  - ../analysis/gap-analysis.md (competitive landscape, gap tracking)
---

# Vinyan — Epistemic Orchestration

## Abstract

Current agent frameworks — OpenHands, SWE-agent, Claude Code, Devin — share a common architecture: the LLM *is* the brain. It decomposes tasks, coordinates workers, evaluates success, and arbitrates conflicts. Every cognitive function runs through a single probabilistic substrate. Every function therefore inherits every LLM failure mode: hallucination, epistemic arrogance, non-reproducible reasoning, and the inability to distinguish “I verified this” from “I believe this.”

Vinyan is an **autonomous task orchestrator** built on the **Epistemic Orchestration** paradigm — the architectural thesis that AGI-grade reliability emerges from correct epistemic architecture, not from larger LLMs. It receives tasks, plans execution, dispatches workers, verifies results, and learns from outcomes without human intervention. Its verification layer is an **Epistemic Nervous System (ENS)**: the connective substrate between hypothesis generation and hypothesis verification. Phase 0 delivers the **verification foundation** (Oracle Gate); Phase 1 delivers the **complete agent**; the full ENS emerges across Phases 2–5 as self-improvement and fleet governance activate. Like a biological nervous system connecting specialized organs, Vinyan connects heterogeneous **Reasoning Engines** (deterministic verifiers, heuristic analyzers, symbolic solvers, LLMs, statistical models) through a shared epistemic protocol. No single engine is "the brain." The Orchestrator is rule-based and non-LLM-driven — its routing, verification, and commit decisions are reproducible given the same state. Communication flows through the **Epistemic Communication Protocol (ECP)** — an internal protocol encoding confidence, evidence chains, falsifiability, and first-class uncertainty. ECP establishes an epistemic boundary between components that formulate hypotheses and components that validate them, within a framework of *Mostly-Deterministic Orchestration with Principled Stochasticity*, bounded by immutable safety invariants that only human governance can modify.

> **Epistemic Orchestration** = uncertainty-aware, verification-first, self-calibrating orchestration. Vinyan is the first implementation of this paradigm. ENS is its verification substrate. ECP is its wire protocol.
---

## 1. Vision — Why Vinyan Exists

Current agent frameworks default to the LLM as primary decision-maker. Some have added deterministic checks — Claude Code hooks, HiClaw credential isolation, OpenHands Docker sandbox — but these are **add-ons to an LLM-centric architecture**, not the foundation. The LLM still decomposes tasks, coordinates workers, evaluates success, and arbitrates disagreements. Every core cognitive function remains probabilistic, non-reproducible, and fundamentally unable to distinguish “I verified this” from “I believe this.”

Vinyan inverts this:

| Dimension | Current Paradigm | Vinyan Paradigm |
| :--- | :--- | :--- |
| Role of LLM | LLM is the primary decision-maker (with optional deterministic add-ons) | LLM is ONE reasoning engine among many |
| System architecture | Agent framework orchestrates LLMs | Epistemic Orchestration — autonomous orchestrator with ENS verification substrate |
| Integration protocol | MCP/tools extend the LLM | ECP connects heterogeneous reasoning systems |
| Verification | Self-evaluation by LLM | External verification by deterministic engines |
| Governance | Governance via add-on hooks/plugins | Governance is the architectural foundation |
| Human involvement | Human-in-the-loop for safety | Immutable invariants + autonomous escalation |
| Agent completeness | LLM *is* the entire agent | Complete system: rule-based Orchestrator + LLM Generators + Tool Execution + external Verification |

> **Timeline honesty:** This table compares Vinyan's *architectural design* against competitors' *general approach*. As of Phase 6 completion, Vinyan is a standalone autonomous agent with multi-instance coordination — all seven axioms are proven in implementation. Competitors are also evolving — pre-commit verification, structured verification hooks, and risk-based routing are incrementally adoptable patterns. Vinyan's durable advantage is the *architectural commitment* to A1 + A4 from the foundation, not individual features.

**Why code is capability #1:** Vinyan's first and most developed domain is software engineering — not because Vinyan is a code tool, but because code is the **meta-capability that enables unbounded self-evolution**. A system that can competently modify its own source code can: add new verification engines for any domain, fix its own defects without downtime, create tools it doesn't yet possess, and optimize its own execution pipeline. Code is the bootstrap — the capability that unlocks all other capabilities. The Oracle framework (§3, §6) is domain-agnostic by design; current implementations are code-specific because that's where self-evolution starts.

**Phase 1 Vinyan's concrete advantages over "Claude Code + linters":**
1. **A1 — Structural separation guarantee:** The Generator (LLM) never evaluates its own output. This is an *architectural invariant*, not a hook or opt-in rule — the Orchestrator enforces it.
2. **A4 — Content-addressed fact database:** Verified facts are stored with file hashes and auto-invalidated when source changes. No need to re-run full verification — only invalidated facts are re-checked.
3. **WorkingMemory-driven replanning:** Failed approaches are recorded with Oracle evidence and injected as hard constraints. The system re-enters at the Plan step (not Generate), preventing identical retry loops.
4. **Semantic verification beyond structural linting:** LLM-as-Critic (§6) + targeted test generation catch logic errors, misunderstood requirements, and behavioral regressions that type checkers and linters cannot detect.
5. **Deterministic risk-based routing:** Task risk score (blast radius, dependency depth, irreversibility) determines model selection, isolation level, and verification depth — not a one-size-fits-all approach.

**Critical distinction:** Vinyan is NOT a verification add-on or a hook library that augments other agents. It is a **complete autonomous agent system** where the Orchestrator receives tasks from humans/APIs, plans execution via LLM-assisted task decomposition with Oracle validation at each level (§8), dispatches LLM-powered Workers (Generator Engines) to produce solutions, executes tools to interact with the environment (file I/O, shell, search), and verifies results through deterministic Reasoning Engines (Oracles). Phase 0 proves the verification thesis inside a host agent; Phase 1 removes the host — Vinyan IS the agent.

**The protocol analogy:** TCP/IP didn’t try to be a better telegraph. HTTP didn’t try to be a better FTP. ECP establishes a fundamentally new communication paradigm for reasoning systems — one where epistemic state (confidence, evidence, uncertainty) is a first-class citizen of the protocol, not metadata bolted onto tool calls.

**Domain scope:** Vinyan is a general-purpose task orchestrator. Its verification engines are currently most developed for software engineering, where formal verification tools exist (AST parsers, type checkers, test runners). The Oracle framework is domain-agnostic; current built-in implementations are code-specific as the bootstrap domain. Cross-domain expansion (document analysis, workflow automation, data pipelines) follows naturally as new Reasoning Engines are added — either by users via the Oracle SDK, or by Vinyan itself through its code self-evolution capability.
### 1.1 Core Axioms — The DNA of Epistemic Orchestration

Seven non-negotiable principles define the Epistemic Orchestration paradigm. Every section (§2–§14) is an implementation or extension of these axioms. If a proposed feature cannot justify itself through at least one axiom, it does not belong in Vinyan.

| # | Axiom | Principle | Implemented In |
| :--- | :--- | :--- | :--- |
| **A1** | **Epistemic Separation** | Generation and verification are performed by different components. No engine evaluates its own output. This is the foundational principle — the single insight that justifies Vinyan's existence. | §3 Reasoning Engines, §6 Truth Maintenance, §7 Mutation Protocol |
| **A2** | **First-Class Uncertainty** | "I don't know" is a valid protocol state, not an error. Epistemic state (confidence, evidence, uncertainty) is encoded at the protocol level, not bolted on as metadata. | §2 ECP, §3.1 Tiered Registry |
| **A3** | **Deterministic Governance** | The Orchestrator's routing, verification, and commit decisions are rule-based and reproducible given the same input state — no LLM is in the decision path for governance actions. Stochastic components (LLMs) are used for generation and initial task decomposition, but operate within deterministic constraints. Safety-critical paths are never probabilistic. "Deterministic" in Vinyan means "non-LLM-driven and state-reproducible", not "free of all heuristics" — heuristic rules that calibrate from data are deterministic in this sense because they produce the same output for the same input state. **Acknowledged boundary:** Task decomposition (§8) is the most consequential decision in the pipeline and uses an LLM. The Orchestrator validates decomposition outputs deterministically (5 structural criteria) but cannot verify semantic correctness of the decomposition itself. This is an honest limitation, not a design flaw — no system can deterministically validate natural language understanding. | §7 Zero-Trust Execution, §8 Risk Routing, §10 Safety Invariants |
| **A4** | **Content-Addressed Truth** | Every verified fact is bound to the content hash of its evidence source. When the source changes, dependent facts are automatically invalidated. No stale knowledge persists. | §6 World Graph, file hash binding |
| **A5** | **Tiered Trust** | Deterministic evidence (compiler, type checker, tests) outranks heuristic evidence (complexity metrics), which outranks probabilistic evidence (LLM reasoning). Contradictions resolve by evidence tier — not by vote or LLM arbitration. | §3.1 Tiered Registry, §3.2 Contradiction Resolution |
| **A6** | **Zero-Trust Execution** | Workers propose; the Orchestrator disposes. Workers have zero execution privileges. All state mutations pass through a multi-phase commit protocol. | §5 Process Isolation, §7 Four-Phase Commit |
| **A7** | **Prediction Error as Learning Signal** | System improvement is driven by the delta between predicted and actual outcomes — not task success/failure alone. This enables continuous calibration without external training data. | §9 Self-Model, §10 Evolution Engine |

These axioms are **self-reinforcing**: A1 requires A5 (separated verification needs a trust hierarchy), A5 requires A4 (trust hierarchy needs evidence provenance), A3 requires A6 (deterministic governance needs controlled execution), and A7 closes the loop (prediction error feeds back into all other axioms).

**Validation status (updated Phase 6)**: All seven axioms are **proven in implementation**. A1, A4, A6 were proven in Phase 0 (100% structural error reduction in A/B experiment). A2 is **fully active** — `OracleVerdict` carries continuous confidence, `type: 'uncertain'|'contradictory'` states, evidence chains with temporal context, and Subjective Logic opinions. A3 is **fully proven** — `risk-router.ts` calculates risk scores and `calculateRoutingLevel()` deterministically routes L0–L3; no LLM in governance path. A5 is **fully proven** — `tier-clamp.ts` enforces three-tier confidence capping (engine tier, transport tier, peer trust) with `clampFull()` composing all three. A7 is **fully proven** — `self-model.ts` computes per-task-type EMA prediction error with adaptive learning rate, sliding window miscalibration detection, and feeds back into routing calibration. Test suite: 400+ tests across all modules.
---

## 2. Epistemic Communication Protocol (ECP)

### 2.1 Three Communication Channels

| Channel | Parties | Purpose | Transport |
| :--- | :--- | :--- | :--- |
| **Epistemic Query** | Orchestrator ↔ Reasoning Engines | Hypothesis verification, truth queries, confidence calibration | ECP (internal) |
| **Delegation** | Orchestrator ↔ Workers | Task assignment with trust contracts, isolation budgets, allowed operations | ECP (internal) |
| **External Interface** | Vinyan ↔ Host / Other Agents | Tool access via MCP, inter-agent via A2A, human channels | MCP / A2A / Custom |

**Key decision:** MCP is used *only* for the External Interface channel. Internal communication uses ECP because MCP lacks epistemic semantics — it cannot propagate confidence, maintain evidence chains, express falsifiability conditions, or encode first-class “I don’t know.”

### 2.2 First-Class “I Don’t Know”

```typescript
interface ECPResponse {
  type: 'known' | 'unknown' | 'uncertain' | 'contradictory';
  confidence: number;           // 0.0 – 1.0
  evidence_chain: Evidence[];   // provenance
  falsifiable_by: string[];     // what would invalidate this?
  deliberation_request?: {      // engine requests more compute (§13.1)
    reason: string;
    estimated_depth: number;    // additional reasoning steps needed
    expected_confidence_gain: number;
  };
  temporal_context?: {          // when was evidence gathered? (§13.2)
    observed_at: string;        // ISO timestamp
    valid_until?: string;       // optional expiry
    supersedes?: string;        // hash of prior evidence this replaces
  };
  contradiction?: {
    claims: Claim[];
    resolution_path: ResolutionStep[];
  };
}
```

`type: 'unknown'` is not an error — it is a semantically meaningful state that triggers specific Orchestrator behaviors: uncertainty reduction strategies, targeted investigation, escalation to higher-tier engines, or human delegation. This eliminates the pervasive antipattern where LLMs fabricate answers rather than admit ignorance.

### 2.3 Phase 0 Transport & ECP vs MCP Relationship

Phase 0 transport: JSON-RPC over stdio (same transport layer as MCP local). Evolves to streaming + remote in later phases.

**Relationship to MCP:** ECP is built on the same JSON-RPC transport as MCP but adds epistemic semantics that MCP's schema cannot express:

| Capability | MCP | ECP |
|:---|:---|:---|
| Tool invocation | ✅ request/response | ✅ request/response |
| Confidence propagation | ❌ no schema support | ✅ `confidence` field on every response |
| Evidence chains | ❌ results are opaque | ✅ `evidence_chain` with provenance |
| "I don't know" | ❌ error or empty result | ✅ `type: 'unknown'` as semantic state |
| Falsifiability | ❌ not expressible | ✅ `falsifiable_by` conditions |
| Contradiction handling | ❌ last-write-wins | ✅ `contradiction` with resolution path |
| Deliberation negotiation | ❌ fixed compute | ✅ `deliberation_request` for adaptive compute |
| Temporal validity | ❌ no expiry model | ✅ `temporal_context` with TTL |

ECP is not a "fundamentally different wire protocol" — it is a **semantic extension** of JSON-RPC that adds epistemic state as first-class data. The innovation is in the schema and the Orchestrator behaviors it enables, not the transport. MCP could theoretically be extended with these fields, but doing so would overload a protocol designed for tool invocation with epistemic semantics it was not designed to carry. ECP keeps these concerns separate.

### 2.4 Network-Aware ECP (Phase 5)

Phase 0–4 ECP operates over local stdio (same-machine, zero-latency). Phase 5 multi-instance coordination (§11) requires ECP over network boundaries. Network transport introduces failure modes that local ECP never encounters:

**Message Framing:**
```typescript
interface ECPNetworkEnvelope {
  protocol_version: number;        // negotiated during handshake
  message_id: string;              // UUID — idempotency key
  source_instance_id: string;      // sender identity
  target_instance_id?: string;     // null = broadcast
  timestamp: number;               // sender wall-clock (ms since epoch)
  ttl_ms: number;                  // message expires after this duration
  payload: ECPResponse;            // standard ECP message
  signature?: string;              // Ed25519 signature for mTLS-verified instances
}
```

**Delivery Guarantees:**

| Property | Guarantee | Rationale |
|:---------|:----------|:----------|
| Ordering | Causal per-instance (not global) | Global ordering requires consensus — too expensive for advisory coordination |
| Delivery | At-least-once with idempotency | `message_id` deduplication at receiver. Lost messages retry with exponential backoff (100ms → 5s, max 3 attempts) |
| Freshness | TTL-bounded | Receiver drops messages where `now - timestamp > ttl_ms`. Prevents acting on stale evidence |
| Partial failure | Fail-open to single-instance | If network transport fails, Orchestrator continues with local-only oracles. No governance action depends on remote availability |

**Idempotency:** Every cross-instance ECP message carries a `message_id`. Receivers maintain a bounded deduplication window (last 10,000 message IDs, ~1MB memory). Duplicate messages are acknowledged but not re-processed.

**Circuit Breaker Integration:** Each remote instance connection uses the same circuit-breaker pattern as local oracles (`oracle/circuit-breaker.ts`): 3 failures → open, 60s reset, half-open probe. A partitioned instance is treated as an unavailable oracle — the local Orchestrator continues without it (A2: uncertainty is a valid state, not an error).

**Confidence Degradation:** Remote ECP responses always carry reduced confidence:
- Local deterministic oracle: confidence as-reported (up to 1.0)
- Remote deterministic oracle: confidence capped at 0.95 (I13 safety invariant)
- Remote heuristic/probabilistic: confidence × 0.8

This ensures A5 (Tiered Trust) holds across network boundaries — local evidence always outranks remote evidence of the same tier.

### 2.5 ECP as Publishable Standard

ECP is designed to be a **publishable protocol specification** — not an internal Vinyan detail but a standard that external systems can implement to participate in Epistemic Orchestration.

**Three-layer protocol stack:**

| Layer | Transport | Purpose | Status |
|:------|:----------|:--------|:-------|
| Layer 1: ECP Local | stdio (subprocess) | Local oracle invocation | Production (Phase 0+) |
| Layer 2: ECP Network | WebSocket / HTTP | Remote oracle, cross-instance | Production (Phase 5) |
| Layer 3: Bridges | MCP, A2A, LSP | External ecosystem integration | Production (Phase 5) |

**Conformance levels** enable incremental adoption:

| Level | What's Required | Who |
|:------|:---------------|:----|
| Level 0 (Minimal) | stdin/stdout JSON: `HypothesisTuple` → `OracleVerdict` | Any CLI tool wrapper |
| Level 1 (Standard) | + capability advertisement, health/heartbeat, full epistemic types | Production oracle |
| Level 2 (Full) | + network transport, temporal context, deliberation | Remote service |
| Level 3 (Platform) | + cross-instance coordination, knowledge sharing | Vinyan peer instance |

A Level 0 oracle can be built in 15 lines of any language. This low barrier-to-entry is intentional: Epistemic Orchestration grows by making it trivial for external verification systems (security scanners, compliance tools, domain experts) to join the network as ECP-native Reasoning Engines.

**MCP and A2A are bridge layers, not the primary interface.** External agents that speak MCP or A2A interact with Vinyan through translation bridges that enforce trust degradation (§2.3). ECP-native engines get full epistemic semantics without translation loss.

**Full specification:** [ecp-spec.md](../spec/ecp-spec.md) — message format, epistemic semantics, transport bindings, security model, versioning, conformance levels.

**Oracle SDK:** [oracle-sdk.md](../spec/oracle-sdk.md) — developer guide for building ECP-compatible Reasoning Engines.

**Protocol architecture:** [protocol-architecture.md](../architecture/protocol-architecture.md) — transport abstraction, remote oracle pattern, bridge evolution, trust degradation matrix.

---

## 3. Reasoning Engine Model

Reasoning Engines replace the narrower “Oracle” concept from earlier designs. An Oracle only verifies (“is this true?”). A Reasoning Engine serves four distinct roles:

| Role | Function | Examples |
| :--- | :--- | :--- |
| **Verifier** | Confirms or falsifies hypotheses with evidence | AST parser, type checker, test runner |
| **Predictor** | Forecasts outcomes before execution | Self-Model forward predictor (§9), dependency analyzer |
| **Generator** | Produces candidate solutions | LLM worker, symbolic solver, template engine |
| **Critic** | Evaluates quality on multiple dimensions | Complexity analyzer, mutation tester, architecture checker |

A single engine may serve multiple roles, but the Orchestrator invokes each role explicitly via ECP — preventing conflation of “I generated this” with “I verified this.”

### 3.1 Tiered Registry

| Tier | Confidence Range | Examples | Trust Policy |
| :--- | :--- | :--- | :--- |
| **Deterministic** | ≥ 0.95 | AST parser, type checker, test runner | Accepted without review |
| **Heuristic** | 0.5 – 0.95 | Complexity metrics, LLM-as-judge (structured) | Requires corroboration |
| **Probabilistic** | 0.1 – 0.9 | LLM reasoning, statistical models | Treated as hypotheses |
| **Speculative** | < 0.5 | Creative generators, exploration engines | Requires full verification |

### 3.2 Deterministic Contradiction Resolution

When Reasoning Engines produce conflicting verdicts, the Orchestrator resolves through a deterministic decision tree — **not** LLM arbitration:

1. **Domain Separation** — Are the engines evaluating different aspects? Both valid in their respective domain.
2. **Confidence Comparison** — Higher-tier engine wins (deterministic > heuristic > probabilistic).
3. **Evidence Weight** — More concrete, verifiable evidence wins.
4. **Historical Accuracy** — Engine with better track record wins.
5. **Escalation** — Present full evidence from both sides to human for resolution.

### 3.3 LLM Integration — Generator as Reasoning Engine

An LLM is integrated as a **Generator-class Reasoning Engine** — not as the central brain, but as one engine in the tiered registry (§3.1, Probabilistic tier). The Orchestrator:

1. Assembles a structured prompt from `PerceptualHierarchy` + `WorkingMemory` (§9.4)
2. Dispatches to the LLM provider (Claude, GPT, local models) as a Generator Engine via ECP
3. Wraps the LLM response as an `ECPResponse` with `type: 'uncertain'` and `confidence` derived from the Self-Model's prediction (§9)
4. Routes the response through Verifier Engines (Oracles, §6) before any state mutation

The LLM never sees its own outputs' verification results directly — maintaining Epistemic Separation (A1). Failed approaches are conveyed through WorkingMemory as structured constraints ("do NOT try X again"), not raw Oracle verdicts.

**Provider abstraction:** The Orchestrator maintains a provider registry, routing tasks to appropriate tiers based on complexity and budget:

| Provider Tier | Examples | Use Case |
|:---|:---|:---|
| Fast / Cheap | claude-haiku, gpt-4o-mini | Level 0-1 tasks (reflex, heuristic) |
| Balanced | claude-sonnet, gpt-4 | Level 2 tasks (analytical) |
| Powerful / Expensive | claude-opus, o3 | Level 3 tasks (deliberative, PHE) |
| Local / Free | ollama, llama.cpp | Exploration, zero-cost experimentation |

### 3.4 Tool Execution — Environment Interaction

Autonomous agents must interact with their environment. Workers interact through a **restricted, Orchestrator-mediated tool set** — they never execute tools directly. Workers propose tool calls; the Orchestrator validates permissions, executes the tool in the appropriate isolation context (§5), and returns results as ECP evidence.

| Tool Category | Examples | Phase |
|:---|:---|:---|
| **Read** | File read, directory list, search (grep/semantic) | Phase 1 |
| **Write** | File create/edit, directory create | Phase 1 |
| **Execute** | Shell command, test runner, linter | Phase 1 |
| **Observe** | Git status/log/diff, HTTP GET (read-only APIs) | Phase 1 |
| **External** | MCP tools, inter-agent A2A | Phase 1B |

Tool results are wrapped as ECP evidence with provenance (file path, timestamp, content hash) before entering the World Graph. This maintains Content-Addressed Truth (A4). The permission model is risk-scoped: low-risk tasks get read + limited write; high-risk tasks get full access behind isolation boundaries.

---

## 4. Layer 0: The Cognitive & Perception Baseline

To operate autonomously at or above human capacity, an agent must possess contextual awareness and the ability to push back against flawed directives. Vinyan closes the cognitive gap between human developers and AI through four deterministic constraints at Layer 0.

* **PerceptualHierarchy Injection (Perception):** Agents are never deployed "blind." Before execution, the Orchestrator assembles a deterministic `PerceptualHierarchy`—comprising dependency cone (filtered by routing level), linter warnings, type errors, verified facts from World Graph, and runtime context—into the agent's context. Salience is deterministic: dep-oracle traverses the dependency cone from the task target, with depth controlled by routing level (L0-1 shallow, L2-3 deep). The Orchestrator also injects `WorkingMemory` containing failed approaches, active hypotheses, and unresolved uncertainties. See [architecture.md Decision 8](../architecture/decisions.md) for concrete interfaces.
* **Architectural Invariants & Epistemic Pushback (Alignment):** Vinyan rejects the LLM “helpfulness bias.” The system is governed by hardcoded architectural rules. If a human prompt or a worker’s sub-task violates these invariants (e.g., bypassing authentication), the Orchestrator outright rejects the intent, forcing a systemic pushback rather than attempting a catastrophic execution.
* **The Ephemeral Mutation Sandbox (Exploration):** Autonomy requires experimentation. Workers operate in file-based mutation sandboxes (`shadow-runner.ts`) — isolated temporary directories where proposed changes are applied and verified (compilation, type-checking, tests) before being committed to the canonical workspace. The Orchestrator creates, executes, and tears down sandboxes; workers have no direct filesystem access.
* **Multi-Modal Deterministic QA (Evaluation):** Agents are forbidden from evaluating their own success. Quality Gates are enforced exclusively by the Orchestrator via deterministic engineering tools (unit tests, AST validation) and visual regression models for UI changes.

---

## 5. The Execution Substrate: Unix Philosophy for Epistemic Systems

Long-running autonomous systems degrade due to state contamination and memory leaks. Vinyan mitigates this by eliminating shared-memory event loops entirely.

* **OS-Level Ephemeral Processes:** Every cognitive worker is instantiated as an isolated child process. The Orchestrator remains decoupled from the worker’s execution thread. If a worker hallucinates into an infinite loop or exceeds memory boundaries, the OS terminates the process immediately, preserving the Orchestrator’s integrity.
* **Filesystem as IPC:** Communication relies on a “crash-only” durable filesystem contract. The Orchestrator writes intent specifications to an isolated workspace. The worker awakens, processes the inputs, and writes telemetry and results back to disk before terminating. Zero memory is shared across boundaries.
* **Tool Execution via Orchestrator:** Workers do not execute tools (file I/O, shell commands, search) directly. They propose tool calls as part of their output; the Orchestrator validates permissions, executes the tool in the appropriate isolation context, and returns results as ECP evidence. This maintains Zero-Trust Execution (A6) for environment interaction — not just code generation.
---

## 6. Truth Maintenance & Verification

LLMs suffer from epistemic arrogance—confidently asserting hallucinated facts. Vinyan intercepts this via a programmatic verification layer backed by the Reasoning Engine model (§3).

* **The Hypothesis Tuple:** Workers cannot dynamically script queries against the environment. They must formulate a structured hypothesis (Target + Pattern).
* **Reasoning Engine Verification:** The Orchestrator processes the hypothesis using Reasoning Engines—primarily deterministic tools (AST parsers, type checkers, test runners, linters). Only if the engine programmatically verifies the pattern is the data committed to the **World Graph** as a verified fact, bound to the file’s content hash (SHA-256). Any subsequent file mutation instantly invalidates dependent facts. Reasoning Engines communicate with the Orchestrator via ECP (§2). For external Oracle integration, third-party verification tools can bridge into the ecosystem as MCP Servers via the External Interface channel (§2.1).
* **Dependency Edges in World Graph:** Beyond storing flat verified facts, the World Graph maintains **dependency relationships** between facts ("function A calls function B", "module X imports module Y", "changing schema Z invalidates queries Q1-Q3"). These edges are deterministically derived from AST analysis and are verifiable, not predicted. They enable the Orchestrator to answer "what will break if I change X?" through static graph traversal—not speculation.
* **Multi-Dimensional Quality Signal:** Oracle verdicts extend beyond binary pass/fail to provide a **composite quality score**: code complexity delta, test mutation score, architectural compliance, and efficiency (tokens consumed / quality achieved). This continuous signal replaces the crude pass/fail as the primary feedback to the Evolution Engine, enabling gradient-based learning—“approach A is 30% better than approach B” rather than “both pass.”
* **Verification Scope & Limitations:** Current Reasoning Engines verify **structural properties only**: syntax validity, type correctness, import resolution, test pass/fail, function signature matching. This is a deliberate scope constraint, not an oversight.

  **What structural verification catches:** hallucinated function names, wrong parameter types, broken imports, non-existent API calls, type mismatches — errors where the LLM "believes" code is correct but deterministic tools can falsify the claim. These are common in LLM-generated code and are not fully caught by IDE/LSP because (a) the LLM generates code outside an IDE context, and (b) verification happens *before* the code is written to disk, preventing broken intermediate states.

  **What structural verification does NOT catch:** incorrect business logic, wrong algorithm choice, race conditions, semantic misunderstanding of requirements, incorrect assumptions about external APIs. These require higher-tier verification approaches — property-based testing (Phase 2), mutation testing (Phase 2), formal specification checking (Phase 3+), and human review for subjective design decisions. The tiered registry (§3.1) distinguishes these confidence levels explicitly: **deterministic** (≥ 0.95: AST, type checker, test runner), **heuristic** (0.5–0.95: complexity metrics, LLM-as-judge with structured protocol), and **probabilistic** (0.1–0.9: LLM reasoning, statistical models).

  **Phase 1 Semantic Verification Strategy:** Rather than deferring all semantic verification to Phase 3+, Phase 1 introduces three concrete approaches that extend verification beyond structural properties:
  1. **LLM-as-Critic with structured rubrics** — a separate LLM instance (not the generator) evaluates code against explicit criteria (correctness, edge cases, naming clarity) using a structured scoring protocol. Registered as a `probabilistic` tier engine. The Critic's verdict carries `type: 'uncertain'` with confidence derived from rubric agreement, NOT from the LLM's self-reported confidence.
  2. **Test generation as verification** — after code generation, the system generates targeted test cases (edge cases, boundary conditions) and runs them. Test failures provide semantic signal that structural verification misses. Test generation uses the Generator Engine; test execution and result evaluation are deterministic.
  3. **User-provided acceptance criteria** — users can specify machine-checkable acceptance criteria ("function must handle null input", "response time < 200ms") that are converted to test assertions. This bridges the gap between subjective requirements and deterministic verification.

  These approaches do not eliminate the semantic gap — they narrow it. Semantic verification remains fundamentally harder than structural verification, and Vinyan is honest about the confidence levels each approach provides.

  **World Graph scalability:** Phase 0 targets single-file TypeScript mutations with a local SQLite-backed World Graph. Multi-file scalability (Phase 1+) requires: (a) **lazy invalidation** — only recompute hashes for files in the active dependency cone, not the entire project, (b) **bounded propagation depth** — invalidation cascades are capped at a configurable depth (default: 3 hops) to prevent infinite loops in circular dependency graphs, (c) **write-ahead logging** — SQLite WAL mode for concurrent read/write access during mutations. Cross-language AST unification is deferred to Phase 2.
---

## 7. Asymmetric Mutation Protocol (Zero-Trust Execution)

Autonomic tool synthesis—allowing an AI to write and execute its own scripts on the fly—is a critical vulnerability. Vinyan implements a **Four-Phase Commit** protocol for state mutations.

1.  **Phase 1: Intent Proposal (The Draft):** The worker formulates a structural mutation intent (e.g., a unified diff). It possesses zero execution privileges.
2.  **Phase 2: Blast Radius Calculation:** The Orchestrator statically analyzes the intent, assigning a Risk Score based on dependency graphs and file volatility.
3.  **Phase 3: Shadow Execution (Validation):** High-risk mutations are piped into a hardened microVM or isolated container. The Orchestrator runs deterministic gates (compilation, type-checking) against the mutated state.
4.  **Phase 4: The Commit:** The Orchestrator applies the mutation to the canonical environment *only* if all deterministic tests pass.

**Routing-Level Phase Mapping:** Not every mutation requires all four phases. The Orchestrator selects phases based on the task's routing level (§8):

| Routing Level | Phase 1 (Intent) | Phase 2 (Blast Radius) | Phase 3 (Shadow) | Phase 4 (Commit) | Latency Budget |
|:---|:---|:---|:---|:---|:---|
| **L0 (Reflex)** | ✅ | ❌ skip | ❌ skip | ✅ (hash-verified) | < 100ms |
| **L1 (Heuristic)** | ✅ | ✅ (lightweight) | ❌ skip | ✅ | < 2s |
| **L2 (Analytical)** | ✅ | ✅ (full) | Conditional* | ✅ | < 10s |
| **L3 (Deliberative)** | ✅ | ✅ (full) | ✅ (mandatory) | ✅ | < 60s |

\*L2 Shadow Execution triggers only when blast radius exceeds a configurable threshold (default: 5 affected files or risk score > 0.7).

These latency targets are **design constraints**, not aspirations — if Oracle verification cannot meet the budget for a given routing level, the Oracle is either optimized, made asynchronous (non-blocking verification that can roll back), or excluded from that level's pipeline.

Two additional safety dimensions extend the protocol:

* **Production Boundary Classification:** Every mutation target is classified by environment (development / staging / production). Mutations affecting production systems (database operations, API calls, deployments) that **cannot be git-reverted** automatically escalate to Risk > 0.9, requiring Level 3 (Deliberative) execution with explicit human approval. This prevents the class of catastrophic failures where an autonomous agent irreversibly damages production data.
* **Adversarial Input Defense:** Workers receive external content (code comments, API responses, user messages) that may contain prompt injection attacks designed to bypass Oracle validation. The Mutation Protocol enforces: (1) **input sanitization** before content enters worker prompts, (2) **Oracle independence**—Oracles verify actual code artifacts, never worker claims about code, and (3) any worker output referencing “skip Oracle” or “bypass validation” is automatically rejected by the Orchestrator.
---

## 8. Economic & Risk-Based Routing

Infinite retry loops are financially and computationally irresponsible. Vinyan schedules tasks based on empirical risk and actual computational cost, measured in normalized **Vinyan Credits** (pegged to real-world USD constraints).

Rather than a binary System 1/System 2 switch, routing operates as a **four-level continuum** with deterministic escalation rules:

| Routing Level | Trigger Conditions | Execution Profile | Lifecycle Steps |
| :--- | :--- | :--- | :--- |
| **Level 0 (Reflex)** | Known pattern with cached solution | Near-instant retrieval, zero LLM cost. | Perceive → Retrieve → Verify (hash) → Commit |
| **Level 1 (Heuristic)** | Low Risk Score, Standard Budget | Single model, single pass, light verification. Default for routine tasks. | Perceive → Generate → Verify → Commit |
| **Level 2 (Analytical)** | Moderate Risk, Novel Dependencies | Single model, multi-pass with full Oracle verification. | Perceive → Predict → Plan → Validate Plan → Generate → Verify + QualityScore → Learn |
| **Level 3 (Deliberative)** | High Blast Radius, High Uncertainty | Parallel hypothesis exploration within isolated shadow environments. Selects optimal mutation based on programmatic QA pass rates, not LLM confidence. | Perceive → Predict → Plan (iterative + Critic) → Validate Plan → Generate (PHE) → Verify + QualityScore + Shadow → Learn |

> **Design note:** The previous “MCTS” framing has been revised. Software engineering search spaces are combinatorially explosive without clean reward signals (unlike game playing). **Parallel hypothesis generation with structured selection** (closer to beam search) better describes the actual mechanism.

* **Iterative Task Decomposition with Oracle Validation:** Task decomposition—breaking a user request into executable subtasks—is the single most consequential decision in an agent pipeline (UC Berkeley, 2025: wrong decomposition = 100% downstream waste). Rather than a single Planner LLM call, Vinyan decomposes **hierarchically with Oracle validation at each level**: high-level DAG (2-3 subtasks) → dep-oracle validates structure + semantics-oracle validates coverage → for each subtask, decompose further → validate sub-DAG against parent + siblings (no overlap, no gap) → execute only leaf tasks. This ensures decomposition errors are caught before any computation is wasted.

**Decomposition is LLM-assisted, not deterministic.** The initial task decomposition (breaking a user request into a high-level DAG) uses an LLM in its Generator Engine role (§3.3). The Orchestrator does not decompose tasks through rules alone — natural language understanding requires an LLM. However, the Orchestrator's governance of decomposition is deterministic: it validates each decomposition level through Oracles, enforces structural constraints (no overlap, no gap, dependency ordering), and rejects invalid DAGs. The distinction is: **LLMs generate candidate decompositions; the Orchestrator validates and commits them.** This is consistent with A3 (Deterministic Governance) — governance decisions are rule-based, even when the inputs to those decisions come from probabilistic sources.
---

## 9. Self-Model — Heuristic Prediction Loop

The Self-Model is Vinyan's lightweight prediction mechanism — it estimates outcomes before execution using heuristic rules, compares predictions against actual results, and uses the delta as a learning signal. It is NOT a learned forward model or neural predictor; it starts as static rules and improves through calibration.

> **Honest timeline:** The Self-Model provides near-zero practical value during its first ~100 tasks. Cold-start safeguards correctly override predictions for 50 tasks; meta-confidence is forced low with <10 observations per pattern. The Self-Model's primary Phase 1 value is **data collection** — recording prediction/actual pairs that seed Phase 2 calibration. Visible routing improvement requires ~200+ tasks (months of real use). Users should not expect intelligent routing from the Self-Model in early operation — it is an investment in future capability, not an immediate feature.

### 9.1 Heuristic Prediction

Before dispatching a worker, the Self-Model predicts using deterministic heuristics (file count, dependency depth, test count, historical pass rates):

- **Expected test results** — “14/15 pass; test X may fail due to dependency Y”
- **Expected blast radius** — which files and modules are affected (from World Graph dependency edges)
- **Expected duration** — resource consumption estimate based on task size
- **Uncertainty areas** — "low confidence about Z's dependency chain"

After execution, prediction is compared against actual Reasoning Engine results. **Prediction error is the primary learning signal** for the Evolution Engine (§10) — not task success/failure alone.

### 9.2 Cold Start → Auto-Calibration

1. **Cold start** — heuristic predictions from static rules (file count, test count, dependency depth)
2. **Active calibration** — after each task, record predicted vs. actual outcomes → compute calibration error
3. **Drift detection** — if prediction accuracy degrades beyond threshold → trigger recalibration cycle

**Cold-start safeguards** to prevent bad predictions from poisoning the calibration loop:
- **Conservative override period:** During the first N tasks (configurable, default: 50), the Self-Model's routing recommendations are advisory only — the Orchestrator defaults to L2 (Analytical) minimum, regardless of Self-Model prediction. This prevents under-routing during calibration.
- **Meta-uncertainty:** The Self-Model outputs not just a prediction but a **confidence-in-prediction** score based on sample size. With < 10 observations for a task pattern, meta-confidence is forced to < 0.3, triggering conservative fallback.
- **Human audit sampling:** During calibration (first 100 tasks), 10% of routing decisions are flagged for optional human review. This provides ground truth for cases where both the Self-Model and Oracles may be miscalibrated.
- **Monotonic trust ramp:** The Self-Model's influence on routing increases monotonically as calibration error decreases — it cannot gain authority faster than its accuracy improves.

### 9.3 Stuck Detection

The Self-Model monitors execution state for simple signals:

- **"Am I stuck?"** → retried same approach 2+ times → signal for strategy pivot
- **"Is this too hard?"** → risk score exceeds routing level threshold → escalate routing level (§8)
- **"Should I ask for help?"** → prediction confidence below minimum + budget near limit → human escalation with context package

> **Scope note:** This is pattern-matching on execution traces, not metacognition. Full metacognitive monitoring (learning which task types need which execution level) is a Phase 2+ research question. **However, Self-Model is a Phase 1 deliverable** with concrete interfaces in [architecture.md Decision 11](../architecture/decisions.md). Phase 1 prediction accuracy is ~50-60% with static heuristic rules — the value is in starting the calibration loop early, not in accurate initial predictions.
---

### 9.4 Working Memory

Working Memory is maintained by the Orchestrator (not workers) and persists across retries within a task. It contains:

- **failedApproaches**: approach + Oracle verdict evidence → injected as hard constraints ("do NOT try X again")
- **activeHypotheses**: what the current plan is testing, with Self-Model confidence scores
- **unresolvedUncertainties**: areas where Self-Model has low prediction confidence
- **scopedFacts**: verified facts from World Graph, filtered to the task's dependency cone

Working Memory turns "retry" into "replan with evidence" — after Oracle rejection, the failed approach is recorded and the lifecycle re-enters at the Plan step (not Generate). After N failures **per routing level** (configurable, default 3), the routing level auto-escalates.

See [architecture.md Decision 8](../architecture/decisions.md) for the concrete `WorkingMemory` interface.
---

## 10. Evolutionary Governance & Telemetry

An epistemic nervous system must evolve its fleet and rulesets based on empirical outcomes, not semantic noise.

Evolution in Vinyan operates at **two speeds**: (1) **Fast loop** — real-time in-session learning: the approach blacklist prevents retrying failed strategies within the same task, and outcome records accumulate for later analysis. (2) **Slow loop** — between-session analysis extracts patterns from accumulated traces to generate new rules. This dual-speed design ensures both immediate behavioral adaptation and long-term structural improvement.

> **QualityScore integration**: Evolution Engine consumes **QualityScore** (multi-dimensional quality signal: architectural compliance, efficiency, complexity delta, mutation test score) and **PredictionError** (Self-Model predicted vs actual outcomes) as primary learning signals. Binary pass/fail is necessary but not sufficient for meaningful calibration — without quality signal, the system can only learn "what fails" but never "what succeeds well." See [architecture.md Decision 10](../architecture/decisions.md) for the `QualityScore` interface.

* **Rule Consolidation (The Sleep Cycle):** Vinyan does not dump all interactions into a vector database. It logs structural regressions and failures as immutable traces. During asynchronous background cycles, the system analyzes accumulated traces to extract anti-patterns and successful strategies, decaying irrelevant patterns to prevent unbounded knowledge accumulation. The implementation includes: (1) anti-pattern extraction with Wilson LB significance testing (fail rate ≥80%, LB ≥0.6), (2) success pattern extraction with pairwise trace comparison, (3) cross-task correlation mining across 2-attribute combinations (model, routing level, blast radius bucket, oracle verdict pattern), (4) counterfactual routing analysis ("what if routed one level higher?"), (5) exponential and power-law decay with A/B comparison, and (6) rule backtesting with promotion/retirement lifecycle. Neural replay remains a theoretical extension explored in [theory.md](theory.md).
* **Cached Solution Patterns:** When the same task pattern succeeds repeatedly with the same approach, that approach is cached as a shortcut (populating Level 0 Reflex in §8). This is simple memoization of proven strategies, not hierarchical skill composition or “compression as intelligence” — those are theoretical extensions explored in [theory.md](theory.md).
* **Meritocratic Fleet Governance:** Identity and capability are decoupled. Worker profiles are managed in a flat, concurrent registry. New configurations begin on “Probation” and are promoted to the active roster only after achieving a statistically significant pass rate through deterministic Quality Gates. Underperforming configurations are automatically demoted.
* **Bounded Self-Modification (Safety Invariants):** The Evolution Engine may modify operational rules (Oracle configurations, risk thresholds, worker configurations, routing models) but **cannot** modify immutable invariants: human escalation triggers, security policies, budget hard limits, minimum test requirements, and rollback capability. This bounded rule adjustment ensures the system can improve without violating safety constraints.

> **Mechanism assessment (updated Phase 6):** The Evolution Engine is a **statistical analytics pipeline** that extracts failure patterns, generates counterfactual routing analyses, and adjusts operational thresholds through backtested rules. Phase 2 introduced frequency-based pattern detection with probation/promotion lifecycle. Phase 3 added: counterfactual generation (what-if routing analysis with Wilson LB confidence), cross-task correlation mining (2-attribute combination analysis), trace-calibrated Self-Model (replaces static heuristics with per-task-type EMA), and fuzzy skill matching for cross-task generalization. The term "evolution" describes the *direction* (the system improves over time) and the *mechanism* (statistical pattern extraction → rule generation → backtesting → promotion/retirement). True autonomous strategy invention — producing fundamentally novel approaches rather than pattern-based optimization — remains a research frontier.
---

## 11. Multi-Instance Coordination

> **Status: Implemented.** A2AManager orchestrates 8+ sub-managers (PeerTrust, CostTracker, RetractionManager, PeerHealthMonitor, RemoteBusAdapter, CapabilityManager, CalibrationExchange, and feature-flagged components). 30 source files, 28 test files.

ECP’s design allows multiple Vinyan instances to communicate as peer Reasoning Engines. Each instance registers capabilities in the tiered registry (§3.1); inter-instance communication uses the same ECP semantics as internal communication via the network-aware ECP transport (§2.4). The full inter-instance protocol is specified in [a2a-protocol.md](../spec/a2a-protocol.md).

### 11.1 Coordination Topology

Vinyan uses a **flat peer mesh** — no super-orchestrator, no leader election. Each instance’s Orchestrator remains sovereign over its own task lifecycle (A3: deterministic local governance). Coordination is **advisory**: shared knowledge, optional delegation, cross-instance verification requests. No remote instance can override local governance decisions (safety invariant I12).

```
Instance A (frontend specialist)          Instance B (backend specialist)
┌──────────────────────────┐              ┌──────────────────────────┐
│ Local Orchestrator       │◄────ECP─────►│ Local Orchestrator       │
│ Local Oracles            │  Network     │ Local Oracles            │
│ Local World Graph        │  Transport   │ Local World Graph        │
│ Local Self-Model         │  (§2.4)      │ Local Self-Model         │
└──────────────────────────┘              └──────────────────────────┘
```

**Why no leader:** Leader election introduces a single point of failure and requires consensus protocols (Raft, Paxos) that add latency and complexity. Vinyan’s advisory model means partition tolerance is trivial — a partitioned instance simply continues with local-only resources. The cost is potential duplicate work (two instances may process the same task type independently), which is acceptable given the advisory model.

### 11.2 Instance Discovery & Identity

Each instance publishes a capability descriptor via `.well-known/vinyan.json`:

```typescript
interface InstanceDescriptor {
  instance_id: string;               // stable UUID, generated on first run
  protocol_version: number;          // ECP version for compatibility check
  capabilities: {
    oracle_types: string[];          // ["ast", "type", "dep", "test", "lint"]
    languages: string[];             // ["typescript", "python", "go"]
    domain_tags: string[];           // ["frontend", "backend", "infra"]
    active_workers: number;
  };
  health: {
    status: "healthy" | "degraded" | "draining";
    uptime_ms: number;
    current_load: number;            // 0.0–1.0
  };
  endpoint: string;                  // WebSocket/HTTP URL for ECP network transport
  public_key: string;                // Ed25519 public key for message verification
}
```

Discovery modes:
1. **Static config** (Phase 5 default): Peers listed in `vinyan.json` under `phase5.instances.peers`
2. **Descriptor polling**: Periodically fetch `/.well-known/vinyan.json` from configured peer URLs
3. **Dynamic discovery** (future): mDNS/DNS-SD for local network, registry service for cloud

### 11.3 Task Delegation

When an instance encounters a task outside its capability (e.g., Python verification on a TypeScript-only instance), it may delegate to a peer:

1. **Capability check**: Query known peers’ `InstanceDescriptor.capabilities` for matching oracle types / languages
2. **Delegation**: Send `TaskInput` + `PerceptualHierarchy` + `TaskFingerprint` via ECP network transport
3. **Re-verification**: Delegating instance **always** re-verifies the result locally with whatever oracles it has (A6: zero-trust). Remote results enter with confidence cap (§2.4)
4. **Timeout**: Delegation has a hard timeout (configurable, default 60s). On timeout, the task falls back to local processing or escalation

Delegation is **never mandatory** — it is an optimization. A partitioned instance processes tasks with degraded capability rather than blocking.

### 11.4 Cross-Instance Knowledge Sharing

Sharing follows Phase 4’s `AbstractPatternExport` format with additional provenance:

- **Rules**: Effectiveness-proven rules shared during Sleep Cycle. Enters remote instance at `status: ‘probation’` (I14)
- **Skills**: High-success-rate cached skills shared. Confidence reduced 50% on import
- **Self-Model parameters**: Calibrated EMA parameters warm-start peer instances (enters `basis: ‘hybrid’`)
- **Worker profiles**: When instances share `WorkerConfig.modelId`, capability scores bootstrap peer selection

All shared knowledge carries a provenance chain: `source_instance_id → original_ids → transformation_history → local_probation_status`.

### 11.5 Partition Tolerance

Network partitions are inevitable in distributed systems. Vinyan’s partition strategy follows the advisory coordination model:

**During partition:**
- Each instance operates independently with local-only resources (full capability, reduced knowledge sharing)
- No write to shared state — all writes are local
- Delegated tasks in-flight at partition time: timeout → fallback to local processing
- No split-brain risk because there is no shared mutable state requiring consensus

**On partition heal:**
- Instances exchange Sleep Cycle summaries accumulated during partition
- Knowledge sharing resumes: new rules/skills enter probation on the receiving side
- No automatic state merge — each instance’s local state is authoritative for its own operations
- Conflicting rules (promoted on A, retired on B) resolve by: the local instance’s decision takes precedence locally

**CAP theorem position:** Vinyan chooses **AP (Availability + Partition tolerance)** over Consistency. Each instance is always available and processes tasks independently. Cross-instance knowledge is eventually consistent (shared during Sleep Cycle, enters probation). This is appropriate because:
1. No governance action depends on remote state (A3)
2. Knowledge sharing is advisory, not authoritative (I14: always enters probation)
3. The cost of unavailability (blocked tasks) exceeds the cost of temporary knowledge divergence

### 11.6 Cross-Instance Contradiction Resolution

When remote evidence contradicts local evidence, the 5-step Deterministic Contradiction Resolution (§3.2) extends with an additional precedence rule:

1. **Domain Separation** — Are the engines evaluating different aspects?
2. **Local vs Remote** — **Local evidence takes precedence over remote evidence of the same tier** (A5 + §2.4 confidence degradation)
3. **Confidence Comparison** — Higher-tier engine wins (deterministic > heuristic > probabilistic)
4. **Evidence Weight** — More concrete, verifiable evidence wins
5. **Historical Accuracy** — Engine with better track record wins
6. **Escalation** — Present full evidence from both sides to human

### 11.7 World Graph Federation

In multi-instance mode, each Vinyan instance maintains its **own local World Graph** (SQLite). There is no shared database — SQLite's single-writer limitation makes a centralized multi-instance World Graph impractical.

**Architecture:**
```
Instance A                          Instance B
┌───────────────────┐               ┌───────────────────┐
│ Local World Graph │               │ Local World Graph │
│ (authoritative)   │◄──facts via──►│ (authoritative)   │
│ - local facts     │   ECP §2.4    │ - local facts     │
│ - remote facts    │               │ - remote facts    │
│   (provenance-    │               │   (provenance-    │
│    tagged)        │               │    tagged)        │
└───────────────────┘               └───────────────────┘
```

**Rules:**
1. **Local facts are authoritative.** Each instance's oracle verdicts produce facts bound to local file hashes (A4). These are the ground truth for that instance.
2. **Remote facts enter as supplementary.** Facts received via knowledge sharing (§11.4) are stored with `source_instance_id` provenance and `confidence × 0.8` (reduced trust, A5).
3. **No shared writes.** Instances never write to each other's World Graph. Knowledge transfer is a copy operation, not a synchronization.
4. **File hash invalidation is local-only.** When Instance A's file watcher detects a change, only Instance A's facts are invalidated. Instance B's copy of the same fact remains valid until Instance B independently detects the file change.
5. **Conflicting facts.** If local and remote facts for the same target disagree, the local fact takes precedence. Remote fact is marked `stale` and re-requested on next interaction.
6. **Dependency edges are local.** Each instance builds its own dependency graph from its local workspace. Cross-instance dependency queries are best-effort enrichment, not authoritative.

**Why not CRDT/merge:** World Graph facts are content-addressed (A4) — their validity depends on local file state. Merging remote facts without access to the remote filesystem would produce facts that cannot be verified locally, violating A1 (epistemic separation). The federation model preserves local verification integrity.

---

## 12. Evolution Pathway

| Phase | Milestone | Key Capability | Axioms Proven |
| :--- | :--- | :--- | :--- |
| **0** | Oracle Gate MVP | Verification library inside host agent. AST/type/dep checks + content-addressed fact database. Proved A1 + A4 measurably reduce structural hallucination (100% structural error reduction in A/B experiment). | A1, A4 ✅ |
| **1** | Autonomous Agent | Standalone agent: rule-based Orchestrator core loop (Perceive→Predict→Plan→Generate→Verify→Learn) + LLM Generator Engines + Tool Execution + 4-level risk routing + ECP + Self-Model + semantic verification (LLM-as-Critic, test generation) + MCP External Interface. | A1, A2, A3, A6 ✅ |
| **2** | Multi-Worker + Skill Formation | OS-level process isolation + Shadow Execution + Sleep Cycle (frequency-based pattern extraction → rule generation → backtesting → promotion/retirement) + Level 0 skill cache with probation/promotion. | A3, A6 (hardened) ✅ |
| **3** | Full Self-Improvement | Counterfactual routing analysis + cross-task correlation mining (2-attribute with Wilson LB) + trace-calibrated Self-Model (per-task-type EMA, replaces static heuristics) + fuzzy skill matching + pattern decay (exponential/power-law A/B) + miscalibration detection. | A7 (full loop) ✅ |
| **4** | Fleet Governance | Meritocratic worker profiles (probation→active→demoted→retired with Wilson LB gates) + capability-based routing + worker performance pattern mining. | All axioms at scale ✅ |
| **5** | Complete ENS Platform | Standalone platform (API server, terminal UI, web dashboard, VS Code extension) + multi-instance coordination (A2A with 8+ sub-managers, peer trust, knowledge exchange) + cross-language oracle support (Python/Go/Rust) + **ECP as publishable protocol standard** ([ecp-spec.md](../spec/ecp-spec.md)) + Oracle SDK ([oracle-sdk.md](../spec/oracle-sdk.md)) + A2A + MCP protocol bridges ([protocol-architecture.md](../architecture/protocol-architecture.md), [a2a-protocol.md](../spec/a2a-protocol.md)). | All axioms at platform scale ✅ |
| **6** | Agentic Worker Protocol | Multi-turn tool loop with AgentSession state machine + AgentBudget (3-pool: context/inference/delegation with adaptive alpha) + SessionOverlay (CoW filesystem with OCC) + DelegationRouter (task decomposition with budget derivation) + capability routing by level (L0 single-shot, L1-L2 agentic with tools, L3 container-isolated). 45/45 implementation steps complete. | A6 (full agentic isolation) ✅ |

### 12.1 Phase 0 — Oracle Gate MVP (Historical Specification)

> **Historical record.** Phase 0 has been completed — the hypothesis was confirmed (100% structural error reduction). This section is preserved as the original experimental design.

Phase 0 existed to prove **one hypothesis**: deterministic external verification (A1) measurably reduces structural hallucination in LLM-generated code.

**Deliverables:**

| Component | Implementation | Purpose |
| :--- | :--- | :--- |
| `ast-oracle` | tree-sitter | Verify symbol existence, function signatures, import relationships |
| `type-oracle` | `tsc --noEmit` / Pyright | Verify type correctness of proposed changes |
| `before_tool_call` hook | Claude Code hooks / OpenClaw | Intercept file mutations, construct HypothesisTuple, route to oracles |
| World Graph | SQLite + file watcher | Store verified facts with content-hash binding (A4), auto-invalidate on file change |
| Approach blacklist | In-memory per session | Prevent retrying failed strategies within a session (fast-loop learning) |

**Experimental Protocol:**

| Parameter | Value |
|:---|:---|
| **Baseline** | Claude Code (or OpenClaw) performing N tasks without oracle gate |
| **Treatment** | Same agent + oracle gate hooks |
| **Task set** | ≥ 30 TypeScript mutation tasks, stratified: 10 simple (rename, add field), 10 moderate (refactor function, change interface), 10 complex (cross-module change) |
| **Primary metric** | Structural error rate: broken imports, type errors, wrong signatures, non-existent symbol references |
| **Minimum effect size** | ≥ 25% reduction in structural error rate (treatment vs baseline) |
| **Secondary metrics** | False positive rate (oracle rejects correct code) < 10%; latency overhead < 3s per mutation (L1 budget) |
| **Statistical test** | Paired comparison (same tasks, with/without oracle); Wilcoxon signed-rank test, α = 0.05 |
| **Go/No-Go** | Primary metric met AND false positive rate acceptable → proceed to Phase 1. Otherwise → analyze failure modes, iterate oracle design, or stop. |

This is a pre-registered experimental design. Adjusting success criteria after observing results invalidates the experiment.

**Scope constraints:** Single-file TypeScript mutations. Multi-file blast radius analysis, cross-language support, and heuristic oracles deferred to Phase 1. No Self-Model, no Evolution Engine, no Fleet Governance — those require runtime data that Phase 0 collects.

**What Phase 0 is NOT:** It is not a framework, not an SDK, not a product, and not an AI agent. It is a **verification library** inside a host agent — a scientific experiment with a measurable outcome. The "Epistemic Orchestration" paradigm names the architectural vision; "ENS" names the verification substrate. Phase 0 proves the verification thesis (A1 + A4); Phase 1 proves the agent thesis (A3 + A6); the full paradigm emerges across Phases 2–5. If the oracle gate does not reduce hallucination meaningfully, the architectural thesis is wrong and Vinyan pivots or stops.

---

## 13. Research-Validated Protocol Extensions

Literature review (2025–2026) confirms five extensions required for ENS completeness. Each has academic or industry backing; integration priority varies.

### 13.1 Deliberation Depth Signal — CONFIRMED

ECP §2.2 now includes `deliberation_request` — an engine can signal insufficient reasoning depth and request additional compute. This aligns with **test-time compute scaling** research: adaptive (L2) methods dynamically adjust computation based on task complexity and model confidence. The "Reasoning on a Budget" survey (arXiv:2507.02076) categorizes approaches as controllable (fixed budget) vs. adaptive (dynamic allocation). DAST introduces Token Length Budget for difficulty-aware reasoning; state-conditional verification budgets allocate more verification to ambiguous branching points (arXiv:2602.03975). The HILA metacognitive policy framework (Yang et al., arXiv:2603.07972) uses dual-loop policy optimization to govern when agents act autonomously vs. defer to humans — structurally analogous to ECP's routing levels.

### 13.2 Temporal Evidence Protocol — CONFIRMED

ECP §2.2 now includes `temporal_context` — evidence carries temporal provenance (when observed, expiry, supersession chain). The World Graph (§6) invalidates facts by content hash but previously lacked episodic history. **REMem** (ICLR 2026, Shu et al.) demonstrates that time-aware gists combined with hybrid memory graphs enable episodic reasoning and more robust refusal behavior for unanswerable questions. The graph-based agent memory taxonomy (arXiv:2602.05665) identifies temporal graphs as a distinct architectural category alongside knowledge graphs and hypergraphs. Active ecosystem: Mem0, Memori, OMEGA — all addressing the gap between semantic-only and episodic memory.

### 13.3 Proactive Background Cognition — DEFERRED (Phase 3+, not designed)

All sections above describe request-response cognition. Industry is moving toward persistent background agents: Ona Automations (57% of Ramp’s merged PRs run as background agents), Karpathy’s “AI Claws” (March 2026). Vinyan’s Sleep Cycle (§10) runs offline between sessions; a Background Sentinel mode could enable continuous low-priority monitoring during active sessions. **This is explicitly out of scope for Phase 0–2.** The resource model, token budget implications, and privacy considerations are unresolved. Noted here only as an industry trend to track, not a planned feature.

### 13.4 Recursive Verification & Trust Bootstrap — CONFIRMED

Who verifies the Verifier? **Recursive Self-Critiquing** (arXiv:2502.04675) demonstrates progressive accuracy improvement through critique chains: $C^1 \to C^2$ achieves 66% → 82% → 90% on GAOKAO Math benchmarks. Vinyan's Critic role (§3) provides the mechanism; the missing piece is an explicit **cross-validation protocol**: (1) Verifier $V_1$ checks output, (2) independent Verifier $V_2$ checks $V_1$'s verdict, (3) disagreement triggers Contradiction Resolution (§3.2). For trust bootstrap at initialization: initial tier assignments are human-set (Phase 0–1); the Evolution Engine (§10) promotes/demotes engines based on empirical accuracy, with **human governance as the ultimate trust anchor** — consistent with the immutable invariants principle.

### 13.5 Creativity Protection Zone — PARTIALLY CONFIRMED

If governance is too restrictive, LLMs are reduced to pure hypothesis generators with no exploratory agency. **ActSafe** (ICLR 2025, As et al.) formalizes safe exploration: maintain a pessimistic set of safe policies, then optimistically explore within that set to maximize epistemic information gain. Applied to Vinyan: §8 Routing should reserve an explicit **exploration budget** — a percentage of compute allocated to Speculative-tier engines (§3.1) that generate creative solutions outside verified patterns, subject to: (a) sandbox execution only (§7 Phase 3), (b) full verification before any commit, (c) exploration results feed the Sleep Cycle (§10) for potential skill formation. This embodies the core design tension: **the right to not know + the right to try** must coexist within governed boundaries.

---

## 14. Failure Modes & Recovery

No system is immune to failure. This section documents the top failure scenarios and their recovery strategies — not as a complete fault tree, but as evidence that failure paths have been considered in the design.

| # | Failure Mode | Cause | Impact | Recovery Strategy |
|:---|:---|:---|:---|:---|
| **F1** | Oracle false negative (rejects correct code) | tree-sitter grammar bug, tsc version mismatch, overly strict pattern matching | Valid mutation blocked; developer friction | Configurable override: human can force-commit with audit trail. Oracle accuracy tracked — systematic false negatives trigger Oracle review (§10 Evolution Engine). Phase 0 metric: false positive rate < 10%. |
| **F2** | Oracle false positive (accepts incorrect code) | Verification scope gap (§6) — structural check passes but semantic error exists | Incorrect code committed to codebase | Mitigated by tiered verification: no single Oracle is the sole gate. Multi-dimensional QualityScore (§6) provides additional signal. Semantic errors are explicitly out of scope for deterministic Oracles — they require test coverage (test-oracle) or human review. |
| **F3** | World Graph inconsistency | Race condition between file watcher and mutation; crash during graph update | Stale or contradictory facts used for verification | SQLite WAL mode + write-ahead journaling. On detected inconsistency: invalidate the entire dependency cone of affected files and rebuild from source. Content-hash binding (A4) ensures inconsistency is always detectable — a hash mismatch triggers automatic revalidation. |
| **F4** | Self-Model miscalibration cascade | Bad initial predictions → wrong routing → poor outcomes → feedback reinforces bad model | Systematic resource waste (over/under-routing) | Cold-start safeguards (§9.2): conservative override period, meta-uncertainty, monotonic trust ramp. Hard floor: Self-Model cannot route below L1 for any task with blast radius > 1 file. |
| **F5** | Risk scoring systematically miscalibrated | Heuristic weights don't match actual project risk profile | High-risk tasks under-protected; low-risk tasks over-verified | Evolution Engine (§10) adjusts risk weights based on prediction error (A7). Immutable safety floor: any mutation touching production systems is always ≥ L3 regardless of risk score. Human can override risk assessment upward (never downward without audit). |

**Design principle:** Failure recovery in Vinyan follows a consistent pattern: **detect** (content hashes, prediction error, accuracy tracking) → **contain** (invalidate affected scope, not the whole system) → **recover** (rebuild from source of truth) → **learn** (feed failure into Evolution Engine). The system is designed to be resilient to individual component failures, not immune to them.

---

## Conclusion

Vinyan is built on seven Core Axioms (§1.1) — all proven in implementation across Phases 0–6. The three innovations that distinguish it from current agent frameworks:

1. **Epistemic Separation (A1)** — enforced architecturally through the Reasoning Engine model (§3) and Mutation Protocol (§7). No component evaluates its own output. This is the single principle that justifies Vinyan's existence.
2. **First-Class Uncertainty (A2)** — encoded in the Epistemic Communication Protocol (§2). "I don't know" is a protocol state that triggers specific orchestrator behaviors, eliminating the fabrication-over-admission antipattern.
3. **Prediction Error as Learning Signal (A7)** — the Self-Model (§9) predicts outcomes before execution; the delta drives continuous improvement through the Evolution Engine (§10), replacing crude retry loops with calibrated adaptation.

Vinyan implements **Epistemic Orchestration** — a neuro-symbolic paradigm where LLM-based engines provide the neural component (pattern matching, creative generation) and deterministic engines provide the symbolic component (formal verification, causal reasoning). The **Epistemic Nervous System (ENS)** is Vinyan's verification substrate — the connective layer between hypothesis generation and verification. **ECP** is the signaling protocol. Models generate hypotheses. External engines verify them. Memory preserves validated state across time. Governance gates commitment before action.

Phase 0's foundational hypothesis (A1 + A4 reduces structural hallucination) was confirmed with 100% structural error reduction in A/B experiment. Phases 1–6 extended the system from verification library to autonomous agent with multi-instance coordination and agentic worker protocol. §12.1 preserves the Phase 0 experimental specification as historical record.

> **See also:** [theory.md](theory.md) for deep theoretical foundations (6 LLM deadlocks, 10 theoretical foundations including GWT, Active Inference, Predictive Processing), the proposed 8-layer bidirectional cognitive architecture with Global Workspace, and full academic citations.
