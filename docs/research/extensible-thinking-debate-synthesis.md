# Extensible Thinking — Design Debate Synthesis

**Date:** 2026-04-04
**Status:** Design exploration (pre-implementation)
**Participants:** Team Pragmatist, Team Epistemicist, Team Futurist, Team Economist

> **Document boundary**: This document owns the debate synthesis and consensus recommendations for Vinyan's Extensible Thinking design.
> For current architecture, see [decisions.md](../architecture/decisions.md). For Claude Code lessons, see [claude-code-architecture-lessons.md](../analysis/claude-code-architecture-lessons.md). For TDD contracts, see [tdd.md](../spec/tdd.md).

---

## 1. Debate Question

**How should Vinyan extend its thinking/reasoning system to enable true autonomous task orchestration — beyond the current `adaptive/enabled/disabled` modes?**

Current state: `ThinkingConfig` (3 modes, routing-level determined) + `ReasoningPolicy` (gen/verify budget split, SelfModel calibrated). Gap: no unified policy, no per-task-type override, no thinking effectiveness tracking, no multi-hypothesis capability.

---

## 2. Team Positions — Summary Matrix

| Dimension | Pragmatist | Epistemicist | Futurist | Economist |
|-----------|-----------|-------------|---------|----------|
| **Unified ThinkingPolicy** | Build as additive wrapper; keep old fields | Build with hard constraints baked in | Build as extensible union type | Build with budget envelope baked in |
| **Per-task-type override** | Defer until 200+ tasks prove patterns | Allow only offline trace-derived overrides | Add ambiguity signal alongside risk | Map to 4-tier efficiency hierarchy |
| **Multi-hypothesis** | Reject (deterministic LLM = same output) | Allow only if all branches go through oracle gate | Core capability — 3-4x parallel generation | Viable only at >30% failure rate |
| **Worker negotiation** | Reject (Phase 1 scope) | Reject permanently (A6 violation) | Not proposed | Not proposed |
| **Thinking effectiveness** | 10% sampled, async, observation-only | Oracle-grounded metrics only, no causal claims | Self-Model calibrates mode selection via A7 | ROI-gated: extension must show >15% return |
| **Counterfactual reasoning** | Not discussed | Allowed if oracle-driven, not self-driven | Second-priority mode after multi-hypothesis | Viable for critical-path tasks only |
| **Debate mode** | Reject | Reject self-selection; oracle arbitrates | Third-priority; L3 only | Deeply negative ROI at current volumes |

---

## 3. Areas of Strong Consensus (4/4 teams agree)

### 3.1 ThinkingPolicy as a first-class type

All teams agree that thinking configuration deserves formalization beyond the current `ThinkingConfig` embedded in routing levels.

**Consensus type** (merged from all proposals):

```typescript
interface ThinkingPolicy {
  /** Who decided this policy */
  source: 'default' | 'calibrated' | 'task-override';

  /** LLM thinking mode (unchanged from today) */
  thinking: ThinkingConfig;

  /** Generation/verification budget split (unchanged from today) */
  reasoning: ReasoningPolicy;

  /** Trace observation key for A7 learning */
  observationKey?: string;

  /** Post-verification: did thinking improve outcome? (oracle-grounded) */
  oracleConfidenceDelta?: number;
}
```

**Design constraint (Epistemicist):** Workers receive this type but cannot modify or suggest changes to it. It flows one-way: Orchestrator → Worker.

**Budget constraint (Economist):** `ThinkingPolicy` should be derivable from a small set of precomputed profiles (5-6 max) to preserve prompt cache hit rates.

### 3.2 Workers must not influence governance

All teams reject worker-driven thinking negotiation. A6 (Zero-Trust Execution) is unanimously upheld: workers propose output; Orchestrator governs thinking depth.

### 3.3 Effectiveness measurement must be oracle-grounded

All teams agree that "thinking improved outcomes by X%" is epistemically dangerous unless grounded in oracle verdicts, not in the generator's self-assessment.

**Allowed metric:** "Over N traces of task-type T, oracle confidence distribution with thinking-mode X vs mode Y."

**Forbidden metric:** "Thinking reduced failure rate by Z%" (no counterfactual ground truth).

### 3.4 Backward compatibility is non-negotiable

All teams propose additive changes. Existing `ThinkingConfig` and `ReasoningPolicy` fields in `RoutingDecision` remain. New `ThinkingPolicy` is an optional computed accessor.

---

## 4. Key Disagreements — The Debate

### 4.1 Should thinking depth decouple from routing level?

| Team | Position | Argument |
|------|----------|----------|
| **Pragmatist** | No (for now) | Risk ↔ thinking correlation is untested. Keep coupled until data proves independence. |
| **Futurist** | Yes, immediately | High-risk ≠ high-ambiguity. Refactoring 50 files (high risk, low ambiguity) shouldn't waste tokens on deep thinking. |
| **Epistemicist** | Only via offline calibration | Decoupling is allowed if the mapping is deterministic and trace-derived, not runtime-negotiated. |
| **Economist** | Yes, via confidence decay | Learned tasks (high confidence) should use less thinking regardless of risk level. |

**Synthesis verdict:** **Decouple, but deterministically.** Introduce an `ambiguity` signal alongside `riskScore`:

```
thinkingDepth = f(riskScore, ambiguity, selfModelConfidence)
    where ambiguity is computed from task structure (plan complexity, prior trace count)
    and the function is deterministic (A3-safe)
```

This satisfies Futurist's vision, Epistemicist's A3 constraint, and Economist's confidence decay.

**Implementation timing:** After 200+ traces provide calibration data (Pragmatist's gating condition).

---

### 4.2 Multi-hypothesis: wasteful or essential?

This is the sharpest disagreement.

**Pragmatist's strongest argument:** LLM generation is near-deterministic within a session. Running the same prompt 3 times produces the same output. Multi-hypothesis requires different prompts (noise injection) or temperature randomization (harms reproducibility). For single-engine scenarios, it's wasteful.

**Futurist's strongest argument:** Multi-hypothesis isn't "run 3 times." It's "generate 3 structurally different approaches" with diversity constraints (`different-patterns`, `different-resources`). Each branch gets a different framing prompt. Research shows 4-attempt multi-hypothesis beats single-attempt + retry loops on high-ambiguity tasks. The win is +24% success rate on cross-domain synthesis.

**Epistemicist's constraint:** Multi-hypothesis is allowed **only if** all branches pass through oracle gate independently. The generator must NOT self-select the "best" branch — that's A1 violation (generation evaluating its own output). Oracle scores determine the winner.

**Economist's constraint:** Multi-hypothesis breaks even only when task failure rate >30%. At current L2 costs, 3-branch generation costs 2.4x baseline. ROI is positive only for high-failure domains.

**Synthesis verdict:** **Multi-hypothesis is architecturally sound but economically conditional.**

Design it now (extend `ThinkingConfig` union type). Enable it only when:
1. Task type has historical failure rate >30% (Economist's gate)
2. All N branches go through oracle gate independently (Epistemicist's constraint)
3. Orchestrator selects winner by oracle score, not generator self-assessment (A1)
4. Diversity constraint is explicit in the prompt (Futurist's design)

```typescript
| { type: 'multi-hypothesis'; branches: 2 | 3 | 4;
    diversityConstraint: 'different-patterns' | 'different-resources';
    selectionRule: 'oracle-score' | 'evidence-weight'; }  // never 'self-select'
```

---

### 4.3 Per-task-type override: premature or essential?

**Pragmatist:** Only 2 task types exist today (`code` | `reasoning`). Building per-type overrides for 2 types is noise. Wait for 5+ types with divergent data.

**Futurist:** Task types will grow. Architecture should accommodate them now (at type level, not behavior level).

**Epistemicist:** Overrides must derive from offline trace analysis with `minObservationCount`. No ad-hoc rules.

**Economist:** Map to 4-tier efficiency hierarchy (T1-T4), not open-ended per-type config.

**Synthesis verdict:** **Build the slot, don't fill it yet.**

```typescript
interface ThinkingPolicy {
  // ... base fields ...

  /** Per-task-type calibration (populated by offline trace analysis only) */
  taskTypeCalibration?: {
    taskTypeSignature: string;
    minObservationCount: number;
    basis: 'insufficient' | 'emerging' | 'calibrated';
    recommendedThinking: ThinkingConfig;
  };
}
```

The field exists in the type. SelfModel returns `undefined` until `minObservationCount ≥ 50` for a given task type. This satisfies:
- Pragmatist: no behavior change until data proves it
- Futurist: type system is ready for extension
- Epistemicist: trace-derived, basis field explicit
- Economist: can be mapped to T1-T4 tiers later

---

### 4.4 Counterfactual reasoning: luxury or essential?

**Futurist:** On verification failure, inject failure evidence into a new generation attempt with "try a different approach" framing. Trades thinking cost for avoiding L2→L3 escalation.

**Economist:** Counterfactual is the most economically viable extension. Escalation from L2→L3 costs 5x; counterfactual costs 2x. Net savings: 3x per avoided escalation.

**Epistemicist:** Allowed if the failed approach is stored as a World Graph fact (content-addressed), and the retry is independently verified by oracle gate.

**Pragmatist:** Current escalation mechanism already handles this (route to higher level on failure). Counterfactual adds a "lateral retry before vertical escalation" step.

**Synthesis verdict:** **Strong candidate for Phase 2.** Economically justified, epistemically safe if oracle-verified. Implementation:

```typescript
| { type: 'counterfactual';
    trigger: 'verification_failure';
    maxRetries: 2;
    constraintSource: 'working-memory'; }  // failed approaches stored here
```

Key constraint: the counterfactual generator does NOT see its own prior thinking — only the oracle failure evidence. This preserves A1 (no self-evaluation).

---

### 4.5 Debate mode: visionary or uneconomical?

**Futurist:** Multiple ReasoningEngines argue about the same task; Orchestrator arbitrates by evidence weight. Powerful for high-stakes design decisions.

**Economist:** Deeply negative ROI at current volumes. 3-engine debate costs ~$2.94/task vs $0.30 baseline. Break-even requires catching issues that single-engine misses on >40% of debated tasks.

**Epistemicist:** Architecturally sound IF arbitration is oracle-driven, not consensus-driven. Each participant submits `falsifiable_by` claims; oracle tests them.

**Pragmatist:** Not needed until Vinyan has 3+ genuinely different engine types. Currently only LLM engines exist.

**Synthesis verdict:** **Defer to Phase 3+.** Requires multiple heterogeneous ReasoningEngines to be meaningful. Design the type now; don't implement.

---

### 4.6 Metacognitive monitoring: innovation or overhead?

**Futurist:** Mid-generation, Orchestrator observes intermediate output for confidence drift, circular reasoning, or plan incoherence. Auto-adjusts thinking depth.

**Epistemicist:** Extremely dangerous. This lets the generator's internal state influence governance (A3/A6 violation). "Confidence is dropping → escalate" means the generator controls its own routing.

**Economist:** 50% continuous overhead (15K tokens/task) with uncertain upside. Requires >1,000 tasks before any ROI signal.

**Pragmatist:** Not opposed in principle, but implementation complexity is high for speculative gain.

**Synthesis verdict:** **Reject for now.** The A3/A6 concerns are well-founded: generator internal state should not drive governance decisions in real-time. Alternative: post-hoc analysis of thinking traces (offline, not real-time) can surface patterns without violating governance boundaries.

---

## 5. Synthesized Architecture — Extensible Thinking Roadmap

### Phase 1.1: Foundation (Current + ThinkingPolicy type)

**Scope:** Type-level changes only. No behavioral changes.

```typescript
// Extend RoutingDecision
export interface RoutingDecision {
  // ... existing fields ...
  thinkingPolicy?: ThinkingPolicy;  // NEW: optional, computed by Orchestrator
}

// ThinkingPolicy type
export interface ThinkingPolicy {
  source: 'default' | 'calibrated' | 'task-override';
  thinking: ThinkingConfig;
  reasoning: ReasoningPolicy;
  observationKey?: string;
  taskTypeCalibration?: {
    taskTypeSignature: string;
    minObservationCount: number;
    basis: 'insufficient' | 'emerging' | 'calibrated';
    recommendedThinking: ThinkingConfig;
  };
}

// Extended ThinkingConfig union (types only, not implemented)
export type ThinkingConfig =
  | { type: 'adaptive'; effort: 'low' | 'medium' | 'high' | 'max'; display?: 'omitted' | 'summarized' }
  | { type: 'enabled'; budgetTokens: number; display?: 'omitted' | 'summarized' }
  | { type: 'disabled' }
  // Future modes (type-only for now):
  | { type: 'multi-hypothesis'; branches: 2 | 3 | 4;
      diversityConstraint: 'different-patterns' | 'different-resources';
      selectionRule: 'oracle-score' | 'evidence-weight' }
  | { type: 'counterfactual'; trigger: 'verification_failure';
      maxRetries: number; constraintSource: 'working-memory' }
  | { type: 'deliberative'; checkpoints: number; depthLimit: number }
  | { type: 'debate'; participants: string[]; debateTurns: number;
      arbitrationRule: 'oracle-score' | 'evidence-weight' };
```

**Deliverables:**
- `ThinkingPolicy` type in `src/orchestrator/types.ts`
- `observationKey` field in trace events
- `compileThinkingPolicy()` function that returns merged view from existing fields
- No behavior change — backward compatible

### Phase 2: Data-Driven Activation

**Gate:** ≥200 traces with observation keys collected.

**Scope:**
1. Ambiguity signal extracted from task structure (plan complexity, prior trace count)
2. `thinkingDepth = f(riskScore, ambiguity, confidence)` — deterministic function
3. Per-task-type calibration populated when `minObservationCount ≥ 50`
4. Counterfactual mode implementation (lateral retry before vertical escalation)

**Activation criteria per mode:**

| Mode | Activation gate | Economic gate | Epistemic gate |
|------|----------------|---------------|----------------|
| Per-task calibration | ≥50 traces of type T | Oracle confidence delta >5% | Basis = 'calibrated' |
| Multi-hypothesis | Historical fail rate >30% for type T | Cost <3x baseline per task | All branches oracle-verified |
| Counterfactual | Fail rate >20% at current level | Cost <2x vs escalation | Failed approach in working memory |

### Phase 3: Advanced Modes

**Gate:** Phase 2 modes proven with positive ROI on real tasks.

**Scope:**
1. Debate mode (requires ≥2 heterogeneous ReasoningEngine types)
2. Deliberative mode (checkpoint-based reasoning with intermediate oracle validation)
3. SelfModel learning: which thinking modes reduce prediction error (A7)
4. Monthly cost dashboard with automatic tier downgrade for mastered tasks

---

## 6. Consensus Design Principles

These principles emerged from cross-team agreement during the debate:

| # | Principle | Source teams |
|---|-----------|-------------|
| P1 | **Thinking is generation, not governance.** Thinking output is a hypothesis; oracle gate verifies. | All 4 |
| P2 | **Thinking policy flows one-way.** Orchestrator → Worker. No reverse channel. | Pragmatist + Epistemicist |
| P3 | **Measure oracle-grounded outcomes, not causal effectiveness.** | Epistemicist + Economist |
| P4 | **Activate modes only when data passes economic + epistemic gates.** | Pragmatist + Economist |
| P5 | **The generator never selects between its own hypotheses.** Oracle scores determine winners. | Epistemicist + Futurist |
| P6 | **Precompute thinking profiles (5-6 max) for cache efficiency.** | Economist |
| P7 | **Confidence decay: learned tasks need less thinking.** Budget should decrease as SelfModel confidence increases. | Economist + Pragmatist |
| P8 | **Type system extensibility now; behavioral complexity later.** | Futurist + Pragmatist |

---

## 7. The Thinking Extension: Two Dimensions, Not One

The deepest insight from this debate is that "thinking depth" is **two independent dimensions**, not one slider:

```
                          HIGH AMBIGUITY
                               │
                               │
              ┌────────────────┼────────────────┐
              │  Low-risk       │   High-risk     │
              │  High-ambiguity │   High-ambiguity│
              │                 │                 │
              │  → Deep Think   │   → Deep Think  │
              │  → Light Verify │   → Deep Verify │
              │  (design exp.)  │   (security)    │
              │                 │                 │
  LOW RISK ───┼─────────────────┼─────────────────┼─── HIGH RISK
              │                 │                 │
              │  Low-risk       │   High-risk     │
              │  Low-ambiguity  │   Low-ambiguity │
              │                 │                 │
              │  → No Think     │   → Light Think │
              │  → No Verify    │   → Deep Verify │
              │  (L0 reflex)    │   (L3 rename)   │
              │                 │                 │
              └────────────────┼────────────────┘
                               │
                          LOW AMBIGUITY
```

- **Risk** determines verification depth (existing L0-L3 routing — correct)
- **Ambiguity** determines thinking depth (new signal — to be added)
- These are independent: high-risk doesn't imply high-ambiguity, and vice versa

Current Vinyan conflates them into a single routing level. The Extensible Thinking design separates them.

---

## 8. Rejected Ideas (with reasons)

| Idea | Rejected by | Reason |
|------|------------|--------|
| Worker suggests thinking depth | All 4 teams | Violates A6; creates governance capture |
| Metacognitive real-time monitoring | Epistemicist + Economist | A3/A6 violation; 50% overhead; uncertain ROI |
| Thinking adapts verification depth | Epistemicist | Generator controlling governance = capture |
| Unlimited/unbounded thinking | Economist | 9.5x cost multiplier; unsustainable |
| Per-oracle thinking tuning | Pragmatist | Couples LLM thinking to oracle selection unnecessarily |
| Thinking confidence → oracle confidence | Epistemicist | Self-report ≠ measurement; A1 violation |
| Ad-hoc operator override rules | Epistemicist | Pattern matching creates shadow governance |
| Debate mode at current phase | Pragmatist + Economist | Only 1 engine type exists; deeply negative ROI |

---

## 9. Open Questions for Future Debate

1. **How to compute ambiguity?** Plan complexity × uncertainty markers in goal description? Prior trace count for task type? Needs concrete formula.

2. **What happens when thinking modes interact with ECP confidence architecture?** ThinkingPolicy must align with subjective logic / EHD confidence framework if adopted.

3. **Multi-hypothesis with non-LLM engines:** If symbolic solvers produce structurally different solutions from LLMs, multi-hypothesis becomes more valuable (diverse generators). When is the engine ecosystem ready?

4. **Thinking budget vs. API pricing evolution:** If Anthropic/OpenAI change thinking token pricing (e.g., thinking tokens become cheaper), the economic gates shift. Should `ThinkingPolicy` include a cost-model abstraction?

5. **Human-in-the-loop override:** Should users be able to force a thinking mode (e.g., "use multi-hypothesis for this task")? Pragmatist says yes (user knows context); Epistemicist says only if it doesn't bypass oracle gate.
