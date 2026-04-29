# Persona/Skill Redesign — Future Backlog

**Status:** redesign FULLY CLOSED 2026-04-29 across Phases 1–14. The original Phase 1 plan and all four originally-deferred items shipped. This document captures **future enhancements** that are NOT required for the redesign to be complete but would extend its impact. Treat as backlog candidates, sized for individual scoping.

## Table of contents

1. [Hub discovery adapter](#1-hub-discovery-adapter-completes-phase-14-item-1) — completes Phase-14 Item 1's pluggable discovery surface
2. [BidAccuracyTracker persistence](#2-bidaccuracytracker-persistence) — sibling to Item 3, same pattern
3. [TaskDomain-aware A1 routing](#3-taskdomain-aware-a1-verifier-routing) — finer signal than `taskType === 'code'`
4. [Skill graduation pipeline](#4-skill-graduation-pipeline) — auto-promote `probabilistic` → `heuristic` → `deterministic`
5. [Per-task skill attribution](#5-per-task-skill-attribution-risk-m2) — distribute outcome credit by usage signal, not equal split

---

## 1. Hub discovery adapter — completes Phase-14 Item 1

### Why

Phase-14 Item 1 added `LocalHubAcquirer.discoverCandidateIds: RemoteCandidateDiscoveryFn` as a caller-supplied hook so the acquirer can invoke `SkillImporter.import()` on cache miss. The hook is empty in factory pending an operator decision on which discovery backend to use. Without a real discovery, the import path is reachable from tests only — no runtime skill ever gets fetched from a remote registry.

### What

Pick (or stack) one of these backends and wire `discoverCandidateIds` in `factory.ts`:

| Backend | Source | Pros | Cons |
|---|---|---|---|
| Config-list | `vinyan.json` `skills.discovery.candidates: { capabilityId: skillId[] }` | Deterministic, easy to test, no network | Operator-curated; doesn't auto-discover |
| GitHub topic search | Existing `GitHubAdapter` + `q=topic:vinyan-skill capability:<id>` | Auto-discovers, reuses adapter | Rate limits, depends on convention adoption |
| Registry index file | Single hosted JSON (`agentskills.io/index.json`) keyed by capability id | Predictable URL, cacheable, vendor-neutral | Requires hosted registry |
| Hybrid | Config-list first, then GitHub search | Robust | More moving parts |

**Recommendation:** ship config-list first (smallest footprint, no network surface). Add GitHub search behind a feature flag once the config-list path has telemetry showing real cache misses.

### Critical files

- `src/orchestrator/agents/local-hub-acquirer.ts:90` — hook is already wired
- `src/orchestrator/factory.ts:482` — instantiate `LocalHubAcquirer` with `discoverCandidateIds`
- `src/config/schema.ts` — add `skills.discovery` section
- `src/skills/hub/wiring.ts` — if reusing `setupSkillImporter`, the importer handle is already factory-wired-able

### Size

100–150 LOC config-list backend + 60–80 LOC config schema + 100–120 LOC tests.

### Verification

- Integration test: config carries `{ "lang.typescript": ["vinyan-skills/ts-coding"] }`; persona requests `lang.typescript`; importer fires; skill ends up `active`.
- Smoke: rate-limit failure or 404 from importer degrades to no-op (existing A9 path).

---

## 2. BidAccuracyTracker persistence

### Why

Phase-14 Item 3 persisted `PersonaOverclaimTracker`. The sibling `BidAccuracyTracker` (provider-keyed cost-prediction accuracy) is still in-memory only. Same architectural concern: a process restart resets every provider back to cold-start (`accuracy_ema = 0.5`), which means the bid score's `accuracyPremium` factor stays at the cold-start neutral until 10 settlements rebuild — every restart erases real history.

### What

Mirror `PersonaOverclaimStore` exactly. Schema slot already exists (`bid_accuracy` table, `001_initial_schema.ts:397`).

### Critical files

- `src/economy/market/bid-accuracy-tracker.ts` — accept optional persistence handle in constructor; rehydrate from `listAll` on construction; write through on `recordSettlement`
- `src/db/bid-accuracy-store.ts` — NEW; read/write rows
- `src/orchestrator/factory.ts:645` — pass store into `MarketScheduler` constructor (already takes the persona overclaim store, so the pattern is established)

### Size

120–150 LOC store + 100 LOC tests. No new migration — column exists.

### Verification

Restart-replay test: record 20 settlements at varied accuracies; drop the tracker; re-instantiate; the EMA + violation-window state survives.

---

## 3. TaskDomain-aware A1 verifier routing

### Why

Phase-14 Item 4's `selectVerifierForDelegation()` keys on `parentTaskType === 'code'`. `TaskInput.taskType` is a coarse `'code' | 'reasoning'`. The TaskUnderstanding pipeline computes a finer `taskDomain: 'code-mutation' | 'code-reasoning' | 'general-reasoning' | 'conversational'`. The original Phase-1 plan called for A1 enforcement specifically on `code-mutation` — `code-reasoning` (e.g. "explain this function") doesn't strictly need a separate Verifier persona since no artifact is being produced.

Today's gate is conservative: `'code'` covers BOTH `code-mutation` AND `code-reasoning`. So the verifier override fires for some delegations where it's overkill (e.g. "review this function's complexity" on a code-reasoning parent).

### What

Thread the `taskDomain` through to the A1 router.

Two options:

**Option A — best-effort plumbing.** Add an optional `parentTaskDomain?: TaskDomain` to `A1VerifierRoutingInput`. When present and `=== 'code-reasoning'`, skip the override. Otherwise behave identically. Callers that don't have the domain available pass it as undefined and the existing `'code'` gate stays in force.

**Option B — refactor.** Compute `taskDomain` inside the router via a heuristic on the parent's goal/files. More logic, more drift risk, no immediate caller for the precision.

**Recommendation:** Option A. Workflow-executor and agent-loop both have `parent: TaskInput` available; if the upstream pipeline annotates the parent with TaskUnderstanding output, the domain is reachable. Keep the refactor simple.

### Critical files

- `src/orchestrator/agents/a1-verifier-router.ts:30` — add `parentTaskDomain?: TaskDomain` to `A1VerifierRoutingInput`
- `src/orchestrator/workflow/workflow-executor.ts:629`, `src/orchestrator/agent/agent-loop.ts:721` — pass `parent.understanding?.taskDomain` (or wherever it lives) when available

### Size

20–30 LOC + 30 LOC tests (verify-style + code-reasoning parent → no override; verify-style + code-mutation parent → override).

### Verification

Existing Phase-13 + Phase-14 test cases for `parentTaskType === 'code'` still pass; new cases for `taskDomain === 'code-reasoning'` confirm skipped routing.

---

## 4. Skill graduation pipeline

### Why

`SkillMdRecord.frontmatter.confidence_tier` ladders from `speculative → probabilistic → pragmatic → heuristic → deterministic`. Autonomously-created skills land at `probabilistic` (Phase-14 Item 2). The redesign assumes future graduation paths exist but Phase 14 didn't ship any — a skill stays `probabilistic` forever even if real outcomes show sustained high Wilson LB.

This is the highest-leverage extension: skill graduation drives `effectiveTrust` upward via `TIER_WEIGHT`, which directly influences auction wins.

### What

Add a sleep-cycle promoter that scans `SkillOutcomeStore` rows per `(persona, skill, taskSig)`:

```
For each (persona, skill, taskSig) row:
  Wilson LB ≥ 0.85 AND outcomes ≥ 30 → promote tier one rung up
  Wilson LB < 0.4 AND outcomes ≥ 20 → demote tier one rung down (or quarantine)
```

Mirror existing `skill-promoter.ts` (which handles `acquired → bound` scope graduation) — same scheduling pattern, different decision rule.

### Critical files

- `src/orchestrator/agents/skill-promoter.ts` (template)
- `src/skills/autonomous/tier-graduation.ts` (NEW) — pure decision function
- `src/orchestrator/factory.ts:1503` — same wire-up pattern as `setSkillPromoter`
- `src/skills/skill-md/writer.ts` — mutate frontmatter `confidence_tier` + `promoted_at` + content_hash recompute

### Size

200–300 LOC + 150–200 LOC tests. Largest backlog item but mostly mechanical.

### Verification

Sleep-cycle replay test: seed 30 successful outcomes for a `probabilistic` skill; run promoter; verify tier flipped to `pragmatic` AND `content_hash` recomputed AND skill_trust_ledger row appended.

### Risk

Tier changes invalidate `content_hash` (A4) — every promotion is effectively a new skill version. The writer must recompute the hash atomically and the trust ledger must record both old and new hashes.

---

## 5. Per-task skill attribution (risk M2)

### Why

`recordSkillOutcomesFromBid` (in `skill-outcome-store.ts:156`) currently fans one task outcome out to **every** loaded skill on the bid. A persona that loaded `[ts-coding, lint-fix, refactor-extract]` and won a refactor task gets all three skills credited equally — even though `lint-fix` was probably irrelevant.

This is documented as risk M2 in the original Phase 1 plan: equal credit dilutes the attribution signal that drives Phase-14 Item 2's autonomous creator (which keys on `(persona, skill, taskSig)` Wilson LB).

### What

Extend `SkillUsageTracker` (Phase 11) to track which loaded skills the LLM actually `skill_view`ed during the task. At outcome-recording time, credit only the skills that were viewed. Skills loaded but not viewed get NO credit (instead of equal credit). This converts the attribution from `1/N per loaded skill` to `1/V per viewed skill`, where V ≤ N.

Aligns with Phase-11's already-implemented `evaluateOverclaim` view-tracking — same data already flows into the tracker.

### Critical files

- `src/db/skill-outcome-store.ts:156` — `recordSkillOutcomesFromBid` accepts a `viewedSkillIds?: ReadonlySet<string>` filter
- `src/orchestrator/factory.ts:2156` — at the executeTask wrapper, pass `skillUsageTracker.getViewed(input.id)` into `recordTaskOutcomeForPersona`
- `src/orchestrator/agents/task-outcome-recorder.ts` — plumb the viewed set through

### Size

50–80 LOC core + 80–100 LOC tests (equal-credit baseline; viewed-only attribution; empty viewed set falls back to equal credit so we don't lose signals on legacy paths)

### Verification

Two skills loaded; only one viewed; record outcome; assert only the viewed skill's row incremented; the unviewed skill's counter stays at 0. Baseline test (empty viewed set) confirms legacy fallback.

### Risk

False negatives if the LLM uses an L0 catalog card without invoking `skill_view`. Mitigation: empty viewed set falls back to equal credit so the change is purely additive — never worse than current behaviour.

---

## Sequencing recommendation

If picking up the backlog in a future session, the order that maximizes leverage per LOC is:

1. **Item 5 (per-task attribution)** — closes the M2 risk; reuses Phase 11 view tracker; strengthens every downstream signal (auction outcomes, autonomous creator triggers, persona-skill-promoter)
2. **Item 4 (skill graduation)** — once M2 is fixed, graduation runs on cleaner data
3. **Item 3 (taskDomain routing)** — small, axiom-aligned, surfaces once graduated skills start producing more delegations
4. **Item 2 (BidAccuracy persistence)** — sibling pattern; mechanical; no dependency on others
5. **Item 1 (hub discovery adapter)** — ship config-list slice first; expand if telemetry shows real demand

## Out of scope for this backlog

These are tracked elsewhere or by other initiatives:

- Cross-instance skill federation (A2A skill sync) — see `docs/design/agent-conversation.md`
- Skill marketplace / payment surface — out of redesign scope; see Vinyan OS ecosystem plan
- LLM provider auto-discovery for `selectByTier` — orthogonal to the redesign

## Status reference

| Item | Status |
|---|---|
| Persona/skill redesign Phases 1–13 | ✅ Shipped (2026-04-28) |
| Phase 14 Item 1 — LocalHubAcquirer hub fetch | ✅ Shipped (wiring) — pending discovery adapter (Item 1 above) |
| Phase 14 Item 2 — DraftGenerator + cross-engine critic | ✅ Shipped (2026-04-29) |
| Phase 14 Item 3 — PersonaOverclaim persistence | ✅ Shipped (2026-04-29) |
| Phase 14 Item 4 — A1 in agent-loop | ✅ Shipped (2026-04-29) |
| Future backlog (this doc) | 📋 Designed, ready to scope |
