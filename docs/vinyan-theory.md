---
type: concept-theory
audience: architects, researchers
single-source-of-truth-for: theoretical foundations, academic citations, cognitive science basis
related:
  - vinyan-concept.md (unified concept — start here)
  - vinyan-architecture.md (concrete implementation decisions)
---

# Vinyan — Theoretical Foundations & Deep Analysis

> **Relationship to concept.md:** This document (formerly `vinyan-concept-v2.md`, renamed to avoid version confusion) provides the deep theoretical underpinnings for the Vinyan concept defined in [vinyan-concept.md](vinyan-concept.md). Concept.md is the canonical concept document; this file contains the academic citations, cognitive science foundations, v1 critique, and the detailed 8-layer cognitive architecture that justify the design decisions in concept.md. The two documents describe **one unified concept** — concept.md for the "what" and "why", this document for the "evidence" and "theoretical depth".
>
> **Axiom Foundation:** All theoretical claims in this document trace back to the 7 Core Axioms (A1–A7) defined in [concept.md §1.1](vinyan-concept.md). Each layer, critique resolution, and phase milestone below is tagged with the axiom(s) it implements or validates.
>
> **Scope note:** Some constructs in this document (hippocampal replay, hierarchical skill composition, Affect Engine, Episodic Stream, predictive causal model) are theoretical extensions explored here for academic rigor. Concept.md uses more conservative framing: pattern mining instead of neural replay, cached solution patterns instead of skill formation, dependency edges instead of predictive causal model. This document is the research frontier; concept.md is the implementation contract.

## สารบัญ

1. [Executive Synthesis](#1-executive-synthesis)
2. [LLM Fundamental Deadlocks](#2-llm-fundamental-deadlocks)
3. [Theoretical Foundations](#3-theoretical-foundations)
4. [Critique of Vinyan v1](#4-critique-of-vinyan-v1)
5. [Vinyan v2 — Revised Cognitive Architecture](#5-vinyan-v2--revised-cognitive-architecture)
6. [Evolution Pathway](#6-evolution-pathway)
7. [Open Questions & Research Agenda](#7-open-questions--research-agenda)

---

## 1. Executive Synthesis

### 1.1 ทางตัน 6 ข้อสำคัญที่สุดของ LLM → AGI

1. 🟢 **Frozen Weights Paradox** — LLM ไม่เรียนรู้ขณะใช้งาน weights คงที่หลัง training สิ่งที่เรียกว่า "in-context learning" เป็นเพียง conditional computation บน existing weights ไม่ใช่การ update knowledge จริง (Madabushi et al., 2025 — "Context-Directed Extrapolation from Training Data Priors") **Test-Time Compute** เป็น partial mitigation แต่ไม่ใช่ true learning (Snell et al., 2024)
2. 🟢 **Compositional Generalization Failure** — LLM ล้มเหลวอย่างเป็นระบบเมื่อต้องรวม known components ในรูปแบบที่ไม่เคยเห็น performance ตกเกือบ zero เมื่อ composition equivalences ถูกกำจัด (Mondorf et al., 2025 — Compositional-ARC)
3. 🟢 **Epistemic Humility Deficit** — LLM ไม่รู้ว่าไม่รู้ ทำให้ "ไม่มีทางปฏิเสธ" สร้าง hallucination อย่างมั่นใจ เพราะ objective function optimize ความน่าจะเป็น (plausibility) ไม่ใช่ความจริง (truth) (Bender & Gebru, 2021)
4. 🟢 **Temporal Reasoning Gap** — ล้มเหลวกับ causal reasoning, counterfactuals, และ long-horizon planning เพราะ next-token prediction ไม่สร้าง causal model จริง เห็น correlation ไม่ใช่ causation (Ashwani et al., 2024)
5. 🟢 **Binding Problem / Grounding Gap** — ไม่มี unified representation ข้าม modalities แม้ multimodal models จะ "map" ภาพกับคำ แต่ยังไม่ผ่าน causal grounding แบบที่สัตว์/มนุษย์มี (Garrido et al., 2025 — Visual Cognition in MLLMs; Harnad, 1990)
6. 🟡 **No World Model** — LLM ไม่มี internal model ของ environment ที่ใช้ simulate ผลลัพธ์ก่อน act ต่างจาก LeCun's JEPA proposal ที่เสนอ world model เป็น core component ของ autonomous intelligence (LeCun, 2022)

> **Confidence Legend**: 🟢 Established (peer-reviewed, replicated) · 🟡 Emerging (recent, not yet replicated) · 🔴 Speculative (conjecture / synthesis)

### 1.2 "จิตวิญญาณมนุษย์" Operationalized เป็น Functional Components

แทนที่จะถกว่า AI มี "จิตวิญญาณ" หรือไม่ (ปัญหาที่ยังไม่มีคำนิยามทางวิทยาศาสตร์) เราเลือก **operationalize** คุณสมบัติที่ทำให้มนุษย์ต่างจากเครื่องจักร ตาม Butlin et al. (2023) framework:

| Functional Component | Operationalized Definition | Neuroscientific Basis |
|---|---|---|
| **Global Workspace** | Broadcast mechanism ที่ทำให้ subsystems เข้าถึง shared information | Global Workspace Theory (Baars, 1988; Dehaene, 2014) |
| **Self-Model** | Internal forward model ที่ predict ผลลัพธ์ก่อน execute | Wolpert (1997) forward/inverse models; Predictive Processing (Clark, 2013) |
| **Epistemic Awareness** | รู้ว่ารู้อะไร ไม่รู้อะไร calibrated confidence | Metacognition (Flavell, 1979; Fleming, 2021) |
| **Temporal Continuity** | Sense of narrative self ข้าม episodes, ไม่ใช่แค่ fact retrieval | Episodic memory + Autonoetic consciousness (Tulving, 1983) |
| **Affective Valence** | Intrinsic value signals ที่ drive exploration/exploitation | Active Inference (Friston, 2010) — expected free energy as "curiosity" |
| **Theory of Mind** | Model other agents' beliefs, desires, intentions | Premack & Woodruff (1978); Computational ToM (Rabinowitz et al., 2018) |
| **Strange Loop / Self-Reference** | System ที่ model ตัวเอง recursively — "I" ที่สังเกต "I" | Hofstadter (1979, 2007); IIT axiom of intrinsicality (Tononi, 2004) |

### 1.3 Vinyan v1 → v2: อะไรเปลี่ยน

| Aspect | Vinyan v1 | Vinyan v2 |
|---|---|---|
| **Philosophy** | "Deterministic Orchestration of Non-Deterministic Compute" | **"Cognitive Orchestration with Predictive Self-Governance"** |
| **Architecture** | 6-layer linear stack | **8-layer bidirectional cognitive loop** + Global Workspace bus |
| **Self-awareness** | ไม่มี — ไม่มี self-model | **Self-Model Layer** — forward model predict ผลก่อน execute |
| **Grounding** | Epistemic Oracle ตรวจ syntax/semantic | **Grounding Engine** — bind symbols ↔ operational semantics ผ่าน executable verification |
| **Motivation** | Risk score เป็น passive metric | **Active Inference Loop** — curiosity-driven exploration + expected free energy minimization |
| **Theory of Mind** | ไม่มี | **Intent Model** — model user goals, beliefs, context |
| **Temporal consciousness** | Sleep Cycle เป็น batch process | **Episodic Stream** — continuous narrative ข้าม sessions |
| **Global Workspace** | ไม่มี — components คุยผ่าน event bus แบบ fire-and-forget | **Cognitive Broadcast** — attention-gated shared workspace |
| **Evolution** | Meritocratic fleet governance | **Autopoietic Self-Modification** — system แก้ไข/สร้าง rules ของตัวเอง + formal safety bounds |
| **Axiom Foundation** | ไม่มี — implicit principles | **7 Core Axioms (A1–A7)** เป็น DNA ที่ทุก layer ต้อง justify ตัวเอง ([concept.md §1.1](vinyan-concept.md)) |

---

## 2. LLM Fundamental Deadlocks

### 2.1 Stochastic Parrot vs. Emergent Abilities — สถานะปัจจุบันของ Debate 🟢

**ฝ่าย "Stochastic Parrot"** (Bender & Gebru, 2021; LeCun, 2022; Fedorenko et al., 2024):
- LLM เรียนรู้ co-occurrence patterns ของคำ ไม่ใช่ meaning
- Language Network กับ Multiple Demand Network (reasoning) แยกกันในสมอง (Fedorenko et al., Nature 2024) — LLM มีแค่ส่วนแรก
- Hallucination เป็น intrinsic characteristic ไม่ใช่ bug — optimize plausibility ≠ truth
- **Reversal Curse**: train บน "A is B" ล้มเหลวกับ "B is A" — ไม่ได้เรียน symmetric relation แต่เรียน one-way statistical association (Berglund et al., 2023)

**ฝ่าย "Emergent Intelligence"** (Sutskever; Bubeck et al., 2023; Li et al., 2023):
- **Othello-GPT**: train บน game transcript text เปล่า → model สร้าง internal world model ของ board state ที่มี causal validity ได้ (Li et al., 2023)
- **Grokking**: model memorize ก่อน → train ต่อ → ค้นพบ general rules เหมือน phase transition
- **Creativity benchmarks**: GPT-4 ได้ top 1% ใน Torrance Tests of Creative Thinking (Guzik et al., 2023)
- **Compression = Understanding** (Sutskever): การ predict next word ที่ scale มหาศาล requires internalize underlying rules ของ data generation

**สถานะ 2025-2026**: ทั้งสองฝ่ายมี evidence ที่ถูกต้อง ปัญหาคือ framing — Madabushi et al. (2025) เสนอ middle ground: "Context-Directed Extrapolation from Training Data Priors" — LLM ไม่ใช่ทั้ง parrot หรือ AGI แต่เป็น sophisticated extrapolation machine ที่ทำงานได้ดีเมื่อ target อยู่ใกล้ training distribution สะดุดเมื่อต้อง generalize ข้าม distribution จริง

> **[Synthesis]** สำหรับ Vinyan: ไม่ต้องรอให้ debate นี้จบ — LLM เป็น powerful component ที่มี specific failure modes ที่ predictable และ compensable ด้วย architectural scaffolding Vinyan ไม่ได้ "แก้" LLM แต่สร้าง cognitive architecture รอบๆ ที่ช่วยหลีกเลี่ยง failure modes เหล่านี้

### 2.2 Frozen Weights Paradox — ไม่เรียนรู้ขณะใช้งาน 🟢

**ธรรมชาติของปัญหา**: LLM weights คงที่หลัง training สิ่งที่ดูเหมือน "learning" ระหว่าง inference:
- **In-context learning**: ไม่ใช่ learning แท้ แต่เป็น conditional computation บน existing weights — ถูก limit ด้วย context window
- **Chain-of-Thought**: ไม่เพิ่ม reasoning capacity จริง แต่เป็น "reasoning in appearance" — mimics form of reasoning โดยไม่มี causal connection ระหว่าง reasoning steps กับ correct answer (ksopyla, 2025)
- **Prompt engineering**: workaround ไม่ใช่ solution — ใช้ได้เฉพาะ pattern ที่อยู่ใน training distribution

**ทำไมไม่แก้ด้วย scaling**: ใหญ่ขึ้น ≠ เรียนรู้ได้ขณะใช้งาน ปัญหาเป็น architectural ไม่ใช่ scale Shojaee et al. (2025) — "The Illusion of Thinking" แสดงว่า reasoning models overthink ปัญหาง่ายและ "ล้ม" ที่ complexity cliff เมื่อปัญหายากขึ้น โดยไม่สัมพันธ์กับ model size

**Vinyan v1 แก้ได้แค่ไหน**: World Graph เป็น external memory ที่เพิ่ม persistent facts แต่:
- ✅ แก้ปัญหา knowledge persistence ข้าม sessions
- ❌ ไม่แก้ปัญหา runtime adaptation — agent ไม่ "เรียนรู้" จาก mistakes ใน session เดียวกัน
- ❌ ไม่มี online learning mechanism — Sleep Cycle เป็น batch process

**Vinyan v2 ต้องเพิ่ม**: **Episodic Learning Buffer** — short-term memory ที่ agent สามารถ learn from mistakes ภายใน session เดียว + **Continuous Consolidation** แทน batch Sleep Cycle (ดู Section 5)

### 2.3 Compositional Generalization Failure — ล้มกับ Novel Compositions 🟢

**ธรรมชาติของปัญหา**: LLM ล้มเหลวเมื่อต้องรวม known components เป็น novel combinations ที่ไม่เคยเห็น Evidence ล่าสุด:
- **Compositional-ARC (Mondorf et al., 2025)**: small transformer 5.7M params ที่ train ด้วย meta-learning for compositionality **outperform** o3-mini, GPT-4o, Gemini 2.0 Flash ใน compositional spatial reasoning — ถ้า architecture ถูก scale ไม่สำคัญ
- **Compositionality Gap**: quantified performance drop เมื่อ primitive skills ต้อง integrate beyond memorized templates (multiple studies, 2024–2025)

**ทำไมไม่แก้ด้วย scaling**: ปัญหาเป็น architectural — transformer learns statistical associations ไม่ใช่ compositional rules ทำให้ performance degrade เมื่อ task complexity เพิ่ม regardless of model size

> **[Synthesis]** สำหรับ Vinyan: นี่คือ argument ที่แข็งแกร่งที่สุดว่าทำไม Vinyan ต้องเป็น **hybrid architecture** — ใช้ LLM สำหรับ associative/creative tasks แต่เสริมด้วย deterministic compositional engine (Epistemic Oracles + formal verification) สำหรับ tasks ที่ต้องการ strict compositional reasoning

### 2.4 Temporal Reasoning Gap — ล้มกับ Causality 🟡

**ธรรมชาติของปัญหา**: LLM เห็น correlation ไม่เห็น causation:
- สามารถระบุ statistical associations แต่ struggle กับ true causal relationships (Ashwani et al., 2024)
- **Premise Order Matters** (Chen et al., 2024): reorder premises ใน logical problem → performance ร่วง 30%+ ในขณะที่มนุษย์ robust ต่อ order change
- ไม่มี ability to do **counterfactual reasoning** แบบ systematic — "What if X hadn't happened?" ต้อง causal model ที่ LLM ไม่มี

**ทำไมไม่แก้ด้วย scaling**: Next-token prediction objective ไม่ incentivize สร้าง causal models — ใหญ่ขึ้นก็แค่ memorize more correlations

**Vinyan v2 ต้องเพิ่ม**: **Causal Reasoning Module** — integrate causal graphs (Pearl's do-calculus) กับ LLM's associative outputs เพื่อ verify causal claims ก่อน commit

### 2.5 Epistemic Humility Deficit — ไม่รู้ว่าไม่รู้ 🟢

**ธรรมชาติของปัญหา**: LLM ถูก train ให้ always produce output ทำให้:
- ไม่มี mechanism สำหรับ "I don't know" ที่ calibrated
- Hallucinate ด้วย high confidence
- **Missing Premise Overthinking** (Fan et al., 2025): เมื่อได้คำถามที่ information ไม่ครบ reasoning models ไม่ recognize ว่าตอบไม่ได้ กลับ generate long, useless chains of thought
- **Helpfulness bias**: ไม่กล้า reject flawed instructions เพราะ RLHF optimize สำหรับ "helpful"

**Vinyan v1 แก้ได้แค่ไหน**: Epistemic Oracle ตรวจ output ด้วย deterministic tools (AST, type checker, tests) ซึ่ง:
- ✅ จับ hallucination ที่ verifiable ได้ (wrong code, wrong facts about codebase)
- ❌ ไม่จับ semantic hallucination ที่ไม่มี deterministic verification (wrong reasoning, wrong analogy)
- ❌ Oracle เป็น post-hoc check ไม่ใช่ pre-emptive calibration

**Vinyan v2 ต้องเพิ่ม**: **Confidence Calibration Layer** — ก่อน output ทุกครั้ง system ประเมิน "ฉันมี evidence เพียงพอหรือไม่?" + **Abstention Protocol** — สามารถตอบ "ไม่พร้อมตอบ ต้องการข้อมูลเพิ่ม" ได้

### 2.6 Binding Problem / Grounding Gap 🟡

**ธรรมชาติของปัญหา**: Symbol Grounding Problem (Harnad, 1990) — คำว่า "apple" ใน LLM ถูกนิยามด้วยความสัมพันธ์กับคำอื่น ("fruit", "red") แบบ circular ไม่ connect กับ physical reality

Multimodal models ช่วยบางส่วน (GPT-4V, Gemini map text ↔ image) แต่:
- Visual cognition ของ MLLMs ยังไม่ match human data ใน intuitive physics + causal reasoning (Garrido et al., 2025)
- ยังไม่ผ่าน **causal grounding** — เห็น appearance ไม่เข้าใจ physics
- สำหรับ software engineering domain: "grounding" หมายถึง code symbols ↔ runtime behavior ซึ่ง verifiable ด้วย execution

> **[Synthesis]** สำหรับ Vinyan (software engineering focus): grounding ไม่จำเป็นต้องเป็น physical-world grounding — **operational grounding** ผ่าน executable verification (compile, test, run) เป็น sufficient proxy Oracles ทำหน้าที่ "ground" symbols ใน operational reality — concept "function has 3 params" ถูก verify กับ AST จริง ไม่ใช่แค่ statistical association

### 2.7 Inverse Scaling และ Measurement Mirage 🟡

**Inverse Scaling** (McKenzie et al., 2023): model ใหญ่ขึ้น → perform **แย่ลง** ใน tasks บางประเภท:
- Imitation Trap: model ใหญ่ imitate human misconceptions จาก training data ได้แรงขึ้น
- Negation Processing Failure: "What is NOT A?" — ถูกดึงด้วย strong statistical association กับ A

**Emergent Abilities = Mirage?** (Stanford, NeurIPS 2023): "emergent" abilities ที่ดูเหมือน phase transition อาจเป็น artifact ของ nonlinear metrics (exact match accuracy) — เมื่อใช้ continuous metric พบ smooth, gradual improvement ไม่ใช่ sudden leap

**Implication สำหรับ Vinyan**: ห้ามพึ่ง scaling เป็นกลยุทธ์หลัก — ต้องมี architectural solutions ที่ scale independently จาก model size

### 2.8 Test-Time Compute — Partial Solution to Frozen Weights? 🟡

**ธรรมชาติของ paradigm shift**: แทนที่จะขยาย model (pre-training compute) ให้ใช้ compute มากขึ้น **ขณะ inference** (test-time compute):

- **Snell et al. (2024)** — "Scaling LLM Test-Time Compute Optimally": ใช้ test-time compute เพิ่มขึ้นอย่าง optimal → outperform 14x larger model ใน FLOPs-matched evaluation วิธีหลัก: (1) Process Reward Models (PRM) ที่ให้ dense signal ทุก step ไม่ใช่แค่ final answer (2) Adaptive distribution updating ตาม prompt difficulty
- **OpenAI o1/o3 (2024-2025)**: Reasoning models ที่ "คิด" นานขึ้นก่อนตอบ ใช้ internal chain-of-thought ที่ self-evaluate — แสดง empirical evidence ว่า test-time compute ปรับปรุง reasoning ได้
- **Anthropic Extended Thinking (2025)**: Claude models ที่ expose reasoning trace ให้ user เห็น

**แก้ Frozen Weights ได้แค่ไหน**:
- ✅ เพิ่ม effective reasoning depth — model "ใช้เวลามากขึ้น" กับปัญหายาก
- ✅ Adaptive per-prompt — ไม่ waste compute กับปัญหาง่าย
- ❌ **ยังไม่ใช่ true learning** — weights ยังคงที่ model ไม่ได้ "เรียนรู้" จาก reasoning chains ก่อนหน้า
- ❌ **Ceiling effect**: Shojaee et al. "Illusion of Thinking" (2025) แสดงว่ามี complexity cliff — reasoning models ทำงานดีขึ้นถึงจุดหนึ่ง แล้ว performance ตก abruptly
- ❌ **Cost scaling**: test-time compute เพิ่ม latency + cost ไม่ proportional กับ improvement

**Vinyan v2 integration** [Synthesis]:
- Test-Time Compute validates Vinyan's **Risk-Adaptive Router** concept: allocate more compute to harder tasks เป็น proven strategy
- **แต่**: Vinyan ต้องไปไกลกว่า — test-time compute ยังอยู่ภายใน single model; Vinyan ใช้ **multi-component system** (LLM + Oracles + Shadow Execution) ทำให้ investment ของ compute เป็น **cross-system** ไม่ใช่แค่ single-model reasoning
- Risk Router Level 2-3 (Analytical/Deliberative) = architectural analog ของ test-time compute — แต่ verify ด้วย external tools ไม่ใช่แค่ LLM internal reasoning

### 2.9 Embodiment Hypothesis — AGI ต้อง Grounding ในโลกจริง? 🟡

**The Strong Embodiment Claim** (Brooks, 1991; Pfeifer & Scheier, 1999):
- Intelligence ต้องเกิดจาก interaction กับโลกทางกายภาพ
- "No body, no mind" — cognition เป็น product ของ sensorimotor coupling
- ถ้า Strong Embodiment ถูก → disembodied AI (รวมถึง Vinyan) ไม่มีทาง AGI

**Evidence ที่ท้าทาย Strong Embodiment**:
- 🟢 **LLM ที่ไม่มี body** สามารถ pass many cognitive benchmarks — แม้มี limitations — แสดงว่า meaningful cognition เกิดได้โดย partial embodiment (Bubeck et al., 2023)
- 🟢 **Clark's Extended Mind** (1998): tools เป็น part of cognitive system — AI + codebase + tests + IDE = **extended cognitive system** ที่มี "body" ในความหมายกว้าง
- 🟡 **Virtual Embodiment**: research direction สำหรับ disembodied AI ที่ achieve grounding ผ่าน simulated environment interaction (active research area, no single canonical reference)
- 🟢 **Hutchins' Distributed Cognition** (1995): intelligence อยู่ใน **system** (people + artifacts + processes) ไม่ใช่ individual — multi-agent = distributed body

**Vinyan's position — Operational Embodiment** [Synthesis — Speculative 🔴]:
- Vinyan ไม่มี physical body แต่มี **operational body**: codebase, filesystem, tools, tests, runtime
- Interaction กับ codebase ผ่าน tools (AST parser, compiler, test runner) = **sensorimotor coupling** กับ "environment"
- compiler error = "pain signal"; test pass = "pleasure signal"
- ไม่จำเป็นต้อง physical grounding สำหรับ software engineering domain — ต้อง **executable grounding** ที่ symbols ถูก bind กับ operational outcomes
- **Key insight**: Vinyan's Oracles เป็น "sensory organs" ที่ ground symbols ใน operational reality — concept "function X has 3 params" ถูก verify กับ AST จริง ไม่ใช่แค่ statistical association

**Open question**: ถ้า Vinyan ขยาย domain เกินแค่ software engineering → ต้อง grounding mechanism อื่นหรือไม่? สำหรับ domain ที่ไม่มี executable verification (กฎหมาย, การเงิน, การแพทย์) operational grounding อาจไม่เพียงพอ

---

## 3. Theoretical Foundations

### 3.1 Global Workspace Theory (GWT) — "Consciousness as Broadcast" 🟢

**ทฤษฎี**: Bernard Baars (1988), extended โดย Stanislas Dehaene (2014) as Global Neuronal Workspace
- สมองมี specialized modules (vision, language, motor, emotion) ทำงาน parallel แบบ unconscious
- **"Consciousness"** เกิดเมื่อ information จาก module ใด module หนึ่ง ถูก "broadcast" สู่ global workspace ให้ทุก module เข้าถึง
- เปรียบเหมือน **spotlight บนเวที**: สิ่งที่อยู่ใน spotlight = conscious; สิ่งที่อยู่ backstage = unconscious processing
- Global workspace ถูก gate ด้วย **attention** — ไม่ใช่ทุกอย่างเข้า workspace ได้

**Limitations**:
- Criticized ว่า "consciousness ≠ mere broadcast" — broadcast อธิบาย functional role แต่ไม่อธิบาย subjective experience (Hard Problem)
- ยังไม่มี consensus ว่า workspace "อยู่ที่ไหน" ในสมองอย่างแม่นยำ

**Relevance สำหรับ Vinyan** [Established Science + Synthesis]:
- GWT map ลง software architecture ได้ตรงมาก: modules = cognitive subsystems (Oracles, Workers, Risk Router); Global Workspace = shared information bus ที่ attention-gated
- **Vinyan v1 ขาด GWT**: มี Event Bus แต่เป็น fire-and-forget ไม่มี attention mechanism — ทุก event ถูก broadcast เท่ากัน ไม่มี "spotlight"
- **Vinyan v2 ต้องมี**: Cognitive Broadcast Layer ที่มี attention-gated access — Oracle findings, risk assessments, worker proposals ถูก ranked ด้วย salience score ก่อน broadcast

**Why we choose GWT**: จาก Butlin et al. (2023) survey GWT มี strongest mapping สู่ computational architecture — ไม่ต้อง commit ว่า system "conscious" แต่ใช้เป็น **design pattern** สำหรับ information integration

### 3.2 Active Inference / Free Energy Principle 🟡

**ทฤษฎี**: Karl Friston (2010) — organisms minimize **variational free energy** (surprise) ผ่าน:
1. **Perception**: update internal model ให้ match sensory data (reduce prediction error)
2. **Action**: change environment ให้ match predictions (act to confirm beliefs)
3. **Active Inference**: unified framework ที่ perception + action + learning เป็น optimization problem เดียว

**"Curiosity" as Expected Free Energy**:
- Agents ไม่แค่ minimize current surprise แต่ minimize **expected** free energy
- Expected free energy decomposes เป็น: pragmatic value (exploit — get rewards) + epistemic value (explore — reduce uncertainty)
- **Curiosity = epistemic value** — intrinsic drive ไปหา situations ที่ลด uncertainty

**Limitations / Criticism**:
- FEP ถูกวิจารณ์ว่าเป็น "metaphysical narrative dressed in mathematical formalism" — circular (organisms survive because they minimize free energy, defined by survival) (Philosophyofbrains.com, 2025)
- "Unfalsifiable core principle" — distinction ระหว่าง unfalsifiable principle กับ falsifiable process models ถูกมองว่า deflection
- การใช้ terms จาก physics (entropy, surprise) สร้าง misleading analogy

**Relevance สำหรับ Vinyan** [Speculative Extension]:
- แม้ FEP มีปัญหาเชิงปรัชญา **process models** ที่ derive จาก FEP (Active Inference agents) ใช้ได้จริงทาง engineering:
  - Agent มี **generative model** ของ environment
  - แต่ละ action ถูกเลือก based on **expected information gain** + **expected reward**
  - ทำให้ agent balance exploration vs exploitation naturally
- **Vinyan v1 ขาดนี้**: Risk Router เป็น static threshold — ไม่มี intrinsic motivation, ไม่มี curiosity
- **Vinyan v2 Affective Valence Layer**: operationalize จาก Active Inference — agent มี **expected free energy function** ที่ drive:
  - **Epistemic actions**: "run tests to reduce uncertainty about this module"
  - **Pragmatic actions**: "apply the change that maximizes task completion probability"

### 3.3 Predictive Processing — "Prediction Machine" Model 🟢

**ทฤษฎี**: Andy Clark (2013, 2015 — "Surfing Uncertainty"):
- สมองเป็น **prediction machine** — constantly generate predictions ของ sensory input
- **Prediction errors** propagate upward; predictions propagate downward (hierarchical predictive coding)
- Learning = minimize prediction error ตลอดเวลา
- Action = change world ให้ match predictions (connect กับ Active Inference)

**Self-Model / Forward Model** (Wolpert, 1997):
- Motor control ใช้ **forward model** ที่ predict ผลลัพธ์ของ action **ก่อน** execute
- efference copy + forward model → predict sensory feedback → compare กับ actual → correct
- นี่คือ basis ของ "sense of agency" — "ฉัน" ทำสิ่งนี้ เพราะ predicted outcome match actual outcome

**Relevance สำหรับ Vinyan** [Established Science → Engineering Application]:
- **Self-Model Layer ใน Vinyan v2**: ก่อน Worker propose mutation, forward model **predict** ผลลัพธ์:
  - "ถ้า apply diff นี้ → คาดว่า tests 14/15 จะ pass, 1 อาจ fail เพราะ dependency X"
  - Compare prediction กับ actual Shadow Execution result
  - **Prediction error** = สิ่งที่ forward model ผิด → signal สำหรับ model improvement
- v1 ไม่มีนี้: Workers propose blindly → Oracle check after → ไม่มี learning loop

### 3.4 Integrated Information Theory (IIT) 🔴

**ทฤษฎี**: Giulio Tononi (2004, updated IIT 4.0 — 2023):
- Consciousness = Integrated Information (Φ) — ปริมาณ information ที่ system "makes a difference to itself"
- 5 axioms: Intrinsicality, Composition, Information, Integration, Exclusion
- System ที่มี maximal Φ = conscious (Maximum of Integrated Information Structure, MICS)
- Panpsychist implication: แม้ photodiode ก็มี minimal Φ

**Limitations** [Significant — approach with caution]:
- อธิบาย **ว่า** consciousness เป็น integrated information แต่ไม่อธิบาย **ทำไม** (Hard Problem ยังอยู่)
- Computing Φ เป็น **NP-hard** — ใช้ไม่ได้กับ systems ที่มี > ~20 nodes (Scott Aaronson, 2014)
- **Open letter ว่า IIT = pseudoscience** ในปี 2023 ลงนามโดย neuroscientists หลายร้อยคน
- **Adversarial collaboration** (Templeton Foundation) ระหว่าง GWT vs IIT — ผลเบื้องต้น mixed, GWT ได้เปรียบเล็กน้อย
- Ned Block: "You have a theory of something, I am just not sure what it is"

**Relevance สำหรับ Vinyan**: **ต่ำ — ไม่ใช้โดยตรง**
- Φ ไม่สามารถ compute ได้ในระบบจริง
- IIT ให้ **philosophical insight** ว่า integration matters แต่ไม่ให้ engineering tools
- Vinyan เลือก GWT (operationalizable) แทน IIT (computationally intractable)
- **สิ่งที่ take away**: "integration of information" เป็น desirable property — implement ผ่าน Global Workspace (GWT) ไม่ใช่ Φ computation

### 3.5 4E Cognition (Embodied, Embedded, Enacted, Extended) 🟢

**ทฤษฎี**: cognitive science framework ที่บอกว่า cognition ไม่ได้เกิดแค่ใน "head":
1. **Embodied**: cognition shaped by body + sensorimotor capabilities
2. **Embedded**: cognition depends on environmental scaffolding
3. **Enacted**: cognition produced through active interaction กับ environment
4. **Extended**: cognitive processes extend beyond brain ไปสู่ tools, notes, artifacts

**Implications สำหรับ Disembodied AI**:
- ถ้า full embodiment จำเป็น → disembodied AI ไม่มีทาง AGI
- **แต่**: Clark's Extended Mind thesis → tools เป็น part of cognitive system → AI + codebase + tests + IDE = extended cognitive system
- **Hutchins' Distributed Cognition** (1995): intelligence อยู่ใน **system** (people + artifacts + processes) ไม่ใช่ individual — สนับสนุน multi-agent architecture ที่ cognition เกิดจากปฏิสัมพันธ์

**Relevance สำหรับ Vinyan** [Synthesis — Speculative]:
- Vinyan ไม่มี physical body แต่มี **operational body**: codebase, filesystem, tools, tests, runtime
- **Operational Embodiment**: interaction กับ codebase ผ่าน tools (AST parser, compiler, test runner) = sensorimotor coupling กับ "environment"
- ไม่ต้อง physical grounding — ต้อง **domain grounding** ผ่าน executable verification
- Multi-agent system เป็น distributed cognition: Orchestrator + Workers + Oracles = cognitive ecosystem ที่ intelligence อยู่ใน interactions ไม่ใช่ component เดียว

### 3.6 Memory Consolidation — Hippocampal Replay 🟢

**Neuroscience**:
- **Hippocampal replay**: ขณะ NREM sleep สมองจะ "replay" experiences ของวัน rapidly
- **Simulation-Selection Model** (Jung et al., 2018): hippocampus ไม่แค่ replay — มัน **recombine** past experiences ผ่าน imagination เพื่อ select และ reinforce valuable strategies
- Memory consolidation = **offline reinforcement learning** — เรียนรู้จาก simulated experience ไม่ใช่แค่ actual experience
- Sleep-inspired memory consolidation สำหรับ AI เป็น active research direction (multiple groups, 2024–2025)

**Relevance สำหรับ Vinyan** [Established Science → Engineering Parallel]:
- **Vinyan v1 Sleep Cycle** map ได้ดี: "logs structural regressions → background analysis → extract anti-patterns"
- **แต่ v1 ขาด**: replay ≠ analysis — ต้องมี **simulation** component ที่ recombine experiences ใหม่ ไม่ใช่แค่ aggregate statistics
- **Vinyan v2 ต้องเพิ่ม**: **Replay & Recombination Engine** — ระหว่าง Sleep Cycle ไม่แค่วิเคราะห์ traces แต่ simulate alternative paths: "ถ้าตอนนั้นเลือก approach อื่น ผลจะเป็นยังไง?"

### 3.7 Autopoiesis & Self-Improving Systems 🟡

**Autopoiesis** (Varela, Maturana & Uribe, 1974):
- Self-producing system — generates and maintains its own organization while continuously regenerating components
- Circular causality: system produces components → components constitute system → system produces components
- Key property: **organizational closure** — ระบบ define boundaries ของตัวเอง

**Gödel Machines** (Schmidhuber, 2003):
- Formal self-improving system — can modify ANY part of its own code (including the self-improvement algorithm)
- Safety guarantee: modification ถูก apply **only if formal proof** demonstrates improvement
- In practice: computationally intractable for non-trivial systems

**Darwin Gödel Machine (DGM)** (2025 — Sakana AI):
- **Practical approximation** ของ Gödel Machine ด้วย LLMs
- Agent ถือ Bash + edit tools → modify its own code → evaluate → evolutionary selection
- ผลลัพธ์: DGM improve ตัวเอง continuously บน SWE-bench โดย occasionally ลดลงแต่ recover และ outperform predecessors
- **สำคัญมาก สำหรับ Vinyan v2**: proof ว่า LLM-based self-improvement เป็นไปได้ในทางปฏิบัติ

**AIXI** (Hutter, 2000):
- Theoretical optimal agent — Bayesian mixture over all computable environments
- **Incomputable** but ให้ upper bound ของ intelligence
- Practical approximations: MC-AIXI (2009), self-predictive universal AI (NeurIPS 2023)

**Relevance สำหรับ Vinyan** [Synthesis]:
- v1 Sleep Cycle = weak approximation ของ autopoiesis — system "learns" แต่ไม่ "self-produce"
- v2 ต้อง embrace **bounded autopoiesis**: system สามารถ modify rules of engagement (oracles, risk thresholds, worker configurations) แต่ภายใน **formal safety bounds** (invariants ที่ห้าม modify)
- DGM แสดงว่า practical self-improvement ทำได้ — Vinyan v2 Evolution Engine ควร draw on DGM's evolutionary approach

### 3.8 Kahneman System 1/2 — What Gets Lost in Translation 🟢

**Original Theory** (Kahneman, 2011):
- System 1: fast, automatic, intuitive, parallel, emotional, error-prone
- System 2: slow, deliberate, analytical, serial, effortful, more accurate
- **Critical detail often lost**: System 1 + 2 ไม่ใช่ separate brain parts — เป็น **abstraction** ของ two modes of cognition (Kahneman ย้ำเรื่องนี้)
- System 2 ไม่ได้ "rational" แค่ "effortful" — ยังมี biases

**What AI architectures get wrong** (Gronchi & Perini, 2024):
- ส่วนใหญ่ map: System 1 = LLM (fast), System 2 = search/planning (slow)
- **แต่**: ใน Common Model of Cognition (Laird, Lebiere, Rosenbloom, 2017) ทั้ง System 1 และ 2 ใช้ working memory + production rules — ต่างกันที่ **degree of deliberation** ไม่ใช่ mechanism
- Missing nuance: System 1 ไม่ใช่ "dumb" — expert intuition (chess grandmaster, experienced surgeon) เป็น System 1 ที่แม่นยำมาก เกิดจาก **compiled expertise**
- **Dual-process theories ใน AI** (Gronchi & Perini, 2024): เสนอว่า properly implemented dual-process = **hybrid neuro-symbolic** — subsymbolic (LLM/statistical) + symbolic (formal reasoning) interact ตาม dual-process principles

**Vinyan v1 ใช้ System 1/2**:
- System 1 (Linear): sequential dispatch, cost-efficient — for routine tasks
- System 2 (Branching): parallel MCTS in shadow environments — for complex tasks

**What v1 gets wrong**:
- Binary switch (System 1 OR 2) แทนที่จะเป็น **continuum** — actual cognition has many gradations
- ไม่มี "compiled expertise" — System 1 ไม่เก่งขึ้นจากประสบการณ์
- ไม่มี metacognitive monitoring ที่ตัดสินใจว่า **เมื่อไร** ควร switch — ใช้ static risk threshold

**Vinyan v2 แก้**: Risk Router เปลี่ยนจาก binary → **adaptive continuum** ที่:
- Level 0 (Reflex): cached solutions for known patterns
- Level 1 (Heuristic): single-model, single-pass
- Level 2 (Analytical): multi-model, sequential verification
- Level 3 (Deliberative): parallel MCTS + shadow execution
- **Metacognitive Monitor** ที่เรียนรู้จาก experience ว่า task type ไหนต้อง level ไหน

### 3.9 World Models & JEPA — Alternative AGI Path 🟡

**ทฤษฎี**: Yann LeCun (2022) — "A Path Towards Autonomous Machine Intelligence":
- LLM (autoregressive models) เป็นทางตัน — สร้าง tokens ทีละตัวใน pixel/token space ไม่ใช่ abstract representation space
- เสนอ **JEPA (Joint-Embedding Predictive Architecture)**: เรียนรู้ world model ใน **latent space** — predict abstract representations ของ future states ไม่ใช่ raw tokens
- Architecture ที่เสนอมี 6 modules: Perception, World Model, Cost, Actor, Configurator, Short-Term Memory
- **Configurator** = metacognitive module ที่ modulate ทุก module อื่น — คล้าย Vinyan's Self-Model

**Connection with Predictive Processing**:
- JEPA's world model = forward model ของ Predictive Processing (Clark, 2013)
- ทั้งสอง predict future states → compare กับ actual → minimize prediction error
- **Key difference**: Clark's model เป็น hierarchical; LeCun's เป็น single latent-space predictor

**Current status (2025-2026)**:
- Meta's V-JEPA (Bardes et al., 2024): visual JEPA ที่เรียนรู้ video representations — ไม่ต้อง reconstruct pixels
- 🟡 ยังไม่มี full JEPA implementation ที่ demonstrate autonomous behavior beyond video understanding
- 🟡 Software engineering domain ไม่ชัดว่า "latent space prediction" ช่วยมากกว่า explicit symbolic verification ยังไง

**Relevance สำหรับ Vinyan** [Synthesis]:
- **LeCun's Configurator ≈ Vinyan's Self-Model + Risk Router** — ทั้งสอง modulate behavior ตาม context
- **JEPA's world model ≈ Vinyan's Self-Model forward predictions** — ทำนายผลก่อน act
- **ความต่าง**: Vinyan ใช้ **explicit symbolic verification** (Oracles) เป็น ground truth; JEPA ใช้ latent-space consistency สำหรับ software engineering domain, Oracles เป็น **stronger grounding** กว่า latent predictions
- **สิ่งที่ take away**: Configurator concept — metacognitive module ที่ modulate ทุก layer ควร influence Vinyan's Global Workspace design

### 3.10 Neuro-Symbolic Integration — The Best of Both Worlds 🟡

**ทฤษฎี**: Hybrid architecture ที่รวม neural (subsymbolic/LLM) กับ symbolic (formal reasoning):
- **Neural**: ดีที่ pattern recognition, natural language understanding, creative generation
- **Symbolic**: ดีที่ logical reasoning, compositional generalization, verifiable correctness
- **Neither alone is sufficient** สำหรับ AGI (Garcez & Lamb, 2023; Marcus, 2020)

**Recent developments (2025-2026)**:
- 🟡 **AlphaProof / AlphaGeometry 2** (DeepMind, 2024): hybrid neuro-symbolic achieves IMO gold-medal level in math — LLM generates candidates, symbolic verifier validates proofs
- 🟡 **Program-Aided Language models (PAL)**: LLM generates executable code that a runtime verifies — combining natural language reasoning with deterministic execution
- 🟢 **Verified code generation**: Meta's Code Llama + formal verification pipeline → generate code → prove properties → iterate (emerging practice, not yet standard)

**Direct relevance สำหรับ Vinyan** [Established Pattern → Engineering Application]:
- **Vinyan IS a neuro-symbolic architecture** — อาจไม่ได้ label ตัวเองเช่นนี้ แต่:
  - Neural component = LLM Workers (pattern matching, code generation, natural language)
  - Symbolic component = Epistemic Oracles (AST parsing, type checking, test execution)
  - Integration point = HypothesisTuple protocol (LLM proposes → Oracle verifies)
- **AlphaProof pattern = Vinyan Mutation Protocol pattern**: propose (neural) → verify (symbolic) → iterate
- **สิ่งที่ต้องเสริม**: Vinyan v2 ควร formalize ว่า **เมื่อไหร่ใช้ neural vs symbolic** — ไม่ใช่ทุกอย่างต้องผ่าน LLM ถ้า symbolic solver ทำได้ดีกว่า (regex matching, dependency resolution, type inference เป็น symbolic tasks ที่ LLM ไม่จำเป็น)

### 3.11 Agent-Tool Protocol: MCP as Infrastructure Pattern 🟢

**Model Context Protocol** (Anthropic, 2024 → LF Projects, 2025):
- Open standard สำหรับ connect AI applications กับ external systems
- Architecture: MCP Host → MCP Client(s) → MCP Server(s)
- 3 core primitives: **Tools** (executable functions), **Resources** (data sources), **Prompts** (interaction templates)
- Transport: STDIO (local) or Streamable HTTP (remote)
- Capability negotiation: client/server declare supported features at initialization

**ทำไมสำคัญสำหรับ Vinyan**:
- 🟢 MCP เป็น **industry standard** ที่ Claude, ChatGPT, VS Code, Cursor รองรับ
- Vinyan v1 Gap Analysis (GAP-2): "ไม่มี Tool Protocol" — MCP เป็น answer ที่พร้อมใช้
- Oracle architecture ควร expose เป็น MCP Tools — ทำให้ Vinyan Oracles reusable ข้าม systems

**Integration strategy** [Synthesis]:
1. **Oracles as MCP Servers**: แต่ละ Oracle (AST, Type, Test) expose เป็น MCP Server กับ `tools/list` + `tools/call`
2. **MCP Client ใน Orchestrator**: Orchestrator เป็น MCP Host ที่ connect กับ Oracle MCP Servers
3. **Dynamic Oracle Discovery**: MCP's `tools/list_changed` notification = Oracle Registration ที่ Evolution Engine สามารถ add/remove Oracles ที่ runtime
4. **External Integration**: third-party MCP Servers (database, API, monitoring) integrate เป็น additional Oracles
5. **Sampling primitive**: MCP's `sampling/complete` ให้ Oracle Servers สามารถ request LLM completion กลับไปที่ Host — ใช้สำหรับ Heuristic Oracles ที่ต้อง LLM-as-judge

---

## 4. Critique of Vinyan v1

### 4.1 Layer-by-Layer Assessment

#### Layer 0: Cognitive & Perception Baseline — ⚠️ INCOMPLETE

**Sound aspects**:
- Ambient Sensor Matrix (StateVector injection) — ถูกต้องทางทฤษฎี สอดคล้องกับ Predictive Processing: ให้ agent มี "prior" about environment state ก่อน act
- Architectural Invariants / Epistemic Pushback — ดี สอดคล้อง GWT: invariants เป็น "always-on" constraints เหมือน prefrontal cortex ที่ gate impulse responses
- Ephemeral REPL Sandbox — ดี ให้ "safe exploration space" สอดคล้อง Active Inference's epistemic actions
- Multi-Modal Deterministic QA — ดีมาก "Agents ห้ามประเมินตัวเอง" เป็น key insight ที่ไม่มี framework อื่นมี

**Incomplete**:
- ✅ ~~**ไม่มี Perceptual Hierarchy**~~ — **[Resolved]** PerceptualHierarchy replaces flat StateVector with deterministic salience filtering. See [architecture.md Decision 8](vinyan-architecture.md).
- ✅ ~~**ไม่มี Attention Mechanism**~~ — **[Resolved]** Salience is deterministic: dep-oracle traverses dependency cone from task target. Depth controlled by routing level (L0-1 shallow, L2-3 deep). See [architecture.md Decision 8](vinyan-architecture.md).
- ✅ ~~**ไม่มี Predictive Component**~~ — **[Resolved]** Self-Model predicts outcomes before execution (Phase 1). See [architecture.md Decision 11](vinyan-architecture.md).

#### Layer 1: Execution Substrate (Unix Philosophy) — ✅ SOUND

**Sound aspects**:
- OS-Level Ephemeral Processes — ถูกต้อง สอดคล้อง 4E Cognition (Enacted): each worker "enacts" cognition ผ่าน active interaction กับ isolated environment
- Filesystem as IPC — ถูกต้อง crash-only design ป้องกัน state contamination
- Process isolation ป้องกัน hallucination propagation

**Minor improvement**: เพิ่ม **resource budgets** per process (CPU time, memory, token count) ที่ enforce ด้วย OS-level cgroups ไม่ใช่แค่ timeout

#### Layer 2: (Implicit) — ไม่มี Communication Layer ที่ชัดเจน

**Missing entirely**: v1 กระโดดจาก "process isolation" ไปสู่ "Oracle validation" โดยไม่มี layer ที่อธิบาย **how** subsystems communicate structured information — Event Bus ถูกกล่าวถึงใน architecture doc แต่ไม่อยู่ใน concept

#### Layer 3: Epistemic Oracle & Truth Maintenance — ✅ SOUND แต่ INCOMPLETE

**Sound aspects**:
- Hypothesis Tuple protocol — ดีมาก แยก "claim" ออกจาก "verification" สอดคล้อง scientific method
- Deterministic Oracles (AST, regex) — ดี operationally ground symbols ใน codebase reality
- File hash binding / invalidation — ดีมาก ป้องกัน stale facts

**Incomplete**:
- ❌ **Oracle ตรวจได้แค่ structural properties** — "function has 3 params" verifiable, "this approach scales well" ไม่ verifiable ด้วย AST
- ❌ **ไม่มี Semantic Oracle** — verifying logic correctness, not just syntax
- ❌ **ไม่มี Oracle สำหรับ runtime behavior** — property-based testing, fuzzing ฯลฯ
- ✅ ~~**ไม่มี Oracle confidence spectrum**~~ — **[Resolved]** Tiered Registry (concept.md §3.1) with 4 tiers: Deterministic ≥ 0.95, Heuristic 0.5–0.95, Probabilistic 0.1–0.9, Speculative < 0.5. Verification Scope & Limitations section (concept.md §6) now explicitly distinguishes structural vs semantic verification boundaries.
- ❌ **ไม่มี Oracle learning** — Oracle set คงที่ ไม่สร้าง Oracle ใหม่จากประสบการณ์

#### Layer 4: Asymmetric Mutation Protocol — ✅ SOUND

**Sound aspects**:
- 4-phase protocol (Propose → Blast Radius → Shadow Execute → Commit) — well-designed
- Zero-trust principle — ถูกต้อง workers ห้ามมี execution privileges

**Complete as-is**: layer นี้ design ดีและ implementable ปัญหาเดียวคืออยู่ระดับ "mutation" เท่านั้น ไม่ cover "query" operations ที่อาจมี side effects

#### Layer 5: Economic & Risk-Based Routing — ⚠️ INCOMPLETE (ดี concept)

**Sound aspects**:
- System 1/2 routing based on risk — ดี มี theoretical backing
- Vinyan Credits (pegged to USD) — pragmatic

**Incomplete** (ดู Section 3.8):
- ✅ ~~Binary System 1/2 แทนที่ continuum~~ — **[Resolved]** 4-level adaptive continuum implemented. See [architecture.md Decision 9](vinyan-architecture.md).
- ⚠️ ~~ไม่มี "compiled expertise"~~ — **[Partially resolved]** Skill Formation infrastructure in Phase 1 (trace schema + templates table). Actual caching in Phase 2. See [architecture.md Phase 2+ roadmap](vinyan-architecture.md).
- ⚠️ ~~**ไม่มี metacognitive router**~~ — **[Partially resolved]** Self-Model provides forward prediction for routing decisions. Full metacognitive learning deferred to Phase 2+. See [architecture.md Decision 11](vinyan-architecture.md).
- ✅ ~~Risk Score Formula (ใน architecture doc) เป็น static formula ไม่ adaptive~~ — **[Resolved]** Updated with environmentType, irreversibility, production boundary. See [architecture.md Decision 4](vinyan-architecture.md).

#### Layer 6: Evolutionary Governance & Telemetry — ⚠️ SOUND concept, IMPLEMENTATION UNDERSPECIFIED

**Sound aspects**:
- Sleep Cycle concept — มี neuroscientific parallel (hippocampal replay)
- Meritocratic Fleet Governance — ดี Darwin Gödel Machine (2025) validate ว่า approach นี้ work
- Immutable traces — ดี audit trail

**Incomplete**:
- ❌ **Sleep Cycle ขาด simulation component** — แค่ analyze ≠ hippocampal replay ที่ recombine
- ❌ **ไม่มี formal safety bounds** สำหรับ rule modification — system จะรู้ได้ยังไงว่า rule ใหม่ปลอดภัย?
- ❌ **ไม่มี forgetting mechanism** — knowledge ที่ไม่ relevant ต้อง decay ไม่ใช่สะสมไม่มีที่สิ้นสุด

### 4.2 Missing Layers — ต้องเพิ่มใหม่ทั้งชั้น

| Missing Layer | ทำไมต้องมี | Theoretical Basis |
|---|---|---|
| **Self-Model / Metacognition** | Agents ไม่มี internal model ของตัวเอง ไม่ predict ผลก่อน execute ไม่รู้ว่ากำลังทำอะไร | Forward models (Wolpert, 1997); Predictive Processing (Clark, 2013) | **[Resolved → Phase 1]** Promoted to Phase 1 deliverable with concrete interfaces. See [architecture.md Decision 11](vinyan-architecture.md), [concept.md §9](vinyan-concept.md). |
| **Global Workspace** | ไม่มี attention-gated broadcast ระหว่าง subsystems ทำให้ information fragmented | GWT (Baars, 1988; Dehaene, 2014); Butlin et al. (2023) top indicator |
| **Affective / Motivational System** | ไม่มี intrinsic motivation, curiosity ไม่มี mechanism สำหรับ exploration vs exploitation | Active Inference (Friston, 2010); Expected Free Energy |
| **Theory of Mind** | ไม่ model user intent, other agents' beliefs ทำให้ collaborate ได้แย่ | Premack & Woodruff (1978); Mutual ToM (IBM Research, CHI 2024) |
| **Temporal / Episodic Stream** | ไม่มี narrative continuity ข้าม sessions มากกว่า fact retrieval | Episodic memory (Tulving, 1983); Autonoetic consciousness |

### 4.3 Concepts ที่เป็น Illusion — ดูก้าวหน้าแต่ไม่ contribute จริง

1. **"Trustless Cognitive Operating System"** — Buzzword ที่ misleading Vinyan ไม่ได้ "trustless" แบบ blockchain — ยังต้อง trust invariants ที่มนุษย์ set ยังต้อง trust Oracle implementations คำว่า "trustless" สร้างความคาดหวังที่ผิด ควรเปลี่ยนเป็น **"Zero-Trust Execution Policy"** ที่แม่นยำกว่า **[Resolved — A1+A6]** — "Cognitive Operating System" framing ถูก rebrand เป็น **"Epistemic Nervous System"** ใน concept.md v3 (มีนาคม 2026) เพื่อสะท้อน metaphor ที่แม่นยำกว่า: Vinyan เป็น connective substrate ระหว่าง generation ↔ verification ↔ memory ↔ action ไม่ใช่ OS ที่ replace ทุกอย่าง Axiom A1 (Epistemic Separation) + A6 (Zero-Trust Execution) เป็น formal replacement ของ "trustless" claim

2. **"Deterministic Orchestration of Non-Deterministic Compute"** — ฟังดีดี แต่เป็น **over-simplification**: orchestration ที่ pure deterministic ไม่สามารถ handle ปัญหาที่ต้อง adaptive decision-making (เลือก approach ไหน? retry หรือ escalate? explore หรือ exploit?) Reality: orchestration ต้องเป็น **mostly-deterministic with principled stochasticity** — deterministic สำหรับ safety-critical paths, stochastic สำหรับ strategy selection **[Resolved — A3, March 2026]** — Axiom A3 (Deterministic Governance) now defines "deterministic" precisely: **"non-LLM-driven and state-reproducible"**, not "free of all heuristics." The Orchestrator's routing, verification, and commit decisions are rule-based. LLMs are used for generation and task decomposition (probabilistic inputs), but governance of those outputs is deterministic. See concept.md §1.1 A3 and §8 for the explicit acknowledgment that task decomposition is LLM-assisted.

3. **MCTS ใน System 2** — Monte Carlo Tree Search ฟังดี impressive แต่ search space ของ software engineering tasks เป็น **combinatorially explosive** ไม่มี clean reward signal เหมือน game playing ควรใช้ **parallel hypotheses + selection** (ใกล้กับ beam search) มากกว่า MCTS จริงๆ **[Resolved]** — concept.md §8 now uses "parallel hypothesis generation with structured selection" framing instead of MCTS.

4. **"Cryptographically tied to file's hash"** — Technical term ที่ misleading Hash binding ดี แต่ "cryptographically" imply security guarantees ที่ไม่จำเป็น SHA-256 hash comparison เพียงพอ ไม่จำเป็นต้อง crypto formality **[Resolved — A4]** — Axiom A4 (Content-Addressed Truth) formalizes this: facts bind to content hash for invalidation, not for cryptographic security

---

## 5. Vinyan v2 — Revised Cognitive Architecture

### 5.1 Architecture Overview

```
┌───────────────────────────────────────────────────────────────────────┐
│                    COGNITIVE BROADCAST (Global Workspace)              │
│  ┌─────────────────────────────────────────────────────────────────┐  │
│  │  Attention-Gated Shared Information Space                        │  │
│  │  salience-ranked: Oracle verdicts, Worker proposals,             │  │
│  │  Risk assessments, Self-Model predictions, Intent models         │  │
│  └───────────┬──────────┬──────────┬──────────┬──────────┬─────────┘  │
│              │          │          │          │          │            │
│   ┌──────────▼──┐ ┌────▼──────┐ ┌▼─────────┐ ┌▼────────┐ ┌▼───────┐ │
│   │ L7: Self    │ │L6: Intent │ │L5: Affect │ │L4: Epi- │ │L3: Evo-│ │
│   │ Model       │ │ Model     │ │ Engine    │ │ stemic  │ │ lution │ │
│   │ (forward    │ │(Theory of │ │(Active    │ │ Oracle  │ │ Engine │ │
│   │  model +    │ │ Mind)     │ │ Infer.)   │ │ Gateway │ │        │ │
│   │  metacog.)  │ │           │ │           │ │         │ │        │ │
│   └──────┬──────┘ └─────┬─────┘ └─────┬─────┘ └────┬────┘ └───┬───┘ │
│          │              │             │             │          │     │
│   ┌──────▼──────────────▼─────────────▼─────────────▼──────────▼───┐ │
│   │           L2: Risk-Adaptive Router (Continuum)                  │ │
│   │  Level 0: Reflex │ Level 1: Heuristic │ Level 2: Analytical    │ │
│   │  Level 3: Deliberative (parallel hypotheses + shadow exec.)    │ │
│   └──────────────────────────┬─────────────────────────────────────┘ │
│                              │                                       │
│   ┌──────────────────────────▼─────────────────────────────────────┐ │
│   │       L1: Execution Substrate (Process Isolation + IPC)        │ │
│   │  ┌────────┐ ┌────────┐ ┌────────┐ ┌───────────────────┐       │ │
│   │  │Worker 1│ │Worker 2│ │Worker N│ │Shadow Sandbox(es) │       │ │
│   │  └────────┘ └────────┘ └────────┘ └───────────────────┘       │ │
│   └────────────────────────────────────────────────────────────────┘ │
│                                                                       │
│   ┌────────────────────────────────────────────────────────────────┐ │
│   │    L0: Perception & Grounding Baseline                         │ │
│   │  StateVector │ Perceptual Hierarchy │ Invariant Enforcement    │ │
│   │  Operational Grounding (compile/test/AST ↔ symbols)            │ │
│   └────────────────────────────────────────────────────────────────┘ │
│                                                                       │
│   ┌────────────────────────────────────────────────────────────────┐ │
│   │  ⟳ Episodic Stream (L8: cross-layer temporal continuity)      │ │
│   │  Working Memory │ Episodic Buffer │ Sleep Consolidation        │ │
│   └────────────────────────────────────────────────────────────────┘ │
└───────────────────────────────────────────────────────────────────────┘
```

### 5.2 ไม่ใช่ Linear Stack — เป็น Bidirectional Cognitive Loop

**Key architectural shift จาก v1**: Layers ไม่ stack เชิงเส้น (L0→L1→...→L6) แต่เชื่อมกันผ่าน **Global Workspace (Cognitive Broadcast)** ที่ทุก layer สามารถ:
1. **Publish** information to workspace (Oracle results, predictions, risk scores)
2. **Subscribe** to relevant information จาก workspace (filtered by attention/salience)
3. **Feedback** ข้าม layers ได้โดยตรง (Self-Model → Risk Router, Intent Model → Perception)

**Feedback Loops ที่สำคัญ**:
- **Self-Model → Execution**: predict ผลก่อน execute → compare → learn
- **Affect Engine → Risk Router**: curiosity drives exploration budget allocation
- **Intent Model → Perception**: user intent shapes what StateVector prioritizes
- **Evolution Engine → ทุก layer**: learned patterns modify thresholds, oracles, routing rules
- **Episodic Stream → Global Workspace**: temporal context shapes current attention

### 5.3 Layer Specifications

#### L0: Perception & Grounding Baseline — `[Planned Phase 1]`

**Purpose**: Transform raw environment into structured, prioritized perception

**Theoretical Grounding**: Predictive Processing (Clark, 2013) — perception เป็น hierarchy ของ predictions ไม่ใช่ passive data intake

**Mechanism**:
```typescript
interface PerceptualHierarchy {
  raw: RawState;           // file changes, git status, errors
  structural: StructuralState;  // AST-level: functions, imports, dependencies
  semantic: SemanticState;     // module-level: purposes, relationships, contracts
  architectural: ArchState;    // system-level: patterns, invariants, boundaries
}

interface StateVector {
  perception: PerceptualHierarchy;
  predictions: PredictionSet;     // NEW: "what do we predict might be problematic?"
  salience: SalienceMap;          // NEW: ranked by relevance to current task
  invariants: ArchitecturalInvariant[];  // v1 retained: hardcoded rules
}
```

**Operational Grounding** [Synthesis]:
แทนที่ physical grounding (ไม่มี body) Vinyan ใช้ **operational grounding**: ทุก symbol ถูก bind กับ operational semantics ผ่าน executable verification:
- "function X accepts 3 params" → verified by AST Oracle
- "module Y compiles clean" → verified by Type Oracle
- "change Z doesn't break tests" → verified by Test Oracle
- Grounding ≠ understanding meaning → Grounding = verified operational correspondence

**Open Problems**: Semantic grounding (ความหมายเชิง architecture, design quality) ยังไม่มี deterministic oracle → ต้องใช้ heuristic oracles + human review

**Adversarial Input Defense**: Workers receive external content (code comments, API responses, file contents) that may contain **prompt injection** designed to manipulate worker behavior. L0 enforces input sanitization at the perception boundary: (1) content entering worker prompts is stripped of instruction-like patterns, (2) StateVector construction uses only Oracle-verified structural data—never raw text claims, (3) any worker output referencing "skip Oracle" or "bypass validation" is rejected by the Orchestrator before reaching L1. This extends Zero-Trust from mutations to **perception itself**.

#### L1: Execution Substrate — `[Implemented Phase 0]`

**Purpose**: Process isolation + crash-only IPC (retained from v1)

**Theoretical Grounding**: 4E Enacted Cognition — each worker "enacts" cognition through active interaction with isolated environment

**Mechanism**: unchanged from v1 + เพิ่ม:
- **Resource budgets** per process (OS-level cgroups: CPU time, memory limit, token count)
- **Ephemeral REPL** surfaces ที่ worker request ได้ (v1 concept, now formalized)
- **Checkpoint Recovery**: Workers write progress checkpoints to the filesystem at meaningful boundaries (subtask completion, Oracle pass). If a worker crashes or is terminated, the Orchestrator can resume from the last checkpoint rather than restart from zero—preventing UC Berkeley failure mode #6 ("restarted randomly") and reducing wasted computation.
- **Mutation Protocol (integrated from v1 L4)**: 4-phase mutation (Propose → Blast Radius → Shadow Execute → Commit) ถูก integrate เข้า L1 เป็น execution capability แทนที่จะเป็น layer แยก — เหตุผล: mutation เป็น **execution operation** ไม่ใช่ cognitive function กึ่ง Layer; v2 ย้ายมาเป็น Worker capability ที่ Orchestrator enforce ผ่าน Zero-Trust policy

```typescript
interface WorkerBudget {
  maxTokens: number;        // LLM token budget
  maxWallTime: number;      // wall-clock timeout (ms)
  maxMemory: number;        // bytes
  maxProcesses: number;     // child process limit (prevent fork bombs)
}
```

#### L2: Risk-Adaptive Router (ปรับจาก v1 System 1/2) — `[Implemented Phase 0 (binary), Planned Phase 1 (continuum)]`

**Purpose**: Route tasks to appropriate execution profile based on assessed risk — continuum ไม่ใช่ binary

**Theoretical Grounding**: Dual-Process Theory แต่ implement เป็น **continuum with metacognitive monitoring** ตาม Common Model of Cognition (Laird et al., 2017)

**Mechanism**:

```typescript
enum ExecutionLevel {
  REFLEX = 0,       // cached solution, near-instant, zero LLM cost
  HEURISTIC = 1,    // single model, single pass, light verification
  ANALYTICAL = 2,   // single model, multi-pass, full Oracle verification
  DELIBERATIVE = 3, // multi-model, parallel hypotheses, shadow execution
}

interface RiskAssessment {
  blastRadius: number;       // files affected (dep-oracle)
  dependencyDepth: number;   // import chain length
  testCoverage: number;      // % affected code covered
  reversibility: number;     // 0-1: can this be git-reverted cleanly?
  novelty: number;           // 0-1: how unlike past successful tasks? (NEW)
  confidenceGap: number;     // 0-1: Self-Model prediction uncertainty (NEW)
  environmentType: 'development' | 'staging' | 'production';  // NEW: production = auto-escalate
  irreversibility: number;   // NEW: 0-1: DB ops, API calls, deployments that can't git-revert
}

// Metacognitive Monitor — learns from experience
interface MetacognitiveRouter {
  route(assessment: RiskAssessment, taskType: TaskType): ExecutionLevel;
  // updates routing model based on outcome: was this level sufficient?
  learn(assessment: RiskAssessment, level: ExecutionLevel, outcome: Outcome): void;
}
```

**Open Problems**: ต้อง bootstrap MetacognitiveRouter — เริ่มจาก static thresholds (v1 approach) แล้ว gradually learn จาก experience

#### L3: Epistemic Oracle Gateway (ขยายจาก v1) — `[Implemented Phase 0, Extended Phase 1 (QualityScore)]`

**Purpose**: Deterministic verification ของ agent claims + confidence calibration

**Theoretical Grounding**: Scientific method (hypothesis → experiment → evidence) + Epistemic Logic

**v1 retained**: HypothesisTuple, OracleVerdict, file hash binding, invalidation triggers

**v2 extensions**:

```typescript
// Extended Oracle Verdict — เพิ่ม confidence spectrum
interface OracleVerdict {
  verified: boolean;
  confidence: number;          // NEW: 0-1, not just binary
  evidenceStrength: 'deterministic' | 'statistical' | 'heuristic';  // NEW
  evidence: Evidence[];
  fileHashes: Record<string, string>;
  counterEvidence?: Evidence[];  // NEW: ถ้ามี conflicting evidence
  suggestedOracles?: string[];   // NEW: "ควรตรวจด้วย Oracle X เพิ่ม"
  qualityDimensions?: QualityScore;  // NEW: multi-dimensional quality signal
}

// NEW: Continuous quality signal — not just pass/fail
interface QualityScore {
  complexityDelta: number;      // change in cyclomatic complexity (negative = simpler)
  testMutationScore: number;    // mutation testing: what % of injected faults caught?
  architecturalCompliance: number; // import depth, circular deps, layer violations
  efficiency: number;           // tokens consumed / quality achieved
  composite: number;            // weighted combination → single scalar for Evolution Engine
}

// New: Semantic Oracle — heuristic, not deterministic
interface SemanticOracle extends Oracle {
  type: 'heuristic';
  // Uses LLM-as-judge but with structured protocol
  // Confidence < 1.0 always — clearly marked as non-deterministic
  validate(hypothesis: HypothesisTuple): OracleVerdict;
}

// New: Confidence Calibration — aggregate Oracle results ก่อน commit
interface CalibrationGate {
  aggregate(verdicts: OracleVerdict[]): CalibratedConfidence;
  shouldProceed(confidence: CalibratedConfidence): boolean;
  shouldAbstain(confidence: CalibratedConfidence): AbstentionReason | null;
}
```

**Oracle taxonomy v2**:
| Oracle Type | Confidence | Examples |
|---|---|---|
| **Deterministic** | 1.0 | AST parser, type checker, test runner, lint |
| **Statistical** | 0.7-0.95 | Property-based testing, fuzzing, benchmark comparison |
| **Heuristic** | 0.5-0.8 | LLM-as-judge (structured), pattern matching, complexity metrics |

**MCP Integration** [Synthesis — ดู Section 3.11]:
Oracles ควร expose เป็น **MCP Servers** — แต่ละ Oracle type (AST, Type, Test, Semantic) register เป็น MCP Server กับ `tools/list` + `tools/call`. Orchestrator เป็น MCP Host/Client ที่ connect กับ Oracles ด้วย STDIO (local) หรือ Streamable HTTP (remote). ประโยชน์:
- **Dynamic Oracle Discovery**: ใช้ MCP `tools/list_changed` notification → Evolution Engine สามารถ add/remove Oracles ที่ runtime
- **External Oracle Integration**: third-party MCP servers (database, monitoring, CI pipeline) integrate เป็น additional Oracles โดย Vinyan ไม่ต้อง custom adapter
- **Sampling primitive**: Heuristic Oracles ใช้ MCP `sampling/complete` เพื่อ request LLM-as-judge completion กลับไปที่ Host

**Open Problems**: Heuristic oracles ยังมี LLM bias — ต้อง calibrate ด้วย ground truth data sets

#### L4: Episodic Stream (NEW — Temporal Consciousness) — `[Research Phase 3+]`

**Purpose**: Maintain narrative continuity ข้าม sessions + provide temporal context สำหรับ current decisions

**Theoretical Grounding**: Episodic Memory (Tulving, 1983); Hippocampal Replay (Jung et al., 2018)

**Mechanism**:

```typescript
interface Episode {
  id: string;
  timestamp: number;
  task: TaskSummary;
  decisions: Decision[];       // what was decided and why
  outcomes: Outcome[];         // what happened
  surprises: PredictionError[];  // what Self-Model got wrong
  emotionalValence: number;    // -1 to 1: was this experience "good" or "bad"?
}

interface EpisodicStream {
  // Working Memory: current session episodes
  working: Episode[];
  
  // In-Session Learning: approach blacklist to prevent retry loops
  approachBlacklist: Map<TaskId, FailedApproach[]>;  // NEW: "tried X, failed because Y"
  
  // Episodic Buffer: recent sessions, decaying relevance
  buffer: WeightedEpisode[];
  
  // Consolidated: patterns extracted by Sleep Cycle
  consolidated: ConsolidatedPattern[];
  
  // Operations
  record(episode: Episode): void;
  recall(query: EpisodicQuery): Episode[];   // retrieve relevant episodes
  consolidate(): ConsolidatedPattern[];      // Sleep Cycle: replay + recombine
  forget(criteria: DecayCriteria): void;     // Active forgetting
}

interface SleepCycle {
  // Phase 1: Replay — re-simulate significant episodes
  replay(episodes: Episode[]): SimulatedOutcome[];
  
  // Phase 2: Recombine — generate counterfactual scenarios
  // "what if we had chosen approach B instead?"
  recombine(episodes: Episode[], alternatives: Alternative[]): CounterfactualResult[];
  
  // Phase 3: Extract — identify patterns from replay + recombination
  extract(replays: SimulatedOutcome[], counterfactuals: CounterfactualResult[]): Pattern[];
  
  // Phase 4: Consolidate — promote valuable patterns, decay irrelevant ones
  consolidate(patterns: Pattern[]): ConsolidatedPattern[];
}
```

**Open Problems**:
- "Emotional valence" ต้อง operationalize: ใช้ outcome quality (tests pass/fail, user satisfaction, risk realized) เป็น proxy
- Forgetting criteria ต้อง tuning — ลบเร็วไป เสีย lessons; ลบช้าไป context bloat

**In-Session Online Learning**: แก้ปัญหา Frozen Weights Paradox โดยไม่ต้องรอ Sleep Cycle: เมื่อ worker fails, approach + Oracle feedback ถูกบันทึกใน `approachBlacklist` ทันที → subsequent attempts receive "don't repeat" constraints in their prompts. หลัง N failures ใน approach เดิม, Risk Router ต้อง **escalate routing level** (ไม่ใช่แค่ retry) หรือ Affect Engine signals pivot เมื่อ frustration สูง. นี่คือ **runtime adaptation** ที่ v1 ขาดไป—ไม่ต้อง update weights แต่เปลี่ยน behavior ใน session เดียวกันได้.

#### L5: Affective / Motivational Engine (NEW) — `[Research Phase 3+]`

**Purpose**: Provide intrinsic motivation (curiosity, risk-aversion) + balance exploration vs exploitation

**Theoretical Grounding**: Active Inference (Friston, 2010) — Expected Free Energy decomposition

**Mechanism**:

```typescript
interface AffectiveState {
  curiosity: number;          // epistemic value: desire to reduce uncertainty
  confidence: number;         // pragmatic value: belief in current approach
  urgency: number;            // temporal pressure from task deadline/budget
  frustration: number;        // accumulated prediction errors (signal to change strategy)
}

interface MotivationalEngine {
  // Expected Free Energy = pragmatic value + epistemic value
  evaluateAction(action: ProposedAction, state: WorldState): {
    pragmaticValue: number;   // expected task progress
    epistemicValue: number;   // expected uncertainty reduction
    expectedFreeEnergy: number; // combined score
  };
  
  // Drive exploration when epistemic value high
  shouldExplore(state: AffectiveState): boolean;
  
  // Drive exploitation when pragmatic value high
  shouldExploit(state: AffectiveState): boolean;
  
  // Signal strategy change when frustration accumulates
  shouldPivot(state: AffectiveState): boolean;
  
  // NEW: Receive quality gradient from Oracle QualityScore
  // Enables "approach A is 30% better" not just "both pass"
  evaluateQuality(qualityScore: QualityScore): AffectiveUpdate;
}
```

**Concrete Example**:
- Worker failed 3 times on same approach → frustration สูง → Motivational Engine signals "pivot strategy"
- Oracle revealed unexpected dependency → curiosity สูง → allocate budget to explore that dependency
- Task 80% complete, high confidence → pragmatic value dominates → rush to completion

**[Speculative Extension]**: ไม่ claim ว่านี่เป็น "emotions" — เป็น **functional analogs** ที่ serve similar roles ใน decision-making: urgency = "fear of deadline", curiosity = "interest in unknown", frustration = "pain from repeated failure"

#### L6: Intent Model — Theory of Mind (NEW) — `[Research Phase 3+]`

**Purpose**: Model user goals, beliefs, context + model other agents' beliefs ใน multi-agent scenarios

**Theoretical Grounding**: Theory of Mind (Premack & Woodruff, 1978); Mutual ToM (IBM Research, 2024); Computational ToM for LLMs (NLPer, 2025)

**Mechanism**:

```typescript
interface UserIntentModel {
  // Inferred user goals (from conversation, project context, past interactions)
  goals: Goal[];
  
  // Beliefs about user's knowledge state
  userKnowledge: KnowledgeState;  // what does the user know about the codebase?
  
  // User preferences (communication style, risk tolerance, quality expectations)
  preferences: UserPreferences;
  
  // Update model from user's explicit + implicit signals
  update(signal: UserSignal): void;
  
  // Predict user satisfaction with proposed action
  predictSatisfaction(action: ProposedAction): number;
}

interface AgentBeliefModel {
  // In multi-worker scenarios: what does Worker B believe about the task?
  workerBeliefs: Map<WorkerId, BeliefState>;
  
  // Detect belief conflicts between workers
  detectConflicts(): BeliefConflict[];
  
  // Resolve conflicts via shared evidence (Global Workspace broadcast)
  resolveConflict(conflict: BeliefConflict): Resolution;
}
```

**Open Problems**:
- User intent inference จาก sparse signals (text messages, code reviews) เป็นปัญหายาก
- ต้องระวัง "mind-reading" bias — inferred intent อาจผิด → ต้อง verify กับ user เมื่อ uncertainty สูง

#### L7: Self-Model / Metacognition (NEW — Critical Layer) — `[Planned Phase 1]`

**Purpose**: Internal forward model ที่ predict ผลลัพธ์ก่อน execute + monitor own performance + act as **World Model** for the operational environment

**Theoretical Grounding**: Forward/Inverse Models (Wolpert, 1997); Metacognition (Fleming, 2021); Predictive Processing (Clark, 2013); Hofstadter's Strange Loops (2007) — self-reference as basis of self-awareness; **World Models (LeCun JEPA, 2022; DreamerV3, Hafner 2023)** — predict-then-act outperforms reactive act-then-verify

**Mechanism**:

```typescript
interface SelfModel {
  // Forward Model: predict outcome before execution
  predict(action: ProposedAction, worldState: WorldState): PredictedOutcome;
  
  // Compare prediction vs actual — generate prediction error
  compare(predicted: PredictedOutcome, actual: ActualOutcome): PredictionError;
  
  // Update forward model from prediction errors
  learn(error: PredictionError): void;
  
  // Metacognitive monitoring
  assessConfidence(task: Task): CalibratedConfidence;
  assessCapability(task: Task): CapabilityAssessment;  // "can I do this?"
  
  // Strange Loop: model of self modeling (recursive)
  selfAssess(): SelfAssessment;
}

interface PredictedOutcome {
  expectedTestResults: TestPrediction[];  // "tests 14/15 pass, test X may fail"
  expectedRiskLevel: number;
  expectedDuration: number;               // estimate: how long will this take?
  expectedSideEffects: SideEffect[];      // "this change might affect module Y"
  uncertaintyAreas: string[];             // "I'm unsure about dependency chain for Z"
  causalConsequences: CausalPrediction[]; // NEW: "if I change X, Y and Z will break"
                                          // sourced from World Graph causal edges
}

interface SelfAssessment {
  // "How well am I doing on this task?"
  progressEstimate: number;        // 0-1
  confidenceInProgress: number;    // 0-1 (meta-confidence)
  
  // "What are my weaknesses right now?"
  weaknesses: Weakness[];          // e.g., "low confidence in regex patterns"
  
  // "Should I ask for help?"
  escalationAdvice: EscalationAdvice;
}
```

**Why this is the most critical missing layer**:
1. Without Self-Model: Workers propose blindly → waste tokens on doomed approaches
2. Without metacognition: system ไม่รู้เมื่อ stuck → infinite retry loops (Problem P2 จาก gap analysis)
3. Without prediction errors: ไม่มี learning signal → Evolution Engine ไม่มี input ที่ดี

**Strange Loop implementation** [Speculative]:
- Self-Model predict ผลลัพธ์ → compare กับ actual → prediction error → update Self-Model → Self-Model predict better → ...
- Recursive: Self-Model models "how good am I at modeling?" (meta-prediction)
- **ไม่ claim ว่าสร้าง consciousness** — เป็น functional self-reference ที่ improve performance

**World Model Integration**: L7 bridges the gap between World Graph (verified facts) and World Model (predictive causal model). World Graph stores "what IS true" (backward-looking); Self-Model's forward predictor uses World Graph's **causal edges** to predict "what WILL happen if I do X" (forward-looking). Prediction errors from actual Oracle results feed back to refine both the forward model and the World Graph's causal relationships. This implements the DreamerV3/MuZero pattern (predict-then-act) without requiring a separate learned latent-space model—leveraging Vinyan's unique strength of **deterministic Oracle feedback** as ground truth for prediction calibration.

#### L8: Evolution Engine (ขยายจาก v1 Sleep Cycle) — `[Planned Phase 2-3]`

**Purpose**: Self-improvement ภายใน formal safety bounds

**Theoretical Grounding**: Autopoiesis (Varela, Maturana & Uribe, 1974); Darwin Gödel Machine (Sakana AI, 2025); Complex Adaptive Systems

**Mechanism — Bounded Autopoiesis**:

```typescript
interface EvolutionEngine {
  // Mutable components (can be modified by Evolution Engine)
  mutableRules: {
    oracleConfigurations: OracleConfig[];    // add/modify/remove oracles
    riskThresholds: RiskThreshold[];         // tune routing
    workerConfigurations: WorkerConfig[];    // add/modify/remove worker types
    consolidationPatterns: Pattern[];        // learned anti-patterns
    routingModel: MetacognitiveRouter;       // learned task→level mapping
    skillLibrary: SkillTemplate[];           // NEW: compressed reusable execution patterns
  };
  
  // Skill Formation — compression as intelligence (AGI consensus requirement)
  // Beyond defensive rules ("don't do X"), the Evolution Engine compresses
  // successful execution traces into reusable skill templates.
  formSkill(traces: SuccessfulTrace[]): SkillTemplate;
  composeSkills(skills: SkillTemplate[]): CompositeSkill;  // skills compose hierarchically
  
  // Immutable invariants (CANNOT be modified — formal safety bounds)
  immutableInvariants: {
    humanEscalationTriggers: Trigger[];     // conditions that MUST escalate to human
    securityPolicies: SecurityPolicy[];      // auth, credential handling, RCE prevention
    budgetHardLimits: BudgetLimit[];        // maximum spend regardless of task
    testRequirements: TestPolicy[];          // minimum test coverage for commits
    rollbackCapability: boolean;             // mutations MUST be reversible
  };
  
  // Evolution process (DGM-inspired)
  propose(modification: RuleModification): SafetyVerdict;
  evaluate(modification: RuleModification, traces: Trace[]): ImprovementEstimate;
  apply(modification: RuleModification): void;
  rollback(modification: RuleModification): void;
}
```

**Safety Mechanism — Adaptation ของ DGM approach**:
1. Evolution Engine proposes rule modification based on accumulated traces
2. **Formal safety check**: modification ไม่ violate immutable invariants?
3. **Shadow evaluation**: apply modification ใน sandboxed replay ของ past episodes
4. **Statistical significance**: improvement ต้อง significant over N episodes (not one-off)
5. **Apply with rollback**: ถ้า performance degrade → automatic rollback

**Skill Formation** [NEW — Compression as Intelligence]:
The Evolution Engine produces not just defensive rules but **productive skills**:
- **SkillTemplate** = parameterized execution pattern extracted from successful traces (e.g., "implement REST CRUD endpoint" = file structure + test patterns + Oracle configuration)
- **Skill Hierarchy** = skills compose: "build auth system" = "implement JWT" + "implement middleware" + "implement session store"
- **Level 0 Population** = cached skills populate Risk Router's Reflex level (near-instant, zero LLM cost) — the more skills acquired, the cheaper the system operates
- This implements the AGI consensus principle that **compression is an intelligence amplifier**: discard detail, preserve decision-relevant structure
- **Kill criterion**: if skill reuse rate < 10% after 100 tasks → skill formation is overhead, not value

### 5.4 Cognitive Broadcast — The Global Workspace Implementation

**Design Pattern**: Publisher-Subscriber bus with **attention-gated access**

```typescript
interface CognitiveBroadcast {
  // Publish to workspace (any layer can publish)
  publish(item: BroadcastItem): void;
  
  // Subscribe with attention filter (each layer gets relevant items only)
  subscribe(filter: AttentionFilter): Observable<BroadcastItem>;
  
  // Current workspace contents (attention-ranked)
  workspace: RankedBroadcastItem[];
  
  // Attention mechanism: ranks items by salience to current task
  rank(items: BroadcastItem[], context: TaskContext): RankedBroadcastItem[];
}

interface BroadcastItem {
  source: LayerIdentifier;
  type: 'oracle_verdict' | 'risk_assessment' | 'prediction' | 'intent_update'
        | 'affective_signal' | 'episodic_recall' | 'evolution_proposal';
  salience: number;         // producer's estimate of importance
  content: unknown;         // layer-specific payload
  timestamp: number;
  ttl: number;              // time-to-live: auto-expire stale items
}
```

**How layers interact via Broadcast**:
1. **Oracle Gateway** publishes verdict → **Self-Model** receives, compares with prediction → publishes prediction error
2. **Self-Model** publishes low confidence → **Risk Router** receives, escalates to higher execution level
3. **Intent Model** publishes updated user goal → **Perception** adjusts salience map → **Affect Engine** adjusts urgency
4. **Affect Engine** publishes high frustration → **Evolution Engine** receives, notes pattern for future learning
5. **Episodic Stream** publishes recalled similar episode → **Global Workspace** makes it available to all layers

### 5.5 สรุป Information Flow สำหรับ Typical Task

```
1. User submits task
   ↓
2. L0 (Perception): construct StateVector with perceptual hierarchy + salience ranking
   → publish to Cognitive Broadcast
   ↓
3. L6 (Intent Model): infer user goals, update preferences
   → publish intent model update to Broadcast
   ↓
4. L7 (Self-Model): predict difficulty, estimate capability, predict outcome
   → publish predictions + confidence to Broadcast
   ↓
5. L2 (Risk Router): assess risk (using Oracle + Self-Model inputs)
   → select execution level (Reflex/Heuristic/Analytical/Deliberative)
   ↓
5b. **Iterative Decomposition**: if task is complex, decompose hierarchically:
   Planner LLM → high-level DAG (2-3 subtasks) → dep-oracle validates structure
   + semantics-oracle validates coverage (“do subtasks COVER request?”)
   → for each subtask → decompose further → validate sub-DAG against parent + siblings
   → execute only leaf tasks (prevents wrong-decomposition cascading waste)
   ↓
6. L1 (Execution): spawn Worker(s) at chosen level
   → Worker proposes mutation (HypothesisTuple)
   ↓
7. L3 (Oracle Gateway): validate hypothesis with deterministic + heuristic oracles
   → publish verdicts to Broadcast
   ↓
8. L7 (Self-Model): compare predicted vs actual Oracle results
   → publish prediction errors to Broadcast
   ↓
9. L5 (Affect Engine): evaluate expected free energy of proceeding
   → if frustration high, signal pivot
   → if curiosity high about new finding, signal explore
   ↓
10. L4 (Mutation Protocol): if Oracles pass → shadow execute → commit
    ↓
11. L4 (Episodic Stream): record episode (decisions, outcomes, surprises)
    ↓
12. L8 (Evolution Engine): [async] during Sleep Cycle:
    - replay significant episodes
    - recombine + counterfactual "what if"
    - extract patterns → propose rule modifications
    - evaluate in shadow → apply if improvement significant
```

---

## 6. Evolution Pathway

### 6.1 Phase 0 → v2 Implementation Roadmap

| Phase | What | Prerequisites | Falsifiability Criteria | Axioms Proven |
|---|---|---|---|
| **Phase 0**: Validation Hooks | Vinyan as Claude Code/OpenClaw hooks: Oracle Gateway + World Graph | Working Claude Code/OpenClaw setup | Measurable: hallucination rate ลดลง (A/B test hook enabled vs disabled) | **A1, A3, A4, A5, A6** |
| **Phase 1A**: Self-Model MVP | Forward model ที่ predict Oracle outcome ก่อน actual verification | Phase 0 + sufficient trace data | Measurable: prediction accuracy > 70% after 100 tasks | **A7** |
| **Phase 1B**: Episodic Buffer MVP | Working memory + session-level episodic recording | Phase 0 + database for episodes | Measurable: same-session mistake repetition rate ลดลง | **A4, A7** |
| **Phase 2A**: Risk-Adaptive Router | Replace binary System 1/2 with 4-level continuum + basic metacognitive learning | Phase 1A (Self-Model predictions feed router) | Measurable: average cost per task ลดลง while quality ≥ same | **A2, A3** |
| **Phase 2B**: Cognitive Broadcast | Attention-gated shared workspace replacing Event Bus | Phase 2A + L3/L7 producing publishable items | Measurable: context relevance score (human eval) เพิ่มขึ้น | **A2, A5** |
| **Phase 3A**: Affect Engine | Active Inference-inspired motivation (curiosity, frustration) | Phase 2A (router must understand explore/exploit signals) | Measurable: strategy pivot ก่อน budget exhaust (vs v1 which retries until timeout) | **A2, A7** |
| **Phase 3B**: Intent Model | Basic user intent modeling from conversation + project context | Phase 2B (broadcast needed for intent propagation) | Measurable: user "ไม่ใช่ที่ต้องการ" rate ลดลง | **A2** |
| **Phase 4**: Evolution Engine v2 | DGM-inspired self-improvement with safety bounds | All previous + sufficient trace data (months) | Measurable: system autonomously improves rules ที่ pass safety checks | **A3, A7** |
| **Phase 5**: Full Sleep Cycle v2 | Replay + Recombination + Counterfactual generation | Phase 4 + Phase 1B episodic data | Measurable: patterns extracted ≠ just "this failed" but "this alternative would have worked" | **A4, A7** |

### 6.2 Critical Dependencies

```
Phase 0 (Foundation)
  ├── Phase 1A (Self-Model) ──── Phase 2A (Router)
  │                                └── Phase 3A (Affect)
  ├── Phase 1B (Episodic) ─────── Phase 5 (Sleep v2)
  │
  └── Phase 2B (Broadcast) ────── Phase 3B (Intent)
                                    │
                                    └── Phase 4 (Evolution)
```

### 6.3 Falsifiability Criteria Per Layer

ทุก layer ต้อง prove ว่า **contribute จริง** ไม่ใช่แค่ "ฟังดูดี":

| Layer | Falsification Test | Kill Criterion (เมื่อไหร่ตัดทิ้ง) |
|---|---|---|
| L0 (Perception) | A/B: agent + StateVector vs agent ไม่มี | ถ้า no significant quality difference |
| L3 (Oracle Gateway) | A/B: Oracle-validated vs self-validated execution | ถ้า hallucination rate ไม่ลด |
| L7 (Self-Model) | Prediction accuracy tracked over time | ถ้า accuracy < random baseline after 200 tasks |
| L5 (Affect Engine) | Compare budget utilization + task success with/without | ถ้า no improvement in budget efficiency |
| L6 (Intent Model) | User satisfaction scores with/without | ถ้า satisfaction ไม่เพิ่ม |
| L8 (Evolution) | Track rule modifications: how many improve vs degrade | ถ้า > 50% of modifications degrade performance |
| Global Workspace | Context relevance score with/without attention gating | ถ้า random broadcast = same quality as attention-gated |

---

## 7. Open Questions & Research Agenda

### 7.1 ปัญหาที่ยังไม่มีคำตอบแม้ค้นแล้ว

1. **Self-Model Bootstrap Problem**: Forward model ต้อง training data แต่ training data มาจาก system operation ที่ยังไม่มี forward model → chicken-and-egg พบวิธีเดียวคือ start จาก heuristic model (rule-based predictions) แล้วค่อยๆ learn จาก experience

2. **Attention Mechanism สำหรับ Global Workspace**: neuroscience ของ attention ยังไม่เข้าใจสมบูรณ์ สำหรับ software: ใช้อะไรในการ rank salience? Task relevance? Recency? Surprise value? Likely need multi-factor scoring ที่ tune empirically

3. **Semantic Oracle Problem**: ไม่มี deterministic way ในการ verify "design quality" หรือ "architectural fitness" ได้ สิ่งที่ทำได้คือ:
   - Proxy metrics (complexity, coupling, cohesion)
   - LLM-as-judge (not deterministic but better than nothing)
   - Human review (expensive but ground truth)
   - ยังไม่มี automated semantic oracle ที่เชื่อถือได้

4. **Bounded Autopoiesis Safety**: อะไรเป็น "immutable invariant" จริง? ใครกำหนด? ถ้า invariant set ผิดตั้งแต่แรก system ถูก constrain ไม่ให้ improve ที่จำเป็น → ต้อง meta-level process สำหรับ review invariants (requires human governance)

5. **Consciousness vs. Functional Analogues**: Butlin et al. (2023) ให้ indicators แต่ "no current AI systems are conscious" — ถ้า Vinyan v2 implement ทุก indicator property แล้ว system จะ "conscious" หรือยัง? คำตอบปัจจุบัน: เราไม่รู้ — ประเด็นนี้เป็นปรัชญา ไม่ใช่ engineering ดังนั้น Vinyan optimize สำหรับ **functional performance** ไม่ optimize สำหรับ consciousness

6. **Compositionality ในระดับ Architecture**: Vinyan v2 เพิ่ม layers มาก → ปัญหา compositionality ย้ายจาก LLM level ไปสู่ architecture level — layers compose อย่างถูกต้องหรือไม่? จะรู้ได้ยังไงว่า emergence ที่เกิดเป็น beneficial ไม่ใช่ destructive?

7. **Cross-Domain Oracle Extension**: Vinyan's core strength (deterministic Oracle verification) ทำงานดีมากใน software engineering เพราะมี formal verification tools (AST, type checker, test runner). สำหรับ non-code domains (legal, financial, scientific) ยังไม่มี deterministic oracle ที่เทียบเท่า — ต้องใช้ Heuristic Oracle (LLM-as-judge) ซึ่งเป็นปัญหาเดียวกับที่ Vinyan วิจารณ์ framework อื่น ("ให้ agent ประเมินตัวเอง"). **ทางเลือก**: Vinyan claims "Autonomous Software Engineering Orchestrator" สำหรับ Phase 0-2; cross-domain เป็น Phase 3+ research agenda ต่อเมื่อ domain-specific Oracle verifiers มี maturity เพียงพอ. Oracle **framework** เป็น domain-agnostic (propose → verify externally); Oracle **implementations** เริ่มที่ code-specific.

8. **Quality Signal Bootstrap**: Multi-dimensional QualityScore (complexity delta, mutation testing, architectural compliance) ต้อง calibrate baseline ก่อนใช้งาน — "ดีขึ้น 30%" เทียบกับอะไร? ต้องมี corpus ของ "good code changes" เพื่อ train initial weights → possible approach: use human-reviewed PRs จาก open-source projects เป็น ground truth

9. **Task Decomposition Semantic Oracle**: dep-oracle ตรวจ structural validity (files exist, dependencies correct) แต่ไม่ตรวจ semantic validity ("แบ่งงานถูกไหม", "ลำดับถูกไหม", "subtasks ครอบคลุม original request ไหม") — นี่เป็น Heuristic Oracle territory ที่ต้อง research ว่า calibrate ได้ดีแค่ไหน

### 7.2 Suggested Experiments / POCs

| Experiment | Goal | Expected Duration | Success Criteria |
|---|---|---|---|
| **POC-1: Oracle Impact** | Measure hallucination reduction ด้วย AST + Type + Test Oracles เป็น Claude Code hooks | 2-4 weeks | Hallucination rate ลดลง ≥ 30% on 50-task benchmark |
| **POC-2: Forward Model** | Build simple forward model ที่ predict test outcomes before execution | 3-5 weeks | Prediction accuracy > 65% after 50 tasks |
| **POC-3: Attention-Gated Context** | Compare: full StateVector injection vs attention-filtered injection | 2-3 weeks | Token cost ลดลง ≥ 20% at same quality |
| **POC-4: Affective Routing** | Add "frustration counter" ที่ trigger strategy pivot after N failures | 1-2 weeks | Reduce average retries before success by ≥ 40% |
| **POC-5: Episodic Recall** | Store task episodes + recall similar when facing new task | 3-4 weeks | Time-to-solution ลดลง for recurring task patterns |
| **POC-6: DGM-Lite** | Allow Evolution Engine to modify Oracle thresholds based on traces | 4-6 weeks | Autonomous threshold improvements that pass safety checks |
| **POC-7: Skill Formation** | Extract reusable skill templates from successful execution traces | 3-4 weeks | Skill reuse rate > 10% on 100 tasks; Level 0 cache hit rate measurable |
| **POC-8: Iterative Decomposition** | Compare single-shot vs hierarchical task decomposition with Oracle validation at each level | 2-3 weeks | Wrong-decomposition rate ลดลง ≥ 40% on complex multi-file tasks |

### 7.3 Research Directions ที่ต้อง Monitor

1. **ARC-AGI-3** (2026): interactive reasoning environments ที่ต้อง agents เข้าไป "probe" actively — ถ้า LLMs ยัง fail → reinforces need for architecture-level solutions
2. **Test-Time Training / Adaptation**: approach ที่ให้ model learn during inference (not just in-context learning) — อาจ partially solve Frozen Weights Paradox
3. **Adversarial Collaboration GWT vs IIT** (Templeton Foundation): ผลสุดท้ายจะ inform whether Global Workspace approach มี empirical backing
4. **Darwin Gödel Machine follow-ups**: ดู whether DGM approach scales to complex software engineering (not just benchmarks)
5. **Neuro-Symbolic AI**: research ใน hybrid architectures ที่รวม LLM (subsymbolic) กับ formal reasoning (symbolic) — direct relevance สำหรับ Vinyan's Oracle + LLM hybrid
6. **LeCun JEPA / World Models**: V-JEPA (Meta, 2024) เรียนรู้ video representations ใน latent space — ดูว่า approach นี้ extend ไปสู่ code representation ได้ไหม → อาจ inform Vinyan's Self-Model design
7. **MCP Ecosystem Growth**: MCP adoption ข้าม major AI platforms (Claude, ChatGPT, VS Code, Cursor) → ถ้า ecosystem mature → Vinyan Oracles สามารถ leverage existing MCP Server ecosystem แทนที่สร้างเอง
8. **AlphaProof / Formal Verification + LLM**: DeepMind's neuro-symbolic approach ที่ได้ IMO gold → ดูว่า pattern นี้ generalize ไปสู่ software verification ได้ หรือ domain-specific only

### 7.4 Deferred Concepts — ดีแต่ยังไม่เข้ากับแนวคิดหลัก

สิ่งต่อไปนี้ถูกระบุใน gap analysis แต่ **ยังไม่เพิ่มเข้า concept** เพราะขัดกับหลักการหรือยังไม่มี evidence เพียงพอ:

| Concept | ทำไมเก็บไว้ก่อน | เงื่อนไขที่อาจเปิดได้ |
|---|---|---|
| **Cross-Domain AGI Claim** | Vinyan's จุดแข็งคือ deterministic Oracle ซึ่งเป็น code-specific. Claim AGI ก่อนมี domain-specific Oracles สำหรับ non-code domains = **over-promise** ที่ทำลาย epistemic credibility. ใช้ Heuristic Oracle (LLM-as-judge) สำหรับ non-code domains ขัดกับ thesis หลัก "แยก คิด ออกจาก ตรวจ อย่างเด็ดขาด" | เมื่อมี domain-specific verification tools (e.g., contract analyzers, financial model validators) ที่ mature พอ → integrate เป็น Oracle |
| **Full Theory of Mind** | L6 Intent Model ที่ implement ไว้เป็น **user intent inference** ไม่ใช่ full Theory of Mind (model beliefs, desires, deceptions of other agents). Full ToM เป็น research problem ที่ยังไม่มี established solution และไม่จำเป็นสำหรับ software engineering use case | เมื่อ multi-agent scenarios ต้องการ inter-agent negotiation จริงๆ |
| **Conscious Experience / Qualia** | Vinyan optimize สำหรับ **functional performance** ไม่ใช่ consciousness. เพิ่ม consciousness mechanisms เข้าไปโดยไม่มี falsifiable test = unfalsifiable overhead | ไม่เปิด — รอให้ปรัชญาและ neuroscience ตกลงกันก่อน |
| **Physical Embodiment** | Vinyan ใช้ operational embodiment (codebase + tools = body) ซึ่ง sufficient สำหรับ software domain. Physical embodiment (robotics) ไม่จำเป็นและเพิ่ม complexity โดยไม่มี benefit | เมื่อ Vinyan ขยายไป non-software domains ที่ต้องการ physical interaction |

---

## Appendix A: Citation Index

### Academic Papers

| ID | Citation | Used In |
|---|---|---|
| 1 | Bender, E. & Gebru, T. (2021). "On the Dangers of Stochastic Parrots." FAccT | 2.1, 2.5 |
| 2 | Li, K. et al. (2023). "Emergent world representations: Exploring a sequence model trained on a synthetic task" (Othello-GPT). arXiv | 2.1 |
| 3 | Fedorenko, E. et al. (2024). "Language is primarily a tool for communication rather than thought." Nature | 2.1 |
| 4 | Schaeffer, R. et al. (2023). "Are Emergent Abilities of Large Language Models a Mirage?" NeurIPS | 2.7 |
| 5 | Berglund, L. et al. (2023). "The Reversal Curse." arXiv | 2.1 |
| 6 | Guzik, E. et al. (2023). "The Originality of Machines: AI Takes the Torrance Test." Journal of Creativity | 2.1 |
| 7 | Bubeck, S. et al. (2023). "Sparks of AGI: Early experiments with GPT-4." Microsoft Research | 2.1 |
| 8 | Madabushi, H.T., Torgbi, M. & Bonial, C. (2025). "Neither Stochastic Parroting nor AGI: LLMs Solve Tasks through Context-Directed Extrapolation from Training Data Priors." arXiv:2505.23323 | 2.1, 2.2 |
| 9 | Shojaee, P. et al. (2025). "The Illusion of Thinking: Understanding the Strengths and Limitations of Reasoning Models." arXiv:2506.06941. Apple ML Research | 2.2 |
| 10 | Fan, Ch. et al. (2025). "Missing Premise exacerbates Overthinking." arXiv:2504.06514 | 2.5 |
| 11 | Aggarwal, P. et al. (2025). "OptimalThinkingBench: Evaluating Over and Underthinking in LLMs." arXiv:2508.13141. FAIR at Meta / CMU | 2.2 |
| 12 | Chen, X. et al. (2024). "Premise Order Matters in Reasoning with Large Language Models." arXiv:2402.08939. Google DeepMind | 2.4 |
| 13 | Ashwani, S. et al. (2024). "Cause and Effect: Can LLMs Truly Understand Causality?" arXiv:2402.18139 | 2.4 |
| ~~14~~ | ~~Pruthi, P. et al. (ICLR 2026). "Why Transformers Succeed and Fail at Compositional Generalization." OpenReview~~ — **REMOVED: unverifiable, no evidence this paper exists** | — |
| 15 | Mondorf, P. et al. (2025). "Compositional-ARC: Assessing Systematic Generalization." arXiv:2504.01445 | 2.3 |
| 16 | Harnad, S. (1990). "The Symbol Grounding Problem." Physica D | 2.6 |
| 17 | McKenzie, I. et al. (2023). "Inverse Scaling: When Bigger Isn't Better." arXiv | 2.7 |
| 18 | Baars, B.J. (1988). "A Cognitive Theory of Consciousness." Cambridge University Press | 3.1 |
| 19 | Dehaene, S. (2014). "Consciousness and the Brain." Viking | 3.1 |
| 20 | Friston, K. (2010). "The free-energy principle: a unified brain theory?" Nature Reviews Neuroscience | 3.2 |
| 21 | Clark, A. (2013). "Whatever next? Predictive brains, situated agents, and the future of cognitive science." BBS | 3.3 |
| 22 | Clark, A. (2015). "Surfing Uncertainty: Prediction, Action, and the Embodied Mind." Oxford University Press | 3.3 |
| 23 | Wolpert, D.M. (1997). "Computational approaches to motor control." Trends in Cognitive Sciences | 3.3 |
| 24 | Tononi, G. (2004). "An information integration theory of consciousness." BMC Neuroscience | 3.4 |
| 25 | Tononi, G. et al. (2023). IIT 4.0. PLoS Computational Biology | 3.4 |
| 26 | Butlin, P. et al. (2023). "Consciousness in Artificial Intelligence: Insights from the Science of Consciousness." arXiv | 1.2, 3.1, 3.4, 7.1 |
| 27 | Varela, F.J., Maturana, H.R. & Uribe, R. (1974). "Autopoiesis: The organization of living systems, its characterization and a model." Biosystems 5, 187–196 | 3.7 |
| 28 | Schmidhuber, J. (2003). "Gödel Machines: Fully Self-Referential Optimal Universal Self-Improvers." arXiv | 3.7 |
| 29 | Sakana AI (2025). "Darwin Gödel Machine: Open-Ended Evolution of Self-Improving Agents." arXiv:2505.22954 | 3.7 |
| 30 | Hutter, M. (2000). "A Theory of Universal Artificial Intelligence based on Algorithmic Complexity." arXiv | 3.7 |
| 31 | Kahneman, D. (2011). "Thinking, Fast and Slow." Farrar, Straus and Giroux | 3.8 |
| 32 | Laird, J., Lebiere, C., Rosenbloom, P. (2017). "A Standard Model of the Mind." AI Magazine 38 | 3.8 |
| 33 | Tulving, E. (1983). "Elements of Episodic Memory." Oxford University Press | 5.3 (L4) |
| 34 | Jung, J. et al. (2018). "Remembering rewarding futures: a simulation-selection model of the hippocampus." Hippocampus 28, 913–930 | 3.6 |
| 35 | Hutchins, E. (1995). "Cognition in the Wild." MIT Press | 3.5 |
| 36 | Hofstadter, D. (1979). "Gödel, Escher, Bach." Basic Books | 3.3 |
| 37 | Hofstadter, D. (2007). "I Am a Strange Loop." Basic Books | 5.3 (L7) |
| 38 | Premack, D. & Woodruff, G. (1978). "Does the chimpanzee have a theory of mind?" BBS | 5.3 (L6) |
| 39 | Chollet, F. (2019). "On the Measure of Intelligence." arXiv:1911.01547 | 2.3 |
| 40 | Fleming, S. (2021). "Know Thyself: The Science of Self-Awareness." Basic Books | 5.3 (L7) |
| 41 | Garrido, G.M. et al. (2025). "Visual cognition in multimodal large language models." Nature Machine Intelligence 7, 96–106. DOI:10.1038/s42256-024-00963-y | 2.6 |
| 42 | Gronchi, G. & Perini, A. (2024). "Dual-process theories of thought as potential architectures for developing neuro-symbolic AI models." Frontiers in Cognition. DOI:10.3389/fcogn.2024.1356941 | 3.8 |

### Web Sources & Industry

| ID | Source | Used In |
|---|---|---|
| W1 | ksopyla (2025). "2025 LLM Limitations: Research Review." ai.ksopyla.com | 2.1-2.7 |
| W2 | Pebblous AI (2025). "The Birth of the Intelligent Parrot." blog.pebblous.ai | 2.1 |
| W3 | ARC Prize (arcprize.org). ARC-AGI benchmark documentation | 2.3 |
| W4 | Philosophy of Brains (2025). "AI and Agency: Karl Friston." philosophyofbrains.com | 3.2 |
| W5 | IBM Research (2024). "Theory of Mind in Human-AI Interaction." CHI 2024 | 5.3 (L6) |
| W6 | NLPer (2025). "Theory of Mind in Multi-Agent LLM Collaboration." | 5.3 (L6) |
| W7 | ACL Anthology (2025). "Theory of Mind in Large Language Models." survey paper | 5.3 (L6) |
| W8 | Model Context Protocol (2024-2025). modelcontextprotocol.io — Open standard by Anthropic, adopted by LF Projects | 3.11, 5.3 (L3) |

### New References (Round 2)

| ID | Citation | Used In |
|---|---|---|
| 43 | Snell, C. et al. (2024). "Scaling LLM Test-Time Compute Optimally." arXiv:2408.03314 | 2.8 |
| 44 | LeCun, Y. (2022). "A Path Towards Autonomous Machine Intelligence." openreview.net | 3.9 |
| 45 | Bardes, A. et al. (2024). "V-JEPA: Video Joint-Embedding Predictive Architecture." Meta AI | 3.9 |
| 46 | Garcez, A. & Lamb, L. (2023). "Neurosymbolic AI: The 3rd Wave." Artificial Intelligence Review | 3.10 |
| 47 | Marcus, G. (2020). "The Next Decade in AI: Four Steps Towards Robust Artificial Intelligence." arXiv:2002.06177 | 3.10 |
| 48 | Brooks, R. (1991). "Intelligence without representation." Artificial Intelligence 47 | 2.9 |
| 49 | Clark, A. & Chalmers, D. (1998). "The Extended Mind." Analysis 58 | 2.9, 3.5 |
| 50 | Shojaee, P. et al. (2025). "The Illusion of Thinking: Understanding the Strengths and Limitations of Reasoning Models via the Lens of Problem Complexity." arXiv:2506.06941. Apple ML Research | 2.8 |

---

## Appendix B: Glossary

| Term | Definition |
|---|---|
| **Active Inference** | Framework ที่ organisms minimize expected free energy ผ่าน perception + action |
| **Autopoiesis** | Self-producing system ที่ generate and maintain its own organization |
| **Cognitive Broadcast** | Global Workspace implementation: attention-gated shared information space |
| **Compositional Generalization** | Ability to combine known components into novel combinations |
| **Expected Free Energy** | G = pragmatic value (exploit) + epistemic value (explore) |
| **Forward Model** | Internal model ที่ predict outcome of action before execution |
| **Grounding (Operational)** | Binding symbols to operational semantics ผ่าน executable verification |
| **GWT** | Global Workspace Theory — consciousness as brain-wide information broadcast |
| **IIT** | Integrated Information Theory — consciousness as integrated information (Φ) |
| **JEPA** | Joint-Embedding Predictive Architecture — LeCun's proposal for learning world models in latent space |
| **MCP** | Model Context Protocol — open standard สำหรับ connecting AI applications กับ external tools/data |
| **Neuro-Symbolic** | Hybrid architecture combining neural (LLM) + symbolic (formal reasoning) methods |
| **Prediction Error** | Difference between Self-Model prediction and actual outcome |
| **Production Boundary** | Environment classification (dev/staging/production) that gates mutation protocol escalation |
| **QualityScore** | Multi-dimensional continuous quality signal (complexity, mutation score, compliance, efficiency) replacing binary pass/fail |
| **SkillTemplate** | Compressed reusable execution pattern extracted from successful traces by Evolution Engine |
| **Strange Loop** | Self-referential structure: system modeling system modeling system... |
| **Theory of Mind (ToM)** | Ability to attribute beliefs, desires, intentions to other agents |
| **World Model** | Predictive causal model that answers "what will happen if I do X?" — extends World Graph from facts to predictions |
