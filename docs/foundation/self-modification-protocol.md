# Self-Modification Protocol

> **Status:** authoritative (2026-05-01)
> **Audience:** every contributor — human or AI — who proposes changes to Vinyan's own code
> **Why this doc exists:** Vinyan's core thesis (`CLAUDE.md`) says
> *"a system that can modify its own code can evolve without limits or
> downtime"*. The infrastructure to do this safely already exists in
> pieces; this doc names the end-to-end flow, the trust pre-conditions,
> the activation protocol, and the gaps still under work.

---

## TL;DR

A self-modification request flows through five layers, each a Guard
axiom in action:

```
Generation (worker / persona / CLI delegate / autonomous skill)
   ↓ A1 — different engine for verification
Verification (oracles → tier-clamp → critic → goal-alignment)
   ↓ A4 — content-addressed
Commit (artifact-commit.ts: 4-step path safety, two-pass fail-closed)
   ↓ A6 — orchestrator disposes; A11 (RFC) capability gate evaluates
Activation (vinyan serve --watch supervises child; SIGTERM on file change → respawn)
   ↓ A12 (RFC) — hot-reload protocol; future: state migration
Trust update (skill ledger, profile lifecycle, A11 capability claim)
   ↓ A7 — calibrate from outcome
```

Each layer has a code anchor and an axiom contract. The full pipeline
is *already wired* — the gaps documented at the end are about
strengthening (not establishing) the contracts.

---

## 1. Generation paths

The system has four legitimate paths for producing a code patch. Each
runs under different trust and verification rules.

### 1.1 Vinyan Worker (#2 — agentic loop subprocess)
- **Code:** `src/orchestrator/worker/`, `worker-entry.ts`, `src/orchestrator/agent/agent-worker-entry.ts`
- **Output shape:** `WorkerOutput { mutations: Array<{ file, content, diff, explanation }> }`
- **Trust:** zero-trust per A6. Subprocess isolation. Worker proposes; orchestrator disposes.

### 1.2 Vinyan Persona (#1 — internal specialist)
- **Code:** `src/orchestrator/agents/`, dispatched via workflow `delegate-sub-agent`
- **Output shape:** same `WorkerOutput`-shaped mutations after critic pass.
- **Trust:** internal-trusted; A1 still binds (generator-class persona requires verifier-class persona on the verify side — `assertA1Compatible`).

### 1.3 External CLI Delegate (#3 — Claude Code / GitHub Copilot)
- **Code:** `src/orchestrator/external-coding-cli/`
- **Output shape:** structured CLI claim envelope parsed from stdout/transcript, mapped to mutations.
- **Trust:** zero-trust per A6 + A1 verification. Vinyan's verifier runs after the delegate's claim; verifier verdict overrides the CLI's self-report.
- **Special hazard:** the same Claude Code binary is also #4 (Host CLI used by the developer). See `docs/foundation/agent-vocabulary.md` and §6 below.

### 1.4 Autonomous Skill Creator
- **Code:** `src/skills/autonomous/creator.ts`
- **Output shape:** SKILL.md artifact (skill record), NOT direct source code.
- **Trust:** A1 enforced via `generatorEngineId !== criticEngineId` constructor check (line 86–96). Confidence floor 0.7 before promotion.
- **Note:** This path produces *skills*, not editable source files. Promotion to source-code patch is a future bridge (Gap 5 below).

---

## 2. Verification pipeline

For a typical L2 task touching source code, verification runs in this order:

1. **Guardrails** — `src/guardrails/` (prompt injection, bypass attempts). Synchronous, fail-closed.
2. **Structural oracles in parallel** — `src/oracle/`:
   - AST (syntax)
   - Type checking
   - Dep graph
   - Lint
   - Test runners
   - Goal-alignment check (`goal-alignment-verifier.ts`)
   - CommonSense (mutation classification + surprise gate)
3. **Tier clamping** — `src/oracle/tier-clamp.ts` reduces oracle confidence per tier and per transport.
4. **Content-hash verification** — `src/gate/content-hash-verifier.ts` checks mutations against pre-execution file hashes (A4).
5. **Critic engine** — `src/orchestrator/critic/critic-engine.ts` runs at L2+. A1: separate LLM from generator. Optionally enters debate mode for high-risk mutations (Wave 5).
6. **Goal alignment verifier** — explicit expectation-match check against the user goal.
7. **Pipeline confidence aggregator** — `src/orchestrator/pipeline-confidence.ts` combines oracle + critic confidences against `PIPELINE_THRESHOLDS`.

All deterministic. No oracle output feeds back into routing (A3).

---

## 3. Commit contract

### 3.1 Path safety
`src/orchestrator/worker/artifact-commit.ts:validateArtifactPath` (lines 77–126) enforces the 4-step protocol:

1. Reject absolute paths.
2. Reject `..` traversal (lexical).
3. `realpath` containment check (handles macOS `/var` → `/private/var` aliasing).
4. Reject symlinks at the target file.
5. Verify parent directory's `realpath` is contained (defends symlink-in-parent escapes).

### 3.2 Two-pass fail-closed
`commitArtifacts(workspace, artifacts, opts?)`:

- **Pass 1:** preflight every path. If ANY fails, return `{ applied: [], rejected: [...all-bad-paths] }`. Zero writes.
- **Pass 2:** only when preflight is clean, write each artifact. Per-file failures land in `rejected`; siblings already written remain on disk **unless `opts.rollbackOnPartialFailure` is set**.

### 3.3 A11 RFC gate (post-preflight, pre-write)
When `opts.bus + opts.taskId + opts.actor` are wired, the commit emits
`commit:capability_escalation_evaluated` with `decision: 'allow'` today.
Future enforcement: workers/peers with Wilson-LB ≥ 0.99 over many
traces of a task class get direct-mutate permission for that class only.

### 3.4 Gap 4 — dormant pending reload
Successful Pass 2 writes that land under `src/orchestrator/`,
`src/core/`, `src/api/`, or `src/cli/` emit
`commit:dormant_pending_reload` so UIs can warn "this change requires
reload" before activation.

### 3.5 Gap 7 — rollback on partial failure
With `opts.rollbackOnPartialFailure: true`, the commit takes a
pre-write snapshot of every artifact path that already exists. On
partial Pass 2 failure, snapshots restore previous content (or
unlink files that didn't exist before). The contract becomes
all-or-nothing.

---

## 4. Activation contract

The activation infrastructure exists today: `vinyan serve --watch` in
`src/cli/supervise.ts`.

### 4.1 How it works
- Supervisor spawns the actual server as a child subprocess.
- When `--watch` is set, supervisor watches `src/**/*.ts` and `vinyan.json`.
- File change → debounce 200ms → SIGTERM child → respawn child with fresh module imports.

The supervisor's own comment (`supervise.ts:7-13`) names this the
self-evolution path: *"This lets Vinyan evolve itself: regenerate its
own code, save, and see the running server pick up the change without
a manual restart."*

### 4.2 What this means for self-modification
A worker / CLI delegate / persona that commits a patch under `src/`
will see the change *activate* automatically when:
1. The deployment is running `vinyan serve --watch` (not the default).
2. The supervisor's child is healthy enough to accept SIGTERM gracefully.
3. The new code parses and starts (otherwise child crashes; supervisor backs off).

### 4.3 Open work for full A12 (Phase 7, separate PR)
- **State migration**: in-flight task queue persisted to DB before SIGTERM, picked up by new child at startup. Today, in-flight tasks die.
- **Schema-change detection**: refuse hot-reload when a new migration is pending; require manual `vinyan migrate && vinyan serve` so DB and code stay in lockstep.
- **`vinyan serve --self-modify` command**: a deployment mode that implies `--watch` plus state migration plus elevated reload gating.

---

## 5. Trust pre-conditions

Self-modification is gated by accumulated trust. The relevant ledgers:

### 5.1 Skill Trust Ledger
- **Code:** `src/db/skill-trust-ledger-store.ts`
- States: `fetched → scanned → quarantined | dry_run → critic_reviewed → promoted | demoted → retired | rejected`.
- Profile-scoped; cross-profile reads require explicit `'ALL'` sentinel.
- Autonomous skill promotion floor: `AUTONOMOUS_GATE_CONFIDENCE_FLOOR = 0.7` (`src/skills/autonomous/creator.ts:68-69`).

### 5.2 Profile Lifecycle
- **Code:** `src/orchestrator/profile/profile-lifecycle.ts`
- FSM: `probation → active → demoted → retired`.
- Invariant I8: never demote the last active profile.
- `maxDemotions` cap (default 3) → permanent retirement.

### 5.3 Capability Escalation (A11 RFC)
- Code seam: `src/orchestrator/worker/artifact-commit.ts` (event today).
- Future contract: Wilson-LB ≥ 0.99 over N>1000 traces of task class C → direct-mutate authority within C, audited per mutation, revoked on any error.

### 5.4 Adaptive Parameter Ledger
- **Code:** `src/orchestrator/adaptive-params/parameter-ledger.ts`, migration 030.
- Every mutation to a tunable ceiling (Wilson-LB threshold, cache TTL, etc.) is recorded with timestamp + actor + reason + old/new value.
- Sleep-cycle, operator config, and autonomous tuner all write through this ledger.

---

## 6. Self-application boundary (Gap 3)

The most subtle hazard: **a CLI delegate (#3) modifying its own
subsystem**. Concretely: a user types
*"ask Claude Code to refactor src/orchestrator/external-coding-cli/"*.
Vinyan would spawn Claude Code (#3) to edit the very code that drives #3.

The deterministic rule the orchestrator enforces:

- If the originating intent was a #3 delegation AND the resolved
  `targetPaths` includes any path under
  `src/orchestrator/external-coding-cli/`, refuse autonomous dispatch.
- Emit `coding-cli:self_application_detected` with `taskId`,
  `providerId`, `targetPaths`, and reason.
- Require explicit human approval before proceeding (escalate via
  approval gate).

This rule lives in the core-loop ECC fast-path (Phase 6 implementation).

---

## 7. Gap status

The 2026-04-30 self-modification audit identified seven gaps. Status as of 2026-05-01:

| # | Gap | Status |
|---|---|---|
| 1 | Activation Protocol | **Partial.** `vinyan serve --watch` exists; default off. State migration + schema-change gating deferred to Phase 7 PR. |
| 2 | External CLI scope enforcement (`allowedScope`/`forbiddenScope`) | **Resolved (Phase 6).** Scope rules now enforced in runner + approval bridge. |
| 3 | Self-application boundary | **Resolved (Phase 6).** Deterministic rule in core-loop ECC dispatch. |
| 4 | Silent durability after orchestrator-self-mutation | **Resolved (Phase 6).** `commit:dormant_pending_reload` event emitted. |
| 5 | Skill promotion to source code | **Out of scope.** Distinct architecture problem; SKILL.md → source-bridge requires a separate spec. |
| 6 | Heightened verification for self-mutations | **Resolved (Phase 6).** Critic engine runs an extra pass when targets fall under `src/orchestrator/`. |
| 7 | Rollback on partial commit failure | **Resolved (Phase 6).** `commitArtifacts` accepts `rollbackOnPartialFailure: true` for all-or-nothing semantics. |

---

## 8. End-to-end example: self-improvement walkthrough

A worker proposes a refactor to `src/sleep-cycle/wilson.ts`:

1. **Generation.** Worker `worker-3` (Wilson-LB 0.91 over 850 traces in
   `class:numerical-refactor`) emits `WorkerOutput` with mutations.
2. **Verification.** Oracles (AST, type, lint, test) all return
   `verified` at `tier=heuristic, confidence=0.92`. Critic (separate
   engine — `mock/balanced` while generator was `mock/powerful`)
   returns `accepted`. Pipeline confidence 0.88 → above threshold.
3. **A11 stub fires.** `commit:capability_escalation_evaluated` emits
   `decision: 'allow'` (the gate is informational today; future
   enforcement may have already auto-allowed this worker for
   numerical-refactor class once Wilson-LB > 0.99).
4. **Commit.** `commitArtifacts` writes the new wilson.ts. Path under
   `src/sleep-cycle/` doesn't trigger reload-required (only
   `src/orchestrator/`, `src/core/`, `src/api/`, `src/cli/` do — but the
   prefix list could be extended).
5. **Activation.** If running under `vinyan serve --watch`, supervisor
   detects the file change, SIGTERMs the child, child respawns with new
   wilson.ts loaded. In-flight tasks die today (state migration
   pending in Phase 7).
6. **Trust update.** Outcome of next sleep-cycle that uses the new
   wilson.ts feeds A7's calibration loop. If predictions improve,
   `worker-3`'s Wilson-LB rises further; if they regress, the trust
   trace records the drop and A11 enforcement (when it lands) revokes
   direct-mutate authority.

This loop is the operational definition of "evolve without limits".

---

## 9. References

- **Axioms:** `docs/foundation/concept.md` §1 (A1–A7) and §1.3b (A11–A14 RFC)
- **Vocabulary:** `docs/foundation/agent-vocabulary.md` (#1–#5 disambiguation)
- **Adaptive parameters:** `src/orchestrator/adaptive-params/parameter-registry.ts`
- **Commit gate:** `src/orchestrator/worker/artifact-commit.ts`
- **Activation supervisor:** `src/cli/supervise.ts`
- **Trust ledgers:** `src/db/skill-trust-ledger-store.ts`, `src/orchestrator/profile/profile-lifecycle.ts`, `src/orchestrator/adaptive-params/parameter-ledger.ts`
- **Axiom self-test suite:** `tests/axiom-invariants/`
