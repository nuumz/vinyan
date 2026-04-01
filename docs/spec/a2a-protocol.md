# ECP-over-A2A Protocol Specification

> **Version:** 2.0 | **Phase:** 5 | **Audience:** AI Agent (Copilot/Claude)
>
> **This document owns:** Inter-instance and external agent communication protocol.
> **Cross-reference:** [concept.md](../foundation/concept.md) §2.4 (Network ECP), §11 (Multi-Instance Coordination), [decisions.md](../architecture/decisions.md) Decision 17, [tdd.md](tdd.md) §20-§23.
>
> **Implementation status:** Phases A-L implemented. Trust lifecycle, peer discovery, knowledge sharing (Tier 0 + Tier 2), streaming schemas, peer health monitoring, and remote bus adapter are all functional. Configuration schema covers all v1.0 features.

---

## 1. Overview

Vinyan instances communicate using **Google A2A v1.0 as transport** with **ECP (Epistemic Communication Protocol) as the semantic layer**. ECP data rides inside A2A `data` parts with MIME type `application/vnd.vinyan.ecp+json`.

This replaces the previously-specified VIIP protocol. A2A provides standard transport plumbing (HTTP, JSON-RPC, task lifecycle, Agent Cards). ECP provides epistemic semantics (confidence, evidence chains, uncertainty, falsifiability) that A2A alone cannot express.

**Design principles:**
- **ECP-native semantics:** Every message carries epistemic metadata — not bolted on as transport headers
- **Advisory coordination:** No remote message overrides local governance (A3). Remote knowledge enters probation (I14)
- **Fail-open to single-instance:** Network failure degrades capability, never blocks tasks
- **Empirical trust (A5):** Trust is earned through statistically significant accuracy, not declared

---

## 2. Wire Protocol

### 2.1 Transport

**Primary:** HTTP POST with JSON-RPC 2.0 (Google A2A v1.0 spec)
**Streaming:** Server-Sent Events for progress updates and partial verdicts

Endpoint: `http://<host>:<port>/` (default port 3928)

### 2.2 A2A JSON-RPC Envelope

All messages use the standard A2A JSON-RPC format:

```typescript
interface A2AJsonRpcRequest {
  jsonrpc: "2.0";
  id: string | number;
  method: "tasks/send" | "tasks/get" | "tasks/cancel";
  params: Record<string, unknown>;
}
```

### 2.3 ECP Data Part

ECP semantics are carried inside A2A `data` parts:

```typescript
// A2A part wrapping
{
  type: "data",
  mimeType: "application/vnd.vinyan.ecp+json",
  data: ECPDataPart
}

// ECP data part schema (src/a2a/ecp-data-part.ts)
interface ECPDataPart {
  ecp_version: 1;
  message_type: ECPMessageType;        // 22 message types — see §3
  epistemic_type: "known" | "unknown" | "uncertain" | "contradictory";
  confidence: number;                   // 0.0–1.0
  confidence_reported: boolean;         // distinguishes absent vs zero confidence (A2)
  evidence?: Evidence[];
  falsifiable_by?: string;              // content-addressed invalidation (A4)
  temporal_context?: { valid_from: number; ttl_ms: number };
  conversation_id?: string;            // multi-turn task correlation
  trace_context?: TraceContext;         // W3C-compatible distributed tracing
  cost?: CostSignal;                   // computational cost (AI-unique)
  payload: unknown;                    // message-type-specific data
  signer?: { instance_id: string; public_key: string };
  signature?: string;                  // Ed25519 over canonical JSON
}
```

### 2.4 Agent Card Discovery

Vinyan instances are discovered via `/.well-known/agent.json` (A2A standard). Vinyan peers are identified by the `x-vinyan-ecp` extension:

```typescript
// Agent Card extension (src/a2a/types.ts)
"x-vinyan-ecp": {
  protocol: "vinyan-ecp",
  ecp_version: 1,
  instance_id: string,
  public_key: string,
  capability_version: number,          // monotonic — for staleness detection
  oracle_capabilities: Array<{
    name: string;
    tier: "deterministic" | "heuristic" | "probabilistic" | "speculative";
    languages: string[];
    accuracy?: number;
    latency_ms?: number;
  }>,
  features: string[],                  // e.g., ["knowledge_sharing", "feedback_loop", "file_invalidation"]
  calibration?: {
    brier_score?: number;
    sample_size?: number;
    bias_direction?: "overconfident" | "underconfident" | "calibrated";
  }
}
```

---

## 3. Message Types (22)

All message types are defined in the `ECPMessageType` enum (`src/a2a/ecp-data-part.ts`):

### 3.1 Core Primitives (7 — implemented)

| Type | Direction | Purpose |
|:-----|:----------|:--------|
| `assert` | Sender → Receiver | Declare a verified fact with evidence |
| `query` | Sender → Receiver | Request verification of a hypothesis |
| `respond` | Receiver → Sender | Return oracle verdict with confidence |
| `request` | Sender → Receiver | Request a specific action or resource |
| `delegate` | Sender → Receiver | Delegate a task to a peer |
| `cancel` | Either → Either | Cancel an in-flight task or query |
| `subscribe` | Sender → Receiver | Subscribe to a category of events |

### 3.2 Negotiation Primitives (4 — v1.1)

| Type | Direction | Purpose |
|:-----|:----------|:--------|
| `propose` | Sender → Receiver | Propose terms for task split, knowledge exchange, etc. |
| `affirm` | Receiver → Sender | Accept a proposal, creating mutual commitments |
| `commit` | Either → Either | Declare a binding commitment with deadline |
| `retract` | Either → Either | Retract a previously shared verdict, rule, or knowledge item |

### 3.3 Knowledge Sharing (3 — implemented)

| Type | Direction | Purpose |
|:-----|:----------|:--------|
| `knowledge_offer` | Sender → Receiver | Announce available patterns/rules after Sleep Cycle |
| `knowledge_accept` | Receiver → Sender | Accept specific items from offer |
| `knowledge_transfer` | Sender → Receiver | Send patterns with full data; also used for file invalidation relay |

### 3.4 Coordination (3 — partial)

| Type | Direction | Purpose |
|:-----|:----------|:--------|
| `feedback` | Either → Either | Structured accuracy feedback on shared knowledge (v1.1) |
| `intent_declare` | Sender → All | Declare intent to modify files (v1.1) |
| `intent_release` | Sender → All | Release a previously declared intent (v1.1) |

### 3.5 Meta (3 — implemented)

| Type | Direction | Purpose |
|:-----|:----------|:--------|
| `capability_update` | Sender → All | Announce oracle additions/removals (v1.1) |
| `trust_attestation` | Sender → Receiver | Share empirical trust data about a third peer (v2.0) |
| `heartbeat` | Either → Either | Periodic health check with timestamp |

### 3.6 Streaming (2 — implemented)

| Type | Direction | Purpose |
|:-----|:----------|:--------|
| `progress` | Worker → Requester | Phase progress update (0-100%) |
| `partial_verdict` | Worker → Requester | Individual oracle result before aggregation |

---

## 4. Trust Lifecycle

### 4.1 Unified Trust Vocabulary

All trust operations use a single canonical vocabulary (`src/oracle/tier-clamp.ts`):

| Level | Confidence Cap | Meaning |
|:------|:--------------|:--------|
| `untrusted` | 0.25 | New peer, no empirical data |
| `provisional` | 0.40 | Some accurate verdicts observed |
| `established` | 0.50 | Statistically significant accuracy |
| `trusted` | 0.60 | High accuracy over extended period |

### 4.2 Confidence Clamping Pipeline

All remote verdicts pass through `clampFull()` — three independent ceilings:

```
clampFull(confidence, tier, transport, peerTrust)
  = min(clampByTier(confidence, tier),
        clampByTransport(confidence, transport),
        clampByPeerTrust(confidence, peerTrust))
```

- **Tier ceiling:** deterministic=0.95, heuristic=0.80, probabilistic=0.70, speculative=0.50
- **Transport ceiling:** stdio=1.0, websocket=0.80, http=0.70, a2a=0.50
- **Peer trust ceiling:** untrusted=0.25, provisional=0.40, established=0.50, trusted=0.60

### 4.3 Trust Progression (Wilson Lower Bound)

Trust is promoted based on statistically significant accuracy (`src/a2a/peer-trust.ts`):

```
Promotion thresholds (configurable in phase5.trust):
  untrusted → provisional:  Wilson LB >= 0.60, min 10 interactions
  provisional → established: Wilson LB >= 0.70
  established → trusted:    Wilson LB >= 0.80

Demotion triggers:
  5 consecutive inaccurate verdicts → demote one level
  7 days inactivity → demote one level (skips untrusted)
```

### 4.4 Authorization Scoping

| Action | Minimum Trust |
|:-------|:-------------|
| Receive event forwards | `untrusted` |
| Receive file invalidations | `untrusted` |
| Send oracle requests | `provisional` |
| Delegate tasks | `provisional` |
| Share knowledge (offer/transfer) | `established` |
| Trust attestation sharing | `trusted` |

---

## 5. Knowledge Sharing

### 5.1 Tier 0 — Real-Time File Hash Invalidation

When a file changes locally, `FileWatcher` emits `file:hashChanged`. The `FileInvalidationRelay` (`src/a2a/file-invalidation-relay.ts`) forwards this to all peers as an ECP `knowledge_transfer` data part:

```typescript
// payload
{
  type: "file_invalidation",
  filePath: string,
  newHash: string,          // SHA-256 or "DELETED"
  instance_id: string,
  timestamp: number,
}
```

- **Delivery:** Fire-and-forget HTTP POST (best-effort)
- **Receiving side:** Calls `worldGraph.updateFileHash()` → cascade invalidation via falsifiable conditions (A4)

### 5.2 Tier 2 — Sleep Cycle Batch Exchange

After `sleep:cycleComplete`, the `KnowledgeExchangeManager` (`src/a2a/knowledge-exchange.ts`) initiates a 3-phase protocol:

1. **Offer:** Create `KnowledgeOffer` from extracted patterns using `abstractPattern()` from `src/evolution/pattern-abstraction.ts`. Classify portability (universal/framework-specific/project-specific).

2. **Accept:** Peer evaluates offer using Jaccard similarity on framework + language markers. Rejects project-specific patterns and those below similarity threshold (default 0.5).

3. **Transfer:** Send `AbstractPattern[]`. Peer imports via `importAbstractPattern()` with **50% confidence reduction** (probation). Emits `a2a:knowledgeImported` bus event.

### 5.3 Remote Bus Adapter

The `RemoteBusAdapter` (`src/a2a/remote-bus.ts`) subscribes to configured bus events and forwards them to all peers:

**Default forwarded:** `sleep:cycleComplete`, `evolution:rulePromoted`, `evolution:ruleRetired`, `skill:outcome`, `file:hashChanged`

**Never forwarded:** `worker:dispatch`, `trace:record`, `task:start`, `task:complete`

---

## 6. Streaming

### 6.1 Progress Updates

```typescript
// ECPProgressUpdate (src/a2a/streaming.ts)
{
  ecp_version: 1,
  message_type: "progress",
  task_id: string,
  phase: "routing" | "oracle_dispatch" | "oracle_execution" | "aggregation" | "commit",
  progress_pct: number,          // 0–100
  oracle_name?: string,
  estimated_remaining_ms?: number,
  timestamp: number,
}
```

### 6.2 Partial Verdicts

```typescript
// ECPPartialVerdict (src/a2a/streaming.ts)
{
  ecp_version: 1,
  message_type: "partial_verdict",
  task_id: string,
  oracle_name: string,
  verified: boolean,
  confidence: number,
  oracles_completed?: number,
  oracles_total?: number,
  is_final: boolean,
  timestamp: number,
}
```

### 6.3 Backpressure

The `A2AStreamingChannel` implements 2-tier backpressure:
- **Normal:** Send everything
- **Backpressure (controller.desiredSize <= 0):** Drop progress updates, keep partial verdicts

---

## 7. Peer Health & Partition Tolerance

### 7.1 Heartbeat Monitor

`PeerHealthMonitor` (`src/a2a/peer-health.ts`) sends periodic heartbeat via A2A `tasks/send` with ECP `heartbeat` data part.

**State machine:**
```
connected ──(1 miss)──→ degraded ──(3 misses)──→ partitioned
    ↑                       │                        │
    └───── (success) ───────┘────── (success) ───────┘
```

**Configuration (phase5.instances):**
- `heartbeat_interval_ms`: 15,000 (default)
- `heartbeat_timeout_ms`: 45,000 (default)

### 7.2 Partition Behavior

- **During partition:** Each instance operates independently. Local Orchestrator continues with local oracles only. No shared state writes.
- **On partition heal:** Heartbeat recovery → `peer:connected` bus event → knowledge exchange resumes with probation.
- **CAP position:** AP (Availability + Partition tolerance). No governance action depends on remote state (A3).

---

## 8. Configuration

### 8.1 Instance Configuration (`phase5.instances`)

```yaml
instances:
  enabled: false
  listen_port: 3928
  heartbeat_interval_ms: 15000
  heartbeat_timeout_ms: 45000
  peers:
    - url: "http://instance-b:3928"
      trust_level: "untrusted"        # untrusted | provisional | established | trusted
```

### 8.2 A2A Protocol (`phase5.a2a`)

```yaml
a2a:
  enabled: false
  confidence_cap: 0.5                 # max confidence for A2A verdicts
  streaming_enabled: false
  allowed_methods:                    # A2A JSON-RPC methods to accept
    - "tasks/send"
    - "tasks/get"
    - "tasks/cancel"
```

### 8.3 Knowledge Sharing (`phase5.knowledge_sharing`)

```yaml
knowledge_sharing:
  enabled: false
  file_invalidation_enabled: true     # Tier 0: real-time hash relay
  batch_on_sleep_cycle: true          # Tier 2: batch exchange
  max_probation_queue: 100
```

### 8.4 Trust (`phase5.trust`)

```yaml
trust:
  promotion_untrusted_lb: 0.60       # Wilson LB threshold
  promotion_provisional_lb: 0.70
  promotion_established_lb: 0.80
  promotion_min_interactions: 10
  demotion_on_consecutive_failures: 5
  inactivity_decay_days: 7
```

### 8.5 Coordination (`phase5.coordination`)

```yaml
coordination:
  intent_declaration_enabled: false   # v1.1
  negotiation_enabled: false          # v1.1
  commitment_tracking_enabled: false  # v1.1
```

### 8.6 Distributed Tracing (`phase5.tracing`)

```yaml
tracing:
  distributed_enabled: false          # v1.1
  w3c_trace_context: true
  sample_rate: 0.1
```

---

## 9. Performance Budget

| Operation | Target Latency | Notes |
|:----------|:---------------|:------|
| Agent Card fetch | < 5s | `fetchAgentCard()` with configurable timeout |
| Oracle request → verdict | < 5s | Remote oracle execution + network RTT |
| Task delegation → result | < 60s | Configurable per-task timeout |
| File invalidation relay | < 1s | Fire-and-forget, Tier 0 best-effort |
| Knowledge transfer | < 10s | Batch of up to 100 items |
| Heartbeat interval | 15s | Configurable |
| Event forward latency | < 3s | Fire-and-forget via RemoteBusAdapter |

---

## 10. Implementation Map

| Component | Source File | Status |
|:----------|:-----------|:-------|
| ECP data part schema | `src/a2a/ecp-data-part.ts` | v1.0 |
| ECP ↔ A2A translation | `src/a2a/ecp-a2a-translation.ts` | v1.0 |
| Transport interface | `src/a2a/transport.ts` | v1.0 |
| StdioTransport | `src/a2a/stdio-transport.ts` | v1.0 |
| A2ATransport | `src/a2a/a2a-transport.ts` | v1.0 |
| A2A Bridge | `src/a2a/bridge.ts` | v1.0 |
| Confidence clamping | `src/oracle/tier-clamp.ts` | v1.0 |
| Agent Card generator | `src/a2a/agent-card.ts` | v1.0 |
| Peer discovery | `src/a2a/peer-discovery.ts` | v1.0 |
| Peer trust lifecycle | `src/a2a/peer-trust.ts` | v1.0 |
| File invalidation relay | `src/a2a/file-invalidation-relay.ts` | v1.0 |
| Knowledge exchange | `src/a2a/knowledge-exchange.ts` | v1.0 |
| Streaming schemas | `src/a2a/streaming.ts` | v1.0 |
| Peer health monitor | `src/a2a/peer-health.ts` | v1.0 |
| Remote bus adapter | `src/a2a/remote-bus.ts` | v1.0 |
| Config schema | `src/config/schema.ts` | v1.0 |
| Negotiation (PROPOSE/AFFIRM) | `src/a2a/negotiation.ts` | v1.1 planned |
| Commitment tracking (COMMIT) | `src/a2a/commitment.ts` | v1.1 planned |
| Retraction (RETRACT) | `src/a2a/retraction.ts` | v1.1 planned |
| Knowledge feedback | `src/a2a/feedback.ts` | v1.1 planned |
| Intent declaration | `src/a2a/intent.ts` | v1.1 planned |
| Distributed tracing | `src/a2a/trace-context.ts` | v1.1 planned |
| Trust attestation | `src/a2a/trust-attestation.ts` | v2.0 planned |
| Gossip propagation | `src/a2a/gossip.ts` | v2.0 planned |
