# Vinyan Protocol Architecture — ECP-Centric Design

> **Version:** 1.0-draft | **Date:** 2026-04-01
> **Context:** Rethink of Vinyan's external interface design. MCP/A2A become bridge layers; ECP becomes the native publishable protocol for the ENS ecosystem.
> **References:** [ecp-spec.md](../spec/ecp-spec.md), [oracle-sdk.md](../spec/oracle-sdk.md), [concept.md](../foundation/concept.md) §2

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

Same pattern as local oracles (`src/oracle/circuit-breaker.ts`), with additional network-aware triggers:

| Trigger | Local (stdio) | Remote (WebSocket) |
|:--------|:-------------|:-------------------|
| Process exit non-zero | ✅ | N/A |
| Timeout | ✅ | ✅ |
| Invalid JSON output | ✅ | ✅ |
| Connection lost | N/A | ✅ (counts as failure) |
| No heartbeat for 90s | N/A | ✅ (counts as failure) |

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
- Same confidence cap as A2A tasks: 0.5 (I13, `A2A_CONFIDENCE_CAP`)
- All A2A verification results: `type: "uncertain"`
- Uses `src/a2a/confidence-injector.ts` for consistent trust degradation

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

## §6 Trust Degradation Matrix

The complete trust model across all protocol layers:

| Source | Transport | Layer | Confidence Cap | Type Cap | Status | Code Reference |
|:-------|:----------|:------|---------------:|:---------|:-------|:----------|
| Local deterministic oracle | stdio | L1 | 1.0 | `known` | ✅ Implemented | `TIER_CAPS.deterministic` in `src/oracle/tier-clamp.ts` |
| Local heuristic oracle | stdio | L1 | 0.9 | `known` | ✅ Implemented | `TIER_CAPS.heuristic` in `src/oracle/tier-clamp.ts` |
| Local probabilistic oracle | stdio | L1 | 0.7 | `known` | ✅ Implemented | `TIER_CAPS.probabilistic` in `src/oracle/tier-clamp.ts` |
| Remote Vinyan oracle | WebSocket | L2 | 0.95 | `known` | ⚠️ Cap defined, transport not implemented | `TRANSPORT_CAPS.websocket` in `src/oracle/tier-clamp.ts` |
| Remote third-party oracle | WebSocket | L2 | `conf × 0.8` | `uncertain` | ❌ Design only | — |
| MCP tool (`local`) | stdio | L3 | 0.7 | `uncertain` | ✅ Implemented | `TRUST_CONFIDENCE.local` in `src/mcp/ecp-translation.ts` |
| MCP tool (`network`) | stdio | L3 | 0.5 | `uncertain` | ✅ Implemented | `TRUST_CONFIDENCE.network` in `src/mcp/ecp-translation.ts` |
| MCP tool (`remote`) | stdio | L3 | 0.3 | `uncertain` | ✅ Implemented | `TRUST_CONFIDENCE.remote` in `src/mcp/ecp-translation.ts` |
| A2A agent | HTTP | L3 | 0.5 | `uncertain` | ✅ Implemented | `A2A_CONFIDENCE_CAP` in `src/a2a/confidence-injector.ts` |

> **Label mapping:** The MCP bridge code uses `TrustLevel = "local" | "network" | "remote"` (in `ecp-translation.ts`), while the config schema uses `"trusted" | "semi-trusted" | "untrusted"` (in `Phase5MCPConfigSchema`). The mapping is: `trusted` → `local` (0.7), `semi-trusted` → `network` (0.5), `untrusted` → `remote` (0.3). These vocabularies should be unified in a future cleanup.

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
| D10 | Multi-oracle combination | Priority-based heuristic (v1); DS combination as v2 research | v1: 5-step deterministic resolution in `conflict-resolver.ts`. v2: Dempster's rule under investigation — see §9.2 for caveats. |
| D11 | LLM confidence policy | Explicit exclusion from governance | LLM self-confidence poorly calibrated (Kadavath 2022, Xiong 2024). Hard policy, not guideline. See §9.3. |
| D12 | Evidence integrity | Merkle-chained evidence in v2 | Certificate Transparency pattern for tamper-proof evidence chains. See §9.4. |

---

## §9 Research Directions (ECP v2)

> The following sections describe potential future enhancements. None are committed designs. Current v1 implementation is complete for local oracle coordination; these directions become relevant when ECP Network Transport (PH5.18) is implemented.

### 9.1 Confidence Model Evolution: Scalar → Belief Intervals

**Current (ECP v1):** `confidence: number` — a single scalar in [0, 1].

**Problem:** Scalar confidence conflates two distinct epistemic states:
- "50% confident" (strong evidence for both true and false)
- "No information" (no evidence at all)

Both map to `confidence: 0.5`, but they should produce different Orchestrator behavior.

**Solution (ECP v2):** Dempster-Shafer belief/plausibility intervals.

```typescript
// v1: scalar (current — maintained for backward compatibility)
confidence: 0.5

// v2: belief interval (additive, optional extension)
belief_interval?: {
  belief: number;       // Bel(H) — minimum confidence supported by evidence
  plausibility: number; // Pl(H) — maximum confidence if all unknowns resolve favorably
}
// Uncertainty gap = plausibility - belief
// Gap = 0 → full evidence (deterministic oracle)
// Gap = 1 → no evidence at all
// Gap > 0 → partial evidence → trigger deliberation or escalation
```

**Migration:** `belief_interval` is optional. Engines that don't provide it: `belief = confidence, plausibility = confidence` (zero uncertainty gap — backward compatible). The scalar `confidence` field is ALWAYS present for v1 consumers.

**Orchestrator behavior with belief intervals:**

| Scenario | Belief | Plausibility | Gap | Action |
|:---------|-------:|-------------:|----:|:-------|
| Deterministic (compiler) | 1.0 | 1.0 | 0.0 | Accept immediately |
| Strong heuristic | 0.85 | 0.90 | 0.05 | Accept with high confidence |
| Partial evidence | 0.3 | 0.8 | 0.5 | Escalate — high uncertainty gap |
| No information | 0.0 | 1.0 | 1.0 | Route to different engine |
| Conflicting evidence | 0.4 | 0.6 | 0.2 | Contradiction resolution |

**Axiom alignment:** A2 (First-Class Uncertainty) — belief intervals make uncertainty *measurable*, not just categorical.

### 9.2 Multi-Oracle Aggregation: Current Heuristic and Future Directions

> **v2 Research Direction** — The current heuristic works well for Vinyan's oracle set. DS combination is one possible future improvement, not a committed design.

**Current (v1, implemented):** `src/gate/conflict-resolver.ts` uses a 5-step deterministic algorithm: (1) domain separation — cross-domain conflicts are both valid, (2) tier priority — deterministic > heuristic > probabilistic (A5), (3) evidence count — more evidence items wins, (4) historical accuracy — oracle with better track record wins, (5) escalation — set `hasContradiction: true` on aggregate result, apply conservative default (failure wins). This priority heuristic is simple, auditable, and sufficient for the current oracle set (5 built-in oracles with clear tier separation).

**Possible v2 improvement:** When 3+ oracles with overlapping domains produce verdicts, a more formal combination rule could strengthen or weaken combined confidence. Dempster's rule of combination is one candidate, with known limitations:

```
// Dempster's rule for two independent mass functions m1, m2:
// Combined mass: m12(A) = Σ{B∩C=A} m1(B)·m2(C) / (1 - K)
// where K = Σ{B∩C=∅} m1(B)·m2(C) is the conflict factor
//
// For ECP: each oracle verdict maps to a mass function over
// the frame {verified, ¬verified, Θ} where Θ = uncertainty.
// The exact mass assignment from scalar confidence requires
// a mapping function — see Shafer (1976) for the rigorous formulation.
```

> **Note:** The implementation should convert each oracle's `confidence` and `type` into a proper mass function before applying Dempster's rule. A naive product of scalar confidences is NOT equivalent to DS combination. This is a **target design for ECP v2** — the current `conflict-resolver.ts` uses priority-based resolution (domain → tier → evidence count → historical accuracy → escalation).

**Practical implementation in Vinyan:**

```typescript
interface DempsterCombination {
  /** Combine verdicts from independent oracles using DS rule */
  combine(verdicts: OracleVerdict[]): {
    combined_confidence: number;
    conflict_factor: number;    // K — high K means oracles disagree
    contributing_engines: string[];
  };
}

// Integration point: src/gate/conflict-resolver.ts
// DS combination runs AFTER tier-based filtering:
//   1. Group verdicts by tier (deterministic > heuristic > probabilistic)
//   2. Within each tier, apply Dempster's combination
//   3. Higher-tier combined result overrides lower-tier
//   4. If conflict_factor > 0.7 → flag as "contradictory"
```

**When NOT to use DS combination:**
- When verdicts are from the same underlying data source (not independent)
- When one oracle explicitly subsumes another (e.g., type-check includes lint-clean)
- When an oracle returns `type: "unknown"` (excluded from combination, not treated as evidence)

**Axiom alignment:** A3 (Deterministic Governance) — Dempster's rule is a deterministic mathematical function, no LLM needed. A5 (Tiered Trust) — tier ranking still applies as pre-filter.

**Open questions before adopting DS combination:**
- Does the current oracle set actually produce enough same-tier overlap to benefit from formal combination?
- Converting scalar confidence to mass functions requires arbitrary mapping choices — is that more principled than the current heuristic?
- The 5-step algorithm is fully auditable; DS combination produces a single number that is harder to explain.
- DS assumes independent sources, but AST and type oracles both read the same file.

### 9.3 LLM Confidence Exclusion Policy

**Research finding:** LLM self-reported confidence has poor calibration. Studies on LLM calibration (e.g., Kadavath et al. 2022 "Language Models (Mostly) Know What They Know"; Xiong et al. 2024 "Can LLMs Express Their Uncertainty?") report high Expected Calibration Error (ECE), indicating that when an LLM expresses high confidence, actual accuracy can be significantly lower.

**Policy (non-negotiable, A3 compliance):**

```
RULE: LLM-generated confidence values MUST NOT enter the governance path.

Specifically:
1. If an oracle wraps an LLM (e.g., LLM-as-critic in src/orchestrator/core-loop.ts):
   - The oracle MUST set confidence based on evidence structure, NOT LLM self-report
   - confidence = f(evidence_count, evidence_specificity, tool_confirmation)
   - LLM's self-reported confidence may be logged for calibration research (A7) but never used for routing

2. If an MCP tool returns LLM-generated text with embedded confidence claims:
   - Ignore all embedded confidence claims
   - Apply trust-tier confidence cap (probabilistic: 0.7, via bridge: 0.5)

3. Governance decisions (routing level, verdict acceptance, fact promotion):
   - ONLY use confidence derived from structured evidence + tier caps
   - The SelfModel's prediction confidence (EMA-based) is valid because it's
     calibrated against actual outcomes (A7), not LLM self-report
```

**Implementation touchpoints:**

| File | Current Behavior | Required Change |
|:-----|:----------------|:---------------|
| `src/orchestrator/core-loop.ts` | LLM-as-critic verdict | Ensure confidence set by evidence structure, not LLM output |
| `src/mcp/ecp-translation.ts` | Already caps at trust level | Add explicit `llm_confidence_excluded: true` annotation |
| `src/gate/quality-score.ts` | Quality dimensions | Document that quality scores derived from evidence, not LLM claims |

**Axiom alignment:** A1 (Epistemic Separation) — LLM generates, different system evaluates. A3 (Deterministic Governance) — governance confidence comes from evidence structure. A5 (Tiered Trust) — LLM is probabilistic tier, capped accordingly.

### 9.4 Merkle-Chained Evidence (ECP v2)

**Current:** `evidence[]` is a flat array. No way to verify that evidence hasn't been tampered with or that the chain is complete.

**Proposed (v2):** Each evidence item includes a hash of the previous item, forming a Merkle chain (Certificate Transparency pattern).

```typescript
interface MerkleEvidence extends Evidence {
  /** SHA-256 of the previous evidence item in the chain. Null for first item. */
  prev_hash: string | null;
  /** SHA-256 of this evidence item (file + line + snippet + contentHash + prev_hash). */
  self_hash: string;
}
```

**Use cases:**
- Cross-instance fact sharing (future Phase 5): verify evidence chain integrity across network
- Audit trail: prove that a fact was derived from specific evidence at a specific time
- Tamper detection: any modification breaks the hash chain

**Deferred to v2** because current local-only deployment doesn't need tamper-proofing. Becomes critical when ECP Network (PH5.18) enables cross-instance communication.

> **Threat model note:** Merkle evidence addresses integrity, not correctness. A compromised remote instance can generate valid Merkle chains of wrong evidence. A formal threat model should precede this design when ECP Network Transport is implemented.




