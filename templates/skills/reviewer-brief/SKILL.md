---
name: reviewer-brief
description: Frame review output by severity, name the violated invariant, cite evidence, list missing tests, and state residual risk. Use when reviewing, auditing, critiquing, or producing a verdict.
---

# Reviewer Brief

A review is most useful when it is structured. Severity, evidence, and an explicit verdict are the three things a generator needs to act on a review without re-reading it.

## When to use

- Producing a review, audit, critique, or sanity-check verdict.
- Asked to evaluate work against a stated contract.
- Reading a generator's output and deciding what to do with it.

## Procedure

1. **Read the work end-to-end before commenting.** Form a model of what the change is trying to do; do not respond to the first line before understanding the last.
2. **Compare to the stated contract.** Does the work do what it said it would? Note unrelated edits as separate items, not blockers.
3. **Group findings by severity.** *Must-fix* (blocking), *should-fix* (defect, non-blocking), *nit* (taste). Sort within each group by impact.
4. **Name the violated invariant.** "This is wrong" is unhelpful. "This re-enters the cache during concurrent writes" is actionable.
5. **Cite evidence.** *file:line* or quoted passage. The author should not have to guess what you meant.
6. **List missing tests.** New behavior without a test, bug fix without a regression test — call it out by name.
7. **State residual risk.** What might still break that this review did not check.
8. **End with a verdict.** Ready / changes requested / discussion needed. No verdict is the worst review.

## Output

Findings by severity, each with *invariant · evidence · suggested action*. Final verdict line. Do not quote the work back to the author.

## Anti-patterns to avoid

- Mixing taste, defects, and blockers in one undifferentiated list.
- Modifying the work yourself — Verifier-class personas describe what should change; the Generator does the change.
- Verdict-less reviews; the author cannot ship without one.
