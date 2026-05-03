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
10. [Axiom mapping](#10-axiom-mapping)
11. [Phasing & sizing](#11-phasing--sizing)
12. [Risk register](#12-risk-register)
13. [Verification plan](#13-verification-plan)
14. [Open questions](#14-open-questions)
15. [Out of scope](#15-out-of-scope)

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

## 10. Axiom mapping

| Axiom | How this design honors it |
|---|---|
| **A1 Epistemic Separation** | `verify` steps run on a different RE than the prior generator step; engine refuses same-RE verify pairs |
| **A2 First-Class Uncertainty** | Unmet preconditions → `type:'unknown'`; non-blocking oracles attenuate confidence rather than failing |
| **A3 Deterministic Governance** | Protocol resolution, step advancement, oracle dispatch all rule-based — no LLM in the path |
| **A4 Content-Addressed Truth** | `protocol.contentHash` + per-step evidence hashes + voice/trend snapshot hashes |
| **A5 Tiered Trust** | source-citation = deterministic; org-voice = deterministic+probabilistic split; trend-alignment = heuristic |
| **A6 Zero-Trust Execution** | RoleProtocolEngine runs in orchestrator, not workers; workers only execute LLM dispatch slots |
| **A7 Prediction Error as Learning** | Step-success EMA feeds sleep-cycle adaptation |
| **A8 (proposed)** | `role_protocol_run` audit table records protocol id, version hash, step verdicts, RE ids, timestamps |
| **A9 (proposed)** | Trend-feed failure → degraded confidence per circuit breaker; org-voice oracle missing → `unknown`, not crash |
| **A10 (proposed)** | Voice/trend snapshot freshness checked at gather-step time; stale snapshot triggers re-fetch |

## 11. Phasing & sizing

| Phase | Scope | Size (LOC) | DoD |
|---|---|---|---|
| **A** — MVP | Types, engine, `researcher.investigate`, `source-citation` oracle, wire into phase-generate | ~700 + 250 tests | `bun run test:integration` covers full researcher protocol; `bun run check` green |
| **B** — Secretary | `secretary` persona, `secretary.brief` protocol, `org-voice` oracle, config schema | ~500 + 200 tests | Smoke test with real LLM (`bun run test:smoke`) producing a brief that passes voice oracle |
| **C** — Content creator | `content-creator` persona, `content.ideate` protocol, `trend-alignment` oracle, trend feed registry | ~600 + 250 tests | Integration test with mock trend feed showing novelty scoring |
| **D** — Adaptation | Sleep-cycle hooks, adaptive ceiling params, audit table migration | ~400 + 200 tests | `parameter_adaptations` rows from synthetic 100-run scenario |

Total budget: ~2,200 LOC + ~900 LOC tests. Comparable in scope to Phase-15 skill graduation (~1,800 LOC).

## 12. Risk register

| Id | Risk | Likelihood | Mitigation |
|---|---|---|---|
| R1 | Protocol rigidity over-constrains tasks (e.g. quick lookup forced through full discover-gather-compare cycle) | High | `taskDomain === 'conversational'` short-circuits to persona-default; CLI flag `--no-role-protocol` |
| R2 | Source-citation oracle false negatives (valid cite in unrecognised format) | Medium | Ship at L1 (heuristic, non-blocking) for first month; promote to L2 only after empirical FNR < 5% |
| R3 | Trend feeds are external infrastructure | Medium | Per A9: feed failure → `type:'unknown'` confidence floor 0.4; circuit breaker isolates persona |
| R4 | Org-voice oracle requires hand-curated voice profile per org | High (adoption friction) | Ship default `formal-en-business` profile; provide `vinyan voice extract` CLI to bootstrap profile from sample texts |
| R5 | A1 violation if persona's RE pool has only one engine | Medium | Engine refuses dispatch with `unknown`-tier verdict; surfaced as configuration error before task starts |
| R6 | Content-addressed protocol invalidates caches on every minor edit | Low | `contentHash` covers `steps + exitCriteria` only — comments and docstrings normalised out |
| R7 | Trend snapshot privacy: persisting external API responses to disk | Medium | Trend snapshot rows redacted from cross-instance A2A sync; opt-in retention |

## 13. Verification plan

Per CLAUDE.md DoD table:

- **Type/wiring (Phase A):** `bun run check` green + `bun test tests/orchestrator/role-protocols/` green + grep callers of `personaDispatch` untouched + new `role_protocol_run` row appears in benchmark trace.
- **Behavior tests:** every protocol has a step-by-step integration test exercising `ok`, `unknown` precondition, `contradictory` oracle verdict, fallback escalation. Property tests on the engine's step-ordering invariants (no step runs before its precondition step).
- **Benchmark gate:** `bun run test:benchmark` within ±15% of pre-change phase timings (A-protocol adds ≤2 oracle calls/task).
- **Smoke gate:** Phase B and C require `bun run test:smoke` with a real API key — produce one brief and one ideated content piece end-to-end.
- **Honesty gate:** feature is ✅ Active only after `vinyan run` invokes the engine for at least the `researcher` persona without extra config.

## 14. Open questions

1. **Should RoleProtocol be a first-class ECP type?** Recommend yes — A8 traceability and A2A peer interop both benefit from the protocol id appearing on the wire. Defer until Phase D.
2. **Dynamic step insertion mid-task** (e.g. ad-hoc clarify-scope inserted by user)? Recommend no — keep protocol immutable per task; user clarifications go through existing `task_amendment` channel.
3. **Per-role budget multipliers?** Researcher protocols genuinely cost more LLM calls than developer single-shot. Defer to Phase D economy integration.
4. **Should `mixed`-class personas be allowed `verify` steps in their own protocols?** Reading `persona-class.ts:38-45`, the answer is *yes for self-evaluation on micro-decisions, no for substantial artifacts*. Engine should enforce a payload-size guard.
5. **Soul vs protocol authority** when they conflict (e.g. soul says "be brief", protocol mandates 6-step gather)? Recommend protocol wins; soul tone-shapes within protocol scaffolding. Document in concept.md if accepted.

## 15. Out of scope

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

## Status reference

| Item | Status |
|---|---|
| RoleProtocol types + engine | 📋 Proposed |
| `researcher.investigate` protocol + source-citation oracle | 📋 Proposed |
| `secretary.brief` protocol + org-voice oracle | 📋 Proposed |
| `content-creator.ideate` protocol + trend-alignment oracle | 📋 Proposed |
| Sleep-cycle adaptation + adaptive ceiling params | 📋 Proposed |
| ECP-level RoleProtocol surface | 📋 Deferred to post-MVP |
