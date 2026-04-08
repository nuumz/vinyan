# Vinyan OS — AGI Economy Operating System Architecture

> **Document boundary**: This document owns the **OS identity framing, kernel hardening roadmap (K1), economy design (K2), 2027 target architecture, and milestone gates**.
> For axiom definitions and paradigm vision → [concept.md](../foundation/concept.md).
> For academic foundations and LLM deadlocks → [theory.md](../foundation/theory.md).
> For concrete implementation decisions D1-D18 → [decisions.md](decisions.md).
> For phase completion status → [implementation-plan.md](../design/implementation-plan.md).
> For ECP v2 wire protocol design → [ecp-v2-system-design.md](../design/ecp-v2-system-design.md).
> For worker IPC and tool authorization → [agentic-worker-protocol.md](../design/agentic-worker-protocol.md).
> For inter-instance A2A protocol → [a2a-protocol.md](../spec/a2a-protocol.md).
> For task classification and routing invariants → [task-routing-spec.md](../foundation/task-routing-spec.md).

**Date:** 2026-04-08
**Status:** v2 — corrected against codebase reality (v1 had stale gap assessments in §3-5)
**Audience:** Contributors, future agents, architecture reviewers

---

## 1. Vision & Identity

Vinyan is not a coding agent. Vinyan is not a verification platform. **Vinyan is an operating system kernel for autonomous agent economies.**

Every operating system answers the same questions: Who gets to run? What resources can they access? How do we know they did what they claimed? How does the system improve over time? Traditional OSes answer these for processes and threads. Vinyan answers these for **reasoning engines** — LLMs, symbolic solvers, proof assistants, domain oracles, humans, and whatever comes next.

The thesis: **AGI-grade reliability emerges from correct epistemic architecture, not from larger LLMs** ([concept.md §1](../foundation/concept.md)). This is an OS-level claim — it says the kernel design matters more than the quality of any individual process.

### 1.1 Why an OS, Not an Agent

| Traditional OS | Vinyan OS | Why the parallel holds |
|---|---|---|
| Schedules **processes** on CPUs | Schedules **reasoning engines** on tasks | Both allocate heterogeneous compute to heterogeneous work |
| **Capability-based security** (seL4) — processes get explicit permission tokens | **Capability tokens** — agents get explicit operation authorization | Both enforce principle of least privilege |
| **Process isolation** — no process reads another's memory | **Epistemic separation (A1)** — no engine evaluates its own output | Both prevent a single component from corrupting the system |
| **Ring 0 kernel mode** — scheduler/MMU are trusted, deterministic | **Deterministic governance (A3)** — routing/verification/commit are rule-based, no LLM | Both keep the decision path outside untrusted code |
| **Content-addressed filesystem** (Git, IPFS) | **Content-addressed truth (A4)** — facts bound to SHA-256 file hash | Both guarantee data integrity through content addressing |
| **System calls** — structured interface between user/kernel space | **ECP** — epistemic communication protocol with confidence + evidence | Both define the boundary between trusted and untrusted execution |
| **Error handling** — `ENOENT`, `EPERM` are valid return codes | **First-class uncertainty (A2)** — `type: 'unknown'` is a valid protocol state | Both treat "I don't know" as information, not failure |
| **telemetry + adaptive scheduling** | **Prediction error as learning (A7)** — system calibrates from delta(predicted, actual) | Both use runtime data to improve future decisions |

### 1.2 Industry Convergence

Vinyan's axioms aren't speculative. The industry is independently discovering the same design principles:

| Vinyan Axiom (2025) | Independent Discovery (2026) | Source |
|---|---|---|
| A3: Deterministic Governance | "Trustworthy Agentic AI Requires Deterministic Architectural Guarantees" | arXiv Feb 2026 |
| A6: Zero-Trust Execution | seL4 capability model applied to AI agent isolation; Weight Enclaves | arXiv Feb 2026, ACM Digital Library |
| A1: Epistemic Separation | Drexler's CAIS — factored cognition via verified service marketplace | Ongoing refinement 2025-2026 |
| A5: Tiered Trust | Agentic Rubrics — AI-generated scoring replacing binary pass/fail | arXiv Jan 2026 (OpenHands) |
| A7: Prediction Error as Learning | Agent Contracts — formal resource-bounded guarantees with calibration | arXiv 2026, ICLR 2026 Workshop |

The market is projected to reach $8.5B by 2026 for multi-agent systems (Deloitte). EU AI Act enforcement in 2027 will **require** auditability of AI decisions — Vinyan's A3 (deterministic) + A4 (content-addressed) are compliance-ready by design.

---

## 2. Axiom-to-OS Mapping

The 7 axioms defined in [concept.md §1.1](../foundation/concept.md) map directly to OS kernel primitives. This mapping is not metaphorical — each axiom specifies a concrete subsystem.

| Axiom | OS Primitive | Kernel Subsystem | Decisions |
|---|---|---|---|
| **A1** Epistemic Separation | Process isolation | Oracle Gate — different engines verify at each layer | D1-D3 |
| **A2** First-Class Uncertainty | Error codes (`EUNKNOWN`) | ECP protocol — `type: 'unknown'` propagates through pipeline | D4 |
| **A3** Deterministic Governance | Kernel mode (ring 0) | Core Loop — rule-based routing/verification/commit, zero LLM | D5-D6 |
| **A4** Content-Addressed Truth | Content-addressed filesystem | World Graph — SHA-256 content addressing + cascade invalidation | D7 |
| **A5** Tiered Trust | Security levels / capabilities | Tiered confidence — deterministic > heuristic > probabilistic | D8 |
| **A6** Zero-Trust Execution | Sandboxing / jail | Worker isolation — propose/dispose, IPC boundary | D9-D10 |
| **A7** Prediction Error as Learning | Adaptive scheduling | Self-Model — per-task-type calibration from prediction error | D11 |

**Key insight (seL4 parallel):** seL4 formally verifies that its kernel code matches its abstract specification — providing **mathematical proof** that isolation guarantees hold. Vinyan's A3 makes an analogous claim: governance decisions are deterministic and reproducible. Phase K4 (2027+) targets formally verifying kernel properties in Lean4, following the same methodology.

---

## 3. Starting Position — Architectural Gaps

This section maps the gap between current subsystems and the K1/K2 requirements. Status is assessed against the actual codebase, not design docs.

| Component | Status | What Exists | Remaining Gap |
|---|---|---|---|
| **Oracle Gate** | Operational | Parallel oracle execution, circuit breakers, quality scoring, **5-step contradiction resolver** (`conflict-resolver.ts` wired into `gate.ts`), tier-priority + SL fusion | ConflictReport not yet an ECP message type; escalation on `'contradictory'` verdicts not wired to risk-router auto-escalation |
| **Core Loop** | Functional | Full 6-step: Perceive→Predict→Plan→Generate→Verify→Learn | Tool execution limited to file/shell |
| **World Graph** | Functional | Content-addressed facts, SHA-256, cascade invalidation | No schema migration path |
| **Evolution Engine** | Partial | Wilson CI, decay math, pattern mining, rule generation | Data gates block activation; rules don't auto-promote |
| **Worker Pool** | Operational | Subprocess isolation, warm pool, IPC via JSON-RPC, **DAG executor with `Promise.all` subtask parallelism** (`dag-executor.ts`), per-level semaphores (L1=5, L2=3, L3=1) | **Cross-task dispatch is sequential** — `core-loop.ts` accepts one `TaskInput` at a time; parallelism is within-task only |
| **A2A** | Partial | A2AManager conditionally wired in `serve.ts`, 4 transport types (Stdio/HTTP/WebSocket/A2A), **28 test files** in `tests/a2a/` | Default-disabled (`network` config optional); no cross-instance integration test with real peer delegation |
| **MCP** | Partial | Server exposes oracles via JSON-RPC | Read-only — no task delegation, no MCP client |
| **Security** | Partial | 15+ injection detection patterns, budget enforcement in `agent-loop.ts` (hard kill on `budget_exceeded`, tool call slicing) | **Strip-not-block** — `sanitizeForPrompt()` replaces detected patterns with `[REDACTED]` but does not reject input; no capability tokens |
| **ECP** | Partial | `ECPTransport` interface + **4 runtime implementations** (Stdio, HTTP, WebSocket, A2A transport), used in `oracle/runner.ts` with confidence clamping per tier/transport | No formal `ecp_version` field; epistemic extension fields (`evidence_chain`, `falsifiable_by`) not enforced on every message; no unified validation middleware |
| **CLI** | Functional | `vinyan run`, gate, analyze, patterns, mcp | No live operational dashboards |

### Remaining Blockers for Economy OS

With contradiction resolution, subtask parallelism, A2A wiring, and ECP transports already implemented, the blockers have shifted from "build from zero" to "harden and extend":

| # | Blocker | Current State → What's Missing | Severity |
|---|---|---|---|
| **B1** | Guardrails strip-not-block | `sanitizeForPrompt()` replaces patterns but **does not reject** input. In a multi-agent economy, sanitized-but-processed is a trust violation. No capability tokens exist. | CRITICAL — undermines A6 |
| **B2** | No cross-task concurrent dispatch | Subtask parallelism works (`dag-executor.ts` + semaphores), but `core-loop.ts` accepts **one task at a time**. Economy requires multiple independent tasks dispatched concurrently. | HIGH — blocks K2 throughput |
| **B3** | A2A default-disabled, no cross-instance delegation test | A2AManager is wired (`serve.ts`) and heavily unit-tested (28 files), but default config has no `network` section → never activated in practice. No integration test proves two live instances can exchange tasks. | MEDIUM — blocks K2.4 |
| **B4** | No formal Agent Contract | Budget enforcement exists in `agent-loop.ts` (hard kill, tool slicing), but there is no `AgentContract` type, no capability-scoped tokens, and no kernel-level contract issuance at dispatch time. | HIGH — blocks K2.1 (market requires enforceable contracts) |

For complete phase-by-phase history, see [implementation-plan.md](../design/implementation-plan.md).

---

## 4. Kernel Hardening — K1 (2026 Q2-Q3)

> **Goal:** Make the kernel trustworthy enough that multiple agents can safely operate within it.

K1 resolves the three blockers and adds the primitives required before opening the system to an agent economy.

### 4.1 Oracle Pipeline — Contradiction Resolution Hardening

**Current state:** `conflict-resolver.ts` already implements a 5-step deterministic resolution tree, wired into `gate.ts` (line 326). It separates oracles by tier priority (deterministic=4 > heuristic=3 > probabilistic=2), uses domain classification (structural/quality/functional), and applies Subjective Logic fusion for same-tier conflicts. The `'contradictory'` verdict type exists for unresolvable cases.

**Remaining gap:** ConflictReport is not yet a first-class ECP message type. The `'contradictory'` verdict does not auto-trigger risk-router escalation (L0→L2, L2→L3). Human escalation path at L3 is undefined.

**Design:** Extend the existing resolver to complete the escalation chain:

```
Oracle verdicts arrive in parallel
  │
  ├─ All agree → aggregate confidence (current behavior, unchanged)
  │
  ├─ Conflict detected (≥1 PASS + ≥1 FAIL):
  │   │
  │   ├─ Step 1: Separate by evidence tier (A5)
  │   │   Deterministic: AST, Type, Test results
  │   │   Heuristic: Dep analysis, Lint rules
  │   │   Probabilistic: LLM-based oracles (future)
  │   │
  │   ├─ Step 2: Higher tier wins
  │   │   If deterministic oracles conflict with heuristic → deterministic verdict prevails
  │   │   If same-tier oracles conflict → proceed to Step 3
  │   │
  │   ├─ Step 3: Conflict analysis
  │   │   Generate ConflictReport: which oracles disagree, on what evidence, why
  │   │   Verdict type: 'contradicted' (new verdict type, distinct from pass/fail/unknown)
  │   │   Include: winning_tier, losing_oracles[], conflict_reason, falsifiable_by
  │   │
  │   └─ Step 4: Escalation policy
  │       'contradicted' at L0-L1 → escalate to L2 (more oracles = more evidence)
  │       'contradicted' at L2 → escalate to L3 (deeper analysis)
  │       'contradicted' at L3 → human escalation with full ConflictReport
  │
  └─ Special case: deterministic oracle FAIL always overrides
      Type checker says "error" → FAIL regardless of other oracles
      Test runner says "2 tests fail" → FAIL regardless of other oracles
      Rationale: A5 — deterministic evidence is ground truth
```

**Integration points (extend existing, not build new):**
- `src/gate/conflict-resolver.ts` — add `ConflictReport` generation with `winning_tier`, `losing_oracles[]`, `conflict_reason`, `falsifiable_by`
- `src/gate/risk-router.ts` — wire `'contradictory'` verdict → automatic escalation (L0-L1→L2, L2→L3, L3→human)
- `src/core/types.ts` — add `ConflictReport` type if not already present
- ECP v2 — `ConflictReport` becomes a first-class ECP message type

**What already works (do not rebuild):** `conflict-resolver.ts` already handles tier-precedence, SL fusion, domain classification, and `'contradictory'` verdict emission. The gate wiring (`gate.ts` L326-344) is complete.

### 4.2 Agent Contracts — Resource-Bounded Guarantees

**Current state:** `agent-loop.ts` already enforces hard budget limits — `maxToolCallsPerTurn` slices excess tool calls (line 327), and token budget exhaustion triggers `session.close('budget_exceeded')` (line 426). `agent-session.ts` terminates subprocess on close. These are building blocks, but they are per-session advisory limits, not formal kernel-issued contracts.

**Remaining gap:** No `AgentContract` type exists. Budgets are configured per routing level, not issued per-task. There are no capability-scoped permissions (file paths, commands). No audit trail links budget enforcement to content-addressed evidence.

**Design:** An Agent Contract formalizes and extends the existing budget enforcement into a kernel-issued, immutable envelope:

```typescript
interface AgentContract {
  // Identity
  agent_id: string;            // cryptographic or registry-assigned
  task_id: string;             // bound to one task

  // Resource limits
  token_budget: number;        // max LLM tokens (input + output)
  time_limit_ms: number;       // wall-clock timeout
  max_tool_calls: number;      // prevent infinite tool loops
  max_escalations: number;     // prevent escalation storms

  // Capability scope
  capabilities: Capability[];  // explicit list of allowed operations
  
  // Violation policy
  on_violation: 'kill' | 'warn_then_kill' | 'degrade';
  violation_tolerance: number; // warnings before kill (for warn_then_kill)
}

type Capability = 
  | { type: 'file_read';  paths: string[] }     // glob patterns
  | { type: 'file_write'; paths: string[] }
  | { type: 'shell_exec'; commands: string[] }   // allowlist
  | { type: 'shell_read'; commands: string[] }
  | { type: 'llm_call';   providers: string[] }
  | { type: 'mcp_tool';   servers: string[]; tools: string[] }
  | { type: 'a2a_delegate'; targets: string[] };
```

**Contract lifecycle:**

```
Task arrives at kernel
  │
  ├─ Kernel assesses risk (existing risk-router.ts)
  ├─ Kernel generates AgentContract with limits proportional to risk level:
  │   L0: { token_budget: 0, time_limit_ms: 100, max_tool_calls: 0 }
  │   L1: { token_budget: 10_000, time_limit_ms: 15_000, max_tool_calls: 0 }
  │   L2: { token_budget: 50_000, time_limit_ms: 30_000, max_tool_calls: 20 }
  │   L3: { token_budget: 100_000, time_limit_ms: 120_000, max_tool_calls: 50 }
  │
  ├─ Contract is immutable once issued (A3 — deterministic)
  ├─ Worker receives contract via IPC
  │
  ├─ During execution:
  │   Every LLM call → kernel checks token_budget remaining
  │   Every tool call → kernel checks max_tool_calls + capability match
  │   Every tick → kernel checks wall-clock vs time_limit_ms
  │
  ├─ On violation:
  │   'kill' → immediate process termination, task marked FAILED
  │   'warn_then_kill' → first N violations logged, then kill
  │   'degrade' → reduce capability scope (remove write → read-only)
  │
  └─ On completion:
      Actual resource usage recorded in trace → feeds A7 (prediction error)
      Contract vs actual delta → Self-Model calibration
```

**Integration points:**
- `src/orchestrator/worker/worker-pool.ts` — generate contract at dispatch time
- `src/orchestrator/worker/agent-session.ts` — enforce limits during IPC
- `src/orchestrator/core-loop.ts` — contract generation after risk routing
- New: `src/core/agent-contract.ts` — types + validation

**Relationship to existing code:** The [agentic-worker-protocol.md](../design/agentic-worker-protocol.md) defines 3-pool budgeting (thinking/tool/output) and tiered tool authorization (L0-L3). `agent-loop.ts` already enforces `maxToolCallsPerTurn` and `budget_exceeded` termination. Agent Contracts formalize these existing enforcement mechanisms into a typed, auditable, capability-scoped envelope — the enforcement logic exists, the contract abstraction does not.

### 4.3 Capability Tokens — seL4-Style Permission Model

**Problem:** Current guardrails strip injection patterns from input but don't block unauthorized operations. In an economy with multiple agents, "strip-not-block" is unsafe — a stripped prompt still gets processed.

**Design:** Every tool call must present a valid capability token. No token → operation rejected (not stripped).

```
Agent requests tool call
  │
  ├─ Kernel checks: does AgentContract include matching Capability?
  │   Yes → generate short-lived CapabilityToken
  │   No → REJECT with { error: 'CAPABILITY_DENIED', required: 'file_write', agent_has: [...] }
  │
  ├─ Token properties:
  │   • Bound to specific operation (file path, command, etc.)
  │   • Single-use (consumed on execution)
  │   • Expires after time_limit_ms from contract
  │   • Non-transferable between agents
  │
  ├─ Tool executor validates token before execution
  │   Invalid/expired/wrong-scope → REJECT
  │   Valid → execute + consume token
  │
  └─ Audit trail:
      Every token issue, validation, consumption, and rejection → audit log
      Content-addressed (A4) — audit entries bound to task hash
```

**Integration points:**
- `src/guardrails/` — replace strip logic with capability validation
- `src/orchestrator/tools/` — add token validation before every tool execution
- New: `src/security/capability-token.ts` — token generation, validation, revocation
- `src/bus/audit-listener.ts` — log all capability events

**Upgrade path from current guardrails:**
1. Keep existing regex patterns for detection (they're good)
2. Add: detection → REJECT instead of strip
3. Add: capability token validation as second gate
4. Result: defense-in-depth — pattern detection + capability authorization

### 4.4 ECP v2 Runtime — Formalize Existing Transports

**Current state:** 4 transport implementations already exist and are used at runtime:
- `StdioTransport` (`a2a/stdio-transport.ts`) — child process oracle invocation
- `HttpTransport` (`a2a/http-transport.ts`) — stateless POST to remote oracle
- `WebSocketTransport` (`a2a/websocket-transport.ts`) — persistent bidirectional with caching
- `A2ATransport` (`a2a/a2a-transport.ts`) — peer-to-peer across instances

`oracle/runner.ts` (line 82) calls `transport.verify(hypothesis, timeoutMs)` and applies confidence clamping per tier/transport. This is a working runtime.

**Remaining gap:** No formal `ecp_version` field on messages. Epistemic extension fields (`evidence_chain`, `falsifiable_by`, `temporal_context`) are optional and unvalidated. No unified inbound message validation middleware. No audit logging for transport-level messages.

**Design:** This section does NOT duplicate [ecp-v2-system-design.md](../design/ecp-v2-system-design.md) — it specifies only the K1-gate hardening needed to make the existing transports protocol-compliant.

**K1 hardening requirements:**

| Requirement | Current | K1 Target |
|---|---|---|
| Serialization | JSON-RPC 2.0 (implicit) | JSON-RPC 2.0 + mandatory ECP epistemic extension fields |
| Transport | 4 types operational (Stdio, HTTP, WS, A2A) | Add `ecp_version` + schema validation to all 4 |
| Validation | Zod schemas for oracle config (existing) | Zod middleware on all inbound ECP messages |
| Versioning | Not present | `ecp_version` field required; kernel rejects unknown versions |
| Epistemic fields | `confidence` present; others optional | `confidence`, `evidence_chain`, `falsifiable_by`, `temporal_context` required on every verdict |
| Backward compatibility | N/A | Messages without epistemic fields treated as `confidence: 0.0, tier: 'probabilistic'` |

**What K1 adds to existing transports (not builds from scratch):**
- Version + schema validation middleware wrapping existing transports
- Mandatory epistemic field enforcement on verdict responses
- Audit logging for all inbound/outbound ECP messages
- Unified `ECPMessage` envelope type across all 4 transport types

For the full protocol design including SL fusion, opinion algebra, and multi-hop evidence chains, see [ecp-v2-system-design.md](../design/ecp-v2-system-design.md).

### 4.5 Guardrails Upgrade — Block, Don't Strip

**Problem:** Current guardrails detect prompt injection via 15+ regex patterns but only strip the offending content. The processed input still reaches the LLM — just with the attack payload removed. In a multi-agent economy, this is insufficient.

**Design:**

```
Current:  Input → detectPromptInjection() → strip patterns → pass to LLM
K1:       Input → detectPromptInjection() → if detected:
            1. REJECT input (do not process)
            2. Log to audit trail with pattern match details
            3. Emit SecurityViolation event to EventBus (K2 subscribes when active)
            4. Return ECP error: { type: 'security_violation', pattern: '...', action: 'rejected' }
```

**Integration points:**
- `src/guardrails/prompt-injection.ts` — change return type from sanitized string to `'clean' | SecurityViolation`
- `src/orchestrator/perception.ts` — handle rejection instead of continuing with stripped input
- `src/bus/audit-listener.ts` — log security events

### 4.6 K1 Deliverable Summary

| ID | Deliverable | New/Extend | Key Files | What Already Exists |
|---|---|---|---|---|
| K1.1 | Oracle contradiction escalation + ConflictReport | Extend | conflict-resolver.ts, risk-router.ts, core/types.ts | 5-step resolver wired in gate.ts; `'contradictory'` verdict type |
| K1.2 | Agent Contract system | New (formalize existing) | core/agent-contract.ts, worker-pool.ts, agent-session.ts | Budget enforcement in agent-loop.ts (hard kill + tool slicing) |
| K1.3 | Capability tokens | New | security/capability-token.ts, guardrails/, tools/ | — |
| K1.4 | ECP v2 transport hardening | Extend | a2a/*-transport.ts, oracle/runner.ts | 4 transport types operational with confidence clamping |
| K1.5 | Guardrails block-not-strip | Extend | guardrails/prompt-injection.ts, perception.ts | 15+ detection patterns working; sanitizeForPrompt() |

**Implementation priority (risk-ordered):**
1. K1.5 + K1.3 (security — strip-not-block is the only CRITICAL blocker)
2. K1.2 (formalize existing budget enforcement into typed contracts)
3. K1.1 (escalation wiring — resolver already works, just needs auto-escalation)
4. K1.4 (formalize transports — already functional, needs protocol compliance)

---

## 5. Agent Economy — K2 (2026 Q3-Q4)

> **Goal:** Transform Vinyan from a single-agent system to a multi-agent economy where heterogeneous reasoning engines compete for work through a verified market mechanism.

K2 depends on K1. Without Agent Contracts (K1.2) and Capability Tokens (K1.3), the kernel can't enforce resource bounds on competing agents. Without ECP runtime (K1.4), external agents can't communicate with the kernel.

### 5.1 Market Scheduler — From Fixed Routing to Bid-Based Allocation

**Problem (B2):** Current Risk Router maps risk score → fixed routing level → single model assignment. This is adequate for a single agent but cannot support multiple agents competing for tasks.

**Design:** The Market Scheduler replaces fixed assignment with a **task auction**:

```
Task arrives at kernel
  │
  ├─ Kernel creates TaskAuction:
  │   {
  │     task: TaskInput,
  │     required_capabilities: Capability[],  // from risk assessment
  │     minimum_trust: TrustTier,             // from risk level
  │     budget: TokenBudget,                  // from contract limits
  │     deadline: Deadline                    // from task urgency
  │   }
  │
  ├─ Kernel broadcasts auction to registered agents
  │
  ├─ Agents submit AgentBid:
  │   {
  │     agent_id: AgentIdentity,
  │     capabilities: Capability[],           // what this agent can do
  │     trust_score: number,                  // from Trust Ledger
  │     estimated_cost: TokenEstimate,
  │     estimated_quality: QualityEstimate,   // from Self-Model history
  │     collateral: number                    // trust points staked
  │   }
  │
  ├─ Kernel selects winner (deterministic — A3):
  │   1. Filter: agent.capabilities ⊇ auction.required_capabilities
  │   2. Filter: agent.trust_score ≥ auction.minimum_trust
  │   3. Rank: score = trust_weight × trust_score
  │                   + cost_weight × (1 - normalized_cost)
  │                   + quality_weight × estimated_quality
  │   4. Weights are kernel parameters (not LLM-decided)
  │   5. Tie-break: agent with more task-type-specific experience
  │
  ├─ Winner receives AgentContract (K1.2)
  ├─ Winner executes → Oracle Gate verifies → outcome recorded:
  │   Success: Trust Ledger records (success + evidence_hash) → Wilson LB recalculated
  │   Failure: Trust Ledger records (failure + evidence_hash) → Wilson LB recalculated
  │   Collateral: affects bid ranking weight (skin-in-the-game signal), NOT trust score directly
  │
  └─ Audit: full auction record persisted (A4 content-addressed)
```

**Why market > central planning:**
- Holos paper (arXiv Jan 2026): market-based agent coordination delivered 90x throughput and 40x cost reduction vs fixed routing.
- Agents self-select tasks they're good at → specialization emerges without central configuration.
- New agents enter at low trust → earn capability through verified outcomes → organic growth.
- Kernel doesn't need to "know" what each agent is best at — the market discovers it.

**Evolution from current code:**
- `src/gate/risk-router.ts` becomes the **auction generator** (risk assessment → auction parameters)
- `src/orchestrator/worker/worker-pool.ts` becomes the **bid collector + dispatcher**
- Selection algorithm lives in new `src/orchestrator/market-scheduler.ts`

**Incremental path:** K2.1 starts with a simplified auction where internal workers (different LLM providers) bid. Full external agent participation comes after A2A enablement (K2.4).

**Market integrity — anti-gaming mechanisms (REQUIRED before economy is meaningful):**

Without integrity enforcement, the market is a scored router vulnerable to strategic misreporting. Agents that report `estimated_cost: low, estimated_quality: high` win auctions regardless of actual capability.

| Mechanism | Design | Why Required |
|---|---|---|
| **Ex-post settlement** | After Oracle Gate verification, compare actual quality/cost with bid estimates. Delta recorded in Trust Ledger. | Without this, estimated_quality is unverifiable self-report |
| **Bid accuracy decay** | Trust score is weighted by historical bid accuracy: `bid_accuracy = 1 - avg(abs(estimated - actual) / estimated)`. Persistent over-promisers see bid_accuracy → 0, which reduces their auction ranking. | Prevents strategic inflation of quality estimates |
| **Collateral slashing** | Collateral staked in bid is partially consumed on verification failure (proportional to confidence gap). Not a penalty for honest failure — only for failures where the agent's bid confidence exceeded the actual outcome by > threshold. | Skin-in-the-game signal without punishing genuine uncertainty |
| **Bid ceiling from history** | Kernel caps `estimated_quality` at `max(historical_quality) × 1.1` for agents with ≥10 completed tasks. New agents can bid freely but at low trust. | Prevents established agents from gaming quality claims |
| **Falsifiability requirement** | Each bid must include `falsifiable_by: string[]` — what evidence would disprove the quality claim. Kernel verifies at least one falsifiable criterion after execution. | A2 compliance: claims must be testable, not just asserted |

### 5.2 Trust Ledger — Agent Reputation System

**Problem:** Without persistent reputation, the kernel can't distinguish a proven agent from a new one. Every task allocation would be a coin flip.

**Design:** The Trust Ledger records verified outcomes per agent, per capability, using content-addressed evidence.

```sql
-- Trust Ledger schema (extends existing SQLite)
CREATE TABLE agent_trust (
  agent_id       TEXT NOT NULL,
  capability     TEXT NOT NULL,           -- e.g., 'code-mutation', 'test-generation'
  successes      INTEGER DEFAULT 0,
  failures       INTEGER DEFAULT 0,
  total_tasks    INTEGER DEFAULT 0,
  trust_score    REAL DEFAULT 0.0,        -- Wilson lower bound (reuses sleep-cycle/wilson.ts)
  last_updated   TEXT NOT NULL,
  evidence_hash  TEXT NOT NULL,           -- SHA-256 of latest evidence (A4)
  PRIMARY KEY (agent_id, capability)
);

CREATE INDEX idx_trust_agent ON agent_trust(agent_id);
CREATE INDEX idx_trust_capability ON agent_trust(capability);
```

**Trust score formula:** Reuses the Wilson lower bound already implemented in `src/sleep-cycle/wilson.ts`:

$$\text{trust} = \frac{\hat{p} + \frac{z^2}{2n} - z\sqrt{\frac{\hat{p}(1-\hat{p})}{n} + \frac{z^2}{4n^2}}}{1 + \frac{z^2}{n}}$$

where $\hat{p} = \frac{\text{successes}}{\text{total}}$, $z = 1.96$ (95% confidence), $n = \text{total\_tasks}$.

**Why Wilson LB:**
- Correctly handles low sample sizes (new agents get conservative scores)
- Already proven in sleep-cycle pattern mining
- Deterministic (A3) — same inputs → same trust score

**Trust dynamics:**
- New agent: trust starts at Wilson LB with 0 successes, 0 failures → ~0.0 (conservative)
- After 10 successes, 0 failures → ~0.72 (still cautious)
- After 100 successes, 2 failures → ~0.93 (well-proven)
- Trust decay: exponential decay if agent hasn't been active (reuses `src/sleep-cycle/decay-experiment.ts`)

**Integration points:**
- New: `src/db/trust-store.ts` — SQLite read/write for trust ledger
- `src/orchestrator/market-scheduler.ts` — reads trust during bid evaluation
- `src/orchestrator/core-loop.ts` — updates trust after task verification
- `src/sleep-cycle/wilson.ts` — reuse directly (no new math)

### 5.3 Cross-Task Concurrent Dispatch

**Current state:** Within-task parallelism already works: `dag-executor.ts` uses `Promise.all` for independent subtask nodes (line 133), `worker-pool.ts` enforces per-level semaphores (L1=5, L2=3, L3=1), and `detectFileConflicts()` triggers sequential fallback when subtasks share target files.

**Remaining gap (B2):** `core-loop.ts` `executeTask(input: TaskInput)` accepts **one task at a time**. There is no task queue or multi-task dispatcher. For an economy with concurrent agents working on different tasks, this is the bottleneck.

**Design:**

```
Current:  External caller → core-loop.executeTask(task) → wait → next task
          (within task: subtasks run in parallel via DAG executor ✓)

K2:       TaskQueue → ConcurrentTaskDispatcher:
            - Accepts multiple TaskInput concurrently
            - Semaphore: max N concurrent top-level tasks (configurable, default 4)
            - Each task: own AgentContract (K1.2)
            - Each task's subtasks: still use existing DAG executor
            - Cross-task file conflicts: advisory file locks
```

**Concurrency model:**
- **Independent tasks** (different files, different goals): run in parallel, no coordination
- **Cross-task file conflicts**: serialize writes via file-level advisory lock (new)
- **Within-task subtasks**: existing DAG executor handles parallelism (unchanged)

**Integration points:**
- `src/orchestrator/core-loop.ts` — new `dispatchConcurrent(tasks: TaskInput[])` or accept tasks via queue
- New: `src/orchestrator/task-queue.ts` — bounded task queue with concurrent dispatch
- New: `src/orchestrator/worker/file-lock.ts` — advisory file locks for cross-task write conflicts
- `src/orchestrator/worker/warm-pool.ts` — scale to match cross-task concurrency limit

**What already works (do not rebuild):**
- DAG executor subtask parallelism (`dag-executor.ts`)
- Per-level semaphores (`worker-pool.ts`)
- Warm pool subprocess management
- File conflict detection within DAG (`detectFileConflicts()`)

### 5.4 A2A Integration — Enable and Harden

**Current state:** A2AManager is conditionally wired in `serve.ts` (line 28) — created and passed to `VinyanAPIServer` when `network?.instances?.enabled` is true. The `network` config section is optional in `schema.ts`, so A2A is never activated in default setup. However, the implementation is substantial: 4 transport types, A2ABridge for task routing, ECP data parts, streaming channels, and **28 test files** in `tests/a2a/` covering manager, bridge, transports, trust, gossip, negotiation, and more.

**Remaining gap (B3):** No integration test proves two live instances can exchange task delegation end-to-end. Default config never activates A2A. Market Scheduler integration doesn't exist yet.

**Design:** Enable A2A and add missing integration layer:

| Step | Change | Detail |
|---|---|---|
| 1 | Default ON | `src/config/schema.ts` — `network.instances.enabled` default to `true` (with graceful fallback if no peers) |
| 2 | Market integration | Market Scheduler can delegate tasks to peer instances when local agents are fully loaded |
| 3 | Trust sharing | Trust Ledger entries can be shared across trusted peers (with evidence verification) |
| 4 | Integration testing | New: `tests/integration/a2a-delegation.test.ts` — two instances, task delegation, result return, trust exchange |

**Guard rails for A2A:**
- A2A messages validated through ECP v2 runtime (K1.4)
- Incoming tasks subject to same Agent Contract (K1.2) as local tasks
- Trust scores from peers discounted by peer trust level (trust-of-trust dampening per [a2a-protocol.md](../spec/a2a-protocol.md))

For the full A2A message protocol (22 message types, discovery, streaming, partition tolerance), see [a2a-protocol.md](../spec/a2a-protocol.md). K2.4 is about **wiring** — not redesigning the protocol.

### 5.5 MCP Tool Hub — Bidirectional Integration

**Problem:** Current MCP server is read-only (oracle queries). Agents need access to tools from the MCP ecosystem (file, shell, search, git, browser, etc.) — building 40+ tools in-house is not viable.

**Design:** Add MCP client capability alongside existing server:

```
Current:  External MCP Client ──► Vinyan MCP Server (oracle queries only)

K2:       External MCP Client ──► Vinyan MCP Server (oracle + task delegation)
          Vinyan MCP Client   ──► External MCP Servers (tools: file, shell, git, ...)
          
          Agent needs tool → asks kernel → kernel:
            1. Check capability token (K1.3)
            2. Route to appropriate MCP server
            3. Validate result through oracle gate
            4. Return verified result to agent
```

**Integration points:**
- New: `src/mcp/client.ts` — MCP client that connects to external servers
- `src/mcp/server.ts` — extend with task delegation endpoints
- `src/config/schema.ts` — MCP server registry configuration
- `src/orchestrator/tools/` — tool executor routes through MCP client

**Why MCP over built-in tools:**
- MCP ecosystem has 100+ tool servers already
- Standard protocol — any MCP-compatible tool works
- Vinyan adds value by **verifying** tool results through Oracle Gate, not by reimplementing tools

### 5.6 K2 Deliverable Summary

| ID | Deliverable | New/Extend | Key Files | Depends On | What Already Exists |
|---|---|---|---|---|---|
| K2.1 | Market Scheduler + integrity mechanisms | New | orchestrator/market-scheduler.ts | K1.2, K1.3 | Risk Router (auction parameter source) |
| K2.2 | Trust Ledger | New | db/trust-store.ts | K1 (any) | Wilson LB in sleep-cycle/wilson.ts |
| K2.3 | Cross-Task Concurrent Dispatch | New (on existing foundation) | orchestrator/task-queue.ts, core-loop.ts, worker/file-lock.ts | K1.2 | DAG executor subtask parallelism, per-level semaphores |
| K2.4 | A2A Enablement + Integration | Extend | config/schema.ts, market-scheduler.ts | K1.4 | A2AManager wired in serve.ts, 4 transports, 28 test files |
| K2.5 | MCP Tool Hub | New + Extend | mcp/client.ts, mcp/server.ts | K1.3 | MCP server (read-only) |

---

## 6. 2027 Target Architecture

### 6.1 Full Economy Diagram

```
╔════════════════════════════════════════════════════════════════════════╗
║                    VINYAN OS — AGI ECONOMY KERNEL                      ║
║                                                                        ║
║  ┌─────────────────────── AGENT SPACE ──────────────────────┐          ║
║  │                                                          │          ║
║  │  ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌─────────┐         │          ║
║  │  │ LLM     │ │Symbolic │ │ Proof   │ │ Human   │         │          ║
║  │  │ Agent   │ │ Solver  │ │ Asst.   │ │ Expert  │  ...    │          ║
║  │  └────┬────┘ └────┬────┘ └────┬────┘ └────┬────┘         │          ║
║  │       │           │           │           │              │          ║
║  │  ┌────┴───────────┴───────────┴───────────┴─────┐        │          ║
║  │  │        ECP v2 SYSTEM CALL INTERFACE          │        │          ║
║  │  │  confidence │ evidence_chain │ falsifiable_by│        │          ║
║  │  └────────────────────┬─────────────────────────┘        │          ║
║  └───────────────────────┼──────────────────────────────────┘          ║
║                          │                                             ║
║  ════════════════════════╪═════════════════════════════════            ║
║                    KERNEL BOUNDARY (A3: no LLM here)                   ║
║  ════════════════════════╪═════════════════════════════════            ║
║                          │                                             ║
║  ┌───────────────────────┼─────────────────────────────────────┐       ║
║  │              VINYAN KERNEL (Deterministic)                  │       ║
║  │                                                             │       ║
║  │  ┌───────────────┐  ┌──────────────┐  ┌─────────────────┐   │       ║
║  │  │  SCHEDULER    │  │  VERIFIER    │  │  MEMORY MGR     │   │       ║
║  │  │               │  │              │  │                 │   │       ║
║  │  │ Market        │  │ Oracle Gate  │  │ World Graph     │   │       ║
║  │  │ Auction       │  │ + Contra-    │  │ (A4 content-    │   │       ║
║  │  │ + Trust-      │  │   diction    │  │  addressed)     │   │       ║
║  │  │   Weighted    │  │   Resolution │  │ + Trust Ledger  │   │       ║
║  │  │   Bidding     │  │ + Formal     │  │ + Fact Store    │   │       ║
║  │  │               │  │   Proof      │  │                 │   │       ║
║  │  └───────┬───────┘  └──────┬───────┘  └────────┬────────┘   │       ║
║  │          │                 │                   │            │       ║
║  │  ┌───────┴─────────────────┴───────────────────┴─────────┐  │       ║
║  │  │              TRUST ENGINE (A5 + A6)                   │  │       ║
║  │  │  Agent Identity │ Capability Tokens │ Agent Contracts │  │       ║
║  │  └──────────────────────────┬────────────────────────────┘  │       ║
║  │                             │                               │       ║
║  │  ┌──────────────────────────┴────────────────────────────┐  │       ║
║  │  │              RULE GOVERNANCE (A7)                     │  │       ║
║  │  │  Rule Validation │ Promotion │ Demotion │ Invariants  │  │       ║
║  │  │  Candidates from Agent Space — kernel validates only  │  │       ║
║  │  └───────────────────────────────────────────────────────┘  │       ║
║  └─────────────────────────────────────────────────────────────┘       ║
║                                                                        ║
║  ┌─────────────────── HARDWARE ABSTRACTION ──────────────────────┐     ║
║  │  MCP Hub │ A2A Gateway │ Tool Registry │ Sandbox │ Federation │     ║
║  └───────────────────────────────────────────────────────────────┘     ║
╚════════════════════════════════════════════════════════════════════════╝
```

### 6.2 2027 Quarterly Roadmap

| Quarter | Focus | Key Deliverables | Success Criteria |
|---|---|---|---|
| **Q1** | Heterogeneous Engines | Lean4 proof oracle, Z3 constraint solver, human-in-loop ECP bridge | ≥3 non-LLM reasoning engine types active in production |
| **Q2** | Full Market Economy | Dynamic pricing, reputation decay, capability marketplace, agent specialization | Throughput > 5x single-agent baseline; specialization observable in trust data |
| **Q3** | Federation | Cross-instance economy: shared trust ledger, task delegation across network | ≥2 Vinyan instances cooperating on shared task workload |
| **Q4** | Self-Evolving OS | Evolution engine auto-promotes rules; system measurably improves over time | Prediction error ↓ over 30-day window without manual intervention |

### 6.3 2027 Non-Negotiable Properties

| Property | Measurement | Why Non-Negotiable |
|---|---|---|
| **Multi-agent concurrent execution** | ≥10 agents active simultaneously | Not an economy without concurrency |
| **Heterogeneous engines** | ≥3 engine types (LLM, symbolic, proof/human) | Monoculture = single point of failure |
| **Formal proof oracle** | ≥1 proof assistant (Lean4/Isabelle) as oracle | Differentiation no competitor has |
| **Capability-based trust** | Trust earned through verification, revoked on violation | Safety mechanism for open economy |
| **Self-improvement** | Measurable prediction error reduction over time | A7 is an axiom — must be proven |
| **Open protocol** | ≥1 third-party agent using ECP | Network effect requires openness |
| **Audit-ready** | Every decision reproducible from trace + evidence | EU AI Act 2027 compliance |

### 6.4 Stretch Goals (Not Required for 2027 Success)

| Goal | When | Dependency |
|---|---|---|
| Formal kernel verification (prove A3 in Lean4) | If proof oracle works well in Q1 | Lean4 oracle maturity |
| EU AI Act certification | Q3-Q4 | Audit trail completeness |
| Oracle marketplace (third-party oracles) | Q3+ | Trust Ledger stability |
| Paradigm publication (academic paper) | Anytime after Q2 | Working economy as evidence |
| VS Code / IDE integration | Community-driven | API stability |

---

## 7. Milestone Gates

### K1 Gate (Exit: end of 2026 Q3)

All criteria are boolean. ALL must pass before K2 begins.

| # | Gate Criterion | How to Test |
|---|---|---|
| G1 | Oracle contradiction escalation: `'contradictory'` verdict triggers auto-escalation in risk-router; ConflictReport is a valid ECP message | Test suite: contradictory verdict at L1 → auto-escalate to L2; ConflictReport serializes/deserializes correctly |
| G2 | Agent contract: runaway agent killed within budget limit | Test: agent exceeds token_budget → process terminated |
| G3 | Capability token: agent without token → operation REJECTED (not stripped) | Test: unauthorized file_write → error response, not silent strip |
| G4 | ECP v2 hardening: all 4 transports validate `ecp_version` and enforce mandatory epistemic fields | Test: message without `ecp_version` → rejected; message without `evidence_chain` → rejected; all 4 transports pass validation |
| G5 | Guardrails block: detected injection → REJECT with audit log entry | Test: injection pattern → rejection + audit record |
| G6 | All existing tests pass (0 failures) | `bun run test` — 0 failures |
| G7 | Each K1 deliverable has verification scenarios for its key architectural property | Dedicated test suite per K1.x deliverable |
| G8 | Zero type errors | `bun run check` passes |

### K2 Gate (Exit: end of 2026 Q4)

| # | Gate Criterion | How to Test |
|---|---|---|
| G9 | Cross-task dispatch: ≥3 independent top-level tasks execute concurrently | Integration test: 3 independent `TaskInput`s dispatched via task queue, wall-clock < sum of individual times (subtask parallelism already tested separately) |
| G10 | Market auction: 2 agents bid → kernel selects by trust + capability | Test: mock agents with different trust → deterministic selection |
| G11 | Trust ledger: trust score updates correctly after success/failure | Test: agent completes 10 tasks → trust matches Wilson LB calculation |
| G12 | A2A: 2 Vinyan instances exchange task delegation | Integration test: instance A delegates to instance B → result returned |
| G13 | MCP client: agent calls external MCP server tool → result verified | Integration test: MCP server → tool call → oracle gate → verified result |
| G14 | All K1 gates still pass | Regression: G1-G8 green |
| G15 | Each K2 deliverable has verification scenarios for its key architectural property | Dedicated test suite per K2.x deliverable |
| G16 | Zero type errors | `bun run check` passes |

### 2027 Target Gate (Exit: end of 2027)

| # | Gate Criterion | How to Test |
|---|---|---|
| G17 | ≥3 non-LLM reasoning engine types | `vinyan status` shows active engine types |
| G18 | Throughput > 5x single-agent | Benchmark: concurrent economy vs sequential baseline |
| G19 | Federation: ≥2 instances cooperate | Integration test: cross-instance task completion |
| G20 | Self-improvement measurable | 30-day prediction error trend shows ↓ |
| G21 | ≥1 third-party agent using ECP | External integration test or partner demo |
| G22 | All decisions reproducible from trace | Audit: replay trace → same decisions |

---

## 8. Non-Goals

Vinyan deliberately does NOT build:

| Non-Goal | Why Not | Who Should Build It |
|---|---|---|
| IDE integration (VS Code, Cursor, JetBrains plugin) | Kernel focus. UX is a layer above. | Community / `vscode-extension/` stub exists |
| Cloud hosting / SaaS | OS ≠ hosting provider. Users deploy where they want. | Infrastructure team / third-party |
| SWE-bench #1 ranking | Vinyan verifies code, not generates it. LLM quality is the agent's problem. | Agents competing in the economy |
| 40+ built-in tools | MCP ecosystem exists. Build the hub, not every tool. | MCP server authors |
| Web dashboard UI | TUI + API is sufficient. UI layered on top. | Frontend developers |
| Fine-tuning / training LLMs | Vinyan uses LLMs, doesn't train them. | LLM providers |
| Human-in-the-loop for every decision | Defeats autonomy. Humans set invariants, kernel enforces. | N/A — design principle |
| Multi-model fine-tuner | A3 — governance is rule-based. Model quality is an agent concern. | Agent developers |
