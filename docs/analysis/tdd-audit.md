# Vinyan TDD Audit — ENS Design Review

> **Document boundary**: เอกสารนี้เป็นเจ้าของ audit findings + action items สำหรับ TDD
> สำหรับ TDD spec → [tdd.md](../spec/tdd.md), concept → [concept.md](../foundation/concept.md), gap analysis → [gap-analysis.md](gap-analysis.md)
>
> **Audit date**: March 2026 | **Score: 85/100** | **Status: 🟢 Minor Items Remaining**
>
> **Update (March 29):** ENS identity redesign completed — TDD no longer frames Vinyan as a plugin. Thesis statement added (§1), section renames (§3 ECP Protocol, §4 Reasoning Engine Framework, §8 Host Integration Adapter), Phase 1 extension notes (§4–§7), and §16–§19 new sections close the Phase 1 architecture gap. Score: 78 → 85.

---

## 1. Executive Summary

Phase 0 implementation solid — 253 tests pass, interfaces match TDD spec, Epistemic Separation (A1) และ Content-Addressed Truth (A4) ดีที่สุดในตลาด AI agent ปัจจุบัน

**จุดแข็งหลัก:**
- Security & Guardrails (88/100) — prompt injection defense 70+ stress tests, 0% FP
- Implementation Readiness (90/100) — algorithm-level spec ที่ implement ได้ทันที
- A1/A4/A5/A6 axioms proven ใน Phase 0

**จุดอ่อนหลัก:**
- NFR & Observability (62/100) — ไม่มี latency targets, monitoring, disaster recovery
- ENS richness gap — TDD deliver binary verdicts แต่ concept promise confidence + evidence chains + "I don't know"
- Phase 0→1 transition — ไม่มี migration spec จาก hook-based → standalone Orchestrator

---

## 2. Score Breakdown by Dimension

| Dimension | Score | สรุปสั้น |
|-----------|:-----:|----------|
| Architecture & Structure | 85 → 90 | Axiom-traced design, ENS thesis statement, Orchestrator diagram, Phase 1 extension notes |
| Data Storage | 80 | Content-addressed ถูกต้อง, ขาด retention + capacity plan |
| API & Communication | 82 → 85 | ECP reframed as protocol (not just transport), circuit breaker added |
| Security & Compliance | 88 | ดีที่สุด — Oracle independence, production boundary, guardrails |
| NFR & Observability | 62 | อ่อนที่สุด — ไม่มี SLA, monitoring, DR |
| Implementation Readiness | 90 → 92 | Phase 0 implemented ครบ, 253 tests pass, §16–§19 Phase 1 specs added |

---

## 3. Findings — Architecture

### 3.1 World Graph เป็น Single Point of Failure

**ปัญหา:** `.vinyan/world.db` (SQLite single file) ไม่มี replication — corrupt = สูญเสีย verified facts ทั้งหมด

**Impact:** Long-running projects สูญเสีย knowledge base ถ้า disk fail หรือ concurrent write corruption

**Recommendation:** เพิ่ม periodic backup strategy + integrity check on startup

### 3.2 Phase 0→1 Architecture Cliff

**ปัญหา:** Phase 0 = host bridge (Oracle Gate inside OpenClaw), Phase 1 = standalone Orchestrator process — ไม่มี incremental migration path ระบุใน TDD

**Status: 🟡 Partially addressed** — §16–§19 เพิ่มแล้ว (Orchestrator, LLM Generator, Tool Execution, MCP Interface), §4–§7 มี Phase 1 extension notes แล้ว. ยังขาด formal migration spec.

**Impact:** Phase 1 อาจต้อง redesign components ที่ Phase 0 สร้างไว้แล้ว

**Recommendation:** เขียน Migration Spec ระบุ: อะไร reuse ตรง, อะไร wrap/adapt, breaking changes, backward compat

### 3.3 Oracle Conflict Resolution ยัง Thin

**ปัญหา:** `any-fail = block` (§4) เป็น conservative simplification — ไม่มี data collection สำหรับ false positive analysis

**Impact:** ไม่มี empirical evidence สำหรับ design Phase 1 weighted conflict resolution

**Recommendation:** เก็บ `blocked_but_later_succeeded` metric ใน session log ตั้งแต่ Phase 0

---

## 4. Findings — Data

### 4.1 ไม่มี World Graph Retention Policy

**ปัญหา:** facts table grow indefinitely — ไม่มี cleanup ใน §5

**Impact:** SQLite performance degradation ที่ scale (10K+ facts)

**Recommendation:** เพิ่ม configurable retention: ลบ facts เก่ากว่า N sessions หรือ N days

### 4.2 ไม่มี Capacity Model

**ปัญหา:** ไม่มี projection ว่า World Graph รองรับกี่ facts/files ก่อน performance degrade

**Impact:** ไม่รู้ limits → production surprise

### 4.3 Phase 1 Concurrent Write ยัง Open

**ปัญหา:** §15 Q2 acknowledge "race conditions if multiple writers" แต่ไม่มี proposed solution

**Impact:** Phase 1 multi-worker จะ hit concurrency issue ทันที

---

## 5. Findings — API & Communication

### 5.1 ECP ไม่มี Protocol Versioning

**ปัญหา:** `VinyanConfig.version: 1` แต่ protocol format ไม่มี version field — Phase 1 เปลี่ยน OracleVerdict shape จะ break Phase 0 oracles silently

**Recommendation:** เพิ่ม `protocolVersion` field ใน request/response

### 5.2 ไม่มี Resilience Patterns สำหรับ Oracle Invocation

**ปัญหา:** oracle dispatch ไม่มี circuit breaker, retry, rate limit — crashing oracle = performance drain ทุก call

**Recommendation:** Phase 0 ใส่ simple circuit breaker (N consecutive failures → disable oracle for M seconds)

### 5.3 Error Communication เป็น String-Only

**ปัญหา:** `OracleVerdict.reason?: string` — Phase 1 ต้อง programmatic error handling จะทำไม่ได้

**Recommendation:** เพิ่ม `errorCode?: 'TIMEOUT' | 'PARSE_ERROR' | 'TYPE_MISMATCH' | 'SYMBOL_NOT_FOUND'`

---

## 6. Findings — Security

### 6.1 Regex Injection Defense ไม่มี Update Mechanism

**ปัญหา:** 20 patterns hardcoded — token splitting, Unicode homoglyphs, novel LLM patterns จะ evade

**Impact:** False sense of security หลัง Phase 0 launch

**Recommendation:** แยก patterns เป็น configurable list ที่ update ได้โดยไม่ต้อง rebuild

### 6.2 Session Logs ไม่มี Sanitization

**ปัญหา:** JSONL logs บันทึก full `GateRequest` params — อาจมี API keys, credentials ใน code content

**Recommendation:** เพิ่ม sensitive content filter ก่อน log write

### 6.3 `sanitizeWorkerInput()` อาจ Corrupt Legitimate Code

**ปัญหา:** regex replace `[FILTERED]` จะ corrupt code ที่มี string matching pattern ตามธรรมชาติ (เช่น test file ที่มี "you are now")

**Recommendation:** เพิ่ม context-awareness — sanitize เฉพาะ user-facing content, ไม่ sanitize code artifacts

---

## 7. Findings — NFR & Observability (จุดอ่อนที่สุด)

### 7.1 ไม่มี Performance Targets

**ปัญหา:** ไม่มี latency/throughput targets ใดๆ — gate check + oracle round overhead เท่าไหร่จึง acceptable?

**Impact:** ถ้า >2s per tool call, UX จะไม่ viable

**Recommendation:** กำหนด p50 ≤ 500ms, p99 ≤ 2s สำหรับ full gate cycle

### 7.2 ไม่มี Runtime Monitoring

**ปัญหา:** มีแค่ JSONL session logs + offline analyzer — ไม่มี real-time metrics, alerting

**Recommendation:** Phase 0 minimal: เก็บ oracle latency histogram + block rate counter

### 7.3 ไม่มี Disaster Recovery Plan

**ปัญหา:** World Graph corruption, session log loss — ไม่มี RPO/RTO targets

**Recommendation:** กำหนด RPO (max data loss) + backup cadence

---

## 8. ENS Axiom Coverage — Bird's Eye View

ตารางนี้แสดง axiom-level delivery status — ไม่ใช่ per-component findings แต่เป็น **systemic view ว่า ENS vision ถูก deliver แค่ไหน**

### 8.1 สิ่งที่ TDD Deliver ได้ดีเยี่ยม

| Axiom | ENS Quality | Evidence |
|:---:|---|---|
| **A1** Epistemic Separation | 🟢 **ดีที่สุดในตลาด** | Oracle verify artifacts จริง ไม่ใช่ worker claims; process isolation; ไม่มี framework อื่นมีสิ่งนี้ |
| **A4** Content-Addressed Truth | 🟢 **ถูกต้อง** | SHA-256 hash binding + cascade invalidation ป้องกัน stale knowledge ได้ deterministic |
| **A5** Tiered Trust | 🟢 **มี foundation** | deterministic > heuristic > probabilistic; oracle config ระบุ tier |
| **A6** Zero-Trust Execution | 🟢 **ครบถ้วน** | fail-closed defaults, production boundary, irreversibility scoring, guardrails |

### 8.2 สิ่งที่ "มี concept แต่ TDD spec ยัง thin"

| Aspect | Concept Promise | TDD Reality | Gap |
|--------|----------------|-------------|-----|
| **A2: First-Class "I Don't Know"** | `ECPResponse.type: 'unknown'` triggers uncertainty reduction, targeted investigation, human delegation | Binary `verified: boolean` เท่านั้น | ENS core differentiator ยังไม่ manifest |
| **A7: Prediction Error as Learning** | Self-Model predict ก่อน execute → delta เป็น learning signal | Phase 0 ไม่มี learning loop ใดๆ | ENS จะเป็น reactive system จนกว่า Phase 1 |
| **ECP Richness** | `deliberation_request`, `temporal_context`, `contradiction.resolution_path` | ไม่มีแม้ placeholder interfaces | Concept ambitious กว่า TDD อย่างมีนัย |
| **Contradiction Resolution** | 5-step deterministic tree (§3.2) | `any-fail = block` one-liner | ไม่มี "reasoning about disagreement" |
| **Working Memory** | 4 components: failedApproaches, activeHypotheses, unresolvedUncertainties, scopedFacts | inject แค่ verified facts + failed approaches | ครึ่งเดียว (2/4) |

### 8.3 Critical ENS Gaps ที่ TDD ไม่ Address

Gaps เหล่านี้เป็น **systemic** — ไม่ใช่แค่ component-level finding แต่กระทบ ENS thesis ทั้งหมด

#### Gap A: ไม่มี Continuous Quality Signal

Oracle verdicts เป็น binary pass/fail → Evolution Engine (Phase 2+) ต้องการ continuous gradient

- "approach A ดีกว่า B ได้ 30%" ตอบไม่ได้ — ได้แค่ "A pass, B fail"
- System 2 selection: ทุก branch ผ่าน Oracle → เลือกตัวไหน? ไม่มี signal
- `QualityScore` interface defined แต่ `computeComposite()` ยัง Phase 1 → **Phase 0 collect data ที่มี signal ไม่พอ** สำหรับ Phase 1 calibration

**Why it matters for ENS:** A7 (Prediction Error as Learning) ต้องการ gradient ไม่ใช่ binary — ถ้า reward signal ห่วย agent จะ converge ไปที่ behavior ที่ห่วยด้วย

#### Gap B: ไม่มี Skill Formation Path

Evolution Engine สร้าง **rules** (defensive: "เมื่อเจอ pattern X ให้ escalate") แต่ **ไม่สร้าง skills** (productive: "วิธี implement JWT auth ที่ดี คือ...")

| Rules (Vinyan มี) | Skills (ENS ต้องการ) |
|---|---|
| "Don't do X" | "How to do Y well" |
| Defensive — prevent bad | Productive — enable good |
| Binary triggers | Parametric, context-dependent |
| Grow linearly | Compress exponentially |

TDD ไม่มีแม้ schema placeholder สำหรับ `skill_templates` table — migration `2` เป็นแค่ comment

**Why it matters for ENS:** Intelligence = compression of experience เป็น reusable abstractions ถ้ามีแค่ rules 10,000 ข้อที่ไม่ compress เป็น skills → system ไม่ scale

#### Gap C: Cross-Domain Limitation Undocumented

Oracles ทั้งหมดเป็น **code-specific** (AST, tsc, test runner, lint) — สำหรับ non-code domains ไม่มี deterministic oracle → ต้องใช้ LLM-as-judge ซึ่ง **เป็นปัญหาเดียวกับที่ Vinyan วิจารณ์ framework อื่น**

TDD ไม่ address ว่า Oracle framework จะ extend to non-code domains อย่างไร — Concept §1 scope note acknowledge แต่ TDD ไม่ document limitation หรือ extension path

**Why it matters for ENS:** "Epistemic Nervous System for AI Systems" claim broad scope — แต่ TDD deliver แค่ "Epistemic Nervous System for Code"

---

## 9. Critical Findings — Blockers

สิ่งที่ **ต้องแก้ก่อน** ถึงจะ claim Phase 0 success ได้ตามเกณฑ์ที่ TDD §13 ตั้งไว้

### 9.1 ไม่มี Performance Model → ไม่รู้ว่า UX viable ไหม

§13 มี success criteria (≥30% catch rate, ≥20% token reduction) แต่ **ไม่มี latency budget** — Oracle gate เพิ่ม overhead ทุก tool call

**ถ้า oracle gate ช้า >2s per tool call → developer จะ disable Vinyan** — success criteria อื่นไม่มีความหมาย

→ **Must add:** p50/p99 latency targets ใน §13 ก่อน benchmark

### 9.2 ไม่มี World Graph Retention → Long-running Projects จะ Degrade

§5 cascade invalidation ดี แต่ **ไม่มี cleanup** — facts จาก deleted files, old sessions, stale oracles สะสมไม่มีขีดจำกัด

SQLite performance degrades ที่ scale → projects ที่ใช้ Vinyan นานๆ จะช้าขึ้นเรื่อยๆ โดยไม่มี mitigation

→ **Must add:** configurable retention policy ใน §5

---

## 10. Risks & Trade-offs

ไม่ใช่สิ่งที่ "ผิด" แต่เป็น design decisions ที่ **มี cost ซ่อนอยู่** — ต้อง monitor

| Risk | Trade-off | ต้องตั้ง Tripwire เมื่อ |
|------|-----------|----------------------|
| **Phase 0→1 Architecture Cliff** | Host bridge → standalone Orchestrator = significant interface change, reusable core components (Oracle, World Graph, Risk Router) | เมื่อเริ่ม Phase 1 design — ถ้าพบว่า >50% Phase 0 code ต้อง rewrite ให้ re-evaluate strategy |
| **Static Regex Injection Defense** | Fast + zero FP ตอนนี้ แต่ attack vectors evolve → false sense of security | เมื่อ first evasion detected ใน production — ต้องมี update pipeline พร้อม |
| **Binary Verdicts = Thin Learning Signal** | Phase 0 collect แค่ pass/fail → Phase 1 Self-Model ต้องการ richer data | เมื่อ Phase 1 Self-Model accuracy < 50% after 100 sessions → Phase 0 data ไม่พอ |
| **OpenClaw Host Dependency** | §8 host bridge API ไม่ specified → OpenClaw breaking change = bridge broken (Phase 0 only, eliminated in Phase 1) | เมื่อ OpenClaw release major version — ต้อง regression test Vinyan hooks ทันที |
| **any-fail = block ไม่มี FP tracking** | Conservative ดีสำหรับ safety แต่ over-blocking ทำลาย adoption | เมื่อ block rate > 20% ของ mutations — ถ้า developer ไม่ trust gate จะ disable มัน |

---

## 11. Actionable Recommendations — How to Fix

Technical solutions (ไม่ใช่แค่ "ต้องทำอะไร" แต่ **"ทำยังไง"**)

### R1: Performance Budget — เพิ่มใน §13

```
Gate Cycle Latency Budget:
  p50 ≤ 500ms (ไม่รู้สึกว่าช้า)
  p99 ≤ 2,000ms (ยอมรับได้สำหรับ complex files)
  
Per-Oracle Budget:
  ast-oracle:  p99 ≤ 200ms (tree-sitter = fast)
  type-oracle: p99 ≤ 1,500ms (tsc on full project)
  dep-oracle:  p99 ≤ 500ms (BFS traversal)
```

### R2: World Graph Retention — เพิ่มใน §5

```sql
-- Configurable retention: ลบ facts เก่ากว่า N days
DELETE FROM facts 
WHERE verified_at < (strftime('%s','now') - :max_age_seconds) * 1000
  AND session_id NOT IN (
    SELECT DISTINCT session_id FROM facts 
    ORDER BY verified_at DESC LIMIT :keep_sessions
  );
```

Config: `worldGraph.retention.maxAgeDays: 30`, `worldGraph.retention.keepLastSessions: 10`

### R3: OracleVerdict `type` + `errorCode` — แก้ §2

```typescript
interface OracleVerdict {
  verified: boolean;
  type: 'known' | 'unknown';                    // ← NEW: enable A2
  errorCode?: 'TIMEOUT' | 'PARSE_ERROR'         // ← NEW: programmatic handling
    | 'TYPE_MISMATCH' | 'SYMBOL_NOT_FOUND' 
    | 'ORACLE_CRASH';
  evidence: Evidence[];
  fileHashes: Record<string, string>;
  reason?: string;
  oracleName?: string;
  duration_ms: number;
  qualityScore?: QualityScore;                   // ← Populate 2 dims in Phase 0
}
```

### R4: ECP Protocol Versioning — แก้ §3

```json
// Request
{ "protocolVersion": 1, "target": "...", "pattern": "...", "workspace": "..." }

// Response  
{ "protocolVersion": 1, "verified": true, "type": "known", ... }
```

Oracle runner: ถ้า response `protocolVersion` ไม่ match → log warning + treat as compatible (forward compat)

### R5: Oracle Circuit Breaker — เพิ่มใน §4

```typescript
interface OracleCircuitBreaker {
  failureCount: number;
  lastFailure: number;
  state: 'closed' | 'open' | 'half-open';
}
// N consecutive failures (default: 3) → open for M seconds (default: 60)
// half-open: ลอง 1 request → success = close, fail = re-open
```

### R6: Injection Patterns → Config — แก้ §7

ย้าย patterns จาก hardcoded array → `vinyan.json` section:

```jsonc
{
  "guardrails": {
    "injectionPatterns": "default",          // "default" = built-in 20 patterns
    "customPatterns": [                       // เพิ่มเติมได้
      "CUSTOM_EVASION_PATTERN"
    ],
    "disabledPatterns": []                    // ปิด FP ได้
  }
}
```

---

## 12. Findings — ENS Vision Details

### 12.1 "I Don't Know" ยังไม่ Deliver

**ปัญหา:** Concept §2.2 promise `type: 'unknown'` เป็น semantically meaningful state ที่ trigger orchestrator behaviors — TDD Phase 0 เป็น binary `verified: boolean` เท่านั้น

**Impact:** ENS core differentiator (A2 axiom) ยังไม่ manifest ใน Phase 0

**Recommendation:** เพิ่ม `type: 'known' | 'unknown'` ใน OracleVerdict ตั้งแต่ Phase 0 (→ R3)

### 12.2 Learning Signal ไม่พอสำหรับ Phase 1 Self-Model

**ปัญหา:** Phase 0 เก็บแค่ binary pass/fail — Phase 1 Self-Model ต้องการ continuous gradient จาก QualityScore

**Impact:** Phase 1 cold-start จะ cold กว่าที่คาด เพราะ Phase 0 data มี signal dimension เดียว

**Recommendation:** เก็บ `QualityScore` (2 dimensions: architecturalCompliance + efficiency) ตั้งแต่ Phase 0 (→ R3)

### 12.3 ECP Richness Gap

**ปัญหา:** Concept มี `deliberation_request`, `temporal_context`, `contradiction.resolution_path` — TDD ไม่ spec fields เหล่านี้เลยแม้แต่ placeholder

**Impact:** Concept ambitious กว่า TDD อย่างมีนัย — Phase 1 ต้อง bridge gap ใหญ่

### 12.4 Working Memory Implement ครึ่งเดียว

**ปัญหา:** Concept §9.4 ระบุ 4 components — TDD §8 `handleBeforePromptBuild` inject แค่ verified facts + failed approaches (2 จาก 4)

---

## 13. Action Items — ปรับเข้า Design ทันที (Phase 0)

Items เหล่านี้ไม่ต้องรอ Phase 1 — แก้ใน TDD + implementation ปัจจุบันได้เลย

> **Scope filter applied**: Deep thinking review (March 2026) ตัด 4 items ที่เป็น scope creep ออก → ย้ายไป §14 Phase 1 พร้อมเหตุผล

- [x] **§13: เพิ่ม Performance Budget** — p50/p99 latency targets สำหรับ gate cycle + per-oracle budget table (→ §9.1, R1) ✅ *added to TDD*
- [x] **§5: เพิ่ม World Graph Retention Policy** — configurable cleanup: maxAgeDays / keepLastSessions / maxFactCount (→ §9.2, R2) ✅ *added to TDD*
- [x] **§2: เพิ่ม `type` + `errorCode` ใน OracleVerdict** — `type: 'known' | 'unknown'` สำหรับ A2, `errorCode` สำหรับ programmatic handling (→ §8.2, §12.1, R3) ✅ *added to TDD*
- [x] **§4: เก็บ QualityScore 2 dimensions ตั้งแต่ Phase 0** — architecturalCompliance + efficiency → seed Phase 1 Self-Model (→ §8.3 Gap A, §12.2) ✅ *clarified in TDD (already in spec but responsibility note added)*
- [x] **§4: เพิ่ม Oracle Circuit Breaker** — N consecutive failures → disable oracle ชั่วคราว (→ Finding 5.2, R5) ✅ *added to TDD*
- [x] **§4: เก็บ False Positive Metric** — `blocked_verdicts` + `mutation_hash` ใน session log → target ≥50 FP candidates ก่อน Phase 1 (→ Finding 3.3) ✅ *added to TDD*

---

## 14. Action Items — Phase 1 Checklist

Items เหล่านี้ต้องการ Orchestrator หรือ design ที่ยังไม่มี — plan ไว้สำหรับ Phase 1

**Moved from Phase 0** (scope creep — ไม่กระทบ Phase 0 success criteria):
- [ ] **ECP Protocol Versioning** — `protocolVersion: number` ใน request/response (→ Finding 5.1, R4) — *Phase 0→1 architecture cliff จะ redesign protocol ทั้งหมด → versioning ตอนนี้จะ obsolete*
- [ ] **Injection Patterns as Config** — ย้ายจาก hardcoded → configurable (→ Finding 6.1, R6) — *20 patterns ทำงานได้ดีสำหรับ POC scope, maintainability concern ยังไม่เร่ง*
- [ ] **Session Log Sanitization** — filter sensitive content ก่อน JSONL write (→ Finding 6.2) — *Phase 0 = local tool, logs อยู่บนเครื่อง developer → security risk ต่ำ*
- [ ] **Test Oracle + Lint Oracle** — complete 5/5 oracles ตาม TDD §4 spec — *TDD ระบุเป็น Phase 0 แต่ implementation defer ไว้ ⚠️ ต้อง revise TDD scope ให้ตรงกัน: ระบุ 3/5 เป็น Phase 0, 5/5 เป็น Phase 1*

**Original Phase 1 items:**
- [ ] **เขียน Phase 0→1 Migration Spec** — component mapping: reuse / wrap / rewrite + backward compat strategy (→ Finding 3.2)
- [ ] **Implement Weighted Conflict Resolution** — ใช้ false positive data จาก Phase 0 design tiered voting (→ Finding 3.3)
- [ ] **ECP Response Type Full Spectrum** — ขยาย `type` จาก `'known' | 'unknown'` เป็น `'known' | 'unknown' | 'uncertain' | 'contradictory'` (→ §8.2, §12.1)
- [ ] **ECP Richness: Deliberation + Temporal** — เพิ่ม `deliberation_request`, `temporal_context` fields ตาม concept §2.2 (→ §8.2, §12.3)
- [ ] **Working Memory 4 Components** — activeHypotheses + unresolvedUncertainties เพิ่มจาก 2/4 เป็น 4/4 (→ §8.2, §12.4)
- [ ] **Skill Formation Schema** — เพิ่ม `skill_templates` table + trace-to-skill extraction pipeline (→ §8.3 Gap B)
- [ ] **Cross-Domain Oracle Extension Guide** — document pluggable Oracle interface for non-code domains (→ §8.3 Gap C)
- [ ] **World Graph Concurrent Write Strategy** — writer queue / WAL + single-writer enforcement (→ Finding 4.3)
- [ ] **World Graph Capacity Model** — benchmark SQLite ที่ 10K/50K/100K facts, document limits (→ Finding 4.2)
- [ ] **World Graph Backup + DR** — periodic backup, integrity check, RPO/RTO targets (→ Finding 3.1, 7.3)
- [ ] **Self-Model Cold Start** — ใช้ QualityScore data จาก Phase 0 เป็น calibration baseline (→ §8.3 Gap A, §12.2)
- [ ] **Runtime Observability** — oracle latency histogram, block rate, structured event stream (→ Finding 7.2)
- [ ] **Sanitizer Context-Awareness** — แยก user-content vs code-artifact sanitization (→ Finding 6.3)
- [ ] **OpenClaw SDK Interface Contract** — document exact hook API ที่ Vinyan depends on (→ Risk: SDK dependency)

---

## 15. Missing Artifacts Checklist

- [x] Performance budget document (→ §9.1, R1) ✅ *added to TDD §13*
- [ ] Phase 0→1 migration spec (→ Finding 3.2)
- [x] World Graph retention policy (→ §9.2, R2) ✅ *added to TDD §5*
- [ ] World Graph capacity model — benchmark at scale (→ Finding 4.2)
- [ ] OpenClaw SDK interface contract (→ Risk: SDK dependency)
- [ ] Oracle extension guide — how to add new oracle types (→ §8.3 Gap C)
- [ ] Disaster recovery plan (→ Finding 7.3)
- [ ] Mermaid sequence diagram: full gate flow
- [ ] Skill formation schema design (→ §8.3 Gap B)
- [ ] ENS scope declaration — "for AI Systems" vs "for Code" boundary (→ §8.3 Gap C)

---

## 16. ENS Competitive Readiness — HiClaw Benchmark

> **Context:** Vinyan's vision is to be a full Epistemic Nervous System that surpasses HiClaw/OpenClaw — not a plugin. Phase 0 proved epistemic verification works (253 tests, A1/A3/A4/A5/A6 validated). The question: **what TDD specs are missing to claim Vinyan is architecturally superior as a complete system?**

### 16.1 Assessment: Phase 0 TDD vs HiClaw

| มิติ | Vinyan TDD Status | HiClaw Status | Verdict |
|------|------------------|--------------|---------|
| Epistemic verification | ✅ Full spec + implemented | ❌ ไม่มี | **Vinyan >>>** |
| Truth persistence | ✅ World Graph spec + implemented | ❌ JSON files | **Vinyan >>** |
| Risk routing | ✅ Full algorithm + tests | ❌ Ad-hoc by LLM | **Vinyan >>** |
| Security guardrails | ✅ Injection + bypass defense | ❌ ไม่มี | **Vinyan >>** |
| Multi-agent orchestration | ⚠️ D7 in arch doc, no TDD | ✅ Manager→Leader→Worker | **HiClaw >** (working vs designed) |
| Execution lifecycle | ⚠️ D9 in arch doc, no TDD | ✅ Naive retry (working) | **Tie** (HiClaw works but inferior design) |
| Tool protocol | ❌ No spec | ✅ Higress MCP Gateway | **HiClaw >>** |
| Channels | ❌ No spec | ✅ Matrix + 20 channels | **Defer** — not core ENS |
| Skills ecosystem | ❌ No spec | ✅ 80K+ skills | **Defer** — Phase 3+ |

### 16.2 จำเป็นจริง ๆ — TDD Sections ที่ต้องเขียน

เฉพาะสิ่งที่ **ไม่มีจะ claim ไม่ได้ว่า Vinyan เป็น full platform:**

#### MUST-1: Deterministic Orchestrator TDD (← arch D7)

**ทำไมจำเป็น:** นี่คือ killer feature ที่ HiClaw ไม่มี — deterministic orchestrator vs LLM Manager ที่ hallucinate task assignments มี design ดีอยู่แล้วใน arch doc (5 machine-checkable acceptance criteria, two-tier validation, planning depth per routing level) แต่ **ไม่มี TDD section = ไม่มี implementation contract**

**ต้อง spec อะไร:**
- Task DAG interface + topological sort algorithm
- Dispatch protocol: Orchestrator → Worker (intent format, result format)
- 5 acceptance criteria เป็น executable test assertions
- Worker pool management: fork/kill/timeout lifecycle
- Planning depth per routing level (L0-1: no plan, L2: single-pass, L3: iterative + Critic)

**Arch references:** D7 (Multi-Agent Coordination), D5 (Worker Isolation)

#### MUST-2: Adaptive Execution Lifecycle TDD (← arch D9)

**ทำไมจำเป็น:** HiClaw ใช้ naive retry (ลองใหม่เหมือนเดิมจนกว่าจะผ่าน) Vinyan ออกแบบ replan-with-evidence + auto-escalation ที่ดีกว่ามาก แต่ **ไม่มี state machine spec = implement ไม่ได้**

**ต้อง spec อะไร:**
- State machine: Perceive → Predict → Plan → Generate → Verify → Learn (per routing level)
- Transition rules: Oracle reject → record in WorkingMemory → re-enter at Plan (not Generate)
- Escalation triggers: N failures → escalate routing level; Level 3 + N failures → human
- WorkingMemory state management: failedApproaches accumulation, hypothesis tracking

**Arch references:** D9 (Adaptive Execution Lifecycle), D8 (WorkingMemory)

#### MUST-3: Tool Protocol — MCP Host Spec (← gap-analysis GAP-2)

**ทำไมจำเป็น:** ถ้าไม่มี tool protocol, Vinyan ไม่ใช่ platform — เป็นแค่ verification engine ที่ต้อง host ใน framework อื่น MCP เป็น industry standard ที่ HiClaw (Higress), OpenClaw (mcporter), Claude Code ใช้อยู่แล้ว

**ต้อง spec อะไร:**
- MCP host implementation: Vinyan Orchestrator as MCP client (consume tools)
- Reasoning Engine as MCP server: expose Oracle capabilities ให้ external systems ใช้
- Tool discovery + capability matching per Worker
- ECP ↔ MCP bridge: translate epistemic metadata (confidence, evidence) ↔ MCP tool results

**Arch references:** Concept §2.1 External Interface channel, GAP-2

### 16.3 ไม่จำเป็นตอนนี้ — Deferred with Rationale

| Item | เหตุผลที่ defer |
|------|----------------|
| D8 PerceptualHierarchy full TDD | D7 Orchestrator ทำงานได้โดย inject context แบบ Phase 0 ก่อน — PerceptualHierarchy เป็น optimization ไม่ใช่ prerequisite |
| D10 QualityScore full spec | Phase 0 เก็บ 2 dimensions อยู่แล้ว (architecturalCompliance + efficiency) — full 4 dimensions ต้อง tree-sitter diff + mutation infra ที่ยังไม่มี |
| D11 Self-Model full spec | Cold-start heuristics (file count, dep depth, test count) ทำงานได้ — calibration ต้อง traces จาก Phase 1 ก่อนถึง meaningful |
| GAP-1 Channel protocol | stdin/stdout + API เพียงพอสำหรับ Phase 1 — Matrix/Slack/Discord เป็น integration layer ไม่ใช่ core ENS capability |
| GAP-4 Human escalation | stdout notification + process exit code เพียงพอ — rich escalation protocol ต้อง UI ที่ยังไม่มี |
| GAP-7 Skills ecosystem | Phase 3+ concern — ต้องมี Evolution Engine + trace data จำนวนมากก่อนถึงจะมี skills ที่ meaningful |

### 16.4 Research TODO — ข้อจำกัดที่ต้องวิจัยก่อน implement

| หัวข้อ | คำถามที่ต้องตอบ | ข้อจำกัดปัจจุบัน |
|--------|----------------|-----------------|
| **ECP ↔ MCP bridge** | Epistemic metadata (confidence, evidence chain) map ลง MCP tool result ยังไง? MCP ไม่มี concept ของ "I don't know" | MCP spec ไม่มี epistemic semantics — ต้อง design extension หรือ sideband channel |
| **Deterministic task decomposition** | dep-oracle ให้ blast radius ได้ — แต่ map blast radius → task DAG ที่ correct ยังไง? | D7 มี 5 criteria แต่ไม่มี algorithm ว่า generate candidate DAG จาก dependency graph ยังไง |
| **Parallel worker coordination** | Workers share files — concurrent writes to same file ทำยังไง? | D8 บอก "read-only copy per worker, merge on return" แต่ merge conflict strategy ยังไม่มี |
