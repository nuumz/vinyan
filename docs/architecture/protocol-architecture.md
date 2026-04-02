# Vinyan Protocol Architecture — ECP-Centric Design

> **Version:** 1.0-draft | **Date:** 2026-04-01
> **Context:** Rethink of Vinyan's external interface design. MCP/A2A become bridge layers; ECP becomes the native publishable protocol for the ENS ecosystem.
> **References:** [ecp-spec.md](../spec/ecp-spec.md), [oracle-sdk.md](../spec/oracle-sdk.md), [concept.md](../foundation/concept.md) §2

### Document Boundary

| This doc owns | Cross-ref for |
|:-------------|:--------------|
| Three-layer protocol stack (L1/L2/L3) | ECP wire format & epistemic semantics → [ecp-spec.md](../spec/ecp-spec.md) |
| Transport abstraction & resolution | A2A message types & trust lifecycle → [a2a-protocol.md](../spec/a2a-protocol.md) |
| Remote oracle pattern (connection, trust degradation, circuit breaker) | Agentic worker IPC & delegation → [agentic-worker-protocol.md](../design/agentic-worker-protocol.md) |
| MCP/A2A bridge **implementation plans** (tool schemas, wiring, files to modify) | MCP/A2A bridge **translation semantics** → [ecp-spec.md](../spec/ecp-spec.md) §10 |
| **§6 Trust Degradation Matrix — canonical source** for the full cross-layer trust model | ECP v2 research directions → [ecp-v2-research.md](../research/ecp-v2-research.md) |
| Migration path & execution order | |

---

## §1 Architecture Overview

### The Problem

Vinyan's current external interfaces treat it as either a **tool** (MCP) or a **peer agent** (A2A). Neither captures its true role: an **Epistemic Nervous System** that connects heterogeneous Reasoning Engines. The protocol architecture must reflect this.

### Three-Layer Protocol Stack

```
┌──────────────────────────────────────────────────────────┐
│  Layer 3: Bridge Protocols                               │
│  MCP Bridge │ A2A Bridge │ LSP Bridge (future)           │
│  ─── translation + trust degradation ───                 │
├──────────────────────────────────────────────────────────┤
│  Layer 2: ECP Network                                    │
│  WebSocket transport │ HTTP fallback │ Network envelope  │
│  ─── same ECP semantics, network-aware ───               │
├──────────────────────────────────────────────────────────┤
│  Layer 1: ECP Local                                      │
│  Stdio transport │ Subprocess lifecycle │ Zod validation │
│  ─── current production implementation ───               │
└──────────────────────────────────────────────────────────┘
```

**Principle:** All three layers use the same ECP message schema (`HypothesisTuple` → `OracleVerdict`). Transport determines two things: (1) connection lifecycle and (2) trust-level confidence adjustment (§6). Confidence is clamped at the transport boundary (`src/oracle/tier-clamp.ts`) so that downstream code sees a single `confidence` number — it doesn't need to know the transport, but the transport has already influenced the value.

### Interaction Patterns Supported

| # | Pattern | Layer | Status |
|:--|:--------|:------|:-------|
| 1 | AI Agent → Vinyan: "Verify my output" | L3 (MCP Bridge) | ✅ Implemented |
| 2 | Vinyan → External Tool: "Execute this" | L3 (MCP Client) | ⚠️ Code exists, not wired |
| 3 | Remote Oracle → Vinyan: "I can verify X" | L2 (ECP Network) | ❌ Design phase |
| 4 | Vinyan ↔ Vinyan: "Share knowledge" | L2 (ECP Network) | ❌ Design phase |
| 5 | External System → Vinyan: "Join verification" | L2 (ECP Network) | ❌ Design phase |
| 6 | Any Agent → Vinyan: "Assess risk" | L3 (MCP expanded) | ⚠️ Partial (4 of 8 tools) |

---

## §2 Transport Abstraction

### Current State

`src/oracle/runner.ts` hardcodes `Bun.spawn()` at line 52. Every oracle is a local subprocess:

```typescript
// Current: hardcoded stdio transport
const proc = Bun.spawn(spawnArgs, { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
```

### Target State

The runner resolves transport from the registry entry:

```typescript
// Target: transport-agnostic base interface
interface ECPTransport {
  /** Send a hypothesis and receive a verdict. */
  verify(hypothesis: HypothesisTuple, timeout_ms: number): Promise<OracleVerdict>;
  /** Close the transport (kill subprocess, close WebSocket, etc.) */
  close(): Promise<void>;
  /** Transport type for trust level determination. */
  readonly transportType: "stdio" | "websocket" | "http";
  /** Whether the transport is currently connected and ready. */
  readonly connected: boolean;
}

/**
 * Extended interface for persistent transports (WebSocket).
 * StdioTransport does NOT implement this — subprocess lifecycle is per-invocation.
 */
interface PersistentECPTransport extends ECPTransport {
  /** Register engine capabilities with the orchestrator. */
  register(capabilities: EngineCapabilities): Promise<{ engine_id: string }>;
  /** Send/receive heartbeat. Returns false if peer is unresponsive. */
  heartbeat(): Promise<boolean>;
  /** Reconnect with exponential backoff after connection loss. */
  reconnect(): Promise<void>;
  /** Event emitter for connection lifecycle events. */
  on(event: "disconnected" | "reconnected" | "heartbeat_timeout", handler: () => void): void;
}
```

> **Design note:** `StdioTransport` implements `ECPTransport` only — subprocess oracles have a spawn→verify→exit lifecycle with no persistent connection. `WebSocketTransport` implements `PersistentECPTransport` which adds registration, heartbeat, and reconnection (§3). This split avoids forcing subprocess oracles to implement no-op lifecycle methods.

**Implementations:**

| Transport | Class | Use Case |
|:----------|:------|:---------|
| `StdioTransport` | Wraps current `Bun.spawn()` logic | Local subprocess oracles (all existing oracles) |
| `WebSocketTransport` | Persistent WS connection to remote engine | Remote oracles, cross-instance coordination |
| `HttpTransport` | Stateless POST `/ecp/v1/verify` | Serverless, firewalled environments |

### Transport Resolution

```typescript
function resolveTransport(entry: OracleRegistryEntry): ECPTransport {
  if (entry.transport === "websocket" && entry.endpoint) {
    return new WebSocketTransport(entry.endpoint);
  }
  if (entry.transport === "http" && entry.endpoint) {
    return new HttpTransport(entry.endpoint);
  }
  // Default: stdio (backward compatible)
  const command = entry.command ?? `bun run ${entry.path}`;
  return new StdioTransport(command);
}
```

### Files to Modify

| File | Change |
|:-----|:-------|
| `src/oracle/runner.ts` | Extract `StdioTransport` from current logic. Add transport resolution. |
| `src/oracle/registry.ts` | Add `transport?: "stdio" \| "websocket" \| "http"` and `endpoint?: string` to `OracleRegistryEntry`. |
| New: `src/oracle/transport/stdio.ts` | Extract current subprocess logic into `StdioTransport` class. |
| New: `src/oracle/transport/websocket.ts` | WebSocket transport implementation. |
| New: `src/oracle/transport/http.ts` | HTTP transport implementation. |
| New: `src/oracle/transport/types.ts` | `ECPTransport` interface. |

### Backward Compatibility

All existing oracles continue to work unchanged. The default transport is `stdio`. The `command` and `path` fields on `OracleRegistryEntry` still work as before. Transport abstraction is purely additive.

---

## §3 Remote Oracle Pattern

### Connection Lifecycle

```
Remote Engine                              Vinyan Orchestrator
    │                                           │
    │── WebSocket connect: ws://host/ecp/v1 ───▶│
    │── ecp/register: {                         │
    │     name, patterns, languages, tier       │
    │   } ─────────────────────────────────────▶│
    │                                           │── validate registration
    │                                           │── assign engineId
    │                                           │── add to registry
    │◀── ack: { engine_id, accepted_version } ──│
    │                                           │
    │   ... normal operation ...                │
    │                                           │
    │◀── ecp/verify: { hypothesis } ────────────│
    │── process hypothesis                      │
    │── ecp/verdict: { verdict } ──────────────▶│
    │                                           │
    │── ecp/heartbeat: { status } ─────────────▶│  (every 30s)
    │◀── ecp/heartbeat: { ack } ────────────────│
    │                                           │
    │   ... connection lost ...                 │
    │── reconnect with backoff ────────────────▶│
    │── ecp/register (re-register) ────────────▶│
    │◀── ack (merge with existing) ─────────────│
```

### Trust Degradation for Remote Engines

Remote engines always operate with reduced trust:

| Engine Location | Transport | Confidence Adjustment | Rationale |
|:----------------|:----------|:---------------------|:----------|
| Local subprocess | stdio | As-reported (up to tier cap) | Trusted execution environment |
| Remote Vinyan instance | WebSocket | Cap at 0.95 (I13) | Network introduces latency and partition risk |
| Remote third-party | WebSocket | `confidence × 0.8` | Uncontrolled execution environment |
| Remote third-party | HTTP | `confidence × 0.7` | Stateless, no health monitoring |

The transport type and trust level are factored into the `confidence` value **before** the verdict enters the Orchestrator's aggregation pipeline. Downstream code sees a single `confidence` number — it doesn't need to know the transport.

### Circuit Breaker for Remote Engines

Same pattern as local oracles — see [ecp-spec.md §6.3](../spec/ecp-spec.md) for the consolidated circuit breaker spec (including network-aware triggers table merged from this section).

### Temporal Context for Network Engines

Network latency makes `temporal_context` operationally critical:

- Remote verdicts SHOULD include `temporal_context.valid_from` = when evidence was gathered.
- The Orchestrator checks: if `now > valid_until`, the verdict is automatically stale.
- For real-time verification, `valid_until` should be `valid_from + verification_freshness_window` (default: 300s for remote, unlimited for local).

---

## §4 MCP Bridge Evolution

### 4.1 Expanded MCP Server

Current: 4 tools. Target: 8 tools.

| Tool | Status | ECP Operation | Description |
|:-----|:-------|:-------------|:-----------|
| `vinyan_ast_verify` | ✅ Exists | `ecp/verify` → ast oracle | AST pattern verification |
| `vinyan_type_check` | ✅ Exists | `ecp/verify` → type oracle | Type checking |
| `vinyan_blast_radius` | ✅ Exists | `ecp/verify` → dep oracle | Dependency blast radius |
| `vinyan_query_facts` | ✅ Exists | World Graph query | Query verified facts |
| `vinyan_run_gate` | **New** | Full gate pipeline | Risk route → multi-oracle → aggregate |
| `vinyan_risk_assess` | **New** | Risk scoring | Compute risk score for a change |
| `vinyan_query_evidence` | **New** | Evidence retrieval | Get evidence chain for a fact |
| `vinyan_list_oracles` | **New** | Registry query | Discover available engines + capabilities |

**New tool schemas:**

```typescript
// vinyan_run_gate — full verification pipeline
{
  name: "vinyan_run_gate",
  inputSchema: {
    type: "object",
    properties: {
      files: { type: "array", items: { type: "string" }, description: "Files to verify" },
      workspace: { type: "string", description: "Workspace root" },
      risk_level: { type: "string", enum: ["auto", "l0", "l1", "l2", "l3"], description: "Override routing level" }
    },
    required: ["files", "workspace"]
  }
}

// vinyan_risk_assess — risk scoring
{
  name: "vinyan_risk_assess",
  inputSchema: {
    type: "object",
    properties: {
      files: { type: "array", items: { type: "string" } },
      workspace: { type: "string" },
      description: { type: "string", description: "Natural language change description" }
    },
    required: ["files", "workspace"]
  }
}

// vinyan_query_evidence — evidence chain for a fact
{
  name: "vinyan_query_evidence",
  inputSchema: {
    type: "object",
    properties: {
      target: { type: "string", description: "File or symbol to query" },
      pattern: { type: "string", description: "Pattern filter (optional)" }
    },
    required: ["target"]
  }
}

// vinyan_list_oracles — discover available engines
{
  name: "vinyan_list_oracles",
  inputSchema: {
    type: "object",
    properties: {
      language: { type: "string", description: "Filter by language (optional)" }
    }
  }
}
```

**Files to modify:**
- `src/mcp/server.ts` — Add 4 new tool handlers
- `src/cli/mcp.ts` — Wire new tools to `runGate()` (`src/gate/gate.ts`), `calculateRiskScore()` (`src/gate/risk-router.ts`), `listOracles()` (`src/oracle/registry.ts`)

### 4.2 MCP Client Wiring

`MCPClientBridge` exists at `src/mcp/client-bridge.ts` but is not connected to startup.

**Wiring plan:**

1. Read from `vinyan.json`:
   ```json
   { "phase5": { "mcp": { "client_servers": [
     { "name": "github-tools", "command": "npx @github/mcp-server", "trust_level": "semi-trusted" }
   ] } } }
   ```

2. On startup (`src/orchestrator/factory.ts`):
   ```typescript
   for (const server of config.phase5?.mcp?.client_servers ?? []) {
     const bridge = new MCPClientBridge({ ...server });
     await bridge.connect();
     const tools = await bridge.discoverTools();
     // Register discovered tools as probabilistic-tier oracle proxies
     for (const tool of tools) {
       registerOracle(`mcp:${server.name}:${tool.name}`, {
         command: undefined,  // not a subprocess — calls through bridge
         tier: "probabilistic",
         // Custom handler that calls bridge.callTool()
       });
     }
   }
   ```

3. External MCP tools become **probabilistic-tier** evidence sources. Their results pass through `mcpToEcp()` with trust-level confidence caps.

**Files to modify:**
- `src/orchestrator/factory.ts` — Add MCP client startup
- `src/mcp/client-bridge.ts` — Add method to register discovered tools as oracle proxies
- `src/config/schema.ts` — `Phase5MCPConfigSchema` already exists (no changes needed)

### 4.3 Translation Layer

The translation layer (`src/mcp/ecp-translation.ts`) remains the trust boundary:

- **Outbound (ecpToMcp):** Full ECP verdict → lossy MCP result (epistemic metadata in JSON text content)
- **Inbound (mcpToEcp):** Opaque MCP result → degraded ECP verdict (`type: "uncertain"`, confidence capped)

No changes needed to the translation logic — it already enforces A5 correctly.

---

## §5 A2A Bridge Evolution

### 5.1 Current State

`src/a2a/bridge.ts` handles task-level interaction only:
- `tasks/send` — Submit a full task to Vinyan's orchestrator
- `tasks/get` — Poll task status
- `tasks/cancel` — Cancel a running task

### 5.2 Verification-Level A2A (Proposed)

External A2A agents should be able to send **hypotheses** for verification without submitting a full task. This is a lightweight interaction for agents that want Vinyan's oracle capabilities without the full orchestrator loop.

**New endpoint:**

```
POST /a2a/verify
Content-Type: application/json

{
  "jsonrpc": "2.0",
  "id": "1",
  "method": "verify",
  "params": {
    "hypothesis": {
      "target": "src/auth/login.ts",
      "pattern": "type-check",
      "workspace": "/project"
    }
  }
}
```

**Response:**
```json
{
  "jsonrpc": "2.0",
  "id": "1",
  "result": {
    "verified": true,
    "type": "known",
    "confidence": 0.5,
    "evidence": [...]
  }
}
```

**Trust rules:**
- Confidence capped via `clampFull(confidence, tier, "a2a", peerTrust)` — 4-level peer trust (untrusted=0.25, provisional=0.40, established=0.50, trusted=0.60)
- All A2A verification results: `type: "uncertain"`
- Uses `src/a2a/confidence-injector.ts` with parametric peer trust levels via `clampFull()`

### 5.3 Agent Card Enhancement

Current agent card (`src/a2a/agent-card.ts`) advertises task-level skills. Enhanced version also advertises oracle capabilities:

```json
{
  "name": "vinyan",
  "description": "Epistemic Nervous System for AI Systems",
  "url": "http://localhost:3927",
  "skills": [
    { "id": "verify-typescript", "name": "TypeScript Verification", "description": "Type check, AST, lint, test" },
    { "id": "verify-python", "name": "Python Verification", "description": "Pyright type checking" }
  ],
  "ecp": {
    "conformance_level": 1,
    "protocol_version": 1,
    "oracles": ["ast-oracle", "type-oracle", "dep-oracle", "test-oracle", "lint-oracle", "python-type"]
  }
}
```

**Files to modify:**
- `src/a2a/bridge.ts` — Add `verify` method handler
- `src/a2a/agent-card.ts` — Add `ecp` section with oracle capabilities
- `src/api/server.ts` — Add `POST /a2a/verify` route

---

## §6 Trust Degradation Matrix (Canonical Source)

> **This is the single source of truth** for the complete trust model. Other documents ([ecp-spec.md](../spec/ecp-spec.md) §4.4, [a2a-protocol.md](../spec/a2a-protocol.md) §4) define their local pieces; this table unifies everything.

The complete trust model across all protocol layers:

| Source | Transport | Layer | Confidence Cap | Type Cap | Status | Code Reference |
|:-------|:----------|:------|---------------:|:---------|:-------|:----------|
| Local deterministic oracle | stdio | L1 | 1.0 | `known` | ✅ Implemented | `TIER_CAPS.deterministic` in `src/oracle/tier-clamp.ts` |
| Local heuristic oracle | stdio | L1 | 0.9 | `known` | ✅ Implemented | `TIER_CAPS.heuristic` in `src/oracle/tier-clamp.ts` |
| Local probabilistic oracle | stdio | L1 | 0.7 | `known` | ✅ Implemented | `TIER_CAPS.probabilistic` in `src/oracle/tier-clamp.ts` |
| Remote Vinyan oracle | WebSocket | L2 | 0.95 | `known` | ⚠️ Cap defined, transport not implemented | `TRANSPORT_CAPS.websocket` in `src/oracle/tier-clamp.ts` |
| Remote third-party oracle | WebSocket | L2 | `conf × 0.8` | `uncertain` | ❌ Design only | — |
| MCP tool (`local`) | stdio | L3 | 0.7 | `uncertain` | ✅ Implemented | `clampFull("probabilistic", "stdio")` in `src/mcp/ecp-translation.ts` |
| MCP tool (`network`) | stdio | L3 | 0.40 | `uncertain` | ✅ Implemented | `clampFull("probabilistic", "http", "provisional")` in `src/mcp/ecp-translation.ts` |
| MCP tool (`remote`) | stdio | L3 | 0.25 | `uncertain` | ✅ Implemented | `clampFull("probabilistic", "a2a", "untrusted")` in `src/mcp/ecp-translation.ts` |
| A2A peer (untrusted) | HTTP | L3 | 0.25 | `uncertain` | ✅ Implemented | `clampFull(tier, "a2a", "untrusted")` — `PEER_TRUST_CAPS.untrusted` |
| A2A peer (provisional) | HTTP | L3 | 0.40 | `uncertain` | ✅ Implemented | `clampFull(tier, "a2a", "provisional")` |
| A2A peer (established) | HTTP | L3 | 0.50 | `uncertain` | ✅ Implemented | `clampFull(tier, "a2a", "established")` |
| A2A peer (trusted) | HTTP | L3 | 0.50 | `uncertain` | ✅ Implemented | `clampFull(tier, "a2a", "trusted")` — capped by transport=0.50 |

> **Trust vocabulary unified:** All trust levels use canonical `PeerTrustLevel` from `src/oracle/tier-clamp.ts`: `untrusted` (0.25), `provisional` (0.40), `established` (0.50), `trusted` (0.60). MCP bridge maps `local`→no peer trust, `network`→provisional, `remote`→untrusted via `clampFull()`. The config schema uses the same vocabulary: `"untrusted" | "provisional" | "established" | "trusted"`.

**Key invariant:** Local deterministic evidence always outranks any remote or bridged evidence. This ensures A5 (Tiered Trust) holds regardless of protocol path.

---

## §7 Migration Path

How this architecture maps to the existing implementation plan:

| Phase 5 Item | Protocol Architecture Section | Status |
|:-------------|:------------------------------|:-------|
| PH5.0 Pre-cleanup | — | Open (2 items) |
| PH5.1 API Server | §4.2 (MCP client wiring startup), §5.2 (A2A verify route) | Partial |
| PH5.5 MCP Bridge | §4.1 (expanded tools), §4.2 (client wiring) | Partial (4/8 tools) |
| PH5.6 A2A Bridge | §5.2 (verification-level), §5.3 (agent card) | Partial |
| PH5.7 ECP Network Transport | §2 (transport abstraction), §3 (remote oracle pattern) | Design |
| PH5.8 Instance Coordinator | §3 (remote engine lifecycle) | Design |
| PH5.10 Polyglot Framework | §2 (`command` field already supports any language) | Partial (`runner.ts` supports `command` field; `gate.ts` calls verifiers directly) |
| PH5.14 Security | ECP Spec §8 (instance identity, signing) | Partial |

### New Phase 5 Items (Proposed)

| Item | Description | Depends On |
|:-----|:-----------|:-----------|
| **PH5.17** Oracle SDK packages | Publish `@vinyan/oracle-sdk` (TS) and `vinyan-oracle-sdk` (Python PyPI) | ECP spec finalized |
| **PH5.18** ECP Network Transport | Implement `WebSocketTransport` + `HttpTransport` + transport resolution in runner | PH5.14 (security) |
| **PH5.19** ECP Specification publication | Formalize ECP spec as a standalone document for external consumption | ECP spec reviewed |

### Recommended Execution Order

```
Tier 0 — Prerequisites:
  PH5.16 (Migration) → PH5.0 (Cleanup) → PH5.14 (Security)

Tier 1 — ECP Foundation:
  PH5.18 (ECP Transport) → PH5.19 (ECP Spec publish)
       │
       ├── PH5.17 (Oracle SDK)
       │
       └── PH5.1 (API Server)
              │
              ├── PH5.5 (MCP Bridge — expand to 8 tools + wire client)
              ├── PH5.6 (A2A Bridge — add verify endpoint)
              ├── PH5.2 (Terminal UI)
              └── PH5.3 (Web Dashboard)

Tier 2 — Multi-Instance:
  PH5.7 (ECP Network) → PH5.8 (Instance Coordinator) → PH5.9 (Knowledge Sharing)

Tier 3 — Cross-Language (independent):
  PH5.10 (Polyglot) → PH5.11 (Python) + PH5.12 (Go) + PH5.13 (Rust)
```

**Key change from original plan:** PH5.18 (ECP Transport) is inserted as Tier 1 prerequisite. The transport abstraction is the foundation that everything else builds on — it's what makes Vinyan a platform instead of a library.

> **OTel opportunity:** `src/observability/metrics.ts` exports in-memory statistics mappable to OTel semantic conventions (`gen_ai.verdict.confidence`, `gen_ai.verdict.epistemic_type`, etc.). Track as ecosystem strategy after ECP v1 stabilizes.

---

## §8 Design Decisions

| # | Decision | Choice | Rationale |
|:--|:---------|:-------|:----------|
| D1 | Wire format | JSON-RPC 2.0 extension | Compatible with MCP/A2A tooling. No new protocol to learn. |
| D2 | WebSocket sub-protocol | `ecp-v1` | Enables protocol version negotiation at transport level. |
| D3 | Default transport | stdio (backward compatible) | All 5 existing oracles + Python oracle continue working unchanged. |
| D4 | Trust degradation | Applied at transport layer | Downstream code sees a single `confidence` number — doesn't need to know transport. |
| D5 | Remote oracle registration | Push (engine → orchestrator) | Engine initiates connection, declares capabilities. Orchestrator doesn't need to discover engines. |
| D6 | MCP expansion | 4 → 8 tools | Cover the most common external integration patterns without overwhelming the tool list. |
| D7 | A2A verification | New `/a2a/verify` endpoint | Lightweight alternative to full task submission. Same trust degradation. |
| D8 | Batch verification | Deferred to ECP v2 | Keep v1 simple (one hypothesis per request). Batch adds complexity. |
| D9 | Confidence model | Scalar [0,1] in v1, belief/plausibility tuple in v2 | DS theory recommends `[Bel, Pl]` intervals but scalar is simpler for initial adoption. See §9.1. |
| D10 | Multi-oracle combination | Priority-based heuristic (v1); DS combination as v2 research | v1: 5-step deterministic resolution in `conflict-resolver.ts`. v2: Dempster's rule under investigation — see [ecp-v2-research.md §2](../research/ecp-v2-research.md#2-multi-oracle-aggregation-ds-combination). |
| D11 | LLM confidence policy | Explicit exclusion from governance | LLM self-confidence poorly calibrated (Kadavath 2022, Xiong 2024). Hard policy, not guideline. See [ecp-v2-research.md §3](../research/ecp-v2-research.md#3-llm-confidence-exclusion-policy). |
| D12 | Evidence integrity | Merkle-chained evidence in v2 | Certificate Transparency pattern for tamper-proof evidence chains. See [ecp-v2-research.md §4](../research/ecp-v2-research.md#4-merkle-chained-evidence). |

---

## §9 Research Directions (ECP v2)

> Full research content extracted to **[ecp-v2-research.md](../research/ecp-v2-research.md)**.
>
> Topics: (1) Belief intervals replacing scalar confidence, (2) Dempster-Shafer multi-oracle combination, (3) LLM confidence exclusion policy, (4) Merkle-chained evidence, (5) Confidence conflation resolution (two-field split).
>
> None are committed designs. v1 is complete for local oracle coordination.



