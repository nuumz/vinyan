# Phase 6 — Agentic Worker Protocol: Implementation Plan

> Status: **READY TO START**
> **Authoritative document:** This file. Implement from here — not from AWP.
> Design reference: [`agentic-worker-protocol.md`](./agentic-worker-protocol.md) (v5) — background/rationale only
> Prerequisite: Phases 0–5 complete (`bun run test:all` passing)
> Branch convention: `feature/phase6-{phase-name}`

---

## Document Authority

**This implementation plan is the authoritative working document.** Implement from the specs here.

[`agentic-worker-protocol.md`](./agentic-worker-protocol.md) (AWP) is background and rationale — read it to understand *why* something is designed the way it is, not *what* to implement. The AWP was updated incrementally across v1→v5 and contains resolved decisions that this plan already incorporates.

### What to use from AWP (safe to cross-reference)

| AWP Section | Status | Use for |
|-------------|--------|---------|
| §4 Protocol Wire Format (ndjson turns) | ✅ Stable | Understanding turn structure |
| §7.2 WorkerTurn / OrchestratorTurn schemas | ✅ Stable (v5) | Reference for Zod schema names |
| §8.1 AgentSession interface + state machine | ✅ Stable (v5 adds `drainAndClose`) | Interface design |
| §8.2 AgentBudget + 3-pool model | ✅ Stable (v5 adds `extensionRequestCount`, `contextWindow`) | Budget logic |
| §8.5 Two-tier compression + landmark rules | ✅ Stable | Compression algorithm |
| §8.6 shell_exec read-only whitelist | ✅ Stable | Security constraints |
| §8.9 PerceptionCompressor priority table | ✅ Stable | Truncation priority |
| §10.1 Provider format mapping table | ✅ Stable | Anthropic vs OpenAI wire differences |
| §11 DelegationRouter R1–R6 | ✅ Stable | Delegation rules |

### Do not use from AWP

| AWP Section | Why |
|-------------|-----|
| §8.3 AgentLoop pseudocode | Fixed in this plan (see critical fixes below) |
| §8.4 DelegationRouter budget calc | `budget.tokensRemaining` is undefined — use `delegationRemaining` (fix #6 below) |
| §8.8 AgentSessionSummary ownership | Ownership clarified to core-loop.ts — use Phase 6.3 spec |
| §11 Capability Matrix | Delegation was L3-only; corrected to L2+ (fix #8 below) |
| §13 Sequence diagrams | Replaced by Data Flow Diagrams in this plan |

### Critical fixes incorporated in this plan

All bugs below were found in AWP during review. They are **already corrected here** — do not re-import the wrong version from AWP.

1. **`session.close('completed')` → `session.drainAndClose()`** — `'completed'` is not a valid `TerminateReason`. After worker sends `done`/`uncertain`, skip terminate turn and just drain stdin.
2. **Budget tracking** — use `turn.tokensConsumed` when present; fall back to `estimateTokens(turn)` only when absent.
3. **Compressed history block role** — MUST be `role: 'user'`, not `'assistant'`. Consecutive assistant messages cause API 400 errors.
4. **ToolExecutor/built-in-tools.ts is MODIFY, not unchanged** — must add overlay-aware CoW routing for all file ops + `guardrails.scan()` on tool results before returning to worker (A6). See Phase 6.1.
5. **AgentLoop missing `PerceptionCompressor.compress()`** — must compress perception before building the init turn in `runAgentLoop`. Without this, large perceptions overflow context on first call. See Phase 6.3.
6. **DelegationRouter budget calc** — AWP §8.4 uses `budget.tokensRemaining * 0.5` but `tokensRemaining` is an undefined field. Correct formula: `(budget.delegation - budget.delegationConsumed) * 0.5`. See Phase 6.4.
7. **`handleDelegation` budget lifecycle** — AWP pseudocode referenced `decision.childBudget` which doesn't exist on `DelegationDecision`. Correct flow: `budget.deriveChildBudget(decision.allocatedTokens)` → pass budget to `buildSubTaskInput` → `budget.returnUnusedDelegation(reserved, actual)` after child returns. See Phase 6.3.
8. **Delegation available at L2+, not L3-only** — `manifestFor()` must include `delegate_task` at L2 and above. Restricting to L3 makes delegation inaccessible in the common analytical tier.

---

## Overview

Phase 6 transforms Vinyan workers from **single-shot LLM calls** into **agentic loops** that can use tools, read results, and delegate sub-tasks — while keeping all governance (routing, verification, commit) deterministic and rule-based (A3).

```
Single-shot (current):  Orchestrator → Worker[one LLM call] → JSON response → Oracle
Agentic (Phase 6):      Orchestrator ⇄ Worker[tool loop] ⇄ tools ⇄ Oracle (on final diff)
```

**Phases at a glance:**

| Phase | Name | What it unlocks | Migration steps |
|-------|------|-----------------|-----------------|
| 6.0 | Protocol Foundation | Types, schemas, provider messages[] | 1–8 |
| 6.1 | Infrastructure | Session, budget, overlay, compressor | 9–18 |
| 6.2 | Worker Entry | New subprocess with tool loop | 19–22 |
| 6.3 | Agent Loop | Orchestrator-side loop, wires it all | 20, 23–27 |
| 6.4 | Delegation | Worker-to-worker task delegation | 28–37 |
| 6.5 | Hardening | Observability, cleanup, concurrency | 38–45 |

Each phase has clean exit criteria — do not start the next phase until the current one passes.

---

## Capability Matrix

Tool availability by routing level. **`manifestFor(routing)`** returns this set.

| Level | LLM path | File tools | Shell | Delegation | Control tools |
|-------|----------|------------|-------|------------|---------------|
| **L0** | None — `worker-entry.ts` single-shot; returns JSON directly, no tool loop | None | None | None | None |
| **L1** | Heuristic; `agent-worker-entry.ts` tool loop | `file_read`, `directory_list`, `search_grep`, `search_semantic`, `git_status`, `git_diff` | Read-only whitelist only (`grep`,`find`,`cat`,`head`,`tail`,`ls`,`git log/diff/status/show/blame`) | None | `attempt_completion`, `request_budget_extension` |
| **L2** | Analytical | L1 + `file_write`, `file_edit`, `file_delete` | L1 shell + `http_get` | `delegate_task` (depth ≤ 1) | L1 tools |
| **L3** | Deliberative | L2 (overlay mounted as container root fs) | Full shell inside Docker container | `delegate_task` (depth ≤ 2) | L1 tools |

**Key rule (fix #8):** `delegate_task` is available at L2+. It was L3-only in AWP §11 — this was too restrictive.

**L0 clarification:** L0 uses the existing `worker-entry.ts` path unchanged. It receives a `WorkerInput`, makes one LLM call, and writes a `WorkerOutput`. No `AgentSession`, no `AgentBudget`, no overlay.

```typescript
// manifestFor() implementation
function manifestFor(routing: RoutingDecision): ToolDescriptor[] {
  const base = [file_read, directory_list, search_grep, search_semantic,
                git_status, git_diff, attempt_completion, request_budget_extension]
  if (routing.level < 1) return []
  if (routing.level === 1) return base
  const analytical = [...base, file_write, file_edit, file_delete, shell_exec, http_get, delegate_task]
  return analytical  // L2 and L3
}
```

---

## Tool Formal Descriptors

Three control tools added in Phase 6.0. All must have `descriptor()` returning the schema below so the LLM knows how to call them.

### `attempt_completion`

```typescript
{
  name: 'attempt_completion',
  description: 'Signal task completion or inability to complete. MUST be called to end every session — do not emit plain text to indicate done/uncertain.',
  inputSchema: {
    type: 'object',
    properties: {
      status:           { type: 'string', enum: ['done', 'uncertain'],
                          description: "Use 'done' when the task is complete. Use 'uncertain' when blocked." },
      summary:          { type: 'string', description: 'Brief summary of what was accomplished.' },
      uncertainties:    { type: 'array', items: { type: 'string' },
                          description: 'Reasons for uncertainty (required when status=uncertain).' },
      proposedContent:  { type: 'string', description: 'Non-file output (answer, analysis, etc.).' },
    },
    required: ['status'],
  },
  category: 'control',
  sideEffect: false,
  minRoutingLevel: 0,
}
```

### `request_budget_extension`

```typescript
{
  name: 'request_budget_extension',
  description: 'Request additional tokens from the negotiable budget pool. The orchestrator may grant up to 50% of remaining negotiable tokens per request. Maximum 3 requests per session.',
  inputSchema: {
    type: 'object',
    properties: {
      tokens: { type: 'number', description: 'Additional tokens requested (hint; actual grant may differ).' },
      reason: { type: 'string', description: 'Why more tokens are needed — what has been done and what remains.' },
    },
    required: ['tokens', 'reason'],
  },
  category: 'control',
  sideEffect: false,
  minRoutingLevel: 1,  // L0 has no budget negotiation (single-shot)
}
```

### `delegate_task`

```typescript
{
  name: 'delegate_task',
  description: 'Delegate a bounded sub-task to a child agentic worker. The child runs the full pipeline (perceive → generate → oracle verify → commit). Results returned as a DelegationOutcome. Constraints: targetFiles must be a subset of your own allowedPaths; shell_exec is never available to the child (R6).',
  inputSchema: {
    type: 'object',
    properties: {
      goal: {
        type: 'string',
        description: 'Clear, bounded, verifiable goal for the child worker.',
      },
      targetFiles: {
        type: 'array',
        items: { type: 'string' },
        description: 'Files the child may read/write. Must be a strict subset of parent allowedPaths.',
      },
      requiredTools: {
        type: 'array',
        items: { type: 'string' },
        description: "Tools the child needs. 'shell_exec' is prohibited (R6 — capability creep prevention).",
      },
      context: {
        type: 'string',
        description: 'Additional context the child worker should know before starting.',
      },
      requestedTokens: {
        type: 'number',
        description: 'Token budget hint. Actual allocation is capped by the parent delegation pool.',
      },
    },
    required: ['goal', 'targetFiles'],
  },
  category: 'delegation',
  sideEffect: true,   // spawns subprocess, may write files via overlay
  minRoutingLevel: 2, // L2+ only (fix #8)
}
```

---

## Data Flow Diagrams

### 13.1 — Complete Agentic Pipeline (L1+)

```
Task
 └─→ core-loop.ts: executeTask()
      ├─ ① Perceive:  PerceptualHierarchy built (dep-cone, World Graph, diagnostics)
      ├─ ② Predict:   SelfModel estimates confidence
      ├─ ③ Plan:      TaskDecomposer → TaskDAG (optional)
      └─ ④ Generate:  WorkerPool.dispatch()  [routing.level >= 1]
                       └─→ runAgentLoop(input, perception, memory, plan, routing, deps)
                            ├─ PerceptionCompressor.compress(perception, budget.contextWindow)
                            ├─ SessionOverlay.create(workspace, taskId)
                            ├─ AgentSession.start() ─────────────────────────────────────────┐
                            │   [spawns agent-worker-entry.ts subprocess]                    │
                            │                                           agent-worker-entry.ts │
                            │                                           ├─ receive init turn  │
                            │                                           ├─ compress perception│
                            │                                           ├─ build history[]    │
                            │                                           └─ LOOP:              │
                            │                                              ├─ LLM.generate()  │
                            │                                              ├─ [tool_calls]     │
                            │                                              │   writeTurn()     │
                            │                                              └─ [attempt_compl.] │
                            │                                                  writeTurn(done) │
                            │   ←──────────────────────────────────────────────────────────── │
                            └─ LOOP (orchestrator side):
                                ├─ AgentSession.receive(remainingMs)  → WorkerTurn
                                │
                                ├─ [type: 'tool_calls']:
                                │   ├─ calls.slice(0, maxToolCallsPerTurn)  ← cap
                                │   ├─ for each call: ToolExecutor.execute(call, toolContext)
                                │   │   ├─ file ops → SessionOverlay (CoW)
                                │   │   ├─ shell_exec → read-only whitelist check
                                │   │   └─ delegate_task → handleDelegation() ─────────────┐
                                │   │       ├─ DelegationRouter.canDelegate() (R1-R6)       │
                                │   │       ├─ childBudget = budget.deriveChildBudget()     │
                                │   │       ├─ subInput = buildSubTaskInput(..., childBudget)│
                                │   │       ├─ result = await deps.executeTask(subInput) ◄──┘ (recursion)
                                │   │       └─ budget.returnUnusedDelegation(reserved, actual)
                                │   ├─ guardrails.scan(result.output)  ← A6: scan before inject
                                │   └─ AgentSession.send(tool_results turn)
                                │
                                ├─ [type: 'done']:
                                │   ├─ mutations = overlay.computeDiff()
                                │   ├─ session.drainAndClose()         ← NOT session.close()
                                │   └─ return WorkerLoopResult { mutations, isUncertain: false }
                                │
                                ├─ [type: 'uncertain']:
                                │   ├─ partialMutations = overlay.computeDiff()
                                │   ├─ session.drainAndClose()
                                │   └─ return WorkerLoopResult { mutations: partial, isUncertain: true }
                                │
                                └─ [budget exceeded / timeout / null]:
                                    ├─ session.close('budget_exceeded' | 'timeout')
                                    └─ return WorkerLoopResult { isUncertain: true }
                            [finally: overlay.cleanup()]

      ├─ ⑤ Verify:   OracleGate.verify(mutations)   ← runs on overlay diff, not workspace
      │               [L1: AST+Type+Dep+Lint]  [L2: +tests]  [L3: +shadow]
      │               [PASS] → commitArtifacts()
      │               [FAIL] → see 13.3 Retry Flow
      ├─ ⑥ Learn:    TraceCollector.record(transcript, predictionError)
      └─ World Graph update + Shadow Job persist
```

### 13.2 — Single-Shot Path (L0)

```
Task (routing.level = 0)
 └─→ core-loop.ts: executeTask()
      ├─ ① Perceive:  (lightweight — hash only)
      └─ ④ Generate:  WorkerPool.dispatch()  [L0 path]
                       └─→ emptyOutput(taskId)  ← no LLM, no tokens
      ├─ ⑤ Verify:   OracleGate.verify([])  ← hash-only check
      └─ ⑥ Learn:    TraceCollector (minimal)

NOTE: L0 does NOT use runAgentLoop, AgentSession, AgentBudget, or SessionOverlay.
     worker-entry.ts (existing, single-shot LLM call) remains untouched for L0.
```

### 13.3 — Retry & Escalation Flow

```
Attempt N result arrives at core-loop.ts
  │
  ├─ [WorkerLoopResult.isUncertain = true  OR  OracleGate verdict = FAIL]:
  │   ├─ summary = buildAgentSessionSummary(loopResult)  ← core-loop.ts owns this, not AgentLoop
  │   ├─ workingMemory.priorAttempts.push(summary)       ← injected into next attempt's init turn
  │   ├─ Escalate: routing.level++  (L1 → L2 → L3)
  │   │   [if already L3: no further escalation]
  │   └─ Attempt N+1: runAgentLoop with stronger model + deeper oracle + priorAttempts context
  │
  ├─ [max retries reached]:
  │   └─ TaskResult { status: 'failed', reason: lastUncertainties }
  │
  └─ [oracle PASS]:
      ├─ commitArtifacts()
      ├─ World Graph update (A4: SHA-256 rebind)
      └─ TaskResult { status: 'success' }

AgentSessionSummary (~150 tokens) injected as:
  workingMemory.priorAttempts: AgentSessionSummary[]
  → Visible to next attempt's LLM in the init turn's user message
  → NOT a system prompt injection — goes in user context block
```

---

## Phase 6.0 — Protocol Foundation

**Objective**: Add all new types and schemas. Extend LLM providers to support multi-turn `messages[]`. No behavior change — existing single-shot workers untouched.

### Files to create

**`src/orchestrator/llm/provider-format.ts`** ← *largest task in this phase*

Implements `normalizeMessages(messages: HistoryMessage[], provider: 'anthropic' | 'openai-compat')`.

Anthropic format:
- `assistant` turn with `toolCalls[]` → `content: [{ type: 'tool_use', id, name, input }]`
- `tool_result` turn → `role: 'user'`, `content: [{ type: 'tool_result', tool_use_id, content, is_error }]`
- Multiple tool results in one batch → single `user` message with multiple `tool_result` blocks
- `thinking` string → prepend `{ type: 'thinking', thinking }` before `{ type: 'text' }` block

OpenAI-compat format:
- `assistant` turn with `toolCalls[]` → `tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(input) } }]`
- `tool_result` turn → separate `{ role: 'tool', tool_call_id, content }` message per result
- `thinking` → discard (not supported)

```typescript
export type ProviderFamily = 'anthropic' | 'openai-compat'

export function normalizeMessages(
  messages: HistoryMessage[],
  family: ProviderFamily,
): AnthropicMessage[] | OpenAIMessage[]

// Test: normalizeMessages with 2 tool calls + 2 results → correct Anthropic content blocks
// Test: same input → correct OpenAI tool role messages
// Test: tool_call_id in result correctly references original assistant call id
// Test: multiple tool_results batched into single Anthropic user message
```

### Files to modify

**`src/orchestrator/types.ts`**

Add these types (do not remove existing `LLMRequest`/`LLMResponse`):

```typescript
// Multi-turn message history
interface Message {
  role: 'system' | 'user' | 'assistant'
  content: string
  toolCalls?: ToolCall[]    // present when role='assistant' and model issued tool calls
}

interface ToolResultMessage {
  role: 'tool_result'       // canonical — normalized by provider-format.ts at call time
  toolCallId: string        // must match ToolCall.id from preceding assistant message
  content: string
  isError?: boolean
}

type HistoryMessage = Message | ToolResultMessage

// Extend LLMResponse — add optional fields (backward compatible)
interface LLMResponse {
  content: string
  thinking?: string          // Anthropic extended thinking block
  toolCalls: ToolCall[]
  tokensUsed: { input: number; output: number }
  stopReason: 'end_turn' | 'tool_use' | 'max_tokens'
}

// Retry context — built by core-loop.ts, injected into next attempt's WorkingMemory
interface AgentSessionSummary {
  sessionId: string
  attempt: number
  outcome: 'uncertain' | 'max_tokens' | 'timeout' | 'oracle_failed'
  filesRead: string[]
  filesWritten: string[]
  turnsCompleted: number
  tokensConsumed: number
  failurePoint: string
  lastIntent: string
  uncertainties: string[]
  suggestedNextStep?: string
}

// Extend WorkingMemoryState (add optional field — backward compatible)
// priorAttempts?: AgentSessionSummary[]
```

**`src/orchestrator/protocol.ts`**

Add Zod schemas for new protocol types:
- `AgentBudgetSchema` (all fields from AWP §8.2 including `contextWindow`, `maxExtensionRequests`)
- `OrchestratorTurnSchema` (union of exactly **3 types**: `init | tool_results | terminate`)
  > **No `delegation_result` type.** Delegation results are `ToolResult` entries inside a regular `tool_results` turn — not a separate turn type. The `handleDelegation()` function returns a `ToolResult` which is bundled with any other tool results from the same `tool_calls` turn and sent back as one `tool_results` turn. AWP §7.1 defines the 3-type union as authoritative.
- `WorkerTurnSchema` (union of `tool_calls | done | uncertain`) — `tool_calls` includes optional `tokensConsumed`
- `DelegationRequestSchema`

**`src/orchestrator/tools/tool-interface.ts`**

```typescript
// Add to ToolCategory union
type ToolCategory = 'file' | 'shell' | 'search' | 'vcs' | 'delegation' | 'control'

// Extend ToolContext (backward compatible — new fields optional)
interface ToolContext {
  routingLevel: RoutingLevel
  allowedPaths: string[]
  workspace: string
  overlayDir?: string                                            // present for L1+ agentic sessions
  onDelegate?: (req: DelegationRequest) => Promise<ToolResult>  // injected at L2+
}

// New: ToolDescriptor (formal schema for LLM consumption)
interface ToolDescriptor {
  name: string
  description: string
  inputSchema: {
    type: 'object'
    properties: Record<string, { type: string; description: string; enum?: string[] }>
    required: string[]
  }
  category: ToolCategory
  sideEffect: boolean
  minRoutingLevel: RoutingLevel
}

// Add to Tool interface
interface Tool {
  // ...existing fields
  descriptor(): ToolDescriptor
}
```

**`src/orchestrator/tools/built-in-tools.ts`**

- Add `descriptor()` to all existing tools
- Add `attempt_completion` tool — see "Tool Formal Descriptors" section above
- Add `request_budget_extension` tool — see "Tool Formal Descriptors" section above
- Add `delegate_task` descriptor stub — handler is a pass-through to `context.onDelegate`; full wiring in Phase 6.4 (step 28)

**`src/orchestrator/llm/openrouter-provider.ts`** and **`src/orchestrator/llm/anthropic-provider.ts`**

- If `request.messages` is present: call `normalizeMessages(request.messages, family)` and use multi-turn path
- If only `request.systemPrompt`/`userPrompt`: existing single-turn path unchanged (backward compat)
- Extract `thinking` from Anthropic response content blocks (if present)
- Return `LLMResponse.thinking` populated; return `stopReason` field

### `manifestFor(routing)` utility

Add to `built-in-tools.ts` or a new `tool-manifest.ts`. **Important: delegate_task at L2+, not L3-only (fix #8).**

```typescript
function manifestFor(routing: RoutingDecision): ToolDescriptor[] {
  if (routing.level === 0) return []   // L0: single-shot, no tools
  const base = [
    file_read, directory_list, search_grep, search_semantic,
    git_status, git_diff,
    attempt_completion, request_budget_extension,
  ]
  if (routing.level === 1) return base
  // L2+: mutation tools + shell + delegation
  return [...base, file_write, file_edit, file_delete, shell_exec, http_get, delegate_task]
}
```

### Exit criteria

```bash
bun run check          # tsc + biome — zero errors
bun run test           # all existing unit tests still pass
```

Manual verification:
- `WorkerTurnSchema.parse({ type: 'tool_calls', turnId: 't0', calls: [], rationale: '', tokensConsumed: 100 })` — passes
- `normalizeMessages([assistant+toolCalls, toolResult], 'anthropic')` — produces correct Anthropic content blocks with matching tool_use_id
- `normalizeMessages(same, 'openai-compat')` — produces correct role:'tool' messages

---

## Phase 6.1 — Infrastructure

**Objective**: Build the core infrastructure components. No new behavior visible to users — these are the plumbing layers tested in isolation.

### Files to create

**`src/orchestrator/worker/agent-session.ts`**

```typescript
type SessionState = 'INIT' | 'WAITING_FOR_WORKER' | 'WAITING_FOR_ORCHESTRATOR' | 'CLOSED'
type TerminateReason = 'budget_exceeded' | 'timeout' | 'parent_done' | 'error'

class AgentSession implements IAgentSession {
  private state: SessionState = 'INIT'
  private proc: BunSubprocess

  async send(turn: OrchestratorTurn): Promise<void>
  // Guards: state must be INIT or WAITING_FOR_ORCHESTRATOR; throw otherwise
  // Writes JSON.stringify(turn) + '\n' to proc.stdin
  // Transitions → WAITING_FOR_WORKER

  async receive(timeoutMs: number): Promise<WorkerTurn | null>
  // Guards: state must be WAITING_FOR_WORKER; throw otherwise
  // Promise.race([readline, setTimeout(timeoutMs)])
  // Zod-validates line; invalid JSON or timeout → null
  // Transitions → WAITING_FOR_ORCHESTRATOR

  async close(reason: TerminateReason): Promise<void>
  // 1. Write terminate turn to proc.stdin + end stdin
  // 2. await proc.exited with 2s timeout
  // 3. proc.kill('SIGKILL') if still running
  // 4. Drain remaining stdout/stderr to audit log
  // 5. State → CLOSED (idempotent — safe to call twice)

  async drainAndClose(): Promise<void>
  // Worker already done (sent done/uncertain) — no terminate turn needed
  // 1. proc.stdin.end()
  // 2. await proc.exited with 2s timeout
  // 3. proc.kill('SIGKILL') if still running
  // 4. Drain stdout/stderr
  // 5. State → CLOSED (idempotent)

  get sessionState(): SessionState
  get pid(): number
}

export interface IAgentSession {
  send(turn: OrchestratorTurn): Promise<void>
  receive(timeoutMs: number): Promise<WorkerTurn | null>
  close(reason: TerminateReason): Promise<void>
  drainAndClose(): Promise<void>
  readonly sessionState: SessionState
}
```

Key detail: `receive()` must use `Promise.race` — not bare readline await. Caller passes `budget.remainingMs()` so timeout tracks the session budget.

**`src/orchestrator/worker/agent-budget.ts`**

```typescript
class AgentBudgetTracker {
  private budget: AgentBudget
  private extensionRequestCount = 0

  static fromRouting(routing: RoutingDecision, contextWindow: number): AgentBudgetTracker

  canContinue(): boolean      // checks turnsUsed < maxTurns, tokens remaining, duration
  canDelegate(): boolean      // checks delegationDepth < maxDelegationDepth

  recordTurn(tokensConsumed: number): void
  // tokensConsumed = turn.tokensConsumed if present, else estimateTokens(turn) (fix #2)

  requestExtension(tokens: number): { granted: number; remaining: number }
  // Guard: extensionRequestCount >= maxExtensionRequests (default 3) → return { granted: 0 }
  // Grant: min(tokens, (budget.negotiable - budget.negotiableGranted) * 0.5)
  // Increment extensionRequestCount

  deriveChildBudget(requestedTokens?: number): AgentBudget
  // Allocates from delegation pool: min(requestedTokens ?? default, delegationRemaining * 0.5)
  // (fix #6: use delegationRemaining = budget.delegation - budget.delegationConsumed)
  // Eagerly deducts from delegationConsumed

  returnUnusedDelegation(reserved: number, actual: number): void
  // Refunds (reserved - actual) back to delegationConsumed
  // Called after child task completes — see fix #7

  remainingMs(): number
  toSnapshot(): AgentBudget    // serializable — for IPC init turn
}
```

**`src/orchestrator/worker/session-overlay.ts`**

```typescript
class SessionOverlay {
  readonly dir: string          // workspace/.vinyan/sessions/{taskId}/overlay/

  static create(workspace: string, taskId: string): SessionOverlay
  // mkdir -p overlay dir; validate taskId matches /^[a-zA-Z0-9_-]+$/

  // CoW reads: check overlay first, then fall through to workspace
  readFile(relPath: string): string | null
  listDir(relPath: string): string[]   // merge overlay + workspace entries; hide tombstones

  // Writes always go to overlay
  writeFile(relPath: string, content: string, baseContentHash: string): void
  // Stores baseContentHash for OCC check at commit time

  deleteFile(relPath: string): void
  // Creates overlay/{relPath}/.wh tombstone

  // Compute mutations (overlay diff vs real workspace)
  computeDiff(): ProposedMutation[]
  // For each non-tombstone file in overlay:
  //   original = workspace file content (or '' if new)
  //   mutation = { file, content, diff: createUnifiedDiff(original, overlayContent), explanation }
  // For each tombstone: emit deletion mutation

  // OCC-safe commit
  async commit(workspace: string): Promise<{ committed: string[]; conflicts: string[] }>
  // Re-check: sha256(workspace[file]) === baseContentHash at commit time
  // Hash mismatch → add to conflicts list (do not commit that file)
  // Committed files → write through to workspace

  cleanup(): void   // rmSync overlay dir, recursive, force — MUST be in finally
}
```

**`src/orchestrator/llm/perception-compressor.ts`**

```typescript
function compressPerception(
  perception: PerceptualHierarchy,
  contextWindow: number,
): PerceptualHierarchy
// Target: compressed result renders to ≤ contextWindow * 0.30 tokens
// Token estimate: chars / 3.5 (conservative — code is token-dense)
// Priority order (highest first — discard lowest-priority first):
//   1. World Graph facts for target files — never truncate
//   2. directImportees of target files — never truncate
//   3. Type/lint errors on target files — keep top 10 by proximity
//   4. dependencyCone.directImporters — keep top 20 by import count
//   5. verifiedFacts (non-target) — keep top 10 by confidence
//   6. transitiveImporters — replace with count only
//   7. Non-error warnings — replace with count only
```

### Files to modify (MODIFY — not unchanged)

**`src/orchestrator/tools/built-in-tools.ts`** ← **MODIFY** (fix #4)

This file requires three distinct changes. Do not skip any — all three are required for A6 compliance.

**Change A: Overlay-aware CoW routing for all file operations**

For `file_read`, `file_write`, `file_edit`, `file_delete`, `directory_list`:
- Check `context.overlayDir !== undefined` (agentic mode signal)
- If present: route ALL reads and writes through `SessionOverlay` (CoW semantics)
- `file_read` → `overlay.readFile(relPath)` (overlay-first, workspace fallback)
- `file_write` / `file_edit` → `overlay.writeFile(relPath, content, baseHash)`
- `file_delete` → `overlay.deleteFile(relPath)` (tombstone)
- `directory_list` → `overlay.listDir(relPath)` (merged view)
- If `overlayDir` absent: existing behavior unchanged

**Change B: shell_exec read-only whitelist enforcement (L1/L2 agentic mode)**

```typescript
// In shell_exec execute():
if (context.overlayDir !== undefined) {
  // Agentic session — enforce read-only whitelist
  const ALLOWED_COMMANDS = ['grep', 'find', 'cat', 'head', 'tail', 'ls',
                             'git log', 'git diff', 'git status', 'git show', 'git blame']
  const cmd = input.command.trim()
  const allowed = ALLOWED_COMMANDS.some(prefix => cmd === prefix || cmd.startsWith(prefix + ' '))
  if (!allowed) {
    return { status: 'error', output: `[BLOCKED] Command not in read-only whitelist. Allowed: ${ALLOWED_COMMANDS.join(', ')}` }
  }
}
// L3 container: no whitelist check (Docker provides isolation)
```

**Change C: guardrails.scan() on all tool results before returning to worker (A6)**

```typescript
// In ToolExecutor.execute() or each tool's execute() method, after getting result:
const scanResult = deps.guardrails.scan(result.output)
if (scanResult.blocked) {
  result = { ...result, output: '[CONTENT BLOCKED: potential prompt injection detected]' }
}
// Then return result to be injected into WorkerTurn history
```

Note: `guardrails` must be injected into the ToolExecutor (not accessed globally). Add `guardrails: GuardrailsEngine` to `ToolExecutorConfig`.

**`src/orchestrator/tools/tool-interface.ts`**

Wire the runtime overlay path: `overlayDir?: string` and `onDelegate?` are now used, not just declared. Pass `overlay.dir` when constructing `ToolContext` inside `runAgentLoop`.

### Unit tests

```
tests/orchestrator/agent-session.test.ts
  - state transitions: INIT → send → WAITING_FOR_WORKER → receive → WAITING_FOR_ORCHESTRATOR
  - send() in wrong state throws
  - receive() timeout returns null
  - close() is idempotent (second call is no-op)
  - drainAndClose() vs close(): drainAndClose does NOT send terminate turn

tests/orchestrator/agent-budget.test.ts
  - 3-pool: base + negotiable + delegation sum is consistent
  - requestExtension: 50% cap per request, maxExtensionRequests=3 hard stop → 4th returns 0
  - deriveChildBudget: uses delegationRemaining * 0.5 formula (fix #6)
  - returnUnusedDelegation: correct refund amount
  - canContinue() false when turns exhausted

tests/orchestrator/session-overlay.test.ts
  - writeFile then readFile returns overlay content
  - readFile falls through to workspace when not in overlay
  - deleteFile creates tombstone; listDir hides it
  - computeDiff: addition, modification, deletion mutations
  - OCC: commit rejects file when baseContentHash differs; commits others
  - cleanup removes directory

tests/orchestrator/perception-compressor.test.ts
  - large perception → compressed to ≤ 30% context budget
  - target file facts preserved at full fidelity
  - transitiveImporters replaced with count only
  - priority: errors preserved when non-error warnings dropped
```

### Exit criteria

```bash
bun run test tests/orchestrator/agent-session.test.ts
bun run test tests/orchestrator/agent-budget.test.ts
bun run test tests/orchestrator/session-overlay.test.ts
bun run test tests/orchestrator/perception-compressor.test.ts
bun run check
```

---

## Phase 6.2 — Agent Worker Entry

**Objective**: New subprocess entry point (`agent-worker-entry.ts`) for L1+ agentic sessions. Old `worker-entry.ts` untouched.

### Files to create

**`src/orchestrator/worker/agent-worker-entry.ts`**

Core loop:

```
1. Read init OrchestratorTurn from stdin (ndjson line)
2. Run compressPerception(perception, budget.contextWindow)
3. Build initial history: [system, user(task + compressed_perception + priorAttempts)]
4. LOOP (max budget.maxTurns):
   a. Proactive compression: if estimateHistoryTokens(history) > budget.contextWindow * 0.75
      → compressHistory(history); compressionAttempts++
   b. provider.generate({ messages: normalizeMessages(history, family), tools: manifest, maxTokens })
   c. Append assistant response to history
   d. if stopReason === 'max_tokens':
      → reactive compression (up to 2 total attempts); if still maxTokens → writeTurn(uncertain)
   e. if stopReason === 'tool_use':
      → separate attempt_completion call from regularCalls
      → if regularCalls: writeTurn({ type: 'tool_calls', calls, tokensConsumed }), await tool_results turn on stdin, append to history
      → if attempt_completion: writeTurn({ type: 'done'|'uncertain', ... }), break
   f. if stopReason === 'end_turn' (no attempt_completion — fallback):
      → writeTurn({ type: 'done', proposedContent: response.content }), break
5. process.exit(0)
```

`compressHistory(history)` algorithm:
- Keep: `[0]` system, `[1]` init user — verbatim always
- Classify middle turns as LANDMARK (error results, file_write results, delegation results → truncate to 500 chars) vs NON-LANDMARK (100 chars)
- Combine into **single `role: 'user'`** message (NOT `'assistant'` — fix #3): `"[COMPRESSED CONTEXT: N turns]\n{summaries}"`
- Append: `CONTEXT_COMPRESSION_CONTINUATION_PROMPT`
- Keep: last 3 turns verbatim
- Return: `[system, init, compressed_user_block, ...last3]`

Constant:
```typescript
const CONTEXT_COMPRESSION_CONTINUATION_PROMPT = `
The conversation history above has been compressed to fit within context limits.
The [COMPRESSED CONTEXT] block summarizes prior turns. Continue the task from where you left off.
`.trim()
```

**Worker stdout rule**: **only `writeTurn()` writes to stdout**. All debug/error logging → stderr only.

**`src/orchestrator/llm/mock-provider.ts`** (extend existing)

Add scripted responses support:
```typescript
interface MockResponse {
  content?: string
  toolCalls?: ToolCall[]
  stopReason: 'end_turn' | 'tool_use' | 'max_tokens'
  tokensUsed?: { input: number; output: number }
}
// Constructor accepts MockResponse[] — pops one per generate() call
```

This enables testing compression path (script a `max_tokens` response followed by normal response).

### Integration tests

```
tests/orchestrator/agent-worker-entry.test.ts

Test 1: single tool call + attempt_completion
  - Mock: turn 1 → tool_calls[file_read], turn 2 → tool_calls[attempt_completion{done}]
  - Verify: two WorkerTurns on stdout, second has type 'done'
  - Verify: tokensConsumed present in both turns

Test 2: max_tokens → compression → continuation → done
  - Mock: turn 1 → stopReason 'max_tokens'; turn 2 → attempt_completion{done}
  - Verify: compressionAttempts=1, done turn emitted, tokensConsumed accumulated

Test 3: uncertain via attempt_completion
  - Mock: attempt_completion with status 'uncertain', uncertainties: ['blocked on X']
  - Verify: WorkerTurn type 'uncertain', reason present

Test 4: attempt_completion mixed with regular tools in same response
  - Mock: response with [file_read, attempt_completion] in same toolCalls array
  - Verify: attempt_completion processed last; done turn emitted (regular tools NOT sent to orchestrator)
```

### Exit criteria

```bash
bun run test tests/orchestrator/agent-worker-entry.test.ts
bun run check
```

Smoke test (manual):
```bash
echo '{"taskId":"t1","goal":"say hello","routingLevel":1,...}' \
  | bun run src/orchestrator/worker/agent-worker-entry.ts
# Should produce valid WorkerTurn JSON lines on stdout
```

---

## Phase 6.3 — Agent Loop

**Objective**: Orchestrator-side multi-turn session manager. Wires AgentSession + AgentBudget + SessionOverlay + ToolExecutor. L1+ tasks now go through the agentic loop. core-loop.ts gets dual-path dispatch.

### Files to create

**`src/orchestrator/worker/agent-loop.ts`**

Implement as a **stateless async function** (not a class):

```typescript
export async function runAgentLoop(
  input: TaskInput,
  perception: PerceptualHierarchy,
  memory: WorkingMemoryState,
  plan: TaskDAG | undefined,
  routing: RoutingDecision,
  deps: AgentLoopDeps,
): Promise<WorkerLoopResult>
```

**`WorkerLoopResult` formal type** (fix #7 — formally defined here, referenced by core-loop.ts and worker-pool.ts):

```typescript
export interface WorkerLoopResult {
  mutations: ProposedMutation[]         // from overlay.computeDiff()
  proposedContent?: string              // non-file output (answers, analysis)
  uncertainties: string[]
  tokensConsumed: number
  durationMs: number
  transcript: ConversationTurn[]        // full session — passed to TraceCollector
  sessionSummary?: AgentSessionSummary  // present on uncertain/failure; injected into retry
  isUncertain: boolean
}
```

**Full `runAgentLoop` pseudocode** (authoritative — supersedes AWP §8.3):

```typescript
async function runAgentLoop(...): Promise<WorkerLoopResult> {
  const startTime = performance.now()
  const budget = AgentBudgetTracker.fromRouting(routing, deps.contextWindow)
  const overlay = SessionOverlay.create(deps.workspace, input.id)
  const toolContext: ToolContext = {
    routingLevel: routing.level,
    allowedPaths: input.allowedPaths ?? ['src/'],
    workspace: deps.workspace,
    overlayDir: overlay.dir,
    // onDelegate wired in Phase 6.4; undefined until then
    onDelegate: routing.level >= 2
      ? (req) => handleDelegation(req, input, budget, routing, deps)
      : undefined,
  }

  // Fix #5: compress perception BEFORE building init turn
  const compressedPerception = deps.perceptionCompressor.compress(perception, budget.toSnapshot().contextWindow)

  const proc = Bun.spawn(['bun', 'run', deps.agentWorkerEntryPath], {
    stdin: 'pipe', stdout: 'pipe', stderr: 'pipe',
    env: buildAgentWorkerEnv(routing, deps.proxySocketPath),
  })
  const session: IAgentSession = deps.agentSessionFactory
    ? deps.agentSessionFactory(proc, budget)
    : new AgentSession(proc)

  const transcript: ConversationTurn[] = []
  let isUncertain = false
  let finalMutations: ProposedMutation[] = []
  let proposedContent: string | undefined

  try {
    // Send init turn with compressed perception
    const initTurn: OrchestratorTurn = {
      type: 'init',
      taskId: input.id,
      goal: input.goal,
      perception: compressedPerception,   // ← compressed, not raw
      workingMemory: memory,
      plan,
      tools: manifestFor(routing),
      budget: budget.toSnapshot(),
    }
    await session.send(initTurn)

    // Main loop
    while (budget.canContinue()) {
      const turn = await session.receive(budget.remainingMs())

      if (turn === null) {
        // Timeout or subprocess crash
        isUncertain = true
        break
      }

      transcript.push(turn)

      if (turn.type === 'tool_calls') {
        // Fix #2: prefer worker-reported tokensConsumed
        budget.recordTurn(
          turn.tokensConsumed != null ? turn.tokensConsumed : estimateTokens(turn)
        )

        // Cap tool calls per turn
        const calls = turn.calls.slice(0, budget.toSnapshot().maxToolCallsPerTurn)
        const dropped = turn.calls.slice(budget.toSnapshot().maxToolCallsPerTurn)

        const results: ToolResult[] = []
        for (const call of calls) {
          const raw = await deps.toolExecutor.execute(call, toolContext)
          // Fix #4 / A6: scan tool results before injecting into history
          const scanned = deps.guardrails.scan(raw.output)
          const result = scanned.blocked
            ? { ...raw, output: '[CONTENT BLOCKED: potential prompt injection]' }
            : raw
          results.push(result)
        }
        // Synthetic error results for dropped calls (LLM sees all calls resolved)
        for (const call of dropped) {
          results.push({ toolCallId: call.id, status: 'error', output: '[DROPPED: max tool calls per turn exceeded]' })
        }

        await session.send({ type: 'tool_results', turnId: turn.turnId, results })

      } else if (turn.type === 'done') {
        budget.recordTurn(turn.tokensConsumed)
        finalMutations = overlay.computeDiff()
        proposedContent = turn.proposedContent
        await session.drainAndClose()  // fix #1: NOT session.close('completed')
        return {
          mutations: finalMutations, proposedContent, uncertainties: turn.uncertainties,
          tokensConsumed: budget.toSnapshot().baseConsumed,
          durationMs: Math.round(performance.now() - startTime),
          transcript, isUncertain: false,
        }

      } else if (turn.type === 'uncertain') {
        isUncertain = true
        finalMutations = overlay.computeDiff()
        await session.drainAndClose()  // fix #1
        break
      }
    }

    if (!isUncertain && !budget.canContinue()) {
      // Ran out of budget mid-loop
      isUncertain = true
      await session.close('budget_exceeded')
    }

  } catch (err) {
    isUncertain = true
    await session.close('error').catch(() => {})  // best-effort
    throw err  // re-throw so core-loop can record the error
  } finally {
    overlay.cleanup()  // fix #4: ALWAYS clean up overlay
  }

  const partialMutations = overlay.computeDiff()
  return {
    mutations: partialMutations, uncertainties: ['session ended without completion'],
    tokensConsumed: budget.toSnapshot().baseConsumed,
    durationMs: Math.round(performance.now() - startTime),
    transcript, isUncertain: true,
  }
}
```

**`handleDelegation()` — full budget lifecycle** (fix #7):

```typescript
async function handleDelegation(
  request: DelegationRequest,
  parent: TaskInput,
  budget: AgentBudgetTracker,
  routing: RoutingDecision,
  deps: AgentLoopDeps,
): Promise<ToolResult> {
  const decision = deps.delegationRouter.canDelegate(request, budget, parent)
  if (!decision.allowed) {
    return { status: 'denied', output: `Delegation denied: ${decision.reason}` }
  }

  // Fix #7: correct budget lifecycle
  const reserved = decision.allocatedTokens
  const childBudget = budget.deriveChildBudget(reserved)   // eagerly deducts from delegation pool
  const subInput = buildSubTaskInput(request, parent, routing, childBudget)

  const childResult = await deps.executeTask(subInput)     // thunk — no circular dep

  // Refund unused delegation tokens
  const actualConsumed = childResult.tokensConsumed ?? 0
  budget.returnUnusedDelegation(reserved, actualConsumed)

  const outcome = toStrippedOutcome(childResult)           // strip oracle verdicts
  return { status: childResult.status === 'success' ? 'ok' : 'error', output: JSON.stringify(outcome) }
}
```

**`AgentLoopDeps` interface**:

```typescript
interface AgentLoopDeps {
  toolExecutor: ToolExecutor
  guardrails: GuardrailsEngine
  perceptionCompressor: { compress: typeof compressPerception }
  delegationRouter: DelegationRouter         // undefined until Phase 6.4
  executeTask: (subInput: TaskInput) => Promise<TaskResult>  // late-bound thunk (Phase 6.4)
  agentSessionFactory?: (proc: BunSubprocess) => IAgentSession
  agentWorkerEntryPath: string
  proxySocketPath?: string
  workspace: string
  contextWindow: number
  eventBus: EventBus
}
```

### core-loop.ts integration note (step 20)

**`src/orchestrator/core-loop.ts`** — dual-path dispatch and post-loop pipeline:

```typescript
// In executeTask():

// Step 4: Generate
let workerResult: WorkerLoopResult | LegacyWorkerResult
if (routing.level === 0) {
  // L0: existing single-shot path (worker-pool → worker-entry.ts)
  workerResult = await workerPool.dispatch(input, perception, memory, plan, routing)
} else {
  // L1+: agentic loop (fix #4: compression happens inside runAgentLoop)
  workerResult = await runAgentLoop(input, perception, memory, plan, routing, agentLoopDeps)
}

// Step 4½a (skipped): assemblePrompt — already happened inside AgentLoop / worker-entry.ts
// Step 5 (skipped): LLM call — already happened inside agent-worker-entry.ts subprocess

// Step 5 (continues): Oracle verification — runs on final mutation diff, not raw LLM output
const verdict = await oracleGate.verify(workerResult.mutations, input)

if (verdict.pass) {
  await commitArtifacts(workerResult.mutations, workspace)  // write through from overlay
  worldGraph.update(workerResult.mutations)
  shadowStore.persist(taskId, verdict)
} else {
  // Build retry context — core-loop.ts is the owner (not AgentLoop)
  if ('transcript' in workerResult) {
    const summary = buildAgentSessionSummary(workerResult, attempt, verdict)
    memory.priorAttempts = [...(memory.priorAttempts ?? []), summary]
  }
  // Escalate routing level and retry (see 13.3)
}

// Step 6: Learn
traceCollector.record({
  taskId,
  transcript: 'transcript' in workerResult ? workerResult.transcript : [],
  verdict,
  predictionError: selfModel.computeError(prediction, verdict),
})
selfModel.calibrate(taskId, verdict)

// Note: critic + test-gen still run on final mutations — unchanged from Phases 1–5
```

### Files to modify

**`src/orchestrator/worker/worker-pool.ts`**

```typescript
// Add to WorkerPoolConfig
interface WorkerPoolConfig {
  // ...existing
  agentSessionFactory?: (proc: BunSubprocess) => IAgentSession  // injectable for testing
  agentLoopDeps?: Partial<AgentLoopDeps>                         // merged with defaults
}
```

The `dispatch()` method remains the entry point for both L0 and L1+ — it just delegates to `runAgentLoop` for L1+.

### Integration tests

```
tests/orchestrator/agent-loop.test.ts

Test 1: L1 task — 3 tool turns, file_read reads overlay content
  - Uses IAgentSession mock (injectable)
  - Verify: overlay created, file_write goes through CoW, mutations computed from diff
  - Verify: overlay cleaned up in finally (even in success path)

Test 2: guardrails intercept adversarial tool result
  - Mock tool result contains injection pattern
  - Verify: history entry shows '[CONTENT BLOCKED]' not raw content
  - Verify: worker still receives tool_results turn (with blocked content)

Test 3: subprocess crash mid-session (receive → null)
  - MockAgentSession.receive() returns null after 1 turn
  - Verify: isUncertain=true, partial overlay diff preserved, overlay cleaned up

Test 4: budget exceeded mid-loop
  - Mock canContinue() → false after 3 turns
  - Verify: session.close('budget_exceeded'), overlay cleaned up, isUncertain=true
```

### Exit criteria

```bash
bun run test tests/orchestrator/agent-loop.test.ts
bun run test:integration     # all existing integration tests must still pass
bun run check
```

---

## Phase 6.4 — Delegation

**Objective**: Workers at L2+ can delegate sub-tasks via `delegate_task` tool. Sub-tasks run through the full pipeline with bounded scope.

### Files to create

**`src/orchestrator/delegation-router.ts`**

```typescript
export interface DelegationDecision {
  allowed: boolean
  reason: string                // human-readable; always present
  allocatedTokens: number       // 0 if denied
}

class DelegationRouter {
  canDelegate(
    request: DelegationRequest,
    budget: AgentBudgetTracker,
    parent: TaskInput,
  ): DelegationDecision {
    // R1: budget.canDelegate() — depth check (delegationDepth < maxDelegationDepth)
    // R2: request.targetFiles ⊆ parent.allowedPaths — scope containment
    // R3: request.requiredTools ⊆ parent toolManifest names — tool containment
    // R4: delegationRemaining >= minimum viable budget
    //     (delegationRemaining = budget.delegation - budget.delegationConsumed)
    // R5: checkDelegationSafetyInvariants(request) — reuse evolution/safety-invariants.ts
    // R6: 'shell_exec' NOT in request.requiredTools — capability creep prevention
    //     (shell_exec blocked even when R3 would allow it)
    //
    // Budget calculation on approval (fix #6):
    //   allocatedTokens = min(
    //     request.requestedTokens ?? defaultDelegationBudget,
    //     (budget.delegation - budget.delegationConsumed) * 0.5
    //   )
    //   NOT budget.tokensRemaining * 0.5 (tokensRemaining is undefined)
  }
}
```

**`buildSubTaskInput()`**:

```typescript
function buildSubTaskInput(
  request: DelegationRequest,
  parent: TaskInput,
  parentRouting: RoutingDecision,
  childBudget: AgentBudget,
): TaskInput
// goal: request.goal
// targetFiles: request.targetFiles (exactly — not parent's full allowedPaths)
// allowedPaths: request.targetFiles (child bounded to requested files only)
// routingLevel: min(parentRouting.level, riskRouter.route(request).level) ← cap at parent
// budget: childBudget (derived token allocation from parent delegation pool)
// workingMemory: fresh WorkingMemoryState (independent — no parent priorAttempts)
```

### Files to modify

**`src/orchestrator/worker/agent-loop.ts`**

Enable delegation (was stubbed in Phase 6.3):

```typescript
onDelegate: routing.level >= 2
  ? (request) => handleDelegation(request, input, budget, routing, deps)
  : undefined,
```

`handleDelegation()` already has full implementation from Phase 6.3 spec — just enable the condition.

**`src/orchestrator/factory.ts`**

```typescript
// After full deps construction — late-bind to resolve circular dependency:
const delegationRouter = new DelegationRouter()
const executeTaskThunk = (subInput: TaskInput) => executeTask(subInput, deps)
//                                                  ^^^^^^^^^^^^
// deps is fully constructed by this point — no circular dep
// executeTask is defined in this file; thunk defers the call until delegation is requested

const agentLoopDeps: AgentLoopDeps = {
  ...existingDeps,
  delegationRouter,
  executeTask: executeTaskThunk,
}
```

**`src/orchestrator/tools/built-in-tools.ts`**

Wire the `delegate_task` handler (was a descriptor stub in Phase 6.0):

```typescript
// delegate_task.execute():
async execute(input: DelegationRequest, context: ToolContext): Promise<ToolResult> {
  if (!context.onDelegate) {
    return { status: 'error', output: 'Delegation not available at this routing level' }
  }
  return context.onDelegate(input)
}
```

### Integration tests

```
tests/orchestrator/delegation.test.ts

Test 1: L2 basic delegation (step 28)
  - Parent L2 MockAgentSession: emit delegate_task call
  - Child MockAgentSession: emit attempt_completion{done}
  - Verify: child mutations appear in parent overlay area
  - Verify: DelegationOutcome.oraclePassed reflects child result
  - Verify: budget.returnUnusedDelegation called with (reserved, actual)

Test 2: R2 scope violation (step 29)
  - request.targetFiles includes file outside parent.allowedPaths
  - Verify: DelegationDecision.allowed = false, ToolResult.status = 'denied'
  - Verify: reason mentions 'scope containment'

Test 3: routing level cap (step 30)
  - Parent at L2; sub-task risk score would compute to L3
  - Verify: buildSubTaskInput sets routingLevel = L2 (capped at parent)

Test 4: R6 shell_exec blocked (step 31)
  - request.requiredTools includes 'shell_exec'
  - Verify: denied even if R3 would otherwise allow it
  - Verify: reason mentions 'R6' or 'capability creep'

Test 5: oracle_failed → no commit, parent receives failure (step 32)
  - Child task oracle fails
  - Verify: DelegationOutcome.oraclePassed = false
  - Verify: parent receives error ToolResult
  - Verify: returnUnusedDelegation still called (budget cleanup)
```

### Exit criteria

```bash
bun run test tests/orchestrator/delegation.test.ts
bun run test:integration
bun run check
```

---

## Phase 6.5 — Hardening & Observability

**Objective**: Production-readiness. Observability, resource limits, startup cleanup, and concurrency control.

### Tasks

**Step 33 — Worker subprocess orphan protection** (`src/orchestrator/worker/agent-worker-entry.ts`)

```typescript
// After init turn received, start parent-death watchdog:
const parentPid = parseInt(process.env.VINYAN_ORCHESTRATOR_PID ?? '0')
let watchdog: ReturnType<typeof setInterval> | undefined
if (parentPid) {
  watchdog = setInterval(() => {
    if (!isProcessAlive(parentPid)) {
      process.stderr.write('[agent-worker] parent process gone — self-terminating\n')
      process.exit(1)
    }
  }, 10_000)
}
// In finally block:
if (watchdog) clearInterval(watchdog)

function isProcessAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch { return false }
}
```

Pass `VINYAN_ORCHESTRATOR_PID=process.pid` in `buildAgentWorkerEnv()`.

**Step 34 — Bus events** (`src/orchestrator/worker/agent-loop.ts` + `delegation-router.ts`)

```typescript
deps.eventBus.emit('agent:session_start',   { taskId, routingLevel, budget: budget.toSnapshot() })
deps.eventBus.emit('agent:turn_complete',   { taskId, turnId, tokensConsumed, turnsRemaining })
deps.eventBus.emit('agent:tool_executed',   { taskId, turnId, toolName, durationMs, isError })
deps.eventBus.emit('agent:compression',     { taskId, attemptNumber, historyLengthBefore, historyLengthAfter })
deps.eventBus.emit('agent:occ_conflict',    { taskId, file, action: 'retry' })
deps.eventBus.emit('agent:delegation_req',  { taskId, delegationId, goal, routingLevel })
deps.eventBus.emit('agent:delegation_done', { taskId, delegationId, outcome: 'success' | 'denied' | 'failed' })
deps.eventBus.emit('agent:session_end',     { taskId, outcome, tokensConsumed, turnsUsed, durationMs })
```

**Step 35 — TUI dashboard** (`src/tui/views/dashboard.ts`)

- Add "Active Sessions" panel: `taskId | turns | tokens | depth`
- Show delegation tree indentation when `delegationDepth > 0`
- Listen to `agent:session_start`, `agent:turn_complete`, `agent:session_end`

**Step 36 — Stale overlay cleanup** (`src/orchestrator/factory.ts` or startup hook)

```typescript
async function cleanupStaleOverlays(workspace: string, maxAgeMs: number): Promise<void> {
  const sessionsDir = join(workspace, '.vinyan', 'sessions')
  if (!existsSync(sessionsDir)) return
  for (const dir of readdirSync(sessionsDir)) {
    const fullPath = join(sessionsDir, dir)
    const stat = statSync(fullPath)
    if (Date.now() - stat.mtimeMs > maxAgeMs) {
      rmSync(fullPath, { recursive: true, force: true })
    }
  }
}
// maxAgeMs = maxDurationMs * 2 (from config)
// Call on Orchestrator init — before first task runs
```

**Step 37 — Concurrent session semaphore** (`src/orchestrator/worker/worker-pool.ts`)

```typescript
// WorkerPoolConfig
maxConcurrentAgenticSessions?: {
  l1?: number  // default: 5
  l2?: number  // default: 3
  l3?: number  // default: 1
}

// In dispatch() for L1+:
const sem = this.semaphores[routing.level]
await sem.acquire()
try {
  return await runAgentLoop(...)
} finally {
  sem.release()
}
```

**Step 38 — Transcript storage** (`src/orchestrator/core-loop.ts`)

- `TraceCollector.record()` extended to accept `transcript: ConversationTurn[]`
- Store as gzip-compressed sidecar file: `.vinyan/traces/{taskId}.transcript.gz`
- Keep SQLite trace record as index (taskId, timestamp, outcome, tokensConsumed, transcriptPath)

**Step 39 — Final verification**

```bash
bun run test:all    # complete suite — all phases integrated
bun run check
```

**Step 40 — Smoke test**

Manual: `bun run src/cli/run.ts` with a real L2 task and real LLM.

### Exit criteria

```bash
bun run test:all
bun run check
```

---

## Data Flow: core-loop.ts Post-AgentLoop Pipeline

When `runAgentLoop` returns `WorkerLoopResult`, core-loop.ts continues:

| Step | What runs | Change from Phases 1–5 |
|------|-----------|------------------------|
| assemble prompt | **SKIP** | Happened inside agent-worker-entry.ts subprocess |
| LLM generate | **SKIP** | Happened inside agent-worker-entry.ts subprocess |
| oracle verify | **RUN** | Input is `WorkerLoopResult.mutations` (overlay diff) |
| critic | **RUN** | Unchanged |
| test-gen | **RUN** | Unchanged |
| commit | **RUN** | `commitArtifacts(mutations)` — same as before |
| world-graph | **RUN** | SHA-256 rebind for committed files |
| shadow job | **RUN** | Unchanged |
| trace collect | **RUN** | Extended: also stores `transcript` |

**Retry path**: if oracle fails or `isUncertain=true`:
1. `buildAgentSessionSummary(loopResult, attempt, verdict)` → `AgentSessionSummary`
2. `memory.priorAttempts.push(summary)` → injected into next attempt's init turn
3. `routing.level++` (escalate)
4. Re-enter `runAgentLoop` with escalated routing + updated memory

---

## Cross-Cutting Notes

### Testing strategy

Each phase has its own test file. Mock the layer below you:
- Phase 6.0 tests: pure type/schema validation
- Phase 6.1 tests: mock filesystem, mock subprocess
- Phase 6.2 tests: `MockLLMProvider` with scripted `stopReason`
- Phase 6.3 tests: `IAgentSession` mock (injectable via `WorkerPoolConfig`)
- Phase 6.4 tests: `IAgentSession` mock + real `DelegationRouter`

### Backward compatibility invariants

These must hold throughout all phases:
1. `worker-entry.ts` (single-shot L0) — untouched, no imports changed
2. `WorkerInputSchema` and `WorkerOutputSchema` still valid for L0
3. `LLMRequest` single-turn fields (`systemPrompt`, `userPrompt`) still work
4. All Phase 0–5 tests passing before each phase commit

### Do not implement (out of scope for Phase 6)

- Computer use / GUI interaction
- Peer-to-peer worker communication (A2A is external only)
- LLM-assisted context compression (keep deterministic)
- MCP server integration (separate Phase 7 concern)
- L3 Docker container agentic sessions (L3 container exists for single-shot; agentic in Docker = Phase 7)

---

## Migration Plan — Numbered Checklist

Complete implementation order. Each step maps to one logical unit of work.

### Phase 6.0 — Protocol Foundation (steps 1–8)

- [ ] **1.** Create `src/orchestrator/llm/provider-format.ts` — `normalizeMessages()` for Anthropic + OpenAI-compat formats
- [ ] **2.** Extend `src/orchestrator/types.ts` — `HistoryMessage`, `ToolResultMessage`, `LLMResponse.thinking/stopReason`, `AgentSessionSummary`, `WorkingMemoryState.priorAttempts`
- [ ] **3.** Add Zod schemas to `src/orchestrator/protocol.ts` — `AgentBudgetSchema`, `OrchestratorTurnSchema`, `WorkerTurnSchema`, `DelegationRequestSchema`
- [ ] **4.** Extend `src/orchestrator/tools/tool-interface.ts` — `ToolDescriptor`, `ToolCategory += 'delegation'|'control'`, `ToolContext.overlayDir`/`onDelegate`
- [ ] **5.** Add `attempt_completion` formal descriptor + handler to `built-in-tools.ts`
- [ ] **6.** Add `request_budget_extension` formal descriptor + handler to `built-in-tools.ts`
- [ ] **7.** Add `delegate_task` descriptor stub to `built-in-tools.ts` (handler pass-through to `context.onDelegate`; fully wired in step 28)
- [ ] **8.** Extend `openrouter-provider.ts` + `anthropic-provider.ts` for `messages[]` multi-turn path; add `manifestFor()` with delegate_task at L2+

### Phase 6.1 — Infrastructure (steps 9–18)

- [ ] **9.** Create `src/orchestrator/worker/agent-session.ts` — state machine, `send`/`receive`/`close`/`drainAndClose`, `IAgentSession` interface
- [ ] **10.** Create `src/orchestrator/worker/agent-budget.ts` — `AgentBudgetTracker` with 3-pool, `requestExtension` (delegationRemaining * 0.5), `deriveChildBudget`, `returnUnusedDelegation`
- [ ] **11.** Create `src/orchestrator/worker/session-overlay.ts` — CoW fs, OCC commit, `computeDiff`, `cleanup`
- [ ] **12.** Create `src/orchestrator/llm/perception-compressor.ts` — priority-aware truncation to ≤30% of context window
- [ ] **13.** Modify `built-in-tools.ts` — overlay-aware CoW routing for `file_read/write/edit/delete/list` (Change A)
- [ ] **14.** Modify `built-in-tools.ts` — `shell_exec` read-only whitelist for agentic mode (Change B)
- [ ] **15.** Modify `built-in-tools.ts` — `guardrails.scan()` on all tool results before returning (Change C); add `guardrails` to `ToolExecutorConfig`
- [ ] **16.** Add `descriptor()` to all existing tools in `built-in-tools.ts`
- [ ] **17.** Write unit tests: `agent-session`, `agent-budget`, `session-overlay`, `perception-compressor`
- [ ] **18.** `bun run check` — zero errors, all existing tests pass

### Phase 6.2 — Worker Entry (steps 19–22)

- [ ] **19.** Create `src/orchestrator/worker/agent-worker-entry.ts` — full agentic loop: init read, tool loop, `compressHistory`, `attempt_completion` handling, `writeTurn` stdout protocol
- [ ] **21.** Extend `src/orchestrator/llm/mock-provider.ts` — scripted `stopReason` support for compression test
- [ ] **22.** Write integration tests: `tests/orchestrator/agent-worker-entry.test.ts` (4 tests)
- [ ] **23.** `bun run check` + smoke test (manual subprocess invocation)

### Phase 6.3 — Agent Loop (steps 20, 24–27)

- [ ] **20.** Modify `src/orchestrator/core-loop.ts` — dual-path dispatch: L0 → worker-pool single-shot; L1+ → `runAgentLoop`; post-loop pipeline (oracle, critic, trace); `buildAgentSessionSummary` on retry
- [ ] **24.** Create `src/orchestrator/worker/agent-loop.ts` — `runAgentLoop` with `PerceptionCompressor.compress` before init, `try/finally overlay.cleanup`, `guardrails.scan` on results, `drainAndClose` on done/uncertain, `WorkerLoopResult` return
- [ ] **25.** Define `AgentLoopDeps` interface; define `WorkerLoopResult` as exported type
- [ ] **26.** Modify `src/orchestrator/worker/worker-pool.ts` — wire `runAgentLoop` for L1+; add `IAgentSession` factory injection
- [ ] **27.** Write integration tests: `tests/orchestrator/agent-loop.test.ts` (4 tests); run `bun run test:integration`

### Phase 6.4 — Delegation (steps 28–37)

- [ ] **28.** Implement `delegate_task` handler in `built-in-tools.ts` (calls `context.onDelegate`)
- [ ] **29.** Create `src/orchestrator/delegation-router.ts` — `DelegationRouter` with R1–R6; budget calc `delegationRemaining * 0.5`
- [ ] **30.** Add `buildSubTaskInput()` — caps child routing level at parent; fresh `workingMemory`
- [ ] **31.** Add `handleDelegation()` to `agent-loop.ts` — full budget lifecycle: `deriveChildBudget` → `buildSubTaskInput` → `executeTask` → `returnUnusedDelegation`
- [ ] **32.** Enable `onDelegate` condition at L2+ in `runAgentLoop`
- [ ] **33.** Modify `src/orchestrator/factory.ts` — `DelegationRouter` construction; `executeTaskThunk` late-bind; `AgentLoopDeps` wiring
- [ ] **34.** Write delegation Test 1 (basic L2 delegation + returnUnusedDelegation verified)
- [ ] **35.** Write delegation Test 2 (R2 scope violation denied)
- [ ] **36.** Write delegation Test 3 (routing level cap enforced)
- [ ] **37.** Write delegation Test 4 (R6 shell_exec blocked) + Test 5 (oracle_failed cleanup); run `bun run test:integration`

### Phase 6.5 — Hardening (steps 38–45)

- [ ] **38.** Add VINYAN_ORCHESTRATOR_PID watchdog to `agent-worker-entry.ts` — orphan self-termination every 10s
- [ ] **39.** Emit all 8 bus events from `agent-loop.ts` + `delegation-router.ts`
- [ ] **40.** TUI "Active Sessions" panel in `src/tui/views/dashboard.ts`
- [ ] **41.** `cleanupStaleOverlays()` on Orchestrator startup in `factory.ts`
- [ ] **42.** Concurrent session semaphore in `worker-pool.ts` (per-level limits: L1=5, L2=3, L3=1)
- [ ] **43.** Extend `TraceCollector.record()` to accept + store compressed transcript
- [ ] **44.** `bun run test:all` — full suite green
- [ ] **45.** Manual smoke test: L2 agentic task with real LLM; verify overlay, mutations, oracle, commit

---

*Implementation starts at step 1.*
