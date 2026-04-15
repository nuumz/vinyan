# Multi-Agent Orchestration Book — Integration Overview

> **เอกสารชุดนี้** เป็นการตีโจทย์ก่อนลงรายละเอียด: นำเสนอกรอบใหญ่ของการนำไอเดียจากหนังสือ
> *Multi-Agent Orchestration* (Soul Brews Studio, field guide จาก maw-js) มาประยุกต์กับ
> Vinyan โดยไม่ขัดกับ axiom A1–A7 และไม่ทำลาย invariant ของระบบที่มีอยู่
>
> **Companion docs:**
> - Phase A — Design: [`book-integration-design.md`](./book-integration-design.md)
> - Phase B — Implementation Plan: [`../design/book-integration-implementation-plan.md`](../design/book-integration-implementation-plan.md)

---

## 1. ทำไมต้องมีเอกสารชุดนี้

Vinyan โตเร็วในเชิง subsystem (orchestrator / a2a / oracle / sleep-cycle / fleet) แต่
เอกสารยังกระจัดกระจายและไม่มี mental model กลางที่ "operator มนุษย์" ใช้สื่อสารระหว่างกัน
ได้ในประโยคเดียว หนังสือ *Multi-Agent Orchestration* เสนอ pattern ที่:

1. **กลั่นจากการใช้งานจริง** ไม่ใช่กระดาษวิจัย
2. **เน้น human visibility** มากกว่า agent convenience
3. **มี vocabulary ที่ใช้ร่วมกันได้** (Tier 1/2/3, Research Swarm, Architecture Debate, ฯลฯ)

**โอกาส:** หยิบ pattern เหล่านี้มาเสริมจุดอ่อนเฉพาะของ Vinyan — โดยเฉพาะ failure-mode
detector, critic hardening, และ visibility UX — โดย **ไม่ลดทอน** axiom ใด ๆ

**ความเสี่ยง:** หนังสือเขียนจากบริบทที่ "trust the agent" สูงกว่า Vinyan มาก หาก import
pattern แบบไม่กรอง อาจขัดกับ A1 (Epistemic Separation), A3 (Deterministic Governance),
A6 (Zero-Trust Execution) ได้ง่าย — เอกสารชุดนี้กรองให้แล้ว

---

## 2. หลักการคัดกรอง — Axiom Filter

ก่อนเอาไอเดียจากหนังสือมาใช้ ทุกข้อต้องผ่าน 3 คำถามนี้:

| # | คำถาม | ที่มาของ axiom |
|---|---|---|
| Q1 | Generator กับ Verifier ยังเป็น process แยกกันอยู่ไหม? | A1 |
| Q2 | Governance path ยังเป็น rule-based zero-LLM อยู่ไหม? | A3 |
| Q3 | Worker ยังต้อง propose-then-dispose ผ่าน contract ไหม? | A6 |

ทุก action item ในเอกสารชุดนี้ **ผ่านทั้ง 3 ข้อ** หรือไม่ก็ถูก reject (ดูข้อ 6 ด้านล่าง)

---

## 3. สถานะปัจจุบัน — Vinyan มีอะไรอยู่แล้ว

ยืนยันจาก code (เพื่อให้แผนตั้งอยู่บนข้อเท็จจริง ไม่ใช่ความเชื่อ):

| หมวด | สถานะ | หลักฐาน |
|---|---|---|
| ECP protocol (rich, structured) | ✅ มี | `src/a2a/ecp-data-part.ts` |
| A2A transport (stdio/http/ws/gossip) | ✅ มี | `src/a2a/*-transport.ts` |
| Fleet coordinator + worker pool | ✅ มี | `src/orchestrator/fleet/`, `src/orchestrator/worker/` |
| Oracle Gate (deterministic governance) | ✅ มี (A3) | `src/gate/`, `src/oracle/` |
| Multi-instance coordination | ✅ มี | `src/orchestrator/instance-coordinator.ts` |
| Content-addressed truth | ✅ มี (A4) | `src/world-graph/world-graph.ts` |
| **Peer-level heartbeat** | ✅ มี | `src/a2a/peer-health.ts` |
| **Worker-level heartbeat** | ❌ ไม่มี | (ยืนยันโดย grep: ไม่มี `heartbeat` ใน `worker/`) |
| **LLM Critic** | ✅ มี (single) | `src/orchestrator/critic/critic-engine.ts` |
| **Architecture Debate (3-agent)** | ❌ ไม่มี | — |
| **Concurrent dispatcher** | ✅ มี | `src/orchestrator/concurrent-dispatcher.ts` |
| **Pre-computed merge-conflict graph** | ❌ ไม่มี (lazy retry only) | `concurrent-dispatcher.ts` L51-93 |
| **Task Decomposer** | ✅ มี (generic) | `src/orchestrator/task-decomposer.ts` |
| **Research Swarm preset** | ❌ ไม่มี | — |
| **Sleep Cycle** | ✅ มี | `src/sleep-cycle/sleep-cycle.ts` |
| **Termination sentinel** | ❌ ไม่มี (data-gate only) | `sleep-cycle.ts` L116 |
| **Worker lifecycle (probation/active/retired)** | ✅ มี | `src/orchestrator/fleet/worker-lifecycle.ts` |
| **Orphan-worktree cleanup hook** | ❌ ไม่มี (no worktree at all) | (no `worktree` ใน src/) |
| **TUI watch (global)** | ✅ มี | `src/tui/commands.ts` `startWatch` |
| **TUI `peek` (per-agent stream)** | ❌ ไม่มี | — |
| **Engine selector (by trust + level)** | ✅ มี | `src/orchestrator/engine-selector.ts` |
| **Engine selector by role semantics** | ❌ ไม่มี | — |

> **ข้อสังเกตสำคัญ:** Vinyan ซับซ้อนกว่า maw-js ในเชิง correctness อยู่แล้ว — สิ่งที่ขาด
> เป็น "human factor" และ "operational visibility" มากกว่า "core protocol"

---

## 4. ขอบเขตของการเปลี่ยนแปลง — 13 Action Items

จัดเรียงตาม priority/complexity แบ่งเป็น 4 **wave** (รายละเอียดอยู่ใน Phase B):

### Wave 1 — Quick Wins (low risk, ~1-2 wk) — ✅ SHIPPED
| # | Action item | ไฟล์ที่กระทบหลัก | Axiom touched |
|---|---|---|---|
| W1.1 | **Worker heartbeat + Silent-Agent detector** | `worker/agent-loop.ts`, `guardrails/silent-agent.ts` (new) | A6 (เสริม visibility) |
| W1.2 | **Research Swarm preset** ใน task-decomposer | `task-decomposer.ts`, `task-decomposer-presets.ts` (new) | A1 (read-only ⇒ generator แยก verifier) |
| W1.3 | **Three-Tier mental model** ใน docs | `docs/architecture/vinyan-os-architecture.md` §3.x (new subsection) | (docs only) |

### Wave 2 — Critic Hardening (~2-3 wk, needs design discussion) — ✅ SHIPPED
| # | Action item | ไฟล์ที่กระทบหลัก | Axiom touched |
|---|---|---|---|
| W2.1 | **Architecture Debate Mode** (3-agent advocate/counter/architect) | `critic/critic-engine.ts`, `critic/debate-mode.ts` (new) | A1 (3 LLM calls แยก context), A3 (deterministic trigger via risk-router) |
| W2.2 | **Merge-conflict pre-computation** | `concurrent-dispatcher.ts` | A3 (deterministic conflict graph) |
| W2.3 | **Termination sentinel** ใน sleep-cycle | `sleep-cycle/sleep-cycle.ts` | A3 (rule-based termination) |

### Wave 3 — Visibility & UX (parallelizable, UX-heavy) — ✅ SHIPPED (W3.2 deferred)
| # | Action item | ไฟล์ที่กระทบหลัก | Axiom touched |
|---|---|---|---|
| W3.1 | **`peek` live-stream command** | `tui/commands.ts`, `tui/views/peek.ts` (new) | (no axiom impact) |
| W3.2 | **Worktree-isolation cleanup hook** (ถ้าเลือกใช้ worktree) | `fleet/worker-lifecycle.ts`, `worker/sandbox.ts` | A6 (เสริม isolation) |
| W3.3 | **Tier-Transport mapping doc** | `docs/architecture/vinyan-os-architecture.md` (appendix) | (docs only) |

### Wave 4 — Full-book Gap Closure (added after deep-read of Ch01-15 + Appendices)
> **ที่มา:** การอ่านหนังสือเชิงลึกครั้งที่สอง (Ch01–15 + App A–D) เผยกับช่องว่าง
> 4 อย่างที่ overview เวอร์ชันแรกพลาดไป — ดู §11 *Complete Book-to-Vinyan Mapping*
> ด้านล่างเพื่อดู evidence ต่อ item

| # | Action item | ไฟล์ที่กระทบหลัก | Axiom touched | Source |
|---|---|---|---|---|
| W4.1 | **Canary-first batch dispatch** — test one task before fanning out the batch, abort on canary failure | `concurrent-dispatcher.ts` | A3 (deterministic abort rule) | Ch12 §"error() bug", Ch14 Failure 3 |
| W4.2 | **Role-hint → engine tier** selection (read/implement/debate/verify → Haiku/Sonnet/Opus preference) | `engine-selector.ts`, `critic/debate-mode.ts` | A5 (tiered trust, deterministic selection) | App C Cost Analysis + Ch07 |
| W4.3 | **`WorkerLifecycle.onCleanup` hook registry** — generic cleanup-on-retire seam | `fleet/worker-lifecycle.ts` | A6 (defensive isolation) | Ch14 Failure 4 |
| W4.4 | **Implementation Team preset** — mutation-side companion to Research Swarm (disjoint-seam file partition + role assignment) | `task-decomposer-presets.ts` | A1 + A3 (pure partition rule, no LLM in governance path) | Ch07 + Ch12 |

> **Scope note:** W4.4 is larger than W4.1–3 combined because it needs a deterministic
> disjoint-seam heuristic; see Phase B for the decision to ship W4.1–3 in this iteration
> and keep W4.4 as Wave 5 (documented, not coded).

> **W1.1 + W3.1 รวมกัน** จะให้ payoff สูงสุดในเชิง operator UX — heartbeat → bus event →
> peek view สามารถใช้กลไกเดียวกันได้. **W4.1 + W4.2 รวมกัน** ปิดช่องโหว่ "batch of homogeneous
> mutations" ที่ `concurrent-dispatcher` เคยขาด — canary แบ่ง failure blast radius, role-hint
> เลือกโมเดลที่ cost/quality trade-off เหมาะกับแต่ละ partition

---

## 5. Mapping ไอเดีย ↔ Axiom (สรุป — 13 items)

| ไอเดียจากหนังสือ | Axiom relevant | สถานะใน Vinyan | สิ่งที่จะทำ | Wave |
|---|---|---|---|---|
| Three-Tier mental model | (none — taxonomy) | implicit, ไม่ได้เขียนเป็น doc | เขียน section ใหม่ใน vinyan-os-architecture.md | W1.3 ✅ |
| Research Swarm | A1 (separation) | task-decomposer ทำได้แต่ไม่มี preset | เพิ่ม preset + report contract | W1.2 ✅ |
| Architecture Debate | A1, A3 | critic เป็น single-LLM | เพิ่ม debate mode (opt-in via risk-router) | W2.1 ✅ |
| Worktree isolation | A6 | ไม่มี worktree เลย | **Deferred** — Docker sandbox + SessionOverlay already cover | W3.2 ⏸ |
| Silent-agent detector | A6 (visibility) | peer-level เท่านั้น | worker-level heartbeat | W1.1 ✅ |
| Merge conflict pre-compute | A3 | lazy retry | สร้าง conflict graph ก่อน dispatch | W2.2 ✅ |
| Termination sentinel | A3 | data-gate only | rule-based max-cycles + state-progress check | W2.3 ✅ |
| ALWAYS-report contract | A1 | ECP มีอยู่แล้ว | ฝัง REPORT_CONTRACT ใน research-swarm preset | W1.2 ✅ |
| Tier-Transport mapping | (taxonomy) | implicit | appendix | W3.3 ✅ |
| Model economics by role | A5 (tiered trust) | by-level + by-trust | เพิ่ม `roleHint` argument (read⇒Haiku, debate⇒Opus, implement⇒Sonnet) | **W4.2** |
| `peek` visibility | (UX) | global watch only | per-agent live stream | W3.1 ✅ |
| Canary-before-batch (Ch12 "test one handler") | A3 (deterministic abort) | ไม่มี — batch ทั้งหมดรันขนาน | canary-first option on dispatch | **W4.1** |
| Orphan-cleanup hooks (Ch14 Failure 4) | A6 | ไม่มี cleanup registry | generic onCleanup hook registry | **W4.3** |
| Implementation Team (Ch07) | A1 + A3 | ไม่มี mutation-side preset | disjoint-seam partition preset | **W4.4** (Wave 5 — documented only) |

---

## 6. สิ่งที่ **ไม่หยิบมา** (Rejected) และเหตุผล

| ไอเดีย | เหตุผลที่ reject | Axiom ที่ขัด / Source chapter |
|---|---|---|
| In-process subagent (Tier 1 แบบ maw-js) | Generator ต้องเป็น subprocess แยก ไม่ใช่ co-routine ใน Orchestrator | **A1** — Ch02 |
| Unsandboxed TypeScript plugin | Plugin ต้องผ่าน sandbox + agent-contract ไม่ใช่ "ergonomic-trust" | **A6** — Ch10 |
| Plain-text `maw hey` ข้าม tmux | Vinyan ใช้ ECP รวยกว่ามาก ไม่ควรถอย format | (degradation, ไม่ขัด axiom แต่ขัด design philosophy) — Ch03 |
| LLM-as-coordinator | Coordinator ต้องเป็น rule-based | **A3** — Ch03 |
| Ad-hoc cron loop ไม่มี state guard | ทุก loop ต้องมี deterministic termination | **A3** — Ch09 |
| **WASM plugin runtime (Ch11)** | Vinyan ใช้ Docker sandbox อยู่แล้ว — kernel boundary แข็งแกร่งกว่า; WASM มี capability model ที่ดีแต่ Vinyan's A6 capability-scope contract ครอบคลุมเรื่องนี้แล้ว | (not axiom-violating, cost/benefit) — Ch11 |
| **Cross-session TaskCreate/TaskList primitives (Ch04)** | Vinyan's model มี orchestrator เป็น single dispatcher — agent ไม่ต้อง "claim" task เพราะถูก assign ให้ นับตั้งแต่ root ของ DAG; `blockedBy` ถูกแทนด้วย DAG edges | (not needed — orchestrator-owned dispatch) — Ch04 |
| **`maw hey` scrollback injection เป็น transport ที่ 4** | ECP + A2A transport stack ของ Vinyan ครอบคลุม semantics ทั้ง structured messaging และ durable handoff อยู่แล้ว — การเพิ่ม scrollback-based transport จะขัด design philosophy (Ch03 rejects bridging transports across tiers) | (degradation) — Ch03 |
| **In-memory TaskList ที่ sync ผ่าน SendMessage** | `plan_update` ของ Vinyan (Phase 7c-2) เป็น per-session todo ที่ render ใน `<vinyan-reminder>` block อยู่แล้ว — ไม่ต้องมี inter-agent sync เพราะ Vinyan มี one parent per session | (redundant) — Ch04 |
| **Tier 4 "coordinated independence" command** (`maw wake --issue N --team`) | Vinyan's A2A + InstanceCoordinator + DelegationRouter ครอบคลุมทุก property ที่ Tier 4 เสนอ (spawn + name-addressable + cross-process + survivable) ผ่าน ECP + trust attestation อยู่แล้ว | (already covered by richer stack) — Ch15 |

---

## 7. Success Criteria — เอกสารชุดนี้สำเร็จเมื่อ

1. ✅ Operator มนุษย์ใหม่อ่าน overview แล้วบอกได้ว่า "Vinyan แตกต่างจาก maw-js ตรงไหน"
2. ✅ Engineer ที่จะ implement Wave 1 หยิบเอกสาร design (Phase A) ไปทำงานต่อได้โดยไม่ต้องถาม intent
3. ✅ Reviewer มี checklist ในการตรวจว่าแต่ละ PR ของ wave หนึ่งขัด axiom A1/A3/A6 หรือไม่
4. ✅ ทุก action item ผูกอยู่กับไฟล์จริงและ test surface ที่ระบุได้
5. ✅ Rollout strategy ของ Wave 2 (Critic Debate) มี feature-flag และ rollback plan ชัดเจน
6. ✅ ทุก **บทในหนังสือ** (Ch01–15 + App A–D) มี mapping ชัดเจนใน §11 ว่า Vinyan มีอะไรอยู่แล้ว, จะ implement อะไร, หรือปฏิเสธด้วยเหตุผลอะไร — **deep-read pass complete as of 2026-04-15**

---

## 8. Open Questions (ต้องตอบก่อนเริ่ม Wave 2)

1. **Architecture Debate trigger** — ใช้ risk-router score เป็นตัวจุดชนวน (เช่น `riskScore > 0.7`)
   หรือใช้ tag manual `--debate` ของ task? (ผู้เขียน design แนะนำ: **risk-router** เป็น default,
   manual override ทับได้ — A3 compliant). **RESOLVED — shipped in W2.1 with both paths.**
2. **Debate cost cap** — Opus×3 calls ราคาแพง ต้องมี budget guard ที่ระดับใด (per-task vs per-day)?
   **PARTIALLY RESOLVED** — agent budget cap applies per-task (from K1.2 AgentContract).
   Per-day cap ยังไม่มี — ฝากไว้ใน Wave 5 backlog ของ Phase B
3. **Worktree adoption** — Vinyan ใช้ Docker sandbox อยู่แล้ว ค่าใช้จ่ายจริงในการเพิ่ม worktree
   layer คุ้มกับ blast-radius reduction หรือไม่? (อาจตัด W3.2 ออก ถ้าคำตอบคือไม่).
   **RESOLVED — deferred.** Session overlay + Docker sandbox คลุม use case แล้ว; W4.3 เพิ่ม
   cleanup-hook seam สำหรับอนาคต
4. **Termination sentinel scope** — ใช้กับ sleep-cycle อย่างเดียว หรือขยายไปครอบ
   `core-loop` retry loop ด้วย? (default scope: sleep-cycle เท่านั้น เพราะ core-loop มี
   max-retries อยู่แล้ว). **RESOLVED — sleep-cycle only.**
5. **(NEW)** **Canary-first activation** — เปิด default ให้ทุก batch หรือ opt-in เท่านั้น?
   (Phase B แนะนำ: **opt-in**, เพราะ homogeneous-batch detection เป็น heuristic และ canary
   เพิ่ม latency ของ task แรก)
6. **(NEW)** **Role hint mapping** — ถ้า registry ไม่มี tier ที่ preferred role ต้องการ
   (เช่น ไม่มี `fast` tier แต่ role เป็น 'read'), fallback ไปที่อะไร? (Phase B แนะนำ:
   fall through to existing tier-trust ladder; role hint เป็น **preference**, ไม่ใช่ constraint)

---

## 9. ทำตามลำดับนี้

```
[Overview ฉบับนี้] ← คุณอยู่ตรงนี้
        │
        ├──► Phase A — Design Document
        │       (component-level design ของทุก action item + interface signatures)
        │
        └──► Phase B — Implementation Plan
                (Wave 1/2/3, file-by-file change list, test surface, exit criteria)
```

อ่านต่อที่:

- **Phase A:** [`book-integration-design.md`](./book-integration-design.md)
- **Phase B:** [`../design/book-integration-implementation-plan.md`](../design/book-integration-implementation-plan.md)

---

## 10. Deep-Read Delta — what the second pass added (2026-04-15)

> The first overview was written before reading the full book. After a complete
> Ch01–15 + App A–D deep-read, the table below summarizes what changed.

**New items identified:**
- W4.1 Canary-first batch (Ch12 §"error() bug" + Ch14 Failure 3)
- W4.2 Role-hint → engine tier (App C Cost Analysis + Ch07)
- W4.3 WorkerLifecycle cleanup hook registry (Ch14 Failure 4)
- W4.4 Implementation Team preset (Ch07 + Ch12) — planned for Wave 5

**Items re-contextualized:**
- Three-Tier model (§3.1) — now references Ch02's explicit decision tree:
  "< 5 min read ⇒ Tier 1; 5–30 min coordinated ⇒ Tier 2; > 30 min or
  cross-machine ⇒ Tier 3." Vinyan's equivalent mapping is in Phase A §2.
- Architecture Debate (W2.1) — Ch06 recommends **Opus for all 3 seats**
  (research is cheap, argument is not). Factory currently uses
  `powerful` for advocate/architect and `balanced` for counter. This is
  a deliberate cost/diversity trade-off documented in Phase A §3.1.
- Termination sentinel (W2.3) — Ch09 adds "prompt is the whole prompt"
  + "state lives on disk" + "sentinel terminates the loop" as three
  rules. Vinyan already follows rules 1–2 via `AgentBudgetTracker` +
  `TraceStore`/`PatternStore`; rule 3 is what W2.3 adds.

**Items explicitly rejected after deeper read:**
- WASM plugin runtime (Ch11) — Docker sandbox is already richer
- Cross-session TaskCreate/TaskList primitives (Ch04) — orchestrator-owned
  dispatch means agents never need to claim tasks
- Tier 4 `maw wake --team` command (Ch15) — A2A + InstanceCoordinator +
  DelegationRouter already deliver every property Tier 4 proposes

---

## 11. Complete Book-to-Vinyan Mapping

> Every chapter in the book mapped to Vinyan's current state and
> the action item (or deliberate non-action) that closes it.

| Ch | Title | Vinyan state | Action (Wave) |
|----|-------|--------------|---------------|
| 1 | Why One Agent Isn't Enough | Already aligned — Vinyan always spawns generator in a subprocess (A1); 200K context hemorrhage is mitigated by K1.2 AgentContract + worker budget cap + transcript compaction | (no action — design philosophy match) |
| 2 | The Three Tiers | §3.1 added by W1.3; maps book's Tier 1 (rejected — violates A1), Tier 2 (= Swarm — `ConcurrentDispatcher`), Tier 3 (= Fleet — A2A + `InstanceCoordinator`) | **W1.3 ✅** |
| 3 | The Message Bus | Vinyan has `VinyanBus` (in-process, A3-deterministic FIFO) + ECP over 4 A2A transports (HTTP/WS/stdio/gossip); book's 3-transport design is a subset | (no action — already richer) |
| 4 | Task Tracking | Per-session `plan_update` (Phase 7c-2) + DAG for `blockedBy` semantics; cross-session atomic claim not needed under orchestrator-owned dispatch | **Rejected — §6** |
| 5 | Research Swarm | Preset added in W1.2 with REPORT_CONTRACT injection + fan-out cap | **W1.2 ✅** |
| 6 | Architecture Debate | 3-seat critic added in W2.1 with risk-gated DebateRouterCritic | **W2.1 ✅** |
| 7 | Implementation Team | Mutation-side companion to W1.2; needs disjoint-seam heuristic | **W4.4 (Wave 5)** |
| 8 | Federation Agent | A2A (`src/a2a/`) + `InstanceCoordinator` + `PeerHealthMonitor` already implement federation with ECP trust attestation and Wilson-LB peer trust | (no action — already richer) |
| 9 | The Cron Loop | Sleep-cycle has termination sentinel (W2.3); `ScheduleWakeup` self-paced variant not implemented — Wave 5 backlog | **W2.3 ✅** (+ Wave 5 backlog) |
| 10 | Plugin Architecture | Vinyan has MCP tool adapters (`src/mcp/`, `src/orchestrator/mcp/`) + Zod schema validation | (no action — covered by MCP) |
| 11 | WASM Plugin Runtime | Docker sandbox is already the isolation layer; WASM would add a second runtime without matching benefit | **Rejected — §6** |
| 12 | Framework Migration With Agents | The "test one before batch" rule from the `error()` bug is the source of **W4.1** | **W4.1** |
| 13 | What the Human Sees | `peek` added in W3.1; `watch` mode exists; `overview`/fleet-live view enhancement is Wave 5 backlog | **W3.1 ✅** |
| 14 | Failure Modes | Failure 1 (silent agent) = W1.1 ✅; Failure 2 (merge conflict) = W2.2 ✅; Failure 3 (error() bug) = **W4.1**; Failure 4 (orphan worktree) = **W4.3** (seam); Failure 5 (cross-repo command) n/a | **W1.1 ✅ + W2.2 ✅ + W4.1 + W4.3** |
| 15 | Tier 4 | A2A + InstanceCoordinator already deliver every Tier 4 property | **Rejected — §6** |
| App A | Command Reference | Vinyan CLI surface is `vinyan tui {interactive,watch,peek,replay,overview}` — subset of book's `maw` commands, same intent | (reference — Phase A Appendix A) |
| App B | Spawn Pattern Cheatsheet | Vinyan's equivalent is the DAG + ConcurrentDispatcher; cheatsheet added to Phase A Appendix B | (reference — Phase A Appendix B) |
| App C | Cost Analysis | Informs **W4.2** (role-hint → tier); Vinyan already tracks per-engine cost via `CostLedger` | **W4.2** |
| App D | Plugin Catalog | MCP tool map in `factory.ts` is the Vinyan equivalent; no new action | (no action — covered by MCP) |

---

## 12. Priority Matrix (Wave 4 candidates × value/effort)

| Item | Value | Effort | Decision |
|------|-------|--------|----------|
| W4.1 Canary-first batch | **High** — prevents real `error()`-bug failure class across N files | Low (~80 LOC + 5 tests) | **Ship now** |
| W4.2 Role hint → tier | Medium — codifies Appendix C cost guidance as a deterministic rule | Low (~60 LOC + 3 tests) | **Ship now** |
| W4.3 Cleanup hook registry | Low-medium — closes Ch14 Failure 4 as a seam; no concrete cleanup wired today | Very low (~40 LOC + 2 tests) | **Ship now** |
| W4.4 Implementation Team preset | **High** — mutation-side companion to Research Swarm, real operator value | **High** — needs deterministic disjoint-seam heuristic + role assignment + integration node design | **Defer to Wave 5** (documented in Phase A) |
| Wave 5: ScheduleWakeup | Medium — self-paced long-running external polling | Medium — needs session persistence / resumption primitive | Backlog |
| Wave 5: Overview-live fleet view | Medium — single-pane view of all workers + peers + tasks | Low-medium — TUI component, no core changes | Backlog |
| Wave 5: Sleep-cycle "state on disk" audit | Low — Vinyan already does this via TraceStore/PatternStore | Trivial — doc only | Backlog |
