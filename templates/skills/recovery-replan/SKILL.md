---
name: recovery-replan
description: Recover from failed tool calls, bad routing, missing context, or failed verification. Diagnose, avoid retry loops, choose an alternate path, escalate only when truly blocked. Use when something failed.
---

# Recovery & Replan

When something fails, the temptation is to retry harder. Most retries fail the same way. Recovery starts with diagnosis, not repetition.

## When to use

- A tool call returned an error, an unexpected shape, or nothing at all.
- A routing decision sent the work to the wrong persona or surface.
- A verification failed and the next move is unclear.
- A loop is forming — the same step has failed more than once.

## Procedure

1. **Stop and diagnose.** What exactly happened? Read the error verbatim; do not paraphrase. Name the failing component.
2. **Classify the failure.** Transient (network, timeout, race), structural (wrong tool, wrong input), epistemic (missing context, wrong assumption), or governance (policy block).
3. **Pick the recovery move per class.** Transient → retry once with backoff. Structural → switch tool, fix input, or change persona. Epistemic → gather missing evidence first. Governance → respect the block; do not bypass.
4. **Refuse retry loops.** Two same-shape failures means the strategy is wrong, not the attempt. Replan rather than retry a third time.
5. **Escalate only when truly blocked.** Ask the user when (a) you cannot diagnose, (b) the recovery requires their input, or (c) every alternate path has been ruled out. State exactly what you tried.

## Output

A short recovery note: *what failed · class · move taken · result · escalation if any*. So the next run can learn from it.

## Anti-patterns to avoid

- Retrying the exact same call after a non-transient failure.
- Burying the failure under a fallback that silently succeeds — the bug is still there.
- Asking the user before doing the diagnosis they would otherwise have to redo.
