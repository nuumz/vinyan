# Autonomous Orchestrator v1 — Design Doc

## Overview

6-wave upgrade transforming Vinyan from a single-pass pipeline into a goal-driven autonomous agent orchestrator. All waves gated behind config flags (W1/W2/W4/W5a default OFF; W3/W5b/W6 default ON/additive). When flags are off, `vinyan run` behavior is byte-identical to pre-upgrade.

## Architecture: Feedback Loops

```
User goal
    │
    ▼
┌─────────────────────────────────────────────────────────┐
│ Wave 1: Goal-Satisfaction Outer Loop                     │
│                                                          │
│  for iter in 1..maxOuterIterations:                      │
│    ┌──────────────────────────────────────────────┐      │
│    │ executeTaskCore (original 6-phase pipeline)   │      │
│    │   ┌─ Perceive → Predict → Plan → Generate ─┐│      │
│    │   │  W5b: skill hints injected here          ││      │
│    │   │  W4: goal-check after agent done turn    ││      │
│    │   └─ Verify → Learn ────────────────────────┘│      │
│    └──────────────────────────────────────────────┘      │
│                    │                                      │
│              TaskResult                                   │
│                    │                                      │
│    ┌──────────────────────────────────────────────┐      │
│    │ Wave 1: Goal Evaluator (deterministic C1-C5)  │      │
│    │   score >= threshold? → return completed       │      │
│    │   score < threshold?  → Wave 2 below           │      │
│    └──────────────────────────────────────────────┘      │
│                    │                                      │
│    ┌──────────────────────────────────────────────┐      │
│    │ Wave 2: Replan Engine                          │      │
│    │   4 rule-based gates:                          │      │
│    │     1. maxReplans                              │      │
│    │     2. budget cap (20% of remaining)           │      │
│    │     3. plan-signature novelty (SHA-256)        │      │
│    │     4. trigram similarity < 0.85               │      │
│    │   Pass → rewrite goal, next iteration          │      │
│    │   Fail → honest escalation (A7)                │      │
│    └──────────────────────────────────────────────┘      │
└─────────────────────────────────────────────────────────┘
                    │
             ┌──────┴──────┐
             │ task:complete│  (bus event)
             └──────┬──────┘
                    │
    ┌───────────────────────────────────┐
    │ Wave 5a: Failure Cluster Detector  │
    │   ≥2 same-sig failures in 1h      │
    │   → synthesizeReactiveRule         │
    │   → RuleStore.insert (probation)   │
    │   → applied on next task routing   │
    └───────────────────────────────────┘
```

## Wave Summary

| Wave | Module | Config Key | Default | Core Change |
|------|--------|-----------|---------|-------------|
| W1 | `goal-satisfaction/goal-evaluator.ts` | `orchestrator.goalLoop.enabled` | OFF | Deterministic goal evaluator (C1-C5) wrapping existing goal-alignment-verifier |
| W1 | `goal-satisfaction/outer-loop.ts` | (same) | OFF | Rule-based outer iterator with budget guard, WorkingMemory carry-over |
| W2 | `replan/replan-engine.ts` | `orchestrator.replan.enabled` | OFF | 4-gate replan engine; rewrites goal with REPLAN directive for phase-plan |
| W2 | `replan/replan-prompt.ts` | (same) | OFF | Prompt builder with "STRUCTURALLY DIFFERENT" directive |
| W3 | `agent-memory/agent-memory-api.ts` | `orchestrator.agent_memory.enabled` | ON | Unified read-only query over 6 stores + per-task LRU cache |
| W3 | `db/skill-store.ts` (findSimilar) | (same) | ON | Bigram Jaccard similarity for skill matching |
| W4 | `worker/completion-gate.ts` | `orchestrator.agentLoopGoalTermination.enabled` | OFF | Pure rule-based accept/continue/reject decision |
| W4 | `worker/continuation-prompt.ts` | (same) | OFF | Targeted continuation prompt builder |
| W4 | agent-loop goal-check hook | (same) | OFF | Observability: emits `agent-loop:goal-check` event after subprocess done |
| W5 | `goal-satisfaction/failure-cluster-detector.ts` | `orchestrator.reactiveLearning.enabled` | OFF | Rolling-window failure cluster detection |
| W5 | `sleep-cycle/reactive-cycle.ts` | (same) | OFF | Synthesize probational rules from failure clusters |
| W5a | factory.ts wiring | (same) | OFF | task:complete → detector → rule persistence end-to-end |
| W5b | agent-loop skill hints | `orchestrator.skillHints.enabled` | ON | Inject top-k similar skills into worker init turn constraints |
| W6 | `workflows/workflow-registry.ts` | `orchestrator.workflowRegistry.enabled` | ON | Metadata registry for strategy validation; unknown → fallback |

## Axiom Mapping

| Axiom | Enforcement |
|-------|-------------|
| A1 Epistemic Separation | Goal evaluator, completion-gate, replan engine are all separate components from the generator. Agent memory is read-only from generation path. |
| A3 Deterministic Governance | All outer-loop decisions (iterate/stop), replan gates (4 criteria), completion-gate, failure-cluster detection, and registry lookup are pure functions of rule-based inputs. No LLM in any governance path. |
| A5 Tiered Trust | Reactive rules start at `status: 'probation'` — never 'active'. Goal evaluator capped at heuristic tier (0.7) via reuse of goal-alignment-verifier. |
| A6 Zero-Trust Execution | Agent memory tools are read-only (zero side effects). Worker skill hints are informational ("reference only, not mandates"). |
| A7 Prediction Error as Learning | Honest escalation on goal-not-met ("replan exhausted", "budget exhausted"). WorkingMemory carries failed approaches across iterations. Reactive learning generates rules from prediction errors (failure clusters). |

## Config Schema Reference

```jsonc
{
  "orchestrator": {
    // Wave 1: Goal-Satisfaction Outer Loop
    "goalLoop": {
      "enabled": false,               // OFF by default
      "maxOuterIterations": 3,         // max re-attempts before honest escalation
      "goalSatisfactionThreshold": 0.75 // C1-C5 score threshold
    },
    // Wave 2: Replan Engine (requires goalLoop)
    "replan": {
      "enabled": false,
      "maxReplans": 2,
      "tokenSpendCapFraction": 0.20,   // max 20% of remaining budget on replanning
      "trigramSimilarityMax": 0.85     // novelty gate
    },
    // Wave 3: Agent Memory API
    "agent_memory": {
      "enabled": true                  // ON — additive, read-only
    },
    // Wave 4: Agent-Loop Goal-Driven Termination
    "agentLoopGoalTermination": {
      "enabled": false,
      "maxContinuations": 2,
      "continuationBudgetFraction": 0.25
    },
    // Wave 5: Reactive Micro-Learning
    "reactiveLearning": {
      "enabled": false,
      "windowMs": 3600000,             // 1 hour rolling window
      "minFailures": 2
    },
    // Wave 5b: Skill Hints
    "skillHints": {
      "enabled": true,                 // ON — additive
      "topK": 3
    },
    // Wave 6: Workflow Registry
    "workflowRegistry": {
      "enabled": true                  // ON — metadata-only
    }
  }
}
```

## Enable All Waves

To enable the full autonomous orchestrator:

```jsonc
{
  "orchestrator": {
    "goalLoop": { "enabled": true },
    "replan": { "enabled": true },
    "agentLoopGoalTermination": { "enabled": true },
    "reactiveLearning": { "enabled": true }
  }
}
```

W3, W5b, and W6 are already ON by default.

## Test Coverage

- **86 new tests** across 19 test files (all pass)
- TSC: 0 errors
- Full unit suite regression preserved
- Benchmark gate: 5/5 pass (no performance regression in core loop)

## Known Limitations / Future Work

1. **W4 subprocess continuation**: no IPC frame for in-session continuation yet. `continue` collapses to `reject` at MVP. When subprocess protocol adds a `turn_request` frame, the completion-gate's 'continue' decision can drive another subprocess turn.

2. **W2 token tracking**: uses a flat 2000-token estimate per replan attempt. TaskDecomposer doesn't surface actual LLM token usage. A future interface change could return `{ dag, tokensUsed }`.

3. **W6 dispatch refactor**: the core-loop's strategy `if`-chain still exists. The registry validates strategies but doesn't dispatch. Extracting handlers into registry-dispatched modules is the remaining mechanical step.

4. **W3 queryHistoricalProfile shim**: uses a synthetic TaskInput to call profileHistory. A direct `(sig) → profile` API on TraceStore would be cleaner.

5. **W5a detector state**: in-memory only. Restarting Vinyan loses the observation window. Acceptable for 1-hour windows but could be persisted if needed.
