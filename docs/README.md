# Vinyan Documentation

## Reading Order

1. **[foundation/concept.md](foundation/concept.md)** — Vision, 7 Core Axioms (A1-A7), ECP protocol, Reasoning Engine model
2. **[foundation/theory.md](foundation/theory.md)** — Theoretical foundations (GWT, Active Inference, Predictive Processing)
3. **[architecture/decisions.md](architecture/decisions.md)** — Concrete decisions D1-D18, component design, phase roadmap
4. **[spec/tdd.md](spec/tdd.md)** — Implementation contracts, interface definitions, schemas, algorithms
5. **[design/implementation-plan.md](design/implementation-plan.md)** — Phased roadmap (Phase 0-6)

## By Category

### Foundation
- [concept.md](foundation/concept.md) — Core vision and axioms
- [theory.md](foundation/theory.md) — Academic foundations and cognitive architecture

### Architecture
- [decisions.md](architecture/decisions.md) — D1-D18 architecture decisions
- [protocol-architecture.md](architecture/protocol-architecture.md) — Transport abstraction, remote oracle pattern, trust degradation
- [forward-predictor-architecture.md](architecture/forward-predictor-architecture.md) — ForwardPredictor 3-tier prediction system (Heuristic → Statistical → Causal)

### Specifications
- [tdd.md](spec/tdd.md) — Technical Design Document (interfaces, schemas, algorithms)
- [ecp-spec.md](spec/ecp-spec.md) — Epistemic Communication Protocol specification
- [a2a-protocol.md](spec/a2a-protocol.md) — Agent-to-Agent protocol (VIIP)
- [oracle-sdk.md](spec/oracle-sdk.md) — Oracle SDK developer guide (TypeScript + Python)

### Design
- [implementation-plan.md](design/implementation-plan.md) — Phase 0-6 implementation roadmap + EO Reconception + DAG Integration
- [phase6-implementation-plan.md](design/phase6-implementation-plan.md) — Phase 6: Agentic Worker Protocol implementation plan (45/46 steps)
- [agentic-worker-protocol.md](design/agentic-worker-protocol.md) — Multi-turn tool loop, delegation, session overlay, transcript compaction
- [agent-conversation.md](design/agent-conversation.md) — Clarification protocol: `input-required` status, interactive delegation, CLARIFIED/CONTEXT constraint conventions (A2 First-Class Uncertainty)
- [world-model.md](design/world-model.md) — Forward Predictor / World Model design (GAP-A)
- [forward-predictor-implementation-plan.md](design/forward-predictor-implementation-plan.md) — ForwardPredictor 7-phase implementation plan (FP-A through FP-G)
- [ehd-confidence-architecture.md](design/ehd-confidence-architecture.md) — Epistemic Humility Deficit confidence architecture (75% → targeting 85%)
- [identity-reframe-plan.md](design/identity-reframe-plan.md) — EO identity reframe plan
- [tui-redesign.md](design/tui-redesign.md) — TUI redesign specification

### Research
- [world-model-research.md](research/world-model-research.md) — World Model for ForwardPredictor (calibration theory, design gaps G1-G7)
- [epistemic-humility-deficit.md](research/epistemic-humility-deficit.md) — Epistemic Humility Deficit research
- [epistemic-humility-deficit-2025-07.md](research/epistemic-humility-deficit-2025-07.md) — EHD follow-up (July 2025)
- [ehd-synthesis.md](research/ehd-synthesis.md) — EHD synthesis
- [ehd-technical-landscape.md](research/ehd-technical-landscape.md) — EHD technical landscape
- [ehd-implementation-design.md](research/ehd-implementation-design.md) — EHD implementation design
- [formal-uncertainty-frameworks.md](research/formal-uncertainty-frameworks.md) — Formal uncertainty frameworks survey
- [ecp-v2-research.md](research/ecp-v2-research.md) — ECP v2 protocol research
- [a2a-landscape-2026.md](research/a2a-landscape-2026.md) — Agent-to-Agent landscape (2026)
- [design-decision-engine.md](research/design-decision-engine.md) — Decision engine design research
- [design-oracle-integrity.md](research/design-oracle-integrity.md) — Oracle integrity design research
- [design-pipeline-confidence.md](research/design-pipeline-confidence.md) — Pipeline confidence design research
- [design-subjective-logic.md](research/design-subjective-logic.md) — Subjective logic design research

### Analysis
- [gap-analysis.md](analysis/gap-analysis.md) — Competitive landscape vs existing frameworks
- [expert-review.md](analysis/expert-review.md) — Expert panel review findings
- [claude-code-architecture-lessons.md](analysis/claude-code-architecture-lessons.md) — Claude Code harness lessons relevant to Vinyan memory, prompts, and thinking
- [tdd-audit.md](analysis/tdd-audit.md) — TDD audit results and action items
