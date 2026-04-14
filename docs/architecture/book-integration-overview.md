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

## 4. ขอบเขตของการเปลี่ยนแปลง — 10 Action Items

จัดเรียงตาม priority/complexity แบ่งเป็น 3 **wave** (รายละเอียดอยู่ใน Phase B):

### Wave 1 — Quick Wins (low risk, ~1-2 wk)
| # | Action item | ไฟล์ที่กระทบหลัก | Axiom touched |
|---|---|---|---|
| W1.1 | **Worker heartbeat + Silent-Agent detector** | `worker/agent-loop.ts`, `guardrails/silent-agent.ts` (new) | A6 (เสริม visibility) |
| W1.2 | **Research Swarm preset** ใน task-decomposer | `task-decomposer.ts`, `task-decomposer-presets.ts` (new) | A1 (read-only ⇒ generator แยก verifier) |
| W1.3 | **Three-Tier mental model** ใน docs | `docs/architecture/vinyan-os-architecture.md` §3.x (new subsection) | (docs only) |

### Wave 2 — Critic Hardening (~2-3 wk, needs design discussion)
| # | Action item | ไฟล์ที่กระทบหลัก | Axiom touched |
|---|---|---|---|
| W2.1 | **Architecture Debate Mode** (3-agent advocate/counter/architect) | `critic/critic-engine.ts`, `critic/debate-mode.ts` (new) | A1 (3 LLM calls แยก context), A3 (deterministic trigger via risk-router) |
| W2.2 | **Merge-conflict pre-computation** | `concurrent-dispatcher.ts` | A3 (deterministic conflict graph) |
| W2.3 | **Termination sentinel** ใน sleep-cycle | `sleep-cycle/sleep-cycle.ts` | A3 (rule-based termination) |

### Wave 3 — Visibility & UX (parallelizable, UX-heavy)
| # | Action item | ไฟล์ที่กระทบหลัก | Axiom touched |
|---|---|---|---|
| W3.1 | **`peek` live-stream command** | `tui/commands.ts`, `tui/views/peek.ts` (new) | (no axiom impact) |
| W3.2 | **Worktree-isolation cleanup hook** (ถ้าเลือกใช้ worktree) | `fleet/worker-lifecycle.ts`, `worker/sandbox.ts` | A6 (เสริม isolation) |
| W3.3 | **Tier-Transport mapping doc** | `docs/architecture/vinyan-os-architecture.md` (appendix) | (docs only) |

> **W1.1 + W3.1 รวมกัน** จะให้ payoff สูงสุดในเชิง operator UX — heartbeat → bus event →
> peek view สามารถใช้กลไกเดียวกันได้

---

## 5. Mapping ไอเดีย ↔ Axiom (สรุป)

| ไอเดียจากหนังสือ | Axiom relevant | สถานะใน Vinyan | สิ่งที่จะทำ |
|---|---|---|---|
| Three-Tier mental model | (none — taxonomy) | implicit, ไม่ได้เขียนเป็น doc | เขียน section ใหม่ใน vinyan-os-architecture.md |
| Research Swarm | A1 (separation) | task-decomposer ทำได้แต่ไม่มี preset | เพิ่ม preset + report contract |
| Architecture Debate | A1, A3 | critic เป็น single-LLM | เพิ่ม debate mode (opt-in via risk-router) |
| Worktree isolation | A6 | ไม่มี worktree เลย | (ตัดสินใจใน Wave 3) |
| Silent-agent detector | A6 (visibility) | peer-level เท่านั้น | worker-level heartbeat |
| Merge conflict pre-compute | A3 | lazy retry | สร้าง conflict graph ก่อน dispatch |
| Termination sentinel | A3 | data-gate only | rule-based max-cycles + state-progress check |
| ALWAYS-report contract | A1 | ECP มีอยู่แล้ว | เสริมใน delegation-router (เป็น strict-report flag) |
| Tier-Transport mapping | (taxonomy) | implicit | appendix |
| Model economics by role | A5 (tiered trust) | by-level + by-trust | เพิ่ม role hint (read-only ⇒ Haiku, debate-architect ⇒ Opus) |
| `peek` visibility | (UX) | global watch only | per-agent live stream |

---

## 6. สิ่งที่ **ไม่หยิบมา** (Rejected) และเหตุผล

| ไอเดีย | เหตุผลที่ reject | Axiom ที่ขัด |
|---|---|---|
| In-process subagent (Tier 1 แบบ maw-js) | Generator ต้องเป็น subprocess แยก ไม่ใช่ co-routine ใน Orchestrator | **A1** |
| Unsandboxed TypeScript plugin | Plugin ต้องผ่าน sandbox + agent-contract ไม่ใช่ "ergonomic-trust" | **A6** |
| Plain-text `maw hey` ข้าม tmux | Vinyan ใช้ ECP รวยกว่ามาก ไม่ควรถอย format | (degradation, ไม่ขัด axiom แต่ขัด design philosophy) |
| LLM-as-coordinator | Coordinator ต้องเป็น rule-based | **A3** |
| Ad-hoc cron loop ไม่มี state guard | ทุก loop ต้องมี deterministic termination | **A3** |

---

## 7. Success Criteria — เอกสารชุดนี้สำเร็จเมื่อ

1. ✅ Operator มนุษย์ใหม่อ่าน overview แล้วบอกได้ว่า "Vinyan แตกต่างจาก maw-js ตรงไหน"
2. ✅ Engineer ที่จะ implement Wave 1 หยิบเอกสาร design (Phase A) ไปทำงานต่อได้โดยไม่ต้องถาม intent
3. ✅ Reviewer มี checklist ในการตรวจว่าแต่ละ PR ของ wave หนึ่งขัด axiom A1/A3/A6 หรือไม่
4. ✅ ทุก action item ผูกอยู่กับไฟล์จริงและ test surface ที่ระบุได้
5. ✅ Rollout strategy ของ Wave 2 (Critic Debate) มี feature-flag และ rollback plan ชัดเจน

---

## 8. Open Questions (ต้องตอบก่อนเริ่ม Wave 2)

1. **Architecture Debate trigger** — ใช้ risk-router score เป็นตัวจุดชนวน (เช่น `riskScore > 0.7`)
   หรือใช้ tag manual `--debate` ของ task? (ผู้เขียน design แนะนำ: **risk-router** เป็น default,
   manual override ทับได้ — A3 compliant)
2. **Debate cost cap** — Opus×3 calls ราคาแพง ต้องมี budget guard ที่ระดับใด (per-task vs per-day)?
3. **Worktree adoption** — Vinyan ใช้ Docker sandbox อยู่แล้ว ค่าใช้จ่ายจริงในการเพิ่ม worktree
   layer คุ้มกับ blast-radius reduction หรือไม่? (อาจตัด W3.2 ออก ถ้าคำตอบคือไม่)
4. **Termination sentinel scope** — ใช้กับ sleep-cycle อย่างเดียว หรือขยายไปครอบ
   `core-loop` retry loop ด้วย? (default scope: sleep-cycle เท่านั้น เพราะ core-loop มี
   max-retries อยู่แล้ว)

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
