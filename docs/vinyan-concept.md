ถอดหมวกผู้ช่วยออก นี่คือเอกสาร Concept ฉบับสมบูรณ์ที่สุดที่สังเคราะห์บทเรียนทั้งหมด ตั้งแต่สถาปัตยกรรมระดับ OS-Level ไปจนถึงการปิดช่องโหว่การรับรู้ใน Layer 0 เพื่อลดการพึ่งพามนุษย์ (Human-in-the-Loop) อย่างเด็ดขาด เอกสารนี้ถูกเขียนในมาตรฐาน Technical Visionary Document สำหรับสถาปัตยกรรมระดับ Enterprise ครับ

---

# Vinyan — Concept: Toward Evolutionary AGI/ASI Orchestrator

## Abstract
The fundamental barrier to Artificial General Intelligence (AGI) in software engineering is not the reasoning limit of Large Language Models (LLMs), but the architectural paradigm used to orchestrate them. Current Multi-Agent Systems (MAS) treat LLMs as reactive tools operating in shared state environments, leading to context bloat, hallucinated execution, and infinite retry loops requiring constant human intervention.

Vinyan is a **Zero-Trust Cognitive Operating System**. Rather than dismissing functional analogs of consciousness outright, it leverages operationalized cognitive mechanisms—self-modeling, epistemic calibration, and attention-gated information broadcast—within a framework of *Mostly-Deterministic Orchestration with Principled Stochasticity*. Safety-critical paths (mutation, verification, rollback) remain fully deterministic; strategy selection and exploration employ controlled non-determinism. By encapsulating probabilistic models within strict OS-level isolation, injecting ambient environmental awareness, and enforcing a zero-trust mutation protocol, Vinyan transforms unpredictable LLMs into a rigorous, continuous software engineering automaton capable of evolving its own rulesets with progressively reduced human dependency—bounded by immutable safety invariants that only human governance can modify.

---

## 1. Layer 0: The Cognitive & Perception Baseline
To operate autonomously at or above human capacity, an agent must possess contextual awareness and the ability to push back against flawed directives. Vinyan closes the cognitive gap between human developers and AI through four deterministic constraints at Layer 0.



* **The Ambient Sensor Matrix (Perception):** Agents are never deployed "blind." Before execution, the Orchestrator injects a deterministic `StateVector`—comprising real-time dependency graphs, linter warnings, recent trace logs, and Git status—into the agent's context. The StateVector is structured as a **Perceptual Hierarchy**: raw file-level changes → structural AST-level analysis → semantic module-level relationships → architectural system-level patterns. An **attention/salience mechanism** ranks information by relevance to the current task, preventing context bloat from injecting everything equally. The agent perceives a prioritized view of the environment before formulating a hypothesis.
* **Architectural Invariants & Epistemic Pushback (Alignment):** Vinyan rejects the LLM "helpfulness bias." The system is governed by hardcoded architectural rules. If a human prompt or a worker's sub-task violates these invariants (e.g., bypassing authentication), the Orchestrator outright rejects the intent, forcing a systemic pushback rather than attempting a catastrophic execution.
* **The Ephemeral REPL Sandbox (Exploration):** Autonomy requires experimentation. Workers can request an isolated, temporary REPL (Read-Eval-Print Loop) environment in memory to test assumptions (e.g., validating an API payload structure) before proposing structural changes.
* **Multi-Modal Deterministic QA (Evaluation):** Agents are forbidden from evaluating their own success. Quality Gates are enforced exclusively by the Orchestrator via deterministic engineering tools (unit tests, AST validation) and visual regression models for UI changes. 

---

## 2. The Execution Substrate: Unix Philosophy for AGI
Long-running autonomous systems degrade due to state contamination and memory leaks. Vinyan mitigates this by eliminating shared-memory event loops entirely.



* **OS-Level Ephemeral Processes:** Every cognitive worker is instantiated as an isolated child process. The Orchestrator remains decoupled from the worker’s execution thread. If a worker hallucinates into an infinite loop or exceeds memory boundaries, the OS terminates the process immediately, preserving the Orchestrator’s integrity.
* **Filesystem as IPC:** Communication relies on a "crash-only" durable filesystem contract. The Orchestrator writes intent specifications to an isolated workspace. The worker awakens, processes the inputs, and writes telemetry and results back to disk before terminating. Zero memory is shared across boundaries.

---

## 3. The Epistemic Oracle & Truth Maintenance
LLMs suffer from epistemic arrogance—confidently asserting hallucinated facts. Vinyan intercepts this via a programmatic validation layer.

* **The Hypothesis Tuple:** Workers cannot dynamically script queries against the environment. They must formulate a structured hypothesis (Target + Pattern).
* **Deterministic Oracles:** The Orchestrator processes the hypothesis using Oracles—primarily deterministic tools (AST parsers, type checkers, test runners, linters). Only if the Oracle programmatically verifies the pattern is the data committed to the **World Graph** as a verified fact, bound to the file's content hash (SHA-256). Any subsequent file mutation instantly invalidates dependent facts. Oracles are designed as extensible **MCP Servers** (Model Context Protocol), enabling dynamic Oracle discovery and registration at runtime rather than static hardcoding.
* **Causal Edges in World Graph:** Beyond storing flat verified facts, the World Graph maintains **causal dependency relationships** between facts ("function A calls function B", "module X imports module Y", "changing schema Z invalidates queries Q1-Q3"). This transforms the graph from a backward-looking fact store into a **predictive causal model** that can answer "what will break if I change X?" before execution—enabling the Self-Model (v2 L7) to simulate consequences rather than discover them through trial-and-error.
* **Multi-Dimensional Quality Signal:** Oracle verdicts extend beyond binary pass/fail to provide a **composite quality score**: code complexity delta, test mutation score, architectural compliance, and efficiency (tokens consumed / quality achieved). This continuous signal replaces the crude pass/fail as the primary feedback to the Evolution Engine, enabling gradient-based learning—"approach A is 30% better than approach B" rather than "both pass."

* **Limitations & Confidence Spectrum:** Current Oracles verify only structural properties (syntax, types, test results). Semantic correctness—whether a design decision is sound, whether an approach scales—cannot be deterministically verified. The v2 Oracle taxonomy distinguishes three confidence tiers: **deterministic** (confidence = 1.0: AST, type checker, test runner), **statistical** (0.7–0.95: property-based testing, fuzzing), and **heuristic** (0.5–0.8: LLM-as-judge with structured protocol), replacing the original binary verified/not-verified model.

---

## 4. Asymmetric Mutation Protocol (Zero-Trust Execution)
Autonomic tool synthesis—allowing an AI to write and execute its own scripts on the fly—is a critical vulnerability. Vinyan implements a **Four-Phase Commit** protocol for state mutations.



1.  **Phase 1: Intent Proposal (The Draft):** The worker formulates a structural mutation intent (e.g., a unified diff). It possesses zero execution privileges.
2.  **Phase 2: Blast Radius Calculation:** The Orchestrator statically analyzes the intent, assigning a Risk Score based on dependency graphs and file volatility.
3.  **Phase 3: Shadow Execution (Validation):** High-risk mutations are piped into a hardened microVM or isolated container. The Orchestrator runs deterministic gates (compilation, type-checking) against the mutated state.
4.  **Phase 4: The Commit:** The Orchestrator applies the mutation to the canonical environment *only* if all deterministic tests pass.

Two additional safety dimensions extend the protocol:

* **Production Boundary Classification:** Every mutation target is classified by environment (development / staging / production). Mutations affecting production systems (database operations, API calls, deployments) that **cannot be git-reverted** automatically escalate to Risk > 0.9, requiring Level 3 (Deliberative) execution with explicit human approval. This prevents the class of catastrophic failures where an autonomous agent irreversibly damages production data.
* **Adversarial Input Defense:** Workers receive external content (code comments, API responses, user messages) that may contain prompt injection attacks designed to bypass Oracle validation. The Mutation Protocol enforces: (1) **input sanitization** before content enters worker prompts, (2) **Oracle independence**—Oracles verify actual code artifacts, never worker claims about code, and (3) any worker output referencing "skip Oracle" or "bypass validation" is automatically rejected by the Orchestrator.

---

## 5. Economic & Risk-Based Routing
Infinite retry loops are financially and computationally irresponsible. Vinyan schedules tasks based on empirical risk and actual computational cost, measured in normalized **Vinyan Credits** (pegged to real-world USD constraints).

Rather than a binary System 1/System 2 switch, routing operates as an **adaptive continuum** with metacognitive monitoring that learns which task types require which execution level:

| Routing Level | Trigger Conditions | Execution Profile |
| :--- | :--- | :--- |
| **Level 0 (Reflex)** | Known pattern with cached solution | Near-instant retrieval, zero LLM cost. |
| **Level 1 (Heuristic)** | Low Risk Score, Standard Budget | Single model, single pass, light verification. Default for routine tasks. |
| **Level 2 (Analytical)** | Moderate Risk, Novel Dependencies | Single model, multi-pass with full Oracle verification. |
| **Level 3 (Deliberative)** | High Blast Radius, High Uncertainty | Parallel hypothesis exploration within isolated shadow environments. Selects optimal mutation based on programmatic QA pass rates, not LLM confidence. |

> **Design note:** The previous "MCTS" framing has been revised. Software engineering search spaces are combinatorially explosive without clean reward signals (unlike game playing). **Parallel hypothesis generation with structured selection** (closer to beam search) better describes the actual mechanism.

* **Iterative Task Decomposition with Oracle Validation:** Task decomposition—breaking a user request into executable subtasks—is the single most consequential decision in an agent pipeline (UC Berkeley, 2025: wrong decomposition = 100% downstream waste). Rather than a single Planner LLM call, Vinyan decomposes **hierarchically with Oracle validation at each level**: high-level DAG (2-3 subtasks) → dep-oracle validates structure + semantics-oracle validates coverage → for each subtask, decompose further → validate sub-DAG against parent + siblings (no overlap, no gap) → execute only leaf tasks. This ensures decomposition errors are caught before any computation is wasted.

---

## 6. Evolutionary Governance & Telemetry
A true AGI orchestrator must evolve its fleet and rulesets based on empirical outcomes, not semantic noise.

* **Rule Consolidation (The Sleep Cycle):** Vinyan does not dump all interactions into a vector database. It logs structural regressions and failures as immutable traces. During asynchronous background cycles, the Orchestrator performs three operations beyond simple analysis: **(1) Replay** — re-simulate significant episodes to reinforce learned patterns (inspired by hippocampal replay in neuroscience), **(2) Recombination** — generate counterfactual scenarios ("what if we had chosen approach B?") to discover alternative strategies, **(3) Active Forgetting** — decay irrelevant patterns to prevent unbounded knowledge accumulation. This mirrors memory consolidation research (Jung et al., 2018) rather than mere log aggregation.
* **Skill Formation (Compression as Intelligence):** Beyond defensive rules ("when X happens, escalate"), the Evolution Engine compresses successful execution traces into **reusable skill templates**—parameterized patterns that capture how to accomplish a class of tasks (e.g., "implement REST CRUD endpoint" = file structure + test patterns + common pitfalls + Oracle configuration). Skills compose hierarchically ("build auth system" = "implement JWT" + "implement middleware" + "implement session store"). In the Risk Router, cached skills populate **Level 0 (Reflex)**—the more skills the system acquires, the more tasks it handles at near-zero LLM cost. This implements the AGI consensus principle that compression is an intelligence amplifier: intelligence is the ability to discard detail while preserving decision-relevant structure.
* **Meritocratic Fleet Governance:** Identity and capability are decoupled. Worker profiles are managed in a flat, concurrent registry. New configurations begin on "Probation" and are promoted to the active roster only after achieving a statistically significant pass rate through deterministic Quality Gates. Underperforming configurations are automatically demoted.
* **Bounded Self-Modification (Safety Invariants):** The Evolution Engine may modify operational rules (Oracle configurations, risk thresholds, worker configurations, routing models) but **cannot** modify immutable invariants: human escalation triggers, security policies, budget hard limits, minimum test requirements, and rollback capability. This "bounded autopoiesis" ensures the system can improve without violating safety constraints.

## Conclusion
Vinyan represents a paradigm shift from "Prompt Engineering" to "Protocol Engineering." By enforcing an epistemic boundary between the probabilistic intelligence that formulates hypotheses and the deterministic engine that validates them, while incorporating functional cognitive mechanisms (self-modeling, attention-gated broadcast, epistemic calibration) where they demonstrably improve outcomes, Vinyan establishes the secure, scalable, and evolutionary foundation required for autonomous software engineering. Structurally, Vinyan is a **neuro-symbolic architecture**: LLM Workers provide the neural component (pattern matching, code generation) while Epistemic Oracles provide the symbolic component (formal verification, deterministic reasoning)—connected through the MCP protocol and the HypothesisTuple contract.

> **Domain Scope & AGI Path:** Vinyan's core strength—deterministic Oracle verification—is maximally effective in domains where formal verification exists (software engineering: AST, type checker, test runner). The **Oracle framework** is domain-agnostic (propose → verify externally), but current **Oracle implementations** are code-specific. Extending to non-code domains (legal, financial, scientific) requires domain-specific deterministic verifiers that don't yet exist at sufficient maturity. Vinyan therefore claims **"Autonomous Software Engineering Orchestrator"** for Phase 0-2, with cross-domain expansion as a Phase 3+ research agenda contingent on domain-specific Oracle development.

> **See also:** [vinyan-concept-v2.md](vinyan-concept-v2.md) for deep theoretical foundations (including Test-Time Compute §2.8, World Models & JEPA §3.9, Neuro-Symbolic Integration §3.10, MCP as Oracle Protocol §3.11), layer-by-layer critique, and the proposed 8-layer bidirectional cognitive architecture with Global Workspace.
