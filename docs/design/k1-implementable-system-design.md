# Vinyan Kernel — Implementable System Design (K1 + K2)

> ✅ **Status: As-Is (mostly).** K1 (guardrails, agent contracts, tool authorization) is **wired into core-loop and ✅ Active**. K2 (engine selector, MCP client pool, provider trust) is **🔧 Built — needs provider trust data**. Treat any "wiring pending" notes below as historical: K1 has been wired. Re-validate against `src/orchestrator/core-loop.ts` before relying on §9.x integration claims.

> **Document boundary**: Concrete implementation design for K1 (kernel hardening) and K2 (multi-agent dispatch).
> For vision and axiom mapping → [vinyan-os-architecture.md](../architecture/vinyan-os-architecture.md).
> For ECP full protocol → [ecp-system-design.md](ecp-system-design.md).

**Date:** 2026-04-08
**Status:** v4 — clean rewrite. All code verified against staging. K1.5 done. K1.0-K1.4 code exists, wiring pending. K2 code exists, wiring pending.
**Audience:** Implementors (human or agent)

---

## 0. Starting Position

### What Vinyan Is

A **multi-agent orchestration kernel with a strong verification layer**. The verification pipeline — Oracle Gate, SL conflict resolution, tiered trust, circuit breakers, content-addressed facts — is the genuine differentiator. ~49K LOC across 280 source files, 254 test files.

### What This Document Covers

K1 hardens the kernel for multi-agent safety. K2 enables concurrent dispatch + trust-based selection. Both are **wiring tasks** — implementation code already exists in staging for every deliverable except K1.0.

### Current Status at a Glance

```
✅ Done:
  K1.5 Guardrails block-not-strip — validateInput() wired at executeTask() entry

🔧 Code exists, wiring pending:
  K1.2 Agent Contract    — agent-contract.ts (110 LOC)
  K1.3 Tool Authorization — tool-authorization.ts (93 LOC)
  K1.4 ECP Validation    — ecp-validation.ts (staged)
  K2.1 Priority Router   — priority-router.ts (59 LOC) + provider-trust-store.ts (89 LOC)
  K2.2 Task Queue        — task-queue.ts (66 LOC)

⚠️ Needs new code:
  K1.0 confidence_source enforcement — ~20 LOC in gate.ts (A5 violation fix)
  K1.1 Contradiction escalation      — ~20 LOC in core-loop.ts
```

---

## 1. Codebase Audit

| Component | LOC | Wired? | Gap | Action |
|-----------|-----|--------|-----|--------|
| Conflict Resolver (3-path SL) | 347 | ✅ `gate.ts` | `hasContradiction` not consumed by core loop | K1.1: wire |
| Agent Contract | 110 (staged) | ❌ | `createContract()` never called; contract not threaded to agent loop | K1.2: wire |
| Agent Budget Tracker | — | ✅ | `fromContract()` exists but `fromRouting()` used instead | K1.2: swap |
| Guardrails | — | ✅ **Done** | `validateInput()` at `core-loop.ts` L291 | K1.5: ✅ |
| Tool Authorization | 93 (staged) | ❌ | `authorizeToolCall()` zero callers | K1.3: wire (shares K1.2 path) |
| ECP Validation | staged | ❌ | Not integrated into `oracle/runner.ts` | K1.4: wire |
| ECP Transports (4) | — | ✅ | `confidence_source` not filtered in gate decisions | K1.0: fix |
| Risk Router | 204 | ✅ | No gaps | — |
| Core Loop | 2,069 | ✅ | Single-task; no contradiction escalation | K1.1 + K2 |
| Task Queue | 66 (staged) | ❌ | Not integrated | K2.2: wire |
| Priority Router | 59 (staged) | ❌ | Not integrated | K2.1: wire |
| Provider Trust Store | 89 (staged) | ❌ | Schema keys by `(provider)` only, no `task_type` | K2.1: wire + schema decision |
| A2A Manager | 412 | ⚠️ Off | No cross-instance test | K2.3: activate + test |

---

## 2. K1 — Kernel Hardening

### 2.0 K1.0 — `confidence_source` Enforcement (A5 Fix)

**Problem:** `confidence_source` exists with 3 values: `'evidence-derived'`, `'self-model-calibrated'`, `'llm-self-report'`. The understanding engine tags output as `llm-self-report`, but `gate.ts` does not filter on this field. LLM self-reported confidence enters gate decisions alongside deterministic oracle evidence — **this violates A5 (Tiered Trust)**.

**Fix — ~20 LOC in `gate.ts`:**

```typescript
// After collecting oracle results, before SL fusion:
const gateEligibleResults = oracleResults.filter(r => {
  if (r.confidenceSource === 'llm-self-report') {
    eventBus.emit('gate:llm-self-report-excluded', {
      oracleType: r.oracleType, confidence: r.confidence,
    });
    return false;
  }
  return true; // undefined → included (backward compat)
});
// Use gateEligibleResults for SL fusion, epistemic decision, conflict resolution
```

| File | Change | LOC |
|------|--------|-----|
| `src/gate/gate.ts` | Filter `llm-self-report` before aggregation | ~20 |
| `src/bus/audit-listener.ts` | Subscribe to `gate:llm-self-report-excluded` | ~5 |

| Test | Expected |
|------|----------|
| `confidenceSource: 'evidence-derived'` | Included in gate decision |
| `confidenceSource: 'llm-self-report'` | Excluded, logged |
| `confidenceSource: undefined` | Included (backward compat) |
| All oracles are `llm-self-report` | Gate abstains |

---

### 2.1 K1.5 — Guardrails Block-Not-Strip ✅ DONE

`validateInput()` implemented and wired at `core-loop.ts` L291. Injection → REJECT + EventBus + audit. Input never reaches LLM.

`sanitizeForPrompt()` retained (deprecated) at 3 internal sites as defense-in-depth:
- `working-memory.ts` L64 — sanitizes LLM text before storing
- `prompt-assembler.ts` L21 — sanitizes at assembly time
- `prompt-section-registry.ts` L26 — same pattern

These are internal data paths (LLM→storage→prompt), not external input gates.

**Remaining:** Verify `guardrailsScan` callback in `AgentLoopDeps` uses reject semantics for tool results.

---

### 2.2 K1.1 — Contradiction Escalation Wiring

**Problem:** `resolveConflicts()` returns `hasContradiction: true` but core loop ignores it.

**What works:** Resolver → `hasContradiction` in `ResolvedGateResult` → included in gate verdict. Core loop has escalation logic but only for failure/retry, not contradiction.

**Fix — ~20 LOC in `core-loop.ts`:**

```typescript
// After oracle gate returns verdict
if (gateVerdict.decision === 'block' && gateVerdict.hasContradiction) {
  if (currentLevel < 3) {
    const nextLevel = (currentLevel + 1) as RoutingLevel;
    eventBus.emit('verification:contradiction_escalated', {
      taskId, fromLevel: currentLevel, toLevel: nextLevel,
      resolutions: gateVerdict.resolutions,
    });
    continue; // re-verify at higher level
  }
  // L3 contradiction — terminal failure
  eventBus.emit('verification:contradiction_unresolved', {
    taskId, level: currentLevel, resolutions: gateVerdict.resolutions,
  });
  return { outcome: 'failed', reason: 'unresolved_contradiction' };
}
```

| File | Change | LOC |
|------|--------|-----|
| `src/orchestrator/core-loop.ts` | Contradiction check after gate verify | ~20 |
| `src/core/types.ts` | Event types | ~10 |
| `src/bus/audit-listener.ts` | Log events | ~5 |

| Test | Expected |
|------|----------|
| Contradiction at L1 | Auto-escalate to L2 |
| Contradiction at L3 | Terminal failure |
| No contradiction | Normal flow |

---

### 2.3 K1.2 + K1.3 — Contract Wiring + Tool Authorization

**These are one wiring task.** Both need `AgentContract` threaded through the dispatch path.

**What exists (staged):**
- `agent-contract.ts` (110 LOC): `AgentContractSchema`, `createContract()`, `DEFAULT_CAPABILITIES` per level
- `agent-budget.ts`: `fromContract()` (mirrors `fromRouting()`)
- `tool-authorization.ts` (93 LOC): `authorizeToolCall()`, `classifyTool()` (15 tools → 5 capabilities), `matchesScope()` (glob)

**The 5 wiring edits:**

```
1. core-loop.ts (~L466): const contract = createContract(input, routing, contextWindow);
2. core-loop.ts → worker-pool.ts: pass contract through dispatch() [param already typed]
3. worker-pool.ts → agent-loop.ts: add contract to AgentLoopDeps
4. agent-loop.ts: replace fromRouting() → fromContract()
5. agent-loop.ts (~L355): call authorizeToolCall(contract, call.tool, call.parameters)
                          before deps.toolExecutor.execute()
```

| File | Change | LOC |
|------|--------|-----|
| `src/orchestrator/core-loop.ts` | Call `createContract()`, pass to dispatch | ~10 |
| `src/orchestrator/worker/worker-pool.ts` | Thread contract to `runAgentLoop()` | ~5 |
| `src/orchestrator/worker/agent-loop.ts` | `fromContract()` + `authorizeToolCall()` | ~20 |

**Capability scope per routing level (from `DEFAULT_CAPABILITIES`):**

| Level | Capabilities |
|-------|-------------|
| L0 | None |
| L1 | `file_read: **`, `shell_read: [cat,ls,find,grep]` |
| L2 | L1 + `file_write: [src/**,tests/**]`, `shell_exec: [bun,tsc,biome]`, `llm_call: *` |
| L3 | Full access (`**` for all) |

**Security note:** `classifyTool` extracts `cmd.split(/\s+/)[0]` as shell scope. At L3 (`commands: ['**']`), any command passes — **intentional** (L3 = full access). At L2 (`commands: ['bun','tsc','biome']`), `bash -c 'rm -rf /'` is blocked because `bash ∉ ['bun','tsc','biome']`. Scope matching is the security boundary.

| Test | Expected |
|------|----------|
| Contract created at dispatch | `createContract()` called, immutable |
| L0 agent tries `file_write` | REJECTED |
| L2 agent writes to `src/foo.ts` | Allowed |
| L2 agent runs `bash -c 'rm ...'` | REJECTED (`bash` not in L2 allowlist) |
| L3 agent runs anything | Allowed |
| Unknown tool | REJECTED (zero-trust default) |

---

### 2.4 K1.4 — ECP Validation Wiring

**What exists (staged):** `ecp-validation.ts` with `ECPVerdictEnvelopeSchema`, `validateECPVerdict()`, `normalizeECPMessage()`.

**Fix — ~10 LOC in `oracle/runner.ts`:**

```typescript
// After transport.verify() returns rawVerdict:
const normalized = normalizeECPMessage(rawVerdict);
const validation = validateECPVerdict(normalized);
if (!validation.valid) {
  logger.warn(`Invalid ECP verdict: ${validation.error}`, { oracleType });
  normalized.confidence = 0.0; // Degrade, don't crash (backward compat)
}
```

| File | Change | LOC |
|------|--------|-----|
| `src/oracle/runner.ts` | Import + call validation after `transport.verify()` | ~10 |

---

## 3. K2 — Multi-Agent Dispatch (Reduced Scope)

### Scope Reduction from Architecture Doc

| Architecture Doc | K2 Practical | Rationale |
|-----------------|-------------|-----------|
| Market Scheduler (auction) | Priority Router (trust-weighted) | <10 agents → no competition |
| Trust Ledger (per-agent-per-capability) | Trust per provider | Same math, simpler scope |
| Cross-Task Concurrent Dispatch | Task Queue + Semaphore | Existing code, bounded concurrency |
| A2A full federation | Single-peer E2E test | Prove it works first |
| MCP bidirectional | Defer | Client needs tool registry design |
| Market integrity | Defer | No market → no gaming |

### 3.1 K2.1 — Priority Router + Trust Store

**What exists (staged):**
- `priority-router.ts` (59 LOC): `selectProvider()` — trust-weighted selection
- `provider-trust-store.ts` (89 LOC): SQLite persistence with in-memory cache

**Schema decision (D-schema):** Staged code keys by `(provider)` only. Per-task-type keying (`provider_id, task_type`) deferred — <5 providers makes it premature. Extend when trust data shows task-type divergence.

**Wiring needed:**

| File | Change | LOC |
|------|--------|-----|
| `src/orchestrator/core-loop.ts` | Learn phase: `providerTrustStore.recordOutcome()` after verification | ~10 |
| Integration with `ReasoningEngineRegistry` | `selectProvider()` before engine dispatch | ~15 |

### 3.2 K2.2 — Task Queue + Concurrent Dispatch

**What exists (staged):** `task-queue.ts` (66 LOC) — semaphore-based `enqueue<T>(fn): Promise<T>`, `drain()`, default `maxConcurrent = 5`.

**Wiring needed:**

```typescript
// core-loop.ts — export factory
export function createTaskQueue(deps: OrchestratorDeps, maxConcurrent = 4): TaskQueue {
  return new TaskQueue(maxConcurrent, executeTask, deps);
}
```

| File | Change | LOC |
|------|--------|-----|
| `src/orchestrator/core-loop.ts` | Export `createTaskQueue()` | ~5 |
| `src/cli/serve.ts` or API | Use TaskQueue instead of direct `executeTask` | ~10 |

**Concurrency risks:**
- `deps.worldGraph` has write paths — SQLite WAL mode provides single-writer safety for single-process
- Cross-task file write conflicts need advisory locks (not yet implemented, deferred)
- Per-level semaphores in `worker-pool.ts` already bound concurrent LLM calls correctly
- **Crash recovery:** Process crash loses all concurrent in-flight tasks. No checkpointing exists. See architecture doc §7.7.

### 3.3 K2.3 — A2A Activation

**What exists:** `A2AManager` (412 LOC), 4 transports, 28 test files. Default off.

**Scope:**
1. Config: Document opt-in path (NOT default ON — A6 zero-trust)
2. Integration test: Spawn 2 instances in-process, delegate task A→B, verify result
3. A2A messages validated through K1.4 ECP validation

| File | Change | Risk |
|------|--------|------|
| `tests/integration/a2a-delegation.test.ts` | NEW — E2E test | Medium |
| `src/config/schema.ts` | Document activation path | Low |

---

## 4. Implementation Order

```
Phase A (Day 1): A5 Fix
  └─ K1.0: confidence_source enforcement        ← ~20 LOC, highest architectural impact

Phase B (Day 2-4): Contract Wiring
  ├─ K1.2 + K1.3: Thread contract through dispatch   ← 5 wiring edits
  └─ K1.4: Wire ECP validation in oracle/runner       ← ~10 LOC, independent

Phase C (Day 5-6): Contradiction Wiring
  └─ K1.1: hasContradiction → auto-escalation         ← ~20 LOC

Phase D (Day 7+): Tests + K1 Gate
  └─ G0-G7 from architecture doc

--- K1 Gate ---

Phase E (Week 2-3): K2 Foundation
  ├─ K2.1: Wire priority-router + trust-store
  └─ K2.2: Wire task-queue into API layer

Phase F (Week 3-4): Cross-Instance
  └─ K2.3: A2A activation + E2E test

--- K2 Gate ---
```

**Timeline:** K1 = ~1-2 weeks. K2 = ~2-3 weeks. Total = ~4-5 weeks.

---

## 5. Verification Strategy

| Deliverable | Verification |
|-------------|-------------|
| K1.0 confidence_source | `llm-self-report` excluded from gate; `undefined` included; all-LLM → abstain |
| K1.5 Guardrails | ✅ Done — injection → reject + audit; clean → pass |
| K1.1 Escalation | Contradiction at L1 → L2; at L3 → terminal failure; no contradiction → unchanged |
| K1.2 Contract | Contract created at dispatch; `fromContract()` matches `fromRouting()` values |
| K1.3 Tool Auth | L0 denied write; L2 allowed in scope; unknown tool denied; L3 full access |
| K1.4 ECP | Missing `ecp_version` → normalized to 1.0; invalid confidence → degraded to 0.0 |
| K2.1 Priority Router | Select by trust; filter by capability; tie-break by experience |
| K2.2 Task Queue | Bounded concurrency; drain order; batch submit |
| K2.3 A2A | 2 instances delegate task E2E |
| **Full K1+K2** | `bun run test` + `bun run check` (0 errors) |

---

## 6. File Inventory

### ✅ Done

| File | Status |
|------|--------|
| `src/guardrails/index.ts` | `validateInput()` + deprecated `sanitizeForPrompt()` |
| `src/orchestrator/core-loop.ts` L291 | `validateInput()` as first gate |

### Staged (Wiring Only)

| File | LOC | Purpose |
|------|-----|---------|
| `src/core/agent-contract.ts` | 110 | Contract type + Zod + factory |
| `src/security/tool-authorization.ts` | 93 | Tool→capability + auth check |
| `src/a2a/ecp-validation.ts` | staged | ECP validation middleware |
| `src/orchestrator/priority-router.ts` | 59 | Trust-weighted selection |
| `src/db/provider-trust-store.ts` | 89 | SQLite trust persistence |
| `src/orchestrator/task-queue.ts` | 66 | Bounded concurrent dispatch |

### Remaining Wiring

| File | Changes | LOC |
|------|---------|-----|
| `src/gate/gate.ts` | K1.0: filter `llm-self-report` | ~20 |
| `src/orchestrator/core-loop.ts` | K1.1: contradiction escalation; K1.2: `createContract()` + pass to dispatch; K2: `createTaskQueue()` | ~45 |
| `src/orchestrator/worker/worker-pool.ts` | K1.2: thread contract to `runAgentLoop()` | ~5 |
| `src/orchestrator/worker/agent-loop.ts` | K1.2: `fromContract()`; K1.3: `authorizeToolCall()` | ~20 |
| `src/oracle/runner.ts` | K1.4: ECP validation after `transport.verify()` | ~10 |
| `src/core/types.ts` | Event types | ~15 |
| `src/bus/audit-listener.ts` | Subscribe to events | ~10 |

### New Files

| File | LOC | Purpose |
|------|-----|---------|
| `tests/gate/confidence-source.test.ts` | ~40 | K1.0 verification |
| `tests/integration/a2a-delegation.test.ts` | ~80 | K2.3 E2E test |

**Total remaining:** ~125 LOC wiring + ~120 LOC tests

---

## 7. What Remains Aspirational

| Item | Why | Prerequisite |
|------|-----|-------------|
| Market Auction | <10 agents; no adversarial competition | ≥10 heterogeneous agents |
| Formal Proof Oracle (Lean4) | Research-grade; <1% end-to-end success | Lean4 tooling maturity |
| Federation | A2A single-peer not yet proven | Working E2E test |
| Self-Evolution | Data-gated (≥100 traces) | Production deployment |
| Crash Recovery | No task checkpointing exists | Pre-K2 production requirement |
| Value Demonstration | No Vinyan+LLM vs LLM-alone comparison | Side-by-side benchmark |

---

## 8. Decision Log

| # | Decision | Rationale |
|---|----------|-----------|
| D-K1.0 | `confidence_source` enforcement first | A5 violation; ~20 LOC; highest impact |
| D-K1.5 | K1.5 marked DONE | `validateInput()` wired; `sanitizeForPrompt()` retained deprecated |
| D-schema | Keep `(provider)` keying, defer `task_type` | <5 providers; extend when data shows divergence |
| D0 | Identity: "orchestration kernel" not "OS" | Not a systems-programming OS; closer to Kubernetes |
| D0.1 | Drop "Economy" from K1/K2 scope | <10 agents; trust-weighted routing suffices |
| D-K1.1 | Defer ConflictReport as ECP message type | Too broad for K1; wire escalation only |
| D-K1.2 | Defer human escalation at L3 | No human-in-loop interface; log + fail suffices |
| D-K1.3 | Static RBAC per contract, not dynamic tokens | Single-use tokens unnecessary for <10 agents |
| D-K1.4 | Defer `evidence_chain` enforcement | No producers yet; enforce `confidence` + `ecp_version` only |
| D-K2.1 | Priority Router replaces Market Scheduler | No competing bidders at current scale |
| D-K2.2 | TaskQueue wraps `executeTask()` | No core-loop refactor needed |
| D-K2.3 | A2A explicit opt-in | Network listener → A6 compliance |
| D-K2.4 | Defer MCP Client | Needs tool registry design |
