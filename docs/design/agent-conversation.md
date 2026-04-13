---
type: design
status: implemented
single-source-of-truth-for: Agent Conversation clarification protocol, input-required status, CLARIFIED/CONTEXT constraint conventions
related:
  - ../foundation/concept.md (§1.1 A2 First-Class Uncertainty, §7 Epistemic Grounding)
  - ./phase6-implementation-plan.md (§11 Delegation Router, §11 Capability Matrix)
  - ../../src/orchestrator/core-loop.ts (short-circuit branch ~line 905)
  - ../../src/api/session-manager.ts (clarification recording + compaction)
  - ../../src/orchestrator/worker/agent-loop.ts (handleDelegation bubble-up)
---

# Agent Conversation — Clarification Protocol

## Context

Vinyan is framed as an autonomous task orchestrator, not a chat bot (see `docs/design/identity-reframe-plan.md`). But the [Epistemic Grounding](../foundation/concept.md#14-epistemic-grounding) table in the concept doc is explicit:

> **Understanding layer grounding artifact:** User-confirmed intent or explicit task specification — Goal Alignment Oracle — when comprehension confidence is low, the Orchestrator requests clarification rather than proceeding on uncertain interpretation.

In practice, this means a running agent must be able to **pause the task and ask the user a question** when it hits a user-intent ambiguity it cannot resolve from context. Before this feature, an agent that hit such an ambiguity had two unsatisfactory options:

1. **Guess** — produces plausible-looking mutations that may not match intent. Violates A1 (epistemic separation) in spirit: the agent is conflating "I verified this" with "I think this is what you meant".
2. **Fail with `status: 'uncertain'`** — is treated by the core loop as a retry/escalation signal, which wastes budget retrying at a higher routing tier that cannot possibly resolve user-intent questions (no amount of deliberation tells the agent which of two files the user meant).

Agent Conversation adds a **third, first-class outcome** — `status: 'input-required'` — that pauses the task cleanly and surfaces the agent's questions to the user, then threads the user's answer back into the next task turn as authoritative grounding.

## Three layers of the feature

### Layer 1 — User ↔ Orchestrator (top level)

The user runs `vinyan chat` (or the API). A turn proceeds as usual through perceive → predict → plan → generate. There are **two entry points** to `status: 'input-required'` at Layer 1 — both emit the same `TaskResult` shape and the same `agent:clarification_requested` bus event (distinguished by the `source` field on the payload).

**Entry point A — Orchestrator-driven (comprehension gate, pre-generation):**

Right after the Perceive phase produces an enriched `TaskUnderstanding`, and before Predict begins, the core loop runs a deterministic **Comprehension Check** (`src/orchestrator/understanding/comprehension-check.ts`). If the understanding is clearly ambiguous, the orchestrator pauses the task with orchestrator-generated clarification questions — no Predict/Plan/Generate budget is committed.

The check runs two conservative rule-based heuristics:

- **H1 (multi-path ambiguous entity)** — a `ResolvedEntity` with `resolvedPaths.length > 1` and `confidence < 0.6`. Entity resolution could not confidently pick one match from many candidates. Fires one question per ambiguous entity listing the candidates.
- **H4 (contradictory verified claim)** — a `VerifiedClaim` with `type: 'contradictory'`. The STU Phase C verifier found conflicting evidence about the world state. Fires one question per contradictory claim (capped at 3).

Heuristics explicitly deferred from V1:

- **H2 missing targetSymbol** — too noisy; the agent can search for a symbol itself.
- **H3 verb-mutation mismatch** — the current rule-based action-category classifier is too coarse (e.g., maps verbs like "test" to `actionCategory='qa'` which false-positives on `taskType='code'` inputs). Will revisit when the classifier has calibration data or a dedicated `actionIntent` field with provenance.
- **LLM `semanticIntent.ambiguities`** — those come from an LLM and would violate A3 (deterministic governance) if they drove a gate decision. They already enrich the agent's prompt via `buildInitUserMessage`.

**Opt-out:** `TaskInput.constraints: ['COMPREHENSION_CHECK:off']` skips the gate. This is pipeline metadata (filtered out of the agent's prompt by `buildInitUserMessage`) and is primarily used by tests that want to force the pipeline through to Generate.

**Entry point B — Agent-driven (attempt_completion, mid-generation):**

If Generate runs and the worker LLM calls `attempt_completion(status='uncertain', needsUserInput=true, uncertainties=[...])`, the core loop short-circuits **before verify** using the same mechanism. The agent self-reported that it cannot resolve the user's intent from context alone.

Both entry points:

- Build a `TaskResult` with `status: 'input-required'` and `clarificationNeeded: [...]`
- Emit `agent:clarification_requested` on the bus with `source: 'orchestrator'` (A) or `source: 'agent'` (B)
- Return immediately — no retry, no escalation, no oracle run (`mutations.length === 0` asserted)

The calling layer (`src/cli/chat.ts` or `POST /api/v1/sessions/:id/messages`) surfaces the questions as a friendly prompt, then captures the next user message as a **clarification answer**. That answer is injected into the next task's `TaskInput.constraints` as `CLARIFIED:<question>=><answer>`.

**Why both entry points exist:** A closes the A1 epistemic separation gap at the Understanding layer — the orchestrator (deterministic) decides to pause based on an oracle verdict, not the agent (probabilistic) self-reporting. B is the fallback path for ambiguities that only surface during generation (e.g., when the agent has read the files and discovered that "update config" could apply to two modules). Together they cover both pre-generation and mid-generation ambiguity detection.

### Layer 2 — Parent agent ↔ Child agent (delegation)

At routing level L2+, a worker can spawn a child worker via `delegate_task`. Before this feature, a delegated child that returned `input-required` was classified as an error (`ToolResult.status = 'error'`) and the parent's error-handling path fired.

Interactive delegation extends `handleDelegation` so an `input-required` child is surfaced to the parent as a **structured, non-error** ToolResult:

```jsonc
{
  "childTaskId": "...",
  "status": "input-required",
  "mutations": 0,
  "pausedForUserInput": true,
  "clarificationNeeded": ["Q1?", "Q2?"]
}
```

The parent LLM is taught (via a dedicated system-prompt section at L2+) to pick exactly one of two options:

1. **Answer-and-re-delegate.** If the parent already knows the answer — from the original user goal, perception, or its own plan — it constructs a new `delegate_task` call with a `context` field that explicitly resolves each question. `buildSubTaskInput` propagates that `context` into the child's `TaskInput.constraints` as a `CONTEXT:` prefix, and the child sees it as a first-class `## Delegation Context (from parent agent)` section in its init prompt.

2. **Bubble up.** If the parent does not have the answer, it calls `attempt_completion(status='uncertain', needsUserInput=true, uncertainties=[child's questions])`. This uses the Layer 1 machinery: the orchestrator short-circuits, the user sees the questions, the answer flows back in the next turn as `CLARIFIED:` constraints.

Bubble-up composes recursively: an L3 agent whose delegated L2 child asks a question can, in turn, bubble that question up through the L3 → L2 → user chain via the same `attempt_completion(needsUserInput=true)` mechanism.

### Layer 2.5 — Peer consultation (`consult_peer` tool)

Between full delegation (Layer 2) and user clarification (Layer 1) there is a third collaborative primitive: **asking a different reasoning engine for a structured second opinion** without spawning a full child pipeline. This is shipped as the `consult_peer` tool (`src/orchestrator/tools/control-tools.ts:consultPeer`).

**Shape:**

```jsonc
// Call:
{
  "question": "Should I use pattern A or pattern B for retry logic?",
  "context": "The code currently retries 3x with fixed backoff.",
  "requestedTokens": 1500
}

// Response (ToolResult.output, JSON-encoded):
{
  "opinion": "Use exponential backoff with jitter — fixed backoff thundering-herds on server restart.",
  "confidence": 0.7,
  "confidenceSource": "llm-self-report",
  "peerEngineId": "mock/powerful",
  "tokensUsed": { "input": 150, "output": 120 },
  "durationMs": 25
}
```

**How it differs from `delegate_task`:**

| | `delegate_task` | `consult_peer` |
|---|---|---|
| Spawns child pipeline | ✅ perceive → plan → generate → verify | ❌ single LLM call |
| Tools | Child has full tool manifest | No tools |
| Mutations | Child may commit mutations | Read-only |
| Budget | Token pool (15% of parent's) | 3 calls/session, charged to base pool |
| Recursion | Tree-bounded (depth ≤ 2) | Flat (no recursive consults) |
| Return | `TaskResult` | `PeerOpinion` (advisory) |
| Routing level | L2+ | **L1+** |
| Semantics | "Go do this" | "What do you think?" |

**Peer selection (A1 enforcement):**

The factory wires a default `peerConsultant` that picks the first provider whose `id` differs from the worker's current `routing.model`, in tier priority order (`powerful` → `balanced` → `fast`). When no distinct peer is available (e.g., only one provider is registered in the test harness or a single-model deployment), the consultant returns `null` and `handleConsultPeer` denies the consultation with an explicit A1 explanation rather than silently consulting the same model.

**Axiom compliance:**

- **A1 Epistemic Separation**: the peer engine MUST have a different `id` than the worker's — asking the same model for a second opinion is generator self-evaluation, which is exactly what A1 forbids. Enforced at the factory wiring (tier-priority search) and defense-in-depth at `handleConsultPeer` (null check).
- **A3 Deterministic Governance**: peer selection is rule-based (tier priority → first distinct id). No LLM chooses which engine to consult.
- **A5 Tiered Trust**: opinion confidence is **hardcoded** to `0.7` (heuristic-tier cap) by the factory wrapper, regardless of what the peer LLM self-reports. The worker is taught via system prompt to treat this as advisory, not authoritative.
- **A6 Zero-Trust Execution**: the peer has no tools, no overlay access, no mutation authority. The `PeerOpinion` is a bare string wrapped in structured metadata.

**Budget model:**

Consultations share the base pool (via `AgentBudgetTracker.recordConsultation`) rather than having a dedicated pool — they are expected to be rare. `canConsult()` gates on two conditions: (1) per-session counter < 3, (2) base pool has ≥ 500 tokens headroom so a consultation can't starve the primary work that follows.

**Use cases taught to the worker (via `CONSULT_PEER_SECTION` in `buildSystemPrompt`):**

- Cross-check a hard-to-reverse change before committing
- Tie-break between two plausible interpretations
- Sanity-check a fix for edge cases

**What NOT to use it for:**

- Simple factual lookups (use `file_read`, `search_grep`)
- Questions answerable by reading more files
- Anything requiring context not included in the `context` field — the peer does NOT see the worker's conversation history or tools

### Two-phase Goal Alignment

Vinyan has TWO goal-alignment oracles that fire at different points in the pipeline. They are **complementary, not redundant**, and together form a single two-phase architecture that keeps both "comprehension" (is the goal clear?) and "execution fidelity" (did the worker do what was asked?) under A1 epistemic separation.

```
┌─ PRE-generation ─────────────────────────────────────────────┐
│ Comprehension Check                                           │
│ src/orchestrator/understanding/comprehension-check.ts         │
│                                                               │
│ Runs: right after Perceive, before Predict                    │
│ Input: TaskUnderstanding                                      │
│ Question: "Is the goal clear enough to act on?"               │
│ Heuristics: H1 multi-path entity, H4 contradictory claim      │
│ Output: short-circuit TaskResult.status='input-required'      │
│         when ambiguous                                        │
│ Tier: heuristic (0.7 cap via GOAL_ALIGNMENT_HEURISTIC_CAP)    │
└───────────────────────────────────────────────────────────────┘
                          │
                          ▼
                   Predict → Plan → Generate
                          │
                          ▼
┌─ POST-generation ────────────────────────────────────────────┐
│ Goal Alignment Verifier                                       │
│ src/oracle/goal-alignment/goal-alignment-verifier.ts          │
│                                                               │
│ Runs: during Verify, against HypothesisTuple + mutations      │
│ Input: HypothesisTuple + TaskUnderstanding + targetFiles      │
│ Question: "Do the mutations match what the user asked for?"  │
│ Checks: C1 mutation expectation, C2 target symbol coverage,   │
│         C3 action-verb alignment, C4 file scope               │
│ Output: OracleResponse with heuristic confidence              │
│         Classification: INFORMATIONAL (warns, doesn't block   │
│         until calibrated via trace data)                      │
│ Tier: heuristic (0.7 cap)                                     │
└───────────────────────────────────────────────────────────────┘
```

**Both oracles share the same axiomatic posture:**

- **A1 Epistemic Separation** — neither uses an LLM in its verdict path. The Comprehension Check operates on entity resolver + claim verifier output. The Goal Alignment Verifier operates on mutation/symbol/scope matching. Neither is the generator, so both are valid A1 verifiers.
- **A3 Deterministic Governance** — both are pure rule-based. Given the same input, they produce the same verdict. No randomness.
- **A5 Tiered Trust** — both cap confidence at `GOAL_ALIGNMENT_HEURISTIC_CAP = 0.7` (heuristic tier). Their output cannot be promoted to "known" tier because both rely on approximate matching (fuzz entity resolution, coarse verb classifier).

**Shared types** live at `src/orchestrator/understanding/goal-alignment-shared.ts`:

- `GoalAlignmentPhase = 'pre-generation' | 'post-generation'`
- `GOAL_ALIGNMENT_HEURISTIC_CAP = 0.7`
- `GoalAlignmentPhaseVerdict` — unified shape for shared observability / future cross-phase composition

The shared types are **additive**. The existing oracle registry still uses the legacy `OracleResponse` shape for post-gen verdicts, and the Comprehension Check still returns its native `ComprehensionVerdict`. The shared file documents the contract between the two and gives downstream code (telemetry, cross-phase reasoning, trace metadata) a single place to import common types without refactoring the existing registry.

**Why two phases, not one:**

A single oracle cannot check both comprehension and execution because:
1. Pre-gen has no mutations — C1-C4 checks cannot run (they require a HypothesisTuple).
2. Post-gen is too late — by the time mutations exist, budget has been committed; we can't "unask" ambiguity.

Merging the two would either lose pre-gen gating (the whole point of closing the A1 Understanding-layer gap per concept.md §1.1) or force post-gen to abort committed work. Keeping them separate lets each optimize for its phase while sharing the same axiomatic guarantees.

### Layer 3 — Cross-turn grounding (session)

For multi-turn conversations, `SessionManager` stores each assistant `input-required` turn as a structured `[INPUT-REQUIRED]` block in `session_messages.content`:

```
(optional preamble)

[INPUT-REQUIRED]
- Which file should I rename?
- Keep the old name as an alias?
```

- `getPendingClarifications(sessionId)` returns the open questions if and only if the last session message is an unanswered `[INPUT-REQUIRED]` assistant turn. `chat.ts` uses this on startup to resume a paused session, and after every turn to detect whether the next user message should be tagged as a clarification answer.
- `getConversationHistoryCompacted` preserves both **resolved clarifications** (with their answers) and **open clarifications** across rule-based compaction, so long conversations don't lose the epistemic state.

All parsing is pure string matching — no LLM in the path — satisfying A3.

## Axiom alignment

| Axiom | How this feature complies |
|---|---|
| **A1 — Epistemic Separation** | The `input-required` short-circuit does NOT run the oracle gate — because no mutations were committed (asserted `workerResult.mutations.length === 0`). The agent is only surfacing a question; it is not making a claim the oracles would need to verify. Generation stays distinct from verification. |
| **A2 — First-Class Uncertainty** | `'input-required'` is a valid protocol state at `TaskResult.status`, lexically aligned with A2A's `A2ATaskState` `'input-required'`. User-intent ambiguity is no longer an error. |
| **A3 — Deterministic Governance** | Routing, compaction, and the clarification state machine (`getPendingClarifications`) are all pure rule-based code. No LLM is in the decision path for "should this be input-required" — the agent explicitly sets `needsUserInput=true` via a structured tool parameter, and the core loop inspects that boolean. |
| **A5 — Tiered Trust** | User-supplied answers enter via `TaskInput.constraints` as `CLARIFIED:` strings. They are first-class grounding for the Understanding layer but they never become content-addressed facts in the World Graph — they're treated as user-provided evidence (untrusted tier) and can be overridden by any deterministic oracle finding. |
| **A6 — Zero-Trust Execution** | No new communication channel between workers: parent and child agents still talk only through the orchestrator-mediated `delegate_task` tool. The short-circuit branch asserts `mutations.length === 0` as a defense-in-depth check — if mutations somehow appear (policy violation), it falls through to normal verify rather than returning them un-verified. |
| **A7 — Prediction Error as Learning Signal** | `input-required` is currently neutral from the accuracy listener's perspective (neither `confirmed_correct` nor `confirmed_wrong`) — see `oracle-accuracy-listener.ts`. The `agent:clarification_requested` bus event is available for future self-model calibration: per-task-type rates of clarification requests can indicate the ambiguity of goals in that domain. |

## Data flow

### User clarification round trip (Layer 1)

```
┌── Turn 1 ────────────────────────────────────────────────────────┐
│ User: "rename the helper to util"                                │
│    ↓                                                             │
│ chat.ts → executeTask(goal="rename the helper to util")          │
│    ↓                                                             │
│ core-loop: perceive → predict → plan → generate                  │
│    ↓                                                             │
│ agent-loop dispatch → worker: LLM sees ambiguity                 │
│    ↓                                                             │
│ worker: attempt_completion(uncertain, needsUserInput=true,       │
│                           uncertainties=["Which helper?"])      │
│    ↓                                                             │
│ agent-loop: WorkerLoopResult{ needsUserInput=true, ... }         │
│    ↓                                                             │
│ core-loop: short-circuit branch at ~line 905                     │
│    ↓                                                             │
│ emit('agent:clarification_requested', { ... })                   │
│ emit('task:complete', { result: status='input-required' })       │
│    ↓                                                             │
│ chat.ts: display yellow "Vinyan needs clarification: …"          │
│          pendingClarifications = [ "Which helper?" ]             │
│ SessionManager.recordAssistantTurn → [INPUT-REQUIRED] block      │
└──────────────────────────────────────────────────────────────────┘
┌── Turn 2 ────────────────────────────────────────────────────────┐
│ User: "the auth helper"                                          │
│    ↓                                                             │
│ chat.ts: sees pendingClarifications is non-empty                 │
│          builds constraints: ["CLARIFIED:Which helper?=>the auth helper"] │
│    ↓                                                             │
│ executeTask(goal="the auth helper", constraints=[CLARIFIED:…])   │
│    ↓                                                             │
│ core-loop → task-understanding.buildTaskUnderstanding            │
│    ↓                                                             │
│ TaskUnderstanding.constraints = ["CLARIFIED:Which helper?=>…"]   │
│    ↓                                                             │
│ (L1)  prompt-section-registry renders [USER CONSTRAINTS]         │
│ (L2+) agent-worker-entry.buildInitUserMessage renders            │
│       "## User Clarifications" section with Q/A labels           │
│    ↓                                                             │
│ Worker LLM reads the section, grounds its plan on the answers    │
└──────────────────────────────────────────────────────────────────┘
```

### Parent/child delegation bubble-up (Layer 2)

```
parent.delegate_task(goal="rename helper", targetFiles=["src/…"])
    ↓
handleDelegation → buildSubTaskInput → executeTask(childInput)
    ↓
child: attempt_completion(uncertain, needsUserInput=true,
                         uncertainties=["Which auth file?"])
    ↓
child's core-loop short-circuits → TaskResult{status=input-required, ...}
    ↓
handleDelegation wraps it:
    ToolResult{ status='success',                   (NOT 'error'!)
                output='{"childTaskId":"…","status":"input-required",
                          "pausedForUserInput":true,
                          "clarificationNeeded":["Which auth file?"]}' }
    ↓
parent LLM reads tool result, sees pausedForUserInput, picks:
    ├─ (a) Answer from context:
    │       delegate_task(goal="…", context="Use src/auth.ts")
    │       → buildSubTaskInput adds "CONTEXT:Use src/auth.ts" to child.constraints
    │       → child re-runs with "## Delegation Context" in its init prompt
    │
    └─ (b) Bubble up:
            attempt_completion(uncertain, needsUserInput=true,
                              uncertainties=["Which auth file?"])
            → parent's core-loop short-circuits
            → user sees the question via Layer 1 machinery
```

## Conventions (single source of truth)

| Convention | Where produced | Where consumed | Meaning |
|---|---|---|---|
| `TaskResult.status = 'input-required'` | `core-loop.ts` short-circuit branch | `chat.ts`, `session-manager.ts`, `a2a/bridge.ts`, `bus/cli-progress-listener.ts`, `tui/views/tasks.ts` | Task paused; clarification questions are in `clarificationNeeded`. Not a failure. |
| `TaskResult.clarificationNeeded: string[]` | `core-loop.ts` | CLI chat, TUI, A2A bridge | Each entry is one question. |
| `attempt_completion(needsUserInput: true)` | Agent LLM | `agent-worker-entry.ts` handleCompletion, `agent-loop.ts` buildUncertainResult | Disambiguator: this uncertain turn is about USER intent, not a code fact. |
| `[INPUT-REQUIRED]\n- Q1\n- Q2` | `SessionManager.recordAssistantTurn` | `SessionManager.getPendingClarifications`, `parseInputRequiredBlock` | Stored in `session_messages.content`. Parsed with pure string matching (A3). |
| `CLARIFIED:<question>=><answer>` | `chat.ts` (on the turn following an input-required) | `task-understanding.ts` (copy-through), `agent-worker-entry.ts:buildInitUserMessage` (renders as "## User Clarifications") | User's answer threaded as authoritative grounding for the next turn. |
| `CONTEXT:<text>` | `delegation-router.ts:buildSubTaskInput` (from parent's `delegate_task` `request.context`) | `agent-worker-entry.ts:buildInitUserMessage` (renders as "## Delegation Context (from parent agent)") | Parent-provided resolution of child clarifications. |
| `ToolResult.output` JSON with `pausedForUserInput: true` | `handleDelegation` | Parent agent LLM (via L2+ system prompt guidance) | Signal that a delegated child paused rather than failed. |
| `agent:clarification_requested` bus event with `source: 'agent'` | `core-loop.ts` post-Generate short-circuit branch | TUI listeners, API streaming (future), logging | Agent-driven: worker LLM self-reported uncertainty. Per-task-type rates available for future A7 self-model calibration. |
| `agent:clarification_requested` bus event with `source: 'orchestrator'` | `core-loop.ts` post-Perceive comprehension gate | Same consumers as above | Orchestrator-driven: deterministic Comprehension Check detected ambiguity before Generate ran. Distinguishable in trace via `approach: 'comprehension-pause'`. |
| `TaskInput.constraints: ['COMPREHENSION_CHECK:off']` | CLI tests, API test harness | `isComprehensionCheckDisabled()` in `comprehension-check.ts` | Pipeline metadata that bypasses the Comprehension gate. Filtered from the agent init prompt by `buildInitUserMessage`. |
| `POST /api/v1/sessions/:id/messages` response `session.pendingClarifications` | `src/api/server.ts:handleSessionMessage` | Web / mobile / external clients | Exposes the same pending-clarification state the CLI uses; non-empty on input-required turns, empty after completion. |
| `POST /api/v1/sessions/:id/messages` request body `stream: true` | Web / mobile clients | `src/api/server.ts:handleSessionMessage` stream branch | Switches the response to `text/event-stream` (SSE). Same validation + clarification semantics as sync, returns immediately with a live event feed that closes on `task:complete`. |
| `GET /api/v1/sessions/:id/stream` | Web / mobile clients | `src/api/server.ts:handleSessionStream` → `src/api/sse.ts:createSessionSSEStream` | Long-lived SSE stream scoped to a session. One connection per client covers all tasks in the session across multiple turns. Emits an initial `session:stream_open` event, tracks session-task membership via `task:start` filtering, forwards per-task events, heartbeats every 30s via `:heartbeat\n\n` comment lines, and auto-cleans up after 60 minutes as a safety net. |
| `consult_peer` tool call `{question, context?, requestedTokens?}` | Worker LLM at L1+ | `agent-loop.ts:handleConsultPeer` → `deps.peerConsultant` (factory-wired) → `LLMProviderRegistry.selectByTier` | Lightweight second-opinion primitive. Response is a `PeerOpinion` JSON in `ToolResult.output` with confidence hardcoded to 0.7 (A5 heuristic tier). Max 3 per session. A1 enforced: peer engine id must differ from worker's. |

## HTTP API — `POST /api/v1/sessions/:id/messages`

The conversational flow described above is exposed over HTTP for web,
mobile, and external clients. Mirrors `vinyan chat`'s state machine.

**Endpoints:**

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/api/v1/sessions/:id/messages` | Send a user message, run one task turn, return the `TaskResult` + updated session state |
| `GET` | `/api/v1/sessions/:id/messages` | List conversation history (optional `?limit=N`) |

**`POST /messages` request body:**

```jsonc
{
  "content": "refactor the helper",          // required, min 1 char
  "taskType": "code",                         // optional: 'code' | 'reasoning'
  "targetFiles": ["src/auth.ts"],             // optional
  "budget": { "maxTokens": 50000, ... },      // optional
  "showThinking": false,                      // optional
  "stream": false                             // optional — see SSE variant below
}
```

**`POST /messages` response (200):**

```jsonc
{
  "session": {
    "id": "a1b2c3...",
    "pendingClarifications": ["Which helper?", "Keep as alias?"]
  },
  "task": {
    "id": "...",
    "status": "completed" | "failed" | "escalated" | "uncertain" | "input-required",
    "answer": "...",
    "mutations": [...],
    "clarificationNeeded": ["Which helper?", "Keep as alias?"],
    "trace": { ... }
  }
}
```

- **`status: 'input-required'` returns HTTP 200**, not a 4xx — it is a
  valid outcome requesting user input, not an error.
- `session.pendingClarifications` mirrors `task.clarificationNeeded` when
  the turn paused; clients can display either.
- On the NEXT `POST /messages` call, the server calls
  `getPendingClarifications(sessionId)`. If the previous assistant turn
  was an unresolved `[INPUT-REQUIRED]` block, the new user content is
  auto-wrapped as `CLARIFIED:<q>=><answer>` for each open question and
  injected into the next `TaskInput.constraints`. This is the exact
  mechanism `vinyan chat` uses — the HTTP endpoint is a thin wrapper.

**Status codes:**
- `200` — task executed (any `TaskResult.status`, including `input-required`)
- `400` — empty / missing / malformed `content`, or JSON parse error
- `401` — missing or invalid bearer token
- `404` — session id not found
- `500` — task execution threw

**Auth:** standard bearer token, same as other POST endpoints.

### SSE streaming variant (`stream: true`)

When the request body includes `"stream": true`, the server returns a
`text/event-stream` (Server-Sent Events) response instead of waiting
for the task to complete. This matches the OpenAI chat completions
streaming convention and is suitable for web / mobile clients that
want real-time progress feedback.

**Request:** same shape as the sync endpoint, with `stream: true` added.

**Response:**

```
Content-Type: text/event-stream
Cache-Control: no-cache
Connection: keep-alive

event: task:start
data: {"event":"task:start","payload":{...},"ts":1712345678901}

event: phase:timing
data: {"event":"phase:timing","payload":{"phase":"perceive",...},"ts":...}

event: agent:tool_executed
data: {"event":"agent:tool_executed","payload":{...},"ts":...}

event: agent:clarification_requested
data: {"event":"agent:clarification_requested","payload":{"taskId":"...","questions":[...],"source":"agent"|"orchestrator"},"ts":...}

event: task:complete
data: {"event":"task:complete","payload":{"result":{"status":"...","clarificationNeeded":[...],...}},"ts":...}
```

The stream auto-closes on the first `task:complete` event the client
receives for the initiated task id. Events forwarded via SSE are
defined in `src/api/sse.ts:SSE_EVENTS` — the full list includes:

- Task lifecycle: `task:start`, `task:complete`, `task:escalate`, `task:timeout`
- Pipeline observability: `phase:timing`, `trace:record`
- Worker / oracle: `worker:dispatch`, `worker:complete`, `worker:error`, `oracle:verdict`, `critic:verdict`, `shadow:complete`
- Agent Conversation: `agent:session_start`, `agent:session_end`, `agent:turn_complete`, `agent:tool_executed`, **`agent:clarification_requested`** (both `source='agent'` and `source='orchestrator'`)

**Critical ordering:** the server creates the SSE stream (subscribing
the bus listeners synchronously via `ReadableStream.start()`) BEFORE
calling `executeTask`. This guarantees that any event the orchestrator
emits during the pipeline is captured by the subscribers.

**Clarification flow over SSE:** identical to the sync path — the
server queries `getPendingClarifications()` before dispatching the
task and auto-wraps the user's content as `CLARIFIED:<q>=><answer>`
constraints when the previous turn paused. Pending clarification
state is visible via `agent:clarification_requested` events in the
stream *and* via a subsequent `GET /messages` call.

**Validation errors still return JSON:** `404` (unknown session),
`400` (empty content, malformed body), and `401` (missing auth) all
return standard `application/json` error envelopes. Streaming is
only activated AFTER validation passes.

**Turn recording:** the user turn is recorded before the stream is
returned (synchronously, same as sync path). The assistant turn is
recorded in the `.then()` handler attached to the executeTask
promise — it runs after `task:complete` has already been delivered
to the client, so the stream is closed by then. Clients that need
the final `TaskResult` shape (e.g., for `clarificationNeeded`) can
read it from the `task:complete` event payload (`payload.result`).

**Error recovery:** if `executeTask` rejects unexpectedly (a bypass
of core-loop's own exception handling), the server synthesizes a
failed `TaskResult`, records the assistant turn, and manually emits
`task:complete` on the bus to close the stream cleanly. The client
sees a `task:complete` event with `result.status: 'failed'` and
`result.escalationReason` set to the error message.

**Safety net:** a 10-minute `setTimeout(cleanup, ...)` unsubscribes
the bus listeners even if `task:complete` never fires for some
reason (e.g., an orchestrator bug). Matches the existing
`GET /api/v1/tasks/:id/events` convention with a looser bound for
conversational-style budgets.

### Long-lived session-scoped SSE (`GET /sessions/:id/stream`, PR #10)

For clients that want ONE persistent connection covering an entire
conversation (across multiple turns), `GET /api/v1/sessions/:id/stream`
returns a long-lived SSE stream scoped to the session. Distinct from
the per-task `POST /messages` variant:

| Dimension | `POST /messages` (stream=true) | `GET /stream` |
|---|---|---|
| Lifetime | One task turn | Entire session |
| Closes on | `task:complete` (auto) | Client disconnect or 60m safety-net |
| Heartbeat | No | `:heartbeat <ts>\n\n` every 30s |
| Initial event | `task:start` | `session:stream_open` |
| Scope filter | Task id | Session task membership set |

**Membership tracking**: the stream's subscriber listens to `task:start`
and, when `payload.input.sessionId === sessionId`, adds the new task's
id to an in-memory `Set<string>`. All subsequent per-task events
(`task:complete`, `phase:timing`, `agent:clarification_requested`, etc.)
are filtered by membership in that set, so tasks from OTHER sessions
are dropped even if they share the same bus.

**Heartbeat**: SSE comment lines starting with `:` are ignored by the
`EventSource` parser (they do not fire `onmessage`). They serve as a
keep-alive signal for intermediate proxies and allow clients to detect
broken connections by absence of data for more than the heartbeat
interval.

**No replay / reconnection**: V1 does not support `Last-Event-ID`
reconnection. A disconnected client gets a fresh stream on reconnect
with no backfill — they can call `GET /messages` separately to
reconstruct state.

**Axiom posture**: the stream is observational only — it does not
bypass any axioms. Every event it forwards was already emitted on
the shared `VinyanBus` for internal consumption. SSE is a viewport,
not a governance surface.

## What's excluded (future work)

The feature as-landed deliberately leaves these for future PRs:

1. ~~**HTTP API `POST /api/v1/sessions/:id/messages`**~~ — **shipped**
   in the HTTP endpoint PR (sync) and extended with SSE streaming in
   the streaming PR (`stream: true` in the request body).
2. **TUI chat view** — `src/tui/` has the status icon and sort priority for `input-required` but no dedicated conversational view. Monitoring dashboard only.
3. **Suspend/resume of in-flight agent loops across user turns** — today each chat turn is a fresh `executeTask` with a fresh subprocess. A paused L3 agent with a half-finished plan cannot "resume" after the user answers; the new turn starts over with the answer grounded in constraints. Full agent checkpointing is a much larger architectural change.
4. ~~**Goal Alignment Oracle integration**~~ — **partially shipped** as
   the Comprehension Check gate (Layer 1 Entry Point A above). V1 implements
   two conservative heuristics (H1 ambiguous entity, H4 contradictory claim)
   and runs as a deterministic rule-based gate after Perceive, before
   Predict. Deferred enhancements: verb-intent classifier calibration for
   H3, probabilistic signals from LLM `semanticIntent.ambiguities`, and
   reconciliation with the existing mutation-centric `goal-alignment-verifier.ts`
   post-generation oracle (the two are complementary — pre- vs post-gen).
5. ~~**`consult_peer` tool**~~ — **shipped** as a first-class tool at L1+.
   Distinct from `delegate_task`: no child pipeline, no tools, no mutations,
   fixed per-session cap (3 consultations), capped at A5 heuristic-tier
   confidence (0.7). The factory wires a deterministic peer consultant
   backed by `LLMProviderRegistry` that picks the first reasoning engine
   whose `id` differs from the worker's current model — returning `null`
   when no distinct peer is available (honoring A1). See the dedicated
   "Peer consultation (consult_peer tool)" section below.
6. **Inter-instance A2A task delegation** — `InstanceCoordinator.delegate()` exists in code but is not wired into the Predict/Plan phase. The A2A bridge maps `input-required` 1:1 to `A2ATaskState.input-required` so the protocol is ready when the routing logic catches up.
7. **Multi-round batched clarification answering** — parent agent answers some child questions from context and bubbles up the rest. Currently the parent picks exactly one of the two paths for all the child's questions.

## Verification

### Unit tests (in `tests/orchestrator/clarification.test.ts`)

27 tests covering:

1. **Agent loop** — `needsUserInput` propagation from `uncertain` WorkerTurn to `WorkerLoopResult`, non-retryable detection suppressed on user pauses.
2. **SessionManager** — `recordAssistantTurn` stores `[INPUT-REQUIRED]` block; `getPendingClarifications` parses the latest assistant turn; `completeTask` maps `input-required` → `completed` at the DB CHECK constraint boundary; `getConversationHistoryCompacted` preserves both resolved and open clarifications.
3. **`parseInputRequiredBlock`** — pure parser: absent tag, bullet extraction, epilogue handling, whitespace tolerance.
4. **Interactive delegation** — `handleDelegation` forwards `input-required` child as success ToolResult with `pausedForUserInput: true`; still classifies truly failed children as error; treats completed children as success.
5. **`buildSubTaskInput`** — propagates `request.context` as `CONTEXT:` constraint; omits when absent.
6. **System prompt** — L2+ includes the "Handling Delegated Sub-task Clarifications" section; L1 does not.
7. **`buildInitUserMessage` constraint rendering** — CLARIFIED entries render as "User Clarifications" with Q/A pairs; CONTEXT entries render as "Delegation Context"; pipeline metadata (`MIN_ROUTING_LEVEL:`, `THINKING:`, `TOOLS:`) is filtered; plain constraints render as "User Constraints"; mixed inputs surface each in its own section; empty constraints → no section; malformed CLARIFIED (no separator) degrades to plain constraint.

### Manual end-to-end verification

The agentic loop path cannot run in the in-process test harness (subprocess agents require real LLM credentials + filesystem watch support that the sandbox lacks). For manual verification:

```bash
# Run `vinyan chat` in a real workspace with an Anthropic/OpenRouter API key set.
vinyan chat

# Prompt something deliberately ambiguous:
vinyan> refactor the helper

# If the agent chooses to ask, you should see:
# Vinyan needs clarification:
#   • Which helper module did you mean — src/auth.ts or src/utils.ts?

# Answer:
vinyan> src/auth.ts

# Agent should now proceed with src/auth.ts as resolved grounding;
# look for the "## User Clarifications" section in any prompt tracing.

# Resume a session that was paused:
vinyan chat --resume <sessionId>
# → should print "(Vinyan is waiting for you to answer:)" with the open questions.
```

Bus events can be observed via TUI (`vinyan tui`) or a bus listener script.
