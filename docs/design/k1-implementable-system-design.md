# Vinyan Kernel — Implementable System Design (K1 + K2)

> **Document boundary**: This document owns the **concrete implementation design** for K1 (security hardening) and K2 (multi-agent dispatch) — scoped to what the codebase can actually support today.
> For vision and axiom mapping → [vinyan-os-architecture.md](../architecture/vinyan-os-architecture.md).
> For ECP v2 full protocol → [ecp-v2-system-design.md](ecp-v2-system-design.md).

**Date:** 2026-04-08
**Status:** Draft v2 — identity-corrected, K2 scope reduced
**Audience:** Implementors (human or agent)

---

## 0. Identity Reality Check

### What Vinyan Actually Is

Vinyan is a **multi-agent orchestration kernel with a strong verification layer**. The verification pipeline — Oracle Gate, 5-step conflict resolver, tiered trust, circuit breakers, Subjective Logic fusion — is the genuine differentiator. This is real, tested, production-quality code.

### What Vinyan Is Not (Yet)

| Claim | Reality |
|-------|---------|
| "Operating System" | Vinyan ไม่ schedule processes บน CPU, ไม่มี MMU, ไม่มี filesystem. seL4 parallel เป็น useful analogy สำหรับ capability model แต่ Vinyan ไม่ใช่ OS ในความหมาย systems programming. มันคือ **orchestration kernel** — closer to Kubernetes than Linux. |
| "AGI Economy" | LLMs ปัจจุบันเป็น tools ที่ Vinyan orchestrate. "AGI-grade reliability" เป็น design goal ที่เกี่ยวกับ **epistemic architecture** (generation ≠ verification) ไม่ได้หมายความว่า system นี้เป็น AGI หรือใกล้ AGI. |
| "Agent Economy with Market" | Full bid/auction/collateral mechanism สำหรับ <10 agents คือ over-engineering. K2 scope ลดเป็น **priority-based routing with trust scoring** — market mechanism เพิ่มได้ทีหลังเมื่อมี agents พอที่จะแข่งขันกัน |

### Honest Value Proposition

```
What's strong (proven in code):
  ✅ Verification pipeline (Oracle Gate + conflict resolution + tiered trust)
  ✅ Risk-based routing (L0-L3 with evidence-based escalation)
  ✅ Budget enforcement (token/turn/duration/tool-call limits)
  ✅ ECP transport layer (4 types, operational)
  ✅ Epistemic primitives (Subjective Logic, Wilson CI, content-addressed facts)

What needs hardening (K1 — this doc):
  🔧 Security: strip → block, capability scope, ECP validation
  🔧 Wiring: contradiction escalation, formal contracts

What's aspirational (K2 — reduced scope):
  🔮 Multi-task concurrent dispatch
  🔮 Trust-based agent selection (not full market auction)
  🔮 A2A cross-instance delegation
```

---

## 1. Codebase Audit Summary

ก่อน design ต้องรู้ว่า codebase ปัจจุบันมีอะไร — เพื่อไม่ build ซ้ำ และไม่ design สิ่งที่ไม่มี foundation รองรับ

| Component | Exists? | Wired? | Remaining Gap | Implementable? |
|-----------|---------|--------|---------------|----------------|
| Conflict Resolver (5-step) | ✅ `gate/conflict-resolver.ts` | ✅ `gate.ts` L344 | Escalation not auto-triggered; ConflictReport not ECP message | ✅ Low risk |
| Agent Budget Tracker | ✅ `worker/agent-budget.ts` | ✅ `agent-loop.ts` | No formal `AgentContract` type; no capability scope | ✅ Medium risk |
| Guardrails (15+ patterns) | ✅ `guardrails/index.ts` | ✅ | **Strip-not-block**; `.replace()` bug (first match only) | ✅ Low risk |
| RBAC (3-tier) | ✅ `security/auth.ts` + `authorization.ts` | ✅ | API-level RBAC only; no tool-level capability tokens | ⚠️ Medium risk |
| ECP Transports (4 types) | ✅ `a2a/*.ts` | ✅ `oracle/runner.ts` | No version enforcement; epistemic fields optional | ✅ Low risk |
| Risk Router | ✅ `gate/risk-router.ts` | ✅ | Fully operational, no gaps | N/A |
| Core Loop | ✅ `orchestrator/core-loop.ts` | ✅ | Single-task dispatch only | 🔴 K2 scope |
| A2A Manager | ✅ `a2a/a2a-manager.ts` | ⚠️ Default off | No cross-instance integration test | 🔴 K2 scope |

### Implementability Verdict

จาก 5 K1 deliverables ใน architecture doc:

| ID | Deliverable | Verdict | Rationale |
|----|-------------|---------|-----------|
| **K1.5** | Guardrails block-not-strip | ✅ **Implement now** | มี detection 15+ patterns แล้ว, แค่เปลี่ยน behavior จาก strip → reject + fix `.replace()` bug |
| **K1.1** | Contradiction escalation | ✅ **Implement now** | Resolver 5-step ทำงานแล้ว, ต้อง wire `'contradictory'` → risk-router auto-escalation |
| **K1.2** | Agent Contract | ✅ **Implement now** | Budget enforcement ครบ, ต้อง formalize เป็น typed contract + add capability scope |
| **K1.3** | Capability Tokens | ⚠️ **Implement partially** | RBAC 3-tier มีแล้ว, แต่ tool-level tokens ต้อง design ใหม่ — scope ไว้แค่ extend existing auth |
| **K1.4** | ECP v2 hardening | ⚠️ **Implement partially** | Transport ครบ 4 ตัว, เพิ่ม validation middleware + version enforcement ได้เลย; full epistemic enforcement ยังไม่ practical |

**ตัดออก (defer to K2):** Cross-task dispatch, Market Scheduler, Trust Ledger, A2A activation — เหตุผล: ขึ้นกับ K1 foundation ที่ยังไม่มี

---

## 2. Implementation Design — Priority Order

### 2.1 K1.5 — Guardrails: Block, Don't Strip (CRITICAL)

**Problem:** `sanitizeForPrompt()` ใน [guardrails/index.ts](../../src/guardrails/index.ts) ตรวจพบ injection แต่ **strip แค่ first match** แล้วส่ง cleaned text ต่อ → agent ยังได้รับ input ที่มี attack payload ส่วนที่เหลือ

**Bug ที่ต้อง fix ก่อน:** Line 41 ใช้ `.replace(globalPattern, ...)` — global flag ถูกเพิ่มแล้วแต่ `.replace()` กับ RegExp ที่มี `g` flag ทำงานได้ถูกต้อง **เฉพาะเมื่อ** RegExp เป็น global. ต้อง verify ว่า original pattern flags ไม่มี conflict.

**Design:**

```
Current flow:
  Input → detectPromptInjection() → sanitizeForPrompt() → return { cleaned, detections }
  ↓
  Caller ใช้ cleaned string ต่อ (stripped but processed)

New flow:
  Input → detectPromptInjection() → if detections.length > 0:
    1. Return { rejected: true, detections, original: input }
    2. Caller gets SecurityViolation → MUST handle (not ignore)
    3. EventBus.emit('security:injection_detected', { detections, taskId })
    4. Audit log entry created
    5. Input NEVER reaches LLM
```

**Interface changes:**

```typescript
// src/guardrails/index.ts

// BEFORE: always returns cleaned text
export interface SanitizeResult {
  cleaned: string;
  detections: string[];
}

// AFTER: returns either clean input or rejection
export type GuardrailResult =
  | { status: 'clean'; text: string }
  | { status: 'rejected'; detections: string[]; reason: string };

export function validateInput(text: string): GuardrailResult {
  const normalized = normalizeForScan(text);
  const injection = detectPromptInjection(normalized);
  const bypass = containsBypassAttempt(normalized);
  const detections = [...injection.patterns, ...bypass.patterns];

  if (detections.length === 0) {
    return { status: 'clean', text };
  }

  return {
    status: 'rejected',
    detections,
    reason: `Prompt injection detected: ${detections.join(', ')}`,
  };
}

// Keep sanitizeForPrompt() as deprecated fallback for backward compat
/** @deprecated Use validateInput() instead — this strips instead of blocking */
export function sanitizeForPrompt(text: string): SanitizeResult { /* existing */ }
```

**Caller integration (perception.ts):**

```typescript
// src/orchestrator/perception.ts — where task input is processed

const result = validateInput(taskDescription);
if (result.status === 'rejected') {
  eventBus.emit('security:injection_detected', {
    taskId,
    detections: result.detections,
    timestamp: Date.now(),
  });
  // Return error result — DO NOT continue to LLM
  return { error: 'SECURITY_VIOLATION', details: result.reason };
}
// result.status === 'clean' → proceed with result.text
```

**Files to change:**

| File | Change | Risk |
|------|--------|------|
| `src/guardrails/index.ts` | Add `GuardrailResult` type + `validateInput()` function; deprecate `sanitizeForPrompt()` | Low — additive |
| `src/orchestrator/perception.ts` | Replace `sanitizeForPrompt()` call with `validateInput()` | Low — behavior change at single call site |
| `src/core/types.ts` | Add `SecurityViolationEvent` type for EventBus | Low — additive |
| `src/bus/audit-listener.ts` | Subscribe to `security:injection_detected` → log to audit | Low — additive |

**Backward compatibility:** `sanitizeForPrompt()` ยังคงอยู่ (deprecated) → external callers ไม่พัง

**Test scenarios:**

| Scenario | Expected |
|----------|----------|
| Clean input | `{ status: 'clean', text: original }` |
| Input with 1 injection pattern | `{ status: 'rejected', detections: ['system_marker'] }` |
| Input with multiple patterns | `{ status: 'rejected', detections: ['system_marker', 'role_injection'] }` |
| Unicode-normalized attack | Same rejection behavior |
| EventBus receives event | `security:injection_detected` emitted with taskId + detections |

---

### 2.2 K1.1 — Contradiction Escalation Wiring

**Problem:** `conflict-resolver.ts` ส่งคืน `hasContradiction: true` เมื่อ conflict escalate ถึง step 5 แต่ค่านี้ **ไม่ถูกใช้** — core loop ไม่ auto-escalate routing level เมื่อเจอ contradiction

**What already works:**
- `resolveConflicts()` returns `ResolvedGateResult` with `hasContradiction` flag
- `gate.ts` L344 calls `resolveConflicts()` and includes result in gate verdict
- `core-loop.ts` has escalation logic (`applyPredictionEscalation`) — but triggered by failure/retry, not contradiction
- Risk router has routing levels L0-L3

**What's missing:** Wire `hasContradiction → auto-escalate`

**Design:**

```
Gate verdict arrives at core-loop:
  │
  ├─ verdict.decision === 'block' + verdict.hasContradiction === true
  │   │
  │   ├─ Current level < L3
  │   │   → Escalate: level + 1 (more oracles = more evidence to break tie)
  │   │   → Log: "Contradiction at L{n}, escalating to L{n+1}"
  │   │   → Re-run verification at higher level
  │   │
  │   └─ Current level === L3
  │       → Emit event: 'verification:contradiction_unresolved'
  │       → Task result: { outcome: 'failed', reason: 'unresolved_contradiction', conflictReport }
  │       → (Human escalation ไม่ implement ตอนนี้ — ยังไม่มี human-in-loop interface)
  │
  └─ verdict.decision !== contradicted → normal flow (unchanged)
```

**Integration point — core-loop.ts verify step:**

```typescript
// After oracle gate returns verdict
if (gateVerdict.decision === 'block' && gateVerdict.hasContradiction) {
  if (currentLevel < 3) {
    // Auto-escalate: more oracles at higher level may resolve contradiction
    const nextLevel = (currentLevel + 1) as RoutingLevel;
    eventBus.emit('verification:contradiction_escalated', {
      taskId, fromLevel: currentLevel, toLevel: nextLevel,
      resolutions: gateVerdict.resolutions,
    });
    // Re-verify at higher routing level
    continue; // or trigger re-verification with nextLevel
  }
  // L3 contradiction — terminal failure
  eventBus.emit('verification:contradiction_unresolved', {
    taskId, level: currentLevel,
    resolutions: gateVerdict.resolutions,
  });
  return { outcome: 'failed', reason: 'unresolved_contradiction' };
}
```

**Files to change:**

| File | Change | Risk |
|------|--------|------|
| `src/orchestrator/core-loop.ts` | Add contradiction check after gate verification; escalate or fail | Medium — changes verify logic flow |
| `src/core/types.ts` | Add `ContradictionEscalatedEvent`, `ContradictionUnresolvedEvent` | Low — additive |
| `src/bus/audit-listener.ts` | Log contradiction events | Low — additive |

**Not changing (already works):**
- `conflict-resolver.ts` — 5-step resolution already correct
- `gate.ts` — already calls `resolveConflicts()` and returns `hasContradiction`
- `risk-router.ts` — routing levels already defined

**Test scenarios:**

| Scenario | Expected |
|----------|----------|
| Contradiction at L1 | Auto-escalate to L2; EventBus receives `contradiction_escalated` |
| Contradiction at L2 | Auto-escalate to L3 |
| Contradiction at L3 | Task fails with `unresolved_contradiction`; EventBus receives event |
| No contradiction | Normal flow unchanged |
| Contradiction resolved at step 1-4 | `hasContradiction: false` → normal flow |

---

### 2.3 K1.2 — Agent Contract (Formalize Existing Budget)

**Problem:** Budget enforcement เกิดขึ้นจริง (`agent-budget.ts` tracks tokens, turns, tool calls; `agent-loop.ts` kills on `budget_exceeded`) แต่ไม่มี **typed contract** ที่ระบุ capability scope — agent ทุกตัวมี implicit permission เท่ากันหมด

**What already works:**
- `AgentBudgetTracker.fromRouting()` — derives budget from routing level
- `maxToolCallsPerTurn` per level: L0=0, L1=0, L2=20, L3=50
- Budget pools: base (60%), negotiable (25%), delegation (15%)
- Hard kill on `budget_exceeded`
- Delegation depth tracking

**Design — typed contract wrapping existing budget:**

```typescript
// src/core/agent-contract.ts (NEW FILE)

import { z } from 'zod/v4';

/** Tool-level capability scope — what an agent is allowed to do */
export const CapabilitySchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('file_read'),  paths: z.array(z.string()) }),
  z.object({ type: z.literal('file_write'), paths: z.array(z.string()) }),
  z.object({ type: z.literal('shell_exec'), commands: z.array(z.string()) }),
  z.object({ type: z.literal('shell_read'), commands: z.array(z.string()) }),
  z.object({ type: z.literal('llm_call'),   providers: z.array(z.string()) }),
]);

export type Capability = z.infer<typeof CapabilitySchema>;

export const AgentContractSchema = z.object({
  // Identity
  taskId: z.string(),
  routingLevel: z.number().min(0).max(3),

  // Resource limits (from existing AgentBudgetTracker)
  tokenBudget: z.number(),
  timeLimitMs: z.number(),
  maxToolCalls: z.number(),
  maxToolCallsPerTurn: z.number(),
  maxTurns: z.number(),
  maxEscalations: z.number().default(3),

  // Capability scope
  capabilities: z.array(CapabilitySchema),

  // Violation policy
  onViolation: z.enum(['kill', 'warn_then_kill', 'degrade']).default('kill'),
  violationTolerance: z.number().default(0),

  // Metadata
  issuedAt: z.number(),
  immutable: z.literal(true).default(true),
});

export type AgentContract = z.infer<typeof AgentContractSchema>;
```

**Contract generation — extend existing `fromRouting()`:**

```typescript
// src/core/agent-contract.ts

import type { RoutingDecision } from '../orchestrator/types.ts';
import type { TaskInput } from '../core/types.ts';

/** Default capabilities per routing level (A6: least privilege) */
const DEFAULT_CAPABILITIES: Record<number, Capability[]> = {
  0: [],  // L0 reflex — no tool access
  1: [    // L1 heuristic — read-only
    { type: 'file_read', paths: ['**'] },
    { type: 'shell_read', commands: ['cat', 'ls', 'find', 'grep'] },
  ],
  2: [    // L2 analytical — read + write in workspace
    { type: 'file_read', paths: ['**'] },
    { type: 'file_write', paths: ['src/**', 'tests/**'] },
    { type: 'shell_exec', commands: ['bun', 'tsc', 'biome'] },
    { type: 'shell_read', commands: ['**'] },
    { type: 'llm_call', providers: ['*'] },
  ],
  3: [    // L3 deliberative — full access
    { type: 'file_read', paths: ['**'] },
    { type: 'file_write', paths: ['**'] },
    { type: 'shell_exec', commands: ['**'] },
    { type: 'shell_read', commands: ['**'] },
    { type: 'llm_call', providers: ['*'] },
  ],
};

export function createContract(
  task: TaskInput,
  routing: RoutingDecision,
  contextWindow: number,
): AgentContract {
  const level = routing.level;
  return {
    taskId: task.id,
    routingLevel: level,
    tokenBudget: routing.budgetTokens,
    timeLimitMs: routing.latencyBudgetMs,
    maxToolCalls: { 0: 0, 1: 0, 2: 20, 3: 50 }[level] ?? 50,
    maxToolCallsPerTurn: Math.min(10, { 0: 0, 1: 0, 2: 20, 3: 50 }[level] ?? 50),
    maxTurns: level === 1 ? 15 : level === 2 ? 30 : 50,
    maxEscalations: 3,
    capabilities: DEFAULT_CAPABILITIES[level] ?? [],
    onViolation: level <= 1 ? 'kill' : 'warn_then_kill',
    violationTolerance: level <= 1 ? 0 : 2,
    issuedAt: Date.now(),
    immutable: true,
  };
}
```

**Contract enforcement — extend existing budget tracker:**

```typescript
// In worker-pool.ts or agent-session.ts, at dispatch time:

const contract = createContract(task, routing, contextWindow);
// Pass contract to agent-budget tracker
const budget = AgentBudgetTracker.fromContract(contract);

// NEW method on AgentBudgetTracker:
static fromContract(contract: AgentContract): AgentBudgetTracker {
  // Same logic as fromRouting(), but sourced from immutable contract
  const budget: AgentBudget = {
    maxTokens: contract.tokenBudget,
    maxTurns: contract.maxTurns,
    maxDurationMs: contract.timeLimitMs,
    // ... rest same as existing fromRouting()
  };
  return new AgentBudgetTracker(budget);
}
```

**Capability validation — middleware for tool executor:**

```typescript
// src/orchestrator/tools/ — before executing any tool

function validateCapability(
  contract: AgentContract,
  toolCall: ToolCall,
): { allowed: boolean; reason?: string } {
  const requiredCap = classifyToolCapability(toolCall);
  // requiredCap = { type: 'file_write', paths: ['/path/to/file'] }

  const matchingCap = contract.capabilities.find(
    cap => cap.type === requiredCap.type &&
    matchesGlob(requiredCap.paths ?? requiredCap.commands, cap.paths ?? cap.commands),
  );

  if (!matchingCap) {
    return {
      allowed: false,
      reason: `Capability denied: ${requiredCap.type} not in contract for level ${contract.routingLevel}`,
    };
  }
  return { allowed: true };
}
```

**Files to change:**

| File | Change | Risk |
|------|--------|------|
| `src/core/agent-contract.ts` | NEW — Contract type + factory + validation | Low — new file |
| `src/orchestrator/worker/agent-budget.ts` | Add `fromContract()` static method | Low — additive to existing class |
| `src/orchestrator/worker/worker-pool.ts` | Generate contract at dispatch, pass to session | Medium — changes dispatch flow |
| `src/orchestrator/tools/tool-executor.ts` (or equivalent) | Add capability check before tool execution | Medium — behavior change |

**Phase 1 scope (K1.2):** Contract creation + budget bridging + capability validation on tool calls.
**Deferred to K2:** Capability tokens (short-lived, single-use, revocable) — added when Market Scheduler needs per-auction security.

---

### 2.4 K1.3 — Capability Token (Simplified for K1)

**Decision: ลดขอบเขตลง** — architecture doc ออกแบบ full seL4-style single-use tokens ซึ่ง overkill สำหรับ single-agent system ปัจจุบัน

**K1 scope:** Extend existing RBAC (`security/authorization.ts`) ให้ครอบคลุม tool-level operations — ไม่ใช่ dynamic tokens แต่เป็น static permission checks ที่ bind กับ `AgentContract.capabilities`

**Design:**

```typescript
// src/security/tool-authorization.ts (NEW FILE)

import type { AgentContract, Capability } from '../core/agent-contract.ts';

/**
 * Check if a tool call is authorized by the agent's contract.
 * This is the K1 simplified version — static capability matching.
 * K2 adds dynamic, single-use capability tokens.
 */
export function authorizeToolCall(
  contract: AgentContract,
  toolName: string,
  args: Record<string, unknown>,
): { authorized: boolean; violation?: string } {
  const required = classifyTool(toolName, args);

  for (const cap of contract.capabilities) {
    if (cap.type === required.type) {
      if (matchesScope(required.scope, cap)) {
        return { authorized: true };
      }
    }
  }

  return {
    authorized: false,
    violation: `Tool '${toolName}' requires ${required.type} capability, not granted at L${contract.routingLevel}`,
  };
}

/** Map tool name to required capability type */
function classifyTool(
  toolName: string,
  args: Record<string, unknown>,
): { type: Capability['type']; scope: string[] } {
  // File tools
  if (['read_file', 'search_file', 'list_dir'].includes(toolName)) {
    return { type: 'file_read', scope: [String(args.path ?? args.filePath ?? '')] };
  }
  if (['write_file', 'edit_file', 'create_file'].includes(toolName)) {
    return { type: 'file_write', scope: [String(args.path ?? args.filePath ?? '')] };
  }
  // Shell tools
  if (toolName === 'run_command' || toolName === 'shell') {
    const cmd = String(args.command ?? '');
    const isReadOnly = /^(cat|ls|find|grep|head|tail|wc|diff|echo)\b/.test(cmd);
    return {
      type: isReadOnly ? 'shell_read' : 'shell_exec',
      scope: [cmd.split(/\s+/)[0]],
    };
  }
  // LLM tools
  if (toolName === 'llm_generate') {
    return { type: 'llm_call', scope: [String(args.provider ?? '*')] };
  }
  // Unknown tool → deny by default (A6: zero-trust)
  return { type: 'shell_exec', scope: ['UNKNOWN_TOOL'] };
}
```

**Integration point — tool execution path:**

```
Tool call arrives from agent
  │
  ├─ authorizeToolCall(contract, toolName, args)
  │   ├─ authorized: true → execute tool
  │   └─ authorized: false → return error to agent, log violation
  │
  └─ Violation handling (per contract.onViolation):
      'kill' → terminate session immediately
      'warn_then_kill' → increment counter, kill at tolerance
      'degrade' → remove write capabilities from contract copy
```

**Files to change:**

| File | Change | Risk |
|------|--------|------|
| `src/security/tool-authorization.ts` | NEW — tool-level authorization | Low — new file |
| Tool execution entry point | Add `authorizeToolCall()` check | Medium |

---

### 2.5 K1.4 — ECP Transport Validation (Partial)

**Problem:** 4 transports work แต่ไม่ validate `ecp_version` หรือ enforce epistemic fields

**K1 scope (practical):**
1. เพิ่ม validation middleware ที่ wrap ทุก transport
2. Enforce `ecp_version` field — reject unknown versions
3. Enforce `confidence` field (มีอยู่แล้ว) — เปลี่ยนจาก optional เป็น required
4. **Defer** `evidence_chain`, `falsifiable_by`, `temporal_context` enforcement — ยังไม่มี producers ที่ส่งค่าเหล่านี้

**Design:**

```typescript
// src/a2a/ecp-validation.ts (NEW FILE)

import { z } from 'zod/v4';

export const SUPPORTED_ECP_VERSIONS = ['1.0', '2.0-draft'] as const;

/** Minimum required fields on every ECP verdict message */
export const ECPVerdictEnvelopeSchema = z.object({
  ecp_version: z.enum(SUPPORTED_ECP_VERSIONS),
  confidence: z.number().min(0).max(1),
  // K1: optional but logged if missing (prepare for K2 enforcement)
  evidence_chain: z.array(z.string()).optional(),
  falsifiable_by: z.array(z.string()).optional(),
});

export type ECPVerdictEnvelope = z.infer<typeof ECPVerdictEnvelopeSchema>;

/**
 * Validation middleware — wraps any ECPTransport.
 * Validates inbound verdicts before they reach the oracle gate.
 */
export function validateECPVerdict(raw: unknown): {
  valid: boolean;
  data?: ECPVerdictEnvelope;
  error?: string;
} {
  const result = ECPVerdictEnvelopeSchema.safeParse(raw);
  if (!result.success) {
    return { valid: false, error: result.error.message };
  }
  return { valid: true, data: result.data };
}

/** Backward compatibility: messages without version → treated as v1.0, confidence 0.0 */
export function normalizeECPMessage(raw: Record<string, unknown>): Record<string, unknown> {
  return {
    ecp_version: raw.ecp_version ?? '1.0',
    confidence: raw.confidence ?? 0.0,
    ...raw,
  };
}
```

**Integration — oracle/runner.ts:**

```typescript
// After transport.verify() returns a verdict
const normalized = normalizeECPMessage(rawVerdict);
const validation = validateECPVerdict(normalized);
if (!validation.valid) {
  // Log warning but don't crash — backward compat
  logger.warn(`Invalid ECP verdict: ${validation.error}`, { oracleType });
  // Treat as low-confidence result
  normalized.confidence = 0.0;
}
```

**Files to change:**

| File | Change | Risk |
|------|--------|------|
| `src/a2a/ecp-validation.ts` | NEW — validation schema + middleware | Low |
| `src/oracle/runner.ts` | Add validation after transport.verify() | Low — additive check |

---

## 3. Implementation Order & Dependencies

```
Phase A (Week 1-2): Security Foundation
  ├─ K1.5: Guardrails block-not-strip     ← CRITICAL, ไม่มี dependency
  └─ K1.4: ECP validation middleware       ← Independent, low risk

Phase B (Week 3-4): Contract System
  ├─ K1.2: Agent Contract types + factory  ← Depends on nothing
  ├─ K1.3: Tool authorization              ← Depends on K1.2 (uses AgentContract)
  └─ Wire together: contract → budget → tool auth

Phase C (Week 5): Contradiction Wiring
  └─ K1.1: Contradiction escalation        ← Independent, medium risk
      ├─ Wire hasContradiction → auto-escalate in core-loop
      └─ Add EventBus events for audit
```

**Rationale for order:**
1. **K1.5 first** — เป็น CRITICAL security gap (strip-not-block); fix bug `.replace()` ด้วย; ไม่มี dependency
2. **K1.4 parallel** — independent, low risk, validates transport messages
3. **K1.2 → K1.3** — contract ต้องมีก่อน tool authorization ถึงจะ check capability ได้
4. **K1.1 last** — ปลอดภัยที่สุดเพราะ conflict resolver ทำงานอยู่แล้ว, แค่ wire escalation

---

## 4. K2 — Multi-Agent Dispatch (Reduced Scope)

Architecture doc ออกแบบ K2 เป็น full market economy (bid/auction/collateral/dynamic pricing). **ลด scope ลง** — สิ่งที่ codebase รองรับจริงๆ คือ evolving จาก single-task dispatch → multi-task dispatch + trust-based selection.

### 4.1 What K2 Becomes (vs Architecture Doc)

| Architecture Doc (K2) | Practical K2 | Rationale |
|------------------------|-------------|-----------|
| Market Scheduler with auction | **Priority Router** — deterministic selection by trust + capability | <10 agents → no competition → auction has 1 bidder = wasted abstraction |
| Trust Ledger (agent reputation) | **Trust Score per provider** — Wilson LB on outcome history | Same math, simpler scope: per-LLM-provider not per-abstract-agent |
| Cross-Task Concurrent Dispatch | **Task Queue + Semaphore** — bounded concurrency | ✅ Implementable — extend existing worker pool |
| A2A full federation | **A2A single-peer integration test** — prove it works | ✅ Implementable — code exists, needs activation + E2E test |
| MCP bidirectional hub | **Defer** | MCP server exists; client requires tool registry design |
| Market integrity (anti-gaming) | **Defer** | No market → no gaming |
| Dynamic pricing | **Defer** | No competing agents → no price signal |

### 4.2 K2.1 — Priority Router (replaces Market Scheduler)

**Problem:** Risk Router maps risk → fixed routing level → single model. สำหรับ multiple LLM providers, ต้องเลือกว่า provider ไหนดีที่สุดสำหรับ task type นี้

**What already exists:**
- `ReasoningEngineRegistry` — capability-first selection, tier-based fallback
- `AgentBudgetTracker.fromRouting()` — budget per routing level
- `wilson.ts` — Wilson lower bound (proven in sleep-cycle)

**Design — trust-weighted selection among registered engines:**

```typescript
// src/orchestrator/priority-router.ts (NEW FILE)

import { wilsonLowerBound } from '../sleep-cycle/wilson.ts';

interface ProviderScore {
  providerId: string;
  trustScore: number;       // Wilson LB on task-type outcomes
  capabilityMatch: boolean; // can handle this task type
  estimatedCost: number;    // tokens per task (from history)
  estimatedLatency: number; // ms per task (from history)
}

/**
 * Select best provider for a task type.
 * Deterministic (A3): same inputs → same output. No LLM in selection path.
 *
 * Selection order:
 *   1. Filter: capability match required
 *   2. Filter: trust score ≥ minimum for routing level
 *   3. Rank: trust_score * weight + (1 - normalized_cost) * weight
 *   4. Tie-break: more task-type experience wins
 */
export function selectProvider(
  providers: ProviderScore[],
  minimumTrust: number,
  weights: { trust: number; cost: number } = { trust: 0.7, cost: 0.3 },
): ProviderScore | null {
  const eligible = providers
    .filter(p => p.capabilityMatch && p.trustScore >= minimumTrust);

  if (eligible.length === 0) return null;
  if (eligible.length === 1) return eligible[0];

  // Normalize cost to [0,1]
  const maxCost = Math.max(...eligible.map(p => p.estimatedCost));
  const scored = eligible.map(p => ({
    ...p,
    score: weights.trust * p.trustScore
         + weights.cost * (1 - (maxCost > 0 ? p.estimatedCost / maxCost : 0)),
  }));

  scored.sort((a, b) => b.score - a.score);
  return scored[0];
}
```

**Trust score update — after task completion:**

```typescript
// In core-loop.ts learn phase (existing A7 step):

// Record outcome per provider + task type
providerTrustStore.record(providerId, taskType, outcome === 'success');
// Recalculate Wilson LB
const { successes, total } = providerTrustStore.get(providerId, taskType);
const trustScore = wilsonLowerBound(successes, total, 1.96);
```

**Storage — extend existing SQLite pattern:**

```sql
-- New table (follows existing db/ pattern)
CREATE TABLE provider_trust (
  provider_id  TEXT NOT NULL,
  task_type    TEXT NOT NULL,
  successes    INTEGER DEFAULT 0,
  failures     INTEGER DEFAULT 0,
  total_tasks  INTEGER DEFAULT 0,
  trust_score  REAL DEFAULT 0.0,
  last_updated TEXT NOT NULL,
  PRIMARY KEY (provider_id, task_type)
);
```

**Files:**

| File | Change | Risk |
|------|--------|------|
| `src/orchestrator/priority-router.ts` | NEW — trust-weighted provider selection | Low |
| `src/db/provider-trust-store.ts` | NEW — SQLite read/write for trust data | Low |
| `src/orchestrator/core-loop.ts` | Learn phase records outcome per provider | Low — additive |

**What is NOT built (deferred):**
- Bid submission by agents (no auction protocol)
- Collateral staking (no economic mechanism)
- Dynamic pricing (no price signal)
- Anti-gaming (no adversarial agents)

### 4.3 K2.2 — Task Queue + Concurrent Dispatch

**Problem (B2):** `core-loop.ts` `executeTask()` accepts one `TaskInput` at a time. For concurrent work (e.g., multiple independent subtasks from different user requests), this is the bottleneck.

**What already exists:**
- DAG executor — within-task subtask parallelism (`dag-executor.ts`)
- Per-level semaphores — L1=5, L2=3, L3=1 concurrent workers
- Warm pool — subprocess reuse for workers
- File conflict detection — `detectFileConflicts()` serializes when subtasks share files

**Design — bounded task queue wrapping existing dispatch:**

```typescript
// src/orchestrator/task-queue.ts (NEW FILE)

import type { TaskInput, TaskResult } from '../core/types.ts';
import type { OrchestratorDeps } from './core-loop.ts';

/**
 * Bounded concurrent task dispatcher.
 * Wraps existing executeTask() with a semaphore for top-level concurrency.
 * Within-task parallelism unchanged (DAG executor handles it).
 */
export class TaskQueue {
  private active = 0;
  private readonly queue: Array<{
    task: TaskInput;
    resolve: (result: TaskResult) => void;
    reject: (err: Error) => void;
  }> = [];

  constructor(
    private readonly maxConcurrent: number = 4,
    private readonly executeTask: (input: TaskInput, deps: OrchestratorDeps) => Promise<TaskResult>,
    private readonly deps: OrchestratorDeps,
  ) {}

  async submit(task: TaskInput): Promise<TaskResult> {
    return new Promise((resolve, reject) => {
      this.queue.push({ task, resolve, reject });
      this.drain();
    });
  }

  async submitBatch(tasks: TaskInput[]): Promise<TaskResult[]> {
    return Promise.all(tasks.map(t => this.submit(t)));
  }

  private drain(): void {
    while (this.active < this.maxConcurrent && this.queue.length > 0) {
      const item = this.queue.shift()!;
      this.active++;
      this.executeTask(item.task, this.deps)
        .then(item.resolve)
        .catch(item.reject)
        .finally(() => {
          this.active--;
          this.drain();
        });
    }
  }

  get pending(): number { return this.queue.length; }
  get running(): number { return this.active; }
}
```

**Integration — minimal change to core-loop.ts:**

```typescript
// Export existing executeTask unchanged
export async function executeTask(input: TaskInput, deps: OrchestratorDeps): Promise<TaskResult> {
  // ... existing 6-step core loop (100% unchanged)
}

// NEW: convenience wrapper for concurrent dispatch
export function createTaskQueue(deps: OrchestratorDeps, maxConcurrent = 4): TaskQueue {
  return new TaskQueue(maxConcurrent, executeTask, deps);
}
```

**Files:**

| File | Change | Risk |
|------|--------|------|
| `src/orchestrator/task-queue.ts` | NEW — bounded queue with semaphore | Low — pure additive |
| `src/orchestrator/core-loop.ts` | Export `createTaskQueue()` factory | Trivial |
| `src/cli/serve.ts` or API layer | Use TaskQueue instead of direct executeTask | Medium |

**What is NOT built:** File-level advisory locks for cross-task write conflicts — deferred until real concurrent write conflicts are observed.

### 4.4 K2.3 — A2A Activation

**Problem (B3):** A2AManager exists (4 transports, 28 test files) but is default-disabled and has no cross-instance integration test.

**What already exists:**
- `A2AManager` wired in `serve.ts` L29 when `network.instances.enabled = true`
- 4 transport types (Stdio, HTTP, WS, A2A)
- A2A bridge, trust, gossip, negotiation — all unit tested

**Design — minimal activation:**

| Step | Change | Detail |
|------|--------|--------|
| 1 | Config default | `src/config/schema.ts` — add `network.instances.enabled` default to `false` with clear docs on how to enable (NOT auto-enable — A2A requires explicit opt-in for security) |
| 2 | Integration test | `tests/integration/a2a-delegation.test.ts` — spawn 2 server instances in-process, delegate task from A → B, verify result returned |
| 3 | ECP validation | A2A messages pass through K1.4 ECP validation middleware before processing |

**Why NOT default ON:** A2A opens a network listener. Defaulting to ON violates A6 (zero-trust) — explicit opt-in is the correct security posture.

**Files:**

| File | Change | Risk |
|------|--------|------|
| `tests/integration/a2a-delegation.test.ts` | NEW — E2E cross-instance test | Medium |
| `src/config/schema.ts` | Document A2A activation path | Low |

---

## 5. What Remains Aspirational (Beyond K1+K2)

Items ที่ architecture doc กล่าวถึงแต่ยังไม่ practical ในปัจจุบัน:

| Item | Why Aspirational | Prerequisite |
|------|-----------------|--------------|
| **Market Auction** (bid/collateral/dynamic pricing) | <10 agents; no adversarial competition | ≥10+ heterogeneous agents competing |
| **Formal Proof Oracle (Lean4)** | Research-grade integration; no Lean4 runtime | Lean4 LSP bridge + proof format |
| **Federation** (shared trust across instances) | A2A single-peer ยังไม่ proven | Working A2A E2E test |
| **Self-Evolving OS** | Evolution engine data-gated (needs ≥100 traces) | Production deployment with sufficient run data |
| **EU AI Act Certification** | Audit trail exists แต่ compliance ต้อง formal assessment | External auditor + regulatory guidance |
| **Third-party agents via ECP** | ECP v2 spec not finalized | Stable ECP protocol + SDK |
| **Human-in-loop at L3** | No human bridge interface | A2A human transport or CLI integration |

**Honest timeline:** K1 = 5 weeks (realistic), K2 simplified = 4-6 weeks (after K1), Aspirational items = 2027+ depending on adoption and evidence.

---

## 6. Verification Strategy

| Deliverable | Verification |
|-------------|-------------|
| K1.5 Guardrails | Unit tests: clean → pass, injected → reject; integration: EventBus event emitted |
| K1.1 Escalation | Unit tests: contradiction at L1 → L2 escalation; L3 → terminal failure |
| K1.2 Contract | Unit tests: contract creation from routing; `fromContract()` matches `fromRouting()` |
| K1.3 Tool Auth | Unit tests: L0 agent denied write; L2 agent allowed; unknown tool denied |
| K1.4 ECP | Unit tests: missing ecp_version → normalized; invalid confidence → error |
| K2.1 Priority Router | Unit tests: select by trust; filter by capability; tie-break by experience |
| K2.2 Task Queue | Unit tests: bounded concurrency; drain order; batch submit |
| K2.3 A2A | Integration test: 2 instances delegate task E2E |
| **Full K1+K2** | `bun run test` + `bun run check` (0 errors) |

---

## 7. File Inventory (All Changes)

### New Files

| File | Purpose | Size Estimate |
|------|---------|---------------|
| `src/core/agent-contract.ts` | Contract type + Zod schema + factory | ~120 lines |
| `src/security/tool-authorization.ts` | Tool→capability mapping + auth check | ~100 lines |
| `src/a2a/ecp-validation.ts` | ECP message validation middleware | ~60 lines |
| `src/orchestrator/priority-router.ts` | Trust-weighted provider selection (K2) | ~80 lines |
| `src/db/provider-trust-store.ts` | SQLite trust score persistence (K2) | ~60 lines |
| `src/orchestrator/task-queue.ts` | Bounded concurrent task dispatcher (K2) | ~70 lines |
| `tests/integration/a2a-delegation.test.ts` | Cross-instance E2E test (K2) | ~80 lines |

### Modified Files

| File | Change | Lines Changed |
|------|--------|---------------|
| `src/guardrails/index.ts` | Add `GuardrailResult` + `validateInput()` | ~30 lines added |
| `src/orchestrator/perception.ts` | Use `validateInput()` instead of `sanitizeForPrompt()` | ~10 lines |
| `src/orchestrator/core-loop.ts` | Contradiction → auto-escalation; export `createTaskQueue()`; learn phase records trust | ~40 lines |
| `src/orchestrator/worker/agent-budget.ts` | Add `fromContract()` | ~15 lines |
| `src/orchestrator/worker/worker-pool.ts` | Create contract at dispatch | ~10 lines |
| `src/oracle/runner.ts` | Validate ECP verdict envelope | ~10 lines |
| `src/core/types.ts` | Event types for contradiction + security | ~15 lines |
| `src/bus/audit-listener.ts` | Subscribe to new events | ~15 lines |

**Total net new code:** ~750 lines (K1: ~400 + K2: ~350)
**Risk level:** Low-Medium — extends existing patterns, no architectural rewrites

---

## 8. Implementation Order (K1 + K2)

```
Phase A (Week 1-2): Security Foundation — K1
  ├─ K1.5: Guardrails block-not-strip     ← CRITICAL, no dependency
  └─ K1.4: ECP validation middleware       ← Independent, low risk

Phase B (Week 3-4): Contract System — K1
  ├─ K1.2: Agent Contract types + factory
  ├─ K1.3: Tool authorization (depends on K1.2)
  └─ Wire: contract → budget → tool auth

Phase C (Week 5): Contradiction Wiring — K1
  └─ K1.1: Contradiction escalation in core-loop

--- K1 Gate: all tests pass, 0 type errors ---

Phase D (Week 6-7): Multi-Agent Foundation — K2
  ├─ K2.1: Priority Router + provider trust store
  └─ K2.2: Task Queue + concurrent dispatch

Phase E (Week 8-9): Cross-Instance — K2
  └─ K2.3: A2A activation + E2E integration test

--- K2 Gate: concurrent tasks proven, A2A proven ---
```

---

## 9. Decision Log

| # | Decision | Rationale |
|---|----------|-----------|
| D0 | Reframe identity: "orchestration kernel" not "OS" | Vinyan ไม่ schedule CPU processes; OS analogy useful for capability model, misleading for scope |
| D0.1 | Drop "AGI Economy" from practical scope | <10 agents; no adversarial market; trust-weighted routing เพียงพอ |
| D-K1.1 | Defer ConflictReport as ECP message type | ต้อง modify ECP protocol spec across packages — too broad for K1 |
| D-K1.2 | Defer human escalation at L3 contradiction | ไม่มี human-in-loop interface; log + fail เพียงพอสำหรับ K1 |
| D-K1.3 | Simplify capability tokens → static RBAC per contract level | Single-use dynamic tokens ไม่จำเป็นสำหรับ single-agent; extend เมื่อ K2 Market |
| D-K1.4 | Defer mandatory `evidence_chain` enforcement | ยังไม่มี oracle ที่ produce evidence chains; enforce เฉพาะ `confidence` + `ecp_version` |
| D-K1.5 | Keep `sanitizeForPrompt()` as deprecated | Backward compat — external callers อาจใช้อยู่ |
| D-K2.1 | Replace Market Scheduler with Priority Router | Auction requires ≥2 competing bidders; priority routing covers single-digit agent count |
| D-K2.2 | Task Queue wraps existing executeTask() | Least-invasive approach: no core-loop refactor, just bounded semaphore |
| D-K2.3 | A2A explicit opt-in (not default ON) | Network listener requires conscious security decision; A6 compliance |
| D-K2.4 | Defer MCP Client | MCP server exists; client needs tool registry design ที่ยังไม่มี spec |
| D-K2.5 | Defer market integrity mechanisms | No market → no gaming → no anti-gaming needed |
