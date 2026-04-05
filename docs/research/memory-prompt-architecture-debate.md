# Memory & Prompt Architecture — Expert Debate Synthesis

> **Document boundary**: Debate synthesis — owns consensus, disagreements, and recommended path.
> For research landscape → [memory-and-prompt-architecture.md](memory-and-prompt-architecture.md).
> For Claude Code source analysis → [claude-code-deep-dive.md](claude-code-deep-dive.md).

## Debate Panel

| Persona | Lens | Core Thesis |
|---------|------|-------------|
| **Pragmatist** | Ship measurable wins today | Simple file-backed memory > complex DB retrieval. If it's not in `get_errors`, it doesn't exist. |
| **Epistemic Purist** | Axiom compliance first | Vinyan proves A1 in oracles but *violates it systematically in memory*. Memory that writes itself cannot evaluate itself. |
| **Systems Architect** | Production scale & cost | At 10K tasks/day, current baseline = ~$28K/year. Cache boundaries alone save 30-35%. |
| **Red Team** | Adversarial failure modes | Working memory dying at task boundary is the #1 trust deficit — an agent that forgets retry history will waste tokens re-discovering failures. |

---

## 1. Unanimous Consensus (4/4 Agree)

These proposals received no objections from any expert:

### 1.1 Cache-Boundary Markers in PromptAssembler

**What**: Add `CacheControl` markers to separate static system prompt (cacheable) from dynamic per-task content (volatile).

**Why all agree**:
- Pragmatist: ~50-70% token cost reduction, trivial to implement (~110 lines, 3 files)
- Purist: `CacheControl` type already exists in codebase — just wire it
- Architect: 30-35% cost reduction → $4.4K/year savings at 10K tasks/day; payback = immediate
- Red Team: Complexity +0.2, value HIGH → best ratio in all proposals

**Implementation**: Partition `assemblePrompt()` output into `{ cached: systemPrompt, dynamic: taskPrompt }`. Provider layer maps to Anthropic `cache_control` / OpenAI equivalent.

**No disagreements.**

### 1.2 Temporal Decay on World Graph Facts

**What**: Wire existing `valid_until` + `decay_model` columns into confidence scoring at read time.

**Why all agree**:
- Pragmatist: Columns already exist, just need 1 function to apply decay at query time
- Purist: Supports A4 (content-addressed truth) — facts SHOULD lose confidence over time
- Architect: Prevents stale facts from poisoning future tasks; prerequisite for cost-weighted caching
- Red Team: Stale facts = HIGH likelihood failure mode; decay is the minimum viable fix (2 hours)

**Implementation**: `getFact()` → apply `decayedConfidence = applyDecay(confidence, decayPolicy, age)`. Different decay rates by fact type: file-local (hash-bound, no time decay), external-api (7-day half-life), environment (cliff expiry), performance (30-day half-life).

**No disagreements.**

---

## 2. Strong Consensus (3/4 Agree)

### 2.1 Instruction Memory (VINYAN.md)

| Expert | Stance | Key Point |
|--------|--------|-----------|
| Pragmatist | ✅ Simple file-backed | Human-authored only, like Claude Code's `CLAUDE.md`. Not an injection surface because no LLM writes to it. |
| Purist | ✅ With verification gate | Oracle-verified promotion: LLM proposes → oracle verifies → orchestrator commits. A1-compliant. |
| Architect | ✅ For cache stability | Stable instruction block = higher cache hit rate. Content changes rarely → excellent caching ROI. |
| Red Team | ⚠️ Conditional | If human-authored-only → safe. If LLM can propose additions → injection surface. Must mark trust tier at storage. |

**Resolution**: Start with Pragmatist's model (human-authored only). Purist's oracle-verified promotion is the upgrade path when automated learning is needed, but it's Phase 2+ scope.

### 2.2 Evidence-Aware Compaction (Not LLM Summarization)

| Expert | Stance | Key Point |
|--------|--------|-----------|
| Pragmatist | ✅ Evidence-first | Wire existing `TranscriptPartition` type. Keep verdicts + failed approaches, drop narrative. |
| Purist | ✅ Never discard tier-1 | Oracle verdicts (confidence=1.0) must NEVER be evicted. Tier-based hierarchy: deterministic > heuristic > probabilistic. |
| Architect | ✅ Token reduction | Whatever reduces tokens fastest. Structure-preserve compaction > LLM summarization. |
| Red Team | ✅✅ Strongest advocate | LLM summarizer WILL hallucinate details into compacted transcript → re-injected as fact → feedback loop (CATASTROPHIC). Structure-preserve only. |

**Resolution**: Consensus on structure-preserve compaction. Purist's eviction hierarchy (tier > confidence > age) is the tiebreaker when budget forces eviction.

### 2.3 Working Memory Persistence Across Tasks

| Expert | Stance | Key Point |
|--------|--------|-----------|
| Pragmatist | ⚠️ Defer | Wait for evidence it solves real problems. Complexity +1.5, value MEDIUM. |
| Purist | ✅ With epistemic constraints | Serialize to World Graph with trust tier. Cross-task memory must carry provenance. |
| Architect | ✅ For latency | Re-discovering same-file context costs tokens. Episodic store table with same-file query on task start. |
| Red Team | ✅ #1 priority fix | "Compaction amnesia" = biggest trust deficit. Serialize `failedApproaches` to World Graph at task end (3 hours). |

**Resolution**: Red Team's quick fix (serialize failed-approaches at task end, 24h TTL) is the MVP. Full episodic store is Phase 2.

---

## 3. Key Disagreements

### 3.1 Complexity Budget — Build vs. Defer

**The Debate**: Pragmatist identified 6 over-engineered patterns already in codebase (unused `TranscriptPartition`, 5-tier trust taxonomy, schema versioning, etc.) and argues for REMOVING before adding. Purist counters that "80% is already implemented — just wire it."

| Pattern | Pragmatist | Purist |
|---------|-----------|--------|
| `TranscriptPartition` type (unused) | Delete dead code | Wire it — it's the compaction backbone |
| 5-tier trust taxonomy (partially wired) | Over-designed for current needs | Essential for A5 (tiered trust) |
| `decay_model` column (exists, unwired) | Just wire it | Just wire it ✅ |
| Schema versioning tables | Premature — no migration story | Needed for Phase 3 evolution |
| Shadow job persistence | No recovery story = dead weight | Insurance against crash |

**Verdict**: Wire what's useful (`decay_model`, `TranscriptPartition`). Defer what has no consumer (schema versioning, shadow recovery). Pragmatist's "delete dead code" ethos and Purist's "wire existing infrastructure" ethos converge when the criterion is: **does it have a caller this quarter?**

### 3.2 Memory Promotion Path — Human-Only vs. Oracle-Gated

**The Debate**: Should learned patterns become permanent instructions automatically?

- **Pragmatist**: Human-authored only. Claude Code chose this path deliberately. LLM-generated instructions = hallucination risk.
- **Purist**: Oracle-verified promotion WITH deterministic rules. A1 says "no engine evaluates its own output" — this doesn't forbid promotion, it requires external verification.  
- **Red Team**: Both paths have injection risk. Trust-tier marking at storage time is the prerequisite regardless of path.

**Verdict**: Not resolved. Both approaches are valid under different trust assumptions. Start human-only; build oracle-verified promotion when Sleep Cycle has ≥100 traces to validate patterns statistically.

### 3.3 Scale Architect's Productions Proposals vs. Current Phase

Architect proposes S2 (latency enforcement + streaming), S4 (per-worker token budgets), S5 (cross-instance World Graph sync). These are production infrastructure.

- **Pragmatist**: "We don't have 50 concurrent workers. Build when real."
- **Purist**: "S2 is axiom-neutral. S4/S5 require A6-compliant design before building."
- **Red Team**: "S4 prevents token starvation at scale. But at current scale, global budget cap works."

**Verdict**: Defer S4/S5 to Phase 4+. S2 (latency enforcement) is worth building early — it's a safety net even at low scale.

---

## 4. Debate Matrix — All Proposals × All Experts

| Proposal | Pragmatist | Purist | Architect | Red Team | Priority |
|----------|-----------|--------|-----------|----------|----------|
| Cache-boundary markers | ✅ P1 | ✅ E3 | ✅ S1 | ✅ Low complexity | **P0 — Do first** |
| Temporal decay on facts | ✅ P5 | ✅ E4 | ✅ prereq | ✅ 2hr fix | **P0 — Do first** |
| Trust-tier marking at storage | — | ✅ E1 | — | ✅ 1hr fix | **P0 — Do first** |
| VINYAN.md instruction memory | ✅ P2 | ✅+gate E1 | ✅ cache | ⚠️ if human-only | **P1 — This sprint** |
| Failed-approaches serialization | — | ✅ E2 | — | ✅ 3hr fix | **P1 — This sprint** |
| Structure-preserve compaction | ✅ P3 | ✅ E2 | ✅ | ✅✅ | **P1 — This sprint** |
| Evidence-chain preservation | — | ✅ E5 | — | ✅ deep fix | **P2 — Next sprint** |
| Latency budget enforcement | — | — | ✅ S2 | — | **P2 — Next sprint** |
| Tool definition lazy loading | ✅ P4 | — | — | — | **P2 — Nice to have** |
| Adaptive cache TTL | — | — | ✅ S3 | — | **P2 — Nice to have** |
| Per-worker token budgets | — | — | ✅ S4 | — | **P3 — Phase 4** |
| Cross-instance World Graph sync | — | — | ✅ S5 | — | **P3 — Phase 5** |
| Oracle-verified memory promotion | — | ✅ E1 deep | — | ⚠️ | **P3 — When data sufficient** |
| Episodic store (full) | ⚠️ defer | ✅ | ✅ | ✅ MVP first | **P3 — After MVP validated** |

---

## 5. Red Team Failure Modes vs. Mitigations

| # | Failure Mode | Likelihood | Impact | Mitigation | Which Proposal Fixes It |
|---|---|---|---|---|---|
| 1 | **Compaction Amnesia** — working memory dies at task boundary | HIGH | CATASTROPHIC | Serialize failed-approaches to World Graph with 24h TTL | Failed-approaches serialization (P1) |
| 2 | **Stale Facts** — hash binding misses API/env drift | HIGH | MAJOR | Fact-type discrimination + decay policies | Temporal decay (P0) |
| 3 | **Second-Order Injection** — stored fact re-read without re-sanitization | MEDIUM | MAJOR | Trust-tier marking at storage + re-sanitize on re-read | Trust-tier marking (P0) |
| 4 | **Confidence Collapse** — evidence evicted, parent verdict orphaned | MEDIUM | MAJOR | Link verdicts to evidence IDs; check before eviction | Evidence-chain preservation (P2) |
| 5 | **Hallucinated Compaction** — LLM fabricates in summary | MEDIUM | CATASTROPHIC | Structure-preserve compaction only; no LLM summarizer | Structure-preserve compaction (P1) |

**Assessment**: All 5 failure modes have mitigations in the prioritized roadmap. Failure #1 and #5 (both CATASTROPHIC) are addressed in P0-P1. No gaps.

---

## 6. Recommended Architecture — MVP

All 4 experts converge on this minimal viable architecture for autonomous memory:

```
┌─ Static System Prompt ──────────── [CACHED — changes rarely]
│  └─ Role + output format + tool schema
│
├─ Instruction Memory ────────────── [CACHED — human-authored]
│  └─ VINYAN.md (project conventions, user preferences)
│
├─ Working Memory ────────────────── [PER-TASK — bounded arrays]
│  ├─ failedApproaches (max 20, confidence-evicted)
│  ├─ activeHypotheses (max 10, confidence-evicted)
│  ├─ unresolvedUncertainties (max 10, FIFO)
│  └─ scopedFacts (max 50, FIFO)
│  └─ [NEW] Serialize to World Graph at task end (24h TTL)
│
├─ World Graph ───────────────────── [PERSISTENT — content-addressed]
│  ├─ Oracle-verified facts + file hash binding
│  ├─ [NEW] Temporal decay by fact type
│  ├─ [NEW] Trust-tier marking at storage
│  └─ [NEW] Decayed confidence at read time
│
├─ Transcript ────────────────────── [SESSION — structure-preserve compaction]
│  └─ [NEW] Eviction: tier > confidence > age (not FIFO)
│
└─ Procedural Store ──────────────── [PERSISTENT — skill cache]
   └─ Successful patterns from prior tasks
```

**What's explicitly NOT in MVP** (all 4 agree to defer):
- Vector-based fact retrieval / embeddings
- LLM-directed fact paging (MemGPT model)
- Reflection synthesis (Generative Agents model)
- Cross-worker memory sharing (Phase 4)
- LLM summarization for compaction

---

## 7. Implementation Roadmap

### P0 — Immediate (2-4 hours each)

| Item | Est. | Files | Why First |
|------|------|-------|-----------|
| Wire `valid_until` + `decay_model` in World Graph reads | 2h | `world-graph.ts` | Columns exist, just unwired. Blocks stale-fact failure mode. |
| Add trust-tier marking at fact storage | 1h | `world-graph.ts` | Prerequisite for injection mitigation. |
| Cache-boundary markers in PromptAssembler | 4h | `prompt-assembler.ts`, provider layer | Unanimous #1. Immediate cost savings. |

### P1 — This Sprint (half-day each)

| Item | Est. | Files | Why Now |
|------|------|-------|---------|
| Serialize failed-approaches at task end | 3h | `working-memory.ts`, `world-graph.ts` | Fixes #1 trust deficit (compaction amnesia). |
| File-backed VINYAN.md instruction memory | 6h | New: `instruction-memory.ts`, modify `prompt-assembler.ts` | 3/4 experts agree, human-authored only for safety. |
| Structure-preserve compaction | 8h | `transcript-partition.ts` (wire existing type) | Red Team rates LLM compaction as CATASTROPHIC risk. |

### P2 — Next Sprint

| Item | Est. | Why |
|------|------|-----|
| Evidence-chain preservation during eviction | 1w | Prevents confidence collapse (Red Team #4). |
| Latency budget enforcement | 1w | Safety net even at low scale (Architect). |
| Tool definition lazy loading | 3d | Token savings for large tool registries. |

### P3 — When Data Sufficient

| Item | Trigger | Why |
|------|---------|-----|
| Oracle-verified memory promotion | ≥100 Sleep Cycle traces | A1-compliant automated learning. |
| Per-worker token budgets | ≥50 concurrent workers | Global cap fails at scale (8.3× overcommit at 100 workers). |
| Cross-instance World Graph sync | Multi-instance deployment | Phase 5 dependency. |
| Full episodic store | Validated that failed-approaches serialization isn't enough | Don't build until MVP proven insufficient. |

---

## 8. Open Questions (Unresolved)

1. **Compaction trigger threshold**: When should compaction activate? Pragmatist says "don't compact until >150K tokens." Architect says "compact proactively for cache efficiency." No consensus.

2. **Fact-type taxonomy**: How many fact types? Red Team proposes 4 (file-local, external-api, environment, performance). Purist wants alignment with evidence tiers. Need concrete mapping.

3. **Cross-task episodic scope**: When serializing failed-approaches, scope by file? By task type? By time window? Red Team says "same-file context" but Purist says "same task-type patterns."

4. **Cache invalidation strategy**: When VINYAN.md changes, what cache entries invalidate? Architect wants explicit key management. No design yet.

5. **A1 boundary for memory writes**: Where exactly does the A1 boundary sit? LLM proposes facts → World Graph stores → Orchestrator reads. But the LLM *chose* what to propose. Is that a violation? Purist says no (oracle verifies the proposal). Red Team says "it's a grey area."

---

## 9. Key Insight — Where Vinyan Beats the Landscape

All 4 experts highlight the same structural advantage: Vinyan's axiom system (especially A1, A3, A6) prevents failure modes that plague every competing system:

| System | Failure | Why Vinyan Is Immune |
|--------|---------|---------------------|
| Claude Code | LLM writes + reads own memories → self-reinforcing hallucination | A1: generation ≠ verification |
| Mem0 | LLM judges memory importance → biased retention | A3: deterministic governance, no LLM in decision path |
| MemGPT | Worker controls memory paging → can manipulate own context | A6: zero-trust execution, workers propose, orchestrator disposes |
| Generative Agents | Reflection "insights" from LLM → confabulation as knowledge | A5: tiered trust, probabilistic evidence ranked below deterministic |

**The gap isn't architecture — it's wiring.** Infrastructure for temporal decay, trust tiers, and evidence preservation already exists in schema/types. The work is connecting existing pieces, not inventing new ones.
