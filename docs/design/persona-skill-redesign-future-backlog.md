# Persona/Skill Redesign — Closure + Future Backlog

**Status:** core redesign closed 2026-04-29 across Phases 1–15. Runtime hooks for the originally deferred items shipped, with one explicit boundary: remote skill import is hook-only until a production discovery adapter is selected and wired. This document captures the remaining backlog plus the Phase-15 closure decisions that changed the runtime skill architecture.

> **Document boundary:** This document owns persona/runtime-skill redesign closure status and remaining backlog. Runtime skill artifact invariants live in [decisions.md](../architecture/decisions.md#decision-20-skillmd-as-ecp-verified-capability-package-wave-14); current TypeScript remains the source of truth for exact APIs.

## Table of contents

1. [Hub discovery adapter](#1-hub-discovery-adapter-completes-phase-14-item-1) — completes Phase-14 Item 1's pluggable discovery surface
2. [BidAccuracyTracker persistence](#2-bidaccuracytracker-persistence) — sibling to Item 3, same pattern
3. [TaskDomain-aware A1 routing](#3-taskdomain-aware-a1-verifier-routing) — implemented Phase-15 precision gate
4. [Skill graduation pipeline](#4-skill-graduation-pipeline) — implemented Phase-15 confidence-tier promoter
5. [Per-task skill attribution](#5-per-task-skill-attribution-risk-m2) — implemented Phase-15 viewed-skill attribution

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

**Status:** ✅ Shipped in Phase-15 Item 3.

### Why

Phase-14 Item 4's `selectVerifierForDelegation()` keys on `parentTaskType === 'code'`. `TaskInput.taskType` is a coarse `'code' | 'reasoning'`. The TaskUnderstanding pipeline computes a finer `taskDomain: 'code-mutation' | 'code-reasoning' | 'general-reasoning' | 'conversational'`. The original Phase-1 plan called for A1 enforcement specifically on `code-mutation` — `code-reasoning` (e.g. "explain this function") doesn't strictly need a separate Verifier persona since no artifact is being produced.

The old gate was conservative: `'code'` covered BOTH `code-mutation` AND `code-reasoning`. That made the verifier override fire for some delegations where no artifact was produced.

### What

Implemented as the low-risk Option A:

- `A1VerifierRoutingInput` accepts optional `parentTaskDomain?: TaskDomain`.
- `code-reasoning` suppresses the Verifier override because read-only explanation/review tasks produce no artifact.
- `undefined` preserves Phase-14 behavior, so callers without a TaskUnderstanding domain still route by the old `parentTaskType === 'code'` guard.
- `workflow-executor.ts` and `agent-loop.ts` duck-type the field from parent `TaskInput` until the input model statically carries `taskDomain`.

### Critical files

- `src/orchestrator/agents/a1-verifier-router.ts:30` — add `parentTaskDomain?: TaskDomain` to `A1VerifierRoutingInput`
- `src/orchestrator/workflow/workflow-executor.ts`, `src/orchestrator/agent/agent-loop.ts` — duck-type optional `taskDomain` from the parent task and pass it when available

### Remaining follow-up

When `TaskInput` grows a first-class `taskDomain`, replace the current duck-typed reads with the typed field. No routing behavior change is expected.

---

## 4. Skill graduation pipeline

**Status:** ✅ Shipped in Phase-15 Item 4.

### Why

`SkillMdRecord.frontmatter.confidence_tier` ladders from `speculative → probabilistic → pragmatic → heuristic → deterministic`. Autonomously-created skills land at `probabilistic` (Phase-14 Item 2). Phase 15 adds the missing graduation path so outcome evidence can move a runtime skill up or down the tier ladder.

This is the highest-leverage extension: skill graduation drives `effectiveTrust` upward via `TIER_WEIGHT`, which directly influences auction wins.

### What

Implemented as a sleep-cycle promoter that scans `SkillOutcomeStore` rows per `(persona, skill, taskSig)`:

```
For each (persona, skill, taskSig) row:
  Wilson LB ≥ 0.85 AND outcomes ≥ 30 → promote tier one rung up
  Wilson LB < 0.4 AND outcomes ≥ 20 → demote tier one rung down (or quarantine)
```

This mirrors the existing scope promoter (`acquired → bound`) but operates on `confidence_tier`. Both hooks run best-effort in the same sleep-cycle pass and share `SkillOutcomeStore` as their evidence source.

### Critical files

- `src/skills/autonomous/tier-graduation.ts` (NEW) — pure decision function
- `src/skills/autonomous/tier-graduation-applier.ts` (NEW) — artifact rewrite + trust-ledger append
- `src/sleep-cycle/sleep-cycle.ts` — `setSkillTierPromoter()` hook and scheduled run
- `src/orchestrator/factory.ts` — wires artifact store + trust ledger into the sleep-cycle runner

### Verification

[tier-graduation.test.ts](../../tests/skills/autonomous/tier-graduation.test.ts) covers promote, demote, quarantine, cooldown, artifact rewrite, content hash change, trust-ledger evidence, missing-artifact skip, and per-decision A9 isolation.

### Risk

Tier changes invalidate `content_hash` (A4), so every promotion/demotion is effectively a new runtime-skill version. The applier writes the new artifact first, then appends the trust-ledger row best-effort. If the ledger write fails after the artifact write, disk remains the source of truth and the next sleep cycle observes the new tier.

---

## 5. Per-task skill attribution (risk M2)

**Status:** ✅ Shipped in Phase-15 Item 5.

### Why

Before Phase 15, `recordSkillOutcomesFromBid` fanned one task outcome out to every loaded skill on the bid. A persona that loaded `[ts-coding, lint-fix, refactor-extract]` and won a refactor task got all three skills credited equally, even when only one skill was actually viewed.

This is documented as risk M2 in the original Phase 1 plan: equal credit dilutes the attribution signal that drives Phase-14 Item 2's autonomous creator (which keys on `(persona, skill, taskSig)` Wilson LB).

### What

Implemented by reusing `SkillUsageTracker` (Phase 11) as the task's usage signal. At outcome-recording time, the recorder credits only `loaded ∩ viewed` runtime skills when the viewed set is non-empty. Empty/undefined viewed sets preserve the legacy equal-credit fallback so L0 catalog-only tasks do not lose all attribution.

Aligns with Phase-11's already-implemented `evaluateOverclaim` view-tracking — same data already flows into the tracker.

### Critical files

- `src/db/skill-outcome-store.ts:156` — `recordSkillOutcomesFromBid` accepts a `viewedSkillIds?: ReadonlySet<string>` filter
- `src/orchestrator/factory.ts` — captures `skillUsageTracker.getViewed(input.id)` once and passes it to both outcome attribution and overclaim evaluation
- `src/orchestrator/agents/task-outcome-recorder.ts` — plumb the viewed set through

### Verification

[skill-outcome-store-attribution.test.ts](../../tests/db/skill-outcome-store-attribution.test.ts) covers undefined viewed fallback, empty viewed fallback, loaded/viewed intersection, viewed-but-not-loaded suppression, zero-overlap behavior, failure outcomes, and no-op legacy bids.

### Risk

False negatives are still possible if the LLM uses an L0 catalog card without invoking `skill_view`. The empty-viewed fallback keeps that path additive: absence of a usage signal means legacy equal credit, not zero credit.

---

## Sequencing recommendation

If picking up the backlog in a future session, the order that maximizes leverage per LOC is:

1. **Item 2 (BidAccuracy persistence)** — sibling pattern; mechanical; no dependency on others
2. **Item 1 (hub discovery adapter)** — ship config-list slice first; expand if telemetry shows real demand
3. **TaskInput.taskDomain typing follow-up** — only after the upstream input model owns the field directly

## Out of scope for this backlog

These are tracked elsewhere or by other initiatives:

- Cross-instance skill federation (A2A skill sync) — see `docs/design/agent-conversation.md`
- Skill marketplace / payment surface — out of redesign scope; see Vinyan OS ecosystem plan
- LLM provider auto-discovery for `selectByTier` — orthogonal to the redesign

## Status reference

| Item | Status |
|---|---|
| Persona/skill redesign Phases 1–13 | ✅ Shipped (2026-04-28) |
| Phase 14 Item 1 — LocalHubAcquirer remote import fallback | ✅ Hook shipped/tested — production discovery adapter pending (Item 1 above) |
| Phase 14 Item 2 — DraftGenerator + cross-engine critic | ✅ Shipped (2026-04-29) |
| Phase 14 Item 3 — PersonaOverclaim persistence | ✅ Shipped (2026-04-29) |
| Phase 14 Item 4 — A1 in agent-loop | ✅ Shipped (2026-04-29) |
| Phase 15 Item 3 — TaskDomain-aware A1 verifier routing | ✅ Shipped (2026-04-29) |
| Phase 15 Item 4 — Skill tier graduation pipeline | ✅ Shipped (2026-04-29) |
| Phase 15 Item 5 — Per-task viewed-skill attribution | ✅ Shipped (2026-04-29) |
| Remaining future backlog | 📋 Hub discovery adapter, BidAccuracy persistence, typed `TaskInput.taskDomain` follow-up |
