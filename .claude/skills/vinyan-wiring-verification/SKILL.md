---
name: vinyan-wiring-verification
description: Verify a component is actually wired into the runtime, not just present in the codebase. Trigger when about to mark a feature ✅ Active, claim wiring is done, update phase status in CLAUDE.md, or close a wiring PR. Use BEFORE declaring any of those done.
---

## When to use

You wrote or refactored a component and are about to:

- Update CLAUDE.md "Phase Status" to ✅ Active.
- Tell the user "the feature is wired".
- Open a PR titled "wire X into Y".
- Close a "should be active in default run" task.

## The gate (stable principle)

A feature is **✅ Active** only when:

1. Its function appears in a runtime trace produced by the default entry point (whatever `vinyan run` resolves to today) **without extra config**.
2. A test asserts the trace contains the call — not just that the function returns the right value.
3. The wiring path from default entry → factory → component is reachable without setting any optional flag.

Code + unit tests + green CI is **not enough**. A method can be tested in isolation, exported, and never called by the real loop. That is a recurring failure mode in this repo.

## Verification protocol

1. Run a default invocation (smoke or integration test) and inspect the trace or log.
2. `grep` the trace for the component's identifier — it must be present.
3. If a feature flag gates the path, confirm the gate condition is the default. If it is not, the feature is not Active by definition.
4. Add or extend a test that fails when the trace does not include the component.

## Distinction from behavior tests

Behavior tests verify that **calling** a function produces the right output. Wiring verification asks **whether the real loop calls the function in the first place**. Both are required — neither replaces the other.

## Anti-patterns this skill catches

- "It is exported and tested, so it is done."
- Marking ✅ Active because the unit test passes.
- A feature reachable only when an optional flag is enabled, claimed as default.
- A new oracle registered but not reached by the gate's risk router.
- A new phase wired in the factory but never reached because the routing condition is unreachable.

## What this skill does NOT do

- Tell you which entry point or smoke test exists today — read the code.
- Replace reading the PR diff to confirm the wiring is the version that landed.
