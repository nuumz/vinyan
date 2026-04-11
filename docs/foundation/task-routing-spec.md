# Task Routing Specification

> **Document boundary**: This document owns the **requirements and invariants** for Vinyan's task classification and routing system — what properties must hold, what each component decides, and how they compose.
> For implementation details → read `src/orchestrator/task-understanding.ts` and `src/orchestrator/core-loop.ts`.
> For system design rationale → [semantic-task-understanding-system-design.md](../design/semantic-task-understanding-system-design.md).
> For risk routing formula → [risk-router.ts source](../../src/gate/risk-router.ts).
> For K1 implementation design → [k1-implementable-system-design.md](../design/k1-implementable-system-design.md).
> For capability model → [agent-contract.ts](../../src/core/agent-contract.ts), [tool-authorization.ts](../../src/security/tool-authorization.ts).
> For core axioms → [concept.md](concept.md).

**Date:** 2026-04-10
**Status:** v3 — added Intent Resolver (LLM-powered pre-routing classification with strategy short-circuits)
**Confidence:** HIGH — derived from actual failure cases, not theoretical design

---

## 1. Purpose

This spec defines the **correct behavior** of Vinyan's task routing pipeline — the sequence of decisions that transforms a user's natural language goal into an execution configuration (routing level, model, tools, verification depth).

The routing pipeline has been a source of bugs because:
- Multiple classifiers (domain, intent, tool requirement) were designed independently without a shared decision model.
- Gate ordering within classifiers silently blocked correct signals (e.g., intent gate blocked CLI detection).
- Domain labels conflated "what the task is about" with "what capability it needs."

This spec prevents future regressions by defining **invariants** — properties that must hold regardless of implementation changes.

---

## 2. Core Design Principles

| ID | Principle | Rationale |
|----|-----------|-----------|
| P1 | **Capability over economy** | A task that needs tools MUST get tool access. Sending it to text-only mode to save tokens is always wrong. False positive (L2 for a question) costs tokens. False negative (hallucinated tools at L1) produces wrong answers. |
| P2 | **Signal strength determines gate order** | Strongest signals (explicit CLI command mention) must be checked before weaker signals (intent classification). A regex match on `git` is stronger evidence of tool need than heuristic intent classification. |
| P3 | **Classification dimensions are orthogonal** | Domain (what it's about), Intent (what user wants), and Capability (what system resources are needed) are independent dimensions. No dimension gates another — they compose. |
| P4 | **A3: Deterministic governance** | All routing decisions are rule-based. Same input → same routing. No LLM in the decision path. LLM Intent Resolver is an advisory pre-routing step with deterministic fallback — it short-circuits non-pipeline strategies but does not influence routing level decisions within the pipeline. |
| P5 | **Floors override ceilings** | When a floor (minimum level) and a ceiling (maximum level) conflict, the floor wins. Safety > economy. |
| P6 | **Observable failures drive design** | Every routing rule must trace to a real failure case or a provable failure scenario. No speculative rules. |

---

## 3. Classification Dimensions

Three independent classifiers extract orthogonal information from the task:

### 3.1 TaskDomain — "What is this task about?"

Determines the **subject matter** of the task. Controls tool scoping (which tools are available) and prompt framing.

| Value | Meaning | Tool access |
|-------|---------|-------------|
| `code-mutation` | Goal involves modifying code files | Full (read + write + shell) |
| `code-reasoning` | Goal analyzes or asks about code | Read-only |
| `general-reasoning` | Non-code question or explanation | None (LLM knowledge) |
| `conversational` | Greeting, meta-question, social | None (minimal response) |

**Invariants:**
- D1: A task with `targetFiles` is always a code domain (`code-mutation` or `code-reasoning`).
- D2: A task matching `NON_CODE_KEYWORDS` without any `CODE_KEYWORDS` is `general-reasoning`.
- D3: `conversational` is reserved for greetings and meta-questions. It is never assigned to tasks that mention technical concepts.
- D4: Domain classification is **purely about subject matter**. It does NOT determine whether tools are needed — that's `ToolRequirement`'s job.

### 3.2 TaskIntent — "What does the user want?"

Determines the **user's expectation** — are they asking Vinyan to do something, explain something, or just chat?

| Value | Meaning | Prompt framing |
|-------|---------|----------------|
| `execute` | User wants Vinyan to perform an action | Orchestrator mode (plan → execute → verify) |
| `inquire` | User wants information or explanation | Assistant mode (answer from knowledge or tools) |
| `converse` | Social interaction, greeting | Friendly mode (lightweight response) |

**Invariants:**
- I1: Intent is classified from **linguistic signals** (verbs, question patterns), not from domain.
- I2: `execute` means the user expects a side-effect (file change, command execution, deployment). `inquire` means the user expects information only.
- I3: Intent does NOT determine tool access. An inquiry ("git commit ว่าอะไร") may require tool execution to answer. Tool access is `ToolRequirement`'s job.

### 3.3 ToolRequirement — "Does fulfilling this task require runtime tool access?"

Determines whether the task needs **tool execution** to produce a correct answer. This is the **capability signal** that feeds the routing floor.

| Value | Meaning | Routing effect |
|-------|---------|----------------|
| `tool-needed` | Task requires shell/tool execution | Minimum L2 (agentic mode) |
| `none` | Task can be answered from LLM knowledge or cached data | No floor applied |

**Invariants:**
- T1: **CLI command mention is the strongest signal.** If the goal mentions a CLI tool (git, docker, npm, kubectl, etc.), `tool-needed` MUST be returned — regardless of domain or intent. This is P1 + P2.
- T2: `conversational` domain always returns `none` (greetings never need tools).
- T3: T1 takes priority over T2 only in theory — in practice, `conversational` goals cannot contain CLI commands (if they do, they're misclassified as `conversational`).
- T4: Thai action verbs implying system execution (รัน, ติดตั้ง, ลง, ถอน, deploy, etc.) return `tool-needed` for execute-intent tasks.
- T5: `tool-needed` is a **routing floor**, not a routing assignment. It guarantees minimum L2 but does not prevent L3.

---

## 4. Routing Pipeline — Ordered Stages

The routing pipeline is a **sequential transformation** from task input to execution configuration. Each stage has defined inputs, outputs, and invariants.

```
┌─────────────────────────────────────────────────────────────────┐
│  Stage 0: Input Guardrails (K1.5 — live)                        │
│  ┌──────────────────────────────────────┐                       │
│  │ validateInput() — block-not-strip    │                       │
│  │ Injection/bypass → REJECT (A6)       │                       │
│  │ Clean → proceed to classification    │                       │
│  └──────────────────────────────────────┘                       │
│       ↓                                                         │
│  Stage 1: Classify (rule-based, deterministic)                  │
│  ┌──────────┐  ┌──────────┐  ┌──────────────────┐               │
│  │  Domain  │  │  Intent  │  │ Tool Requirement │               │
│  └──────────┘  └──────────┘  └──────────────────┘               │
│       ↓              ↓               ↓                          │
│  Stage 1.5: Intent Resolution (LLM-powered, advisory)           │
│  ┌──────────────────────────────────────┐                       │
│  │ resolveIntent() — fast-tier LLM      │                       │
│  │ Skipped when: code-mutation domain   │                       │
│  │   OR targetFiles present             │                       │
│  │ Fallback: regex classifiers (Stage 1)│                       │
│  │                                      │                       │
│  │ Strategy → short-circuit:            │                       │
│  │  conversational → direct LLM answer  │                       │
│  │  direct-tool → single tool exec      │                       │
│  │  agentic-workflow → rewrite goal     │                       │
│  │  full-pipeline → continue below ↓    │                       │
│  └──────────────────────────────────────┘                       │
│       ↓ (full-pipeline only)                                    │
│  Stage 2: Risk Assessment                                       │
│  ┌──────────────────────────────────────┐                       │
│  │ calculateRiskScore() → routeByRisk() │                       │
│  │ → base routing level (L0-L3)         │                       │
│  └──────────────────────────────────────┘                       │
│       ↓                                                         │
│  Stage 3: Adjustment Layers (applied in strict order)           │
│  ┌──────────────────────────────────────┐                       │
│  │ A. Evolution rules     (may raise)   │                       │
│  │ B. Epsilon exploration (may raise)   │                       │
│  │ C. Text-only cap       (may lower)   │                       │
│  │ D. Capability floor    (may raise)   │   ← P5: floor wins    │
│  │ E. Prediction escalation (may raise) │                       │
│  │ F. Deliberation escalation (later)   │                       │
│  └──────────────────────────────────────┘                       │
│       ↓                                                         │
│  Stage 4: Dispatch                                              │
│  ┌──────────────────────────────────────┐                       │
│  │ L0: reflex (no LLM, no tools)        │                       │
│  │ L1: single-shot text-only (haiku)    │                       │
│  │ L2: agentic loop + tools (sonnet)    │                       │
│  │ L3: deep reasoning + shadow (opus)   │                       │
│  └──────────────────────────────────────┘                       │
│       ↓                                                         │
│  Stage 5: Quality Gates (post-generation)                       │
│  ┌──────────────────────────────────────┐                       │
│  │ 1. Empty answer → retry              │                       │
│  │ 2. Instruction echo → retry          │                       │
│  │ 3. Hallucinated tools → escalate     │                       │
│  │ 4. A6 tool strip → READONLY_TOOLS    │                       │
│  └──────────────────────────────────────┘                       │
│       ↓                                                         │
│  Stage 6: Oracle Verification (post-quality-gates)              │
│  ┌──────────────────────────────────────┐                       │
│  │ Oracles agree   → proceed            │                       │
│  │ Oracle conflict → contradiction      │                       │
│  │   escalation (implemented, see §7.1) │                       │
│  └──────────────────────────────────────┘                       │
└─────────────────────────────────────────────────────────────────┘
```

### 4.1 Stage 1.5: Intent Resolution — Design Rationale

**Problem:** The regex-based classifiers in Stage 1 (`classifyTaskDomain`, `classifyTaskIntent`, `assessToolRequirement`) work reliably for code tasks but fail on natural language variation for non-code tasks. "เปิดแอพ Google Chrome", "ถ่ายรูปหน้าจอ", "ส่งอีเมล" and other OS/tool commands are not covered by hardcoded patterns.

**Solution:** A fast-tier LLM call (`resolveIntent()` in `intent-resolver.ts`) that semantically understands the user's goal and classifies into one of 4 execution strategies:

| Strategy | Meaning | Action |
|----------|---------|--------|
| `conversational` | Greeting, question, meta-query | Short-circuit: direct LLM answer, skip pipeline |
| `direct-tool` | Single tool invocation | Short-circuit: execute one tool call, skip pipeline |
| `agentic-workflow` | Multi-step task needing planning | Rewrite `input.goal` with LLM-generated workflow prompt, continue pipeline |
| `full-pipeline` | Code modification with file targets | No-op: continue to Stage 2 as before |

**A3 compliance:** The Intent Resolver is advisory — it does NOT influence routing level (L0-L3) within the pipeline. Its short-circuits are strategy-level decisions (whether to enter the pipeline), not governance decisions (how the pipeline routes). When LLM is unavailable, `fallbackStrategy()` maps Stage 1 regex results to a strategy deterministically.

**Activation guard:** Intent resolution is skipped when:
- `taskDomain === 'code-mutation'` (regex classifier already handles these well)
- `targetFiles` is present (task has explicit code scope — always full-pipeline)
- No LLM provider is available (graceful degradation to regex-only path)

**Cost:** ~200 tokens per intent resolution call using fast-tier LLM. Zero cost for code tasks (skipped).

**Invariants:**
- IR1: Intent resolution NEVER fires for tasks with `targetFiles` (preserves L0 zero-LLM guarantee).
- IR2: Intent resolution NEVER fires for `code-mutation` domain (regex classifiers are sufficient).
- IR3: When LLM is unavailable, behavior is identical to pre-Intent-Resolver pipeline.
- IR4: Hallucinated tool names in `directToolCall` are normalized to `shell_exec` (known tool whitelist check).

---

## 5. Routing Levels — Capability Matrix

Each level is a **discrete capability tier**, not just a quality slider.

| Level | Model | Tools | Max tool calls | Agent loop | Thinking | Verification | Budget | Latency |
|-------|-------|-------|----------------|------------|----------|--------------|--------|---------|
| L0 | none | none | 0 | no | disabled | hash-only | 0 tokens | <100ms |
| L1 | haiku | none (oracles only) | 0 | no | disabled | AST+Type+Dep+Lint | 10K tokens | <15s |
| L2 | sonnet | full | 20 | yes | adaptive/medium | all oracles + optional critic | 50K tokens | <30s |
| L3 | opus | full + shadow | 50 | yes | adaptive/high | all + shadow execution | 100K tokens | <120s |

**Critical boundary: L1 → L2**

This is the most important boundary in the system. Below it: text-only, no tool execution, single-shot. Above it: agentic with real tool access and multi-turn planning.

**Invariants:**
- R1: Any task that requires runtime data (file system state, git status, command output) MUST be at L2+.
- R2: L0-L1 models should never be prompted with tool descriptions. If they hallucinate tool calls anyway, Gate 3 catches and escalates.
- R3: Model assignment follows level. L1=haiku, L2=sonnet, L3=opus. No "fast model at L2" — Capability > token cost (P1). **Evolution note:** R3 applies to the current single-agent mode. `ProviderTrustStore` ([provider-trust-store.ts](../../src/db/provider-trust-store.ts)) records per-provider outcomes; `PriorityRouter` ([priority-router.ts](../../src/orchestrator/priority-router.ts)) computes Wilson lower-bound trust scores. K2.1 trust-weighted routing will replace fixed model assignment when activated — P1 is preserved via capability filtering before trust ranking.
- R4: Speculative-tier oracles are **rejected** (not just warned) at L0-L1. Returns `GUARDRAIL_BLOCKED` error verdict and emits `guardrail:violation` event. This is a hard enforcement gate (Safety Invariant I17).

**Production guard:** When `environmentType === 'production'`, the risk router enforces minimum L2. Production + irreversibility > 0.5 forces risk score >= 0.9 (effectively L3).

---

## 6. Adjustment Layer Ordering — Invariants

The adjustment layers are applied in **strict order**. This order is load-bearing — changing it breaks behavior.

**Why order matters:**

```
Scenario: conversational task + epsilon exploration
  
  WITHOUT correct order (cap first, then explore):
    Risk → L0 → cap to L1 → epsilon bumps to L2 → wastes tokens on greeting

  WITH correct order (explore first, then cap):
    Risk → L0 → epsilon bumps to L1 → text-only cap clamps to L1 → correct
```

**Ordering invariants:**
- O1: Evolution rules come first (learned rules are most context-specific).
- O2: Epsilon exploration BEFORE caps/floors (exploration is exploratory, caps/floors are safety).
- O3: Text-only cap BEFORE capability floor (floor overrides cap per P5). Two conditions: (a) `conversational` domain → L1 max; (b) `general-reasoning + inquire + none` → L1 max (economy: pure knowledge questions don't need agentic loop). Both use `MAX_CONVERSATIONAL_LEVEL = 1`.
- O4: Capability floor is the **last pre-dispatch adjustment** that can raise the level. It must be after all lowering adjustments so it can override them.
- O5: After the capability floor, the level MUST NOT be lowered by any subsequent adjustment.

**Stages E-F detail:** At L2+, `ForwardPredictor` may raise to L2 (breakProbability > 0.5) or L3 (aggregate risk > 0.7). `SelfModel.forceMinLevel` (cold-start safeguard) may also raise. Both are upward-only — O5 is preserved. Caps/floors are NOT re-applied inside the inner loop.

---

## 7. Quality Gates — Catch What Classification Missed

Quality gates are **defense-in-depth** — they catch failures that the classification + routing pipeline didn't prevent.

| Gate | Catches | Condition | Action |
|------|---------|-----------|--------|
| Empty answer | Model returned nothing useful | reasoning task + empty content | Retry same level |
| Instruction echo | Model echoed system prompt | ≥2 prompt fragments in first 200 chars | Retry same level |
| Hallucinated tools | Model faked tool calls at text-only level | L0-L1 + tool-call XML patterns | **Escalate** to L2 |
| A6 tool strip | Model proposed mutating tools for non-mutation task | non-code-mutation + mutating tool calls | Strip to `READONLY_TOOLS` only |

**Gate invariants:**
- G1: Hallucination gate MUST lead to escalation, not silent acceptance. Implementation records the hallucination as a failed approach and continues the retry loop. When retries exhaust at the current level, the outer routing loop escalates to L2+ where real tools are available.
- G2: Gates are ordered by severity: cheap retries first, expensive escalation later, silent fixes last.
- G3: Gate 4 (A6 strip) is defense-in-depth. It should rarely trigger if classification + prompt framing are correct. **K1.3 status:** `authorizeToolCall()` ([tool-authorization.ts](../../src/security/tool-authorization.ts)) is code-complete — it enforces per-tool capability checks against the `AgentContract`. Once wired into the agent loop, Gate 4 becomes a dead-letter safety net: capability validation will reject unauthorized tool calls before they reach quality gates.
- G4: `READONLY_TOOLS` = `file_read`, `search_grep`, `directory_list`, `git_status`, `git_diff`, `web_search`. These are the only tools preserved by the A6 strip gate for non-mutation tasks.

**Scope:** Gates 1-3 (empty answer, instruction echo, hallucinated tools) apply only to `taskType === 'reasoning'` tasks. Code tasks (`taskType === 'code'`) bypass these gates because their output is structured mutations verified by oracle gates instead. Gate 4 (A6 tool strip) also applies only to reasoning tasks.

### 7.1 Oracle Contradiction Escalation

When oracles produce conflicting verdicts (e.g., AST says PASS, Test says FAIL), the system detects contradiction by partitioning oracle results into `passedOracles` and `failedOracles` arrays. If both are non-empty, `hasContradiction = true` triggers automatic escalation:

| Contradiction at | Action |
|------------------|--------|
| L0-L1 | Escalate to L2 (more oracles = more evidence) |
| L2 | Escalate to L3 (deeper analysis) |
| L3 | Surface to caller via `contradictions` field in `TaskResult` (no further escalation) |

Events emitted: `verification:contradiction_escalated` + `task:escalate` (L0-L2), `verification:contradiction_unresolved` (L3).

**Mechanism:** The current implementation uses direct pass/fail partition — simpler than the planned K1.1 `'contradicted'` verdict type with tier-precedence A5 resolution. Oracle disagreement is not weighted by tier. A5-aware contradiction resolution (where deterministic oracle trumps probabilistic) remains a planned enhancement ([k1-implementable-system-design.md §2.2](../design/k1-implementable-system-design.md)).

**Relationship to quality gates:** Contradiction escalation operates in Stage 6 (post-verification), after quality gates (Stage 5). Quality gates catch *generation* failures; contradiction escalation catches *verification* disagreement. They are complementary, not overlapping.

### 7.2 ECP Confidence Clamping

Oracle confidence values are clamped by tier and transport to enforce epistemic honesty (A5). A probabilistic oracle cannot claim deterministic-level confidence regardless of its self-reported value.

**Tier caps** (applied to all oracle verdicts):

| Tier | Max confidence | Rationale |
|------|---------------|-----------|
| deterministic | 1.0 | Proof-level (AST, type check) |
| heuristic | 0.9 | Strong but not proof (lint rules) |
| probabilistic | 0.7 | LLM-based, inherently uncertain |
| speculative | 0.4 | Experimental, low evidence base |

**Transport caps** (applied on top of tier caps):

| Transport | Max confidence | Rationale |
|-----------|---------------|-----------|
| stdio | 1.0 | Local process, full trust |
| websocket | 0.95 | Persistent connection, slight degradation |
| http | 0.7 | Stateless, replay-vulnerable |
| a2a | 0.7 | Cross-agent, trust boundary |

**Peer trust caps** (active for A2A transport only):

| Trust level | Max confidence |
|-------------|---------------|
| untrusted | 0.25 |
| provisional | 0.40 |
| established | 0.50 |
| trusted | 0.60 |

Final confidence = `min(raw, tierCap, transportCap, peerTrustCap)`. Implementation: `src/oracle/tier-clamp.ts`.

---

## 8. Failure Cases — The Test Suite for This Spec

Each failure case below has been observed in production. The spec must prevent all of them.

### F1: "git last commint ว่าอะไร" → hallucinated tools at L1

**Observed:** LLM produced fake `[TOOL: git_status]` and `[TOOL: shell_exec]` output that was never executed. User received fabricated data.

**Root cause chain:**
1. `CODE_KEYWORDS` matches `git` + `commit` → domain = `code-reasoning`
2. "ว่าอะไร" contains `อะไร` → `INQUIRE_PATTERN` matches → intent = `inquire`
3. `assessToolRequirement`: intent gate (`inquire ≠ execute`) blocked CLI detection → `none`
4. No capability floor → risk score ≈ 0.15 → L1 (text-only, no tools)
5. Haiku model at L1 generated convincing but fake tool output

**Spec violations:** T1 (CLI mention must return `tool-needed`), P2 (strongest signal first), P1 (capability > economy)

**Required behavior:** `git` in goal → `tool-needed` → capability floor → L2 → real tool execution

### F2: code-mutation unconditionally tool-needed → broke L0 reflex

**Observed:** 8 integration tests failed. Code tasks that should route to L0 (cached, no LLM) were forced to L2.

**Root cause:** `assessToolRequirement` returned `tool-needed` for all `code-mutation` tasks → capability floor raised every code task to L2 → L0 reflex path dead.

**Spec violations:** T1 specifies CLI command as the signal, not domain label. Code domains have their own routing via risk score.

**Required behavior:** code-mutation with no CLI mention → `none` → risk-based routing preserved. "fix the export value" → L0 (if risk is low), not L2.

### F3: "docker คืออะไร" → potential over-escalation

**Trade-off accepted:** Under T1, this routes to L2 (tool-needed) even though it's a knowledge question. The LLM at L2 will answer from knowledge without using tools. Cost: ~40K extra tokens vs L1. Benefit: if Docker IS installed and user actually wants `docker info`, it works. This is P1 in action.

### F4: Conversational cap vs capability floor conflict

**Scenario:** A conversational task somehow gets `tool-needed` (shouldn't happen per T2/T3, but defense-in-depth).

**Required behavior per P5:** Floor wins. If `tool-needed` AND `conversational`, the task routes to L2. In practice this shouldn't occur — T2 returns `none` for conversational before CLI check. But if it did (classifier bug), safety > economy.

---

## 9. assessToolRequirement — Gate Order Specification

This function is the most sensitive classifier because its output directly controls the L1↔L2 boundary. Gate ordering is **load-bearing**.

```
assessToolRequirement(understanding, taskDomain, taskIntent) → ToolRequirement

GATE ORDER (invariant — do not reorder):

  1. IF conversational → 'none'          [T2: greetings never need tools]
  2. IF CLI command in goal → 'tool-needed' [T1: strongest signal, overrides everything]
  3. IF intent ≠ execute → 'none'         [only execute-intent gets further checks]
  4. IF Thai action verb → 'tool-needed'  [T4: system-level execution verbs]
  5. DEFAULT → 'none'
```

**Why this order:**
- Gate 1 (conversational) is a fast exit for the most common trivial case.
- Gate 2 (CLI mention) is BEFORE gate 3 (intent check) because of F1. A question about `git` still needs git tools. Intent classification cannot veto a clear capability signal.
- Gate 3 (intent check) filters out pure knowledge questions that don't mention CLI tools.
- Gate 4 (Thai action verbs) only applies to execute-intent because these verbs are ambiguous without intent context.

**Pattern scope:** `TOOL_COMMAND_PATTERN` covers 40+ CLI commands including shell utilities (`mv`, `cp`, `rm`, `cat`, `ls`, `grep`), cloud CLIs (`aws`, `gcloud`, `kubectl`, `terraform`), deployment tools (`heroku`, `vercel`), and media tools (`ffmpeg`, `pandoc`). Breadth is intentional per P1 — false positives cost tokens, false negatives produce hallucinated output.

**Excluded commands:** `go`, `node`, `make`, `convert` are intentionally excluded — they are too ambiguous in natural language (e.g., "go to the store", "make a decision", "convert to PDF" as explanation). If the user means the CLI tool, other context signals (code keywords, target files) will route correctly.

### 9.1 K1 Infrastructure — Capability Enforcement

The following components are **code-complete** but **not yet wired** into the routing pipeline. They formalize the capability constraints described in §5 as runtime enforcement rather than convention.

**AgentContract** ([agent-contract.ts](../../src/core/agent-contract.ts)): Kernel-issued immutable capability envelope (A3, A6). `createContract(task, routing)` produces a contract with:
- Token budget, time limit, max tool calls/turns/escalations from routing decision
- Per-level capability scope (`DEFAULT_CAPABILITIES`): L0=nothing, L1=read-only, L2=workspace read+write+`bun`/`tsc`/`biome`, L3=full access
- Violation policy: L0-L1 → `kill` (zero tolerance); L2-L3 → `warn_then_kill` (tolerance=2)

**Tool Authorization** ([tool-authorization.ts](../../src/security/tool-authorization.ts)): `authorizeToolCall(contract, toolName, args)` maps 15 known tool names → 5 capability types (`file_read`, `file_write`, `shell_exec`, `shell_read`, `llm_call`), then checks scope against contract. Unknown tools → `shell_exec` with scope `['UNKNOWN_TOOL']` → denied at all levels (A6 zero-trust).

**Wiring gap:** 4 integration points needed: `core-loop.ts` (call `createContract()` after routing finalizes) → `worker-pool.ts` (pass contract to dispatch) → `agent-loop.ts` (enforce per-turn) → tool execution (call `authorizeToolCall()` pre-exec). `AgentBudgetTracker.fromContract()` already exists as the alternate factory.

**Effect when wired:** §5's capability matrix becomes runtime-enforced. Gate 4 (A6 tool strip) becomes defense-in-depth behind contract-level rejection.

---

## 10. classifyTaskDomain — Decision Rules

```
classifyTaskDomain(understanding, taskType, targetFiles) → TaskDomain

PRIORITY ORDER:

  1. IF greeting pattern → 'conversational'
  2. IF non-code keywords WITHOUT code keywords → 'general-reasoning'
  3. IF has targetFiles → code domain (mutation/reasoning by expectsMutation)
  4. IF code keywords:
     a. IF expectsMutation AND taskType='code' → 'code-mutation'
     b. ELSE → 'code-reasoning'
  5. IF short goal (<40 chars) without code signals → 'general-reasoning'
  6. DEFAULT → 'general-reasoning'
```

**Known issue:** `CODE_KEYWORDS` is very broad (includes `git`, `commit`, `docker`, `deploy`). This means "git last commit ว่าอะไร" becomes `code-reasoning` even though the user isn't reasoning about code — they want runtime data. This is acceptable because:
- Domain controls **tool scoping** (which tools), not **tool access** (whether tools exist).
- `code-reasoning` gets read-only tools at L2+, which includes `git_status` and `shell_exec` for read commands.
- The routing floor (from `ToolRequirement`) ensures L2+.

---

## 11. classifyTaskIntent — Decision Rules (Frame-First)

```
classifyTaskIntent(understanding, taskDomain) → TaskIntent

FRAME-FIRST PRIORITY ORDER:

  1. IF conversational domain → 'converse'
  2. IF meta-question pattern → 'inquire'
  3. IF inquiry frame detected → 'inquire'     [BEFORE commands — prevents priority inversion]
  4. IF command frame detected → 'execute'
  5. IF code-mutation domain → 'execute'       [safety: code-mutation always executes]
  6. DEFAULT → 'inquire'                       [safe default: don't promise action]
```

**Frame-first design:** Sentence-level structure (question vs command) is detected before individual verb matching. This prevents priority inversion where verbs like ช่วย/explain/deploy trigger `execute` when the sentence is clearly a question.

**Inquiry frames** (checked at step 3):
- Thai question-end markers: อะไร, ยังไง, ไหม, มั้ย, คืออะไร, หมายความว่า, etc. (anchored to `$`)
- Thai inquiry governing verbs: อธิบาย, ช่วยอธิบาย, ช่วยบอก, ช่วยเล่า, ช่วยตอบ, ช่วยแนะนำ
- Thai question-start: อะไร, ทำไม (anchored to `^`)
- English inquiry frame: how/what/why/where/when/who/which (anchored to `^`), or explain/describe/tell me/show me how

**Command frames** (checked at step 4):
- Thai ช่วย + action verb compound: ช่วยรัน, ช่วยลบ, ช่วยสร้าง, ช่วยแก้, etc.
- Thai bare action verbs with negative lookahead: รัน, ติดตั้ง, แก้(?!ตัว|แค้น), เปิด(?!เผย|ใจ), etc.
- English command verbs: fix, create, delete, run, deploy, build, etc. (word-boundary protected)

**Why inquiry before command:** "ช่วยอธิบาย architecture" contains ช่วย (command prefix) AND อธิบาย (inquiry verb). Frame-first classifies it as inquiry because อธิบาย governs the sentence intent. False positive inquiry (answer a question) is cheap — user re-asks. False positive execute (act on a question) is dangerous — may cause mutations.

**Orthogonality with tool requirement:** "git last commit ว่าอะไร" → intent=`inquire` (user asks a question), tool=`tool-needed` (answering requires CLI). Intent and tool requirement are independent dimensions (P3).

---

## 12. Composition Matrix — How Dimensions Interact

This matrix shows the routing behavior for all meaningful (domain × intent × tool) combinations:

| Domain | Intent | Tool | Effective Floor | Typical Level | Example |
|--------|--------|------|-----------------|---------------|---------|
| conversational | converse | none | L1 cap | L0-L1 | "สวัสดี" |
| general-reasoning | inquire | none | — | L0-L1 | "อธิบาย dependency injection" |
| general-reasoning | inquire | none | — | L0-L1 | "ช่วยอธิบาย architecture" (frame-first: อธิบาย governs) |
| general-reasoning | inquire | tool-needed | L2 | L2 | "docker คืออะไร" (CLI mention) |
| general-reasoning | execute | tool-needed | L2 | L2 | "ช่วยรัน npm install" |
| code-reasoning | inquire | none | — | L0-L1 | "explain this function" |
| code-reasoning | inquire | tool-needed | L2 | L2 | "git last commit ว่าอะไร" |
| code-reasoning | execute | tool-needed | L2 | L2 | "git push origin main" |
| code-mutation | execute | none | — | L0-L3 | "fix the export value" (risk-based) |
| code-mutation | execute | tool-needed | L2 | L2-L3 | "ช่วยรัน git rebase" |

**Key insight:** The `tool-needed` column is the only one that forces L2. Domain and intent influence prompt framing and tool scoping, but they do NOT control the routing level — that's risk score + capability floor.

---

## 13. Validation Criteria

Any implementation change to the classification or routing pipeline MUST pass these checks:

### Smoke tests (run after every edit)
1. `"git last commit ว่าอะไร"` → `tool-needed` → routes to L2+
2. `"fix the export value"` (code, no CLI) → `none` → routes by risk (can be L0)
3. `"สวัสดี"` → `conversational` → capped at L1
4. `"ช่วยรัน npm install"` → `tool-needed` → routes to L2+
5. `"docker คืออะไร"` → `tool-needed` → routes to L2+
6. `"explain how authentication works"` → `none` → routes to L0-L1

### Regression suite
- All tests in `tests/orchestrator/task-domain-classifier.test.ts` pass
- All tests in `tests/orchestrator/core-loop-integration.test.ts` pass
- All tests in `tests/orchestrator/core-loop-pipeline-confidence.test.ts` pass
- All tests in `tests/orchestrator/intent-resolver.test.ts` pass (16 tests: strategy classification, fallback, timeout, error handling)

### Invariant checks
- P1: No task with `tool-needed` routes to L0 or L1 (grep for capability floor)
- P4: No Math.random() or LLM call in classification functions (Stage 1). Intent Resolver (Stage 1.5) is LLM-powered but advisory with deterministic fallback.
- P5: Capability floor is applied AFTER text-only cap
- O5: No adjustment after capability floor lowers the level
- IR1: Intent Resolver never fires for tasks with `targetFiles` (preserves L0)
- IR2: Intent Resolver never fires for `code-mutation` domain

---

## 14. Graduated Extensions

### 14.1 Now current scope (code-complete)

| Extension | Status | Implementation | Spec reference |
|-----------|--------|----------------|----------------|
| LLM Intent Resolver (pre-routing strategy classification) | **Implemented** | `intent-resolver.ts`; wired in `core-loop.ts` `prepareExecution()` | §4.1 |
| Fine-grained tool categories (`file_read`, `file_write`, `shell_exec`, `shell_read`, `llm_call`) | Code-complete | `CapabilitySchema` in [agent-contract.ts](../../src/core/agent-contract.ts); `classifyTool()` in [tool-authorization.ts](../../src/security/tool-authorization.ts) | §9.1 |
| Capability token rejection (replaces A6 strip) | Code-complete | `authorizeToolCall()` in [tool-authorization.ts](../../src/security/tool-authorization.ts) | §9.1, G3 |
| Oracle contradiction escalation | Implemented | Pass/fail partition + auto-escalate in [core-loop.ts](../../src/orchestrator/core-loop.ts) | §7.1 |
| ECP confidence clamping (tier × transport × peer-trust) | Implemented | [tier-clamp.ts](../../src/oracle/tier-clamp.ts) | §7.2 |
| Input guardrails — block-not-strip | Live | `validateInput()` in [guardrails/index.ts](../../src/guardrails/index.ts) | §4 Stage 0 |

### 14.2 Future extensions (NOT in current scope)

Listed here to prevent premature implementation:

| Extension | When needed | Why not now | Ref |
|-----------|-------------|-------------|-----|
| `tool-optional` (benefit from tools but not required) | When L1 models get tool access | Currently L1 has no tools — binary decision is sufficient | — |
| Intent confidence score | When classifier accuracy data is available (≥1000 traces) | No calibration data yet — confidence would be meaningless | — |
| Multi-intent tasks ("explain X then fix Y") | When task decomposer handles mixed-intent subtasks | Current decomposer splits into sub-tasks — each sub-task gets its own intent | — |
| Domain-specific routing thresholds | When per-domain failure rates diverge significantly | Current uniform thresholds work — no evidence of domain-specific failure patterns | — |
| Trust-weighted engine selection (replaces R3 fixed model) | K2.1 activation | `ProviderTrustStore` + `PriorityRouter` are code-complete foundation; fixed routing is correct for single-agent mode | K2.1 |
| A5-aware contradiction resolution (`'contradicted'` verdict type) | K1.1 full spec | Current pass/fail partition works but does not weight by tier — deterministic oracle should trump probabilistic | K1.1 |
| `confidence_source` filtering in gate (A5 fix) | K1.0 | `llm-self-report` confidence currently treated equally with `evidence-derived` — violates A5 tier ordering | K1.0 |
