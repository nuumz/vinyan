# Memory & Prompt Architecture — System Design

> **Document boundary**: This document owns the system design, architecture decisions, and implementation plan for Vinyan's memory substrates and prompt assembly pipeline.
> For research landscape → [memory-and-prompt-architecture.md](../research/memory-and-prompt-architecture.md).
> For Claude Code source analysis → [claude-code-deep-dive.md](../research/claude-code-deep-dive.md).
> For expert debate consensus → [memory-prompt-architecture-debate.md](../research/memory-prompt-architecture-debate.md).
> For core architecture decisions → [decisions.md](../architecture/decisions.md).

**Date:** 2026-04-05 (revised: correction audit + flow/journey audit + 3-expert design review)
**Status:** Active — P0 implemented, P1 partial (temporal decay, trust marking, cache boundaries, failed-approach recording, instruction loader, structure-preserve compaction done; evidence chain, cross-task learning, cache TTL differentiation NOT done), P2-P4 in design
**Confidence:** MEDIUM-HIGH — architecture grounded in source code analysis + 3-expert brainstorm + 3-stream correction audit + codebase verification + 3-perspective design review (System Engineer, LLM Agent Engineer, AI Principal).

---

## Executive Summary

Vinyan's memory and prompt systems have moved from "functional but monolithic" to a tiered architecture across 4 memory substrates with temporal decay, trust marking, cache boundaries, and structure-preserve compaction. This document captures the full system design — current state (with honest status labels), architectural gaps, and phased roadmap.

**Key insight from expert synthesis:** The gap isn't missing infrastructure — it's incomplete wiring. Schema columns, type definitions, and decay functions exist but aren't connected at decision points. `tier_reliability` is stored but never consumed in routing. Oracle metadata is persisted in World Graph but dropped before reaching the LLM. The work is connecting existing pieces and adopting the section-based prompt registry pattern already validated in Claude Code.

**Status labels used throughout this document:**
- `[IMPLEMENTED]` — Code exists, tested, in use
- `[PARTIAL]` — Partially built with documented gaps
- `[DESIGNED]` — Technical design complete, ready to code
- `[ASPIRATIONAL]` — Conceptual target, no detailed spec yet

**Three strategic bets:**
1. **Section-based prompt assembly** `[DESIGNED]` — adopt the composable registry pattern validated in Claude Code (enables per-section caching, model adaptation, and progressive disclosure)
2. **Evidence chain completeness** `[DESIGNED]` — preserve forensic trails through eviction, decay, and cross-task boundaries (axiom A3+A4+A5 compliance)
3. **Tiered cache economics** `[DESIGNED]` — static/session/ephemeral with Anthropic pricing awareness (projected 35-61% cost reduction depending on phase completion)

---

## 1. Architecture Overview

### 1.1 Memory Substrates

Vinyan operates 4 distinct memory substrates, each with different lifecycle, trust level, and governance:

| Substrate | Implementation | Lifecycle | Trust | Mutation | Eviction |
|-----------|---------------|-----------|-------|----------|----------|
| **Instruction Memory** | VINYAN.md → `instruction-loader.ts` | Persistent (human-authored) | HIGH (user intent) | Human only | Manual (file edit) |

> **Debate tradeoff (D4):** Implements Red Team's "human-authored-only" constraint. Purist's oracle-verified promotion (A1-compliant but complex) deferred to Phase 4+ when ≥100 Sleep Cycle traces available. See [debate §3.1](../research/memory-prompt-architecture-debate.md).
>
> **Research constraint:** CLAUDE.md compliance degrades sharply above 200 lines (92-96% → 71%). VINYAN.md's current 50KB limit (≈25K lines) risks compliance cliff. Phase 3 decomposes large instruction sets across the hierarchical tier system rather than pooling into one file.
| **Working Memory** | `WorkingMemory` class (in-process) | Per-task (ephemeral) | LOW (LLM-generated) | Agent freely | Bounded arrays: confidence (failed approaches), FIFO (facts, uncertainties) |
| **World Graph** | SQLite WAL (`world-graph.ts`) | Persistent (cross-session) | MEDIUM (oracle-verified) | Hash-gated | TTL + decay + file hash invalidation |
| **Execution Traces** | SQLite (`TraceDB`) | Persistent (audit) | HIGH (deterministic) | Append-only | 30-day retention, keep 10 sessions |

> **Additional persistence stores** (not memory substrates but interact with the memory/prompt path):
> - `SessionStore` — session state + working memory JSON snapshots + compaction results (enables session recovery via `SessionManager.recover()`)
> - `CalibratedSelfModel` params — per-task-type EMA in `self_model_params` table (drives routing prediction)
> - `OracleAccuracyStore` — oracle prediction vs actual outcome tracking
> - `OracleProfileStore` — oracle lifecycle management (active/demoted/retired)
> - `PredictionLedger` — ForwardPredictor calibration data (`prediction_ledger`, `prediction_outcomes`, `plan_rankings`)
> - `SkillStore` / `RuleStore` — cached skills and evolutionary rules
>
> These stores total ~16 SQLite tables across 2 databases (World Graph DB + Vinyan DB). Full schema in `src/db/migrations/` and `src/world-graph/schema.ts`.

### 1.2 Prompt Assembly Pipeline

```
┌─ SYSTEM PROMPT ──────────────────── [CACHED — cache_control: ephemeral]
│  ├─ Role + epistemic preamble              (~100 tokens, static)
│  ├─ Output format (JSON for code)          (~50 tokens, static)
│  ├─ Oracle manifest (verifier capabilities) (~120 tokens, static)
│  ├─ Tool definitions (from runtime)         (~150-300 tokens, semi-static)
│  └─ Project instructions (VINYAN.md)        (~800-1500 tokens, session-stable)
│
├─ USER PROMPT ────────────────────── [DYNAMIC — per-task]
│  ├─ [TASK] Goal (sanitized via guardrails)
│  ├─ [PERCEPTION] Dependency cone, file targets
│  ├─ [DIAGNOSTICS] Type errors (top 10), lint warnings
│  ├─ [KNOWN FACTS] World Graph facts (per-fact trust annotation post-G1; currently "verified" label only)
│  ├─ [CONSTRAINTS] Failed approaches from working memory
│  ├─ [HYPOTHESES] Active hypotheses (from skill cache or prior attempts)
│  ├─ [UNCERTAINTIES] Unresolved areas + suggested actions
│  └─ [PLAN] Task DAG nodes (L2+ only)
│
└─ GUARDRAILS ─────────────────────── [APPLIED — all untrusted text]
   └─ sanitizeForPrompt(): NFKC normalize → zero-width strip → percent-decode
      → regex injection detection → base64 payload detection
```

**Current cache state:** `[IMPLEMENTED]` All sections tagged `CacheControl { type: 'ephemeral' }`. No TTL differentiation. Estimated hit rate: ~0-5% (only within same-task retry loops). This is the primary cost optimization target — Phase 1 adds static/session tiers.

### 1.3 Axiom Compliance Map

> **Honest assessment:** A1 and A6 are fully proven. A3, A4 are mostly proven with evidence-archival gaps. **A5 (Tiered Trust) is NOT functional at the decision point** — `tier_reliability` is stored in World Graph but never consumed in routing, and `PerceptualHierarchy.verifiedFacts` drops oracle origin and confidence before the LLM sees facts. A7 is proven in SelfModel.

| Feature | A1 (Sep) | A3 (Det. Gov) | A4 (Content-Addr) | A5 (Tiered Trust) | A6 (Zero-Trust) | Status |
|---------|----------|---------------|--------------------|--------------------|------------------|---------|
| Temporal decay | — | — | ✅ Facts bound to hash | ✅ Decay by tier | — | `[IMPLEMENTED]` |
| Trust-tier marking | — | — | ✅ tier_reliability stored | ❌ Stored but **never consumed** in routing or prompt | — | `[PARTIAL]` — stored, not wired |
| Cache boundaries | — | ✅ Deterministic placement | — | — | — | `[PARTIAL]` — all ephemeral, no TTL |
| Failed approaches | ✅ LLM proposes, oracle rejects | ❌ Evidence **lost on eviction** (no archive) | — | — | ✅ Oracle verdict drives rejection | `[PARTIAL]` — records but doesn't persist |
| Instruction memory | ✅ Human-authored, not LLM | ✅ SHA-256 cached | ✅ Content-addressed | — | ⚠️ No re-sanitization on load | `[IMPLEMENTED]` |
| Structure-preserve | ✅ No LLM in compaction | ✅ Deterministic | — | ✅ Evidence turns preserved | — | `[IMPLEMENTED]` |
| Oracle metadata in facts | — | — | ✅ Stored in World Graph | ❌ **Dropped** in PerceptualHierarchy | — | `[PARTIAL]` — G1 gap |
| Failed verdict archival | — | ❌ Only successes stored | ❌ Failures vanish | — | — | `[NOT IMPLEMENTED]` — G5 gap |

---

## 2. Memory Lifecycle State Machine `[IMPLEMENTED]`

### 2.1 Per-Task Lifecycle

```
TASK START
   │
   ├── ① INITIALIZE
   │   ├─ WorkingMemory() — empty arrays, zero counters
   │   ├─ routing = riskRouter.assessInitialLevel(input)
   │   └─ startTime = Date.now()
   │
   ├── ② LOAD PERSISTENT MEMORIES + APPLY EVOLUTION RULES
   │   ├─ InstructionLoader.loadInstructionMemory()     [SHA-256 cached]
   │   ├─ PerceptionAssembler.assemble()                [queries WorldGraph]
   │   │   └─ WorldGraph.queryFacts(target)             [decay applied at read time]
   │   ├─ RuleStore.findMatching(filePattern)           [Phase 2 evolution rules]
   │   │   └─ Resolved winners can: escalate routing, require oracles, prefer model, adjust threshold
   │   └─ ε-exploration (random routing +1)             [SelfModel learning data collection]
   │
   ├── ③ CORE LOOP (outer: routing level L0→L3, inner: retry within level)
   │   ├─ WorkingMemory accumulates ACROSS all retries AND escalation levels
   │   │   (single instance per task — never reset between retries or level changes)
   │   ├─ Eviction triggers when bounded arrays full:
   │   │   ├─ failedApproaches (max 20): lowest confidence evicted
   │   │   ├─ hypotheses (max 10): lowest confidence evicted
   │   │   ├─ uncertainties (max 10): FIFO
   │   │   └─ scopedFacts (max 50): FIFO
   │   ├─ On verification success:
   │   │   ├─ commitArtifacts() — writes mutations to workspace filesystem (path-validated)
   │   │   └─ storeFact() — SEPARATE op: derives confidence from min oracle verdict,
   │   │       decay model from oracle temporal context, tier_reliability from confidence thresholds
   │   ├─ On verification failure:
   │   │   ├─ recordFailedApproach() — approach + oracle verdict + confidence + oracle name
   │   │   ├─ emit 'context:verdict_omitted' — diagnostics event
   │   │   └─ retry within level, then escalate routing level (L0→L1→L2→L3→human)
   │   └─ Traces recorded at EVERY outcome (6 types):
   │       timeout, uncertain, fail, budget-exceeded, dispatch-fail, success
   │
   └── ④ TASK COMPLETE
       ├─ ✅ PERSISTED: ExecutionTrace → TraceDB, World Graph facts, instruction cache
       ├─ ✅ PERSISTED: SkillManager.recordOutcome() — skill success/failure feedback
       ├─ ⚠️ SNAPSHOT: SessionStore.saveWorkingMemory() — JSON snapshot for session recovery
       ├─ ❌ LOST: WorkingMemory live instance (in-process, cleared on return)
       └─ ❌ LOST: Agentic transcript (local to agent-loop, unless compacted)
```

### 2.2 Cross-Task Memory Flow

```
Task A (COMPLETED)                         Task B (LOADING)
  │                                           │
  ├─ storeFact(verdicts) ──────┐              ├─ queryFacts(target)
  │                            │              │   ├─ Filter: file hash matches
  │                            ▼              │   ├─ Decay: computeDecayedConfidence()
  │                     ┌────────────┐        │   └─ Returns: confidence-dimmed facts
  │                     │ World Graph├───────►│
  │                     │  (SQLite)  │        │
  │                     └────────────┘        │
  │                            │              │
  ├─ TraceCollector ───────────┤              ├─ CalibratedSelfModel.predict()
  │   .record(trace)           │              │   [IMPLEMENTED]
  │   (6 trace types)          ▼              │   ├─ Per-task-type EMA from traces
  │                     ┌────────────┐        │   ├─ Cold-start safeguards (S1-S4)
  │                     │  TraceDB   ├───────►│   └─ Routing escalation via forceMinLevel
  │                     │  (SQLite)  │        │
  │                     └────────────┘        │
  │                                           │
  └─ ❌ WorkingMemory LOST                    ├─ NEW WorkingMemory (empty)
     ❌ Failed approaches LOST                └─ No cross-task context
```

**Critical gap:** `[NOT IMPLEMENTED]` Failed approaches from Task A are lost at task boundary. Task B starts fresh with no knowledge of Task A's failed strategies.

### 2.2a Cross-Task Learning Protocol `[DESIGNED — Phase 2]`

> **This is the specification for how Task B learns from Task A's failures — the property that makes Vinyan genuinely autonomous.**

**Serialization (Task A → SQLite):**
```
Task A COMPLETE
  └─ serializeFailedApproaches()
      ├─ Filter: only approaches with verdictConfidence ≥ 0.5
      ├─ Schema: { pattern, approach, oracleVerdict, confidence, taskType, fileTarget, fileHash, timestamp }
      ├─ TTL categories:
      │   ├─ Transient failures (context-specific): 24h, exponential decay
      │   └─ Structural patterns (verified ≥3 times across tasks): promote to World Graph fact
      └─ Destination: rejected_approaches table in Vinyan DB (operational history, not world knowledge)
```

**Loading (SQLite → Task B):**
```
Task B START
  └─ loadPriorFailedApproaches(target, taskType)
      ├─ Match: (file_target AND task_type) at 1.0× weight
      │         OR (task_type only) at 0.5× weight, within TTL
      ├─ Dedup: skip if (approach + file_hash) already attempted in current task
      ├─ Confidence downgrade: original × 0.7 (cross-task uncertainty)
      ├─ Max: 5 most recent (prevents constraint bloat)
      └─ Inject: as WorkingMemory.failedApproaches with source='cross-task'
```

**Resolved design questions** (from expert review):

| Question | Decision | Rationale |
|----------|----------|----------|
| Deduplication | Deduplicate on `(approach + file_hash)` | If file changed since Task A (different hash), approach may now succeed — re-verify. Same hash = same context = skip. |
| Match scope | `(file_target AND task_type)` preferred; `(task_type only)` at 0.5× confidence | Same-file + same-type = highly relevant. Same-type + different-file = pattern transfer, less certain. |
| TTL categories | Transient: 24h decay. Structural: promote to World Graph if verified ≥3× across tasks | "Don't use `any` in strict mode" = project convention (permanent). "Add return type failed due to syntax error" = transient (24h). |

**Remaining question (deferred to Phase 3+):**
- Automatic transient vs structural classification. Initial heuristic: same pattern rejected ≥3 times across ≥2 task types → promote to structural.

### 2.3 Session Boundary

| Component | Survives Session Restart? | Invalidation |
|-----------|--------------------------|--------------|
| World Graph facts | ✅ Yes (SQLite file) | File hash change → cascade delete |
| Execution traces | ✅ Yes (SQLite file) | 30-day retention policy |
| SelfModel params | ✅ Yes (SQLite `self_model_params`) | Per-task-type EMA update |
| Session snapshots | ✅ Yes (`session_store` table) | Explicit status change; stores working_memory_json + compaction_json |
| Instruction cache | ❌ No (in-process variable) | Re-loaded from disk |
| Working memory | ❌ No (per-task, in-process) | Already lost at task end; JSON snapshot in SessionStore is stale copy |
| Skill cache | ✅ Yes (SQLite RuleStore) | Explicit invalidation |
| Oracle circuit breakers | ❌ No (in-process) | Reset on restart |

### 2.4 Session Recovery Flow `[IMPLEMENTED]`

```
Vinyan restart
  └─ SessionManager.recover()
      ├─ Query: listSuspendedSessions()
      ├─ For each suspended session:
      │   ├─ Restore: session metadata (id, source, status)
      │   ├─ Restore: working_memory_json → stale snapshot (not live state)
      │   ├─ Restore: compaction_json → episode summary, key failures, success patterns
      │   └─ Resume: pending/running tasks from session_tasks table
      └─ Note: Recovery rebuilds session context but WorkingMemory starts fresh
              (snapshot is informational, not injected back into live WorkingMemory)
```

> **Design rationale (intentional, not gap):** WorkingMemory is NOT rehydrated from snapshot because: (1) stale approaches may reference changed files — rehydrating injects invalid constraints, (2) compaction_json preserves key failures in summarized form, (3) cross-task learning (§2.2a) handles "don't repeat mistakes" via rejected_approaches with file_hash validation. Re-discovering 1-2 approaches < risk of stale constraint injection.

---

## 3. Component Coupling Map `[PARTIAL]`

### 3.1 Data Flow Matrix

| Source → Target | Data | Frequency | Coupling | Status |
|----------------|------|-----------|----------|--------|
| PromptAssembler → WorkingMemory | failedApproaches, hypotheses, uncertainties | Every generation | **HIGH** | `[IMPLEMENTED]` |
| PromptAssembler → InstructionLoader | VINYAN.md content | Once per task (cached) | LOW | `[IMPLEMENTED]` |
| PromptAssembler → WorldGraph (via Perception) | verifiedFacts from queryFacts() | Per task start | MEDIUM | `[IMPLEMENTED]` |
| PerceptualHierarchy → PromptAssembler | **oracle name, confidence, tier** | Per fact rendered | **HIGH** | ❌ **MISSING** — G1: metadata dropped; LLM sees fact text but not trust level |
| CoreLoop → WorkingMemory | recordFailedApproach() | Per retry | **HIGH** | `[IMPLEMENTED]` |
| CoreLoop → WorldGraph | storeFact() after verification | Per committed mutation | MEDIUM | `[IMPLEMENTED]` |
| CoreLoop → FailedVerdictArchive | storeFailedVerdict() | Per failed verification | MEDIUM | ❌ **MISSING** — G5: only successes stored |
| CoreLoop → TraceCollector | record(trace) | Per retry attempt (6 trace types: timeout, uncertain, fail, budget, dispatch-fail, success) | **CRITICAL** | `[IMPLEMENTED]` |
| WorkingMemory eviction → Archive | archiveBeforeEvict() | Per eviction | MEDIUM | ❌ **MISSING** — G2: splice() drops entry |
| RiskRouter → WorldGraph | tier_reliability lookup | Per routing decision | MEDIUM | ❌ **MISSING** — G4: routing ignores evidence tier |
| AgentLoop → TranscriptCompactor | partitionTranscript(), buildCompactedTranscript() | Per session completion | MEDIUM | `[IMPLEMENTED]` |
| OracleRunner → WorldGraph | tier_reliability via storeFact() | Per verification | MEDIUM | `[IMPLEMENTED]` |
| Guardrails → PromptAssembler | sanitizeForPrompt() on all interpolations | Before every assembly | **CRITICAL** | `[IMPLEMENTED]` |
| FileWatcher → WorldGraph | invalidateByFile() | On file change | MEDIUM | `[IMPLEMENTED]` |
| CalibratedSelfModel → CoreLoop | predict() → routing escalation, forceMinLevel | Per task start + per retry (calibrate) | **HIGH** | `[IMPLEMENTED]` |
| TraceStore → CalibratedSelfModel | Historical traces for per-task-type EMA | On predict() | **HIGH** | `[IMPLEMENTED]` |
| SessionManager → SessionStore | session state, working_memory_json, compaction_json | Per session lifecycle event | MEDIUM | `[IMPLEMENTED]` |
| CoreLoop → SkillManager | recordOutcome(skill, success/fail) | Per task completion | MEDIUM | `[IMPLEMENTED]` |
| ForwardPredictor → CoreLoop | Routing escalation via applyPredictionEscalation() | Per task (when available) | MEDIUM | `[IMPLEMENTED]` |
| OracleRunner → OracleAccuracyStore | Prediction vs actual outcome tracking | Per verification | LOW | `[IMPLEMENTED]` |

### 3.2 Coupling Hotspot: PromptAssembler

PromptAssembler is the coupling nexus — 3 major components feed into it, and 6+ files import from it. But the **bigger coupling issue is missing data flows** (4 ❌ entries in §3.1): components don't wire evidence quality metadata. The LLM receives facts without knowing their trust tier, oracle origin, or whether similar approaches have been tried before.

**Proposed mitigation:** Two-part fix:
1. Wire missing data flows (Phase 2: G1-G5 gaps)
2. Section-based `PromptSectionRegistry` decouples content producers from the assembly mechanism (Phase 3, see §5)

---

## 4. Architectural Gaps `[PARTIAL]`

### 4.1 Ranked by severity

> **Autonomy impact:** G1, G2, and G5 are **blockers for autonomous cross-task learning**. Without them, each task reinvents failed approaches, the LLM cannot weigh evidence quality, and negative patterns remain invisible. G3 and G4 degrade quality but don't block autonomy.

| # | Gap | Severity | Axiom Violation | Current State | Proposed Fix | Phase | Status |
|---|-----|----------|------------------|---------------|-------------|-------|--------|
| G1 | Facts lose oracle origin in perception | **CRITICAL** | A4, A5 | `PerceptualHierarchy.verifiedFacts` returns only `{target, pattern, verified_at, hash}` — drops oracle name, confidence, tier | Return full `Fact[]` with oracle metadata | P2 | `[DESIGNED]` |
| G2 | Evidence lost on working memory eviction | **CRITICAL** | A3 | `splice(minIdx)` drops entry entirely; no archive before eviction | Pre-eviction write to `RejectedApproachesArchive` table | P2 | `[DESIGNED]` |
| G3 | Decayed confidence never filtered | MEDIUM | A5 | `queryFacts()` returns facts regardless of confidence level (including 0) | Add level-dependent confidence floor (L0: 0.9, L1+: 0.6) | P2 | `[DESIGNED]` |
| G4 | `tier_reliability` stored but never consumed | **HIGH** | A5 | Written to DB via `storeFact()`, never queried in `calculateRiskScore()` or routing | Activate in confidence-tier annotation + risk scoring | P2 | `[PARTIAL]` — stored, not consumed |
| G5 | Failed oracle verdicts not archived | **CRITICAL** | A3, A4 | Only success verdicts trigger `storeFact()` to World Graph; failure verdicts go to WorkingMemory only (lost at task end) | Store ALL verdicts in `FailedFactArchive` table | P2 | `[DESIGNED]` |

### 4.2 Trust Chain Breaks

```
Oracle Verdict (confidence=0.95, tier=deterministic)
    │
    ▼
storeFact() ─── ✅ Full metadata persisted (confidence, decay, tier_reliability)
    │           Note: confidence = computeFactConfidence(verdicts) = MIN of oracle confidences
    │           tier_reliability = derived: ≥0.95→1.0, ≥0.7→0.8, else 0.5
    │           decay_model = from oracle temporal context (prefers 'exponential')
    │
    ▼
queryFacts() ── ✅ Decay applied correctly
    │
    ▼
PerceptualHierarchy ─── ⚠️ BREAK: oracle origin dropped, confidence not visible
    │
    ▼
PromptAssembler ─── ⚠️ BREAK: LLM sees fact text but not trust level
    │
    ▼
LLM Generation ─── ⚠️ BREAK: Cannot weigh deterministic vs probabilistic evidence
```

**Fix:** Extend `PerceptualHierarchy.verifiedFacts` to carry full `Fact[]` with oracle name, decayed confidence, and tier.

---

## 5. Validated Pattern: Section-Based Prompt Assembly `[DESIGNED]`

> **Attribution:** This pattern is production-validated in Claude Code's `systemPromptSection()` registry ([source analysis](../research/claude-code-deep-dive.md)). Vinyan adapts it for oracle-aware rendering with per-section cache TTL. It is NOT a Vinyan innovation — it is adoption of a proven pattern.

### 5.1 Design

Replace the monolithic `buildCodeSystemPrompt()` / `buildCodeUserPrompt()` with a composable section registry:

```typescript
interface PromptSection {
  id: string;                                        // Unique identifier
  target: 'system_static' | 'system_dynamic' | 'user_dynamic';
  cache?: { type: 'static' | 'session' | 'ephemeral' };
  priority: number;                                  // Lower = earlier in prompt
  render: (context: SectionRenderContext) => string | null;
}

interface SectionRenderContext {
  perception: PerceptualHierarchy;
  workingMemory: WorkingMemoryState;
  taskType: TaskType;
  model?: string;
  plan?: TaskDAG;
}
```

### 5.2 Section Catalog

| ID | Target | Cache | Tokens | Priority | Content |
|----|--------|-------|--------|----------|---------|
| `sys_role` | system_static | 1hr | ~100 | 1 | "You are a coding worker in Vinyan..." |
| `sys_output_format` | system_static | 1hr | ~50 | 2 | JSON schema (code) or plain (reasoning) |
| `sys_oracle_manifest` | system_static | 1hr | ~120 | 3 | Verifier capabilities |
| `sys_tool_definitions` | system_static | 1hr | ~150-300 | 4 | Available tool names + descriptions |
| `sys_instructions` | user_static | 5min | ~800-1500 | 5 | VINYAN.md content `[CURRENT: in system prompt; Phase 1 moves to user message]` |
| `user_task` | user_dynamic | ephemeral | ~100-400 | 10 | Goal (sanitized) |
| `user_perception` | user_dynamic | ephemeral | ~150 | 20 | Target file, importers, blast radius |
| `user_diagnostics` | user_dynamic | ephemeral | ~200 | 30 | Type errors (top 10), lint |
| `user_known_facts` | user_dynamic | ephemeral | ~100-500 | 35 | World Graph facts `[CURRENT: "verified" label only; post-G1: per-fact trust annotation (oracle name + confidence + tier). Section renamed VERIFIED → KNOWN FACTS to avoid implying equal trust]` |
| `user_constraints` | user_dynamic | ephemeral | ~150-2000 | 40 | Failed approaches (confidence-weighted) |
| `user_hypotheses` | user_dynamic | ephemeral | ~100 | 50 | Active hypotheses (if any) |
| `user_uncertainties` | user_dynamic | ephemeral | ~100 | 60 | Unresolved areas |
| `user_plan` | user_dynamic | ephemeral | ~100-300 | 70 | Task DAG (L2+ only) |

### 5.3 Key Design Decision: VINYAN.md in User Messages

**Current:** `[IMPLEMENTED]` Instructions injected into system prompt via `buildCodeSystemPrompt()` at line 91 of `prompt-assembler.ts`.
**Proposed (Phase 1):** `[DESIGNED]` Move to user message as `[PROJECT INSTRUCTIONS]` section.

**Rationale:**
- System prompt becomes purely static (~400 tokens: role + oracle + format)
- Static system prompt cache hit rate jumps from ~5% to ~60%+
- User messages enable per-turn freshness without invalidating system cache
- Claude Code uses this exact pattern ([verified from source](../research/claude-code-deep-dive.md))
- No behavior change (same content, different placement)

### 5.4 Prompt Budget Enforcement `[DESIGNED — Phase 3]`

**Normal operation token estimate** (no retries, no cross-task):

| Section | Max Items | Tokens/Item | Subtotal | % of User Prompt |
|---------|-----------|-------------|----------|------------------|
| Task goal | 1 | 100-400 | ~250 | ~3% |
| Perception | 1 | 150 | ~150 | ~2% |
| Diagnostics | 10 (top) | 20 | ~200 | ~2% |
| Known facts | 50 | 80 | ~4,000 | ~47% |
| Failed approaches | 20 | 100 | ~2,000 | ~24% |
| Hypotheses | 10 | 50 | ~500 | ~6% |
| Uncertainties | 10 | 50 | ~500 | ~6% |
| Plan (L2+) | 1 | 300 | ~300 | ~4% |
| **Total** | | | **~8,400** | |

With Phase 2 cross-task loading (+5 approaches): ~9,000. At L3 with full plan: ~9,500-10K.

**Enforcement:** PromptSectionRegistry renders in priority order. If cumulative tokens exceed level budget, lower-priority sections truncate first:

| Level | Max User Tokens | Truncation Order (first → last) |
|-------|----------------|--------------------------------|
| L1 (Haiku) | 6,000 | plan → uncertainties → hypotheses → approaches (keep top 5) |
| L2 (Sonnet) | 15,000 | plan summary → uncertainties top 5 |
| L3 (Opus) | 30,000 | No truncation expected |

> **Key insight:** Budget enforcement replaces unbounded accumulation with deliberate prioritization. The section registry (§5.1) enables this — each section's `render()` receives remaining budget and self-truncates.

---

## 6. Target Design: Multi-Tier Cache Strategy `[DESIGNED]`

### 6.1 Pricing-Aware Cache Tiers

| Tier | TTL | Write Cost | Read Cost | Content | Invalidation |
|------|-----|-----------|-----------|---------|-------------|
| **Static** | 1 hour | 200% | 10% | Role, oracle manifest, format, tool defs | Vinyan version change |
| **Session** | 5 min | 125% | 10% | VINYAN.md, skill cache | File hash change |
| **Ephemeral** | None | 100% | — | Task-specific: goal, perception, memory | Per-task (inherently unique) |

### 6.2 Cache Placement Diagram `[DESIGNED — not yet implemented]`

```
┌─ TOOLS ─────────────────────────── [Anthropic auto-caches]
│  └─ Tool schema definitions
│  └─ ● Cache breakpoint 1
│
├─ SYSTEM PROMPT ───────────────── [Target: STATIC — 1-hour cache]
│  ├─ Role + epistemic preamble
│  ├─ Output format specification
│  ├─ Oracle manifest
│  └─ Tool definitions
│  └─ ● Cache breakpoint 2
│  Note: Currently ALL sections (including VINYAN.md) in system prompt, all ephemeral.
│  Phase 1 moves VINYAN.md to user message and implements TTL differentiation.
│
├─ USER MESSAGES ─────────────────── [MIXED]
│  ├─ [SESSION] Project instructions (VINYAN.md, 5-min cache)
│  │  └─ ● Cache breakpoint 3
│  │
│  ├─ [EPHEMERAL] Task context
│  │  ├─ Goal + perception + diagnostics
│  │  ├─ Facts + constraints + hypotheses
│  │  └─ Plan (L2+)
│  │
│  └─ Conversation history (auto-cached by provider)
│     └─ ● Cache breakpoint 4 (automatic, moves forward each turn)
│
└─────────────────────────────────────────────────────────────────
```

### 6.3 Cost Projection `[HYPOTHESIS — requires baseline instrumentation]`

**Baseline (today):** Monolithic ephemeral, all ~2,500 tokens rewritten every task. Baseline is estimated, not measured — instrumenting `assemblePrompt()` is a Phase 1 prerequisite.

> **Cost savings reconciliation:** Phase 1 (VINYAN.md move + TTL types) delivers ~35-40% savings on cached prefix. Full 3-tier optimization (Phase 1 complete + section registry in Phase 3) delivers ~61%. The table below shows the full 3-tier target.

| Scale | Today (estimated) | 3-Tier Optimized (target) | Savings |
|-------|-------|-----------------|---------|
| 10 tasks/day | 31K tokens | 12K tokens | **61%** |
| 100 tasks/day | 313K tokens | 123K tokens | **61%** |
| 1K tasks/day | 3.1M tokens | 1.23M tokens | **61%** (~$6/day at Claude pricing) |
| 10K tasks/day | 31M tokens | 12.3M tokens | **61%** (~$56/day) |

**Static cache write amortization:** 1-hour TTL means the 200% write penalty is paid once per session, then 10% reads dominate. At 100 tasks/session, the effective cost per task for the static portion is ~10.2% (90% savings vs re-writing).

---

## 7. Target Design: Model-Aware Prompt Adaptation `[ASPIRATIONAL]`

> **Evidence status:** Conceptually supported by Claude Code's model-version-gated prompt sections ([source](../research/claude-code-deep-dive.md)). Specific token allocations in §7.1 are **unvalidated hypotheses** — require empirical measurement of prompt compliance rates at each tier before deployment.

### 7.1 Model → Section Treatment Matrix `[HYPOTHESIS — values require calibration]`

| Section | Haiku (L1) | Sonnet (L2) | Opus (L3) |
|---------|-----------|-------------|-----------|
| Role preamble | Concise (100 tokens) | Detailed (120) | Full + philosophy (150) |
| Output format | Strict JSON | JSON preferred | JSON or prose |
| Oracle manifest | Condensed (100) | Full (250) | Full + explanations (300) |
| Tool definitions | Names only (50) | Names + 1-line desc (150) | Full schema (300) |
| Project instructions | Filtered (max 20KB) | Full (max 50KB) | Full + extended (max 75KB) |
| Thinking config | Disabled | Adaptive (medium) | Adaptive (max) |
| Plan section | Skipped | Included | Included + reasoning |
| **Thinking budget** | **0 (disabled)** | **4K-8K tokens (adaptive)** | **16K-32K tokens (max)** |

> **Cost dimension often missed:** `(prompt_tokens × input_price) + (thinking_tokens × thinking_price) + (output_tokens × output_price)`. At L3 Opus with 32K thinking, thinking cost can exceed prompt cost. Optimize both dimensions, not just prompt size.

### 7.2 Routing → Model Mapping

```
Risk Score → Routing Level → Model Tier → Prompt Adaptation

L0 (< 0.2): No LLM — cached skills only
L1 (< 0.4): Haiku — condensed prompt, no thinking, JSON only
L2 (< 0.7): Sonnet — full prompt, adaptive thinking, structured output
L3 (≥ 0.7): Opus — extended prompt, maximum thinking, rich exploration
```

**Key constraint:** Model tier adapts the prompt, not the other way around. The section registry renders based on `context.model`, and the risk router selects the model. These are decoupled decisions.

### 7.3 Open Research: LLM Evidence Interpretation Calibration `[NOT STARTED]`

SelfModel calibrates **routing prediction** ("should I escalate?") but does NOT calibrate **evidence interpretation** ("does the LLM correctly weigh confidence=0.6 from lint oracle?").

**Risk without calibration:**
- LLM ignores low-confidence facts → information loss
- LLM over-trusts high-confidence facts → misses context changes
- LLM treats all oracle sources equally → "AST oracle" ≡ "LLM oracle" from its perspective

**Proposed approach (Phase 3+):** Inject interpretation guidance in system prompt calibrated from SelfModel prediction errors. Example: *"AST oracle confidence=0.95 → symbol definitely exists. LLM oracle confidence=0.7 → another LLM agreed, verify independently."*

**Validation requirement:** A/B test on 50+ tasks measuring approach diversity and fact utilization rate before/after evidence metadata. If LLM behavior doesn't change → metadata alone insufficient → interpretation prompting required.

---

## 8. Target Design: Evidence Chain Preservation `[DESIGNED]`

### 8.1 Current Evidence Flow (with gaps)

| Stage | Evidence Status | Gap |
|-------|----------------|-----|
| Oracle verdict generated | ✅ Full evidence (file, line, message, confidence, tier) | — |
| storeFact() on success | ✅ Evidence persisted in World Graph + fact_evidence_files | — |
| queryFacts() next task | ⚠️ Evidence available but confidence dimmed by decay | No confidence floor filter |
| PerceptualHierarchy | ❌ Oracle origin dropped, confidence not visible | G1 |
| PromptAssembler | ❌ LLM cannot weigh trust levels of different facts | G1 |
| Working memory eviction | ❌ Entry + evidence dropped entirely | G2 |
| Failed verification | ❌ Verdict never stored (only successes become facts) | G5 |

### 8.2 Proposed: Complete Evidence Flow

```
Oracle Verdict
    │
    ├── SUCCESS: storeFact() ─── World Graph (with full metadata)
    │                              → queryable via queryFacts()
    │                              → returned as Fact[] with oracle name + confidence
    │
    ├── FAILURE: storeFailedVerdict() ─── FailedFactArchive (NEW)
    │                                      → "type oracle rejected: missing return type"
    │                                      → surfaced to LLM: "Previously rejected pattern"
    │
    └── EVICTION: archiveBeforeEvict() ─── RejectedApproachesArchive (NEW)
                                            → approach + verdict + confidence + routing level
                                            → loaded on escalation as prior-attempts context
```

### 8.3 Evidence Survival Rules

| Trigger | Currently | Target |
|---------|-----------|--------|
| Fact decay below threshold | Fact returned with 0 confidence | Filter out below level-dependent floor |
| Working memory full (20 entries) | Lowest confidence evicted forever | Archive to SQLite before eviction |
| Transcript compaction | Evidence turns preserved, narrative dropped | ✅ Already correct |
| File hash change | Cascade delete facts | ✅ Already correct |
| Task boundary | Working memory cleared | Serialize critical approaches to trace |

---

## 9. Failure Modes & Risk Matrix `[PARTIAL — validated F1-F7, hypothesis F9-F10]`

### 9.1 Failure Modes

**Validated by expert debate** ([source](../research/memory-prompt-architecture-debate.md)):

| # | Mode | Likelihood | Impact | Current Protection | Gap |
|---|------|-----------|--------|-------------------|-----|
| F1 | SQLite WAL accumulation | HIGH (3/5) | CRITICAL | WAL checkpoint at 200 pages | No monitoring; breaks at ~2K tasks/day |
| F3 | Cache poisoning (wrong confidence) | MEDIUM (3/5) | CRITICAL | tier_reliability stored | Not checked during skill retrieval |
| F5 | Prompt injection at storage layer | LOW (1/5) | MEDIUM | sanitizeForPrompt() applied on prompt path (`clean()` wraps all working memory fields) | Storage layer holds raw LLM strings; non-prompt consumers could access unsanitized content |
| F7 | Compaction data loss (if re-enabled) | LOW (1/5) | CRITICAL | CompactionLlm deprecated | No spec gate if someone re-enables |

**Project-specific risks** (not in debate — require load testing to validate):

| # | Mode | Likelihood | Impact | Current Protection | Gap |
|---|------|-----------|--------|-------------------|-----|
| F9 | VINYAN.md insider injection | MEDIUM (2/5) | HIGH | 50KB limit, human-authored | No git signature verification or checksum pinning |
| F10 | Oracle circuit breaker cascade | MEDIUM (2/5) | HIGH | Per-oracle breaker (3 failures/60s) | No oracle fallback registry; **no degradation alerting** — system silently weakens verification |
| F11 | Prompt token accumulation | HIGH (3/5) | MEDIUM | Bounded arrays (20+10+10+50) | No total token budget; normal operation ≈ 8.5K user prompt; Phase 2 cross-task → 12K+ |

### 9.2 Security Boundaries

| Vector | Current Protection | Remaining Gap |
|--------|-------------------|---------------|
| Goal injection | NFKC + zero-width + regex + base64 detection | Creative phrasing evades regex; no NLP matcher |
| VINYAN.md injection | Size cap (50KB), human-authored only | No checksum pin (`.vinyanlock`), no re-sanitization on load |
| Oracle verdict injection | Zod schema validation, subprocess isolation | No HMAC signature on verdicts; confidence field not tier-bounded |
| Cross-task leakage | sessionId filtering on fact queries | sessionId can be NULL; no runtime enforcement |
| Re-injected LLM output | `clean()` applied on prompt assembly path ✅ | Storage layer holds raw strings; non-prompt consumers have no sanitization gate |

### 9.3 Scale Bottleneck Ranking `[HYPOTHESIS — not stress-tested]`

| Order | Bottleneck | Breaks At | Lead Indicator |
|-------|-----------|-----------|----------------|
| 1st | World Graph unfiltered queries (G3) | ~10K facts without confidence floor | queryFacts() returns decayed/irrelevant facts; I/O + prompt bloat compound |
| 2nd | Prompt token accumulation (F11) | Normal operation (bounded arrays full) | User prompt p95 > 10K tokens |
| 3rd | SQLite WAL accumulation | ~2K tasks/day | WAL file > 50MB |
| 4th | In-process WorkingMemory backlog | ~5K tasks/hour | Heap growth linear with concurrency |
| 5th | Instruction loader I/O | ~10K worker spawns/day | Worker spawn latency p95 > 500ms |

> **Reordering rationale (from expert review):** WAL checkpoint at 200 pages handles typical loads. The real first bottleneck is queryFacts() returning all facts (including confidence=0.0) without floor filter — this compounds as both database I/O and prompt token waste. G3 fix addresses both dimensions.

---

## 10. Operational Metrics `[ASPIRATIONAL]`

### 10.1 Key Metrics (Production Dashboard) `[NOT IMPLEMENTED]`

> **Note:** No observability infrastructure exists yet. These are design targets for Phase 4.

| # | Metric | Type | Alert Threshold | Collection Point |
|---|--------|------|-----------------|------------------|
| 1 | **Fact count** | Gauge (0-50K) | ≥ 48K (96% cap) | `world-graph.ts:runRetention()` |
| 2 | **SQLite WAL size** | Gauge (bytes) | ≥ 100MB | `fs.statSync('.vinyan.db-wal')` |
| 3 | **Cache hit rate** | Gauge (0-100%) | < 20% (target 80%+) | Anthropic response headers |
| 4 | **System prompt size** | Histogram (tokens) | p95 > 20K | `assemblePrompt()` output |
| 5 | **Sanitization detections** | Counter (/min) | > 10/hour | `sanitizeForPrompt()` detections |
| 6 | **NULL sessionId queries** | Gauge (%) | > 0% | `WHERE session_id IS NULL` count |
| 7 | **Oracle failure rate** | Gauge (/min per oracle) | ≥ 1/min | `circuitBreaker.failureCount` |
| 8 | **Tokens per task** | Histogram (by level) | L1: >15K, L2: >50K | LLM provider `tokensUsed` |
| 9 | **Evidence chain orphans** | Gauge (count) | > 0 | `facts LEFT JOIN fact_evidence_files` |
| 10 | **Working memory evictions** | Counter (/hour) | > 100/hour | `memory:eviction_warning` events |

---

## 11. Implementation Plan

> **Phase ordering rationale:** Phase 1 delivers cost savings (cache). Phase 2 delivers evidence chain completeness (A3+A4+A5 compliance) — this is the **autonomy-critical phase** that enables cross-task learning. Phase 3 builds the section registry on top of Phase 2's evidence chain. Phase 4 hardens for production.
>
> **Schema coordination:** Phase 2's archive tables share `{ approach/pattern, verdict, confidence, timestamp, routing_level }` structure. Combine as single migration to prevent orphaned records.
> - `FailedFactArchive` → **World Graph DB** (knowledge about what failed — same lifecycle as facts)
> - `RejectedApproachesArchive` → **Vinyan DB** (operational history of attempts — same lifecycle as traces)
>
> **Phase 1 prerequisite:** Instrument `assemblePrompt()` to measure actual baseline token cost before projecting savings.

### Phase 1 — Cache Optimization (Week 1-2) `[STATUS: ~10% — CacheControl type exists, VINYAN.md in system prompt, TTL not wired]`

| Item | Files | Effort | Impact | Status |
|------|-------|--------|--------|--------|
| Instrument `assemblePrompt()` token cost | `prompt-assembler.ts` | 10 lines | Validate baseline for cost projections | `[DESIGNED]` |
| Move VINYAN.md from system to user message | `prompt-assembler.ts` | 40 lines | System cache becomes purely static, hit rate ~60%+ | `[DESIGNED]` |
| Add `CacheControl.ttl` enum: static/session/ephemeral | `types.ts`, `prompt-assembler.ts`, `anthropic-provider.ts` | 60 lines | Enable per-section TTL | `[DESIGNED]` |
| Wire TTL to Anthropic API cache_control | `anthropic-provider.ts` | 30 lines | Static sections get 1-hour cache | `[DESIGNED]` |

**Expected outcome:** 35-40% token cost reduction on cached prefix. No behavioral change.

### Phase 2 — Evidence Chain & Autonomy (Week 3-5) `[STATUS: DESIGNED — 5 gaps (G1-G5) + cross-task learning spec]`

> **This is the autonomy-critical phase.** G1+G2+G5 are blockers for cross-task learning (the property that makes Vinyan genuinely autonomous).

**Internal dependency ordering** (implement in this sequence):

```
G5 (failed verdict archive) ─────────────────────┐
G1 (oracle metadata) ──┬──► G3 (conf. floor) ──┬►│ Cross-task learning
G2 (eviction archive) ──┘   G4 (tier routing) ──┘ │
Storage sanitization ─────────────────────────┘ (independent)
```

| Step | Item | Depends On | Why |
|------|------|-----------|-----|
| 1 | G5 (failed verdict archive) | — | Unblocks cross-task serialization |
| 2 | G1 (oracle metadata in perception) | — | Unblocks G3, G4, Phase 3 |
| 3 | G2 (eviction archive) | — | Parallel with G1 |
| 4 | G3 (confidence floor) | G1 | Uses metadata G1 exposes |
| 5 | G4 (tier_reliability routing) | G1 | Consumes metadata from G1 |
| 6 | Cross-task learning | G5 + G2 | Needs both archive tables |
| 7 | Storage sanitization | — | Independent, anytime |

| Item | Files | Effort | Impact | Status |
|------|-------|--------|--------|--------|
| Extend PerceptualHierarchy.verifiedFacts to full Fact[] | `perception.ts`, `prompt-assembler.ts` | 60 lines | LLM sees oracle origin + confidence per fact (fixes G1) | `[DESIGNED]` |
| Add confidence floor filter in queryFacts() | `world-graph.ts` | 20 lines | Stale facts (< 0.6 for L1+, < 0.9 for L0) excluded (fixes G3) | `[DESIGNED]` |
| Archive evicted failed approaches | `working-memory.ts`, new SQLite table | 80 lines | Forensic trail preserved through eviction (fixes G2) | `[DESIGNED]` |
| Store failed oracle verdicts | `core-loop.ts`, new FailedFactArchive | 60 lines | Failed patterns visible to future tasks (fixes G5) | `[DESIGNED]` |
| Activate tier_reliability in routing | `risk-router.ts` | 50 lines | A5: tiered trust in routing decisions (fixes G4) | `[DESIGNED]` |
| Sanitize working memory at storage layer | `working-memory.ts` | 15 lines | Close non-prompt access to raw LLM output | `[DESIGNED]` |
| Cross-task failed-approach loading | `core-loop.ts`, `working-memory.ts` | 40 lines | Task B loads Task A's serialized failed approaches (24h TTL) | `[DESIGNED]` |

**Expected outcome:** Complete evidence chain from oracle to LLM. A3+A4+A5 compliance. Cross-task learning functional.

**Autonomy Readiness Criteria (ARC)** — Phase 2 → Phase 3 gate:

| Criterion | Metric | Target | How to Measure |
|-----------|--------|--------|---------------|
| Cross-task failure avoidance | Task B skips approach that A verified-failed (same file_hash) | ≥80% | Count loads where loaded approach NOT re-attempted |
| Evidence chain completeness | Facts in prompt carry full oracle metadata | 100% | Assert every `user_known_facts` entry has oracle name + confidence + tier |
| Tiered trust activation | Routing correlates with tier_reliability | Spearman ρ ≥ 0.3 | Over 50+ tasks |
| Failed approach persistence | Approaches surviving task boundary | ≥95% | `rejected_approaches` rows vs `recordFailedApproach()` calls |
| Confidence floor effectiveness | Zero below-floor facts in prompt | 0 violations | Assert at assembly time |

> All ARC criteria must pass on ≥50 task sample before Phase 3 greenlight.

### Phase 3 — Section Registry (Week 6-9) `[STATUS: DESIGNED — blocked on Phase 2.G1 (needs full Fact[] in PerceptualHierarchy)]`

| Item | Files | Effort | Impact | Status |
|------|-------|--------|--------|--------|
| Create PromptSectionRegistry | New: `prompt-section-registry.ts` | 150 lines | Composable prompt assembly (pattern from Claude Code) | `[DESIGNED]` |
| Register 12 built-in sections | New: section definitions | 200 lines | All current content as sections | `[DESIGNED]` |
| Refactor PromptAssembler to use registry | `prompt-assembler.ts` | -100 / +50 lines (net reduction) | Decoupled from content details | `[DESIGNED]` |
| Model adaptation: per-tier section treatment | New: `model-adaptation.ts` | 80 lines | Haiku/Sonnet/Opus get optimized prompts | `[ASPIRATIONAL]` |
| 2-tier instruction loading (user + project) | `instruction-loader.ts` | 80 lines | Start simple: T2 user + T3 project | `[DESIGNED]` |

**Expected outcome:** Section-based prompt system with model adaptation. Instruction loading starts at 2-tier (not 6-tier — see Appendix A).

> **Scope reduction from research:** Original plan proposed 6-tier hierarchical loading in 200 lines. Research shows Claude Code's "simple thing first" philosophy outperformed complex architectures. Start with 2-tier (user preferences + project VINYAN.md), expand to 6-tier only when empirical evidence shows multi-tier adds measurable value.

### Phase 4 — Production Hardening (Week 10-13) `[STATUS: ASPIRATIONAL]`

| Item | Files | Effort | Impact | Status |
|------|-------|--------|--------|--------|
| VINYAN.md checksum pinning (`.vinyanlock`) | New: lock file + validation | 60 lines | Insider injection prevention | `[ASPIRATIONAL]` |
| sessionId NOT NULL enforcement | `world-graph.ts` schema | 10 lines | Cross-task leakage prevention | `[DESIGNED]` |
| Oracle fallback registry | `oracle/registry.ts` | 100 lines | Circuit breaker cascade mitigation | `[ASPIRATIONAL]` |
| Production metrics dashboard (10 metrics) | `observability/` | 150 lines | Proactive failure detection | `[ASPIRATIONAL]` |
| Expand to 6-tier instruction loading (if needed) | `instruction-hierarchy.ts` | 120 lines | Add T1, T4, T5, T6 tiers based on empirical need | `[ASPIRATIONAL]` |

**Expected outcome:** Production-ready memory & prompt system with monitoring and security hardening.

> **Phase gate:** After Phase 2, re-audit before Phase 3 greenlight. After Phase 3, validate model adaptation matrix empirically before Phase 4 expansion to 6-tier instructions.

---

## 12. Decision Log

| # | Decision | Rationale | Alternatives Rejected | Evidence |
|---|----------|-----------|----------------------|----------|
| D1 | VINYAN.md moves to user message | System cache becomes static; Claude Code validated this pattern | Keep in system prompt (lower cache hit rate) | [claude-code-deep-dive.md](../research/claude-code-deep-dive.md) §2 — SUPPORTED |
| D2 | Section-based registry (adopt Claude Code pattern) | Enables per-section caching, model adaptation, progressive disclosure | Template string composition (simpler but uncacheable) | [claude-code-deep-dive.md](../research/claude-code-deep-dive.md) §4 — SUPPORTED |
| D3 | Structure-preserve compaction over LLM summarization | LLM summarizer is injection surface (Red Team rated CATASTROPHIC); deterministic is A1-compliant | LLM summarizer (higher compression ratio but lossy + unsafe) | [debate §5](../research/memory-prompt-architecture-debate.md) — SUPPORTED |
| D4 | Human-authored-only instruction memory | Simplest safe path; Red Team's condition: safe only if human-authored-only. Oracle-verified promotion deferred to Phase 4+ when ≥100 traces available (Purist's upgrade path) | LLM-proposed instructions with oracle gate (A1-compliant but complex) | [debate §3.1](../research/memory-prompt-architecture-debate.md) — SUPPORTED (3/4 agree) |
| D5 | Confidence floor filter at query time, not at storage | Storage captures raw oracle signal; filtering at read time allows level-dependent thresholds | Filter at write time (loses information; can't lower threshold later) | Architecture principle — no external evidence |
| D6 | 3-tier cache (static/session/ephemeral) | Maps to Anthropic pricing tiers; optimal cost-savings/complexity ratio | 2-tier (less granular), 5-tier (over-engineered for current scale) | [claude-code-deep-dive.md](../research/claude-code-deep-dive.md) §3 — PARTIALLY SUPPORTED |
| D7 | Eviction archives to SQLite, not World Graph | Failed approaches are meta-data about attempts, not facts about the world. Different lifecycle and query patterns. | Store in World Graph (conflates fact types) | Architecture principle — no external evidence |
| D8 | Start with 2-tier instructions, not 6-tier | Research shows "simple thing first" outperformed complex architectures at production scale. Defer T1/T4/T5/T6 until empirical evidence shows they add value. | 6-tier from day one (speculative complexity) | [memory-and-prompt-architecture.md](../research/memory-and-prompt-architecture.md) §1.3 — SUPPORTED |
| D9 | No vector embeddings for fact retrieval | Content-addressed hash lookup + agentic search production-validated for code. **Revisit trigger:** if facts > 50K, keyword-based queryFacts() may need indexing strategy. | RAG/embedding-based retrieval (slower, less precise for code) | [memory-and-prompt-architecture.md](../research/memory-and-prompt-architecture.md) §1.2 — SUPPORTED |
| D10 | Move G4 (tier_reliability activation) from Phase 4 to Phase 2 | A5 compliance is autonomy-critical; without it, routing ignores evidence quality tier | Keep in Phase 4 (defers A5 compliance by months) | [debate P0](../research/memory-prompt-architecture-debate.md) — SUPPORTED |

---

## Appendix A: Instruction Memory Evolution Path

### Current (v1): Single File, 50KB Max `[IMPLEMENTED]`

```
VINYAN.md → loadInstructionMemory() → SHA-256 cache → inject in system prompt
```

> **Research warning:** CLAUDE.md compliance drops sharply above 200 lines (92-96% instruction following → 71%). Current 50KB limit (≈25K lines) risks compliance cliff. Mitigation: keep VINYAN.md under 200 lines; decompose larger instruction sets across tiers in v2. Source: [memory-and-prompt-architecture.md](../research/memory-and-prompt-architecture.md) §1.3.

### Target (v2): 2-Tier Loading (Phase 3) `[DESIGNED]`

```
T2: User       (~/.vinyan/preferences.md — cross-project)
T3: Project    (./VINYAN.md — project-level)
```

Later tier (T3) overrides earlier (T2) on conflict. Start simple — expand only when empirical evidence shows additional tiers add measurable value (D8).

### Extension path (v2+): 6-Tier Loading (Phase 4+) `[ASPIRATIONAL — no empirical validation]`

```
T1: Managed    (@vinyan/core-instructions — vendor defaults)
T2: User       (~/.vinyan/preferences.md — cross-project)
T3: Project    (./VINYAN.md — project-level)
T4: Local      (./.vinyan-components.md — directory-scoped)
T5: Auto       (Framework detection → scoped rules)
T6: Model      (Per-model overrides: haiku=concise, opus=detailed)
```

**Open questions** (must answer before implementing T1/T4/T5/T6):
- Binding mechanism: How does code detect each tier? File existence check? npm registry? Framework sniff?
- Merge conflict: T6 (model-specific) overrides T3 (project). What if they conflict on safety rules?
- Security: Is T1 trusted? What if malicious npm package provides T1 core-instructions?
- Scope: Applies to prompt assembly only, or also oracle manifest, skip rules, other subsystems?

### Target (v3): Oracle-Verified Promotion (Phase 4+) `[ASPIRATIONAL]`

**Trigger:** ≥100 Sleep Cycle traces available.
**Flow:** Sleep Cycle discovers pattern → proposes instruction → oracle gate verifies (≥0.9 pass rate on 10-task holdout) → orchestrator commits to T5.

---

## Appendix B: Related Research

| Document | Relevance |
|----------|-----------|
| [memory-and-prompt-architecture.md](../research/memory-and-prompt-architecture.md) | Research landscape: taxonomy, production systems, design principles |
| [claude-code-deep-dive.md](../research/claude-code-deep-dive.md) | Source-level analysis of Claude Code prompt architecture |
| [memory-prompt-architecture-debate.md](../research/memory-prompt-architecture-debate.md) | 4-expert consensus: P0-P3 priorities, failure modes, MVA |
| [world-graph-architecture.md](../research/world-graph-architecture.md) | World Graph design: decay models, cascade invalidation |
| [formal-uncertainty-frameworks.md](../research/formal-uncertainty-frameworks.md) | Subjective logic, belief intervals for confidence modeling |
| [design-pipeline-confidence.md](../research/design-pipeline-confidence.md) | Confidence propagation through verification pipeline |

---

## Appendix C: Evidence Quality Assessment

> **Audit methodology:** 3-stream Expert Agent brainstorm (Epistemic Architect, Research Analyst, Implementation Realist) cross-referenced every major claim against source code and 3 research documents.

### Overall Quality Score: 56% well-supported

| Category | Well-Supported | Partially | Unsupported | Contradicted |
|----------|----------------|-----------|-------------|-------------|
| Cache / Token economics | 2 | 2 | 0 | 0 |
| Prompt architecture | 2 | 1 | 0 | 1 |
| Memory design | 2 | 1 | 1 | 0 |
| Failure modes | 3 | 1 | 2 | 0 |
| Operational metrics | 0 | 0 | 3 | 0 |

### Sections by Evidence Strength

| Rank | Section | Confidence | Reason |
|------|---------|-----------|--------|
| **Strongest** | §1.1 Memory Substrates | 90% | Aligns with taxonomy (Zhang et al. 2024), validated in Mem0/MemGPT |
| | §4 Architectural Gaps | 85% | Debate consensus; verified against source code |
| | §5.3 VINYAN.md in user messages | 95% | Direct Claude Code production validation |
| | §8 Evidence Flow | 90% | Red Team consensus; deterministic flow |
| **Weakest** | §7 Model-Aware Adaptation | 35% | Conceptually sound; specific matrix unvalidated |
| | Appendix A v2+ (6-tier) | 40% | Inspired by Claude Code but not production-tested |
| | §9.1 F9-F10 | 50% | Threat model exists but not empirically triggered |
| | §10 Metrics | 45% | Dashboard is hypothesis, no research validation |
| | §6.3 Cost Projections | 60% | Math is sound; baseline unvalidated |

### Key Contradiction Fixed

**§5 was labeled "Innovation" but section-based prompt assembly already runs in Claude Code production.** Corrected to "Validated Pattern" with attribution.

### Corrections Applied (Revision 2 — flow/journey audit)

| Finding | Section | Correction |
|---------|---------|------------|
| §2.1 lifecycle oversimplified — missing evolution rules, ε-exploration, multi-trace recording | §2.1 | Expanded step ② with evolution rules + ε-exploration; step ③ with commit/storeFact separation, 6 trace types; step ④ with SessionStore snapshot + SkillManager feedback |
| commitArtifacts ≠ storeFact — doc conflated filesystem write with World Graph storage | §2.1, §4.1 | Separated: commitArtifacts writes filesystem; storeFact is separate with confidence derivation (MIN oracle) |
| SessionStore not documented — enables session recovery with working_memory_json | §2.3, §2.4 | Added SessionStore row + new §2.4 Session Recovery Flow |
| SelfModel described as using traces but label ambiguous — CalibratedSelfModel is fully implemented | §2.2 | Updated cross-task diagram: CalibratedSelfModel [IMPLEMENTED] with per-task-type EMA details |
| ~10 persistence stores missing from doc — only 4 "substrates" acknowledged | §1.1 | Added note listing SessionStore, OracleAccuracy/Profile, PredictionLedger, SkillStore/RuleStore |
| 6 data flows missing from coupling map | §3.1 | Added: CalibratedSelfModel↔CoreLoop, TraceStore→SelfModel, SessionManager→SessionStore, CoreLoop→SkillManager, ForwardPredictor→CoreLoop, OracleRunner→OracleAccuracyStore |
| TraceCollector records 6 trace types per task, not 1 | §3.1 | Updated description: "Per retry attempt (6 trace types)" |
| Oracle manifest token estimate ~250 was high | §5.2 | Corrected to ~120 (verified from buildOracleManifest() output) |
| §4.2 missing confidence derivation detail | §4.2 | Added: computeFactConfidence = MIN oracle, tier_reliability derived from confidence thresholds, decay_model from temporal context |
| WorkingMemory scope unclear — carries across retries AND escalation levels | §2.1 | Added explicit note: "single instance per task — never reset between retries or level changes" |

### Research Insights Incorporated

| Insight | Source | Action Taken |
|---------|--------|-------------|
| "Simple thing first" philosophy | [research §1.3](../research/memory-and-prompt-architecture.md) | D8: Start with 2-tier instructions, not 6-tier |
| CLAUDE.md compliance cliff (>200 lines → 71%) | [research §1.3](../research/memory-and-prompt-architecture.md) | Warning added to Appendix A v1 |
| Agentic search beats embeddings | [research §1.2](../research/memory-and-prompt-architecture.md) | D9: Explicit no-RAG decision |
| Compaction amnesia is production-real | [research §5.3](../research/memory-and-prompt-architecture.md) | Cross-task learning protocol added (§2.2a) |
| Red Team's condition on human-authored-only | [debate §3.1](../research/memory-prompt-architecture-debate.md) | Acknowledged in §1.1 footnote and D4 |
