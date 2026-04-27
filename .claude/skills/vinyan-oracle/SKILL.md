---
name: vinyan-oracle
description: Author or modify a Reasoning Engine (Oracle) under src/oracle/. Trigger when adding a new oracle, changing an existing oracle's verdict shape, altering oracle subprocess I/O, or changing oracle registration/capability metadata. Use BEFORE writing the oracle's entry point, not after.
---

## When to use

You are about to:

- Create a new oracle under `src/oracle/<engine>/`.
- Modify an existing oracle's stdin/stdout handling.
- Change how an oracle is registered or selected by capability.
- Add or change a circuit breaker, timeout, or fallback.

## Read first

- The oracle interface and registry (browse `src/oracle/` index and nearby types).
- An existing minimal oracle (for example AST or lint) as a structural reference. Copy its skeleton, not its name or thresholds.
- The conformance suite under `tests/ecp-conformance/` plus any oracle-specific tests under `tests/oracle/`.

Do not assume current file names, schemas, or thresholds — verify by reading.

## Contract (stable across redesigns)

An oracle is a process that:

1. Receives a hypothesis (JSON) on stdin.
2. Emits exactly one verdict (JSON) on stdout, then exits cleanly.
3. Runs without execution privileges over the user's code or filesystem outside its declared inputs.
4. Treats undecidable cases as the protocol's unknown state, not a forced verdict.
5. Declares its capabilities at registration time so the orchestrator can route by capability, not by name.

These five properties are the contract — they do not change when the registry, schemas, or specific oracles evolve.

## Required around every oracle

- **Zod parse on stdin, Zod serialize on stdout.** No raw `JSON.parse` without a schema.
- **Circuit breaker.** Repeated failures must open the breaker — do not retry forever. Reuse the shared infrastructure rather than re-implementing it.
- **Timeout.** Every oracle has an upper bound; the orchestrator may kill it. Do not assume infinite runtime.
- **No state across invocations** unless the oracle explicitly declares persistent state. Default is stateless.

## Subprocess vs in-process

- **L1 / L2 isolation paths are LLM-only** today. A non-LLM RE that needs subprocess isolation is a design conversation, not a code change — escalate.
- A non-LLM oracle dispatched in-process should still log a warning per the existing convention. Verify the convention by reading the dispatcher before adding anything.

## Tests required in same PR

- A conformance test using the shared harness (not a hand-rolled mock).
- A behavior test that calls the oracle with a real input and asserts on the verdict. `toHaveProperty` alone is forbidden by repo policy.
- If the oracle has a failure mode, a test that triggers it and asserts circuit-breaker behavior.

## Anti-patterns this skill catches

- An oracle that calls another oracle directly (cross-oracle coupling). Route through the orchestrator instead.
- An oracle that reads or writes outside its declared inputs.
- An oracle that emits a verdict and *also* keeps writing to stdout (breaks the JSON-line contract).
- A "default" verdict when the oracle cannot decide. Emit the unknown state instead.
- A new oracle not registered with capability metadata.

## What this skill does NOT do

- Tell you the current oracle list, registration API, or breaker thresholds.
- Decide whether a problem warrants a new oracle vs reusing an existing one — that is an axiom-level discussion (who verifies whom). See the `vinyan-axioms` skill.
