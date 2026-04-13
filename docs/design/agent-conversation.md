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

The user runs `vinyan chat` (or the API, when added). A turn proceeds as usual through perceive → predict → plan → generate. If the generator (at any routing level) calls `attempt_completion(status='uncertain', needsUserInput=true, uncertainties=[...])`, the core loop **short-circuits before verify**:

- Builds a `TaskResult` with `status: 'input-required'` and `clarificationNeeded: [...]`
- Emits `agent:clarification_requested` on the bus
- Returns immediately — no retry, no escalation, no oracle run (`mutations.length === 0` is asserted)

The calling layer (`src/cli/chat.ts`) surfaces the questions as a friendly yellow prompt, then captures the next user message as a **clarification answer**. That answer is injected into the next task's `TaskInput.constraints` as `CLARIFIED:<question>=><answer>`.

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
| `agent:clarification_requested` bus event | `core-loop.ts` short-circuit branch | TUI listeners, API streaming (future), logging | Observability — per-task-type rates of clarification requests are available for future A7 self-model calibration. |

## What's excluded (future work)

The feature as-landed deliberately leaves these for future PRs:

1. **HTTP API `POST /api/v1/sessions/:id/messages`** with SSE streaming — `src/api/server.ts` currently has session endpoints but no conversational `/messages` endpoint. The `TaskResult` shape is ready; the HTTP wiring is a separate concern.
2. **TUI chat view** — `src/tui/` has the status icon and sort priority for `input-required` but no dedicated conversational view. Monitoring dashboard only.
3. **Suspend/resume of in-flight agent loops across user turns** — today each chat turn is a fresh `executeTask` with a fresh subprocess. A paused L3 agent with a half-finished plan cannot "resume" after the user answers; the new turn starts over with the answer grounded in constraints. Full agent checkpointing is a much larger architectural change.
4. **Goal Alignment Oracle integration** — concept.md §1.1 envisions the orchestrator itself deciding to request clarification based on an oracle verdict ("comprehension confidence is low → request clarification"). Today the decision is agent-self-reported via `needsUserInput=true`. Wiring the Goal Alignment Oracle into the Understanding phase to proactively inject `input-required` would close this loop but requires design reconciliation with the existing (heuristic, informational-only) oracle.
5. **`consult_peer` tool** — a lightweight synchronous "ask another reasoning engine / oracle for a second opinion" primitive that would not spawn a full child pipeline. Useful for LLM-as-Critic patterns at the edges of delegation depth.
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
