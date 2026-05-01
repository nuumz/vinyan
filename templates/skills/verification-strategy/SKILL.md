---
name: verification-strategy
description: Decide the verification tier — typecheck, lint, affected tests, full suite, manual check. Use when finishing a change, reviewing one, or planning what evidence will prove the work.
---

# Verification Strategy

Verification proportional to risk. Over-verifying small changes wastes time; under-verifying risky ones loses trust. The strategy is decided up front and matched at the end.

## When to use

- About to claim a change is "done" and asking what evidence proves it.
- Planning a workflow and deciding what verification each step will require.
- Reviewing someone else's work and deciding what to actually check.

## Procedure

1. **Anchor on behavior.** What user-observable property must hold? Verification proves the property — not the implementation.
2. **Pick the cheapest sufficient tier.** Typecheck and lint catch shape errors. Affected tests prove behavior. Full suites detect regressions in unrelated surfaces. Manual checks fill the gap when no automated check applies.
3. **Match tier to risk.** Local refactor → affected tests. Schema change → broader impact run. Shared-state change → run the full suite or the impact-equivalent.
4. **Refuse verification by inspection alone.** "It looks right" is not evidence. Behavior must be observed.
5. **Re-run on failure.** A flaky pass is not a pass. If verification was inconsistent, fix the verification before claiming success.

## Output

A short verification note: *tier · what it covers · what it does not cover · residual risk*. Attach to the artifact so a reviewer sees what was actually checked.

## Anti-patterns to avoid

- Asserting on shape-only properties (existence of a key) when behavior is the contract.
- Running the full suite for every change and pretending that proves anything specific.
- Skipping verification because "tests pass on my machine" — that is environmental, not behavioral.
