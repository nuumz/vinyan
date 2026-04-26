---
type: design-plan
status: superseded — concept.md now uses 'Epistemic Orchestration' as core paradigm name
scope: identity reframing + general task execution enablement
related:
  - ../foundation/concept.md (primary reframe target)
  - ../../CLAUDE.md (agent instructions — identity section)
  - ../architecture/decisions.md (core decision framing)
  - ../spec/tdd.md (system overview)
---

# Identity Reframe + General Task Execution

> **Document boundary**: This document owns the plan for reframing Vinyan's identity from "Epistemic Nervous System" to "Epistemic Orchestration" and the code changes required to support non-file tasks.
> For current identity framing, see [concept.md](../foundation/concept.md). For competitive landscape, see [gap-analysis.md](../analysis/gap-analysis.md).

## Problem Statement

Vinyan's documentation uniformly frames it as an **Epistemic Nervous System (ENS)** — a verification substrate that connects Reasoning Engines. This framing is accurate for the implementation layer but misrepresents the system's purpose.

**Intended identity:** Vinyan is an **autonomous task/workflow orchestrator** (autonomous agent). The ENS is its verification substrate — the mechanism, not the mission. Code capability is the first and most important capability because it enables unbounded self-evolution (the system can modify itself), but it is not the core concept.

**Current framing vs intended:**

| Aspect | Current docs say | Actual intent |
|--------|-----------------|---------------|
| **Core identity** | "ENS — connective substrate between generation and verification" | Autonomous task orchestrator |
| **Role of code** | Primary/only task domain | Meta-capability #1 — enables self-evolution without limits or downtime |
| **Role of ENS** | The system IS an ENS | The system USES an ENS as its verification substrate |
| **Role of LLM** | "One reasoning engine among many" | Primary generator for tasks; oracles verify its output |
| **Domain scope** | "Maximally effective in software engineering" | General-purpose orchestrator; code is first domain because it bootstraps all others |

**Why code is capability #1 (not core concept):**

A system that can modify its own code can:
- Add new oracles/verifiers for any domain (self-extending verification)
- Fix its own bugs without downtime (self-repair)
- Create tools it doesn't yet have (self-expanding capability)
- Optimize its own pipeline (self-improvement)

Code capability is the **bootstrap mechanism** that unlocks every other capability. It's the most important thing Vinyan does, but it's a means to an end — the end is autonomous task orchestration across any domain.

---

## Phase 1: Code Gaps — ✅ COMPLETE

Six gaps were identified and fixed. The original plan listed 3; investigation during implementation revealed 3 additional gaps.

### Gap 1: Non-file tasks route to L0 (no LLM) ✅

**Symptom:** `vinyan run "What is 2+2?"` completed in 0ms with 0 tokens — never called the LLM.

**Root cause chain:**
```
TaskInput.targetFiles = undefined
  → blastRadius = 0, fileVolatility = 0, dependencyDepth = 0
  → riskScore ≈ 0.175 (testCoverage defaults to 0.5 when no target file)
  → riskScore ≤ 0.2 threshold → L0
  → L0 worker returns empty result immediately (no LLM, no tokens)
```

**Fix applied:** `src/orchestrator/risk-router-adapter.ts` — floor non-file tasks from L0 to L1.

```typescript
if (!input.targetFiles?.length && decision.level === 0) {
  decision.level = 1;
  decision.model = 'fast';
  decision.budgetTokens = 10_000;
  decision.latencyBudgetMs = 60_000; // subprocess + LLM + proxy overhead
}
```

**Note on latencyBudgetMs:** Original L1 budget is 15s (calibrated for file tasks with fast oracles). Non-file tasks require subprocess startup + proxy connection + LLM call — 60s is the appropriate floor.

---

### Gap 2: CLI doesn't enable LLM proxy ✅

**Symptom:** Agent subprocess exited immediately — `[AgentSession] Failed to parse JSON from worker`.

**Root cause chain:**
```
src/cli/run.ts calls createOrchestrator({ workspace, bus })
  → llmProxy field missing → defaults to false
  → startLLMProxy() never called → proxySocketPath = undefined
  → WorkerPool passes no VINYAN_PROXY_SOCKET to subprocess env
  → agent-worker-entry.ts: "VINYAN_PROXY_SOCKET env var is required" → process.exit(1)
```

**Fix applied:** `src/cli/run.ts` — add `llmProxy: true`.

```typescript
const orchestrator = createOrchestrator({ workspace, bus, llmProxy: true });
```

---

### Gap 3: `proposedContent` lost — TaskResult has no answer field ✅

**Symptom:** LLM generates reasoning response → `proposedContent` exists in `WorkerLoopResult` → discarded → CLI shows nothing.

**Root cause chain:**
```
agent-worker-entry.ts emits { type: 'done', proposedContent: "..." }
  → WorkerLoopResult.proposedContent = "..."         ✅
  → core-loop.ts adapts WorkerLoopResult → WorkerResult  ❌ (proposedContent NOT copied)
  → core-loop.ts builds TaskResult                    ❌ (no answer field)
  → CLI printSummary() shows nothing
```

**Fix applied:**
- `src/orchestrator/core-loop.ts` — add `proposedContent?: string` to `WorkerResult`; copy from `lastAgentResult`; set `answer` in `successResult`
- `src/orchestrator/types.ts` — add `answer?: string` to `TaskResult`
- `src/cli/run.ts` — print `result.answer` in `printSummary()`

---

### Gap 4: System prompt hardcoded as "coding worker" for all tasks ✅

**Not in original plan. Found during implementation.**

**Symptom:** Non-file tasks still received a coding-worker system prompt instructing JSON mutation output format — LLM confused about expected output.

**Root cause:** `agent-worker-entry.ts:buildSystemPrompt()` had a single prompt for all tasks regardless of whether targetFiles were present.

**Fix applied:** `src/orchestrator/worker/agent-worker-entry.ts` — detect non-file tasks via `init.allowedPaths.length === 0`, use separate "reasoning agent" prompt.

```typescript
export function buildSystemPrompt(routingLevel: number, isNonFileTask = false): string {
  if (isNonFileTask) {
    return [
      `You are a Vinyan reasoning agent at routing level L${routingLevel}.`,
      'Your task is to research, reason about, or answer the given question using available tools.',
      "When you are done, call attempt_completion with status 'done' and put your full answer in the proposedContent field.",
      ...
    ].join('\n');
  }
  // coding worker prompt (unchanged)
}
```

---

### Gap 5: Tool schema double-wrapped — LLM doesn't see correct parameter names ✅

**Not in original plan. Found during implementation (root cause of empty `answer`).**

**Symptom:** LLM called `attempt_completion` but without `proposedContent` — field appeared to be unknown to the model.

**Root cause:** Both LLM providers wrapped the full JSON Schema in an extra `{ type: 'object', properties: ... }` layer. `t.parameters` is already a complete JSON Schema; wrapping it produces an invalid schema where the LLM sees `type`, `properties`, `required` as parameter names instead of `status`, `summary`, `proposedContent`.

```typescript
// Bug in openrouter-provider.ts and anthropic-provider.ts:
parameters: { type: 'object', properties: t.parameters }
// ↑ t.parameters IS already { type: 'object', properties: {...}, required: [...] }
// Result: LLM sees { type, properties, required } as field names — wrong
```

**Fix applied:**
- `src/orchestrator/llm/openrouter-provider.ts` — `parameters: t.parameters`
- `src/orchestrator/llm/anthropic-provider.ts` — `input_schema: t.parameters as { type: 'object'; ... }`

---

### Gap 6: Agent subprocess picks wrong LLM tier ✅

**Not in original plan. Found during implementation.**

**Symptom:** Non-file tasks routed to L1 (fast) but subprocess used balanced tier (claude-sonnet) — slower and unnecessary.

**Root cause:** `agent-worker-entry.ts` detected tier by parsing model name string (`includes('fast')`, `includes('powerful')`). My Gap 1 fix set `decision.model = 'claude-haiku'` which doesn't contain 'fast' → mapped to balanced tier.

**Fix applied:** `src/orchestrator/worker/agent-worker-entry.ts` — use `VINYAN_ROUTING_LEVEL` env var (already passed by agent-loop.ts) instead of model name string.

```typescript
// Before:
const tier = process.env.VINYAN_MODEL?.includes('powerful') ? 'powerful'
  : process.env.VINYAN_MODEL?.includes('fast') ? 'fast' : 'balanced';

// After:
const routingLevel = parseInt(process.env.VINYAN_ROUTING_LEVEL ?? '1', 10);
const tier = routingLevel >= 3 ? 'powerful' : routingLevel >= 2 ? 'balanced' : 'fast';
```

**Gap 1 fix also updated:** `decision.model = 'fast'` (cleaner; model name no longer used for tier routing).

---

### Gap 5 (verification semantics) — Already handled, no change needed

**Original concern:** What does "verification passed" mean for non-mutation tasks?

**Finding:** `oracle-gate-adapter.ts:21` already handles this: empty mutations → `{ passed: true, verdicts: {} }`. No oracle runs; verification is a no-op for answer tasks. This is correct behavior — there is nothing to verify when no files are mutated. The `answer` field carries the LLM output; the A1 axiom (generation ≠ verification) is satisfied because the Critic engine (L2+) can evaluate answer quality when enabled.

---

### Tests updated

6 test assertions updated to reflect new behavior:
- `tests/orchestrator/risk-router-adapter.test.ts` — non-file tasks floor to L1, model='fast'
- `tests/orchestrator/core-loop-integration.test.ts` — L0 test uses file with test coverage (testCoverage=0.8 → score=0.13 → L0); L0 assertion uses targetFiles

All 645 tests pass.

---

## Phase 2: Documentation Reframe — ✅ COMPLETE

Four documents reframed. All technical content (axioms, ECP, oracles, protocols) preserved — only the **opening identity framing** shifted.

### Reframe principle

```
Before: "Vinyan IS an ENS that [does verification things]"
After:  "Vinyan IS an autonomous task orchestrator POWERED BY an ENS substrate"
```

### Target 1: CLAUDE.md — "What This Project Is"

| Field | Value |
|-------|-------|
| File | `CLAUDE.md` (project root, lines 3–5) |
| Current | "Vinyan is a **standalone Epistemic Nervous System (ENS)** — a rule-based, non-LLM-driven substrate that connects heterogeneous Reasoning Engines via an Epistemic Communication Protocol (ECP)." |
| Reframe | Lead with autonomous orchestrator identity. ENS becomes "how", not "what". Code capability framed as self-evolution bootstrap. |

**Draft:**

> Vinyan is an **autonomous task/workflow orchestrator** — a standalone agent that receives tasks, plans execution, dispatches workers, verifies results, and learns from outcomes. Its verification layer is an **Epistemic Nervous System (ENS)**: a rule-based substrate that connects heterogeneous Reasoning Engines via the Epistemic Communication Protocol (ECP). LLMs are one component among many, NOT the brain.
>
> Code capability is Vinyan's first and most critical capability — not because Vinyan is a code tool, but because a system that can modify its own code can evolve without limits or downtime (add oracles, fix bugs, create tools, optimize itself).

### Target 2: concept.md — Abstract + §1 Vision

| Field | Value |
|-------|-------|
| File | `docs/foundation/concept.md` (lines 14–26 Abstract, lines 30–50 Vision) |
| Current | Abstract leads with "ENS — connective substrate between generation and verification" |
| Reframe | Abstract leads with autonomous agent identity. §1 adds code-as-meta-capability statement. Domain scope softened. |

**Abstract draft:**

> Vinyan is an **autonomous task orchestrator** — a standalone agent that plans, executes, verifies, and learns from any task it receives. Its architectural foundation is an **Epistemic Nervous System (ENS)**: a connective substrate between hypothesis generation and hypothesis verification...
>
> [rest of Abstract stays as-is — the ENS description, ECP, axioms are correct implementation details]

**§1 addition (after the comparison table, before "Phase 1 Vinyan's concrete advantages"):**

> **Why code is capability #1:** Vinyan's first and most developed capability domain is software engineering — not because Vinyan is a code tool, but because code capability is the **meta-capability that enables unbounded self-evolution**. A system that can competently modify its own source code can: add new verification engines for any domain, fix its own defects without downtime, create tools it doesn't yet possess, and optimize its own execution pipeline. Code is the bootstrap — the capability that unlocks all other capabilities. The Oracle framework (§3, §6) is domain-agnostic by design; current implementations are code-specific because that's where self-evolution starts.

**§1 Domain scope paragraph (replace current):**

> **Domain scope:** Vinyan is a general-purpose task orchestrator. Its verification engines are currently most developed for software engineering, where formal verification tools exist (AST parsers, type checkers, test runners). The Oracle framework is domain-agnostic; current built-in implementations are code-specific as the bootstrap domain. Cross-domain expansion (document analysis, workflow automation, data pipelines) follows naturally as new Reasoning Engines are added — either by users via the Oracle SDK, or by Vinyan itself through its code self-evolution capability.

### Target 3: decisions.md — Core Decision

| Field | Value |
|-------|-------|
| File | `docs/architecture/decisions.md` (line ~10) |
| Current | "**Core Decision:** Vinyan is an **Epistemic Nervous System** — a rule-based, non-LLM-driven substrate that connects heterogeneous Reasoning Engines via the Epistemic Communication Protocol (ECP)." |
| Reframe | Lead with orchestrator, ENS as substrate. |

**Draft:**

> **Core Decision:** Vinyan is an **autonomous task orchestrator** powered by an **Epistemic Nervous System (ENS)** substrate — a rule-based, non-LLM-driven verification layer that connects heterogeneous Reasoning Engines via the Epistemic Communication Protocol (ECP).

### Target 4: tdd.md — §1 System Overview

| Field | Value |
|-------|-------|
| File | `docs/spec/tdd.md` (§1 opening line) |
| Current | "Vinyan is a **standalone Epistemic Nervous System (ENS)** engine — not a plugin or extension of any host agent." |
| Reframe | Orchestrator with ENS layer. |

**Draft:**

> Vinyan is a **standalone autonomous task orchestrator** with an **Epistemic Nervous System (ENS)** verification layer — not a plugin or extension of any host agent.

---

## Verification Checklist

### Code (Phase 1) — ✅ COMPLETE

| Check | Command | Result |
|-------|---------|--------|
| Type safety | `bun run check` | Zero new errors |
| Basic Q&A | `vinyan run "อธิบายว่า L1 routing คืออะไร" --summary` | Routes L1, invokes LLM (~10s), prints answer |
| File task regression | `vinyan run "Add a comment" --file src/gate/risk-router.ts --summary` | Routes L1+, produces mutations |
| Test suite | `bun run test` | 645 pass, 0 fail |

### Docs (Phase 2) — ✅ COMPLETE

| Check | Method | Result |
|-------|--------|--------|
| No content loss | Diff each file — only framing language changes | ✅ Axioms, ECP, §2–§14 untouched |
| Cross-reference integrity | Verify § numbers, decision refs | ✅ All cross-references intact |
| Consistency | Grep new framing across all 4 files | ✅ All use "autonomous task orchestrator + ENS substrate" |
| Old framing removed | `grep '^# Vinyan.*Epistemic'` = 0 matches | ✅ Zero title-level ENS-as-identity |

---

## Excluded from scope

| Item | Why excluded |
|------|-------------|
| Self-Model retraining for non-code tasks | Requires 200+ traces of non-code tasks — no data yet |
| Domain-specific oracles | New oracles follow naturally from Oracle SDK — not blocked |
| Risk factor generalization | Current factors (blast radius, etc.) produce conservative L1 for non-file tasks — acceptable |
| README.md rewrite | Separate task — current README is boilerplate, needs full rewrite beyond identity framing |
| API server / MCP answer field | Same `answer` field will propagate — but API consumers are a separate concern |
