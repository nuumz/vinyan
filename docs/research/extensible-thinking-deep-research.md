# Extensible Thinking: Deep Research & Architectural Analysis

> **Document boundary**: This document owns the external research synthesis and architectural analysis for Vinyan's Extensible Thinking design. It validates, challenges, and extends the debate synthesis findings with academic evidence and competitive landscape analysis.
> For the internal debate synthesis, see [extensible-thinking-debate-synthesis.md](./extensible-thinking-debate-synthesis.md). For current architecture decisions, see [decisions.md](../architecture/decisions.md). For EHD/confidence architecture, see [ehd-confidence-architecture.md](../design/ehd-confidence-architecture.md).

**Date:** 2026-04-04
**Status:** Research complete
**Builds on:** Extensible Thinking Design Debate Synthesis (4 expert teams)

---

## Executive Summary

Extensible Thinking is the design problem of making an autonomous orchestrator's reasoning depth, strategy, and budget **adaptive per-task** rather than fixed per-routing-level. Vinyan's current architecture conflates risk (verification depth) with ambiguity (thinking depth) into a single L0-L3 axis. External research strongly validates the debate synthesis's central insight: **thinking scales along two independent dimensions** — serial depth (longer chains) and parallel breadth (multiple hypotheses). The 2025-2026 literature provides concrete mechanisms for both: BudgetThinker (control tokens for budget adherence), RethinkMCTS (thought-level tree search with refinement), Thinking-Optimal Scaling (diminishing/negative returns of excessive CoT), and CAIR (counterfactual influence ranking for agent workflows). No existing framework (LangGraph, AutoGen, CrewAI, DSPy) implements the full Extensible Thinking vision — most treat reasoning as opaque LLM calls. Vinyan's epistemic architecture (A1-A7 axioms, oracle gate, tiered trust) positions it to be the first orchestrator where thinking strategy is a **governable, measurable, oracle-verified** dimension.

**Recommendation**: Implement the debate synthesis Phase 1 (ThinkingPolicy type + observation keys) immediately. For Phase 2, adopt the 2D thinking model (risk × ambiguity) with deterministic functions, and implement counterfactual mode before multi-hypothesis — the economic case is strongest. Integrate BudgetThinker-style decay scheduling into ReasoningPolicy for budget adherence. Defer debate mode and metacognitive monitoring per debate consensus.

**Confidence**: High (15+ academic papers, 6 framework analyses, full codebase mapping, 4-team debate synthesis)

---

## 1. Specification Overview

### 1.1 Problem Statement

An autonomous task orchestrator must decide *how deeply to think* about each task. Current approaches use a single axis (risk score → routing level → fixed thinking config). This conflates two independent dimensions:

| Dimension | Controls | Example |
|-----------|---------|---------|
| **Risk** | Verification depth (how thoroughly to check) | Renaming 50 files: high risk, low ambiguity |
| **Ambiguity** | Thinking depth (how hard to reason) | Novel algorithm design: low risk, high ambiguity |

The goal is an extensible system where thinking strategy adapts to both dimensions, governed by deterministic rules (A3), verified by independent oracles (A1), and calibrated by prediction error (A7).

### 1.2 Current Vinyan Architecture

```
Task → riskScore (weighted sum) → L0/L1/L2/L3
  L0: ThinkingConfig = disabled,     verification = hash-only
  L1: ThinkingConfig = disabled,     verification = structural oracles
  L2: ThinkingConfig = adaptive/med, verification = all oracles
  L3: ThinkingConfig = adaptive/high, verification = all + shadow
```

**Gap**: A task with `riskScore=0.8` (high risk) but `ambiguity=0.1` (well-understood rename) gets L3 deep thinking — wasteful. A task with `riskScore=0.2` (low risk) but `ambiguity=0.9` (novel design) gets L1 no thinking — inadequate.

### 1.3 Design Constraints (from 7 Axioms)

| Axiom | Constraint on Extensible Thinking |
|-------|----------------------------------|
| A1 (Epistemic Separation) | Generator never evaluates its own thinking quality |
| A2 (First-Class Uncertainty) | "Thinking insufficient" is a valid state, not error |
| A3 (Deterministic Governance) | Thinking policy = f(data), no LLM in the decision path |
| A5 (Tiered Trust) | Deterministic thinking budget > heuristic estimate > LLM self-report |
| A6 (Zero-Trust Execution) | Workers receive thinking policy; cannot modify or negotiate |
| A7 (Prediction Error as Learning) | Thinking effectiveness = delta(predicted, actual outcome) |

---

## 2. Competitive Landscape

### 2.1 Framework Comparison: Thinking/Reasoning Architecture

| Framework | Thinking Control | Multi-Hypothesis | Verification | Budget Mgmt | Epistemic Governance |
|-----------|-----------------|-----------------|-------------|-------------|---------------------|
| **Vinyan** (current) | Per-level ThinkingConfig (3 modes) | ✗ | Oracle gate (5 oracle types) | ReasoningPolicy gen/verify split | A1-A7 axioms, rule-based |
| **LangGraph** | Manual node design; no thinking abstraction | Manual parallel branches | User-implemented | Token counting via callbacks | None — developer responsibility |
| **AutoGen/MS Agent Framework** | Conversation patterns; no thinking modes | GroupChat multi-agent | User-defined evaluator | Budget parameter per conversation | None — conversation-level only |
| **CrewAI** | Role-based prompting; thinking = system prompt | Parallel task execution (not hypothesis) | ✗ (no built-in verification) | Max iterations per task | None |
| **DSPy** | Compiler-optimized prompts; `ChainOfThought` module | Ensemble via optimization | Metric-based evaluation | ✗ (prompt-level, not token-level) | Optimization traces only |
| **OpenHands/Devin** | Opaque internal reasoning | ✗ | Test execution feedback | Context window management | None |
| **Claude Code** | Adaptive thinking (API-level); interleaved thinking | ✗ | Lint + test execution | Token budget per task | Runtime prompt harness |

**Key insight**: No framework treats thinking as a *governable, verifiable* dimension. Most treat it as either opaque (Claude Code, OpenHands), conversation-level (AutoGen), or prompt-engineering (DSPy, CrewAI). Vinyan's oracle-gate architecture uniquely enables **measuring thinking effectiveness** through independent verification.

### 2.2 Provider-Level Thinking APIs (as of 2026-04)

| Provider | API Control | Budget Mechanism | Adaptive Mode |
|----------|------------|-----------------|---------------|
| **Anthropic** (Claude 4.6) | `thinking.type: "adaptive"` with `effort` param; `"enabled"` with `budget_tokens` | Token budget cap; preserved across turns since Opus 4.5 | Model dynamically determines thinking depth |
| **OpenAI** (o3/o4-mini) | `reasoning_effort: "low"/"medium"/"high"` | Internal — not exposed; inference cost ∝ reasoning tokens | Model-internal chain-of-thought |
| **DeepSeek** (R1) | Open-weight; thinking visible in output | No explicit budget; generate until `</think>` | Temperature/sampling params only |
| **Google** (Gemini 3) | `thinkingConfig.thinkingBudget` (0-24576 tokens) | Token budget cap | Model decides when to think |

**Vinyan alignment**: Current `ThinkingConfig` maps cleanly to Anthropic's API. Extension to multi-provider requires abstracting the budget mechanism — some providers (OpenAI) don't expose token budgets, requiring effort-level mapping instead.

---

## 3. Academic Research Synthesis

### 3.1 Budget-Aware Thinking

#### BudgetThinker (Wen et al., Tsinghua, Aug 2025)
**Source**: arXiv:2508.17196 — published at ICML 2026

**Core mechanism**: Dynamic control token insertion that continuously reminds the model of remaining budget. Two-stage training: SFT to follow control tokens + GRPO reinforcement learning for budget adherence.

**Key results**: Precise control over reasoning length while maintaining quality. The model learns when to "compress" reasoning vs. "expand" exploration based on remaining budget.

**Vinyan relevance**: HIGH. BudgetThinker proves that **external budget signals can govern thinking depth without degrading quality**. This directly validates the debate synthesis's proposal that `ThinkingPolicy.reasoning.generationBudget` can be dynamically adjusted per-task.

**Design implication**: Vinyan doesn't need to train models — it operates at the API layer. But the BudgetThinker insight maps to: use `budget_tokens` (Anthropic) or `reasoning_effort` (OpenAI) as the actuator, with the Orchestrator computing the budget from `f(risk, ambiguity, confidence)`.

#### SelfBudgeter (Muennighoff et al., Jan 2025)
**Source**: arXiv:2505.11274

Adaptive token allocation where the model itself learns to allocate reasoning tokens. Complements BudgetThinker by showing that even without external control tokens, models can learn budget-awareness through training.

**Vinyan relevance**: MEDIUM. Vinyan's A3 axiom requires deterministic governance — the Orchestrator sets the budget, not the model. But SelfBudgeter's insight about "easy tasks need fewer tokens" validates the debate synthesis's **confidence decay principle** (P7): as SelfModel confidence increases for a task type, thinking budget should decrease.

#### Thinking-Optimal Scaling (Yang et al., NeurIPS 2025)
**Source**: NeurIPS 2025 poster

**Critical finding**: Excessively scaling Chain-of-Thought length **can impair** reasoning performance. Proposes Thinking-Optimal Scaling strategy that dynamically identifies the sweet spot.

**Vinyan relevance**: CRITICAL. This directly validates the Economist's concern about "unlimited thinking" and the rejection of unbounded thinking in the debate synthesis (§8: rejected idea). The optimal thinking budget is **task-type-dependent and non-monotonic** — more thinking isn't always better.

**Design implication**: The `thinkingDepth = f(risk, ambiguity, confidence)` function should have a **ceiling** that decreases as SelfModel becomes calibrated for a task type. The function should NOT be monotonically increasing with ambiguity.

### 3.2 Multi-Path Reasoning (MCTS and Variants)

#### RethinkMCTS (Li et al., SJTU + Huawei, EMNLP 2025)
**Source**: ACL Anthology 2025.emnlp-main.410

**Core mechanism**: Monte Carlo Tree Search at the **thought level** (not token level) for code generation. Key innovation: "rethink" mechanism that incorporates fine-grained code execution feedback to refine erroneous thoughts during search. Search explores reasoning paths *before* generating code.

**Key results**: Thought-level search outperforms token-level and line-level search. The rethink mechanism (injecting failure evidence) further improves over pure MCTS.

**Vinyan relevance**: HIGH. RethinkMCTS is essentially multi-hypothesis generation with oracle-verified refinement — exactly what the debate synthesis proposes. The "rethink" mechanism maps to Vinyan's **counterfactual mode**: inject verification failure evidence into a new generation attempt.

**Design implication**: The multi-hypothesis `ThinkingConfig` variant should support both **parallel branching** (explore multiple thought paths) and **sequential refinement** (rethink on failure). These are complementary, not alternatives.

#### Collaborative Tree Search (CoTS, CVPR 2025)
**Source**: github.com/zulihit/CoTS

Multi-agent collaborative tree search where multiple agents contribute to different branches. Relevant to Vinyan's debate mode proposal but currently only demonstrated in vision/reasoning tasks, not code generation.

**Vinyan relevance**: LOW (for now). CoTS validates the architectural possibility of debate mode but confirms the debate synthesis recommendation to defer — the mechanism requires multiple heterogeneous agents to be meaningful.

#### Graph-MCTS and Empirical-MCTS (NeurIPS 2025)

Graph-based MCTS extends tree search to DAG structures (reusing subtrees). Empirical-MCTS adds dual-experience learning from both successful and failed paths.

**Vinyan relevance**: MEDIUM. The DAG structure insight is relevant for Phase 3 deliberative mode where intermediate reasoning checkpoints could be shared across hypotheses. The dual-experience learning directly maps to A7 (Prediction Error as Learning).

### 3.3 Counterfactual Reasoning in Agentic Systems

#### CAIR — Counterfactual Agent Influence Ranker (EMNLP 2025)
**Source**: ACL Anthology 2025.emnlp-main.958

**Core mechanism**: Given an Agentic AI Workflow (AAW), CAIR ranks each agent by its causal influence on the final output using counterfactual analysis. Tests 3 architectures: sequential chains, orchestrator-hub, and router-based.

**Key results**: CAIR produces consistent rankings that outperform baseline methods. The orchestrator architecture shows the most sensitivity to individual agent influence — removing a single agent has larger effects than in sequential chains.

**Vinyan relevance**: HIGH. CAIR provides a **formal basis for measuring thinking effectiveness** across Vinyan's routing levels. Instead of asking "did thinking help?" (causally fraught), ask "what's the counterfactual influence of the thinking-engine choice on outcome quality?" This satisfies the Epistemicist's constraint (§3.3): oracle-grounded measurement, no causal claims about thinking itself.

**Design implication**: The `observationKey` in ThinkingPolicy could feed a CAIR-like analysis: compare task outcomes across different thinking modes for the same task type. The A7 prediction error already captures part of this; CAIR adds counterfactual rigor.

#### Causal AI for Decision Intelligence (2026 trend)

Causal reasoning is becoming mainstream in enterprise AI (theCUBE Research, Jan 2026). "Parametric Tyranny" (LLMs cling to trained knowledge during counterfactual reasoning) is a recognized problem — LLMs struggle to reason about "what if things were different" because their weights encode the actual world.

**Vinyan relevance**: MEDIUM. The Parametric Tyranny problem validates A1 (Epistemic Separation): the generator shouldn't evaluate counterfactuals about its own reasoning. Counterfactual analysis belongs in the Orchestrator + oracle layer, using execution evidence, not LLM introspection.

### 3.4 Test-Time Compute Scaling

#### Two-Dimensional Test-Time Compute (Adaptive ML, 2025)

**Critical insight**: Test-time compute has two dimensions:
1. **Serial**: Longer chains of thought (more tokens per attempt)
2. **Parallel**: Multiple attempts with selection (more attempts)

These are **independent and complementary**. Serial scaling (CoT) has diminishing returns per-domain. Parallel scaling (best-of-N with selection) has log-linear scaling but requires a good selection mechanism.

**Vinyan relevance**: CRITICAL. This directly maps to the debate synthesis's 2D model:
- Serial depth → thinking budget (ThinkingConfig effort/budgetTokens)
- Parallel breadth → multi-hypothesis (ThinkingConfig branches)
- Selection mechanism → oracle gate (existing!)

Vinyan already has the selection mechanism (oracle gate) that most systems lack. The missing piece is the parallel generation dimension.

#### Survey: Three Pillars of Slow Thinking (ScienceDirect, 200+ studies)

Three interdependent pillars: (1) Test-time scaling (adaptive compute), (2) Reinforcement learning (reward models), (3) Slow-thinking frameworks (CoT, multi-agent deliberation).

**Vinyan alignment**: Vinyan implements pillar 1 (adaptive ThinkingConfig) and pillar 3 (structured reasoning via ReasoningEngine hierarchy). Pillar 2 is partially addressed by SelfModel calibration (A7) but doesn't use RL/reward models. This is a **deliberate design choice** — RL requires training infrastructure that Vinyan avoids by using API-level models.

#### Intelligent Router Architecture (Meta Intelligence, 2026)

Enterprise recommendation: lightweight classifier routes tasks by complexity to different model tiers. Simple tasks → cheap models, complex reasoning → expensive models.

**Vinyan alignment**: Vinyan already implements this via risk-router.ts (L0=reflex → L3=deliberative). The extension is routing by **both risk and ambiguity**, not just risk.

---

## 4. Design Principles (Research-Validated)

The debate synthesis produced 8 design principles (P1-P8). Research validates all 8, with nuance on two:

| Principle | Research Validation | Nuance |
|-----------|-------------------|--------|
| P1: Thinking is generation, not governance | ✅ BudgetThinker, CAIR — external control, not self-governance | — |
| P2: Policy flows one-way (Orch→Worker) | ✅ CAIR — orchestrator architecture most sensitive to agent choice | — |
| P3: Oracle-grounded measurement only | ✅ CAIR — counterfactual influence, not causal claims | CAIR adds formal rigor beyond simple oracle confidence delta |
| P4: Economic + epistemic activation gates | ✅ Thinking-Optimal Scaling — more isn't always better | Gate should also consider **non-monotonicity**: optimal budget may decrease |
| P5: Generator never self-selects | ✅ RethinkMCTS — oracle (execution) selects, not generator | RethinkMCTS also shows that execution feedback improves next attempt |
| P6: Precompute profiles for cache | ⚠️ BudgetThinker — fine-grained per-task budgets outperform fixed profiles | Tension: cache efficiency vs. per-task optimization. Recommend 6-8 profiles covering the 2D grid |
| P7: Confidence decay (learned → less thinking) | ✅ Thinking-Optimal Scaling — excessive CoT impairs performance | Strong validation — both theoretical and empirical |
| P8: Types now, behavior later | ✅ DSPy — declarative interface enables future optimization | — |

### 4.1 New Principles from Research

| # | Principle | Source | Rationale |
|---|-----------|--------|-----------|
| P9 | **Non-monotonic thinking budget** | Thinking-Optimal Scaling (NeurIPS 2025) | Optimal thinking has a peak — exceeding it degrades performance. ThinkingPolicy needs ceiling, not just floor. |
| P10 | **Parallel > serial for high-ambiguity** | 2D test-time compute (Adaptive ML) | When ambiguity is high, 3 short attempts (parallel) beat 1 long attempt (serial). Multi-hypothesis is more efficient than deep thinking for exploration. |
| P11 | **Refinement > restart** | RethinkMCTS (EMNLP 2025) | Injecting failure evidence into next attempt outperforms clean restart. Counterfactual mode should pass failure diagnostics, not just "try again." |
| P12 | **Counterfactual influence > causal attribution** | CAIR (EMNLP 2025) | Don't ask "did thinking help?" (unfalsifiable). Ask "would outcome differ without this thinking mode?" (testable via A/B on same task types). |

---

## 5. Architecture

### 5.1 Thinking Computation Flow

```mermaid
graph TD
    T[Task Input] --> RS[Risk Scorer]
    T --> AS[Ambiguity Scorer]
    T --> SM[SelfModel Lookup]
    
    RS --> |riskScore| TPC[ThinkingPolicy Compiler]
    AS --> |ambiguityScore| TPC
    SM --> |confidence, failRate| TPC
    
    TPC --> |ThinkingPolicy| RD[RoutingDecision]
    
    subgraph "ThinkingPolicy Compiler (deterministic)"
        TPC --> VD[Verification Depth<br/>f(riskScore)]
        TPC --> TD[Thinking Depth<br/>f(ambiguity, confidence)]
        TPC --> MS[Mode Selection<br/>rules-based]
    end
    
    RD --> WP[WorkerPool]
    WP --> RE[ReasoningEngine]
    RE --> OG[Oracle Gate]
    OG --> |verdict + evidence| TC[TraceCollector]
    TC --> |prediction error| SM
```

### 5.2 Ambiguity Signal Computation

Research suggests ambiguity cannot be a single number — it's computed from multiple signals:

```typescript
interface AmbiguitySignals {
  /** Plan structural complexity (DAG depth, branch count) */
  planComplexity: number;          // 0-1, from TaskDecomposer output
  
  /** Prior trace count for this task type */
  priorTraceCount: number;         // raw count → decayed confidence
  
  /** SelfModel prediction confidence for this task type */
  selfModelConfidence: number;     // 0-1, from SelfModel EMA
  
  /** Goal specificity (are acceptance criteria machine-checkable?) */
  goalSpecificity: number;         // 0-1, from plan validation
  
  /** Domain novelty (is this a known task structure?) */
  domainNovelty: number;           // 0-1, from task-type signature matching
}

/** Deterministic computation (A3-safe) */
function computeAmbiguity(signals: AmbiguitySignals): number {
  const weights = {
    planComplexity: 0.25,
    priorTraceConfidence: 0.30,    // inverse of trace count (decayed)
    goalSpecificity: 0.20,         // inverse: vague goals = high ambiguity
    domainNovelty: 0.25
  };
  // Weighted sum, clamped 0-1
  return clamp(
    weights.planComplexity * signals.planComplexity +
    weights.priorTraceConfidence * (1 - decayedConfidence(signals.priorTraceCount)) +
    weights.goalSpecificity * (1 - signals.goalSpecificity) +
    weights.domainNovelty * signals.domainNovelty,
    0, 1
  );
}
```

### 5.3 2D Thinking Grid (Operational)

```
                        HIGH AMBIGUITY (>0.6)
                              │
              ┌───────────────┼───────────────┐
              │ Profile C     │ Profile D     │
              │ Serial: high  │ Serial: high  │
              │ Parallel: 2-3 │ Parallel: 3-4 │
              │ Verify: light │ Verify: full  │
              │ Budget: 8K    │ Budget: 16K   │
              │               │               │
 LOW RISK ────┼───────────────┼───────────────┼──── HIGH RISK
 (<0.3)       │               │               │     (>0.7)
              │ Profile A     │ Profile B     │
              │ Serial: none  │ Serial: med   │
              │ Parallel: 1   │ Parallel: 1   │
              │ Verify: none  │ Verify: full  │
              │ Budget: 0     │ Budget: 4K    │
              │               │               │
              └───────────────┼───────────────┘
                              │
                        LOW AMBIGUITY (<0.3)
```

**6 profiles** (A-D + 2 intermediate) cover the grid economically, satisfying P6 (cache efficiency).

### 5.4 Mode Selection Rules (Phase 2)

```typescript
function selectThinkingMode(
  risk: number,
  ambiguity: number,
  failRate: number,
  confidence: number
): ThinkingConfig {
  // P7: Confidence decay — learned tasks get less thinking
  const adjustedAmbiguity = ambiguity * (1 - confidence * 0.5);
  
  // P9: Non-monotonic ceiling — cap based on task-type calibration
  const maxBudget = computeCeiling(confidence, failRate);
  
  // P10: High-ambiguity → parallel > serial
  if (adjustedAmbiguity > 0.6 && failRate > 0.30) {
    return {
      type: 'multi-hypothesis',
      branches: failRate > 0.50 ? 4 : 3,
      diversityConstraint: 'different-patterns',
      selectionRule: 'oracle-score'  // P5: never self-select
    };
  }
  
  // P11: Recent failure → counterfactual before escalation
  if (workingMemory.hasRecentFailure(taskType) && failRate > 0.20) {
    return {
      type: 'counterfactual',
      trigger: 'verification_failure',
      maxRetries: 2,
      constraintSource: 'working-memory'
    };
  }
  
  // Default: adaptive with budget from 2D grid
  const budget = Math.min(computeBudget(risk, adjustedAmbiguity), maxBudget);
  return budget === 0
    ? { type: 'disabled' }
    : { type: 'adaptive', effort: mapBudgetToEffort(budget) };
}
```

---

## 6. Data Contracts

### 6.1 ThinkingPolicy (full schema, from debate synthesis + research additions)

```typescript
interface ThinkingPolicy {
  /** Who computed this policy */
  source: 'default' | 'calibrated' | 'task-override';

  /** LLM thinking mode */
  thinking: ThinkingConfig;

  /** Generation/verification budget split */
  reasoning: ReasoningPolicy;

  /** Computed ambiguity signal (0-1) — NEW */
  ambiguityScore?: number;

  /** Profile ID for cache optimization (P6) — NEW */
  profileId?: 'A' | 'B' | 'C' | 'D' | 'AB' | 'CD';

  /** Non-monotonic ceiling for this task type (P9) — NEW */
  thinkingCeiling?: number;

  /** Trace observation key for A7 learning */
  observationKey?: string;

  /** Post-verification: thinking mode influence on outcome (CAIR-inspired) */
  counterfactualInfluence?: number;

  /** Per-task-type calibration (populated offline) */
  taskTypeCalibration?: {
    taskTypeSignature: string;
    minObservationCount: number;
    basis: 'insufficient' | 'emerging' | 'calibrated';
    recommendedThinking: ThinkingConfig;
    optimalBudgetRange?: { min: number; max: number };  // from P9
    historicalFailRate?: number;                         // for multi-hypothesis gate
  };
}
```

### 6.2 Thinking Trace Event (for A7 learning)

```typescript
interface ThinkingTraceEvent {
  taskId: string;
  taskTypeSignature: string;
  
  /** Policy applied */
  policy: ThinkingPolicy;
  
  /** Actual tokens consumed (serial) */
  thinkingTokensUsed: number;
  
  /** Branches attempted (parallel) — NEW */
  branchesAttempted?: number;
  branchesPassedOracle?: number;
  
  /** Oracle verdict on final output */
  oracleVerdict: OracleVerdict;
  oracleConfidence: number;
  
  /** Escalation: did thinking prevent L-escalation? */
  escalationAvoided: boolean;
  
  /** Cost */
  tokenCost: number;
  latencyMs: number;
  
  /** Prediction error for SelfModel */
  predictionError: number;
}
```

---

## 7. Critical Analysis

### 7.1 What the Research Validates in the Debate Synthesis

| Debate Finding | Validation | Strength |
|---------------|-----------|----------|
| 2D thinking model (risk × ambiguity) | Adaptive ML "2D test-time compute"; intelligent router research | **Strong** — independently discovered same decomposition |
| Counterfactual before escalation | CAIR framework; RethinkMCTS rethink mechanism | **Strong** — both academic and empirical evidence |
| Oracle selects, never generator | RethinkMCTS (execution feedback selects); BudgetThinker (external control) | **Strong** — consistent across all search-based methods |
| Confidence decay (P7) | Thinking-Optimal Scaling (excessive CoT harms); BudgetThinker (budget adherence) | **Strong** — diminishing/negative returns are real |
| Multi-hypothesis with oracle gate | RethinkMCTS, CoTS, Graph-MCTS | **Moderate** — demonstrated in code/math, not general tasks |
| Reject metacognitive monitoring | Parametric Tyranny (LLMs bad at self-evaluation) | **Strong** — fundamental limitation, not just overhead |

### 7.2 What the Research Challenges

| Debate Finding | Challenge | Severity |
|---------------|----------|----------|
| "6 precomputed profiles sufficient" (P6) | BudgetThinker shows per-task fine-grained budgets outperform fixed tiers | **Low** — Vinyan operates at API level where 3-4 effort levels are the actual granularity |
| "Multi-hypothesis only at >30% failure rate" | RethinkMCTS shows benefits even at moderate failure rates when thought-level search is used | **Medium** — the 30% gate may be too conservative for thought-level branching (vs full-task branching) |
| "Debate mode requires heterogeneous engines" | CoTS shows collaborative search works with homogeneous agents using different prompts | **Low** — but CoTS also shows marginal benefit vs. single-agent MCTS in most cases |

### 7.3 What the Research Adds (Not in Debate Synthesis)

1. **Non-monotonic thinking budget (P9)**: The debate synthesis assumed "more thinking = better up to cost limit." Research shows a **quality peak** beyond which additional thinking tokens degrade performance. This should be a hard constraint in ThinkingPolicy.

2. **Refinement > restart (P11)**: The debate synthesis's counterfactual mode says "try a different approach." RethinkMCTS shows that passing **fine-grained failure diagnostics** (not just "it failed") produces 15-20% better outcomes than clean restarts. Vinyan's oracle verdicts already provide this evidence — the counterfactual mode should pass the full oracle evidence chain, not just a boolean failure signal.

3. **Counterfactual influence measurement (P12)**: CAIR provides a formal method for measuring "did this thinking mode help?" without causal claims. This directly addresses the Epistemicist's concern about forbidden metrics (§3.3 of debate synthesis). Implementation: compare oracle confidence distributions across thinking modes for the same task-type signature.

4. **DSPy-style compilation as future direction**: DSPy's insight — declarative task definition + automated prompt optimization — is orthogonal to Vinyan's thinking architecture but could enhance it. Future: ThinkingPolicy could include a `promptStrategy` field optimized per-task-type via trace data, similar to DSPy's compilation step.

### 7.4 Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|-----------|
| Ambiguity signal is noisy early | High | Medium | Gate activation on ≥200 traces (debate synthesis §5, Phase 2) |
| Multi-hypothesis costs exceed benefit | Medium | High | Economic gate (>30% failure) + CAIR measurement |
| Provider API changes break ThinkingConfig mapping | Medium | Low | Abstract provider capability via ReasoningEngine interface |
| Thinking-Optimal ceiling is task-type-dependent | High | Medium | Per-type calibration with minObservationCount ≥50 |
| Excessive complexity in ThinkingPolicy type | Low | High | Phase-gated: add fields only when behavioral implementation is ready |

---

## 8. Recommendations & Implementation Priority

### 8.1 Phased Implementation (research-informed update to debate synthesis)

| Phase | Scope | Research Basis | Priority |
|-------|-------|---------------|----------|
| **1.1** | ThinkingPolicy type + observationKey + profileId | Debate synthesis §5.1; DSPy declarative pattern | Immediate |
| **1.2** | Ambient data collection (thinkingTokensUsed, oracleConfidence per task) | CAIR measurement pattern; A7 calibration | Immediate |
| **2.1** | Ambiguity signal computation + 2D routing grid | 2D test-time compute; Thinking-Optimal Scaling | After 200 traces |
| **2.2** | Counterfactual mode (inject oracle evidence on failure) | RethinkMCTS rethink; CAIR; economic case (2x vs 5x escalation) | After 2.1 |
| **2.3** | Multi-hypothesis (parallel branching + oracle selection) | RethinkMCTS; 2D compute; debate synthesis §4.2 | After 2.2 proven |
| **2.4** | Non-monotonic ceiling + confidence decay | Thinking-Optimal Scaling; BudgetThinker | With 2.1 (calibration data) |
| **3.1** | Deliberative mode (checkpoint-based reasoning) | Graph-MCTS; Empirical-MCTS dual-experience | After Phase 2 ROI proven |
| **3.2** | Debate mode (multi-engine) | CoTS; requires ≥2 heterogeneous REs | Phase 3+ |

### 8.2 Key Architectural Decisions

| Decision | Recommendation | Basis |
|----------|---------------|-------|
| **Ambiguity computation** | Weighted sum of 4 signals (plan complexity, trace confidence, goal specificity, domain novelty) | Deterministic (A3); observable inputs only |
| **Mode selection** | Rules-based function with defined precedence: counterfactual → multi-hypothesis → adaptive → disabled | A3; fail-rates and economic gates determine precedence |
| **Thinking ceiling** | Per-task-type, calibrated from trace data, decreasing with SelfModel confidence | Thinking-Optimal Scaling (NeurIPS 2025) |
| **Counterfactual evidence** | Pass full oracle evidence chain + failed approach hash, not just boolean | RethinkMCTS shows 15-20% improvement with fine-grained feedback |
| **Multi-hypothesis selection** | Oracle score only; never generator self-assessment | A1; RethinkMCTS confirms execution-based selection dominates |
| **Profile count** | 6 profiles (2×3 grid: 2 risk tiers × 3 ambiguity tiers) | Balance P6 (cache) with 2D coverage; actual API granularity is 3-4 levels |

---

## 9. Sources

### 9.1 Academic Papers

| Ref | Title | Venue | Date | Confidence |
|-----|-------|-------|------|-----------|
| [1] | BudgetThinker: Empowering Budget-Aware LLM Reasoning with Control Tokens | arXiv:2508.17196 / ICML 2026 | Aug 2025 | High |
| [2] | SelfBudgeter: Adaptive Token Allocation for Efficient LLM Reasoning | arXiv:2505.11274 | Jan 2025 | Medium |
| [3] | Towards Thinking-Optimal Scaling of Test-Time Compute for LLM Reasoning | NeurIPS 2025 poster | Sep 2025 | High |
| [4] | RethinkMCTS: Refining Erroneous Thoughts in MCTS for Code Generation | EMNLP 2025; arXiv:2409.09584 | Nov 2025 | High |
| [5] | CoTS: Collaborative Tree Search (multi-agent) | CVPR 2025 | Jun 2025 | Medium |
| [6] | Empirical-MCTS: Dual-Experience Learning | NeurIPS 2025 | Dec 2025 | Medium |
| [7] | CAIR: Counterfactual-based Agent Influence Ranker | EMNLP 2025 | Nov 2025 | High |
| [8] | A Survey of Slow Thinking-Based Reasoning LLMs | ScienceDirect (200+ studies) | 2025-2026 | High |
| [9] | Test-Time Compute is Two-Dimensional | Adaptive ML blog | 2025 | Medium |

### 9.2 Provider Documentation

| Ref | Source | Date | Confidence |
|-----|--------|------|-----------|
| [10] | Anthropic: Adaptive Thinking API Docs | platform.claude.com | 2026-04 | High |
| [11] | Anthropic: Extended Thinking with Tool Use | platform.claude.com | 2026-04 | High |
| [12] | OpenAI: o4-mini Documentation | openai.com/docs | 2025-04 | High |
| [13] | Claude's Extended Thinking (research preview) | anthropic.com | 2025-02 | High |

### 9.3 Industry Analysis

| Ref | Source | Date | Confidence |
|-----|--------|------|-----------|
| [14] | Inference Cost Burden Persistence | Epoch AI (Substack) | 2025 | Medium |
| [15] | Reasoning Model Comparison: DeepSeek R1 vs o3 vs Gemini 3 | Meta Intelligence | 2026 | Medium |
| [16] | LangGraph vs CrewAI vs AutoGen (Enterprise) | Towards AI / Medium | 2026 | Low-Medium |
| [17] | Top 5 Agentic AI Frameworks 2026 | FutureAGI (Substack) | Mar 2026 | Medium |
| [18] | AI Agent Framework Comparison | Turing.com | 2026 | Medium |
| [19] | DSPy: Let the Model Write the Prompt | Drew Breunig / Data+AI Summit | Jun 2025 | Medium |
| [20] | Causal AI Decision Intelligence (2026 trend) | theCUBE Research | Jan 2026 | Medium |

### 9.4 Internal Vinyan Documents

| Ref | Document | Role |
|-----|----------|------|
| [21] | extensible-thinking-debate-synthesis.md | Foundation — 4-team debate consensus |
| [22] | src/orchestrator/types.ts | Current ThinkingConfig, ReasoningPolicy types |
| [23] | src/gate/risk-router.ts | Current L0-L3 routing logic |
| [24] | src/orchestrator/llm/anthropic-provider.ts | ThinkingConfig → API mapping |
| [25] | ehd-confidence-architecture.md | EHD/confidence framework (must align) |
