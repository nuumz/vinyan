# Persona Role Embodiment — Implementation Plan

**Status:** 📋 Proposed (2026-05-03). Not yet started. This document is the planning artifact for branch `claude/add-persona-roles-ZRQbI`.

> **Document boundary:** Owns the design for *enforced* role-cognition in personas — a layer that sits between Persona identity (`src/orchestrator/agents/`) and Phase execution (`src/orchestrator/phases/`). Persona/Skill redesign closure remains in [persona-skill-redesign-future-backlog.md](./persona-skill-redesign-future-backlog.md). Agent vocabulary boundaries remain in [agent-vocabulary.md](../foundation/agent-vocabulary.md).

## Table of contents

1. [Problem statement](#1-problem-statement)
2. [Thesis: roles are workflow contracts, not personalities](#2-thesis-roles-are-workflow-contracts-not-personalities)
3. [Architecture: Persona × RoleProtocol × DomainPack](#3-architecture-persona--roleprotocol--domainpack)
4. [Data model](#4-data-model)
5. [Three reference protocols](#5-three-reference-protocols)
6. [RoleProtocol engine](#6-roleprotocol-engine)
7. [Per-role oracles](#7-per-role-oracles)
8. [Configuration surface](#8-configuration-surface)
9. [Sleep-cycle integration](#9-sleep-cycle-integration)
10. [Skill admission & persona affinity](#10-skill-admission--persona-affinity)
11. [Reality anchoring — delusion & psychosis safeguards](#11-reality-anchoring--delusion--psychosis-safeguards)
12. [Axiom mapping](#12-axiom-mapping)
13. [Phasing & sizing](#13-phasing--sizing)
14. [Risk register](#14-risk-register)
15. [Verification plan](#15-verification-plan)
16. [Open questions](#16-open-questions)
17. [Out of scope](#17-out-of-scope)

---

## 1. Problem statement

The current persona surface (`src/orchestrator/agents/builtin/`) provides nine role-pure templates with **shallow identity**: a 200–400 word `soul` string plus capability tags and an ACL override. The `researcher` soul (`src/orchestrator/agents/builtin/researcher.ts:52`) reads:

> *"Investigate before concluding. Cite sources for every load-bearing claim. When sources disagree, name the disagreement..."*

This is **identity, not methodology**. Whether the underlying LLM actually performs literature discovery, comparison, and citation extraction is left to the LLM's discretion — there is no rule-based contract that *enforces* the research workflow. The same critique applies to every Generator-class persona.

Three concrete role demands surface this gap:

| Role | Required cognitive workflow | What current personas miss |
|---|---|---|
| **Researcher** | discover sources → fetch → compare → synthesize with citations → fact-check | No discovery step, no citation oracle, no source-disagreement enforcement |
| **Secretary** | load org context → relevance-filter → support-draft in org voice → confirm scope | No org-context injection, no voice oracle, no scope-confirmation step |
| **Content creator** | scan trends → ideate → score novelty → draft → trend-alignment check | No trend feed substrate, no novelty scoring, no trend-alignment oracle |

The shared failure mode: **the LLM is asked to "be" the role, but the orchestrator does not verify that the role's epistemic process was followed**. This violates A1 in spirit — generation evaluates its own adherence to the role contract.

## 2. Thesis: roles are workflow contracts, not personalities

> **Claim:** Soul prompts encode *who the persona is*. RoleProtocols encode *how the persona must work*. The orchestrator enforces the protocol; the LLM fills in the protocol's slots.

This split keeps governance deterministic (A3) while letting the probabilistic engine do what it does best. The protocol is a small state machine — ordered steps, preconditions, oracle hooks, exit criteria — compiled from a declarative spec. The dispatcher refuses to advance past a step whose oracle returns `unknown`/`contradictory` without re-prompting or escalating.

Existing precedent in the codebase:
- A1 verifier routing (`src/orchestrator/agents/a1-verifier-router.ts`) already encodes a deterministic rule on top of personas; RoleProtocols generalize the pattern.
- Phase-15 skill graduation (`src/skills/autonomous/tier-graduation.ts`) shows the codebase is willing to compile cognitive policy into rule-driven artifacts.
- The Persona Class taxonomy (`src/orchestrator/agents/persona-class.ts:30-45`) already separates *what a persona does* from *who it is*. RoleProtocol is the next axis: *how it does it*.

## 3. Architecture: Persona × RoleProtocol × DomainPack

Three orthogonal axes, each owned by a separate subsystem:

```
                  ┌──────────────────────────────┐
                  │  Persona (existing)          │
                  │  identity + ACL + soul       │  src/orchestrator/agents/
                  └──────────────────────────────┘
                                 ×
                  ┌──────────────────────────────┐
                  │  RoleProtocol (NEW)          │
                  │  steps + oracles + exit      │  src/orchestrator/agents/role-protocols/
                  └──────────────────────────────┘
                                 ×
                  ┌──────────────────────────────┐
                  │  DomainPack (existing skills)│
                  │  tools + vocabulary + sources│  src/skills/
                  └──────────────────────────────┘
```

Composition rules:

1. A persona may declare a default `roleProtocol`; runtime caller can override (`TaskInput.roleProtocolId`).
2. A protocol may require domain capabilities (e.g. `secretary.brief` requires `org:context`); the dispatcher fails fast if the persona's skills cannot supply them.
3. The protocol's evidence chain is a strict superset of any oracle's evidence chain — every protocol step contributes one or more `Evidence` rows tagged `source: 'role-step:<stepId>'` (A4 + A8 traceability).
4. Protocol selection is rule-based on `(persona.role, taskDomain, taskInput.tags)`. No LLM in the selection path (A3).

## 4. Data model

New types in `src/orchestrator/agents/role-protocols/types.ts`:

```typescript
export type RoleProtocolId = string & { readonly __brand: 'RoleProtocolId' };

export interface RoleProtocol {
  id: RoleProtocolId;                    // 'researcher.investigate'
  bindsRoles: ReadonlyArray<PersonaRole>; // ['researcher']
  bindsDomains: ReadonlyArray<TaskDomain>;// ['general-reasoning']
  steps: ReadonlyArray<RoleStep>;
  exitCriteria: ReadonlyArray<ExitCriterion>;
  fallback: 'persona-default' | 'escalate' | 'unknown';
  // A4: protocol body itself is content-addressed; changes invalidate cached
  // step plans bound to a task.
  contentHash: string;
}

export interface RoleStep {
  id: string;                            // 'discover-sources'
  kind: StepKind;                        // see below
  required: boolean;
  preconditions: ReadonlyArray<Precondition>;
  oracles: ReadonlyArray<OracleHook>;    // structural verification per step
  prompt?: string;                       // step-scoped guidance prepended to soul
  budget?: { tokens?: number; ms?: number };
}

export type StepKind =
  | 'discover'    // enumerate candidate sources / inputs
  | 'gather'      // fetch / load source content
  | 'analyze'     // compare, classify, extract
  | 'synthesize'  // produce coherent artifact
  | 'verify'      // run an oracle on a prior step's output (A1: different RE)
  | 'draft'       // produce candidate output
  | 'critique'    // self-review (only legal in mixed-class personas)
  | 'confirm';    // user/scope confirmation gate

export interface Precondition {
  kind: 'evidence-present' | 'capability-bound' | 'env-var' | 'config-key';
  ref: string;                           // e.g. 'role-step:discover-sources' or 'org.voice'
}

export interface OracleHook {
  oracleId: string;                      // 'source-citation', 'org-voice', 'trend-alignment'
  inputBindings: Record<string, string>; // map oracle input slots to step outputs
  blocking: boolean;                     // step cannot complete on `unknown` if true
}

export interface ExitCriterion {
  kind: 'all-required-steps-ok' | 'evidence-confidence' | 'oracle-verdict';
  threshold?: number;                    // confidence floor when applicable
  oracleId?: string;
}
```

Branded `RoleProtocolId` mirrors the `PersonaId` pattern at `src/core/agent-vocabulary.ts:33-34`. Adoption is gradual; existing string callers continue to compile.

## 5. Three reference protocols

### 5.1 `researcher.investigate`

```
discover-sources    → analyse candidate sources (web, local docs, knowledge graph)
gather-content      → fetch each source; record fetch_hash (A4)
compare-extract     → cross-source claims into a claim table; flag disagreements
synthesize          → draft synthesis, each claim carrying ≥1 source ref
verify-citations    → source-citation oracle (blocking)
verify-cross-source → cross-source-disagreement oracle (non-blocking; surfaces uncertainty per A2)
```

Exit: all required steps `ok` AND `verify-citations.confidence ≥ 0.85`.

### 5.2 `secretary.brief`

```
load-context        → load org context (vinyan.json `org.context_path`)
clarify-scope       → confirm-step; produces a scoped task spec or hands off
relevance-filter    → reduce loaded context to scope-relevant subset
draft-support       → produce briefing/draft using filtered context
verify-org-voice    → org-voice oracle (blocking)
verify-scope        → scope-coverage oracle (non-blocking)
```

Exit: scope confirmed AND voice oracle `ok` AND draft references ≥1 context evidence row.

### 5.3 `content-creator.ideate`

```
scan-trends         → query registered trend feeds; record snapshot hash (A4)
ideate              → produce ≥3 candidate angles with novelty rationale
score-novelty       → rank candidates against historical persona output corpus
draft               → expand top-ranked angle into full content
verify-trend-align  → trend-alignment oracle (non-blocking; informs confidence)
critique            → mixed-class self-review allowed here per persona-class.ts:38-45
```

Exit: at least one candidate above novelty floor AND draft references ≥1 trend snapshot.

### 5.4 New built-in personas

- `secretary` (NEW; `mixed` class — light reflex + dialogue + logistics fits the existing `MIXED_ROLES` definition at `src/orchestrator/agents/persona-class.ts:45`)
- `content-creator` (NEW; `generator` class)
- `researcher` (existing) — gains default `roleProtocol: 'researcher.investigate'`

## 6. RoleProtocol engine

New module: `src/orchestrator/agents/role-protocol-engine.ts`.

Responsibilities:

1. Resolve `(persona, taskInput) → RoleProtocol` deterministically (rule table; no LLM).
2. For each step in order:
   - Check preconditions; halt with `type:'unknown'` (A2) if any unmet.
   - Render step-scoped prompt (`step.prompt + soul + persona ACL identity`) and dispatch to the persona's RE.
   - Capture step output as `Evidence{source:'role-step:<id>', confidence, content_hash}`.
   - Run each `OracleHook`; on blocking `unknown`/`contradictory`, retry once then escalate per `protocol.fallback`.
3. Evaluate exit criteria; on success, hand the assembled evidence chain back to the calling phase.
4. Append a `role_protocol_run` row to the audit table (A8).

Constraints:
- Step transitions are rule-based on oracle verdicts only; no LLM in the governance path (A3).
- The engine is invoked from `phase-generate.ts` (`src/orchestrator/phases/phase-generate.ts:51-80`) when the dispatched persona has a bound protocol. Backwards compatible: persona without protocol → existing single-shot dispatch.
- `verify` steps must call a different RE from any prior `analyze`/`synthesize`/`draft` step in the same run (A1 enforcement at engine level, not just persona pair).

## 7. Per-role oracles

Three new oracles under `src/oracle/role/`:

### 7.1 `source-citation` oracle

- Input: synthesized text + claim table from compare-extract step.
- Algorithm: every claim row must have ≥1 `evidence_chain` entry whose `source.kind === 'fetched-doc'` and whose `content_hash` matches a row from the gather step.
- Returns `known` if every claim cited; `contradictory` if claims contradict source content; `unknown` if any claim missing a citation.
- Tier: deterministic (A5) — pure structural check.

### 7.2 `org-voice` oracle

- Input: drafted text + voice profile from `vinyan.json` `org.voice` (style markers, tone descriptors, banned phrases).
- Algorithm: deterministic banned-phrase scan + structural style markers (sentence length distribution, formality markers). Probabilistic style judgment delegated to a separate RE (A1).
- Returns `known`/`uncertain` per A5 tier.
- Voice profile is content-addressed (A4); profile change triggers re-verification of any cached `secretary.brief` runs.

### 7.3 `trend-alignment` oracle

- Input: drafted content + active trend snapshot.
- Algorithm: keyword/topic overlap scoring + freshness check (snapshot age ≤ TTL).
- Non-blocking: low alignment attenuates confidence, does not fail the task (A2 — uncertainty is first-class).
- Tier: heuristic (A5).

All three oracles ship with circuit breakers per existing pattern (`failureThreshold=3, resetTimeout=60s` per CLAUDE.md §quality gates).

## 8. Configuration surface

Additions to `src/config/schema.ts`:

```yaml
agents:
  - id: my-secretary
    name: Org Secretary (TH)
    role: secretary
    role_protocol: secretary.brief        # NEW
    soul_path: .vinyan/agents/my-secretary/soul.md   # default location; explicit override optional
    capability_overrides: { writeAny: false, network: true }

org:                                      # NEW section
  # Workspace-scope by default; resolve precedence mirrors persona-skill-loader:
  # `<workspace>/.vinyan/org/context.md` then `~/.vinyan/org/context.md`.
  context_path: .vinyan/org/context.md
  voice:
    style: formal-thai-business
    banned_phrases: ["just FYI", "tl;dr"]
    formality_markers: { khrap_kha_required: true }

content:                                  # NEW section
  trend_feeds:
    - id: x-trends
      kind: rss
      url: https://example.com/x-trends.rss
      ttl_minutes: 30
    - id: google-trends
      kind: api
      key_env: GTRENDS_API_KEY
      ttl_minutes: 60
  novelty:
    historical_window_days: 90
    min_novelty_score: 0.6

role_protocols:                           # NEW section — operator overrides
  researcher.investigate:
    exit_criteria:
      - kind: evidence-confidence
        threshold: 0.85
```

All sections optional; absence triggers protocol-level fallback per `protocol.fallback`.

### 8.1 On-disk layout

Per-agent assets follow the existing convention from `src/orchestrator/agents/registry.ts:140` and `src/skills/simple/loader.ts:20-23` — every agent owns a directory keyed by its `id`, never a flat file in `.vinyan/agents/`:

```
<workspace>/.vinyan/agents/<agent-id>/
  ├── soul.md              # default soul location (overridable via `soul_path`)
  ├── skills.json          # bound skill snapshot (Phase-13)
  └── skills/<name>/       # per-agent project-scope skills
      └── SKILL.md

~/.vinyan/agents/<agent-id>/
  └── skills/<name>/       # per-agent user-scope skills
      └── SKILL.md
```

This redesign adds **no new per-agent files**. Role protocols live under `<workspace>/.vinyan/role-protocols/<protocol-id>.yaml` (or are loaded from built-ins shipped in `src/orchestrator/agents/role-protocols/builtin/`); they are persona-agnostic and bind to multiple personas, so they do not nest under `.vinyan/agents/<id>/`.

Resolution precedence for any per-agent asset matches `persona-skill-loader.ts`:

1. Explicit `soul_path` / `<asset>_path` from `vinyan.json` (absolute or workspace-relative)
2. `<workspace>/.vinyan/agents/<agent-id>/<asset>` (project scope)
3. `~/.vinyan/agents/<agent-id>/<asset>` (user scope)
4. Built-in default shipped in source



## 9. Sleep-cycle integration

The sleep-cycle (`src/sleep-cycle/`) already mines patterns from trace history. Two additions:

1. **Step-success EMA** per `(persona, protocolId, stepId)`. Drives:
   - Adaptive prompt enrichment for chronically-failing steps.
   - Demotion/quarantine of protocol versions whose Wilson LB < 0.4 over ≥30 runs (mirrors skill graduation pattern at `src/skills/autonomous/tier-graduation.ts`).
2. **Adaptive ceiling parameters** registered in `src/orchestrator/adaptive-params/parameter-registry.ts`:
   - `role.exit.confidence_floor` (default 0.85, range 0.7–0.95)
   - `role.step.retry_max` (default 1, range 0–2)
   - `role.oracle.unknown_tolerance` (default 0, range 0–2 unknowns/run)

Per CLAUDE.md §"Guard axioms vs Ceiling parameters" these are tunable, not load-bearing for safety — protocol *correctness* is the guard, exit *strictness* is the ceiling.

## 10. Skill admission & persona affinity

**Problem.** Today's autonomous skill pipeline (`src/orchestrator/agents/skill-acquirer*.ts` → `skill-promoter.ts` → `persona-skill-loader.ts`) gates on **statistical** signal: a skill enters a persona's `bound` set when its Wilson lower bound and graduation tier clear thresholds. Nothing prevents a `researcher` from accumulating `marketing-copy-write` skills, or a `secretary` from binding `kernel-debugging`. Statistical fitness ≠ role fitness; without a role gate, a persona can grow into something its workflow contract no longer describes — wrong-direction growth.

**Thesis.** A persona is its **role × skill signature**, not its `id`. A skill must reinforce, not dilute, the role contract. Admission is a separate rule from promotion.

### 10.1 Affinity model

Two new fields, both rule-evaluable (A3):

1. **`Persona.roleAffinity: AffinityTag[]`** — declared in soul YAML frontmatter alongside existing capability tags. `AffinityTag` is a closed enum: `research | writing | code-modify | code-review | ops | content-create | synthesis | coordination | analysis | creative-trend`. Closed enum because open vocabularies drift (a foundational lesson from `agent-vocabulary.md`).
2. **`SkillManifest.roleAffinity: AffinityTag[]`** — required field in SKILL.md frontmatter (zod schema rejects empty). Existing skills audited via one-shot migration (`bun run migrate:skill-affinity`); the migration tool emits a stub PR for each skill listing the affinity tags it derived from the skill's first 200 chars + existing tags, for human approval. No silent inference at runtime.

The model is intentionally **multi-label** — a skill may legitimately reinforce more than one role. `secretary.brief` reinforces `writing + synthesis + coordination`; `code-review` reinforces `code-review + analysis`.

### 10.2 SkillAdmissionPolicy (rule-based, A3)

Inserts before `applyPromotions` in `src/orchestrator/agents/skill-promoter.ts`. Inputs: candidate `SkillManifest`, target `Persona`. Output: `'accept' | 'pending-operator' | 'reject'`.

```ts
// new file: src/orchestrator/agents/skill-admission.ts
type AdmissionVerdict =
  | { kind: 'accept'; overlap: number }
  | { kind: 'pending-operator'; overlap: number; rationale: string }
  | { kind: 'reject'; rationale: string };

function decideAdmission(skill: SkillManifest, persona: Persona): AdmissionVerdict {
  const intersect = skill.roleAffinity.filter(t => persona.roleAffinity.includes(t));
  const overlap = intersect.length / skill.roleAffinity.length; // skill-anchored ratio
  if (overlap === 0) return { kind: 'reject', rationale: `no affinity overlap with ${persona.id}` };
  if (overlap < ROLE_AFFINITY_ACCEPT_FLOOR) {
    return { kind: 'pending-operator', overlap, rationale: 'partial overlap; operator confirmation required' };
  }
  return { kind: 'accept', overlap };
}
```

`ROLE_AFFINITY_ACCEPT_FLOOR` is a **tunable ceiling** (default 0.5, range 0.3–0.8) registered in `parameter-registry.ts`. The *existence* of the gate is the guard axiom; the *strictness* is the ceiling. Sleep-cycle may relax/tighten the floor based on long-run task-success-by-persona, but it cannot disable the gate.

`reject` records a `skill_admission_audit` row (A8) and never enters `bound`. `pending-operator` parks the skill in `pending_admission` — surfaced via TUI and `vinyan persona admissions` CLI; never auto-binds.

### 10.3 Persona drift signature

Sleep-cycle (`src/sleep-cycle/`) gains a new mining job:

- `personaSkillSignature(personaId)` = multiset histogram of every bound skill's `roleAffinity` tags.
- Compared per audit cycle to `persona.roleAffinity` via cosine similarity.
- When `cosine < SIGNATURE_DRIFT_FLOOR` (default 0.7) over a rolling 20-bind window, emit a `persona.drift.detected` event carrying the divergent tags.
- Operator review is mandatory; auto-action is **freeze new admissions for that persona**, not silent rebalancing. Forced silent re-shaping of a persona is itself wrong-direction growth.

### 10.4 Why this is not "skill firewall"

Adversarial framing (skills as attackers, persona as victim) fits zero-trust execution (A6) — but skills here are not external code, they are *capabilities the persona learned*. The right mental model is **professional development**: a researcher who keeps signing up for marketing courses is not failing a firewall, they are losing the thread of their role. The admission policy is a career-coach gate, not a perimeter.

Adversarial skill content (malicious SKILL.md from a hub) remains the responsibility of the existing K1 guardrails and skill-importer signature checks — out of scope for this section.

## 11. Reality anchoring — delusion & psychosis safeguards

**Two distinct failure modes**, requiring distinct mechanisms:

| Mode | Definition | Failure horizon | Existing partial mitigation |
|---|---|---|---|
| **Delusion** | A single belief held with high confidence that contradicts oracle-verifiable reality | One claim, one moment | A4 hashes auto-invalidate *facts*; persona-internal *summaries* of facts do not auto-invalidate |
| **Psychosis** | Sustained drift between persona's predicted outcomes and oracle-verified outcomes across many tasks | Multi-task, multi-day | A10 goal-grounding (`src/orchestrator/goal-grounding.ts`) catches per-task drift; multi-task drift is unmeasured |

A1 enforces separation per-decision; A4 binds facts to file hashes; A10 catches per-task goal drift. None of these catch a persona whose **persisted internal state** has drifted from the actual world. Reality anchoring fills that gap.

### 11.1 DelusionDetector — single-claim reality check

`src/orchestrator/agents/reality-anchor/delusion-detector.ts`. Runs in `phase-verify` after oracle verdicts return, before commit.

For every claim in the persona's output that references a content-addressed `Fact` (file content, oracle verdict, prior decision), the detector:

1. Re-fetches the fact's **current** content hash (cheap, A4-native).
2. Compares against the hash recorded when the persona acquired the fact.
3. Re-runs the smallest deterministic oracle that originally produced the fact (e.g. `ast-oracle` for a "function X has signature Y" claim).

Output:

```ts
type RealityCheckVerdict =
  | { kind: 'consistent'; checkedClaims: ClaimRef[] }
  | { kind: 'delusion'; falsified: Array<{ claim: ClaimRef; expectedHash: string; actualHash: string; oracleVerdict: OracleVerdict }> };
```

**Action on `delusion`**: confidence for the affected claims attenuates to `unknown` (A2 — protocol-honest), the persona's working memory entry for that fact is invalidated, and `phase-verify` returns `escalate-and-reground` rather than `ok`. No silent overwrite — the original belief is preserved with a `delusion-falsified-at: <ts>` annotation for audit.

This is **A4 extended from facts to derived beliefs** — content-addressed truth applied not just to files but to the persona's mental model of files.

### 11.2 PsychosisMonitor — multi-task drift watcher

`src/orchestrator/agents/reality-anchor/psychosis-monitor.ts`. Subscribes to `EventBus` `task.complete` and `phase.verify.complete`. Maintains rolling per-persona window (default size 20).

Per-window scalars:

- `meanPredictionError` — `mean(abs(predicted_confidence_at_plan − actual_confidence_at_verify))`
- `oracleContradictionRate` — `count(oracle.kind === 'falsified') / count(oracle.*)`
- `goalDriftRate` — `count(goal-grounding.action !== 'ok') / window`
- `delusionRate` — `count(reality-check.kind === 'delusion') / window`

**Re-grounding triggers** (any one fires; rule-based, A3):

| Signal | Threshold | Source of threshold |
|---|---|---|
| `meanPredictionError` | > 0.4 | parameter-registry: `psychosis.prediction_error_ceiling` |
| `oracleContradictionRate` | > 0.2 | parameter-registry: `psychosis.contradiction_ceiling` |
| `goalDriftRate` | > 0.3 | parameter-registry: `psychosis.goal_drift_ceiling` |
| `delusionRate` | > 0.15 | parameter-registry: `psychosis.delusion_ceiling` |

All four are tunable ceilings, not guard axioms. The *existence of the monitor* is the guard.

### 11.3 Re-grounding protocol

Triggered by either DelusionDetector (per-claim) or PsychosisMonitor (per-persona). Five rule-based stages, each emitting an audit row to `reality_anchor_audit` (A8):

1. **Quarantine** — persona enters `state: 'quarantined'`; new task dispatch to it returns `unknown` confidence. In-flight tasks finish but commit is gated on stage 5 reentry.
2. **Evidence rebuild** — for every fact in the persona's working memory, re-hash the source file and re-query its origin oracle. Drop facts whose hash changed without explicit acquisition; re-anchor facts whose hash is current.
3. **Belief prune** — drop tier-3 (probabilistic) cached beliefs unconditionally; keep tier-1 (deterministic) and tier-2 (heuristic) only where evidence rebuild confirmed them. (Tier definitions per A5.)
4. **Replay** — for last N committed decisions (default 10), re-evaluate against rebuilt evidence using the original RE pool. Contradictions logged; decisions are not retroactively reversed (the work happened, the world saw it), but their confidence in `world-graph` is downgraded.
5. **Reentry** — operator approval **OR** M consecutive shadow-mode tasks (default 5) with no triggers firing. On reentry, persona returns to `state: 'active'`; signature & soul preserved.

**Recovery, not reset.** Soul, role-protocol, role-affinity, bound skills all persist. Only probabilistic state (tier-3 beliefs, summaries, prediction caches) is rebuilt. The persona wakes from a bad dream — it is not factory-reset.

### 11.4 Why a separate monitor and not "just A10"

A10 (Goal-and-Time Grounding, `src/orchestrator/goal-grounding.ts`) catches drift **within one task** by comparing root intent vs current execution goal via token-Jaccard. PsychosisMonitor measures drift **across tasks** by comparing predicted vs actual oracle outcomes. They are complementary:

- A10: "the goal you're chasing now is not the goal you started this task with"
- PsychosisMonitor: "the world you think you're operating in is not the world the oracles report"

A formal proposal to widen A10's enforcement coverage to multi-task is the natural axiom-promotion path; this design is the implementation candidate behind that promotion.

### 11.5 Interaction with skill admission (§10)

Re-grounding does not touch admission state by default. But if the same persona triggers re-grounding ≥ 3 times within a 100-task window, sleep-cycle automatically re-runs `personaSkillSignature` analysis: chronic psychosis correlated with a specific skill bundle is a signal that the *bundle*, not the persona, is the source. The bundle's lowest-Wilson-LB skill is unbinned (with audit row), and the persona is allowed reentry. This is the only path by which reality anchoring can prune skills — never through a single delusion event.

## 12. Axiom mapping

| Axiom | How this design honors it |
|---|---|
| **A1 Epistemic Separation** | `verify` steps run on a different RE than the prior generator step; engine refuses same-RE verify pairs. **DelusionDetector** extends A1 across persisted state — a persona's stored summary of a fact is verified against a different (deterministic) RE than the LLM that produced the summary. |
| **A2 First-Class Uncertainty** | Unmet preconditions → `type:'unknown'`; non-blocking oracles attenuate confidence rather than failing. Falsified delusions emit `unknown`, never silent overwrite. |
| **A3 Deterministic Governance** | Protocol resolution, step advancement, oracle dispatch, **skill admission, re-grounding triggers** all rule-based — no LLM in the path |
| **A4 Content-Addressed Truth** | `protocol.contentHash` + per-step evidence hashes + voice/trend snapshot hashes. **DelusionDetector** applies A4 to persona-derived beliefs, not just source facts |
| **A5 Tiered Trust** | source-citation = deterministic; org-voice = deterministic+probabilistic split; trend-alignment = heuristic. Re-grounding stage 3 prunes tier-3 unconditionally and keeps tier-1/2 only when hash-validated |
| **A6 Zero-Trust Execution** | RoleProtocolEngine + reality-anchor components run in orchestrator, not workers; workers only execute LLM dispatch slots |
| **A7 Prediction Error as Learning** | Step-success EMA feeds sleep-cycle adaptation. **PsychosisMonitor** is the prediction-error loop applied to the persona's reality-model, not just to skill graduation |
| **A8 (proposed)** | `role_protocol_run` audit table + new `skill_admission_audit` and `reality_anchor_audit` tables record actor, evidence, policy version, timestamp |
| **A9 (proposed)** | Trend-feed failure → degraded confidence per circuit breaker; org-voice oracle missing → `unknown`, not crash. Re-grounding is a graceful degradation path (quarantine, not crash) for a drift-detected persona |
| **A10 (proposed)** | Voice/trend snapshot freshness checked at gather-step time. **PsychosisMonitor** is the multi-task companion to per-task `goal-grounding.ts` — the natural promotion candidate for widening A10 coverage |

## 13. Phasing & sizing

| Phase | Scope | Size (LOC) | DoD |
|---|---|---|---|
| **A** — MVP | Types, engine, `researcher.investigate`, `source-citation` oracle, wire into phase-generate | ~700 + 250 tests | `bun run test:integration` covers full researcher protocol; `bun run check` green |
| **B** — Secretary | `secretary` persona, `secretary.brief` protocol, `org-voice` oracle, config schema | ~500 + 200 tests | Smoke test with real LLM (`bun run test:smoke`) producing a brief that passes voice oracle |
| **C** — Content creator | `content-creator` persona, `content.ideate` protocol, `trend-alignment` oracle, trend feed registry | ~600 + 250 tests | Integration test with mock trend feed showing novelty scoring |
| **D** — Adaptation | Sleep-cycle hooks, adaptive ceiling params, audit table migration | ~400 + 200 tests | `parameter_adaptations` rows from synthetic 100-run scenario |
| **E** — Skill admission (§10) | `AffinityTag` enum, soul/SKILL.md schema fields, `skill-admission.ts`, audit table, drift signature mining job | ~350 + 200 tests | Existing skills migrated with stub PR; admission verdict appears for every promotion attempt; `vinyan persona admissions` CLI lists pending |
| **F** — Reality anchoring (§11) | DelusionDetector wired into phase-verify; PsychosisMonitor subscribed to EventBus; re-grounding state machine; quarantine state in registry; `reality_anchor_audit` migration | ~700 + 350 tests | Synthetic file-mutation scenario produces `delusion` verdict; synthetic 20-task drift scenario triggers re-grounding; persona reentry verified |

Total budget: ~3,250 LOC + ~1,450 LOC tests. Phase F is the heaviest single phase; recommend gating its merge on Phase E + Phase D landing first so the audit + parameter infrastructure is mature.

## 14. Risk register

| Id | Risk | Likelihood | Mitigation |
|---|---|---|---|
| R1 | Protocol rigidity over-constrains tasks (e.g. quick lookup forced through full discover-gather-compare cycle) | High | `taskDomain === 'conversational'` short-circuits to persona-default; CLI flag `--no-role-protocol` |
| R2 | Source-citation oracle false negatives (valid cite in unrecognised format) | Medium | Ship at L1 (heuristic, non-blocking) for first month; promote to L2 only after empirical FNR < 5% |
| R3 | Trend feeds are external infrastructure | Medium | Per A9: feed failure → `type:'unknown'` confidence floor 0.4; circuit breaker isolates persona |
| R4 | Org-voice oracle requires hand-curated voice profile per org | High (adoption friction) | Ship default `formal-en-business` profile; provide `vinyan voice extract` CLI to bootstrap profile from sample texts |
| R5 | A1 violation if persona's RE pool has only one engine | Medium | Engine refuses dispatch with `unknown`-tier verdict; surfaced as configuration error before task starts |
| R6 | Content-addressed protocol invalidates caches on every minor edit | Low | `contentHash` covers `steps + exitCriteria` only — comments and docstrings normalised out |
| R7 | Trend snapshot privacy: persisting external API responses to disk | Medium | Trend snapshot rows redacted from cross-instance A2A sync; opt-in retention |
| R8 | Affinity tag closed enum becomes a bottleneck (legitimate skill has no fitting tag) | Medium | Enum extension is a documented RFC process (PR + audit row); never inferred at runtime; ship with 10 tags chosen to span the existing skill corpus |
| R9 | Affinity migration tags existing skills incorrectly, causing mass `pending-operator` queue | High at first migration | One-shot tool emits stub PRs (not auto-commits); operator-batch-approval CLI; admission floor drops to 0.3 during migration window |
| R10 | PsychosisMonitor false positive — legitimate exploratory work flagged as psychosis | Medium | Triggers are `OR`-ed across signals so one noisy signal can't fire alone; window size 20 absorbs single-task noise; reentry path via M shadow tasks is no-cost for false positives |
| R11 | Re-grounding latency disrupts user task | Medium | Quarantine is async — in-flight task completes; rebuild + replay run in sleep-cycle window unless operator forces foreground; user sees a single notification, not a stall |
| R12 | DelusionDetector cost — re-fetching every fact-claim hash on every verify | Medium | Detector only runs on claims explicitly tagged `derivedFromFact`; batched hash check via existing `world-graph` index; benchmark gate ensures < 5% verify-phase overhead |
| R13 | Quarantine deadlock — only persona of its role is quarantined and no fallback exists | Low | Registry boots with at least one fallback persona per role-affinity tag; quarantine triggers `persona.quarantined` event so operator can route to the fallback |
| R14 | Drift signature triggers freeze on a persona that legitimately broadened its scope | Medium | Freeze blocks new admissions, not existing skills or new tasks; operator can update `persona.roleAffinity` (audit-logged) to widen the declared scope |

## 15. Verification plan

Per CLAUDE.md DoD table:

- **Type/wiring (Phase A):** `bun run check` green + `bun test tests/orchestrator/role-protocols/` green + grep callers of `personaDispatch` untouched + new `role_protocol_run` row appears in benchmark trace.
- **Behavior tests:** every protocol has a step-by-step integration test exercising `ok`, `unknown` precondition, `contradictory` oracle verdict, fallback escalation. Property tests on the engine's step-ordering invariants (no step runs before its precondition step).
- **Benchmark gate:** `bun run test:benchmark` within ±15% of pre-change phase timings (A-protocol adds ≤2 oracle calls/task; Phase F detector ≤ 5% verify-phase overhead per R12).
- **Smoke gate:** Phase B and C require `bun run test:smoke` with a real API key — produce one brief and one ideated content piece end-to-end.
- **Phase E gate:** integration scenario binds 5 mock skills to a `researcher` persona, asserts: 2 admitted (overlap ≥ 0.5), 2 parked in `pending_admission` (partial overlap), 1 rejected (zero overlap). Drift signature mining job emits `persona.drift.detected` for a synthetic 25-bind history that diverges from declared affinity.
- **Phase F gate:** two integration scenarios — (1) **delusion**: persona acquires fact at hash H1, file mutates to H2, persona's claim at verify references the H1 form → DelusionDetector returns `delusion`, confidence attenuates to `unknown`; (2) **psychosis**: synthetic 20-task trace with `meanPredictionError = 0.5` triggers re-grounding; quarantine → rebuild → replay → reentry sequence emits the expected 5 audit rows; persona returns to `active` after 5 clean shadow tasks.
- **Honesty gate:** feature is ✅ Active only after `vinyan run` invokes the engine for at least the `researcher` persona without extra config; reality-anchor active only when audit table appears in default-config trace.

## 16. Open questions

1. **Should RoleProtocol be a first-class ECP type?** Recommend yes — A8 traceability and A2A peer interop both benefit from the protocol id appearing on the wire. Defer until Phase D.
2. **Dynamic step insertion mid-task** (e.g. ad-hoc clarify-scope inserted by user)? Recommend no — keep protocol immutable per task; user clarifications go through existing `task_amendment` channel.
3. **Per-role budget multipliers?** Researcher protocols genuinely cost more LLM calls than developer single-shot. Defer to Phase D economy integration.
4. **Should `mixed`-class personas be allowed `verify` steps in their own protocols?** Reading `persona-class.ts:38-45`, the answer is *yes for self-evaluation on micro-decisions, no for substantial artifacts*. Engine should enforce a payload-size guard.
5. **Soul vs protocol authority** when they conflict (e.g. soul says "be brief", protocol mandates 6-step gather)? Recommend protocol wins; soul tone-shapes within protocol scaffolding. Document in concept.md if accepted.
6. **Affinity tag governance** — who curates the closed enum? Recommend a `docs/foundation/role-affinity.md` doc owned by the same surface as `agent-vocabulary.md`; additions require RFC + landed migration. Defer until Phase E PR.
7. **A2A peer reality-anchor sync** — should a quarantined persona on instance X propagate quarantine to an A2A peer running the same persona id? Recommend no by default (peers earn trust independently per `PeerTrustLevel`), but expose `A2APolicy.shareQuarantine` opt-in.
8. **Reality-anchor for personas with no oracle-backed claims** (pure synthesis personas)? PsychosisMonitor still works (prediction-error from goal-grounding alone), but DelusionDetector has nothing to check. Document as expected — synthesis personas degrade gracefully to monitor-only coverage.

## 17. Out of scope

- Cross-instance role-protocol sharing via A2A — defer to a later RFC; protocols ship local-only first.
- Marketplace for community protocols — Vinyan OS ecosystem concern, not this redesign.
- LLM-authored protocols (autonomous protocol creator) — the persona-skill autonomous creator pattern (`src/skills/autonomous/`) is the precedent, but defer until ≥10 hand-authored protocols exist as training corpus.
- UI for protocol authoring — CLI/YAML only in Phases A–D.

---

## Sequencing recommendation

If this plan is accepted, the order maximizing leverage per LOC is:

1. **Phase A (researcher MVP)** — proves the engine + oracle pattern on the persona that already exists.
2. **Phase D (sleep-cycle adaptation)** — moved up to land *with* Phase A so the engine is observable from day 1; adds <100 LOC if developed alongside.
3. **Phase B (secretary)** — exercises the org-context dimension; broadest user demand.
4. **Phase C (content-creator)** — exercises the external-feed dimension; highest infrastructure surface.
5. **Phase E (skill admission)** — must precede F so the affinity model exists when reality-anchor reasons about persona scope; small enough to land alongside C.
6. **Phase F (reality anchoring)** — lands last; reuses Phase D's audit infrastructure and Phase E's affinity model in §11.5 skill-prune path.

## Status reference

| Item | Status |
|---|---|
| RoleProtocol types + engine | 📋 Proposed |
| `researcher.investigate` protocol + source-citation oracle | 📋 Proposed |
| `secretary.brief` protocol + org-voice oracle | 📋 Proposed |
| `content-creator.ideate` protocol + trend-alignment oracle | 📋 Proposed |
| Sleep-cycle adaptation + adaptive ceiling params | 📋 Proposed |
| Skill admission policy + persona drift signature (Phase E) | 📋 Proposed |
| Reality anchoring — DelusionDetector + PsychosisMonitor + re-grounding (Phase F) | 📋 Proposed |
| ECP-level RoleProtocol surface | 📋 Deferred to post-MVP |
| A2A peer reality-anchor sync | 📋 Deferred (RFC) |
