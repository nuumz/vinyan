---
name: task-decomposition
description: Break complex work into ordered subgoals with explicit dependencies, expected outputs, and stopping conditions. Use when a task has multiple steps, unclear scope, or non-trivial coordination.
---

# Task Decomposition

A plan that is too coarse hides the failures; a plan that is too fine drowns them. Decompose to the level where each subgoal has a checkable output.

## When to use

- The task plainly has more than one step and the steps interact.
- A first pass produces "and then…" sentences — that is undeclared sequencing.
- Different subgoals belong to different personas, surfaces, or risk levels.

## Procedure

1. **Restate the goal as a single outcome.** If you cannot, the task is not yet a task.
2. **List the subgoals.** Each subgoal has an *expected output* and is independently checkable. If a subgoal cannot be checked, decompose further or merge.
3. **Mark dependencies.** Which subgoals must finish before others can start? Order them; flag the ones that can run in parallel.
4. **Define stopping conditions.** When does a subgoal succeed? When does the whole task succeed? Without this, work drifts.
5. **Cap the depth.** Three levels of nesting is usually plenty; if you need more, the goal is probably two goals.

## Output

A short tree or numbered list: *subgoal · expected output · dependencies · done-when*. No more depth than the work warrants.

## Anti-patterns to avoid

- Decomposing simple tasks into ceremonial step lists. If one step does the job, stop.
- Inventing subgoals to look thorough; every subgoal must produce a checkable artifact.
- Hiding sequencing in prose ("first… then… after that"). Make it a list with arrows.
