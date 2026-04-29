---
name: debug-trace
description: Walk through a stack trace or error log to find the root cause. Use when the goal mentions debugging, investigating an error, or tracking down a bug.
---

# Debug Trace

Don't guess at the fix. Reproduce the failure, locate the actual cause, then fix that — not the symptom.

## When to use

- A stack trace, error message, or test failure is in the task.
- The user asks to debug, investigate, or "figure out why" something happens.
- A test is intermittently failing and you need to find the underlying race / ordering / state assumption.

## Procedure

1. **Reproduce first.** Don't reason about a bug you haven't reproduced. If reproduction is non-trivial, isolate it into the smallest possible test case before doing anything else.
2. **Read the trace bottom-up.** The deepest frame is usually where the failure surfaced; the cause is usually 2–5 frames up. Identify the function whose contract was violated.
3. **Check inputs at the failing frame.** What were the arguments? Where did they come from? Are they what the function expects? Many bugs are upstream — bad data passed into otherwise-correct code.
4. **State your hypothesis explicitly.** "I think X is happening because Y." Then design a check that would prove or refute it. If you can't design the check, your hypothesis is too vague.
5. **Verify the fix locally.** Before reporting "fixed", re-run the reproduction. If the test still fails, your hypothesis was wrong — go back to step 3.

## Anti-patterns to avoid

- **"Let me try this and see"** — burning steps changing things at random instead of forming hypotheses.
- **Suppressing the error** — `try/catch` around the failure, returning a default. The bug is still there, just silent.
- **Fixing the test, not the code** — adjusting an assertion to match buggy behavior is regressing.
- **Stopping at the first plausible cause** — root-cause analysis means finding the EARLIEST point at which behavior diverges from expected.
