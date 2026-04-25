# Common Sense Substrate — Implementable System Design

> 🔧 **Status: To-Be (Built).** M1 + M2 + M3 + M4 all code-complete with passing tests. Phase 2.5 sits between Evolution Engine (Phase 2) and Self-Model refinement (Phase 3). Currently `commonsense.enabled: false` by default — flip to `true` in vinyan.json to activate. Promotes from 🔧 → ✅ Active when (a) ≥1 invocation observed in default `vinyan run` smoke test AND (b) sleep-cycle promotion path wired to `SleepCycleRunner`.

> **Document boundary**: Concrete implementation design for the Common Sense Substrate — a defeasible-prior knowledge layer that gives proposed actions a *named, auditable, content-addressed* sanity check. Replaces the scattered hardcoded heuristics currently embedded in `risk-router.ts`, `shell-policy.ts`, `goal-alignment-verifier.ts`, etc.
>
> For vision and the 7 axioms → [foundation/concept.md](../foundation/concept.md).
> For cognitive-architecture grounding → [foundation/theory.md](../foundation/theory.md).
> For ECP semantics being extended → [spec/ecp-spec.md](../spec/ecp-spec.md).
> For the Sleep Cycle promotion path being reused → [design/world-model.md](world-model.md) §7 + `src/sleep-cycle/`.

**Date:** 2026-04-25
**Status:** v1 — design only. Implementation queued behind Phase 2 data gates.
**Audience:** Implementors (human or agent) evaluating whether Vinyan should grow a first-class common-sense capability.

---

## 0. Starting Position

### What this addresses

Vinyan already encodes substantial common sense — irreversibility tables, destructive-git blocklists, prompt-injection patterns, verb→intent mappings, cold-start floors, code-keyword sets, blast-radius weights. **All of it is hardcoded inside TypeScript.** It cannot be inspected by users, updated without redeploy, audited by oracles, falsified by evidence, or learned from traces. This violates four properties Vinyan claims for itself:

| Property | Where it lives today | Should live in |
|---|---|---|
| Auditable | Source files (`risk-router.ts`, `shell-policy.ts`, ...) | SQLite store + ECP envelope |
| Content-addressed (A4) | None | SHA-256 of (microtheory, pattern, default) |
| Tier-typed (A5) | Mixed; mostly unmarked | Explicit `pragmatic` tier (0.5–0.7) |
| Learnable (A7) | None — manual PRs only | Sleep-cycle promotion via Wilson CI |

This document specifies a **Common Sense Substrate** that consolidates these scattered heuristics into a single named, auditable, defeasible-rule layer — and a **Common Sense Oracle** that consumes proposed actions through the existing Oracle Gate.

### What this is NOT

- ❌ Not a generation prior (no system-prompt rules). Generation prior would route LLM through commonsense → violates A1 (no engine evaluates own output).
- ❌ Not Cyc-scale encyclopedic knowledge. Seed corpus is ≤30 hand-curated rules; the rest is promoted from observed regularity.
- ❌ Not a new axiom. A8 would have no enforcement teeth; instead we *extend* A1, A3, A5 to make the substrate's role explicit.
- ❌ Not a hard block. Pragmatic-tier verdicts are 0.5–0.7 confidence (defeasible). They escalate, they don't refuse — final block decisions remain deterministic-tier (A5).

### Current status at a glance

```
🔧 Built (M1 + M2 + M3 + M4 all shipped):
  M1 CommonSense Registry        — SQLite store + 27 innate seed rules + content addressing
                                   src/oracle/commonsense/{types,registry,seeds,predicate-eval}.ts
                                   src/db/migrations/010_commonsense_rules.ts
  M2 CommonSense Oracle          — verification-gate adapter; SARIF-shape suppression in evidence
                                   src/oracle/commonsense/{oracle,microtheory-selector,mutation-classifier}.ts
                                   wired in src/gate/gate.ts ORACLE_ENTRIES
  M3 Surprise-driven activation  — debouncer + activation predicate; gate filter via commonsenseSignals
                                   src/oracle/commonsense/activation.ts
                                   src/orchestrator/prediction/self-model.ts:currentSigma()
  M4 Sleep-cycle promotion path  — walk-forward backtest + Wilson 0.95 + priority caps
                                   src/sleep-cycle/promotion.ts
                                   src/oracle/commonsense/microtheory-inferer.ts

🔧 Reused (existing infrastructure):
  src/oracle/protocol.ts         — Oracle interface
  src/oracle/registry.ts         — Oracle registration
  src/oracle/circuit-breaker.ts  — Per-oracle isolation
  src/world-graph/               — Content-addressed fact pattern (template for A4 compliance)
  src/sleep-cycle/wilson.ts      — Wilson CI implementation
  src/orchestrator/prediction/   — Self-model EMA (used by M3 activation)

📋 Designed (deferred):
  M3.5  Orchestrator wiring      — core-loop populates GateRequest.commonsenseSignals
  M4.5  SleepCycleRunner hookup  — call promoteAllPatterns() after pattern mining
  ECP `prior_assumption` field   — Phase 3 amendment (see §7)
```

---

## 1. Codebase Audit — Common Sense Already in Code

The audit was performed against `src/` HEAD `81b4301`. Each row is currently *hardcoded common sense* that should migrate to the substrate.

| Encoding | File:Line | Form | Tier today | Tier in substrate |
|---|---|---|---|---|
| Irreversibility table (delete=0.3, db_delete=0.95, deploy=0.9) | `src/gate/risk-router.ts:32-51` | Object literal | Deterministic (mislabeled) | Pragmatic (defeasible by context) |
| Production env → min L2 routing | `src/gate/risk-router.ts:152-156` | Hardcoded `if` | Deterministic | Deterministic (governance, stays in router) |
| Destructive git ops (push, reset, clean) | `src/orchestrator/tools/shell-policy.ts:62-66` | Hardcoded blocklist | Deterministic (mislabeled) | Pragmatic + abnormality predicate |
| Prompt-injection patterns | `src/guardrails/prompt-injection.ts:11-35` | Regex array | Deterministic | Deterministic (security, stays in guardrails) |
| Verb→expectation table (add/create/fix/refactor/delete) | `src/oracle/goal-alignment/goal-alignment-verifier.ts:77-88` | Object literal | Heuristic | Pragmatic |
| Cold-start floor 0.1 on metaConfidence | `src/orchestrator/prediction/self-model.ts:147-149` | Magic number | Heuristic (uncommented for years) | Pragmatic + named rule |
| Greeting detection (40+ langs) | `src/orchestrator/understanding/task-understanding.ts:64-87` | Regex set | Deterministic | Pragmatic |
| Code keyword set (100+ terms) | `src/orchestrator/understanding/task-understanding.ts:24-40` | String set | Deterministic | Pragmatic |
| Cascade invalidation depth = 3 | `src/world-graph/world-graph.ts:101-105` (assumed) | Magic number | Heuristic | Pragmatic + abnormality |
| Causal edge weights (test-covers=0.95, etc.) | `docs/design/world-model.md` §5 | Doc-only | None (not in code yet) | Pragmatic |

**Migration policy:** *Security-relevant* rules (prompt injection, env-based hard blocks) STAY in their current homes. *Pragmatic defaults* migrate. The split is the same one A5 already requires: deterministic > pragmatic. Substrate owns the second.

---

## 2. Theoretical Foundation

The substrate is a synthesis of four prior threads, all already cited in `docs/foundation/theory.md` and the research/ folder:

### 2.1 McCarthy (1959) — `Programs with Common Sense`

An agent has common sense if it "deduces for itself a sufficiently wide class of immediate consequences of anything it is told and what it already knows." Vinyan's substrate inherits this framing: the agent's knowledge is *named* (rule rows), *immediate consequence* is computable (pattern + abnormality predicate eval), and *what it already knows* is queryable (microtheory selection from task context).

### 2.2 Reiter (1980) + McCarthy (1980) — Default Logic & Circumscription

Defaults are meta-rules of the form "in the absence of contrary information, assume X." McCarthy's circumscription minimizes *abnormality predicates* — birds fly unless `ab(x)` for that bird. The substrate encodes both directly:

- `default_outcome` field = the default conclusion
- `abnormality_predicate` field = the contrary information that suppresses the default
- `priority` field = Lifschitz's prioritized circumscription (higher priority defaults override lower)

This is the formal substrate that makes "defeasible" precise.

### 2.3 Cyc (Lenat 1984–2024) — Microtheories

Cyc's lesson after 40 years: **partition contradictory knowledge into microtheories** that are internally consistent but globally inconsistent (classical and quantum physics coexist; Bash error semantics differ from Python error semantics). Each rule belongs to exactly one microtheory; the orchestrator picks the active microtheory from task context **deterministically** (matches A3 — governance is not LLM-driven).

Lenat & Marcus (2023, "Getting from Generative AI to Trustworthy AI: What LLMs might learn from Cyc", arXiv 2308.04445) frame this as the missing layer in pure-LLM agents.

### 2.4 Friston — Active Inference / Free Energy Principle

The substrate's *activation policy* (M3) borrows from active inference: don't waste compute checking common sense when prediction error is low (the agent is in a familiar regime); engage the substrate when prediction error spikes (the agent is *surprised* and may be operating outside its trained distribution). This connects directly to A7 (prediction error as learning) and to the existing Self-Model's EMA-based sigma.

`docs/foundation/theory.md` already invokes Active Inference + Predictive Processing as Vinyan's cognitive grounding; the substrate is one operational consequence of that grounding.

---

## 3. Architecture — Verification Gate, Not Generation Prior

### 3.1 The architectural choice

Two patterns exist for shipping common sense in an LLM-agent system:

| Pattern | Mechanism | Fit with Vinyan axioms |
|---|---|---|
| **Generation Prior** | Inject commonsense rules into the LLM system prompt; LLM constrains its own output. | ❌ Violates A1 (the engine evaluates its own output). ❌ Violates A3 (LLM enters governance path). ❌ No content addressing (A4). |
| **Verification Gate** | Worker generates freely; substrate evaluates the proposed action *post hoc*; pragmatic-tier verdict feeds Oracle Gate. | ✅ A1 preserved (substrate ≠ worker). ✅ A3 preserved (substrate is rule-based and deterministic). ✅ A4 satisfied (rules content-addressed by SHA-256). ✅ A5 honored (new pragmatic tier). ✅ A6 honored (substrate is orchestrator-side, not worker-side). |

**Decision: Verification Gate.** Documented here so the choice is not re-litigated by future contributors.

### 3.2 Component diagram

```
                ┌──────────────────────────────────────────────────────────┐
                │  Orchestrator Core Loop                                  │
                │                                                          │
                │  Predict → Plan → Generate → [Verify ◀──────┐]  → Learn │
                │                                  │          │            │
                │                              OracleGate     │            │
                │                                  │          │            │
                │  ┌───────────────────────────────┴────────┐ │            │
                │  │ AST | Type | Dep | Lint | Test | ...  │ │            │
                │  │ + CommonSenseOracle (new) ←────────────┼─┘            │
                │  └─────────────┬───────────────────────────┘             │
                │                │ pragmatic verdicts (conf 0.5-0.7)       │
                │                ▼                                          │
                │  Conflict resolver (deterministic > pragmatic)           │
                │                                                          │
                └──────────────────────────────────────────────────────────┘
                          │
                          ▼ on prediction-error spike (M3 activation gate)
                ┌──────────────────────────────────────────────────────────┐
                │  CommonSenseOracle                                       │
                │   1. selectMicrotheory(ctx)        — deterministic       │
                │   2. registry.findApplicable(...)  — SQLite query        │
                │   3. evalAbnormality(rule, ctx)    — predicate eval      │
                │   4. emit OracleVerdict(pragmatic) — tier-stamped        │
                └──────────────────────────────────────────────────────────┘
                          │
                          ▼ promotion (M4) — offline, sleep cycle
                ┌──────────────────────────────────────────────────────────┐
                │  Sleep Cycle (existing)                                  │
                │   pattern → backtest 80/20 → Wilson CI ≥ 0.95            │
                │       → promote_to_commonsense_rule(microtheory)         │
                └──────────────────────────────────────────────────────────┘
```

### 3.3 Data shape

A commonsense rule is a content-addressed SQLite row + zod-validated schema:

```typescript
// src/oracle/commonsense/types.ts
export const CommonSenseRuleSchema = z.object({
  id: z.string(),                                  // SHA-256 of (microtheory + pattern + default_outcome)
  microtheory: z.string(),                         // e.g. 'typescript-strict', 'shell-bash', 'git-workflow'
  pattern: z.string(),                             // serialized matcher (zod-on-zod): which actions trigger this rule
  default_outcome: z.enum(['allow', 'block', 'needs-confirmation', 'escalate']),
  abnormality_predicate: z.string().optional(),    // serialized predicate: when does default NOT apply
  priority: z.number().int().min(0).max(100),      // prioritized circumscription
  confidence: z.number().min(0.5).max(0.7),        // pragmatic tier band (A5)
  source: z.enum(['innate', 'configured', 'promoted-from-pattern']),
  evidence_hash: z.string().optional(),            // link to World Graph evidence (A4)
  promoted_from_pattern_id: z.string().optional(), // link to sleep_cycle pattern
  created_at: z.number(),                          // unix ms
  rationale: z.string(),                           // human-readable WHY (audit trail)
});
export type CommonSenseRule = z.infer<typeof CommonSenseRuleSchema>;
```

### 3.4 Verdict shape

The oracle returns a standard `OracleVerdict` (no schema change required for MVP), with `tier='pragmatic'` and `confidence_source='evidence-derived'`. The new pragmatic tier slots between heuristic (0.7–0.9) and probabilistic (0.3–0.5):

**SARIF-shape suppression for fired-but-suppressed rules** (research-driven addition, 2026-04-25). When a rule's pattern matches but its abnormality predicate also holds (the rule fires UNLESS abnormality), the verdict's `evidence` array carries a SARIF §3.35-shaped suppression record so the Reiter "rule fired UNLESS" semantics are visible in audit logs ([SARIF v2.1.0 spec](https://docs.oasis-open.org/sarif/sarif/v2.1.0/sarif-v2.1.0.html), [GitHub SARIF support](https://docs.github.com/en/code-security/code-scanning/integrating-with-code-scanning/sarif-support-for-code-scanning)):

```typescript
// Evidence entry for "rule X fired but suppressed by abnormality predicate Y"
{
  file: 'commonsense:suppression',
  line: 0,
  snippet: JSON.stringify({
    suppression: {
      kind: 'inSource',
      status: 'accepted',
      justification: '<predicate-as-string>',
      ruleId: '<rule_id>',
      microtheory: '<3-axis-label>',
    }
  })
}
```

This makes "rule fired but suppressed" auditable instead of silently filtered (avoids the "rule never matters" trap when an abnormality predicate is too eager).

| Tier | Confidence band | Source | A5 weight |
|---|---|---|---|
| Deterministic | 1.0 | AST, type, structural | Highest |
| Heuristic | 0.7–0.9 | Pattern match, lint | High |
| **Pragmatic** | **0.5–0.7** | **Commonsense substrate** | **Medium-High** |
| Probabilistic | 0.3–0.5 | LLM critic, semantic | Medium-Low |
| Speculative | 0.0–0.29 | Single-LLM judgment | Lowest |

Pragmatic > probabilistic because **defeasible-but-named** rules with explicit abnormality predicates carry more evidential weight than LLM judgment.

---

## 4. Axiom Extension

The substrate does **not** add A8. It extends three existing axioms with explicit grounding clauses. Diff against current `CLAUDE.md` and `concept.md`:

### A1 (Epistemic Separation) — addition

> *Verification components MAY consult defeasible prior knowledge (the Common Sense Substrate). When they do, the consulted rule must be cited in the verdict's `prior_assumption` field (§7) and must be falsifiable by an explicit abnormality predicate. The substrate itself is not a generator; rules are loaded, not produced.*

### A3 (Deterministic Governance) — addition

> *Commonsense rules in the substrate are themselves derived from collective domain knowledge: seeded innately, configured per workspace, or promoted from observed patterns via Wilson CI gating (Phase 2 / Sleep Cycle). Once committed to the registry, rule application is deterministic — pattern match + abnormality eval — with no LLM in the application path. Rule promotion runs offline and is not part of the request critical path.*

### A5 (Tiered Trust) — addition

> *A new tier `pragmatic` (confidence band 0.5–0.7) sits between heuristic and probabilistic. It applies to verdicts derived from defeasible commonsense rules. Pragmatic verdicts inform routing (escalation, confirmation prompts) but do not override deterministic verdicts in the conflict resolver. The pragmatic tier is the formal home of "what the system 'just knows' is reasonable."*

These three patches are surgical: no other axiom is touched, and the additions are additive (do not break any existing claim).

---

## 5. Open Questions — Resolutions

The five questions raised in the brainstorm session are answered here as design decisions. Each can be revisited via PR; defaults are chosen to favor minimum risk and maximum reuse of existing infrastructure.

### Q1. Microtheory granularity

**Decision: Hybrid, three-axis.** A rule belongs to one microtheory along each of three orthogonal axes:
1. **Language axis:** `typescript-strict | python-typed | python-untyped | shell-bash | shell-zsh | go | rust | sql | universal`
2. **Domain axis:** `web-rest | cli | data-pipeline | infra-terraform | git-workflow | universal`
3. **Action axis:** `read-only | mutation-additive | mutation-destructive | tool-invocation | universal`

Microtheory selection at oracle time is deterministic: extract `(language, domain, action)` triple from the proposed mutation; query rules whose three-axis label matches with `universal` as wildcard. **Rationale:** Cyc's microtheory experience showed single-axis partitioning produces too many redundant rules; three-axis with universal wildcards keeps the seed corpus small while allowing precise targeting.

**Reversible by:** flattening to single-microtheory if the three-axis model proves unwieldy at scale (>500 rules).

### Q2. Innate vs Learned ratio

**Decision: ~30 innate + open-ended learned.** Seed the registry with exactly the rules currently hardcoded in `src/gate/risk-router.ts`, `src/orchestrator/tools/shell-policy.ts`, and `src/oracle/goal-alignment/goal-alignment-verifier.ts` — count is ~30. After M1 ships, **all new rules must be promoted via M4** (Wilson CI from sleep cycle); manual additions require a `source: 'configured'` tag and a workspace-level config flag. **Rationale:** prevents the Cyc trap (40 years of hand-encoding), forces empirical grounding for new knowledge, matches A7.

**Configured rules** are workspace-level (`vinyan.json` `commonsense.configured: [...]`) and override innate by priority. Useful for org-specific rules ("never modify `vendored/` directory").

### Q3. Conflict resolution between commonsense and observed evidence

**Decision: A5 tier wins, conflict logged.** When a deterministic oracle (e.g., AST symbol-exists = true) contradicts a pragmatic rule (e.g., commonsense says "exports in `tests/` are not public API"), the deterministic verdict wins. The conflict is logged via `eventBus.emit('commonsense:tier_overridden', {...})` and surfaces in the audit listener for offline review. **Rationale:** A5 is non-negotiable; commonsense's role is to escalate when oracles are silent, not to compete with them.

When two **pragmatic** rules within the same microtheory conflict (e.g., one says "block", another says "allow"), highest-priority wins; ties resolve to the most-recent-promotion (commonsense evolves; newer wins). When two pragmatic rules in **different** microtheories disagree, the more-specific microtheory wins (`typescript-strict` over `universal`). Tied specificity: highest `priority`. Tied priority: emit `commonsense:contradiction` and treat as `unknown` (A2).

### Q4. Update cadence

**Decision: Continuous via Wilson CI; Quarterly review for innate.** Promotion runs continuously inside the sleep cycle (M4). **Innate rules** (the ~30 seed) are reviewed quarterly via a dedicated CLI command (`vinyan commonsense review`) that prints rules whose contexts haven't been activated in 30+ days, suggesting demotion or deletion. **Rationale:** A7-aligned learning happens autonomously; human judgment reserved for the foundational layer where empirical signal is sparse.

**Storage cadence:** rules are version-controlled via `evidence_hash` (A4). When a rule's underlying evidence file changes, the rule is auto-tainted (confidence decayed to 0.5 floor) until re-validated. This reuses the existing `world-graph` cascade-invalidation mechanism.

### Q5. User override mechanism

**Decision: Workspace config + explicit ECP envelope flag.** Three override paths, in priority order:
1. **Per-task override:** caller passes `commonsense_disable: ['rule_id_1', ...]` in the task input. Logged, requires confirmation in TUI.
2. **Workspace config:** `vinyan.json` `commonsense.disabled: [...]` lists rule IDs to disable globally. Audit-logged at orchestrator start.
3. **No runtime user override of innate destructive-action rules.** Rules with `source='innate'` AND `default_outcome='block'` (e.g., `rm -rf /` patterns) cannot be disabled via config. Override requires source-code change + commit (A6: zero-trust extends to user-supplied config for security-critical rules).

**Rationale:** balances user agency (defeasibility is meaningless without the ability to defeat) against A6 zero-trust posture for irreversible operations.

---

## 6. MVP Implementation Plan (M1–M4)

### M1 — CommonSense Registry

**Goal:** SQLite store + zod schema + content addressing. No oracle wiring yet.

| File | Purpose | LOC est. |
|------|---------|---|
| `src/oracle/commonsense/types.ts` | Zod schemas (rule, pattern, predicate, verdict adapter) | ~80 |
| `src/oracle/commonsense/registry.ts` | SQLite CRUD + content addressing + microtheory index | ~180 |
| `src/oracle/commonsense/migrations/001_initial.sql` | Schema (one table + indices) | ~30 |
| `src/oracle/commonsense/seeds/innate.ts` | Seed loader (~30 rules ported from hardcoded) | ~150 |
| `tests/oracle/commonsense/registry.test.ts` | Behavior tests (insert, query, content-addressing, abnormality eval) | ~120 |

| Test | Expected |
|------|----------|
| Insert rule with same (microtheory, pattern, default) twice | Idempotent — same SHA-256 ID, no duplicate row |
| Query by `(language='typescript-strict', domain='universal', action='mutation-destructive')` | Returns matching rules + `universal`-wildcard rules, ordered by priority desc |
| Modify pattern → re-insert | New SHA-256 → new row (old row preserved for audit) |
| Seed `innate` rules | Exactly ~30 rows, all with `source='innate'`, `confidence ∈ [0.5, 0.7]` |
| Tampered evidence_hash | Rule auto-tainted on next query (confidence floor 0.5) |

### M2 — CommonSense Oracle

**Goal:** Wire the registry as a verification-gate-style oracle in OracleGate.

| File | Purpose | LOC est. |
|------|---------|---|
| `src/oracle/commonsense/oracle.ts` | Implements `Oracle` interface; uses registry | ~200 |
| `src/oracle/commonsense/microtheory-selector.ts` | Deterministic three-axis selection from `HypothesisTuple` | ~80 |
| `src/oracle/commonsense/predicate-eval.ts` | Pure-function abnormality predicate evaluator (no LLM) | ~120 |
| `src/oracle/registry.ts` | Register `CommonSenseOracle` (one-line addition) | ~5 |
| `tests/oracle/commonsense/oracle.test.ts` | Verdict shape, tier stamping, conflict-with-deterministic tests | ~150 |

| Test | Expected |
|------|----------|
| Hypothesis: `{action: 'rm', path: '/'}` | Verdict `block`, tier `pragmatic`, confidence 0.7 |
| Hypothesis: `{action: 'rm', path: '/tmp/x'}` with abnormality `path∈/tmp` | Verdict `allow`, tier `pragmatic` |
| AST oracle says `block`, commonsense says `allow` | Deterministic wins (block); event `commonsense:tier_overridden` emitted |
| No matching rule | Verdict `unknown` (A2); confidence `null`; not contributory to gate |
| Two pragmatic rules conflict, same priority | Verdict `unknown`; event `commonsense:contradiction` emitted |

### M3 — Surprise-driven activation

**Goal:** Don't run M2 on every task. Activate only when self-model prediction error spikes (cost-aware, A7-aligned).

**External research (2026-04-25)** revised the activation rule from the v1 design:
- Sigma multiplier raised from 1.5 → **2.0** (Datadog/Grafana/Sinch convergent default is 2σ–3σ; 1.5σ activates on noise — see [Sinch dynamic threshold](https://sinch.com/blog/dynamic-threshold-estimation-for-anomaly-detection/))
- **Prometheus-style anti-thrashing** added (`for:` + `keep_firing_for:` pattern — see [Prometheus alerting rules](https://prometheus.io/docs/prometheus/latest/configuration/alerting_rules/))
- Self-model exposes `currentSigma(taskTypeSig)` as Bernoulli-variance proxy `sqrt(p*(1-p))` from existing `predictionAccuracy` EMA — no new persisted field

| File | Purpose | LOC est. |
|------|---------|---|
| `src/gate/gate.ts` | Extend GateRequest to receive `selfModelPrediction` + `riskScore` scalar; compute activation in gate | ~40 |
| `src/oracle/commonsense/activation-debouncer.ts` | Per-microtheory dwell-time + cool-down state | ~80 |
| `src/orchestrator/prediction/self-model.ts` | Expose `currentSigma(taskSig: string): number` (Bernoulli proxy) | ~20 |
| `tests/orchestrator/commonsense-activation.test.ts` | Activation gate tests | ~120 |

Activation rule (deterministic, A3):
```typescript
const activate =
  // Surprise gate (anti-aggressive, anti-thrashing)
  (predictionError > selfModel.currentSigma(taskSig) * 2.0
    && debouncer.dwellExceeded(microtheory, MIN_DWELL_MS=500))
  // Risk override (bypass surprise gate)
  || hypothesisRisk >= 0.6
  // Class override (always activate on destructive mutations)
  || mutationClass === 'mutation-destructive'
  // Cool-down: keep activated for 5s after first activation to avoid flapping
  || debouncer.inCoolDown(microtheory, COOL_DOWN_MS=5000);
```

Cold-start: when self-model has < 30 obs for the task signature, **always activate** (parallels existing self-model cold-start floor at `self-model.ts:147-149`).

| Test | Expected |
|------|----------|
| Low prediction error, additive mutation, low risk | CommonSense Oracle skipped |
| Prediction error 1.6× sigma (above old threshold, below new) | CommonSense Oracle skipped — no false-positive |
| Prediction error 2.5× sigma sustained for 500ms | CommonSense Oracle invoked |
| Destructive mutation regardless of error | CommonSense Oracle invoked |
| `risk_score >= 0.6` regardless of error | CommonSense Oracle invoked |
| Sigma fluctuates above/below threshold rapidly | Single activation (cool-down prevents flap) |
| Cold-start (< 30 obs for task sig) | Activated unconditionally |

### M4 — Sleep-cycle promotion path

**Goal:** Patterns observed by sleep cycle (Wilson CI ≥ 0.95, ≥30 obs, walk-forward backtest passes) auto-promote to commonsense rules with `source='promoted-from-pattern'`.

**External research (2026-04-25)** revised promotion gating from the v1 design:
- **80/20 random split → walk-forward (K=5 expanding windows)** for time-ordered traces with concept drift (see [walk-forward validation](https://www.lightly.ai/blog/train-test-validation-split), [About Trading walk-forward](https://abouttrading.substack.com/p/walk-forward-validation-vs-train))
- **Priority caps by source** to prevent noisy promoted rules from overriding hand-crafted innate rules (Stripe/Sift/Cloudflare convergent pattern):
  - innate: priority ∈ [60, 100]
  - configured: priority ∈ [40, 80]
  - promoted-from-pattern: priority ∈ [30, 70]
- **No public source confirms Stripe Radar / Sift Science use Wilson at fixed N=30** — production fraud-rule systems use simulator backtest + reviewer-in-the-loop. Vinyan's Wilson approach is academically defensible but should add **rule-set-aware simulation** (deferred to M4 v2): replay traces with the candidate rule INSERTED into the existing rule set; reject promotion if it regresses F1 against the existing set, even if Wilson LB passes ([Stripe Radar testing](https://docs.stripe.com/radar/testing)).

| File | Purpose | LOC est. |
|------|---------|---|
| `src/sleep-cycle/promotion.ts` | Walk-forward backtest + Wilson LB gate + microtheory inference + priority-cap enforcement; calls `commonSenseRegistry.insertRule()` | ~150 |
| `src/oracle/commonsense/microtheory-inferer.ts` | Pattern → 3-axis microtheory: language from `taskTypeSignature` extension, domain from affected files + task semantics, action from pattern type | ~80 |
| `src/oracle/commonsense/registry.ts` | Enforce priority caps in `insertRule()` (clamp by source) | ~15 |
| `tests/sleep-cycle/commonsense-promotion.test.ts` | End-to-end pattern → rule | ~120 |

| Test | Expected |
|------|----------|
| Pattern with Wilson LB 0.96, 35 obs, walk-forward passes 4/5 windows | Promoted; rule has `source='promoted-from-pattern'`, microtheory inferred, priority capped at ≤70 |
| Pattern with Wilson LB 0.91 | Not promoted (< 0.95 threshold) |
| Pattern with 28 obs | Not promoted (< 30 obs) |
| Pattern passes only 2/5 walk-forward windows | Not promoted (drift detected) |
| Promoter requests priority=85 for promoted source | Clamped to 70 (priority-cap enforcement) |
| Same pattern observed again after promotion | Rule confidence updates (not duplicated) |

#### Demotion criteria (M4 v2 — deferred)

Convergent literature (concept-drift + production rule-engine practice) gives three triggers:
1. Rolling-window F1 / accuracy drop on the rule (ADWIN signal — see [comparative drift detectors study](https://www.researchgate.net/publication/264081451_A_Comparative_Study_on_Concept_Drift_Detectors), [Aporia 8 methods](https://www.aporia.com/learn/data-drift/concept-drift-detection-methods/))
2. Time-since-last-fired exceeds threshold (the "stale rule" signal — already in §5 Q4)
3. **Override-rate too high** (pragmatic verdict frequently overridden by deterministic — defeated by the very thing it predicted) — track `override_count` per rule; demote when `override_rate > 0.5 over last 100 firings`

Adding `override_count` and `last_fired_at` columns is a future migration — not in MVP.

### Rollout sequence

```
Week 1:  M1 ships (registry standalone; no behavior change in default vinyan run)
Week 2:  M2 ships behind config flag commonsense.enabled (default false)
Week 3:  M3 ships; config flag flipped to true in dev/staging workspace
Week 4:  M4 ships; sleep cycle starts promoting; phase status moves 📋 → 🔧
Week 6:  ≥1 invocation observed in default smoke test → phase status 🔧 → ✅
```

---

## 7. ECP Extension — `prior_assumption` Field (Post-MVP)

**This section is forward-looking and NOT part of the MVP.** It documents the protocol amendment that will make the substrate's role ECP-visible in Phase 3+.

### 7.1 Motivation

Today an oracle returns `verified | confidence | evidence_chain | falsifiable_by`. When the verdict is *informed by* a defeasible commonsense rule, that fact is currently invisible to downstream consumers. Cross-instance A2A coordination, audit logs, and federation economy markets all benefit from explicit prior-assumption disclosure.

### 7.2 Proposed amendment to ECP v1.x (NOT v2 — v2 has not been released)

```typescript
interface OracleVerdict {
  // existing fields ...
  prior_assumption?: {
    rule_id: string;             // content-addressed hash from registry
    microtheory: string;         // three-axis label
    abnormality_predicate?: string; // serialized; consumer can re-eval to falsify
    confidence_impact: number;   // 0.0–1.0: how much this rule moves the verdict
    rationale: string;           // human-readable WHY
  }[];
}
```

### 7.3 Backward compatibility

The field is OPTIONAL. ECP v1.x consumers ignore unknown fields per spec §3.4. No version bump required.

### 7.4 Decision

**Defer to Phase 3.** Risk of premature commitment to wire format outweighs benefit during MVP. M2 verdicts emit the field internally (pretest the shape) but it is stripped before A2A serialization until amendment is ratified.

---

## 8. Roadmap — Phase 2.5 Placement

| Phase | Scope | Status | Dependencies |
|-------|-------|--------|--------------|
| 2 | Evolution Engine (Sleep Cycle + skill cache + rule promotion) | 🔧 Built | DB + ≥100 traces |
| **2.5** | **Common Sense Substrate (this doc)** | **📋 Designed** | **M1–M4 ship; ≥30 seed rules; ≥1 default-path invocation** |
| 3 | Self-Model (trace-calibrated prediction) | 🔧 Built | DB; uses stub otherwise |

**Why 2.5, not earlier:** the M4 promotion path depends on the sleep-cycle infrastructure (Phase 2). Shipping commonsense before Phase 2 would mean either no auto-learning (innate-only Cyc-trap) or a premature mining harness.

**Why 2.5, not later:** every later phase (3 Self-Model, 4 Fleet, 5 ENS) benefits from named priors. Shipping commonsense after them means rewriting their integration points; shipping before means they wire it once.

**Activation gate (3-tier per `docs/README.md` conventions):**

- 📋 Designed → 🔧 Built: M1 + M2 ship with passing tests; commonsense.enabled config flag works.
- 🔧 Built → ✅ Active: M3 + M4 ship; ≥1 commonsense oracle invocation in `bun run test:smoke` against a real workspace; ≥1 sleep-cycle promotion observed end-to-end.

---

## 9. Out of Scope

| Item | Why excluded | When to reconsider |
|------|-------------|---------------------|
| Cyc-style hand-encoded knowledge base (>200 rules) | Cyc retrospective shows diminishing returns; learning beats encoding past ~30 seed | If federation economy creates incentive for shared knowledge bases |
| LLM-as-rule-author (LLM proposes new rules) | Violates A3 (LLM in governance); promotion must be Wilson-gated | Never — replace with sleep-cycle observation if signal-poor |
| ConceptNet / ATOMIC import | License + scope creep; coding-agent commonsense ≠ general commonsense | Phase 5 if multi-domain tasks dominate (>50% non-code traffic) |
| Per-user personalized rules | Creates state divergence across instances; breaks A2A coordination | Possibly via federation economy in Phase 5+ |
| Explicit "common sense benchmark" suite (HellaSwag, etc.) | Benchmarks measure LLM commonsense, not substrate efficacy | Replace with internal shadow-execution backtest (A7-aligned) |
| `prior_assumption` field shipping in MVP | Premature wire-format commitment | §7 — Phase 3 amendment |
| Generation-prior path (system-prompt rules) | Violates A1 (engine evaluates own output) | Never — see §3.1 decision |

---

## 10. Verification Checklist

### Code (M1–M4) — to be checked at ship time

| Check | Command | Expected |
|-------|---------|--------|
| Type safety | `bun run check` | Zero new errors |
| Unit tests | `bun test tests/oracle/commonsense/` | All pass |
| Smoke (M2 wired) | `bun run test:smoke` with `commonsense.enabled=true` | ≥1 commonsense oracle invocation observed |
| End-to-end M4 | `bun test tests/sleep-cycle/commonsense-promotion.test.ts` | Pattern → rule promotion in same process |
| Schema invariants | `bun test tests/oracle/commonsense/registry.test.ts` | Content addressing stable; tier band [0.5, 0.7]; source enum honored |

### Docs — at ship time

| Check | Method | Expected |
|-------|--------|----------|
| README registration | `grep -F 'commonsense-substrate-system-design.md' docs/README.md` | One match in Design section |
| Cross-reference integrity | Verify `concept.md`, `decisions.md`, `tdd.md` all reference the substrate when discussing pragmatic-tier verdicts | Citations consistent |
| Banner status updated | Phase 2.5 row in `docs/README.md` and `CLAUDE.md` Phase Status table | Row present with current ✅/🔧/📋 marker |
| Axiom diff applied | `concept.md` A1/A3/A5 contain the §4 amendments | Diff matches |

### Behavior (post-ship, in production traces) — at ✅ Active gate

| Check | Method | Threshold |
|-------|--------|-----------|
| Activation rate | Audit-log query: % of tasks where commonsense oracle invoked | 5–25% (low enough to be cost-cheap, high enough to matter) |
| Pragmatic-tier override rate | % of pragmatic verdicts overridden by deterministic | < 30% (else rules are wrong, demote) |
| Promotion rate | Sleep-cycle promotions/week | ≥ 1/week after first 100 traces |
| Innate rule activation | Each innate rule activated ≥ once per 30 days | Else mark for `vinyan commonsense review` |

---

## Appendix A. Why this is faithful to Vinyan's identity

The recent identity reframe (`docs/archive/identity-reframe-plan.md`) restated Vinyan as "an autonomous task orchestrator powered by an ENS substrate." This document proposes adding a *second* substrate alongside the ENS:

- **ENS substrate** (existing): connects heterogeneous Reasoning Engines via ECP. Answers *"is this output verified?"*
- **Common Sense substrate** (this doc): connects defeasible prior knowledge to verification. Answers *"is this proposal reasonable a priori?"*

Both substrates are rule-based, deterministic at application time, content-addressed, learnable offline. Both honor A1–A7. Together they make explicit what Vinyan has always implicitly claimed: that AGI-grade reliability emerges from *correct epistemic architecture*, where "correct" means **named, auditable, falsifiable, and tier-typed** at every layer — including the layer that holds the agent's common sense.

## Appendix B. References

### Foundational
- McCarthy (1959), *Programs with Common Sense*, Stanford archive.
- Reiter (1980), *A Logic for Default Reasoning*, AI Journal.
- McCarthy (1980), *Circumscription — A Form of Non-Monotonic Reasoning*, AI Journal.
- Lifschitz (1985), *Computing Circumscription*, IJCAI.
- Lenat & Marcus (2023), *Getting from Generative AI to Trustworthy AI: What LLMs might learn from Cyc*, [arXiv 2308.04445](https://arxiv.org/abs/2308.04445).
- Davis & Marcus (2015), *Commonsense Reasoning and Commonsense Knowledge in AI*, CACM.
- Friston (2010), *The Free-Energy Principle*, Nature Reviews Neuroscience.
- Vadim (2024), *The Agent That Says No — Verification Gate Research to Practice*, vadim.blog.

### Defeasible-reasoning oracles (research informed M2)
- García & Simari (2014), *Defeasible Logic Programming: DeLP-Servers, Contextual Queries, and Explanations for Answers*, [DeLP-Server paper](https://journals.sagepub.com/doi/10.1080/19462166.2013.869767).
- Lam & Governatori (2009), *The Making of SPINdle*, [SPINdle paper](http://www.governatori.net/papers/2009/ruleml09spindle.pdf).
- Gordon, Prakken & Walton (2007), *The Carneades Model of Argument and Burden of Proof*, [paper](https://webspace.science.uu.nl/~prakk101/pubs/GordonPrakkenWalton2007a.pdf).
- KIE (2022), *Defeasible Reasoning, Drools and the Truth Maintenance System*, [KIE blog](https://blog.kie.org/2022/04/defeasible-reasoning-drools-and-truth-maintenance-system.html).
- Anthropic (2026), *Claude Code hooks reference*, [code.claude.com/docs/en/hooks](https://code.claude.com/docs/en/hooks) — adopted verdict-shape precedent for `allow/deny/ask/defer`.
- OASIS (2020), *SARIF v2.1.0 §3.35 Suppression*, [SARIF spec](https://docs.oasis-open.org/sarif/sarif/v2.1.0/sarif-v2.1.0.html) — adopted shape for "rule fired but suppressed by abnormality".

### Surprise-driven activation (research informed M3)
- Pathak et al. (2017), *Curiosity-Driven Exploration by Self-Supervised Prediction*, [arXiv 1705.05363](https://arxiv.org/abs/1705.05363) — RND-style visit-count decay (deferred to M3 v2).
- Burda et al. (2018), *Exploration by Random Network Distillation*, [endtoend.ai summary](https://v1.endtoend.ai/slowpapers/rnd/).
- Friston (2024), *Many Roles of Precision in Predictive Coding*, [MDPI Entropy](https://www.mdpi.com/1099-4300/26/9/790).
- Datadog (current), *Anomaly Monitor Algorithms*, [docs.datadoghq.com](https://docs.datadoghq.com/monitors/types/anomaly/) — convergent industry default 2σ–3σ.
- Sinch (current), *Dynamic Threshold Estimation for Anomaly Detection*, [Sinch blog](https://sinch.com/blog/dynamic-threshold-estimation-for-anomaly-detection/) — `std_coef ∈ [2,3]`.
- Prometheus (current), *Alerting Rules*, [Prometheus docs](https://prometheus.io/docs/prometheus/latest/configuration/alerting_rules/) — `for:` + `keep_firing_for:` anti-thrashing.
- Ganapini et al. (2025), *SOFAI: Slow and Fast AI*, [Nature npj AI](https://www.nature.com/articles/s44387-025-00027-5) — metacognitive arbitration (deferred to M3 v2).

### Promotion + lifecycle (research informed M4)
- Miller (2009), *How Not To Sort By Average Rating*, [Evan Miller](https://www.evanmiller.org/how-not-to-sort-by-average-rating.html) — Wilson LB ranking primitive.
- Stripe (current), *Testing custom rules with Stripe Radar*, [Stripe docs](https://docs.stripe.com/radar/testing) — production rule-promotion pattern (rule-set-aware backtest + human review).
- Sift Science (current), *Workflow Simulation*, [Sift blog](https://sift.com/blog/introducing-workflow-simulation/) — immutable rule versions, simulation-first promotion.
- Lightly (current), *Train-test validation split: walk-forward*, [Lightly blog](https://www.lightly.ai/blog/train-test-validation-split).
- Aerial+ (2025), *Neuro-symbolic Association Rule Mining*, [arXiv 2504.19354](https://arxiv.org/abs/2504.19354) — rule-explosion prevention via redundancy/coverage check.
- Johari et al. (2015), *Always-Valid Inference for sequential testing*, [arXiv 1512.04922](https://arxiv.org/abs/1512.04922) — alternative to fixed-N Wilson when peeking is uncontrolled (deferred).

### Vinyan internal
- `docs/foundation/concept.md`, `docs/foundation/theory.md`, `docs/spec/ecp-spec.md`, `docs/design/world-model.md`, `docs/design/k1-implementable-system-design.md`, `docs/architecture/decisions.md`.

## Appendix C. Deferred upgrade paths (research-surfaced, not in MVP)

Documented for future iterations — each tied to specific research finding and target file:

| # | Upgrade | Trigger | Source | Vinyan target |
|---|---------|---------|--------|---------------|
| 1 | Rename `default_outcome` to Claude Code hook standard `allow/deny/ask/defer` | If Vinyan ever exposes the substrate over external API or A2A | [Claude Code hooks](https://code.claude.com/docs/en/hooks) | `src/oracle/commonsense/types.ts:DefaultOutcomeSchema` |
| 2 | RND-style visit-count decay on per-(microtheory, pattern) firing | When traces show repeated activation on same surprise without new evidence | [Burda RND](https://v1.endtoend.ai/slowpapers/rnd/) | `src/oracle/commonsense/activation-decay.ts` (new) |
| 3 | SOFAI-style metacognitive arbitration combining 4 signals | When sigma-only gating proves insufficient (FP rate > 30%) | [SOFAI 2025](https://www.nature.com/articles/s44387-025-00027-5) | `src/orchestrator/core-loop.ts` (M3 activation predicate) |
| 4 | mSPRT / always-valid CIs replacing fixed-N Wilson | When Sleep-Cycle peeks at patterns more than once per N-window | [Johari et al.](https://arxiv.org/abs/1512.04922) | `src/sleep-cycle/wilson.ts` |
| 5 | Stripe Radar-style rule-set-aware simulation | M4 v2 — once registry exceeds ~50 rules | [Stripe Radar](https://docs.stripe.com/radar/testing) | `src/sleep-cycle/promotion.ts` (extend) |
| 6 | Override-count column + override-rate demotion criterion | After M2 ships and override patterns become observable | [TDS neuro-symbolic fraud](https://towardsdatascience.com/neuro-symbolic-fraud-detection-catching-concept-drift-before-f1-drops-label-free/) | New migration; `commonsense_rules.override_count` |
| 7 | ADWIN drift detector per rule | M4 v2 — quarterly review automation | [Comparative drift study](https://www.researchgate.net/publication/264081451_A_Comparative_Study_on_Concept_Drift_Detectors) | `src/sleep-cycle/drift-detector.ts` (new) |
| 8 | ECP `prior_assumption` field in OracleVerdict | Phase 3 — when A2A federation needs to share defeasible verdicts | §7 of this doc | `src/spec/ecp-spec.md` amendment |
