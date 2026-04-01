# Agent-to-Agent Protocol Landscape Research (April 2026)

> **Date:** 2026-04-01 | **Scope:** Industry survey of A2A communication protocols
> **Purpose:** Inform Vinyan Phase 5 VIIP design and A2A bridge implementation
> **Cross-reference:** [a2a-protocol.md](../spec/a2a-protocol.md) §9 (Relationship to External A2A)

---

## 1. Protocol Stack Convergence

The agent interoperability space has consolidated under the **Agentic AI Foundation (AAIF)** within the Linux Foundation (founded Dec 2025). Platinum members: Anthropic, OpenAI, Google, Microsoft, AWS, Block, Bloomberg, Cloudflare. 146+ member organizations.

The emerging standard stack:

| Layer | Protocol | Owner | Status |
|-------|----------|-------|--------|
| Agent-to-Tool | **MCP** (Model Context Protocol) | Anthropic → AAIF | De facto standard. 97M monthly SDK downloads |
| Agent-to-Agent | **A2A** (Agent2Agent) | Google → AAIF | v1.0.0 (March 2026). Production-ready |
| Agent-to-IDE | **Zed ACP** (Agent Client Protocol) | Zed Industries | Production. Zed, JetBrains, Neovim |
| Agent Infrastructure | **agentgateway / AGP** | Cisco/LangChain → LF | Early. Routing, security, governance |

**Key insight:** MCP and A2A are officially **complementary, not competing**. MCP = agent uses tools (vertical). A2A = agent talks to agent (horizontal). Both live under AAIF.

---

## 2. Google A2A Protocol (v1.0.0)

### 2.1 Overview

Open standard for inter-agent communication. Originally Google, now Linux Foundation project with multi-vendor TSC (Google, Microsoft, Cisco, AWS, Salesforce, ServiceNow, SAP, IBM Research).

- **Repository:** https://github.com/a2aproject/A2A (22.9k stars, 151 contributors)
- **Spec site:** https://a2a-protocol.org
- **License:** Apache 2.0
- **Normative source:** `spec/a2a.proto` (Protocol Buffers)

### 2.2 Architecture — Three Layers

1. **Layer 1 — Canonical Data Model:** Core structures (Task, Message, Part, Artifact, AgentCard) in Protocol Buffers. Protocol-agnostic.
2. **Layer 2 — Abstract Operations:** SendMessage, StreamMessage, GetTask, ListTasks, CancelTask, SubscribeToTask, Push Notification CRUD, GetExtendedAgentCard.
3. **Layer 3 — Protocol Bindings:** JSON-RPC 2.0, gRPC, HTTP+JSON/REST. New bindings can be added without changing layers 1-2.

### 2.3 Key Design Decisions

| Aspect | Design |
|--------|--------|
| **Transport** | HTTP(S) mandatory. TLS 1.2+ in production. Three bindings: JSON-RPC, gRPC, REST |
| **Discovery** | Agent Cards (JSON metadata) via `/.well-known/agent-card.json`, registries, or direct config |
| **Auth** | OAuth 2.0, OpenID Connect, API keys, Bearer tokens, mTLS. Declared in Agent Card (OpenAPI conventions) |
| **Task lifecycle** | `submitted → working → input-required → auth-required → completed / failed / canceled / rejected` |
| **Interaction** | Sync (request/response), Streaming (SSE), Async (webhooks), Multi-turn (`contextId`) |
| **Opacity** | Agents never expose internals (memory, tools, reasoning) to collaborators |
| **Immutability** | Completed tasks are immutable. Refinements create new tasks |
| **Modality** | Text, files, audio/video refs, structured JSON, forms |

### 2.4 Agent Cards

JSON metadata describing an agent's identity, capabilities, skills, endpoint URL, and auth requirements. Three discovery modes:
1. Well-known URI: `/.well-known/agent-card.json`
2. Curated registries (enterprise-managed)
3. Direct configuration

Extended Agent Cards available after authentication for more detailed capabilities.

### 2.5 Official SDKs

| Language | Package |
|----------|---------|
| Python | `pip install a2a-sdk` |
| JavaScript | `npm install @a2a-js/sdk` |
| Go | `go get github.com/a2aproject/a2a-go` |
| Java | Maven (`a2aproject/a2a-java`) |
| .NET | NuGet (`A2A`) |

Samples: https://github.com/a2aproject/a2a-samples

### 2.6 Adoption Timeline

- **April 2025:** Announced at Google Cloud Next
- **June 2025:** Donated to Linux Foundation (AAIF)
- **August 2025:** IBM's ACP merged into A2A
- **March 2026:** v1.0.0 released with gRPC, signed Agent Cards, multi-tenancy
- **150+ organizations** supporting. TSC includes Google, Microsoft, Cisco, AWS, Salesforce, ServiceNow, SAP, IBM

### 2.7 Known Gaps

- Agent Cards **lack cryptographic signatures** in current spec — vulnerable to impersonation
- **No provenance tracking** — when Agent A → B → C, no chain of custody for claims
- Auth0 partnering with Google Cloud for OAuth-based auth improvements
- Mid-2025 adoption slump (over-engineered for enterprises, MCP captured developer mindshare) — recovered with AAIF formation and v1.0

---

## 3. Other Notable Protocols

### 3.1 IBM ACP (Agent Communication Protocol)

- **Status:** Merged into A2A (August 2025)
- Ultra-lightweight REST-first design (curl/Postman compatible). OTLP tracing built in.
- Design principles influenced A2A's simplification.

### 3.2 ANP (Agent Network Protocol)

- **Origin:** Open source community, China-originated
- **Status:** Spec + prototype. White paper: arXiv:2508.00007
- **Key idea:** Three-layer: (1) W3C DID-based identity, (2) Meta-protocol negotiation (agents negotiate *how* to communicate), (3) Application protocol
- **Differentiator:** Decentralized identity as first-class concern. Most ambitious architectural vision
- W3C AI Agent Protocol Community Group involvement

### 3.3 NLIP (Natural Language Interaction Protocol)

- **Origin:** Ecma International TC-56 (formed Dec 2024)
- **Status:** Ratified standard (ECMA-430 through ECMA-434, Dec 2025)
- **Key idea:** Natural language as communication medium, not structured JSON-RPC
- **Differentiator:** Only formally ratified international standard for agent communication

### 3.4 AITP (Agent Interaction & Transaction Protocol)

- **Origin:** NEAR AI (blockchain ecosystem), Feb 2025
- **Status:** RFC/draft, pre-v1.0
- **Key idea:** Payment and transaction support for agent interactions
- **Differentiator:** First-class commerce/crypto for autonomous agent transactions

### 3.5 Agora Protocol

- **Origin:** Oxford University, Jan 2025
- **Status:** Academic/research
- **Key idea:** Agents create ad-hoc protocols via YAML "Protocol Documents." Protocol evolution is emergent
- **Differentiator:** Meta-protocol for protocol creation — most radical approach

### 3.6 FIPA ACL

- **Origin:** IEEE/FIPA, ~1997-2005
- **Status:** Legacy. Academic/defense only
- Speech-act theory with formal semantics. Historical ancestor. Too heavyweight for LLM agents.

### 3.7 LMOS (Language Model Operating System)

- **Origin:** Eclipse Foundation
- **Status:** Active development
- OS-like architecture with central registry + scheduler. JSON-LD for metadata.

---

## 4. Frameworks (Inter-Agent Communication Patterns)

**Important:** None of these frameworks use A2A internally. They all have proprietary message-passing. Standards (A2A, MCP) matter for **cross-framework** and **cross-organization** communication.

### 4.1 Microsoft AutoGen / Agent Framework

- Event-driven architecture (actor model), async message passing
- Agents share full conversation history — flexible but token-expensive (5-25x)
- Supports MCP + A2A externally
- **Problem:** Agents "keep talking without converging" on deterministic tasks

### 4.2 CrewAI

- Strict hierarchical delegation: manager agent + worker agents
- Hub-and-spoke only (no peer-to-peer). Schema-validated, role-typed messages
- Added A2A and MCP support
- Pragmatic: a project rebuilt in 1 week with CrewAI took 3 weeks with AutoGen

### 4.3 LangGraph (LangChain)

- Graph-first orchestration: agents are nodes, edges are control flow
- Shared state via graph. Supports scatter-gather, pipeline, supervisor patterns
- Co-developed AGNTCY (agent gateway) with Cisco
- Best when you need deterministic routing between agents

### 4.4 OpenAI Agents SDK

- Two primitives: Agents and Handoffs. `transfer_to_XXX()` returns agent objects
- Maximum simplicity. No message queue. Good for single-process, not distributed
- OpenAI co-founded AAIF, contributed AGENTS.md spec

---

## 5. Production Reality

### 5.1 What Works

1. **MCP for tool integration** — universally adopted, clear winner
2. **Orchestrator-worker pattern** (not peer-to-peer) — one coordinator, many workers
3. **Human-in-the-loop checkpoints** — not a limitation, a requirement
4. **Specialized subagents with clear boundaries** — vague delegation fails
5. **CrewAI or LangGraph** for structured multi-agent workflows

### 5.2 What Doesn't Work Yet

1. **Fully autonomous multi-agent** — too unpredictable for critical paths
2. **A2A cross-organization** — promising, pilot programs only, not widespread
3. **Peer-to-peer agent negotiation** (ANP-style) — still research-stage
4. **AutoGen for deterministic tasks** — over-communicates, burns tokens

### 5.3 Failure Statistics

From Galileo's analysis of 1,642 execution traces across production multi-agent systems:

| Metric | Value |
|--------|-------|
| Failure rate without formal orchestration | 41% – 86.7% |
| Multi-agent pilots failing within 6 months | 40% |
| Debug time vs single-agent | 3-5x longer |
| Coordination latency (2 agents) | ~200ms |
| Coordination latency (8 agents) | >4 seconds |
| Failure rate reduction with proper orchestration | 3.2x lower |
| Sprint time spent investigating agent failures | 40% |

### 5.4 Failure Categories

| Category | Frequency | Description |
|----------|-----------|-------------|
| Specification failures | ~42% | Agents misinterpret business constraints despite meeting technical parameters |
| Coordination failures | ~37% | Deadlocks when agents wait for mutual confirmations |
| Verification gaps | ~21% | Hallucinated info in shared memory poisons downstream agents |

### 5.5 Case Studies

**Anthropic Multi-Agent Research System:**
- Orchestrator-worker: Claude Opus 4 lead + Claude Sonnet 4 subagents
- 90.2% improvement over single-agent. 15x token cost
- Token usage alone explains 80% of performance variance
- Key lesson: "Agent-tool interfaces are as critical as human-computer interfaces"

**Amazon/AWS:**
- Thousands of agents across organizations since 2025
- Five required mechanisms: evals, trajectory visualization, fast local feedback, intentional changes with success criteria, regular production sample reading

**Enterprise:**
- Wells Fargo: 35,000 bankers, 1,700 procedures in 30s (was 10 min)
- HCLTech: 40% faster case resolution
- Tyson Foods / Gordon Food Service: A2A for supply chain agent collaboration

---

## 6. Security Considerations

### 6.1 A2A Security Model

- JSON Web Signatures (JWS), scoped capability tokens, schema validation
- **Gap:** Agent Cards lack cryptographic signatures → impersonation risk
- Auth0 partnering with Google Cloud for OAuth-based improvements

### 6.2 MCP Security Model

- OAuth 2.1 + PKCE, schema validation, syscall filtering
- Threats: installer spoofing, tool poisoning, credential theft

### 6.3 Cross-Protocol Gaps

- **No provenance tracking** in either A2A or MCP — critical for compliance
- **No chain of custody** when information passes through multiple agents
- ANP's W3C DID approach has strongest identity model but highest complexity

### 6.4 Protocol-Specific Threats (arXiv:2602.11327)

| Protocol | Key Threats |
|----------|-------------|
| A2A | Task injection, notification hijacking |
| MCP | Tool poisoning, credential theft via malicious servers |
| ANP | High complexity of DID-based crypto auth |

---

## 7. Comparison: Vinyan VIIP vs Google A2A

| Aspect | Vinyan VIIP | Google A2A v1.0 | Analysis |
|--------|-------------|-----------------|----------|
| **Transport** | WebSocket (persistent, bidirectional) | HTTP + SSE / gRPC / webhooks | A2A is HTTP-first (simpler, more universal) |
| **Discovery** | Static peer config (`peers[]` in yaml) | Agent Cards + well-known URI + registries | A2A has richer dynamic discovery |
| **Auth** | Ed25519 message signing | OAuth 2.0, mTLS, API keys | A2A uses standard web auth (broader ecosystem) |
| **Message format** | VIIPEnvelope (custom) | Protocol Buffers canonical model | A2A has multi-binding advantage (JSON-RPC, gRPC, REST) |
| **Epistemic semantics** | **Native** — confidence, evidence chains, falsifiable_by, temporal_context | None — generic task/artifact model | **VIIP's unique advantage** |
| **Trust model** | Empirical (Wilson LB on verdict accuracy) | Declared in Agent Card | VIIP is data-driven; A2A is declarative |
| **Knowledge sharing** | 3-phase protocol (offer → accept → transfer) with provenance | Not supported | **VIIP unique feature** |
| **Task lifecycle** | task_delegate → task_result/task_cancel | submitted → working → completed/failed (richer states) | A2A has more granular lifecycle states |
| **Deduplication** | UUIDv7 + 10K FIFO window | Message ID based | Similar approaches |
| **Partition tolerance** | AP (fail-open to single-instance) | Not specified at protocol level | VIIP explicitly handles network partitions |

### VIIP's Unique Edges Over A2A

1. **Epistemic semantics** — confidence, evidence chains, falsifiability are first-class in every message. A2A treats payloads as opaque
2. **Empirical trust** — trust earned through accuracy measurement (Wilson LB), not declared
3. **Knowledge sharing** — structured 3-phase protocol with provenance. A2A has no equivalent
4. **Partition tolerance** — explicit AP design with partition heal recovery. A2A doesn't address this
5. **Content-addressed truth** — facts bound to SHA-256 file hash, auto-invalidate on change

### Where A2A is Stronger

1. **Standard web auth** — OAuth, mTLS vs custom Ed25519 signing
2. **Dynamic discovery** — Agent Cards vs static peer config
3. **Multi-binding transport** — JSON-RPC + gRPC + REST vs WebSocket-only
4. **SDK ecosystem** — 5 official SDKs, 150+ org backing
5. **Task lifecycle granularity** — more states (input-required, auth-required, rejected)

---

## 8. Recommendations for Vinyan

> **Update (2026-04-01):** VIIP has been removed. A2A v1.0 is now the sole transport for both Vinyan-to-Vinyan and external agent communication. ECP semantics ride inside A2A `data` parts with MIME `application/vnd.vinyan.ecp+json`. See `docs/spec/a2a-protocol.md` for the full specification.

### Implemented Architecture

```
┌──────────────────────────────────────────┐
│         Third-Party Agents               │
│  (Google ADK, LangGraph, CrewAI, etc.)   │
└──────────────┬───────────────────────────┘
               │ A2A v1.0 (standard JSON-RPC)
┌──────────────▼───────────────────────────┐
│        ECP-over-A2A Protocol             │
│  - Agent Card with x-vinyan-ecp ext      │
│  - ECP data parts (22 message types)     │
│  - Confidence: clampFull(tier,transport, │
│    peerTrust) — 4-level trust lifecycle  │
└──────────────┬───────────────────────────┘
               │ ECP semantics preserved
┌──────────────▼───────────────────────────┐
│         Vinyan Instance                  │
│  Peer discovery via Agent Cards          │
│  Wilson LB trust progression             │
│  Knowledge sharing (Tier 0 + Tier 2)     │
└──────────────────────────────────────────┘
```

### What was implemented (v1.0)

1. **A2A as sole transport:** VIIP deleted. A2A v1.0 JSON-RPC handles transport. ECP data parts carry epistemic semantics inside A2A `data` message parts.
2. **Unified trust vocabulary:** 4 levels — `untrusted` (0.25), `provisional` (0.40), `established` (0.50), `trusted` (0.60). Wilson LB progression with configurable thresholds.
3. **Canonical clamping:** `clampFull()` applies tier, transport, and peer trust ceilings independently (minimum wins). Replaces all previous confidence cap mechanisms.
4. **Peer discovery:** Agent Cards at `/.well-known/agent.json` with `x-vinyan-ecp` extension identifying Vinyan peers and their oracle capabilities.
5. **Knowledge sharing:** Tier 0 (real-time file hash invalidation) + Tier 2 (batch pattern exchange on Sleep Cycle with 50% probation reduction).
6. **Streaming schemas:** `ECPProgressUpdate` and `ECPPartialVerdict` Zod schemas with SSE channel and backpressure handling.
7. **Infrastructure:** Peer health monitor (heartbeat state machine), remote bus adapter (event forwarding), full config schema.

### Still recommended for future

1. **Auth evolution:** Add OAuth 2.0 support alongside Ed25519 for enterprise deployments.
2. **v1.1 coordination:** PROPOSE/AFFIRM/COMMIT/RETRACT primitives, intent declaration, distributed tracing.
3. **v2.0 fleet scale:** Gossip-based knowledge propagation, cross-instance trust attestation sharing.

---

## 9. Standards Bodies to Watch

| Body | Activity | Timeline |
|------|----------|----------|
| **AAIF** (Linux Foundation) | Governs MCP + A2A. 146 members | Active now |
| **W3C** AI Agent Protocol CG | Inter-agent communication, agent identity | Specs expected 2026-2027 |
| **IETF** | AI Preferences WG, agent identity (SCIM), framework draft | Exploratory |
| **NIST** | AI Agent Standards Initiative (security, identity, interop) | Launched Feb 2026 |
| **Ecma** TC-56 | NLIP standards (ECMA-430-434) ratified | Dec 2025 |

---

## 10. Key References

### Specifications & Repositories
- [A2A Protocol Specification](https://a2a-protocol.org/latest/specification/)
- [A2A GitHub Repository](https://github.com/a2aproject/A2A)
- [A2A Samples](https://github.com/a2aproject/a2a-samples)
- [MCP Specification](https://modelcontextprotocol.io)
- [ANP — Agent Network Protocol](https://github.com/agent-network-protocol/AgentNetworkProtocol)
- [NLIP Standards (Ecma)](https://ecma-international.org/news/ecma-international-approves-nlip-standards-suite-for-universal-ai-agent-communication/)
- [AITP — Agent Interaction & Transaction Protocol](https://aitp.dev/)
- [Zed Agent Client Protocol](https://zed.dev/acp)
- [AGENTS.md Specification](https://agents.md/)
- [AGNTCY Documentation](https://docs.agntcy.org/)

### SDKs
- [A2A Python SDK](https://github.com/a2aproject/a2a-python) — `pip install a2a-sdk`
- [A2A JavaScript SDK](https://github.com/a2aproject/a2a-js) — `npm install @a2a-js/sdk`
- [A2A Go SDK](https://github.com/a2aproject/a2a-go)
- [A2A Java SDK](https://github.com/a2aproject/a2a-java)
- [A2A .NET SDK](https://github.com/a2aproject/a2a-dotnet)

### Academic Papers
- [A Survey of AI Agent Protocols](https://arxiv.org/abs/2504.16736) — Comprehensive comparison across 7 metrics (June 2025)
- [Survey of Agent Interoperability: MCP, ACP, A2A, ANP](https://arxiv.org/abs/2505.02279) — Deep dive on the "big four"
- [Beyond Self-Talk: Communication-Centric Survey of LLM-Based Multi-Agent Systems](https://arxiv.org/abs/2502.14321)
- [LACP Requires Urgent Standardization](https://arxiv.org/abs/2510.13821) — Telecom-inspired argument
- [AI Agent Communication Security Survey](https://arxiv.org/abs/2506.19676) — Security-focused analysis
- [Which LLM Multi-Agent Protocol to Choose?](https://arxiv.org/abs/2510.17149) — Practical benchmarking
- [ANP White Paper](https://arxiv.org/abs/2508.00007)
- [Security Threat Modeling for AI Agent Protocols](https://arxiv.org/abs/2602.11327)

### Industry Analysis
- [Anthropic Multi-Agent Research System](https://www.anthropic.com/engineering/multi-agent-research-system)
- [AWS: Evaluating AI Agents](https://aws.amazon.com/blogs/machine-learning/evaluating-ai-agents-real-world-lessons-from-building-agentic-systems-at-amazon/)
- [Multi-Agent Failure Patterns (Galileo)](https://galileo.ai/blog/multi-agent-ai-failures-prevention)
- [What Happened to Google's A2A](https://blog.fka.dev/blog/2025-09-11-what-happened-to-googles-a2a/)
- [Auth0: MCP vs A2A](https://auth0.com/blog/mcp-vs-a2a/)
- [MCP Server Performance Benchmarks](https://www.tmdevlab.com/mcp-server-performance-benchmark.html)
- [Agent Communication Protocols Landscape](https://generativeprogrammer.com/p/agent-communication-protocols-landscape)
- [AI Agent Protocols 2026 Complete Guide](https://www.ruh.ai/blogs/ai-agent-protocols-2026-complete-guide)

### Governance & Standards
- [AAIF (Linux Foundation)](https://www.linuxfoundation.org/press/linux-foundation-announces-the-formation-of-the-agentic-ai-foundation)
- [W3C AI Agent Protocol Community Group](https://www.w3.org/groups/cg/agentprotocol/)
- [IETF Agentic AI Standards](https://www.ietf.org/blog/agentic-ai-standards/)
- [NIST AI Agent Standards Initiative](https://www.nist.gov/news-events/news/2026/02/announcing-ai-agent-standards-initiative-interoperable-and-secure)

### Tutorials & Getting Started
- [Google Codelab: A2A Purchasing Concierge](https://codelabs.developers.google.com/intro-a2a-purchasing-concierge)
- [DeepLearning.AI A2A Course](https://goo.gle/dlai-a2a)
- [A2A Discord Community](http://discord.gg/a2aprotocol)
