---
name: planning-contract
description: Standardize a plan — objective, assumptions, affected surfaces, steps, verification, rollback, open questions. Use when producing a plan, design proposal, or implementation outline.
---

# Planning Contract

A useful plan is a contract: it states what will be true when the plan succeeds, what is assumed to make it work, and what would invalidate it.

## When to use

- About to begin non-trivial implementation, design, or coordination work.
- Producing a proposal, design note, or pre-implementation outline for a reviewer.
- The change touches more than one surface and a coherent overview reduces re-work.

## Procedure

1. **State the objective in one sentence.** What is true at success.
2. **Name the assumptions.** Things you believe but have not verified. The verifier should be able to challenge each one.
3. **List the affected surfaces.** Files, modules, services, schemas, contracts. Anything outside this list is out-of-scope; flag scope creep loudly.
4. **Lay out the steps.** Ordered, each with an expected output and a checkable success condition.
5. **Define verification.** How will you know the plan worked — and which evidence will prove it.
6. **Note rollback or recovery.** If a step fails mid-way, what does recovery look like.
7. **Surface open questions.** What is unresolved — flag now, not at execution time.

## Output

A plan note in this exact shape: *objective · assumptions · affected surfaces · steps · verification · rollback · open questions*. Skip empty sections rather than invent content.

## Anti-patterns to avoid

- Plans that read like prose with no checkable steps.
- Hiding assumptions in the body where the verifier cannot find them.
- Treating "open questions" as optional — unresolved questions become rework.
