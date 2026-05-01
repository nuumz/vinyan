---
name: workflow-intake
description: Classify a request before acting — intent, expected artifact, ambiguity, risk, persona class. Use when starting any new request and deciding whether to clarify, route, answer directly, or run a workflow.
---

# Workflow Intake

The first move on any request is not to act — it is to classify. A wrong classification ten seconds in is cheaper than a wrong implementation ten minutes in.

## When to use

- A new task or message arrives and you have not yet decided what to do with it.
- The request is ambiguous, broad, or compound and a single direct action would over-commit.
- You are choosing between answering, clarifying, routing, or running a workflow.

## Procedure

1. **Name the intent.** What does the user actually want — an answer, an artifact, a decision, a hand-off, or a clarification? State it in one short sentence.
2. **Identify the expected artifact.** Words, plan, review, report, schedule entry, nothing? The artifact shape constrains every later move.
3. **Score ambiguity.** Are key parameters missing — target, scope, deadline, format? If yes, surfacing them now beats guessing.
4. **Score risk.** Reversible or destructive? Local or shared? Touches data, infra, money, or other people? Higher risk → stricter verification later.
5. **Pick the persona class.** Generator, Verifier, Coordinator, Guide, Logistics. Map the intent to the cognitive role best suited to it.

## Output

A 4–6 line intake note: *intent · artifact · ambiguity · risk · persona class · next move (clarify / route / answer / workflow)*. Then act on the next move.

## Anti-patterns to avoid

- Diving straight into execution when the intent is unclear.
- Treating ambiguity as risk-free and "deciding for the user" without naming the assumption.
- Asking five clarifying questions when one would do — ask the one that most reduces uncertainty.
