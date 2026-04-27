---
name: vinyan-ecp
description: Conform to the Epistemic Communication Protocol (ECP) when authoring or modifying any code that emits or consumes ECP messages between Reasoning Engines, oracles, phases, or the orchestrator. Trigger when the work involves hypothesis tuples, oracle verdicts, evidence chains, fact records, confidence values, or "unknown" states. Use BEFORE adding or changing fields in any ECP-shaped payload.
---

## When to use

You are touching code that produces or consumes:

- A hypothesis or verdict crossing the orchestrator ↔ oracle ↔ RE boundary.
- Any of `confidence`, `evidence_chain`, `falsifiable_by`, `temporal_context`, or the protocol's `unknown` state.
- A fact bound to a file or content hash.

ECP is the **internal** protocol. MCP is for external tool access only — do not conflate them. Code paths that internally call `mcp__*` to talk between Vinyan components are wrong by construction.

## Read first

Before changing any ECP shape:

1. Open the canonical ECP definition (search under `src/core/` for the type module and `docs/foundation/concept.md`).
2. Check the conformance suite under `tests/ecp-conformance/` — it encodes the contract.
3. If a field exists, treat its semantics as load-bearing; do not repurpose.

Field lists, transport mechanics, and schema files all evolve — verify by reading, never paste from memory.

## Invariants (stable across design changes)

- **Uncertainty is first-class.** When an engine cannot decide, it emits the protocol's explicit unknown state. Never substitute a low-confidence guess, an empty string, or `null` to mean "I do not know".
- **Confidence is calibrated, not vibes.** A confidence value must be derivable from evidence. If you cannot explain how it was computed, do not emit it.
- **Evidence is tiered.** Deterministic outranks heuristic outranks probabilistic. Adding evidence to an existing chain must not reorder or drop tiers.
- **Content addressing.** Facts bound to a file reference its content hash, not a path or task ID. Renames and edits must invalidate the fact.
- **No LLM in the governance path (A3).** ECP messages consumed by routing / verification / commit logic are interpreted by deterministic rules. Prompting an LLM with an ECP message to "decide" is an architectural violation — see the `vinyan-axioms` skill.

## When extending the protocol

- Add fields as **optional** until every producer emits them and every consumer handles them.
- Update the Zod schema at the boundary. Do not bypass it because "it is internal".
- Add or update a conformance test in the same PR.
- Update `docs/foundation/concept.md` if the semantics (not just the shape) change.

## Anti-patterns this skill catches

- A new field whose meaning is "whatever the producer wants".
- A consumer that silently ignores the unknown state and proceeds with a default.
- A confidence value hardcoded to 0.5 or 1.0 because the producer did not compute one.
- A "context" field used as a dumping ground for free-form strings.
- An ECP message shipped over MCP transport, or vice versa.

## What this skill does NOT do

- Tell you the current field list — read the code.
- Pick the transport (stdin/stdout, in-process, or otherwise) — that is the RE adapter's concern.
