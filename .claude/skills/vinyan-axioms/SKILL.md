---
name: vinyan-axioms
description: Apply Vinyan's 7 Core Axioms (A1–A7) when facing a design decision or architectural conflict in this repo. Trigger when the work involves epistemic separation (generation vs verification), governance routing, evidence/uncertainty handling, or any cross-cutting change to orchestrator/gate/oracle. Use BEFORE proposing a design that touches these layers — not as a post-hoc checklist.
---

## When to use

For **resolving design tension**, not for writing code. Reach for it when:

- A design choice has multiple plausible options and you need a tie-breaker.
- A reviewer (or you) is unsure whether a proposed component belongs in `orchestrator/`, `gate/`, or a worker.
- Tests or wiring force you to consider whether an LLM is being asked to verify itself.
- You are tempted to put an LLM call inside a routing / commit / governance decision.
- You are tempted to return a default value or empty string when a component cannot decide.

## Read first (do not rely on cached memory)

The authoritative axiom list lives in `CLAUDE.md` ("7 Core Axioms") and `docs/foundation/concept.md`. Re-read whichever is current before applying — wording or numbering may have evolved.

The axioms are **non-negotiable**. They override convenience, performance, and DRY.

## Resolution protocol

1. **Name the conflict.** One sentence: "Option A vs Option B because X."
2. **Map to axioms.** Which axiom(s) does each option uphold or violate?
3. **Pick the option that violates fewer axioms.** Never pick one that violates separation (A1), governance (A3), or zero-trust (A6) — these are the load-bearing trio.
4. **If both options violate an axiom**, the design is wrong — redesign before coding.
5. **Document the tradeoff** in the PR description, not in code comments.

## Common anti-patterns this skill catches

- "Let the LLM pick the route to save a hop." → governance violation; routing must be rule-based.
- "The generator can self-grade with its own confidence score." → separation violation; verifier must be a separate component.
- "Fall back to a default string when the oracle cannot decide." → uncertainty violation; emit the protocol's `unknown` state instead.
- "The worker writes the file directly to skip the dispose step." → zero-trust violation; workers propose, orchestrator disposes.
- "Cache the fact by task ID." → content-addressing violation; bind to content hash.
- "Score success/failure only." → prediction-error violation; learning is delta(predicted, actual).

## What this skill does NOT do

- Decide *which file* a component goes in.
- Tell you current threshold values, function names, or DI graph.
- Replace reading the actual code in the relevant directory before changing it.

When the axiom analysis says "this design is wrong", stop coding and discuss with the user.
