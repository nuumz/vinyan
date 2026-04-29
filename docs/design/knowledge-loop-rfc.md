# Knowledge Loop RFC — Bi-Temporal Facts, Conflict Records, Reconciliation

> **Date**: 2026-04-30 | **Status**: Draft RFC
> **Source research**: `docs/research/obsidian-second-brain-analysis.md`
> **Cross-reference**: ECP §3.6 (temporal context), `docs/architecture/decisions.md` D2 (content-addressed truth), `src/orchestrator/goal-grounding.ts` (A10)

---

## TL;DR

Three Tier-1 patterns from `obsidian-second-brain` map onto gaps in Vinyan's epistemic substrate. They are additive, axiom-aligned, and unblock each other in order:

| # | Phase | Change | LoC est. | Axiom | Blocked by |
|---|---|---|---|---|---|
| A1 | Bi-temporal facts split | `learned_at` separate from `verified_at` | ~150 | A4, A8 | — |
| A2 | First-class Conflict records | `conflicts` table with `status: open\|resolved\|superseded` | ~300 | A2 | A1 |
| B1 | Reconciliation module | `src/orchestrator/reconciliation/` (detect/evaluate/resolve/audit) | ~700 | A1, A3, A8 | A1, A2 |
| C1 | Adversarial-from-history critic | New critic mode using trace + failed-approaches | ~200 | A1, A6, A7 | — (parallel) |
| C2 | Knowledge index (read-first catalog) | `.vinyan/index.md` auto-rebuilt by sleep-cycle | ~250 | — (cost discipline) | — (parallel) |

**Recommendation**: Land A1 + A2 as one RFC PR (tightly coupled), then B1 as a separate PR. C1 and C2 are parallel-safe and can be picked up by different sessions.

---

## 1. Motivation

Vinyan has the most rigorous verification layer of any LLM orchestrator we've surveyed (oracle gate, content-addressed truth, Wilson CI pattern mining, soul-schema). But OSB demonstrates that **rigor alone is not enough** — knowledge ages, contradicts, and decays even after verification. Vinyan stores verdicts; OSB also stores the **belief revision process**.

Three concrete gaps:

1. **No transaction time** — `verified_at` conflates "when oracle observed" with "when we learned". Replay of belief evolution is impossible. (Violates A8's "decision-level provenance, not just file-level hashes".)

2. **Contradictions are runtime-only** — Vinyan's `type: 'unknown'` exists in protocol but is not materialized as queryable records. Sleep-cycle cannot iterate over open conflicts. (Underutilizes A2.)

3. **No reconciliation pass** — L3 routing handles contradictions inline as escalation; nothing periodically scans world-graph for disagreeing facts and resolves them. Knowledge debt accumulates silently.

---

## 2. Phase A1 — Bi-Temporal Facts Split

### 2.1 Schema Change

**File**: `src/world-graph/schema.ts`

Add column:
```sql
ALTER TABLE facts ADD COLUMN learned_at INTEGER;
```

**Semantics after split**:
- `verified_at` = **event time** — when the oracle observed the predicate as true.
- `learned_at` = **transaction time** — when this row was inserted into world-graph (= `Date.now()` at `storeFact()`).
- `valid_until` = unchanged (event-time upper bound).

Existing rows: backfill `learned_at = verified_at` (migration is safe — events were learned at the time they were verified, by definition, in the legacy code path).

### 2.2 Migration

New file: `src/db/migrations/<NEXT>_bitemporal_facts.ts` (number must follow current head; current modified head is 024).

Pattern (matches existing additive `ALTER TABLE` in `world-graph.ts:39-50`):
```typescript
export const migration: Migration = {
  id: '<NEXT>',
  description: 'Bi-temporal facts: learned_at separate from verified_at',
  up: (db) => {
    db.exec('ALTER TABLE facts ADD COLUMN learned_at INTEGER');
    db.exec('UPDATE facts SET learned_at = verified_at WHERE learned_at IS NULL');
    db.exec('CREATE INDEX IF NOT EXISTS idx_facts_learned_at ON facts(learned_at)');
  },
};
```

### 2.3 API Surface

`src/core/types.ts` — add to `Fact`:
```typescript
export interface Fact {
  // ... existing
  /** Event time — when the oracle observed the predicate as true. */
  verifiedAt: number;
  /** Transaction time — when world-graph stored this row. Used for replay/audit. */
  learnedAt: number;
}
```

`WorldGraph.storeFact()`:
- If caller provides `verifiedAt`, use it as event time.
- Always set `learnedAt = Date.now()` at write — never overridable.

### 2.4 ECP Spec Update

`docs/spec/ecp-spec.md` §3.6: clarify that `temporal_context.observed_at` is event time. Add new field `recorded_at` (= transaction time at receiver).

### 2.5 Tests

- Backfill correctness — existing rows get `learned_at = verified_at`.
- New write — `learned_at` is set even if caller omits.
- Replay — query by `learned_at <= T` reproduces the world as known at time T.

### 2.6 Risk

**Low.** Additive only. No behavior change for existing reads. Compatible with hot-fact-index (which doesn't expose timestamps).

---

## 3. Phase A2 — First-Class Conflict Records

### 3.1 Schema

**File**: `src/world-graph/schema.ts`

```sql
CREATE TABLE IF NOT EXISTS conflicts (
  id                   TEXT PRIMARY KEY,
  target               TEXT NOT NULL,
  pattern              TEXT NOT NULL,
  side_a_fact_id       TEXT NOT NULL,
  side_b_fact_id       TEXT NOT NULL,
  status               TEXT NOT NULL CHECK(status IN ('open','resolved','superseded')),
  detected_at          INTEGER NOT NULL,
  detected_by          TEXT NOT NULL,
  resolved_at          INTEGER,
  resolution_strategy  TEXT,
  resolution_evidence  TEXT,
  superseded_by        TEXT
);

CREATE INDEX IF NOT EXISTS idx_conflicts_target ON conflicts(target);
CREATE INDEX IF NOT EXISTS idx_conflicts_status ON conflicts(status);
CREATE INDEX IF NOT EXISTS idx_conflicts_open ON conflicts(status) WHERE status = 'open';
```

`detected_by` examples: `'l3-routing'`, `'reconciliation-detector'`, `'oracle-cross-validation'`.

### 3.2 API

`src/world-graph/world-graph.ts`:
```typescript
recordConflict(c: {
  target: string;
  pattern: string;
  sideA: Fact;
  sideB: Fact;
  detectedBy: string;
}): ConflictRecord;

resolveConflict(id: string, resolution: {
  strategy: 'newer' | 'higher-tier' | 'evolution' | 'manual';
  evidence: string;
  winningSide: 'a' | 'b' | 'merged';
}): void;

queryOpenConflicts(target?: string): ConflictRecord[];
```

### 3.3 Wire-up — L3 Routing

`src/gate/risk-router.ts` and `core-loop.ts` L3 path:

When a contradictory verdict is detected (oracles disagree, or new fact contradicts existing fact), instead of just returning `type: 'unknown'`:
1. Call `recordConflict(...)`.
2. Return verdict `type: 'unknown'` PLUS conflict ID in the trace.
3. Sleep-cycle / reconciliation can pick it up later.

### 3.4 Replaces — Implicit "unknown" Verdicts

Currently, `type: 'unknown'` is transient. After this change, every "unknown" caused by contradiction has a persistent record. Distinct from "unknown" caused by no-data (still transient).

### 3.5 Tests

- Record + query open conflicts.
- Resolve conflict — status transition, evidence captured.
- Conflict survives `runRetention()` (special protection: don't delete `status: open` conflicts even if older than `maxAgeDays`).

### 3.6 Risk

**Low-medium.** Net new table + new write paths in L3 routing. No existing contracts broken. Retention policy needs amendment (don't drop open conflicts).

---

## 4. Phase B1 — Reconciliation Module

### 4.1 Module Layout

```
src/orchestrator/reconciliation/
├── index.ts
├── detector.ts        # Scan facts for (target, pattern) collisions with different verdicts
├── evaluator.ts       # 3-question rule (timestamp / tier / falsifiable_by overlap)
├── resolver.ts        # Emit reconciled fact OR conflict record
└── auditor.ts         # Log to trace-store
```

### 4.2 Algorithm (rule-based, no LLM)

**Detector** — SQL scan:
```sql
SELECT a.id, b.id FROM facts a JOIN facts b
  ON a.target = b.target AND a.pattern = b.pattern AND a.id < b.id
WHERE a.oracle_name != b.oracle_name OR a.verified_at != b.verified_at;
```
Filter to those where verdict types differ (one `verified=true`, other `verified=false`) OR confidence delta exceeds threshold.

**Evaluator — 3 questions** (deterministic per A3):
1. **Newer?** — pick fact with higher `verified_at`. If within ε (e.g., 5 min), treat as concurrent.
2. **Higher tier?** — compare `tier_reliability`. Higher wins.
3. **Evolution vs contradiction?** — if both have `falsifiable_by` and the conditions overlap, this is an evolution (the fact changed because a falsifying condition fired). Otherwise contradiction.

**Resolver — 3 outcomes**:
- **Clear winner** (one side beats the other on Q1+Q2) → keep winner, retire loser with `superseded_by` reference.
- **Evolution** (Q3 = evolution) → keep newer, archive older with `valid_until = newer.verified_at`.
- **Genuine ambiguity** (Q1 tied, Q2 tied) → emit `Conflict` record with `status: open`. Defer to human / future evidence.

**Auditor** — append `reconciliation_event` to trace-store: `{ detected, resolved, escalated }` counts + per-conflict reasoning trace.

### 4.3 Trigger

Add to sleep-cycle `run()` in `src/sleep-cycle/sleep-cycle.ts`, after pattern mining, before promotion. Gated by `config.reconciliation.enabled` (default true once tested).

### 4.4 Safety

Per A3: zero LLM in resolution path. Per A6: reconciliation reads world-graph, writes via `WorldGraph` API, never bypasses oracles. Per A8: every resolution emits a `governance_provenance` record (policy version `reconciliation:v1`).

### 4.5 Tests

- Detect collision pair.
- 3-question evaluator unit-tests for each branch (newer/higher-tier/evolution/ambiguous).
- End-to-end: insert two contradictory facts, run reconciliation, assert one fact archived + correct outcome.
- Idempotence: running twice produces no new records.

### 4.6 Risk

**Medium.** New write path that mutates world-graph state. Must be:
1. Idempotent (re-running the same pass cannot drift).
2. Bounded (cap per-cycle resolution count, e.g., 100, to avoid runaway).
3. Reversible (every retire emits a trace entry sufficient to undo).

---

## 5. Phase C1 — Adversarial-from-History Critic

### 5.1 Change

New file: `src/orchestrator/critic/historical-adversary.ts`

Inputs (from `agent-memory-api.ts`):
- `queryFailedApproaches({ taskType, file, limit: 5 })`
- `queryPriorTraces({ taskType, limit: 10 })`

Output: a system-prompt fragment injected into critic LLM call:

```
HISTORICAL EVIDENCE — pressure-test this proposal against past attempts:

Failed approaches (recent):
- Approach: "<approach signature>" — failed at <oracle> with reason "<reason>"
  (occurred <N> times in last <M> sessions)
- ...

Prior traces with similar signature:
- Trace #<id>: outcome=<success|failure>, escalation=<L0..L3>, retry count=<n>
- ...

CRITIC INSTRUCTIONS:
- Do not be agreeable. Surface the strongest counter-evidence first.
- If this proposal repeats a previously-failed pattern, flag it explicitly.
- Defend why THIS attempt is different — or escalate.
```

### 5.2 Wire-up

`src/orchestrator/critic/llm-critic-impl.ts` — add optional `historicalAdversary` mode (off by default; enable via config flag `critic.historicalAdversary.enabled`).

### 5.3 Risk

**Low.** Pure additive prompt change. No state mutation. Off-by-default.

### 5.4 Validation

Run `bun run test:smoke` with a real API key on a known-failing task signature. Verify critic output references prior failure.

---

## 6. Phase C2 — Knowledge Index (Read-First Catalog)

### 6.1 Change

New file: `src/orchestrator/agent-context/knowledge-index.ts`

Maintains `.vinyan/index.md` (gitignored) — a flat list of:
- Module / directory + 1-line description (extracted from header docstring or `index.ts` JSDoc).
- Last-modified timestamp.
- Key types/exports.

Trigger: rebuild in sleep-cycle nightly (cheap; entire repo scan is <1s for a Vinyan-sized codebase).

### 6.2 Hook into Context Builder

`src/orchestrator/agent-context/context-builder.ts` — inject the index summary as a high-priority context fragment before tool-discovery. Token budget: ≤500.

### 6.3 Measurement

Add telemetry: count of `Glob`/`Grep` calls per session before vs after. Goal: reduce by ≥20% on agentic-workflow paths.

### 6.4 Risk

**Low.** Read-only artifact. Falls back gracefully if missing.

---

## 7. Rollout Plan

### Phase A (one PR, tightly coupled)
- Migration `<NEXT>_bitemporal_facts.ts` (A1)
- Migration `<NEXT+1>_conflicts_table.ts` (A2)
- API additions in `WorldGraph`
- ECP spec update §3.6
- Tests for both
- Wire L3 routing → `recordConflict()`

### Phase B (one PR, depends on Phase A)
- `src/orchestrator/reconciliation/` module
- Sleep-cycle integration
- Idempotence + bounded-batch tests
- `governance_provenance` records (A8 contract)

### Phase C (parallel-safe, separate PRs)
- C1: Historical adversary critic (off by default)
- C2: Knowledge index (off by default; enable after token-saving telemetry validates)

### Out of scope (future)
- Cron-style scheduled agents (Vinyan is session-driven; not urgent)
- `/obsidian-connect` analogical reasoning (needs embedding store)
- `/obsidian-graduate` idea→project (off-domain)
- Markdown vault export (out of scope; SQLite is source of truth)

---

## 8. Axiom Compliance Summary

| Phase | A1 | A2 | A3 | A4 | A5 | A6 | A7 | A8 | A9 | A10 |
|---|---|---|---|---|---|---|---|---|---|---|
| A1 (bi-temporal) | — | — | — | ✅ stronger | — | — | — | ✅ enables replay | — | — |
| A2 (conflicts) | — | ✅ materializes | — | — | — | — | — | ✅ provenance | — | — |
| B1 (reconcile) | ✅ separates gen/verify | — | ✅ rule-based | — | ✅ tier-aware | ✅ no oracle bypass | — | ✅ policy version | — | — |
| C1 (adversary) | ✅ separates | — | — | — | — | ✅ uses past failures | ✅ prediction error | — | — | — |
| C2 (index) | — | — | — | — | — | — | — | — | — | — (cost-only) |

No phase violates any axiom. Phase B1 is the most axiom-laden — it touches A1/A3/A5/A6/A8 simultaneously, so review attention should focus there.

---

## 9. Open Questions

1. **Retention of resolved conflicts** — keep forever or age out? Suggest: keep `resolved` for 90 days, `superseded` for 30 days. `open` always retained.

2. **Reconciliation cadence** — every sleep-cycle run, or every Nth run? Heavy scans on small worlds are wasteful. Suggest: gate on `world_graph.fact_count > 1000`.

3. **L3 routing — when to record a conflict vs let it pass** — needs a threshold. Suggest: only record when both sides have `tier_reliability >= 0.6` (don't pollute conflicts table with low-confidence noise).

4. **Critic adversary — proposal hash matching** — how do we decide "this proposal repeats approach X"? Suggest: reuse `clusterByApproach` from `src/sleep-cycle/approach-similarity.ts`.

5. **Knowledge index format** — markdown for human inspection, or JSON for token efficiency? Suggest: emit both, agent reads JSON.

---

## 10. Decision Required

Pick one before implementation:

- **Option 1 (recommended)**: Land Phase A as one PR after current external-coding-cli WIP commits. Land Phase B 1-2 weeks later. Phase C is opportunistic.

- **Option 2**: Land Phase A + Phase B together in a single big PR. Higher review surface, but resolves A2 axiom debt in one go.

- **Option 3**: Defer entirely until external-coding-cli ships. Reduces concurrent migration risk but loses momentum.

The author's recommendation: **Option 1**.
