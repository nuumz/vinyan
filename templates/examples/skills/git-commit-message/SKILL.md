---
name: git-commit-message
description: Write a Conventional Commits message describing a code change. Use when the goal mentions creating a commit, writing commit message, or committing changes.
---

# Git Commit Message

Write commit messages that explain *why*, not what. The diff already shows what.

## When to use

- The user asks to commit, write a commit message, or summarize a change for git.
- You're about to call `git commit` and need to draft the `-m` text.
- Reviewing a PR description and the commits underneath it look weak.

## Format

```
type(scope): short imperative summary (≤72 chars)

(optional body — wrap at 72 chars)
- Why this change is needed
- Constraints or trade-offs the reader should know about
- Anything surprising in the implementation

Refs: #123
```

### Type vocabulary (Conventional Commits)

- `feat` — new user-facing capability
- `fix` — bug fix; pair with a regression test
- `refactor` — internal restructure, no behavior change
- `docs` — comments / README / docs only
- `test` — tests only
- `chore` — tooling, deps, CI
- `perf` — performance change with measurable impact

## Procedure

1. **Look at the actual diff** before writing. `git diff --staged`. Don't write from memory.
2. **One commit = one logical change.** If the message wants "and" or bullet points listing unrelated things, the commits should be split.
3. **Imperative present.** "fix null deref in parser" not "fixed" or "fixes". Reads like a directive: "if applied, this commit will…"
4. **Subject ≤72 chars.** GitHub truncates at 72 in some views. If you need more, use the body.
5. **Why-first body.** Reviewers know what changed (the diff). They don't know why you chose this approach over alternatives — explain that.

## Examples

```
fix(workflow): reset retry counter when step succeeds

Counter was sticky — a retried step that finally succeeded still
counted toward the `maxAttempts` budget for siblings. Reset on
success so failure quotas are per-step, not per-workflow.
```

```
refactor(skill-cards): extract envelope renderer

No behavior change. Pulls the `<skill-card hash="...">` rendering
out of the prompt-section so future card sources (autonomous,
imported) can reuse the same envelope.
```
