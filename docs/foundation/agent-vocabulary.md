# Agent Vocabulary — Disambiguating "Agent" in Vinyan

> **Status:** authoritative (2026-05-01)
> **Audience:** every contributor (human or AI) working in this repo
> **Why this doc exists:** the word *agent* is overloaded across at least
> five distinct concepts in Vinyan. This is the single source of truth for
> which kind is meant where. When you see "agent" in code, docs, or chat,
> consult this table first.

---

## TL;DR — five distinct things called "agent"

| # | Canonical name | What it actually is | Trust tier | Lifetime | Primary code anchor |
|---|---|---|---|---|---|
| **1** | **Persona** *(a.k.a. "Specialist")* | Internal role/voice (developer, reviewer, coordinator) configured inside Vinyan | internal — A1 generation/verification still applies, but lives in same trust boundary | per-step or per-task | `src/orchestrator/agents/`, `agentId` field in workflow steps, `delegate-sub-agent` strategy |
| **2** | **Worker** *(a.k.a. "Agentic Worker")* | Subprocess that runs the agentic loop (think → act → observe). Phase 6. | **zero-trust per A6** — proposes, orchestrator disposes | per-task subprocess | `src/orchestrator/worker/`, `worker-entry.ts`, bus events `agent:turn_complete`, `agent:tool_executed` (legacy namespace — see RFC below) |
| **3** | **CLI Delegate** *(a.k.a. "External Coding CLI")* | Vendor-provided binary that Vinyan **spawns as a subprocess** to do coding work — Claude Code, GitHub Copilot CLI | **zero-trust per A6 + A1 verification** — every claim verified by Vinyan | per-task subprocess | `src/orchestrator/external-coding-cli/`, `providerId='claude-code'\|'github-copilot'` |
| **4** | **Host CLI** *(a.k.a. "Build-time Claude Code")* | The Claude Code (or other AI coding tool) the **human developer uses to build Vinyan**. Lives outside Vinyan's runtime. | trusted (human-in-the-loop reviews every diff) | dev-time only | `~/.claude/`, `CLAUDE.md`, repo `AGENTS.md` (if any). **Never appears in `src/`**. |
| **5** | **Peer** *(a.k.a. "Vinyan Instance" in A2A)* | Another Vinyan installation acting as an agent-to-agent peer | `PeerTrustLevel` — earned via verification | indefinite (deployed instance) | `src/a2a/`, `instanceId` |

> The word "agent" is acceptable in **abstract docs / user-facing copy** as
> an umbrella term, but every technical statement (code identifier, log
> message, governance reason, error string, prompt template) MUST use one
> of the canonical names above.

---

## The meta-level concern: #3 ↔ #4 share a binary

**Claude Code CLI is the same binary in #3 and #4.** They are *causally
unrelated* but the toolchain is identical:

- **#4 (Host CLI):** A developer types into Claude Code in their terminal.
  Claude Code edits files in `src/`. The diff lands as a commit. Vinyan
  doesn't know any of this happened.
- **#3 (CLI Delegate):** A deployed Vinyan instance receives a user
  request → routes to `external-coding-cli` → spawns `claude` as a
  subprocess → captures structured output → verifies the claim.

These can run **at the same time on the same machine** and on **the same
files**. That is a real concurrency hazard. See [Trust Boundary Hazards](#trust-boundary-hazards) below.

The **self-reference** is also dangerous: when a developer (#4) uses
Claude Code to refactor `src/orchestrator/external-coding-cli/`, they are
modifying the code that *Vinyan uses to spawn Claude Code at runtime*.
That doesn't break anything inherently — but reasoning about it requires
holding both senses of "Claude Code" in mind without conflating them.

The Thai-prompt routing bug fixed on 2026-04-30 is an instance of this
confusion: the router classified "claude code cli" without distinguishing
"spawn the binary [#3]" from "talk about it [conversational]".

---

## Per-dimension detail

### #1 — Persona

A **persona** is a configured role inside Vinyan: `developer`, `reviewer`,
`synthesizer`, `coordinator`, `architect`, etc. It's the discriminator on
the `agentId` field of a workflow step when `strategy='delegate-sub-agent'`.

- **Substrate:** an LLM call with persona-specific system prompt + scoped
  capabilities (declared via `CapabilityRequirement[]`).
- **Trust:** internal. The persona runs inside Vinyan's process and trust
  boundary. It still goes through A1 generation/verification, but A6's
  zero-trust subprocess gate doesn't apply (it's not a subprocess).
- **Identity type (proposed branded):** `PersonaId = string & { __brand: 'persona' }`.
- **Lifetime:** dispatched once per workflow step (or once per ACR room
  participant). Disposed when the step finishes.
- **Wire protocol:** none — internal function call.
- **Code anchors:**
  - `src/orchestrator/agents/registry.ts` — registry of persona specs
  - `src/orchestrator/agents/builtin/` — built-in persona definitions
  - `src/orchestrator/workflow/workflow-executor.ts` `case 'delegate-sub-agent'`
- **Naming rules:**
  - Code: prefer `persona`, `personaId`, `PersonaSpec`, `PersonaRegistry`. Avoid bare `agent` / `agentId` for *new* code; existing usages migrate gradually (see RFC).
  - Docs/UI: "Persona X" or "specialist X". Never "Agent X" without a qualifier.
- **Common confusion:** `agentId: string` in `WorkflowStep` is a Persona ID, *not* a Worker ID and *not* a Peer Instance ID.

### #2 — Worker

A **worker** is the agentic-worker-protocol subprocess (Phase 6) that
runs a `think → act → observe` loop. It executes per-task generation.

- **Substrate:** subprocess (`worker-entry.ts`) driven by an LLM, talking
  to the orchestrator over IPC with ECP-shaped messages.
- **Trust:** **zero-trust per A6**. Workers propose mutations; the
  orchestrator validates and either commits or rejects.
- **Identity type (proposed branded):** `WorkerId`.
- **Lifetime:** per-task or per-routing-level. Disposed at task end.
- **Wire protocol:** IPC + ECP framing.
- **Code anchors:**
  - `src/orchestrator/worker/worker-pool.ts` — pool + dispatch
  - `src/orchestrator/worker/worker-entry.ts` — subprocess entry
  - `src/orchestrator/agent-loop.ts` — the agentic loop itself
  - Bus events `agent:turn_complete`, `agent:tool_started`, `agent:tool_executed`, `agent:thinking`, `agent:contract_violation`, `agent:plan_update`, `agent:clarification_requested` — *currently* under the `agent:*` namespace; rename pending (see RFC).
- **Naming rules:**
  - Code: prefer `worker`, `workerId`, `WorkerPool`. Treat `agent:*` events as the worker event surface.
  - Docs/UI: "Worker subprocess" or "agentic worker". Never "the agent" alone.
- **Common confusion:** `agent:*` events look like persona events but are actually worker events. The capability-first events (`agent:routed`, `agent:synthesized`) are persona-level — see RFC for the split plan.

### #3 — CLI Delegate (External Coding CLI)

A **CLI delegate** is a vendor-provided coding-CLI binary that Vinyan
spawns to perform a delegated task. As of 2026-05-01: Claude Code CLI
and GitHub Copilot CLI.

- **Substrate:** vendor binary spawned via PTY or pipe.
- **Trust:** **zero-trust per A6, plus A1 verification** — Vinyan's
  verifier runs after the delegate's claim and the final outcome status
  reflects the verifier's verdict, not the CLI's self-report.
- **Identity type (proposed branded):** `CliDelegateProviderId = 'claude-code' | 'github-copilot'`.
- **Lifetime:** per-task subprocess.
- **Wire protocol:** vendor-specific (stream-json for Claude Code, hooks
  for Copilot, etc.). Adapters normalize at the boundary.
- **Code anchors:**
  - `src/orchestrator/external-coding-cli/` — entire subsystem
  - `src/orchestrator/intent/external-coding-cli-classifier.ts` — NL → structured intent
  - `src/orchestrator/external-coding-cli/external-coding-cli-workflow-strategy.ts` — workflow strategy adapter
  - Bus events `coding-cli:*` (16 events; see manifest)
- **Naming rules:**
  - Code: `cliDelegate`, `CliDelegateProviderId`, `external-coding-cli`. Never bare `agent`.
  - Docs/UI: "Claude Code CLI" / "Copilot CLI" / "External coding CLI". The umbrella label "External Coding CLI" or "CLI Delegate" is acceptable when the specific provider is unknown.
- **Common confusion:** Conflating with **#4 (Host CLI)** when reading prompts that mention "Claude Code". Disambiguation rule: if the user is asking Vinyan to *do something* using Claude Code, it's #3. If the user is asking Vinyan *about* Claude Code, it's conversational. If the developer is editing source files via Claude Code, it's #4 and Vinyan doesn't know.

### #4 — Host CLI (Build-time)

The **host CLI** is the AI coding tool the human developer uses to write
Vinyan source code. **It is not a Vinyan runtime concept.** It exists
only at development time.

- **Substrate:** outside Vinyan entirely.
- **Trust:** trusted to the same level as the human developer (every
  diff is reviewed before merge).
- **Identity type:** *(none — Vinyan does not have a type for this)*.
- **Lifetime:** dev-time only.
- **Wire protocol:** *(none — Vinyan does not see this binary)*.
- **Code anchors:** `CLAUDE.md` (project), `~/.claude/CLAUDE.md` (user),
  `AGENTS.md` (if exists), `.claude/` directory contents. **Never `src/`**.
- **Naming rules:**
  - Code: never references this concept. If you find yourself wanting to
    name it in code, you're probably confusing it with #3.
  - Docs: "Host CLI" / "the developer's coding CLI" / "build-time Claude Code".
- **Why it's in this taxonomy:** because the same Claude Code binary is
  also #3, the meta-level confusion is real and needs to be named.

### #5 — Peer Instance (A2A)

A **peer** is another Vinyan installation participating in the A2A
network. Peers exchange facts, capability claims, and trust signals
under the A2A protocol.

- **Substrate:** a full Vinyan orchestrator with API/A2A endpoints.
- **Trust:** `PeerTrustLevel` (`untrusted | probation | trusted`),
  promoted/demoted via Wilson-LB on verification accuracy over time.
- **Identity type (proposed branded):** `PeerInstanceId`.
- **Lifetime:** indefinite (until peer deregisters).
- **Wire protocol:** A2A wire protocol (MCP-compatible at boundary, ECP
  semantics internally).
- **Code anchors:** `src/a2a/`, `src/a2a/identity.ts`, `instanceId`.
- **Naming rules:**
  - Code: `peer`, `peerId`, `instanceId`, `PeerInstanceId`. Never `agent` / `agentId`.
  - Docs/UI: "Peer X" or "Vinyan instance X".
- **Common confusion:** `agentId` field in some A2A messages historically meant `instanceId`. New code uses `instanceId` directly.

---

## Trust boundary hazards

The trust model maps cleanly onto the taxonomy:

```
                    Internal trusted ────────────── Vinyan core (A1 only)
                    │
   Agent (umbrella) ┤
                    │              ┌─ #1 Persona ─ same trust as core, A1
                    │              │                applies
                    │── Internal ──┤
                    │              └─ #2 Worker ── zero-trust subprocess (A6)
                    │
                    │              ┌─ #3 CLI ───── zero-trust subprocess
                    │              │   Delegate    + A1 verification
                    └── External ──┤
                                   │
                                   ├─ #5 Peer ──── PeerTrustLevel earned
                                   │   Instance    over time
                                   │
                                   └─ #4 Host ──── outside Vinyan; not
                                       CLI         a runtime concept
```

**Hazards to watch for:**

- **Applying A6 to a persona** — would force zero-trust gating on what is
  actually internal code; produces phantom rejections.
- **Skipping A1 verification on a CLI delegate** — accepting Claude Code's
  "I'm done!" without running Vinyan's verifier. The 2026-04-30 bug
  pre-fix would have done exactly this if the prompt had been routed
  through the wrong path.
- **Crossing #3 ↔ #4 (file system)** — a developer running #4 to edit
  `src/`, and a deployed Vinyan running #3 to edit user files in the same
  workspace. Use distinct workspace roots to avoid step-on.
- **Self-implementation loop** — Vinyan (#3) refactoring its own
  `src/orchestrator/external-coding-cli/`. Allowed in principle (the
  paradigm encourages self-modification) but requires:
  - the refactor must merge through human review (no auto-merge)
  - the running Vinyan instance must not load the refactored code until
    a fresh deploy
  - the trust ledger must record that #3 produced #3 code

---

## Naming rules (binding for new code)

1. **Never use bare `agent` or `agentId` in new code.** Pick one of
   `persona` / `worker` / `cliDelegate` / `peer` / explicit umbrella
   term `Agent` (rare, reserved for top-level abstractions).
2. **User-facing strings (governance reasons, error messages, prompt
   templates, log lines, UI labels) MUST use the canonical name** of the
   specific dimension. "Agent failed" is forbidden; "Worker subprocess
   failed" or "Persona `developer` failed" is required.
3. **Migrating existing code is gradual.** Don't rip-and-replace; do it
   per subsystem in dedicated PRs. Add the new term, keep the old one as
   a deprecated alias for one release, then remove.
4. **When you can't decide which dimension applies**, you've probably
   spotted a real ambiguity in the design. Surface it for review rather
   than guessing.
5. **`AgentProfile` (in `src/db/agent-profile-store.ts`)** refers to the
   workspace-level Vinyan identity (a singleton record about *this
   Vinyan installation*), not any of the five dimensions above. Treat
   that name as a legacy term scheduled for rename to `InstanceProfile`.

---

## Open RFC: Bus event namespace split

The `agent:*` event namespace currently mixes #1 and #2:

- `agent:session_start`, `agent:session_end` — session lifecycle (#2)
- `agent:turn_complete`, `agent:tool_started`, `agent:tool_executed`,
  `agent:tool_denied`, `agent:text_delta`, `agent:thinking`,
  `agent:contract_violation`, `agent:plan_update`,
  `agent:clarification_requested` — Worker subprocess events (#2)
- `agent:routed`, `agent:synthesized`, `agent:synthesis-failed`,
  `agent:capability-research`, `agent:capability-research-failed`
  — Persona routing events (#1)

**Proposed split (next PR):**

- `agent:*` (worker events) → `worker:*`
- `agent:routed`, `agent:synthesized`, etc. (persona events) → `persona:*`
- Keep old names as deprecated aliases for one release (emit both).
- Update `event-manifest.ts` to reflect the split.
- Rename listeners across `recorder/`, `sse.ts`, vinyan-ui.

Why not in this PR: 17 source files reference `agent:*` events; the
rename is mechanical but large enough to warrant a focused PR with its
own test pass. Documenting the split here lets reviewers think in the
target taxonomy already.

---

## Open RFC: Branded ID adoption

`src/core/agent-vocabulary.ts` defines branded types:

```ts
type PersonaId           = string & { readonly __brand: 'persona' };
type WorkerId            = string & { readonly __brand: 'worker' };
type CliDelegateProviderId = 'claude-code' | 'github-copilot';
type PeerInstanceId      = string & { readonly __brand: 'peer-instance' };
```

Adoption strategy:

1. **Phase 1 (this PR):** define the types + constructors. Don't force
   adoption.
2. **Phase 2:** new code uses branded types. Existing `agentId: string`
   stays.
3. **Phase 3:** migrate `WorkflowStep.agentId` → `PersonaId` (smallest
   blast radius).
4. **Phase 4:** migrate `Trace.workerId`, `Trace.agentId` → `WorkerId`
   / `PersonaId` based on origin.
5. **Phase 5:** add a `tsc`-tier contract test forbidding `string`
   parameters named `agentId` outside an allowlist of legacy files.

---

## Quick lookup for "I just saw 'agent' somewhere — which is it?"

| Context | Almost certainly | Verify with |
|---|---|---|
| `src/orchestrator/agents/` | #1 Persona | check `delegate-sub-agent` strategy nearby |
| `src/orchestrator/worker/` | #2 Worker | check for `subprocess` or `worker-entry` |
| `src/orchestrator/external-coding-cli/` | #3 CLI Delegate | always |
| `src/a2a/` | #5 Peer | check for `instanceId` |
| Bus event `agent:turn_complete` | #2 Worker | always (legacy namespace) |
| Bus event `agent:routed` | #1 Persona | always (legacy namespace) |
| `agentId` in `WorkflowStep.inputs` | #1 Persona | check `step.strategy` |
| `agentId` in `Trace` | #1 Persona (recorded role) | distinct from `Trace.workerId` (#2) |
| `instanceId` | #5 Peer | always |
| `providerId` | #3 CLI Delegate | check value: `claude-code` / `github-copilot` |
| `AgentProfile` in `db/agent-profile-store.ts` | none of the 5 — workspace identity (legacy term) | rename pending |
| Prompt mentions "Claude Code" | #3 if the user wants Vinyan to USE it; #4 if they're describing their own toolchain | check verb + provider context |
| `CLAUDE.md` / `AGENTS.md` | #4 Host CLI configuration | always — these are dev-time files |

---

## Changelog

- **2026-05-01** — initial taxonomy. Five dimensions identified after the
  External Coding CLI routing bug (2026-04-30) revealed the conflation.
  RFC sections record the deferred renames for follow-up PRs.
