---
name: vinyan-a2a-mcp-boundary
description: Keep the boundary between internal protocol (ECP semantics, in-process / EventBus / A2A transport) and external protocol (MCP, for tool access to the outside world). Trigger when adding a new agent integration, building or consuming a tool surface, exposing a Vinyan capability, or reaching for any `mcp__*` client/server inside `src/`. Use BEFORE choosing a transport or naming a surface — the wrong choice is hard to unwind.
---

## When to use

You are about to:

- Add an MCP server, MCP client, or `mcp__*` call inside Vinyan source.
- Wire a new external tool into the orchestrator or a worker.
- Expose a Vinyan component to another agent or process.
- Choose between "MCP", "A2A", "EventBus", and "in-process" for a new boundary.
- Adapt an existing internal API to be reachable from outside Vinyan.

## The two-layer model (stable across redesigns)

Vinyan separates **semantics** from **transport**. Get this wrong and the system silently loses epistemic guarantees.

| Layer | Internal (Vinyan ↔ Vinyan) | External (Vinyan ↔ outside world) |
|---|---|---|
| **Semantics** | ECP — confidence, evidence chain, falsifiability, explicit `unknown` state | Whatever schema the external tool uses; treated as untrusted input |
| **Transport** | In-process call, EventBus, A2A (where applicable) | MCP (and only MCP) |

The principle that fixes the boundary:

- **MCP is for the outside world.** It is a tool-access boundary. Anything you reach via MCP is by definition not part of Vinyan and cannot be assumed to honor ECP.
- **ECP is for the inside.** Components that live in `src/` and exchange epistemic claims with each other speak ECP, regardless of how the bytes move.

A2A may be the transport for internal agent-to-agent traffic. Carrying ECP semantics over an A2A transport is fine. Carrying ECP semantics over MCP is not — see anti-patterns below.

## Decision protocol

When choosing where a new surface lives, answer in order:

1. **Is the counterparty inside Vinyan or outside?**
   - Inside → ECP semantics. Pick a transport (in-process, EventBus, A2A).
   - Outside → MCP transport. Define an external schema; do not assume ECP shape.
2. **Does the surface return epistemic claims (confidence, evidence, unknown)?**
   - Yes + outside → wrong design. External tools cannot be trusted to emit ECP. Wrap their output in an oracle/adapter that *converts* into ECP at the boundary.
3. **Are you tempted to call MCP from inside an oracle, the gate, or core-loop?**
   - That is the anti-pattern. Stop and redesign. The MCP call belongs at the edge, with an adapter that enforces the boundary.

## Adapter pattern at the boundary

When external data must enter Vinyan:

- The adapter parses external output with Zod.
- The adapter assigns confidence based on observable evidence, not on what the external tool claims.
- The adapter emits an ECP-shaped record (or `unknown` if the conversion fails).
- The adapter is the only place that knows about the external schema.

When Vinyan must expose a capability outside:

- Define an external schema; do not leak internal ECP types.
- Drop fields whose meaning is internal-only (raw evidence chain, internal trace ids).
- Treat callers as untrusted, even if they claim to be another Vinyan instance — verify they speak the documented external schema.

## Read first

Before adding any cross-boundary code:

- The MCP integration points under `src/mcp/` to see the existing adapter conventions.
- The A2A surface under `src/a2a/` to see how internal agent traffic is currently transported.
- The ECP type module under `src/core/` for the canonical internal shape.

Conventions and library names evolve — verify by reading; do not paste from memory.

## Anti-patterns this skill catches

- An oracle, gate component, or core-loop step that imports an `mcp__*` client to call another Vinyan component.
- An MCP server that exposes internal types (raw evidence chains, internal task ids) directly.
- An A2A handler that strips epistemic semantics on the way out, turning ECP into a flat success/failure flag.
- Treating an external MCP tool's response as ECP-conformant — for example trusting its confidence value, or letting `null` mean `unknown`.
- A "shortcut" surface that lets an external caller bypass the gate by going straight to an oracle or a worker.

## What this skill does NOT do

- Tell you the current MCP server list, A2A library, or schema fields — read the code.
- Decide whether a new capability *should* be exposed externally — that is a product/security call.
- Replace the `vinyan-axioms` and `vinyan-ecp` skills for the deeper "who is allowed to assert what" questions.
