---
name: governance-guardrails
description: Stay aligned with Vinyan governance — generator/verifier separation, no self-evaluation, deterministic routing, content-addressed evidence, trust gates. Use when designing routing, verification, or commits.
---

# Governance Guardrails

The orchestrator's reliability comes from rules that hold even when the model is wrong. When designing a workflow, the rules are not optional; they are the load-bearing part.

## When to use

- Designing a routing decision, verification step, or commit gate.
- Reviewing a workflow proposal for governance compliance.
- About to introduce a path where a generator could see, mutate, or evaluate verifier output.

## Procedure

1. **Hold Epistemic Separation.** The generator never verifies its own output. The verifier never generates the artifact it is verifying. Two engines, two roles, no overlap.
2. **Keep routing deterministic.** Routing, gating, and commit decisions are made by rules, not by an LLM in the governance path. If a rule is missing, write the rule — do not delegate to a model.
3. **Prefer content-addressed evidence.** Facts bind to the hash of the artifact, not its name or path. Renames invalidate; identity does not.
4. **Use tiered trust.** Deterministic > heuristic > probabilistic. State which tier each piece of evidence is and reason accordingly.
5. **Refuse zero-trust shortcuts.** Workers propose; orchestrator disposes. A worker's confidence claim does not unlock execution privileges.
6. **Treat unknown as a state, not a failure.** "I do not know" is a valid protocol state and beats a confident fabrication.

## Output

When you find a guardrail violation, name it explicitly: *which axiom · how it is violated · the deterministic alternative*. Do not silently fix; surface and propose.

## Anti-patterns to avoid

- Letting the generator persona "review" its own output as a convenience.
- Replacing a missing rule with an LLM call in the governance path.
- Inferring a fact and treating it as deterministic; tier it correctly.
