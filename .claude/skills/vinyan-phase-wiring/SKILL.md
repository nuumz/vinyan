---
name: vinyan-phase-wiring
description: Wire a phase, escalation rule, or component into Vinyan's core loop. Trigger when modifying the core loop, factory wiring, EventBus subscriptions, escalation/routing logic, or shadow-job ordering. Use BEFORE adding a hook or changing the phase order — generic pipeline-wiring intuition is not enough here.
---

## When to use

You are about to:

- Add a new phase or sub-step to the core loop.
- Change escalation behavior between risk levels.
- Subscribe to or publish on the EventBus from a new module.
- Change the order of side effects around shadow execution or task results.
- Move wiring from one factory point to another.

## Read first

- `src/orchestrator/core-loop.ts` and `src/orchestrator/factory.ts` (or whatever files own the loop and DI today — verify by reading).
- The existing escalation paths to see how the loop label is applied.
- The EventBus implementation to confirm its FIFO and synchrony guarantees.

## Invariants (do not break)

- **Escalation is single-step.** A failed verification escalates one level; double-escalation in the same loop iteration is a bug. The escalation hop is labeled (look for the `routingLoop:` convention) so it can be detected — preserve the label.
- **Terminal failure on contradiction.** When the deepest verification reaches a contradiction, the task stops. Do not add a retry; do not silently re-route.
- **EventBus is FIFO and synchronous.** Subscribers run in order. Do not introduce async fan-out unless you also reason about ordering — and then document it.
- **Crash safety: shadow work is persisted BEFORE the online task result returns.** The reverse order leaks shadow work on crash. If you are touching shadow execution, this ordering is load-bearing.
- **Workers propose; orchestrator disposes (A6).** A worker emitting a result does not commit it. The commit decision is rule-based (A3) and lives in the orchestrator/gate.

## Wiring checklist

When adding a component to the loop:

1. Inject it via the factory; do not import it inside `core-loop.ts`.
2. Make its inputs explicit. No reaching into shared globals.
3. Decide whether it produces an EventBus event *or* returns a value — not both for the same fact.
4. If it can fail, decide where the failure escalates *before* wiring it.
5. Add a runtime trace assertion to a smoke or integration test — see the `vinyan-wiring-verification` skill.

## Anti-patterns this skill catches

- Calling `core-loop` logic from a worker.
- Two phases that both write to the same World-Graph fact in one iteration.
- An escalation that re-enters the same phase without the loop label.
- A new EventBus subscriber that does async work without preserving order.
- Persisting the online task result before the shadow record (crash leaks).

## What this skill does NOT do

- Tell you the current phase order or factory call graph — these change; read the code.
- Decide whether a new feature is a phase, an oracle, or a worker — that is an axiom-level discussion. See the `vinyan-axioms` skill.
