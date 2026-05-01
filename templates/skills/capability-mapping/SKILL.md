---
name: capability-mapping
description: Map required capabilities to persona roles and available skills. Detect missing skill coverage and decide whether to acquire a skill, request one, or proceed generically. Use when scoping a workflow.
---

# Capability Mapping

Before dispatching, check whether the persona actually has the capability the step needs. A persona without the right skill will improvise — and improvisation is the most common source of low-trust work.

## When to use

- Scoping a workflow that touches an unfamiliar domain, framework, or convention.
- Deciding between proceeding with a generic persona, acquiring a skill, or asking the user for one.
- Auditing whether the planned chain has all the capabilities the goal requires.

## Procedure

1. **List required capabilities.** What does each step need to know or do — in capability terms, not topic terms.
2. **Map to personas and skills.** Which persona claims each capability? Which skills currently support it? What is the evidence — built-in, demonstrated, or inferred?
3. **Detect gaps.** A capability with no claimant is a gap; a claimant with weak evidence is a soft gap.
4. **Choose a coverage move per gap:** acquire a matching skill, request a custom skill from the user, narrow the goal, or proceed generically with a flagged assumption.
5. **Record the assumption.** When proceeding generically, name what is assumed so the verifier can check it later.

## Output

A short table or list: *capability · persona · supporting skill · evidence · gap? · coverage move*.

## Anti-patterns to avoid

- Assuming a persona "should be able to" handle something based on the topic.
- Acquiring skills speculatively when the goal does not need them.
- Hiding gaps under confident prose. A gap names itself when made explicit.
