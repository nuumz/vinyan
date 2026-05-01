---
name: evidence-gathering
description: Gather enough context before acting — read code, docs, specs, prior decisions; identify the source of truth; refuse to speculate. Use when investigating, researching, or before any non-trivial change.
---

# Evidence Gathering

Speculation is cheap and often confidently wrong. Evidence is slower but the only thing that survives a verifier.

## When to use

- Before making a non-trivial change, claim, or recommendation.
- When a fact is needed and the answer might depend on something local you have not yet read.
- When prior context, decisions, or design notes likely exist and would change the answer.

## Procedure

1. **Identify the source of truth.** Code, spec, design doc, ticket, prior commit, prior conversation? Different facts have different authorities; pick the right one.
2. **Read before reasoning.** Do not summarize from memory or training data when the local artifact is reachable. Read the file.
3. **Scope the gather.** Read enough to answer the question; stop when further reading would not change the answer. Evidence has diminishing returns.
4. **Flag what is missing.** If the source of truth is unreachable, name that explicitly — do not paper over with a plausible guess.
5. **Cite specifically.** Quote the line, name the file, link the decision. Vague references decay; specific ones do not.

## Output

A findings list: *claim · evidence (file:line / spec § / quote) · confidence*. No load-bearing claim without a citation.

## Anti-patterns to avoid

- "Probably the code does X" when one read of the file would settle it.
- Reading three more files when one would do — diminishing returns matter.
- Citing the existence of a doc without quoting the relevant passage.
