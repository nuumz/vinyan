# Vinyan Documentation

> **Last validated:** 2026-04-24 against branch `feature/main` HEAD = `4bd4d2a`.
> When a doc claim disagrees with the code, **the code wins** — open a PR to
> fix the doc.

## How to read this directory

Every doc has one of four roles. The role is a heading-1 banner at the top of
each file. If a doc has no banner, it has not been audited yet.

| Role | What it means | Example |
|------|--------------|---------|
| **As-Is** | Describes what the system does today. Safe to use as a reference. | [`spec/tdd.md`](spec/tdd.md), [`spec/ecp-spec.md`](spec/ecp-spec.md) |
| **To-Be** | Describes a planned or partially-implemented feature. **Not safe to assume working.** | [`design/extensible-thinking-system-design.md`](design/extensible-thinking-system-design.md) |
| **Research** | Background investigation that informed a decision. May contain ideas that were rejected. | most files in [`research/`](research/) |
| **Historical** | Superseded but kept for traceability. Lives in [`archive/`](archive/). | [`archive/identity-reframe-plan.md`](archive/identity-reframe-plan.md) |

**Mixed docs (As-Is + To-Be in one file)** carry a per-section status table —
see [`design/implementation-plan.md`](design/implementation-plan.md) §Phase 0–6.

---

## Reading order (new contributors)

1. [`foundation/concept.md`](foundation/concept.md) — Vision, the 7 axioms (A1–A7), ECP, Reasoning Engines.
2. [`foundation/theory.md`](foundation/theory.md) — Cognitive-architecture grounding (GWT, Active Inference, Predictive Processing).
3. [`architecture/decisions.md`](architecture/decisions.md) — Concrete D1–D19 decisions with rationale.
4. [`spec/tdd.md`](spec/tdd.md) — Live interface + schema contract (the implementation source of truth).
5. [`design/implementation-plan.md`](design/implementation-plan.md) — What's shipped vs what's still on the roadmap.

---

## Phase status (canonical)

The same legend is used in [`CLAUDE.md`](../CLAUDE.md) and in code:
**✅ Active** = wired in default `vinyan run` path · **🔧 Built** = code + tests
exist but needs config or data to activate · **📋 Designed** = interface
defined, partial / stub implementation.

| Phase | Scope | Status | Activation condition |
|-------|-------|--------|---------------------|
| 0 | Oracle Gate (verification library) | ✅ Active | Always |
| 1 | Autonomous Agent (Orchestrator + LLM + Tools) | ✅ Active | `ANTHROPIC_API_KEY` or `OPENROUTER_API_KEY` |
| 6 | Agentic Worker Protocol | ✅ Active | Default path |
| K1 | Kernel Hardening (guardrails, agent contracts, tool auth) | ✅ Active | Always |
| 2 | Evolution Engine (Sleep Cycle + skill cache + rule promotion) | 🔧 Built | DB + ≥100 traces |
| 3 | Self-Model (trace-calibrated prediction) | 🔧 Built | DB; uses stub otherwise |
| 4 | Fleet Governance (worker profiles, capability routing) | 🔧 Built | DB + multiple LLM providers |
| 5 | ENS (API, TUI, A2A coordination, cross-language oracles) | 🔧 Built | API via `vinyan serve`; A2A needs `network.instances.enabled` |
| K2 | Trust-Weighted Multi-Agent Dispatch (engine selector, MCP) | 🔧 Built | Provider trust data |
| E1–E4 | Economy OS (cost accounting, budget, market, federation) | 🔧 Built | `economy.enabled: true` |
| O1–O5 | Agent Ecosystem (runtime FSM, commitments, dept/team, volunteer, coordinator) | 🔧 Built | `ecosystem.enabled: true` |
| Agentic SDLC | Brainstorm + Spec phases, ship-it tools (`git_commit`/`git_push`/`git_pr`) | 🔧 Built | `BRAINSTORM_PHASE:on` / `SPEC_PHASE:on` |

**Designed but not built:** L3 container isolation, active-task resumption.

---

## By category

### Foundation (As-Is)
- [`foundation/concept.md`](foundation/concept.md) — Core vision, axioms A1–A7, ECP, RE model.
- [`foundation/theory.md`](foundation/theory.md) — Theoretical foundations (cognitive architecture).
- [`foundation/task-routing-spec.md`](foundation/task-routing-spec.md) — Task routing pipeline (intent resolver, risk router).

### Architecture (mostly As-Is)
- [`architecture/decisions.md`](architecture/decisions.md) — D1–D19 decisions with rationale.
- [`architecture/protocol-architecture.md`](architecture/protocol-architecture.md) — Trust degradation matrix, transport abstraction. **§6 is canonical.**
- [`architecture/forward-predictor-architecture.md`](architecture/forward-predictor-architecture.md) — 3-tier prediction (heuristic → statistical → causal). Heuristic + statistical live; causal pending data.
- [`architecture/vinyan-os-architecture.md`](architecture/vinyan-os-architecture.md) — O1–O5 ecosystem reference architecture. **To-Be for O2–O5.**
- [`architecture/book-integration-overview.md`](architecture/book-integration-overview.md) — Book-integration program (waves shipped piecemeal: silent-agent W1.1, peek W3.1, sleep-cycle W2.3 already in code).
- [`architecture/book-integration-design.md`](architecture/book-integration-design.md) — Design specs for the same program.

### Specifications (As-Is)
- [`spec/tdd.md`](spec/tdd.md) — Technical Design (interfaces, schemas, algorithms). **Single source of truth for code contracts.**
- [`spec/ecp-spec.md`](spec/ecp-spec.md) — ECP v1.0 RC. L0–L1 implemented; L2+ network transports pending PH5.18.
- [`spec/a2a-protocol.md`](spec/a2a-protocol.md) — Agent-to-Agent protocol (ECP-over-A2A v1.0). Replaces the deleted VIIP protocol.
- [`spec/oracle-sdk.md`](spec/oracle-sdk.md) — Oracle SDK (TS + Python). **To-Be — designed, package not yet published.**
- [`spec/w1-contracts.md`](spec/w1-contracts.md) — Frozen cross-track contract surface for W1–W5 parallel work. **Authoritative.**

### Design (mixed As-Is / To-Be)
- [`design/implementation-plan.md`](design/implementation-plan.md) — Phased roadmap with per-component status.
- [`design/phase6-implementation-plan.md`](design/phase6-implementation-plan.md) — Phase 6 (Agentic Worker Protocol) — **fully shipped (45/46 steps).**
- [`design/agentic-worker-protocol.md`](design/agentic-worker-protocol.md) — Background + rationale for Phase 6. Implementation lives in `phase6-implementation-plan.md`.
- [`design/agent-conversation.md`](design/agent-conversation.md) — Clarification protocol (`input-required`, ACR R0–R2). **Shipped.**
- [`design/world-model.md`](design/world-model.md) — Forward Predictor / World Model. **Partial: heuristic + statistical tiers live; causal tier pending.**
- [`design/forward-predictor-implementation-plan.md`](design/forward-predictor-implementation-plan.md) — Companion impl plan (FP-A through FP-G).
- [`design/ehd-confidence-architecture.md`](design/ehd-confidence-architecture.md) — Epistemic Humility Deficit confidence architecture. **Partial: tier/transport caps live; composite calibration pending.**
- [`design/extensible-thinking-system-design.md`](design/extensible-thinking-system-design.md) — Extensible Thinking. **To-Be — not yet prioritized.**
- [`design/k1-implementable-system-design.md`](design/k1-implementable-system-design.md) — K1 hardening. **Code-complete; wired into core-loop.**
- [`design/memory-prompt-architecture-system-design.md`](design/memory-prompt-architecture-system-design.md) — Memory + prompt architecture. **Partial.**
- [`design/semantic-task-understanding-system-design.md`](design/semantic-task-understanding-system-design.md) — STU phases. **Phase A–B + comprehension live; D in ACR; E+ pending.**
- [`design/tui-redesign.md`](design/tui-redesign.md) — TUI redesign spec. **To-Be — designed, awaiting dev resource.**
- [`design/vinyan-os-ecosystem-plan.md`](design/vinyan-os-ecosystem-plan.md) — O1–O5 ecosystem activation recipe. **O1 wired by default; O2–O5 require config flag.**
- [`design/autonomous-orchestrator-v1.md`](design/autonomous-orchestrator-v1.md) — Wave 1–6 outer-loop upgrade design. **Shipped behind feature flags (W3/W5b/W6 default ON; W1/W2/W4/W5a default OFF).**
- [`design/book-integration-implementation-plan.md`](design/book-integration-implementation-plan.md) — Book-integration impl plan (multiple waves landed in code).
- [`design/ecp-system-design.md`](design/ecp-system-design.md) — **To-Be — describes a hypothetical ECP v2. ECP v2 has NOT been released. Read for ideas, do not implement from this doc.**

### Research (background, not active planning)

Research docs informed the live design + spec docs above. They are kept for
context but should not be cited as authority over the live spec.

- A2A landscape: [`research/a2a-landscape-2026.md`](research/a2a-landscape-2026.md) (validates A2A-over-ECP choice).
- Agent-team landscape: [`research/ai-agent-team-landscape-2026.md`](research/ai-agent-team-landscape-2026.md).
- Claude Code deep dive: [`research/claude-code-deep-dive.md`](research/claude-code-deep-dive.md).
- ECP / EHD / Extensible Thinking / Memory series: see the `research/` folder index. Each `*-debate-synthesis.md` was a pre-spec exploration; the corresponding `spec/` or `design/` doc is the authoritative outcome.
- World model + world-graph + uncertainty frameworks: foundational reading for `design/world-model.md`.

### Analysis
- [`analysis/gap-analysis.md`](analysis/gap-analysis.md) — Competitive landscape vs other frameworks.
- [`analysis/expert-review.md`](analysis/expert-review.md) — Multi-agent expert review.
- [`analysis/claude-code-architecture-lessons.md`](analysis/claude-code-architecture-lessons.md) — Harness lessons applied to Vinyan.
- [`analysis/tdd-audit.md`](analysis/tdd-audit.md) — TDD audit + action items.

### Guides
- [`guides/adding-a-specialist.md`](guides/adding-a-specialist.md) — How to add a new specialist agent.

### Archive (historical / superseded)
See [`archive/README.md`](archive/README.md) for what's there and why each
file moved.

---

## Conventions

- **Banners.** Each doc starts with `> Status: As-Is | To-Be | Research | Historical`. If you change a doc's status, update the banner.
- **Cross-references.** Cite `spec/` or `architecture/` docs as authority. `research/` is for context only.
- **Stale doc?** Open a PR. Don't silently rewrite history — note the change in the doc itself.
- **VIIP** has been deleted. The current inter-instance protocol is **ECP-over-A2A v1.0** ([`spec/a2a-protocol.md`](spec/a2a-protocol.md)).
- **ECP v2** has NOT been released. Only one ECP version exists ([`spec/ecp-spec.md`](spec/ecp-spec.md)). Ignore any flag like `ecpV2`.
