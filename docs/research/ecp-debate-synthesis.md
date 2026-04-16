# ECP Debate Synthesis: Transform Vinyan into a Truly Autonomous Orchestrator

> **Document boundary**: This document owns the strategic analysis and consensus roadmap for ECP evolution.
> For v2 schema/behavioral design, see [ecp-system-design.md](../design/ecp-system-design.md).
> For original brainstorm, see [ecp-migration-brainstorm.md](ecp-migration-brainstorm.md).

## Method

4 expert agents debated independently, then 2 cross-examination rounds synthesized agreements, tensions, and blind spots.

| Role | Thesis |
|------|--------|
| **Epistemic Theorist** | v2 schema is correct but insufficient — needs 3 new architectural layers (dependency tracking, decision-class semantics, capability-confidence binding) |
| **Systems Pragmatist** | v2 is hygiene (+5% autonomy), not the solution — worker capability estimation + oracle resilience = +70% autonomy |
| **Autonomy Architect** | Autonomy gap is behavioral, not protocol — 7 missing capabilities starting with miscalibration recovery and graceful degradation |
| **Adversarial Tester** | v2 introduces 4 failure categories — "configured confidence theater" without regression tests + config validation |

---

## The Core Insight

**Autonomy is self-correcting behavior, not protocol purity.**

Vinyan becomes truly autonomous when the Orchestrator automatically adapts routing/escalation/verification policy based on learned prediction errors — without manual config changes. Specifically:
1. SelfModel retrains from prediction deltas
2. Routing thresholds shift per task_type
3. Oracle fallbacks trigger on failure chains (not halt)
4. Miscalibration drift auto-detects and recovers within 1 hour

v2 is **enabler infrastructure** — it creates the data types and audit trail that make autonomous behavior possible. Phase 7 is the **autonomous behavior** itself.

---

## Consensus Points (4/4 Agreement)

| # | Point | Evidence |
|---|-------|----------|
| 1 | **v2 schema is correct, deploy it** | All 4 agents approve Phase A. Zero risk, zero debate. |
| 2 | **Oracle resilience is THE blocker** | Theorist (dependency tracking), Pragmatist (pattern learning), Architect (fallback chains), Tester (10 missing tests) — all converge here from different angles. |
| 3 | **Configuration/threshold governance is broken** | Static thresholds + no validation + no auto-learning = "any config works but none works well." All 4 identify this independently. |
| 4 | **Trace data lifecycle is broken** | DB grows unbounded (Architect), registry drift doesn't invalidate facts (Tester), pattern mining needs clean data (Pragmatist), dependencies need tracking from historical data (Theorist). |
| 5 | **Miscalibration is a production bug** | Event emitted but never acted upon. All 4 agree this is P0 — a 1-week fix that's been ignored. |

---

## False Disagreements Resolved

### "Layers" vs "Pattern Learning"
- **Surface**: Theorist wants dependency tracking NOW; Pragmatist says fix workers FIRST.
- **Resolution**: Sequential dependencies, not conflict. Pragmatist's pattern learning produces DATA that Theorist's thresholds need. Build in order: pattern data → tuned thresholds.

### "Graceful Degradation" vs "Oracle Pattern Learning"
- **Surface**: Architect wants fallback chains; Pragmatist wants failure correlation learning.
- **Resolution**: Same proposal, different names. **Merge into single P0: Oracle Resilience Layer** — detect failure patterns + implement adaptive routing.

### "Config Brittleness" vs "Explicit Thresholds"
- **Surface**: Tester says v2 introduces config risk; Theorist says decision-class thresholds fix it.
- **Resolution**: Both needed. Thresholds handle decision-level governance; validation handles schema-level drift. Theorist's thresholds + Tester's validation = complete fix.

---

## Genuine Tensions (Irreconcilable Trade-offs)

### Tension 1: Scope Now vs Scope Later

| Option | Upside | Downside |
|--------|--------|----------|
| **Theorist (3 layers now)** | Architecturally complete from day 1 | 3-6 month delay; layers lack data to tune correctly |
| **Pragmatist (v2 schema + worker fixes)** | Ships autonomy in month 1-2 | 6-12 months operating with fragile confidence model |

**Verdict: Pragmatist wins.** v2 schema is prerequisite anyway. Layers add ATOP v2 — they don't replace it. Stagger risk: empirical gains first, then rigor from real data.

### Tension 2: Confidence Fusion Strictness

| Option | Upside | Downside |
|--------|--------|----------|
| **Theorist (SL fusion everywhere)** | Maximum epistemic soundness | Computationally heavy; degenerate fusion risk (Tester's concern) |
| **Tester (minimal fusion)** | Simpler, fewer failure modes | Misses evidence dependencies; higher type-II errors |

**Verdict: Hybrid.** Selective SL fusion — L2+L3 decisions MUST fuse + validate. L0+L1 stay probabilistic. Prevents "fusion inflation" while keeping rigor where stakes are high.

### Tension 3: Epistemic Correctness vs Behavioral Adaptability

**The deepest disagreement.** Theorist optimizes for "correct knowledge boundaries." Pragmatist optimizes for "recover and adapt." Both are right — the question is sequence.

**Verdict: Sequence, not choose.**
1. Month 1-2: Empirical autonomy (Pragmatist) — worker reestimation + failure recovery
2. Month 3: Validate (Tester) — config validation + regression tests + audit trail
3. Month 4-5: Add rigor (Theorist) — decision-class thresholds, now grounded in real data
4. Month 6+: Adaptive strategies (Architect) — meta-learning + approach diversity on solid foundation

---

## Blind Spots (What All 4 Missed)

### 1. Miscalibration Recovery Has No Handler
System detects calibration drift, emits event → **no handler** → silent degradation. A 1-week fix that should have been P0 in every paper.

**Fix:** `MiscalibrationRecoveryHandler` — on event: flush old traces, reset EMA windows, escalate risky tasks until recovery check passes.

### 2. Human-in-the-Loop Threshold Tuning
All 4 propose threshold mechanisms but none address: Who sets initial thresholds? What if a decision class has zero training traces? What's the approval process?

**Fix:** Threshold governance layer — each threshold requires empirical data OR explicit human override with rationale. Default-to-escalate for untrained classes.

### 3. Rollback Strategy
No agent addressed: If v2 causes silent state corruption (Tester's Zod default drift), how do we recover? Can we roll back v2 → v1 safely?

**Fix:** Phased canary deployment (10% → 50% → 100%) with versioned trace archival and kill switch.

---

## Proposals: Prioritized Verdict

### Tier 0 — Must Do (Blockers for Credible Autonomy)

| Proposal | Impact | Cost | Consensus | Scope |
|----------|--------|------|-----------|-------|
| v2 schema deployment (Phase A) | M | L | 4/4 | v2 |
| Miscalibration auto-recovery handler | H | L | 4/4 | v2 |
| Fix `isUncertain` + escalation-only-retry | H | L (2d) | 3/4 | v2 |
| Oracle contradiction recovery schema + resolution rule | H | M (3d) | 4/4 | v2 |
| Evidence confidence enum (Deterministic/Heuristic/Probabilistic) | M | L (1d) | 3/4 | v2 |
| Config validation framework (guards invalid thresholds) | M | L (1d) | 4/4 | v2 |
| Fix 7 axiom violations in design | M | M (3-5d) | 4/4 | v2 |
| Trace archival + invalidation on config change | H | M | 4/4 | v2 |
| Threshold governance (human approval for untrained classes) | M | L | blind spot | v2 |

### Tier 1 — Quick Wins (High Leverage Per LOC)

| Proposal | Impact | Cost | Consensus | Scope |
|----------|--------|------|-----------|-------|
| Worker capability reestimation schema | H | L (0.5d) | 3/4 | v2 |
| Speculative caveat mode (`commit_with_caveats`) | M | L (0.5d) | 2/4 | v2 |
| Fact mutation audit trail (version + mutation_reason) | M | L (0.5d) | 3/4 | v2 |
| Regression test baseline (v1 vs v2) | M | M (1d) | 4/4 | v2 |
| Graceful oracle degradation (fallback chains) | H | M (2-3d) | 3/4 | v2/Phase 7 |
| Rollback/downgrade strategy | L | M | blind spot | v2 |

### Tier 2 — Strategic Investments (Phase 7)

| Proposal | Impact | Cost | Consensus | Scope |
|----------|--------|------|-----------|-------|
| Auto-learning routing thresholds (SelfModel EMA per task_type) | H | M (3-4d) | 2/4 | Phase 7 |
| Oracle fallback chains (circuit breaker → next oracle) | H | M (2-3d) | 3/4 | Phase 7 |
| Miscalibration drift detection + auto-recovery (within 1 hour) | H | M (3-4d) | 3/4 | Phase 7 |
| Decision-class thresholds (per-class min confidence) | H | H | 2/4 | Phase 7 |
| Evidence dependency tracking (shared source detection) | M | H | 2/4 | Phase 7 |
| Multi-strategy exploration (approach diversity in retry) | M | M (2-3d) | 2/4 | Phase 7+ |
| Adaptive confidence thresholds (time-aware escalation) | H | M | 2/4 | Phase 7 |

### Tier 3 — Defer (Correct But Not Priority)

| Proposal | Reason to Defer |
|----------|----------------|
| Mandatory SL fusion at all aggregation points | Deterministic/Heuristic/Probabilistic enum is 80/20. Full SL math adds complexity without changing autonomy behavior. Revisit Phase 8+. |
| Cross-task epistemic memory | Requires stable Phase 7 foundation. High cost, high risk. |
| Meta-learning across instances (federated rules) | Phase 8+ when A2A is production-ready. |
| Code-level self-evolution | Research-grade 2027+. Requires 8 sprints + safety invariant work. |
| Falsifiable predicates in Evidence | Nice for audit trails; not autonomy-critical. |

---

## The Roadmap

### Phase v2: Foundation (10-15 days)

```
Sequential (Tier 0 dependencies):
  ① isUncertain + escalation-only-retry fix ─────── 2d
  ② Oracle contradiction recovery + resolution rule  3d
  ③ Evidence confidence enum + config validation ─── 2d
  ④ Axiom violation fixes ────────────────────────── 3-5d

Parallel (Tier 1, alongside Tier 0):
  ├─ Worker reestimation schema ──────── 0.5d
  ├─ Caveat mode + audit trail ───────── 1d
  ├─ Regression test baseline ────────── 1d
  └─ Miscalibration handler ──────────── 1d (week 1!)

Deliverable: v2 spec + all tests passing, zero regressions,
             audit trail for every confidence mutation
```

### Phase 7: Autonomous Behavior (10-12 days after v2 stable)

```
Day 1-4 (Parallel streams):
  ├─ Stream A: Auto-learning routing
  │   SelfModel EMA per task_type
  │   RiskRouter learns threshold deltas
  │   Data gate: ≥100 traces per task_type
  │
  └─ Stream B: Graceful degradation
      Oracle fallback chains (AST→Type→Lint)
      Circuit breaker: failureThreshold=3, resetTimeout=60s

Day 7-10 (After A+B stable):
  └─ Stream C: Drift detection + recovery
      TraceCollector detects prediction error divergence
      Auto-reset thresholds when error_cv > 0.5
      Recovery target: pre-drift accuracy within 1 hour

Optional (Day 10+):
  └─ Stream D: Approach diversity (multiple oracle combos)

Deliverable: System self-corrects routing without human config changes
```

### Phase 8+: Advanced Autonomy (Backlog)

- Meta-learning across instances
- Mandatory SL fusion (only if Phase 7 contradiction resolution proves insufficient)
- Cross-task epistemic memory
- Fleet governance

---

## Autonomy Definition (8 Measurable Metrics)

Vinyan is truly autonomous when ALL 8 are satisfied:

| # | Metric | Target | Measurement |
|---|--------|--------|-------------|
| 1 | **Self-Correcting Routing** | Thresholds auto-adjust ±5% within 50 tasks per task_type | `\|Δthreshold\| / baseline ≥ 0.05` within 50-task window |
| 2 | **Graceful Degradation** | Oracle fallback succeeds when primary fails | `success_rate(fallback_path) ≥ 80%` |
| 3 | **Drift Recovery** | Return to pre-drift accuracy within 1 hour | `time_to_recovery ≤ 60 min`; `prediction_error_cv < 0.4` post-recovery |
| 4 | **Evidential Soundness** | Every decision has audit trail to evidence origin | `100%` decisions traceable to source + tier |
| 5 | **No Silent Regressions** | v2 baseline maintained | `success_rate_delta vs baseline ≤ 2%` or alert fires |
| 6 | **Config Robustness** | Operates across ±50% config variations or alerts | `alert_rate ≥ 90%` when config diverges >2x from SelfModel |
| 7 | **Bounded Miscalibration** | Prediction error CV < 0.4 per task_type | `CV(prediction_error) < 0.4`; auto-reset at CV > 0.5 |
| 8 | **Operator-Free Operation** | ≥8 hours on novel task_types without human intervention | `MTBI ≥ 8 hours` for novel task_types |

**Explicitly NOT autonomy:** choosing which tasks to do (user decides), selecting oracles by cost (only capability matters), modifying task semantics (only routing/escalation), functioning with completely broken config (guards required).

---

## Key Takeaway

> **v2 is the enabler. Phase 7 is the autonomy. Don't ship Phase 7 without v2. Don't wait for v2 to be perfect.**
>
> Fix Tier 0 blockers → ship Tier 1 quick wins → move to Phase 7 autonomous behavior.
> Autonomy emerges from **learned routing + graceful degradation + drift recovery**.
> Everything else is polish.
