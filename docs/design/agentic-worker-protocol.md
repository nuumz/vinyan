# Agentic Worker Protocol (AWP) — System Design

> Status: **DRAFT v6 — implementation-ready after deep codebase cross-reference**
> Author: design session 2026-04-02
> Scope: Phase 6 — Agentic Tool Use & Worker Delegation
> Changelog:
> - v2 — OQ-1 resolved: `delegate_task` via ToolContext injection; protocol simplified to 3 WorkerTurn types
> - v3 — OQ-2 resolved: 3-pool budget with `request_budget_extension` tool; OQ-5 resolved: session overlay replaces "hold mutations until done"
> - v4 — OQ-3 resolved: two-tier context compression recovery (proactive 75% + reactive); OQ-4 resolved: `AgentSessionSummary` compressed prompt pattern; OQ-6 resolved: batch tool results
> - v5 — Expert review: `attempt_completion` tool replaces UNCERTAIN: heuristic; shell_exec overlay constraints; provider messages[] normalization spec; PerceptionCompressor for init; compressHistory message ordering fix; OCC at commit; AgentSession state machine; delegation loop fix; missing implementation requirements

### Document Boundary

| This doc owns | Cross-ref for |
|:-------------|:--------------|
| Multi-turn worker IPC protocol (ndjson, 3 OrchestratorTurn + 3 WorkerTurn types) | ECP wire format & epistemic semantics → [ecp-spec.md](../spec/ecp-spec.md) |
| AgentSession, AgentLoop, AgentBudget (3-pool), SessionOverlay | Full trust degradation matrix → [protocol-architecture.md §6](../architecture/protocol-architecture.md) |
| DelegationRouter (6 invariants), delegation via ToolContext | A2A inter-instance protocol → [a2a-protocol.md](../spec/a2a-protocol.md) |
| PerceptionCompressor, context compression recovery | ECP v2 research → [ecp-research.md](../research/ecp-research.md) |
| Capability matrix (L0-L3 tool authorization) | Protocol stack & transport abstraction → [protocol-architecture.md](../architecture/protocol-architecture.md) |
| Provider message format normalization (Anthropic/OpenAI) | |
> - v6 — Deep codebase cross-reference: fix ToolExecutor classification (now MODIFY, not unchanged); fix DelegationRouter R6 + budget calc; fix handleDelegation budget derivation lifecycle; add try/finally + guardrails.scan() to AgentLoop; fix Capability Matrix L0/L1 inconsistencies; rewrite §13 Data Flow with complete pipeline (all paths, post-verify steps, escalation); expand §14 Migration Plan (core-loop dual-path, orphan protection, delegate_task tool impl)

---

## 1. Abstract

The current Vinyan worker model is **single-shot**: the Orchestrator sends one JSON payload to a worker subprocess, the worker makes one LLM call, and returns one JSON response. Tool calls proposed in that response are executed *after* the worker exits — their results never reach the LLM.

This document specifies the **Agentic Worker Protocol (AWP)**: a bidirectional, multi-turn IPC session between the Orchestrator and a worker subprocess, enabling:

1. **Tool-use loops** — workers call tools, receive results, and use those results to inform subsequent generation (ReAct pattern)
2. **Worker-to-worker delegation** — workers request sub-task execution; the Orchestrator decides whether to honor, modify, or deny the request (A3)

All capabilities are **tiered by routing level** and governed by the Orchestrator. Workers propose; the Orchestrator disposes. Axioms A1–A7 are preserved or strengthened.

---

## 2. Background

### 2.1 Current Limitations

| Limitation | Impact |
|-----------|--------|
| Single-shot worker: one LLM call, one response | Worker cannot use tool results to improve generation |
| Tool results execute *after* oracle verification | Tools are side effects, not inputs to reasoning |
| No worker delegation mechanism | Complex multi-step tasks require full Orchestrator re-entry |
| `LLMRequest` has no `messages[]` field | Multi-turn conversation history not expressible |
| `worker-entry.ts` reads entire stdin at once | Architecturally incompatible with multi-turn IPC |

### 2.2 What Already Exists (Reuse)

| Component | Reuse |
|-----------|-------|
| `LLMResponse.stopReason` | Already typed (`'end_turn' \| 'tool_use' \| 'max_tokens'`) |
| `LLMProvider.supportsToolUse` | Flag already exists, unused |
| `LLMRequest.tools[]` | Schema exists, Anthropic provider already uses it |
| `ToolExecutor` | Execute + validate tool calls — extended with overlay-aware file ops + guardrails.scan() |
| `WorkerInputSchema` | Extended, not replaced |
| `OracleGate` | Final verification — unchanged |
| `ApprovalGate` | Human-in-loop — unchanged |
| `DelegationRouter` concept | Referenced in `InstanceCoordinator` pattern (Phase 5) |

---

## 3. Goals and Non-Goals

### Goals

- G1: Workers can call tools during generation and receive results before producing final output
- G2: Workers can request delegation of sub-tasks; Orchestrator governs the decision (A3)
- G3: All agentic capabilities are tiered by routing level — L0 unchanged, L1+ opt-in
- G4: Full audit trail for every turn, tool call, and delegation event
- G5: Backward compatible — existing single-shot workers continue to work unchanged
- G6: Self-contained ecosystem — no external SDK dependency for the loop protocol
- G7: Budget-bounded — turns, tokens, delegation depth all capped deterministically

### Non-Goals

- NG1: Workers do not acquire execution privileges (A6 unchanged)
- NG2: Oracle Gate verification on final mutations is not replaced or reduced
- NG3: Orchestrator routing decisions are not delegated to workers
- NG4: Workers do not communicate peer-to-peer (A2A is external only)
- NG5: This design does not address computer use / GUI interaction (separate concern)

---

## 4. Design Principles

Every component traces to at least one Vinyan axiom:

| Axiom | How AWP satisfies it |
|-------|----------------------|
| **A1** Epistemic Separation | Tool results are raw facts, not worker self-evaluation. Oracle Gate still verifies final mutations. Workers cannot alter tool outputs. |
| **A2** First-Class Uncertainty | Workers can emit `{ type: 'uncertain' }` at any turn. Partial mutations are preserved for audit. |
| **A3** Deterministic Governance | `DelegationRouter` is rule-based (no LLM in decision path). Capability matrix is a static table. Budget enforcement is deterministic. |
| **A4** Content-Addressed Truth | `verificationHints` in tool results include file content hashes. Stale reads are flagged. |
| **A5** Tiered Trust | Tool results carry `confidence` (deterministic shell output > heuristic search > LLM-generated content). |
| **A6** Zero-Trust Execution | Workers never execute tools directly. IPC carries proposals only. Subprocess isolation preserved. |
| **A7** Prediction Error as Learning | `ConversationTurn` transcript stored with trace, enabling turn-level prediction error in Sleep Cycle (future). |

---

## 5. Architecture Overview

### 5.1 New Components

```
src/orchestrator/
  worker/
    agent-session.ts          NEW  Bidirectional ndjson IPC with subprocess + state machine
    agent-loop.ts             NEW  Multi-turn session orchestrator (replaces dispatch)
    agent-budget.ts           NEW  3-pool budget: base / negotiable / delegation
    agent-worker-entry.ts     NEW  Worker subprocess — multi-turn event loop
    session-overlay.ts        NEW  Per-task staged filesystem (create / CoW read / diff / commit)
    worker-entry.ts           KEEP Single-shot (L0, backward compat — no overlay)
  delegation-router.ts        NEW  A3-compliant delegation governance
  llm/perception-compressor.ts NEW  Truncate perception to contextWindow budget at init
  llm/provider-format.ts      NEW  Canonical Message[] → Anthropic / OpenAI-compat normalization
```

### 5.2 Modified Components

```
src/orchestrator/
  protocol.ts              EXTEND  + OrchestratorTurnSchema, WorkerTurnSchema, DelegationRequestSchema
  types.ts                 EXTEND  + Message, ConversationTurn, AgentBudget, AgentSessionSummary;
                                     WorkingMemoryState.priorAttempts?: AgentSessionSummary[]
  worker/worker-pool.ts    MODIFY  L1+ routes to AgentLoop (injectable IAgentSession for testing)
  tools/tool-interface.ts  EXTEND  + ToolDescriptor, 'delegation'/'control' ToolCategory, overlayDir + onDelegate in ToolContext
  tools/tool-executor.ts   MODIFY  Overlay-aware execution: file_write/read/edit route through overlayDir when present;
                                     guardrails.scan() on all tool results before returning to AgentLoop
  tools/built-in-tools.ts  EXTEND  + descriptor() method per tool; add attempt_completion + request_budget_extension +
                                     delegate_task tools; shell_exec read-only whitelist at L1/L2 subprocess
  core-loop.ts             MODIFY  Step 4 dual-path: L0 uses WorkerPool.dispatch (unchanged), L1+ uses AgentLoop.run();
                                     Steps 4½a/5½ become no-ops for agentic path (tools already executed in overlay);
                                     Step 4 return type widened to WorkerResult | WorkerLoopResult;
                                     Retry path injects AgentSessionSummary into WorkingMemory.priorAttempts;
                                     Critic (WP-2) + TestGenerator (WP-3) still run on WorkerLoopResult.mutations
  factory.ts               MODIFY  Wire DelegationRouter + late-bind executeTask thunk into OrchestratorDeps
  llm/openrouter-provider.ts MODIFY + messages[] multi-turn support via provider-format.ts
  llm/anthropic-provider.ts  MODIFY + messages[] multi-turn support via provider-format.ts; LLMResponse.thinking field
```

### 5.3 Components Left Unchanged

```
worker-entry.ts   (single-shot, L0)
OracleGate        (final verification — A1 anchor)
ApprovalGate      (human-in-loop — A6 anchor)
RiskRouter        (routing decisions — A3 anchor)
EventBus          (audit plumbing)
WorldGraph        (fact storage — A4 anchor)
```

---

## 6. IPC Transport: ndjson over stdin/stdout

### 6.1 Framing

Each message is a single UTF-8 JSON object terminated by `\n`. No length prefix. No binary.

```
Orchestrator → Worker:  write `${JSON.stringify(OrchestratorTurn)}\n` to stdin
Worker → Orchestrator:  write `${JSON.stringify(WorkerTurn)}\n` to stdout
```

**Why ndjson?**

- Already using JSON everywhere in the codebase
- Bun's `readline` handles streaming natively
- Simple to debug (every message is human-readable)
- The current oracle IPC pattern (JSON stdin → JSON stdout) already validates this approach at scale
- Alternatives (length-prefix binary, Unix socket, local HTTP) add complexity without benefit at this stage

### 6.2 Session Lifecycle

```
1. Orchestrator spawns subprocess with stdin/stdout pipe
2. Orchestrator writes OrchestratorTurn { type: 'init' }
3. Worker enters event loop: read → process → write → read → ...
4. Session ends when:
   a. Worker writes WorkerTurn { type: 'done' }     → Orchestrator closes stdin, waits for exit
   b. Worker writes WorkerTurn { type: 'uncertain' } → same
   c. Orchestrator writes OrchestratorTurn { type: 'terminate' } → Worker exits cleanly
   d. Budget exceeded → Orchestrator terminates
   e. Subprocess crash → AgentLoop catches exit code
```

### 6.3 Error Handling

- Worker must not exit without writing a final `done` or `uncertain` turn (or receiving `terminate`)
- If worker crashes mid-session, AgentLoop treats it as `uncertain` with partial mutations preserved
- Orchestrator validates each WorkerTurn with Zod — invalid JSON is treated as `uncertain`

---

## 7. Protocol Specification

### 7.1 Orchestrator → Worker (`OrchestratorTurn`)

3 types only — `'delegation_result'` is removed (OQ-1: delegation results arrive as regular `ToolResult` inside `'tool_results'`):

```typescript
type OrchestratorTurn =
  | {
      type: 'init';
      taskId: string;
      goal: string;
      perception: PerceptualHierarchy;
      workingMemory: WorkingMemoryState;
      plan?: TaskDAG;
      toolManifest: ToolDescriptor[];   // tools authorized for this session
      budget: AgentBudget;              // 3-pool: base / negotiable / delegation
      routingLevel: RoutingLevel;
      allowedPaths: string[];
    }
  | {
      type: 'tool_results';
      turnId: string;
      results: ToolResult[];            // includes delegate_task outcome as ToolResult
      verificationHints: VerificationHint[];  // A4: hashes, staleness flags
    }
  | {
      type: 'terminate';
      reason: 'budget_exceeded' | 'timeout' | 'parent_done' | 'error';
    }
```

### 7.2 Worker → Orchestrator (`WorkerTurn`)

**v2 simplification**: `'delegation'` is removed as a distinct turn type. Delegation is expressed as a regular `tool_calls` turn using the `delegate_task` tool. The protocol surface shrinks to 3 types:

```typescript
type WorkerTurn =
  | {
      type: 'tool_calls';
      turnId: string;
      calls: ToolCall[];         // may include 'delegate_task' at L2+, 'attempt_completion' at all levels
      rationale: string;         // epistemic justification (A2) — from thinking block or content
      tokensConsumed?: number;   // cumulative tokens so far — enables Orchestrator budget tracking mid-loop
    }
  | {
      type: 'done';
      turnId: string;
      proposedMutations?: ProposedMutation[]; // optional metadata/explanation only (OQ-5)
      proposedContent?: string;               // non-file outputs (domain: 'general')
      uncertainties: string[];
      tokensConsumed: number;
    }
  | {
      type: 'uncertain';
      turnId: string;
      reason: string;
      partialMutations?: ProposedMutation[];  // A2: preserve partial work for audit
    }
```

**`attempt_completion` tool — replaces string heuristics for done/uncertain signaling:**

Workers signal task completion by calling the `attempt_completion` tool (category: `'control'`, `minRoutingLevel: 0`). This is the *only* valid way to emit `done` or `uncertain` turns. String-pattern detection (`UNCERTAIN:`, `end_turn` parsing) is not used.

```typescript
// attempt_completion tool descriptor
{
  name: 'attempt_completion',
  description: 'Signal that you have completed the task or cannot proceed. Call this when your work is done or when you are uncertain. Do NOT call this while file tools are still pending.',
  inputSchema: {
    type: 'object',
    properties: {
      status: { type: 'string', enum: ['done', 'uncertain'] },
      summary: { type: 'string', description: 'Brief summary of what was accomplished' },
      uncertainties: { type: 'array', items: { type: 'string' }, description: 'Reasons for uncertainty (required when status=uncertain)' },
      proposedContent: { type: 'string', description: 'Final answer text for non-file tasks' },
    },
    required: ['status'],
  },
  category: 'control',
  sideEffect: false,
  minRoutingLevel: 0,
}
```

**`agent-worker-entry.ts` loop detection**: if any call in a `tool_calls` turn is `attempt_completion`, it is handled last and its `status` drives the terminal `WorkerTurn`:
- `status: 'done'` → emit `WorkerTurn{ type: 'done', ... }` and exit loop
- `status: 'uncertain'` → emit `WorkerTurn{ type: 'uncertain', reason: input.uncertainties[0], ... }` and exit loop

This is provider-agnostic — `end_turn` with a text message is no longer the signal for task completion; `attempt_completion` is.

> **Note:** `OrchestratorTurn` correspondingly drops `'delegation_result'` — delegation results arrive as `ToolResult` entries inside a regular `'tool_results'` turn (see §7.1 for the 3-type definition).

**Why this is simpler**: AgentLoop processes only one kind of response from the worker (`tool_calls`), and only one kind of response back (`tool_results`). The delegation mechanics are entirely encapsulated inside `ToolExecutor` via `ToolContext.onDelegate`.

### 7.3 Delegation via `ToolContext.onDelegate`

`delegate_task` is a regular entry in `BUILT_IN_TOOLS`. It delegates sub-task execution by calling back into the Orchestrator through an injected handler in `ToolContext`:

```typescript
// tool-interface.ts — extended ToolContext
interface ToolContext {
  routingLevel: RoutingLevel;
  allowedPaths: string[];
  workspace: string;
  // New: delegation handler, injected by AgentLoop at L2+. Absent at L0/L1.
  onDelegate?: (request: DelegationRequest) => Promise<ToolResult>;
}
```

**`delegate_task` tool descriptor:**

```typescript
{
  name: 'delegate_task',
  description: 'Delegate a sub-task to a separate worker. The Orchestrator governs whether delegation is permitted based on budget, scope, and safety invariants. Only available at L2+.',
  inputSchema: {
    type: 'object',
    properties: {
      delegationId: { type: 'string', description: 'Unique ID for this delegation request' },
      goal: { type: 'string', description: 'What the sub-task should accomplish' },
      targetFiles: { type: 'array', items: { type: 'string' }, description: 'Files the sub-task needs to modify (must be subset of your allowedPaths)' },
      requiredTools: { type: 'array', items: { type: 'string' }, description: 'Tools the sub-task needs (must be subset of your tool manifest, excluding shell_exec)' },
      acceptanceCriteria: { type: 'array', items: { type: 'string' }, description: 'Criteria for sub-task success' },
      maxTokenBudget: { type: 'number', description: 'Suggested token budget (Orchestrator may cap)' },
      rationale: { type: 'string', description: 'Why this sub-task should be delegated' },
    },
    required: ['delegationId', 'goal', 'requiredTools', 'rationale'],
  },
  category: 'delegation',
  sideEffect: true,
  minRoutingLevel: 2,    // L2+ only
}
```

The `delegate_task` tool's `execute()` simply calls `context.onDelegate(request)`. If `onDelegate` is absent (L0/L1), it returns `{ status: 'error', error: 'delegation not available at this routing level' }`. No special-casing in `AgentLoop`.

```typescript
interface DelegationRequest {
  delegationId: string;
  goal: string;
  targetFiles?: string[];        // must be ⊆ parent's allowedPaths (enforced by DelegationRouter)
  requiredTools: string[];       // must be ⊆ parent's toolManifest (enforced by DelegationRouter)
  acceptanceCriteria?: string[];
  maxTokenBudget?: number;       // worker proposes; Orchestrator caps
  rationale: string;
}
```

**Sub-agent workspace isolation**: when `onDelegate` fires, `DelegationRouter` enforces `request.targetFiles ⊆ parent.allowedPaths`. The sub-task's `allowedPaths` is set to exactly `request.targetFiles` — the sub-agent can only touch what was explicitly delegated. This gives the sub-agent full autonomy within its own bounded scope, without interfering with the parent agent's ongoing work.

**Delegation result as ToolResult**: the sub-task's outcome is returned to the worker as a `ToolResult.output` (JSON-encoded `DelegationOutcome`). Workers receive only the summary — full oracle verdict chains are stripped (A1 protection):

```typescript
interface DelegationOutcome {
  status: 'completed' | 'failed' | 'uncertain' | 'escalated';
  mutations: Array<{ file: string; oraclePassed: boolean }>;  // summary only
  content?: string;
  tokensConsumed: number;
  notes?: string[];
}
```

### 7.4 Verification Hints (A4 compliance)

```typescript
interface VerificationHint {
  file: string;
  contentHash: string;           // SHA-256 of file at time of tool execution
  changedSinceLastRead: boolean; // true if file was mutated between reads in this session
  accessedAt: number;            // timestamp
}
```

Workers receive these as metadata with each `tool_results` turn. They cannot modify hints.

---

## 8. Component Design

### 8.1 `AgentSession` — IPC Abstraction

```typescript
class AgentSession {
  constructor(proc: BunSubprocess, budget: AgentBudgetTracker)

  // Send a turn to the worker (writes ndjson line to stdin)
  async send(turn: OrchestratorTurn): Promise<void>

  // Read next WorkerTurn from stdout (blocks until newline)
  // Returns null if subprocess exits without writing
  async receive(): Promise<WorkerTurn | null>

  // Force close: writes terminate turn + closes stdin, waits up to 2s, then SIGKILL
  // Use for: budget_exceeded, timeout, parent_done, error
  async close(reason: 'budget_exceeded' | 'timeout' | 'parent_done' | 'error'): Promise<void>

  // Graceful close: closes stdin without sending terminate (worker already finished)
  // Use for: after receiving 'done' or 'uncertain' WorkerTurn
  async drainAndClose(): Promise<void>

  readonly alive: boolean;
  readonly pid: number;
  readonly exitCode: number | null;
}
```

**Key implementation detail**: `receive()` uses a readline reader over `proc.stdout`. Each call awaits exactly one `\n`-terminated line. The Orchestrator must not call `receive()` without having sent a turn that warrants a response.

### 8.2 `AgentBudget` — 3-Pool Budget with Negotiation (OQ-2 resolved)

Workers have meaningful influence over budget allocation while the Orchestrator retains final authority (A3). Budget is divided into three pools:

| Pool | Purpose | Worker influence |
|------|---------|-----------------|
| `base` | Guaranteed for worker's own generation turns | None — fixed at task start |
| `negotiable` | Reserve worker can request mid-task | Via `request_budget_extension` tool |
| `delegation` | Set-aside for sub-tasks | Via `DelegationRequest.maxTokenBudget` |

Default allocation by routing level:

| Level | base | negotiable | delegation |
|-------|------|------------|------------|
| L1 | 80% | 20% | 0% |
| L2 | 60% | 15% | 25% |
| L3 | 50% | 15% | 35% |

```typescript
interface AgentBudget {
  // Pool limits (set at task start, immutable)
  base: number;
  negotiable: number;
  delegation: number;
  maxTokens: number;            // = base + negotiable + delegation
  maxTurns: number;
  maxDelegationDepth: number;
  maxToolCallsPerTurn: number;
  maxDurationMs: number;
  maxExtensionRequests: number; // cap on request_budget_extension calls per session (default: 3)
  contextWindow: number;        // provider context window — for PerceptionCompressor + compressHistory
  // Tracking (mutable)
  baseConsumed: number;
  negotiableGranted: number;    // total extensions granted so far
  delegationConsumed: number;
  turnsUsed: number;
  delegationDepth: number;
  startTime: number;
  extensionRequestCount: number; // incremented on each requestExtension call
}

class AgentBudgetTracker {
  canContinue(): boolean
  canDelegate(): boolean
  recordTurn(tokensUsed: number): void

  // Called by request_budget_extension tool — deterministic rules (A3)
  requestExtension(tokens: number): { granted: number; remainingNegotiable: number } {
    // Rule 1: Cap extension requests per session (prevents Zeno drain: log₂N calls → 99% exhaustion)
    if (this.extensionRequestCount >= this.budget.maxExtensionRequests)
      return { granted: 0, remainingNegotiable: this.budget.negotiable - this.budget.negotiableGranted }
    // Rule 2: Never grant more than 50% of remaining negotiable in one request
    const cap = (this.budget.negotiable - this.budget.negotiableGranted) * 0.5
    const granted = Math.min(tokens, cap)
    // Rule 3: If negotiable pool exhausted, grant 0
    if (this.budget.negotiableGranted >= this.budget.negotiable) return { granted: 0, ... }
    this.extensionRequestCount++
    this.budget.negotiableGranted += granted
    return { granted, remainingNegotiable: this.budget.negotiable - this.budget.negotiableGranted }
  }

  // Called after delegation completes — returns unused reservation to pool
  returnUnusedDelegation(reserved: number, actual: number): void {
    const unused = Math.max(0, reserved - actual)
    this.budget.delegationConsumed -= unused
  }

  // Child budget for delegation — draws from delegation pool
  deriveChildBudget(requestedTokens?: number): AgentBudget {
    const available = this.budget.delegation - this.budget.delegationConsumed
    const childMax = Math.min(requestedTokens ?? available, available * 0.5)
    this.budget.delegationConsumed += childMax
    return buildChildBudget(childMax, this.budget.delegationDepth + 1)
  }
}
```

**`request_budget_extension` tool descriptor:**

```typescript
{
  name: 'request_budget_extension',
  description: 'Request additional tokens from the negotiable budget pool. The Orchestrator grants up to 50% of remaining negotiable tokens per request. Maximum 3 requests per session.',
  inputSchema: {
    type: 'object',
    properties: {
      tokens: { type: 'number', description: 'Number of additional tokens requested' },
      reason: { type: 'string', description: 'Why more tokens are needed' },
    },
    required: ['tokens'],
  },
  category: 'control',
  sideEffect: false,
  minRoutingLevel: 1,    // L1+ only — L0 is single-shot
}
```

The tool's `execute()` calls `budgetTracker.requestExtension(tokens)` and returns the `{ granted, remainingNegotiable }` result.

**Token pool sharing**: when a worker delegates a sub-task, the child's token consumption is deducted from the parent's `tokensConsumed`. Total tokens across the delegation tree is bounded by the root task's `maxTokens`.

### 8.3 `AgentLoop` — Turn Orchestrator

`AgentLoop.run()` replaces `WorkerPool.dispatch()` for L1+.

**v2**: AgentLoop has no delegation-specific logic. It passes a `ToolContext` with `onDelegate` injected — `ToolExecutor` handles everything uniformly. The loop is clean:

```
AgentLoop.run(input, perception, workingMemory, plan, routing, deps):

  budget  = AgentBudgetTracker.fromRouting(routing)
  session = new AgentSession(spawnAgentWorker(routing), budget)
  transcript: ConversationTurn[] = []

  // Create session overlay — worker writes land here, not in real workspace (OQ-5)
  overlay = SessionOverlay.create(workspace, input.id)

  // Build ToolContext once — overlayDir + onDelegate injected by routing level
  toolContext = {
    workspace,
    allowedPaths: input.targetFiles ?? [],
    routingLevel: routing.level,
    overlayDir: overlay.dir,                  // OQ-5: all file writes go to overlay
    onDelegate: routing.level >= 2
      ? (request) => handleDelegation(request, input, budget, deps)
      : undefined,
  }

  // Compress perception to fit context window budget (§8.9)
  const compressedPerception = PerceptionCompressor.compress(perception, budget.contextWindow)

  session.send({ type: 'init', ..., perception: compressedPerception,
                 toolManifest: manifestFor(routing), budget })

  try {
    LOOP:
      if !budget.canContinue():
        session.close('budget_exceeded')
        return timeoutResult(transcript)

      turn = await receiveWithTimeout(session, budget)  // §8.10: Promise.race with budget timeout
      if turn === null:
        return uncertainResult('subprocess exited unexpectedly', transcript)

      transcript.push(turn)
      // Prefer worker-reported tokensConsumed (exact) over Orchestrator-side estimate
      budget.recordTurn('tokensConsumed' in turn && turn.tokensConsumed != null
        ? turn.tokensConsumed
        : estimateTokens(turn))

      match turn.type:

        'tool_calls':
          // Enforce per-turn limit (A3 — deterministic cap)
          calls = turn.calls.slice(0, budget.maxToolCallsPerTurn)

          // ToolExecutor handles ALL calls uniformly — delegate_task calls context.onDelegate()
          // file_write/read/edit are overlay-aware via toolContext.overlayDir
          results = await deps.toolExecutor.executeProposedTools(calls, toolContext)

          // A6: scan all tool results for prompt injection before returning to worker
          for (const r of results) {
            if (r.output && deps.guardrails.scan(r.output).detected) {
              r.output = '[CONTENT BLOCKED: potential prompt injection]'
            }
          }

          hints = buildVerificationHints(results, workspace, overlay)
          bus.emit('agent:tools_executed', { taskId, turnId: turn.turnId, results })
          session.send({ type: 'tool_results', turnId: turn.turnId, results, verificationHints: hints })

        'done':
          // OQ-5: mutations come from overlay diff, not from turn.proposedMutations
          mutations = overlay.computeDiff()    // diff overlay vs real workspace
          // No terminate sent — worker already signalled done and will exit cleanly.
          // Just close stdin and wait; session.close() with no terminate is the correct path.
          await session.drainAndClose()
          return { mutations, content: turn.proposedContent,
                   uncertainties: turn.uncertainties, tokensConsumed: turn.tokensConsumed,
                   transcript }

        'uncertain':
          partialMutations = overlay.computeDiff()  // preserve partial work for audit
          await session.drainAndClose()             // same: no terminate needed
          return { mutations: partialMutations,
                   uncertainties: [turn.reason], isUncertain: true, transcript }

  } finally {
    // ALWAYS clean up overlay — even on unexpected errors or budget_exceeded
    overlay.cleanup()
  }

**`WorkerLoopResult` — return type of `AgentLoop.run()`:**

```typescript
interface WorkerLoopResult {
  mutations: ProposedMutation[];        // from overlay.computeDiff() — ground truth
  content?: string;                     // non-file output (from done.proposedContent)
  uncertainties: string[];              // from done.uncertainties or uncertain.reason
  isUncertain?: boolean;               // true if session ended as uncertain/timeout
  tokensConsumed: number;              // cumulative across all turns
  transcript: ConversationTurn[];      // full turn log for TraceCollector + audit
  // Union-compatible with WorkerResult:
  proposedToolCalls: [];               // always empty — tools already executed in overlay
  durationMs: number;
}
```

**Note**: `WorkerLoopResult.proposedToolCalls` is always `[]` because tools are already executed within the agentic loop (via overlay). This is the key difference from `WorkerResult` — core-loop.ts must skip Steps 4½a/5½ when receiving a `WorkerLoopResult`.

/**
 * core-loop.ts integration — what happens AFTER AgentLoop.run() returns:
 *
 * The existing core-loop pipeline continues unchanged after Step 4:
 *   - Steps 4½a/5½ are SKIPPED for agentic path (tools already executed in overlay)
 *   - Step 5: OracleGate.verify(loopResult.mutations, workspace) — A1 anchor
 *   - Post-5: PipelineConfidence + ConfidenceDecision (L1+)
 *   - Step 6: TraceCollector.record(trace including loopResult.transcript)
 *   - On verify pass: commitArtifacts(), WorldGraph fact storage, shadow enqueue
 *   - On verify pass (L2+): Critic review (WP-2), TestGenerator (WP-3)
 *   - On verify fail: AgentLoop.summarizeSession() → AgentSessionSummary
 *     → written to WorkingMemory.priorAttempts → retry at same or higher level
 *   - On uncertain: same as verify fail — escalate routing level
 *
 * WorkerLoopResult is union-compatible with WorkerResult:
 *   - mutations maps to WorkerResult.mutations
 *   - proposedToolCalls is always [] (tools already executed)
 *   - transcript is new (for TraceCollector audit)
 */

// Delegation handler — called by delegate_task tool via ToolContext
async function handleDelegation(
  request: DelegationRequest,
  parent: TaskInput,
  budget: AgentBudgetTracker,
  deps: OrchestratorDeps,
): Promise<ToolResult> {

  const decision = deps.delegationRouter.canDelegate(request, budget, parent)
  if (!decision.allowed) {
    return { callId: request.delegationId, tool: 'delegate_task', status: 'error', error: decision.reason }
  }

  // Reserve tokens from delegation pool — returns unused after child completes
  const childBudget = budget.deriveChildBudget(decision.allocatedTokens)

  // Sub-task: independent scope, fresh WorkingMemory, allowedPaths = request.targetFiles
  const subInput = buildSubTaskInput(request, parent, childBudget)
  const subResult = await deps.executeTask(subInput, deps)   // full pipeline (perceive→verify→learn)

  // Return unused delegation tokens to parent pool
  budget.returnUnusedDelegation(decision.allocatedTokens, subResult.tokensConsumed)

  bus.emit('agent:delegation_complete', { taskId: parent.id, delegationId: request.delegationId })

  // Return summary only — strip oracle verdict chains (A1: worker must not see oracle rubrics)
  return {
    callId: request.delegationId,
    tool: 'delegate_task',
    status: subResult.status === 'completed' ? 'success' : 'error',
    output: JSON.stringify(toStrippedOutcome(subResult)),
  }
}
```

### 8.4 `DelegationRouter` — A3 Governance

Rule-based, no LLM in decision path. Checks 6 invariants:

```typescript
class DelegationRouter {
  canDelegate(
    request: DelegationRequest,
    budget: AgentBudgetTracker,
    parent: TaskInput,
  ): DelegationDecision {

    // R1: Depth gate
    if (!budget.canDelegate())
      return deny('max delegation depth reached')

    // R2: Scope containment (A6: child scope ⊆ parent scope)
    if (request.targetFiles && parent.targetFiles) {
      const parentSet = new Set(parent.targetFiles)
      const escaped = request.targetFiles.filter(f => !parentSet.has(f))
      if (escaped.length > 0)
        return deny(`requested files outside parent scope: ${escaped.join(', ')}`)
    }

    // R3: Tool containment (child cannot request tools parent doesn't have)
    const parentTools = new Set(parent.toolManifest?.map(t => t.name) ?? [])
    const unknown = request.requiredTools.filter(t => !parentTools.has(t))
    if (unknown.length > 0)
      return deny(`requested tools not in parent manifest: ${unknown.join(', ')}`)

    // R4: Delegation pool sufficiency (OQ-2: check delegation pool, not total tokens)
    const reserved = request.maxTokenBudget ?? MIN_DELEGATION_TOKEN_RESERVE
    const delegationRemaining = budget.budget.delegation - budget.budget.delegationConsumed
    if (delegationRemaining < reserved)
      return deny(`insufficient delegation pool (${delegationRemaining} < ${reserved})`)

    // R5: Safety invariant check (reuse existing evolution/safety-invariants.ts)
    const safetyCheck = checkDelegationSafetyInvariants(request)
    if (!safetyCheck.safe)
      return deny(`safety invariant violated: ${safetyCheck.reason}`)

    // R6: shell_exec excluded from delegation — child uses file tools only (prevents capability creep)
    if (request.requiredTools.includes('shell_exec'))
      return deny('shell_exec cannot be delegated — child workers use file tools only')

    return { allowed: true, allocatedTokens: Math.min(reserved, delegationRemaining * 0.5) }
  }
}
```

**`DelegationDecision`:**
```typescript
type DelegationDecision =
  | { allowed: true; allocatedTokens: number }   // tokens drawn from delegation pool
  | { allowed: false; reason: string }
```

### 8.5 `agent-worker-entry.ts` — Multi-Turn Worker Subprocess

Replaces `worker-entry.ts` for L1+. The old entry is preserved for L0 and backward compatibility.

```typescript
async function main() {
  const provider = await setupProvider()

  // ① Read init turn
  const initLine = await readLine()
  const initTurn = OrchestratorInitTurnSchema.parse(JSON.parse(initLine))

  // Build initial conversation
  const history: Message[] = [
    { role: 'system', content: buildSystemPrompt(initTurn) },
    { role: 'user',   content: buildUserPrompt(initTurn) },
  ]

  let totalTokens = 0
  let turnId = 0
  let compressionAttempts = 0          // OQ-3: context compression recovery
  const MAX_COMPRESSION_ATTEMPTS = 2
  const MIN_CONTINUATION_TOKENS = 1000

  // ② Event loop
  while (true) {
    // OQ-3 Proactive: compress history at 75% of provider context window — before hitting wall
    if (compressionAttempts < MAX_COMPRESSION_ATTEMPTS &&
        estimateHistoryTokens(history) > provider.contextWindow * 0.75) {
      history = compressHistory(history)
      compressionAttempts++
    }

    // Generate next response
    const response = await provider.generate({
      messages: history,
      tools: initTurn.toolManifest,
      maxTokens: remainingTokens(initTurn.budget, totalTokens),
    })
    totalTokens += response.tokensUsed.input + response.tokensUsed.output

    // Append assistant response to history
    history.push({
      role: 'assistant',
      content: response.content,
      toolCalls: response.toolCalls,
    })

    // OQ-3 Reactive: response was cut off mid-generation
    if (response.stopReason === 'max_tokens') {
      const budgetRemaining = remainingTokens(initTurn.budget, totalTokens)
      if (compressionAttempts < MAX_COMPRESSION_ATTEMPTS && budgetRemaining > MIN_CONTINUATION_TOKENS) {
        // Compress history + inject continuation prompt — re-enter loop
        history = compressHistory(history)
        history.push({ role: 'user', content: CONTEXT_COMPRESSION_CONTINUATION_PROMPT })
        compressionAttempts++
        continue
      }
      // Budget exhausted or compression limit reached — emit uncertain with partial overlay
      writeTurn({
        type: 'uncertain',
        turnId: `t${turnId++}`,
        reason: `max_tokens: context exhausted after ${compressionAttempts} compression attempt(s)`,
      })
      break
    }

    if (response.stopReason === 'tool_use' && response.toolCalls.length > 0) {
      // Check for attempt_completion — the structured terminal signal
      const completionCall = response.toolCalls.find(c => c.name === 'attempt_completion')

      // Emit tool_calls for all non-completion calls first
      const regularCalls = response.toolCalls.filter(c => c.name !== 'attempt_completion')
      if (regularCalls.length > 0) {
        writeTurn({
          type: 'tool_calls',
          turnId: `t${turnId++}`,
          calls: regularCalls,
          // rationale: from thinking block (Anthropic extended thinking) or text content
          rationale: response.thinking ?? extractThought(response.content),
          tokensConsumed: totalTokens,  // cumulative — enables Orchestrator budget tracking
        })

        // Wait for results
        const resultLine = await readLine()
        const resultTurn = OrchestratorResultTurnSchema.parse(JSON.parse(resultLine))
        if (resultTurn.type === 'terminate') break
        if (resultTurn.type !== 'tool_results') break

        // Tool results are already guardrails-scanned by AgentLoop (Orchestrator side).
        // Worker receives sanitized results — no prompt injection reaches history.
        history.push(buildToolResultMessage(resultTurn))
      }

      // attempt_completion drives terminal turn (after other tool results appended)
      if (completionCall) {
        const input = completionCall.input as { status: 'done' | 'uncertain'; summary?: string; uncertainties?: string[]; proposedContent?: string }
        if (input.status === 'done') {
          writeTurn({
            type: 'done',
            turnId: `t${turnId++}`,
            proposedContent: input.proposedContent ?? input.summary,
            uncertainties: [],
            tokensConsumed: totalTokens,
          })
        } else {
          writeTurn({
            type: 'uncertain',
            turnId: `t${turnId++}`,
            reason: input.uncertainties?.[0] ?? 'worker signalled uncertain via attempt_completion',
          })
        }
        break
      }

    } else {
      // end_turn without attempt_completion — treat as done (fallback)
      // OQ-5: worker does NOT extract mutations — overlay diff is computed by AgentLoop
      writeTurn({
        type: 'done',
        turnId: `t${turnId++}`,
        proposedContent: response.content,
        uncertainties: [],
        tokensConsumed: totalTokens,
      })
      break
    }
  }
}
```

---

### 8.6 Session Overlay — Staged Writes (OQ-5 resolved)

**Problem**: forcing workers to hold all file content until `done` causes (1) no read-after-write, (2) high context pressure, (3) confused LLM when `file_write` says "success" but reading back returns old content. Writing to the real workspace during the loop makes the workspace dirty before oracle verification and complicates rollback.

**Solution**: per-task session overlay directory. Workers write freely to the overlay; the real workspace is untouched until oracle verification passes.

```
workspace/                              ← real workspace — never touched during loop
workspace/.vinyan/sessions/{taskId}/
  overlay/                              ← worker's writes land here
    src/parser.ts
    src/utils.ts
```

**Copy-on-write semantics**:

| Tool | With overlay | Notes |
|------|-------------|-------|
| `file_write` | Writes to `overlay/{path}` | Not workspace |
| `file_read` | `overlay/{path}` first → fallback `workspace/{path}` | Worker sees own writes |
| `file_edit` | Read overlay-or-workspace; write `overlay/{path}` | Consistent CoW |
| `directory_list` | Merges overlay + workspace listings | Includes new overlay files |
| `file_delete` | Creates `overlay/{path}/.wh` tombstone | `computeDiff()` emits deletion mutation |
| `shell_exec` (**L1/L2 subprocess**) | **Read-only whitelist only** — `grep`, `find`, `cat`, `ls`, `git log`, `git diff`, `git status` | Mutation commands → error; `git checkout/stash/commit/add` are **blocked** |
| `shell_exec` (**L3 container**) | Runs inside Docker container where overlay is mounted as root fs | Full shell, overlay-isolated |

Worker experiences a consistent virtual filesystem. Write `foo.ts`, read it back, see own write. Multi-step work (write `parser.ts`, read it to inform `ast.ts` that imports it) works correctly.

**`shell_exec` read-only constraint rationale (A1/A6)**: at L1/L2 subprocess, shell runs in the real workspace. Allowing mutation commands (`sed -i`, `mv`, `rm`, `git commit`, `git checkout`) would bypass the overlay entirely and violate A6. Additionally, running `bun test` or `tsc` in the agentic loop would allow the worker to evaluate its own output before Oracle Gate — a subtle A1 violation. Verification tools are reserved for Oracle Gate only.

**Optimistic Concurrency Control (OCC) at commit time**: each `ProposedMutation` carries a `baseContentHash: string` (SHA-256 of the file at session start). `commitArtifacts()` re-reads the file and verifies the hash before writing. If a concurrent session has modified the file in the meantime, the commit is rejected — the task is marked `uncertain` and retried. This satisfies A4 (content-addressed truth).

**At `done`**: `AgentLoop` calls `computeOverlayDiff(overlayDir, workspace)` → produces `ProposedMutation[]`. Oracle Gate verifies this diff (pre-commit — A1 preserved). `commitArtifacts()` (already exists in `artifact-commit.ts`) applies overlay → workspace if passed. Overlay deleted regardless of outcome.

**`proposedMutations` in `done` turn** → **optional metadata**. Worker says "done"; Orchestrator knows what changed from the diff:

```typescript
// WorkerTurn 'done' — v3
{
  type: 'done';
  turnId: string;
  proposedMutations?: ProposedMutation[];  // optional: explanations only
  proposedContent?: string;
  uncertainties: string[];
  tokensConsumed: number;
}
```

**`ToolContext` extension** (one field added):
```typescript
interface ToolContext {
  routingLevel: RoutingLevel;
  allowedPaths: string[];
  workspace: string;
  overlayDir?: string;    // present for L1+ agentic sessions; absent for single-shot L0
  onDelegate?: (request: DelegationRequest) => Promise<ToolResult>;
}
```

**Rollback**: delete overlay directory. Zero writes to real workspace to undo.

**Backward compatibility**: `worker-entry.ts` (single-shot L0) has no `overlayDir`; `proposedMutations`-in-response path unchanged.

---

### 8.7 Context Compression Recovery (OQ-3 resolved)

**What other tools do:**

| Tool | Approach | Weakness |
|------|----------|----------|
| Claude Code | `auto-compact`: LLM call to summarize conversation | Reactive only; extra LLM cost; non-deterministic output |
| SWE-agent/OpenHands | Append "Please continue" message | Can loop infinitely if context genuinely exhausted |
| VS Code Copilot | Single-turn, avoids problem via small targeted prompts | Not applicable to agentic loops |

**Vinyan's approach — two improvements:**

1. **Proactive trigger at 75% context pressure** — check before each LLM call. Never hits the wall reactively if the history can be compressed early.

2. **Deterministic compression algorithm** — no extra LLM call. Compress the middle of the conversation structurally, preserving the last 3 turns verbatim for immediate coherence.

**`contextWindow` source**: `agent-worker-entry.ts` reads `initTurn.budget.contextWindow` — the Orchestrator populates this from model metadata when building `AgentBudget`. This avoids requiring workers to know the LLM's context limits.

**`compressHistory(history)` algorithm — landmark-aware:**

```
Input:  history = [system, init, turn_2, turn_3, ..., turn_N]

Keep verbatim:
  history[0]  — system message (immutable)
  history[1]  — init user message (task + perception)   ← see §8.9 for init compression
  history[N-3..N] — last 3 turns (immediate context)

Classify middle turns [2..N-4] by landmark status:
  LANDMARK (keep 500 chars):
    - tool result where status === 'error'   (errors are high signal)
    - file_write result                       (successful mutations are milestones)
    - delegation result                       (sub-task outcomes are turning points)
  NON-LANDMARK (keep 100 chars):
    - file_read, search results               (reference data, low signal once seen)
    - successful shell results                (environmental observations)
    - reasoning turns                         (intermediate thoughts)

Format each compressed turn:
  assistant+tool_calls: "[Turn {i}] Called: {toolNames}. Rationale: {rationale.slice(0, landmarkLen)}"
  tool result:          "[Turn {i}] {toolName}: {ok|error} — {output.slice(0, landmarkLen)}"

Combine into a SINGLE USER MESSAGE (not assistant — to preserve Anthropic/OpenAI alternation):
  "[COMPRESSED CONTEXT: {N} turns]\n{compressed_lines}\n---"

Return: [system, init, compressed_user_block, ...last3]
```

**Critical**: the compressed block MUST be `role: 'user'`, not `role: 'assistant'`. Inserting an `assistant` message before `last3` would create two consecutive `assistant` messages, which Anthropic and OpenAI APIs reject with 400.

**Why this is better than Claude Code:**
- **No extra LLM call** — deterministic O(N) processing, no API cost
- **Proactive** — triggered at 75% context pressure, before hitting the wall
- **Landmark-aware** — errors and file_write milestones get 5× more context than routine observations
- **Coherent tail** — last 3 turns verbatim; LLM sees immediate tool chain without confusion
- **Budget-aware** — distinguishes context window pressure from token budget exhaustion
- **Bounded** — max 2 compressions prevents pathological loops

**`CONTEXT_COMPRESSION_CONTINUATION_PROMPT`:**
```
The conversation history above has been compressed to fit within context limits.
The [COMPRESSED CONTEXT] block summarizes prior turns. Continue the task from where you left off.
```

**Reactive recovery flow:**
```
max_tokens received
    │
    ├─ compressionAttempts < 2 AND budgetRemaining > 1000?
    │    YES → compressHistory() + inject continuation prompt → continue loop
    │    NO  → emit WorkerTurn{ type: 'uncertain', reason: 'context exhausted' }
    │          AgentLoop calls overlay.computeDiff() → partial mutations preserved
    │          AgentLoop escalates to higher routing level
    └─ done
```

---

### 8.7.1 Transcript Compaction — Evidence/Narrative Classification (EO #5)

> **Added:** 2026-04-03 | **Axiom:** A2 (First-Class Uncertainty) | **Status:** ✅ Implemented

§8.7 handles *context window pressure* (deterministic mid-conversation compression). This section handles a complementary problem: **long-running sessions accumulate turns that have different epistemic value**. Some turns are evidence (tool results, oracle decisions, error outputs) — losing these degrades future reasoning. Others are narrative (intermediate thinking, exploration, discarded approaches) — these can be summarized without information loss.

**Two-track model:**

| Track | Examples | Treatment |
|-------|----------|-----------|
| **Evidence** (immutable) | Tool invocations, file reads, oracle verdicts, error outputs, delegation results | Never compressed; kept verbatim |
| **Narrative** (compactable) | Reasoning turns, analysis, exploration, "let me think about..." | Summarized by LLM into ~200-token digest |

**Implementation:**

```
partitionTranscript(turns: ConversationTurn[])
  → { evidenceTurns, narrativeTurns, compactedNarrativeTurns, estimatedSavings }

buildCompactedTranscript(turns, narrativeSummary)
  → ConversationTurn[]  // evidence preserved, narrative replaced with summary
```

**Trigger in `AgentLoop`** (`agent-loop.ts`):
- After each turn, check `partition.compactedNarrativeTurns > 2` AND `compactionLlm` available
- If triggered: LLM summarizes narrative turns → `buildCompactedTranscript()` replaces history
- Emits `agent:transcript_compaction` event with turn counts and token savings
- Non-fatal: compaction failure continues with uncompacted transcript

**Why separate from §8.7 compression:**
- §8.7 is **reactive** (triggered at 75% context pressure) and **deterministic** (no LLM call)
- §8.7.1 is **proactive** (triggered by turn accumulation) and **LLM-assisted** (narrative summary)
- Both can apply: §8.7.1 first (reduce narrative), §8.7 later if still over context budget
- §8.7 treats all middle turns equally; §8.7.1 distinguishes evidence from narrative

**Key files:** `src/orchestrator/worker/transcript-compactor.ts`, `src/orchestrator/worker/agent-loop.ts` L264-293

---

### 8.8 `AgentSessionSummary` — Retry Context Prompt Pattern (OQ-4 resolved)

When a session ends as `uncertain` or when Oracle Gate fails, `AgentLoop` builds an `AgentSessionSummary` and stores it in `WorkingMemory.priorAttempts` for the next retry. The full transcript goes to `TraceCollector` → Sleep Cycle (cross-task learning).

**Why compressed summary, not full transcript**: full `ConversationTurn[]` from a 15-turn session with file_read results easily exceeds 50 KB. Injecting this into the retry worker's context window crowds out the actual task and wastes token budget. A structured summary at ~150 tokens/attempt gives the retry worker exactly what it needs: what was tried, why it failed, and what to do differently.

```typescript
interface AgentSessionSummary {
  sessionId: string;
  attempt: number;           // ordinal: 1 = first try, 2 = first retry, ...
  outcome: 'uncertain' | 'max_tokens' | 'timeout' | 'oracle_failed';
  // What happened
  filesRead: string[];       // from VerificationHints.file (accessed paths)
  filesWritten: string[];    // from overlay.computeDiff() file list (attempted mutations)
  turnsCompleted: number;
  tokensConsumed: number;
  // Why it stopped
  failurePoint: string;      // e.g. "max_tokens after 12 turns", "oracle: TypeCheckFailed in parser.ts:42"
  lastIntent: string;        // last tool_calls.rationale or extractThought(done.proposedContent)
  uncertainties: string[];   // from uncertain.reason or done.uncertainties
  suggestedNextStep?: string; // from uncertain turn context or extracted from final content
}
```

**Prompt injection into `WorkingMemoryState`:**

`AgentLoop` writes `AgentSessionSummary` into `workingMemory.priorAttempts: AgentSessionSummary[]`. `agent-worker-entry.ts` renders these into `buildUserPrompt()`:

```
{{#each priorAttempts}}
### Prior Attempt #{{attempt}}
Outcome: {{outcome}} — {{failurePoint}}
Files read: {{filesRead.join(', ') || 'none'}}
Files modified: {{filesWritten.join(', ') || 'none'}}
Last intent: "{{lastIntent.slice(0, 200)}}"
Stopped because: {{uncertainties[0] || 'unknown'}}
{{#if suggestedNextStep}}Try next: {{suggestedNextStep.slice(0, 150)}}{{/if}}
---
{{/each}}
```

**Token budget**: ~150 tokens × up to 3 retries (L1→L2→L3 escalation) = ~450 tokens of prior context. Negligible against typical L2/L3 budgets.

**Data flows and ownership:**

```
AgentLoop.run() returns WorkerLoopResult{mutations, transcript, isUncertain, ...}
  │
  └─ core-loop.ts receives the result
       │
       ├─ IF isUncertain OR OracleGate fails:
       │    buildAgentSessionSummary(loopResult, oracles?) → AgentSessionSummary
       │    workingMemory.priorAttempts.push(summary)
       │    retry at higher routing level with updated workingMemory
       │
       ├─ Full transcript → TraceCollector.record() (audit log + Sleep Cycle)
       │
       └─ AgentSessionSummary → also stored in trace for cross-attempt analysis
```

**Ownership clarification**: `AgentLoop` does NOT write to `WorkingMemory` directly. It returns `WorkerLoopResult` containing all the data needed to build the summary. `core-loop.ts` calls `buildAgentSessionSummary()` and mutates `WorkingMemory` — keeping AgentLoop stateless and pure.

**Progressive anti-repetition**: at retry #2, the worker sees that attempt #1 tried approach X and failed at Y. At retry #3, it sees #1 and #2. This creates a natural "don't repeat mistakes" gradient without any LLM-specific mechanism — just structured context injection.

---

### 8.9 `PerceptionCompressor` — Init Message Budget Control

**Problem**: `PerceptualHierarchy` for large codebases can exceed 4,000 tokens (dep-cone with hundreds of files, full lint diagnostics, World Graph facts). `compressHistory` preserves the init message verbatim — if the init itself is large, the available window for the actual conversation shrinks dramatically. For L3 tasks with 30 turns, context overflow can happen on turn 1 before any real work is done.

**Solution**: `PerceptionCompressor.compress(perception, contextWindow)` applied at `AgentLoop` init, before the session starts. Target: init user message ≤ `contextWindow * 0.30`.

**Truncation priority** (highest signal first, lowest discarded first):

| Data | Priority | Truncation rule |
|------|----------|-----------------|
| World Graph facts for target files | 1 — keep all | Never truncate |
| Direct imports of target files (`directImportees`) | 2 — keep all | Never truncate |
| Type errors / lint errors on target files | 3 — keep top 10 | By proximity to target path |
| `dependencyCone.directImporters` | 4 — keep top 20 | By import count descending |
| `verifiedFacts` (non-target) | 5 — keep top 10 | By confidence descending |
| `dependencyCone.transitiveImporters` | 6 — omit, keep count | Replace with "N transitive importers" |
| Full lint/type warnings (non-errors) | 7 — omit | Replace with "N warnings" |

**`AgentBudget` extension**:
```typescript
interface AgentBudget {
  // ... existing fields
  contextWindow: number;  // provider context window — populated by Orchestrator from model metadata
}
```

`AgentLoop` calls `PerceptionCompressor.compress(perception, budget.contextWindow)` and passes the result to `buildUserPrompt()`. The compression is deterministic and logged to the EventBus for audit.

---

### 8.10 `AgentSession` State Machine

`AgentSession` must enforce the strict-alternation protocol. Calling `send()` or `receive()` in the wrong state throws immediately, making bugs obvious rather than causing silent hangs:

```typescript
type AgentSessionState = 'INIT' | 'WAITING_FOR_WORKER' | 'WAITING_FOR_ORCHESTRATOR' | 'CLOSED'

class AgentSession {
  private state: AgentSessionState = 'INIT'

  async send(turn: OrchestratorTurn): Promise<void> {
    if (this.state !== 'INIT' && this.state !== 'WAITING_FOR_ORCHESTRATOR')
      throw new Error(`AgentSession.send() called in state ${this.state}`)
    this.state = 'WAITING_FOR_WORKER'
    // write ndjson line to stdin
  }

  async receive(): Promise<WorkerTurn | null> {
    if (this.state !== 'WAITING_FOR_WORKER')
      throw new Error(`AgentSession.receive() called in state ${this.state}`)
    // readline — blocks until \n or EOF
    const line = await this.readline()
    if (line === null) { this.state = 'CLOSED'; return null }
    const parsed = parseWorkerTurn(line)  // Zod validation; returns null on error
    this.state = 'WAITING_FOR_ORCHESTRATOR'
    return parsed
  }

  async close(reason: TerminateReason): Promise<void> {
    if (this.state === 'CLOSED') return
    // Phase 1: write terminate + close stdin
    // Phase 2: await proc.exited with 2s timeout
    // Phase 3: proc.kill(SIGKILL) if still alive
    // Phase 4: drain any remaining stdout/stderr to audit log
    this.state = 'CLOSED'
  }
}
```

**`receive()` timeout**: `AgentLoop` must use `Promise.race([session.receive(), timeoutPromise])` — not bare `receive()` — to guard against a hung worker that crashes mid-write without closing stdout:

```typescript
const receiveWithTimeout = () => Promise.race([
  session.receive(),
  new Promise<null>(r => setTimeout(() => r(null), remainingMs(budget))),
])
```

**Worker stdout discipline**: `agent-worker-entry.ts` MUST NOT write to stdout except via `writeTurn()`. Any debug output goes to stderr. Violation breaks the framing protocol.

---

## 9. ToolDescriptor — Formal Tool Schema

Currently `Tool` in `tool-interface.ts` has `execute()` but no formal JSON schema for LLM consumption. AWP requires all tools to declare their input schema:

```typescript
// Extend tool-interface.ts
interface ToolDescriptor {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description: string; enum?: string[] }>;
    required: string[];
  };
  category: ToolCategory | 'delegation';
  sideEffect: boolean;
  minRoutingLevel: RoutingLevel;
}

// Each Tool in built-in-tools.ts gains a descriptor() method:
interface Tool {
  // ... existing fields
  descriptor(): ToolDescriptor;
}
```

`manifestFor(routing: RoutingDecision): ToolDescriptor[]` builds the authorized tool list per routing level (see Capability Matrix).

---

## 10. LLMRequest Extension

Add `messages[]` for multi-turn. Single-turn fields (`systemPrompt`, `userPrompt`) remain for backward compatibility:

```typescript
interface LLMRequest {
  // Single-turn (backward compat — worker-entry.ts still uses these)
  systemPrompt?: string;
  userPrompt?: string;
  // Multi-turn (agent-worker-entry.ts uses this)
  messages?: Message[];
  // Existing
  maxTokens: number;
  temperature?: number;
  tools?: ToolDescriptor[];  // upgraded from anonymous object to ToolDescriptor
}

interface LLMResponse {
  content: string;
  thinking?: string;           // Anthropic extended thinking block — used as rationale source
  toolCalls: ToolCall[];
  tokensUsed: { input: number; output: number };
  stopReason: 'end_turn' | 'tool_use' | 'max_tokens';
}

interface Message {
  role: 'system' | 'user' | 'assistant';
  content: string | MessageContentBlock[];  // string for simple turns; blocks for tool use
  toolCalls?: ToolCall[];    // assistant turn with tool_use blocks
}

// Tool result messages use a dedicated type to avoid role confusion
interface ToolResultMessage {
  role: 'tool_result';       // canonical — providers normalize to their format
  toolCallId: string;        // references ToolCall.id from the preceding assistant message
  content: string;
  isError?: boolean;
}

type HistoryMessage = Message | ToolResultMessage;
```

### 10.1 Provider Message Format Mapping

This is the largest single implementation task in Phase 6.0. Each provider has structurally incompatible formats. `provider-format.ts` is the normalization layer — `agent-worker-entry.ts` builds canonical `HistoryMessage[]`; each provider's `generate()` calls `normalizeMessages(messages, providerFamily)` before the API call.

| Canonical | Anthropic | OpenAI / OpenRouter |
|-----------|-----------|---------------------|
| `role: 'assistant'` + `toolCalls[]` | `role: 'assistant'`, `content: [{ type: 'tool_use', id, name, input }]` | `role: 'assistant'`, `tool_calls: [{ id, type: 'function', function: { name, arguments } }]` |
| `role: 'tool_result'` | `role: 'user'`, `content: [{ type: 'tool_result', tool_use_id, content }]` | `role: 'tool'`, `tool_call_id`, `content` |
| `thinking?: string` | `content: [{ type: 'thinking', thinking }, { type: 'text', text }]` | N/A (discard thinking for OpenAI-compat) |

**Tool call ID correlation**: each `ToolCall` in an assistant message has a provider-assigned `id`. The subsequent `ToolResultMessage.toolCallId` MUST reference that exact `id`. `buildToolResultMessage(resultTurn)` must map `ToolResult[i]` to `originalCalls[i].id` using the turn's call list. This is the most common implementation error — specify it as a test case requirement.

**Batch tool results (OQ-6)**: multiple tool results for a single turn are encoded as:
- **Anthropic**: single `role: 'user'` message with multiple `tool_result` content blocks
- **OpenAI**: multiple separate `role: 'tool'` messages in sequence

---

## 11. Capability Matrix

This table is the A3 governance anchor. Values are constants, not runtime decisions:

| Level | Worker Mode | Allowed Categories | Max Turns | Delegation | Max Depth | Max Calls/Turn | `shell_exec` mode |
|:---:|:---:|---|:---:|:---:|:---:|:---:|:---:|
| **L0** | Single-shot (`worker-entry.ts`) | — | 1 | No | 0 | 0 | N/A |
| **L1** | Agentic, read-only tools | `file_read`, `search`, `vcs`, `shell`¹, `control` | 5 | No | 0 | 3 | **Read-only whitelist** |
| **L2** | Agentic, all tools | + `file_write`, `delegation` | 15 | Yes | 1 | 5 | **Read-only whitelist** |
| **L3** | Agentic, all tools | + full `shell` | 30 | Yes | 3 | 10 | **Container (overlay-mounted)** |

¹ `shell` at L1/L2 is read-only whitelist only (grep, find, cat, ls, git read commands). Mutation commands are blocked.

`control` category includes `attempt_completion` and `request_budget_extension` — available at all agentic levels (L1+). L0 uses single-shot protocol — no tool loop, no `control` tools.

**`shell_exec` read-only whitelist** (L1/L2 subprocess): `grep`, `find`, `cat`, `head`, `tail`, `ls`, `git log`, `git diff`, `git status`, `git show`, `git blame`. All other commands → `{ status: 'error', output: 'command not permitted in subprocess mode' }`. Blocked specifically: `git checkout`, `git stash`, `git commit`, `git add`, `git reset`, `mv`, `rm`, `cp`, `sed -i`, `tsc`, `bun test`, `eslint`, `ruff` (verification tools reserved for Oracle Gate).

`AgentBudget` defaults are derived from this table. Operators can lower them via `vinyan.config.json` but cannot exceed these maximums (safety invariant).

---

## 12. A1 Compliance Analysis in the Agentic Loop

### Tool Results Are Facts, Not Evaluations

> *A1: Generation and verification are performed by different components. No engine evaluates its own output.*

Tool results (`file_read` output, `shell_exec` output) are **raw facts** produced by the environment, not evaluations of the worker's generated content. The worker receives them as observations, not verdicts. A1 is not violated.

The A1 boundary holds because: *the thing being verified by Oracle Gate is the worker's proposed mutations*. Tool results are inputs to generation, not outputs from verification.

**`shell_exec` and the A1 boundary**: if the worker could call `bun test` or `tsc --noEmit` during the agentic loop, it would be evaluating its own output through a tool-mediated path. The worker could iterate until "tests pass" — effectively running its own verification pass before Oracle Gate. To prevent this, verification tools (`bun test`, `tsc`, `eslint`, `ruff`) are **excluded from the agentic loop manifest** at all levels. Oracle Gate is the only component authorized to run tests and type checks. This is a hard constraint enforced by the capability matrix, not just a convention.

**Prompt injection via tool results**: tool results are facts about the environment, but they may contain adversarial content (a `file_read` returning a file with injected instructions). All tool results pass through `guardrails.scan(result.output)` before being injected into conversation history. If injection is detected, the result is replaced with `[CONTENT BLOCKED: potential prompt injection]`. This is an Orchestrator-side enforcement point — workers cannot bypass it.

### The Subtle Risk: Delegation Cherry-Picking

If a worker delegates a sub-task and receives back the full `OracleVerdict` chain, it could:
- Adjust its final answer based on what oracles look for
- Effectively "learn" oracle rubrics through delegation feedback

**Mitigation**: `DelegationOutcome` strips oracle verdicts. Workers see only `{ oraclePassed: boolean }` summary. Full verdicts remain in Orchestrator-owned `TaskResult` for audit.

### Final Verification Unchanged

Oracle Gate runs on the **overlay diff** (computed mutations) — regardless of how many tool turns or delegations occurred, and regardless of what the `done` turn's optional `proposedMutations` contains. The overlay is the ground truth; the `done` turn is a signal, not the data source. This is the A1 enforcement point and is architecturally non-negotiable.

---

## 13. Data Flow — Sequence Diagrams

Protocol has 3 `WorkerTurn` types (`tool_calls` | `done` | `uncertain`) and 3 `OrchestratorTurn` types (`init` | `tool_results` | `terminate`). Delegation is indistinguishable from regular tool calls at the protocol level — the `delegate_task` tool is handled inside `ToolExecutor`.

### 13.1 Complete Pipeline — Agentic Path (L1+)

```
User
  │
  ▼
Orchestrator.executeTask(input)
  │
  │  [Outer loop: escalation L0 → L1 → L2 → L3]
  │  [Inner loop: retries within each level]
  │
  ├─ (pre) Skill Shortcut (L0/L1): skillManager.match() → inject cached hypothesis
  │
  ├─ ① Perceive: perception.assemble(input, routing.level) → PerceptualHierarchy
  ├─ ② Predict (L2+): selfModel.predict(input, perception) → SelfModelPrediction
  ├─ ②½ SelectWorker (Phase 4): workerSelector.selectWorker(fingerprint, ...)
  │     └─ if maxCapability < 0.3 → uncertain (A2: fleet abstains)
  ├─ ③ Plan (L2+): decomposer.decompose(input, perception, memory) → TaskDAG
  ├─ ③½ ApprovalGate: if riskScore ≥ 0.8 → human approval required (A6)
  │
  │  ┌───────────────────────────────────────────────────────────────────────┐
  │  │ ④ AgentLoop.run(input, compressedPerception, memory, plan, routing)  │
  │  │                                                                      │
  │  │  perception = PerceptionCompressor.compress(perception, contextWindow)│
  │  │  overlay = SessionOverlay.create(workspace, taskId)                  │
  │  │                                                                      │
  │  │  try {                                                               │
  │  │    [spawn agent-worker-entry subprocess]                             │
  │  │                                                                      │
  │  │    ──── OrchestratorTurn{init, toolManifest, budget} ──────────►│    │
  │  │                                                                 │    │
  │  │    LOOP:                                                        │    │
  │  │    │◄──── WorkerTurn{tool_calls:[file_read,...]} ───────────────│    │
  │  │    │  guardrails.scan(results)  ← A6: sanitize before return   │    │
  │  │    │  ToolExecutor.execute(calls, toolContext{overlayDir})      │    │
  │  │    │──── OrchestratorTurn{tool_results, verificationHints} ────►│    │
  │  │    │                                                            │    │
  │  │    │◄──── WorkerTurn{tool_calls:[delegate_task(...)]} ──────────│    │
  │  │    │  ToolExecutor → toolContext.onDelegate(request)            │    │
  │  │    │    DelegationRouter.canDelegate() [6 invariants — A3]      │    │
  │  │    │    budget.deriveChildBudget(allocatedTokens)               │    │
  │  │    │    └─ executeTask(subInput) ← full pipeline, isolated      │    │
  │  │    │       subInput.allowedPaths = request.targetFiles only     │    │
  │  │    │    budget.returnUnusedDelegation(reserved, actual)         │    │
  │  │    │  result → DelegationOutcome (stripped — A1) → ToolResult   │    │
  │  │    │──── OrchestratorTurn{tool_results:[delegation outcome]} ──►│    │
  │  │    │                                                            │    │
  │  │    TERMINAL CONDITIONS (one of):                                │    │
  │  │    │◄──── WorkerTurn{done} [via attempt_completion tool] ───────│    │
  │  │    │   overlay.computeDiff() → ProposedMutation[]               │    │
  │  │    │   session.drainAndClose()  ← no terminate, worker already done │    │
  │  │    │   → returns WorkerLoopResult{mutations, transcript}        │    │
  │  │    │                                                            │    │
  │  │    │◄──── WorkerTurn{uncertain} [attempt_completion|max_tokens]─│    │
  │  │    │   overlay.computeDiff() → partialMutations (audit only)    │    │
  │  │    │   session.drainAndClose()  ← no terminate, worker already done │    │
  │  │    │   → returns WorkerLoopResult{mutations, isUncertain, ...}  │    │
  │  │    │                                                            │    │
  │  │    budget.canContinue() == false:                               │    │
  │  │    │   session.close('budget_exceeded') ──terminate─────────►│  │    │
  │  │    │   → returns timeoutResult(transcript)                      │    │
  │  │    │                                                            │    │
  │  │    session.receive() == null (subprocess crash):                │    │
  │  │    │   → returns uncertainResult('subprocess exited', ...)      │    │
  │  │                                                                      │
  │  │  } finally { overlay.cleanup() }   ← ALWAYS: no stale overlays      │
  │  └───────────────────────────────────────────────────────────────────────┘
  │
  │  [Steps 4½a / 5½ SKIPPED for agentic path — tools already executed in overlay]
  │
  ├─ ⑤ OracleGate.verify(mutations, workspace)         ← A1 anchor: always runs
  │     ├─ Guardrails → Risk assessment → Oracle dispatch (AST, Type, Dep, Test, Lint)
  │     ├─ Conflict resolution → Epistemic decision → QualityScore
  │     └─ PipelineConfidence + ConfidenceDecision (L1+): allow | re-verify | escalate | refuse
  │
  ├─ ⑥ Learn: TraceCollector.record(trace + transcript)
  │     └─ selfModel.calibrate(prediction, trace) — adaptive EMA per task type
  │
  │  ON VERIFY PASS:
  │  ├─ Critic review (WP-2, L2+): criticEngine.review(proposal)
  │  ├─ TestGenerator (WP-3, L2+): testGenerator.generateAndRun()
  │  ├─ Probation check (I10): if worker on probation → shadow-only, no commit
  │  ├─ commitArtifacts(workspace, mutations) — 5-step path safety + OCC hash check (A4)
  │  ├─ WorldGraph.storeFacts(committed files + content hashes) — A4
  │  └─ ShadowRunner.enqueue(task) — async post-commit validation (Phase 2.2)
  │
  │  ON VERIFY FAIL / UNCERTAIN:
  │  ├─ AgentLoop.summarizeSession() → AgentSessionSummary (~150 tokens)
  │  ├─ → written to WorkingMemory.priorAttempts (anti-repetition context)
  │  ├─ workingMemory.addFailedApproach(...)
  │  └─ continue inner loop (retry) or escalate routing level (outer loop)
  │
  └─ All levels exhausted → TaskResult{status: 'escalated'}
```

### 13.2 Single-Shot Path (L0) — Unchanged

```
Orchestrator.executeTask(input)
  │
  ├─ ① Perceive
  ├─ ④ WorkerPool.dispatch(input, perception, memory, plan, routing)
  │     └─ L0: returns empty result (no LLM call, hash-only verify)
  ├─ ⑤ OracleGate.verify(mutations) — hash-only at L0, < 100ms
  └─ ⑥ TraceCollector.record(trace)
```

### 13.3 Retry & Escalation Flow

```
                       ┌──────────────────────────────────┐
                       │                                  │
  executeTask ──► L0 ──┤ verify fail?                     │
                  │    │   YES → inject AgentSessionSummary│
                  │    │         into WorkingMemory        │
                  │    │         escalate to L1            │
                  │    └───────────────────────────┬───────┘
                  │                                │
                  ▼                                ▼
               L1 (retry with prior context) ──► L2 ──► L3
                                                         │
                                                         ▼
                                               TaskResult{status:'escalated'}

Each level: up to maxRetries attempts (inner loop).
Each retry: sees all prior AgentSessionSummary entries (progressive anti-repetition).
```

---

## 14. Migration Plan

### Phase 6.0 — Protocol Foundation (no behavior change)

1. Extend `protocol.ts`: add `OrchestratorTurnSchema`, `WorkerTurnSchema`, `DelegationRequestSchema`, `AgentBudgetSchema` (including `contextWindow` field)
2. Extend `types.ts`: add `Message`, `ToolResultMessage`, `HistoryMessage`, `ConversationTurn`, `LLMResponse.thinking`, `AgentSessionSummary`; extend `WorkingMemoryState` with `priorAttempts?: AgentSessionSummary[]`
3. Extend `tool-interface.ts`: add `ToolDescriptor`, `'delegation'`/`'control'` `ToolCategory`, `overlayDir` + `onDelegate` in `ToolContext`
4. Add `descriptor()` to each tool in `built-in-tools.ts`; add `attempt_completion`, `request_budget_extension`, and `delegate_task` tool descriptors
5. Implement `provider-format.ts`: `normalizeMessages()` for Anthropic and OpenAI-compat formats (see §10.1 — this is the largest step in Phase 6.0)
6. Extend `openrouter-provider.ts` + `anthropic-provider.ts`: support `messages[]` via `normalizeMessages()`; extract `thinking` block from Anthropic response

**Exit criteria**: all existing tests pass, `bun run check` clean.

### Phase 6.1 — Infrastructure: AgentSession + AgentBudget + SessionOverlay + PerceptionCompressor

7. Implement `agent-session.ts` with full state machine (`INIT → WAITING_FOR_WORKER → WAITING_FOR_ORCHESTRATOR → CLOSED`); `receive()` uses `Promise.race` with budget timeout
8. Implement `agent-budget.ts` with 3-pool structure; add `maxExtensionRequests: 3` cap; add `returnUnused(tokens)` method
9. Implement `session-overlay.ts`: create/diff/commit/cleanup; file deletion via whiteout tombstones; OCC `baseContentHash` check at commit
10. Add `overlayDir` to `ToolContext`; make `file_write`, `file_read`, `file_edit`, `file_delete`, `directory_list` overlay-aware; enforce `shell_exec` read-only whitelist at L1/L2
11. Implement `perception-compressor.ts`: truncate `PerceptualHierarchy` to `contextWindow * 0.30` by priority table (§8.9)
12. Unit tests: state machine transitions, budget pool arithmetic, overlay CoW semantics + OCC, perception truncation

### Phase 6.2 — agent-worker-entry (new subprocess)

13. Implement `agent-worker-entry.ts` with `attempt_completion` tool detection; `Promise.race` receive timeout; two-tier compression recovery; `tokensConsumed` in `tool_calls` turns
14. Extend `mock-provider.ts`: add `stopReason: 'max_tokens'` option for compression recovery tests
15. Integration test: single-turn with `attempt_completion` (validates terminal signal path)
16. Integration test: two-turn with `file_read` + `attempt_completion`
17. Integration test: `max_tokens` → compression → continuation → `attempt_completion`

### Phase 6.3 — AgentLoop (wires everything)

18. Implement `agent-loop.ts` as a stateless function (not class); injectable `IAgentSession` interface; `try/finally` for overlay cleanup; tool results pass through `guardrails.scan()` before history injection; `AgentSessionSummary` built on session end
19. Modify `worker-pool.ts`: L1+ dispatches via `AgentLoop`; inject `IAgentSession` for testing; L0 uses existing `worker-entry.ts`
20. Modify `core-loop.ts`: Step 4 dual-path (L0: WorkerPool.dispatch, L1+: AgentLoop.run); Steps 4½a/5½ conditional skip when `WorkerLoopResult` (tools already executed in overlay); return type widened to `WorkerResult | WorkerLoopResult`; retry path injects `AgentSessionSummary` into `WorkingMemory.priorAttempts`
21. Integration test: L1 task with 3 tool turns + guardrails intercept test

### Phase 6.4 — DelegationRouter + delegation support

22. Implement `delegation-router.ts` with 6 invariants (R1–R6); child routing level capped at ≤ parent routing level (A3); propagate parent `delegationDepth` counter
23. Implement `delegate_task` tool execute(): calls `context.onDelegate(request)`; returns denied if `onDelegate` absent (L0/L1)
24. Wire `AgentLoop` delegation path with late-binding `executeTask` thunk (§8.3 `handleDelegation`); `budget.deriveChildBudget()` + `returnUnusedDelegation()` lifecycle
25. Wire `factory.ts`: `DelegationRouter` injected; `executeTask` thunk set after full construction
26. Integration test: L2 task with 1 delegation level + `returnUnused` token accounting
27. Integration test: delegation denied (budget / scope / routing level cap / R6 shell_exec)

### Phase 6.5 — Observability + Hardening

28. Add bus events: `agent:turn_start`, `agent:tool_executed`, `agent:delegation_request`, `agent:delegation_complete`, `agent:compression_triggered`, `agent:occ_conflict`
29. Extend TUI dashboard to show turn count + delegation tree
30. Store `ConversationTurn[]` in trace record; extend `ExecutionTrace` with `transcript` field
31. Orchestrator startup: scan `workspace/.vinyan/sessions/` and remove overlays older than `maxDurationMs * 2`
32. Add `maxConcurrentAgenticSessions` semaphore to `WorkerPoolConfig` (default: L1=5, L2=3, L3=1)
33. Worker subprocess orphan protection: `agent-worker-entry.ts` polls stdin close / `ppid` every 10s; self-terminates if parent gone

---

## 15. Open Questions

All 6 open questions are now resolved. Decisions recorded below for reference.

---

**OQ-1: Delegation as WorkerTurn type vs `delegate_task` tool call — ✅ RESOLVED**

**Decision**: Option B, with a further simplification — `delegate_task` is handled entirely inside `ToolExecutor` via `ToolContext.onDelegate`. `AgentLoop` does **not** intercept or inspect tool call names. Workers call `delegate_task` like any other tool; the protocol stays at 3 `WorkerTurn` types.

**Sub-agent workspace isolation**: `DelegationRequest.targetFiles ⊆ parent.allowedPaths`, enforced by `DelegationRouter`. The sub-agent's `allowedPaths` is set to exactly the delegated files — full autonomy within a bounded scope.

---

**OQ-2: Token budget sharing semantics — ✅ RESOLVED**

**Decision**: 3-pool budget structure (base / negotiable / delegation). Workers negotiate mid-task extensions from the `negotiable` pool via `request_budget_extension` tool. Delegation draws from the `delegation` pool. Orchestrator grants up to 50% of remaining pool per request (A3 deterministic rules). See §8.2 for full specification.

---

**OQ-3: What happens when an agentic turn hits max_tokens mid-generation? — ✅ RESOLVED**

**Decision**: Two-tier context compression recovery, better than Claude Code / SWE-agent. See §8.7 for full algorithm.

**Tier 1 — Proactive** (before the wall): check before each LLM call if `estimateHistoryTokens > providerContextWindow * 0.75`. If yes, run `compressHistory()` (deterministic, no extra LLM call) and continue. Prevents hitting `max_tokens` due to context growth in the first place.

**Tier 2 — Reactive** (on `stopReason: 'max_tokens'`): if budget remaining > 1000 tokens and `compressionAttempts < 2`, compress history + inject continuation prompt + re-enter loop. If budget exhausted or attempt limit reached, emit `WorkerTurn{ type: 'uncertain' }` — AgentLoop calls `overlay.computeDiff()` to preserve any partial writes for audit. Orchestrator reschedules at higher routing level.

**`compressHistory()` algorithm**: keep system + init + last 3 turns verbatim; compress middle turns into a structured summary block with tool names, statuses, and 100-char excerpts. No extra LLM call needed. Max 2 compressions per session.

**Improvement over Claude Code**: proactive (not just reactive), deterministic (no extra LLM cost), budget-aware (distinguishes context pressure from budget exhaustion), last-3-turns preserved for coherence.

---

**OQ-4: Conversation history in WorkingMemory for future tasks — ✅ RESOLVED**

**Decision**: `AgentSessionSummary` compressed struct (~150 tokens) injected into `WorkingMemory.priorAttempts` for within-task retry. Full transcript to `TraceCollector` + Sleep Cycle only. See §8.8 for schema and prompt pattern.

**What the summary contains**: outcome, files touched, `failurePoint` (e.g. "oracle: TypeCheckFailed"), `lastIntent`, `uncertainties`, optional `suggestedNextStep`. Rendered as a structured markdown block in the retry worker's init prompt.

**Why not full transcript**: a 15-turn session easily produces 50 KB of tool outputs. Injecting this into the retry context crowds out the actual task. 150 tokens of structured summary is enough to prevent repeating the exact same failure.

**Progressive anti-repetition**: at retry #N, the worker sees summaries of all prior attempts — a natural "don't try what's already been tried" gradient without any special mechanism.

---

**OQ-5: Who builds proposedMutations in multi-turn? — ✅ RESOLVED**

**Decision**: Session overlay (§8.6). Workers write files normally via `file_write` tool during the loop; writes go to a per-task overlay directory. At `done`, `AgentLoop` computes `ProposedMutation[]` by diffing the overlay against the real workspace. `proposedMutations` in the `done` turn is optional metadata. Worker does not need to track what it wrote.

**Why this is correct for an LLM agent**: all mature agent systems (Claude Code, OpenHands, SWE-agent) write files live during execution, not at a batch-commit step. Forcing the worker to accumulate mutations until `done` breaks read-after-write and creates context pressure. The overlay gives the worker a natural filesystem experience while preserving A1 (pre-commit verification) and enabling free rollback.

---

**OQ-6: Streaming vs batch tool results — ✅ RESOLVED**

**Decision**: Batch. All tool calls in one turn execute in parallel and results are sent together in one `tool_results` turn.

**Rationale**: tools within a single turn are independent by design (if they had dependencies, the worker should issue separate turns). Running them in parallel makes batch *faster* than sequential streaming. The protocol stays simple. If a tool has genuine multi-minute latency (e.g. a slow shell command), the correct fix is to break the task into turns, not to stream partial results through the protocol.

---

## 16. Risks

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Worker writes malformed JSON mid-session | Medium | Session abort | `AgentSession` state machine + Zod validation per turn; `uncertain` fallback |
| Delegation depth causes stack overflow | Low | Process crash | Hard cap in `AgentBudgetTracker.canDelegate()` |
| Shared token pool exhausted by first delegation | Medium | Parent task fails | DelegationRouter cap at 50% remaining; `returnUnused()` after child completes |
| Long agentic sessions hold subprocess open | Medium | Resource leak | `AgentSession.close()` always in `try/finally`; `receive()` timeout via `Promise.race` |
| LLM generates `delegate_task` calls at L1 (not authorized) | Medium | Unexpected behavior | `manifestFor(routing)` never includes `delegate_task` at L0/L1 |
| Tool results contain prompt injection | Medium | A6 violation | `guardrails.scan()` applied to all tool results before history injection (§8.3) |
| Concurrent sessions overwrite same file | Medium | Silent data loss | OCC `baseContentHash` check at `commitArtifacts()` — reject on hash mismatch, retry |
| Orchestrator crash leaves stale overlay dirs | Medium | Disk accumulation | Startup cleanup: scan `workspace/.vinyan/sessions/`, delete dirs older than `maxDurationMs × 2` |
| Worker subprocess orphaned on Orchestrator crash | Low | Resource leak | Worker polls `ppid` / stdin close every 10s; self-terminates if parent gone |
| `shell_exec` bypasses overlay at L2 | **Eliminated** | Was Critical/A6 | Read-only whitelist enforced at L1/L2; L3 uses container with overlay mount |
| Sub-task escalates to higher routing than parent | Medium | A3 violation | `buildSubTaskInput` caps child routing ≤ parent routing; depth counter propagated |
| Delegation amplifies `shell_exec` via requiredTools | Medium | Capability creep | DelegationRouter R6: `shell_exec` excluded from `requiredTools`; child uses file tools only |
| LLM response cut off — `max_tokens` without `attempt_completion` | Medium | Ambiguous state | Two-tier compression recovery; hard fallback to `uncertain` preserves partial overlay work |
| `perception` overflow at init time | Medium | Context full on turn 1 | `PerceptionCompressor` truncates to `contextWindow × 0.30` before session starts |
| Too many concurrent agentic sessions | Medium | API rate limit / OOM | `maxConcurrentAgenticSessions` semaphore per level (L1=5, L2=3, L3=1) |

---

*All OQs resolved. Expert review incorporated (v5). Deep codebase cross-reference completed (v6). Document is implementation-ready — Phase 6.0 can begin.*
