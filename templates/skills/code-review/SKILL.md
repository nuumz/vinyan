---
name: code-review
description: Review code changes for correctness, error handling, scope creep, and style. Use when the goal mentions reviewing a PR, diff, or file.
---

# Code Review

Approach a review like a senior engineer who has to live with the consequences of merging this code.

## When to use

- The user asks to review, audit, critique, or sanity-check a code change.
- A PR description, diff, or file path is in the task.
- The user wants to know whether a patch is safe to merge.

## Procedure

1. **Read the diff end-to-end before commenting.** Skim the full change first — don't react to line 1 before understanding line 200. Form a mental model of what the change is trying to do.
2. **Match against the stated intent.** Does the diff actually accomplish what the PR says? Note unrelated edits as separate items, not approval blockers.
3. **Walk error and edge paths.** Null/undefined, empty arrays, off-by-one, timeout, partial failure, concurrent access. Identify the worst-case input and ask: does the code handle it cleanly?
4. **Check scope.** Refactor mixed with feature work? Stylistic noise? Drive-by renames? Call out scope creep — bug fixes don't need surrounding cleanup.
5. **Verify tests follow the change.** New behavior → new test. Bug fix → regression test that fails without the fix. Test quality matters: a passing assertion that doesn't actually test the change is worse than no test.
6. **Look for the failing invariant.** When something feels wrong, name what specifically would break. "This is wrong" is unhelpful; "this overwrites the cache during concurrent writes" is actionable.

## Output

- Group findings by severity: **must-fix** → **should-fix** → **nit**.
- For each finding, cite `file:line` and name the failing invariant.
- End with an explicit verdict: ready to merge / needs changes / needs discussion.
- Don't quote the diff back to the author — they wrote it.
