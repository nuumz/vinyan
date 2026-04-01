# Vinyan A2A Protocol Specification

> **Version:** 1.0 | **Phase:** 5 | **Audience:** AI Agent (Copilot/Claude)
>
> **This document owns:** Inter-instance communication protocol for Vinyan multi-instance coordination.
> **Cross-reference:** [concept.md](../foundation/concept.md) §2.4 (Network ECP), §11 (Multi-Instance Coordination), [decisions.md](../architecture/decisions.md) Decision 17, [tdd.md](tdd.md) §20–§23.
>
> **Implementation status:** This document specifies the VIIP protocol design for Phase 5. Currently, only instance identity signing (`src/security/instance-identity.ts`) and configuration schema stubs (`src/config/schema.ts` — `Phase5InstancesConfigSchema`) are implemented. All message types (`VIIPEnvelope`, `VIIPMessageType`), WebSocket transport, handshake/heartbeat handlers, task delegation, oracle verification, and knowledge sharing are **specification-only** — no runtime implementation exists in the codebase.

---

## 1. Overview

Vinyan instances coordinate via the **Vinyan Inter-Instance Protocol (VIIP)** — ECP semantics over a network transport. This document specifies the wire format, message types, discovery, authentication, failure modes, and partition tolerance behavior.

**Design principles:**
- **ECP-native:** Every message carries epistemic semantics (confidence, evidence chains, uncertainty) — not bolted on as metadata
- **Advisory coordination:** No message can override local governance (A3). Remote knowledge enters probation (I14)
- **Fail-open to single-instance:** Network failure degrades capability, never blocks tasks
- **Idempotent:** Every message has a unique ID for deduplication

---

## 2. Wire Protocol

### 2.1 Transport

**Primary:** WebSocket (persistent, bidirectional, supports streaming)
**Fallback:** HTTP/2 with Server-Sent Events (for environments blocking WebSocket)

Connection URL: `ws://<host>:<port>/vinyan/ecp` or `wss://` for TLS.

### 2.2 Message Envelope

All messages share a common envelope:

```typescript
interface VIIPEnvelope {
  // Header
  viip_version: 1;                   // protocol version, negotiated during handshake
  message_id: string;                // UUIDv7 — idempotency key + temporal ordering
  message_type: VIIPMessageType;     // see §3
  source_instance_id: string;        // sender UUID
  target_instance_id?: string;       // null = broadcast to all peers
  timestamp: number;                 // sender wall-clock, ms since epoch
  ttl_ms: number;                    // message lifetime (default: 30_000)
  correlation_id?: string;           // links request → response pairs (see §2.4 propagation rules)

  // Payload
  payload: Record<string, unknown>;  // type-specific, see §3

  // Authentication
  signature: string;                 // Ed25519 signature over `message_id + timestamp + JSON(payload)`
}

type VIIPMessageType =
  // Lifecycle
  | "handshake"
  | "handshake_ack"
  | "heartbeat"
  | "disconnect"
  // Task delegation
  | "task_delegate"
  | "task_result"
  | "task_cancel"
  // Oracle verification
  | "oracle_request"
  | "oracle_verdict"
  // Knowledge sharing
  | "knowledge_offer"
  | "knowledge_accept"
  | "knowledge_transfer"
  // Events
  | "event_forward";
```

### 2.3 Handshake

On WebSocket connect, initiator sends `handshake`:

```typescript
// handshake payload
{
  instance_descriptor: InstanceDescriptor;  // from concept §11.2
  supported_versions: [1];
  requested_subscriptions: string[];        // event types to receive
}

// handshake_ack payload
{
  instance_descriptor: InstanceDescriptor;
  negotiated_version: 1;
  accepted_subscriptions: string[];
}
```

Handshake must complete within 5 seconds. On timeout → close connection, retry with backoff.

### 2.4 correlationId Propagation Rules

The `correlation_id` field enables distributed tracing across instances (see also [tdd.md](tdd.md) §23.5).

**Rules:**

1. **Task delegation chain:** `task_delegate` MUST set `correlation_id`. The receiving instance MUST echo the same `correlation_id` in the corresponding `task_result` or `task_cancel` response. If the receiver sub-delegates to a third instance, it MUST propagate the same `correlation_id`.

2. **Oracle verification:** `oracle_request` MUST include `correlation_id` from the originating task. `oracle_verdict` MUST echo it.

3. **Knowledge sharing:** `knowledge_offer`, `knowledge_accept`, and `knowledge_transfer` do NOT require `correlation_id` (knowledge transfer is not task-scoped).

4. **Event forwarding:** `event_forward` MAY include `correlation_id` if the event originated from a correlated task. Otherwise omit.

5. **Origin:** The instance that first creates a task generates a UUIDv7 `correlation_id`. All downstream messages for that task propagate it unchanged.

6. **Missing correlationId:** If a `task_delegate` arrives without `correlation_id`, the receiver generates one locally and uses it for all downstream traces. This ensures traceability even with older protocol versions.

---

## 3. Message Types

### 3.1 Task Delegation

**`task_delegate`** — Request peer to process a task:
```typescript
{
  task_input: TaskInput;                  // standard Vinyan TaskInput
  perception: PerceptualHierarchy;        // pre-computed context
  fingerprint: TaskFingerprint;           // for capability matching
  delegation_reason: string;              // "missing_oracle:python" | "capacity" | "domain_specialization"
  timeout_ms: number;                     // max wait (default: 60_000)
}
```

**`task_result`** — Return delegated task result:
```typescript
{
  task_id: string;
  result: TaskResult;                     // standard TaskResult, confidence already capped
  execution_trace: ExecutionTrace;        // for learning (A7)
}
```

**`task_cancel`** — Cancel in-flight delegation:
```typescript
{
  task_id: string;
  reason: string;
}
```

### 3.2 Oracle Verification

**`oracle_request`** — Request remote oracle verification:
```typescript
{
  hypothesis: HypothesisTuple;
  oracle_types: string[];                 // requested oracle types
  routing_level: number;                  // determines which oracles to invoke
}
```

**`oracle_verdict`** — Return verification result:
```typescript
{
  hypothesis_target: string;
  verdicts: Record<string, OracleVerdict>;  // confidence pre-capped at 0.95 per TDD §23.4 (tier clamping implemented in tier-clamp.ts; A2A bridge applies separate A2A_CONFIDENCE_CAP = 0.5)
}
```

### 3.3 Knowledge Sharing

Knowledge sharing follows a 3-phase protocol (offer → accept → transfer) to avoid sending unwanted data:

**`knowledge_offer`** — Announce available knowledge:
```typescript
{
  available: Array<{
    type: "rule" | "skill" | "pattern" | "selfmodel_params" | "worker_profile";
    id: string;
    summary: string;                       // human-readable description
    effectiveness: number;                 // source instance metric
    created_at: number;
  }>;
}
```

**`knowledge_accept`** — Request specific items:
```typescript
{
  accepted_ids: string[];
}
```

**`knowledge_transfer`** — Send accepted knowledge:
```typescript
{
  items: Array<{
    type: string;
    id: string;
    data: AbstractPatternExport;           // Phase 4 serialization format
    provenance: {
      source_instance_id: string;
      original_id: string;
      source_status: string;               // status on source instance
      export_timestamp: number;
    };
  }>;
}
```

All transferred knowledge enters the receiving instance at `status: 'probation'` (I14).

### 3.4 Event Forwarding

Subset of bus events forwarded to peers (configurable):

```typescript
{
  event_name: string;                      // e.g., "sleep:cycleComplete"
  event_payload: unknown;
  original_timestamp: number;
}
```

**Default forwarded events:** `sleep:cycleComplete`, `evolution:rulePromoted`, `evolution:ruleRetired`, `skill:outcome`, `fleet:convergence_warning`.

**Never forwarded:** `worker:dispatch`, `trace:record`, `task:start`, `task:complete` (too noisy, contains potentially sensitive task content).

---

## 4. Authentication & Security

### 4.1 Instance Identity

Each instance generates an Ed25519 keypair on first run, stored in `~/.vinyan/instance-key.json` (JSON format, not PEM — see `src/security/instance-identity.ts`). The public key is published in `InstanceDescriptor.public_key`.

### 4.2 Message Authentication

Every `VIIPEnvelope.signature` is an Ed25519 signature over `message_id + timestamp + canonical_json(payload)`. Receiver verifies signature against the sender's registered public key. Messages with invalid signatures are dropped silently (no error response — prevents oracle attacks).

### 4.3 Transport Security

- **Local network:** Optional TLS (configurable)
- **Public network:** TLS mandatory (wss://), mTLS recommended
- **Trust bootstrapping:** New remote instances start at `trust_level: 'untrusted'`. Trust upgrades based on empirical accuracy (Wilson LB on remote verdict accuracy, same mechanism as `WorkerLifecycle`)

### 4.4 Authorization Scoping

| Action | Required Trust Level |
|:-------|:--------------------|
| Receive event forwards | `untrusted` |
| Send oracle requests | `semi-trusted` |
| Delegate tasks | `semi-trusted` |
| Share knowledge | `trusted` |
| Modify configuration | Not allowed (local-only) |

---

## 5. Failure Modes & Recovery

### 5.1 Connection Failure

| Failure | Detection | Recovery |
|:--------|:----------|:---------|
| Peer unreachable | WebSocket connect timeout (5s) | Exponential backoff: 1s → 2s → 4s → 8s → 30s max. Circuit breaker after 3 consecutive failures |
| Message delivery failure | No ack within TTL | Retry up to 3 times with exponential backoff. On final failure: log + continue without remote result |
| Peer crash (mid-task) | Heartbeat timeout (15s interval, 45s deadline) | Cancel in-flight delegations. Re-process locally or escalate |
| Message corruption | Signature verification failure | Drop message. Increment corruption counter. 10+ corruptions → close + reconnect |

### 5.2 Partition Tolerance

See concept.md §11.5 for the full partition tolerance design. Summary:

- **During partition:** Each instance operates independently. Local Orchestrator continues with local oracles only. No shared state writes.
- **On partition heal:** Exchange Sleep Cycle summaries. Knowledge sharing resumes with probation.
- **CAP position:** AP (Availability + Partition tolerance). No governance action depends on remote state.

### 5.3 Version Mismatch

If `handshake.supported_versions` has no intersection with local supported versions → reject connection with error code `VERSION_MISMATCH`. Instances must upgrade before reconnecting.

---

## 6. Deduplication & Ordering

### 6.1 Deduplication Window

Receivers maintain a bounded set of recently seen `message_id` values:
- Window size: 10,000 entries (FIFO eviction)
- Memory cost: ~640KB (64-byte UUIDs)
- Duplicate messages: acknowledged but not re-processed

### 6.2 Ordering Guarantees

- **Per-source causal ordering:** Messages from the same instance are processed in `message_id` order (UUIDv7 is time-sortable)
- **Cross-instance:** No global ordering. This is acceptable because:
  - Knowledge sharing is idempotent (enter probation regardless of order)
  - Task delegation is request-response (correlation_id links pairs)
  - Event forwarding is informational (no state mutation)

---

## 7. Performance Budget

| Operation | Target Latency | Notes |
|:----------|:---------------|:------|
| Handshake | < 1s | Including TLS negotiation |
| Oracle request → verdict | < 5s | Remote oracle execution + network RTT |
| Task delegation → result | < 60s | Configurable per-task timeout |
| Knowledge transfer | < 10s | Batch of up to 100 items |
| Heartbeat interval | 15s | Configurable |
| Event forward latency | < 500ms | Best-effort, non-blocking |

---

## 8. Configuration

### Implemented fields (`Phase5InstancesConfigSchema` in `src/config/schema.ts`)

```yaml
# vinyan.json → phase5.instances — these fields exist in the schema today
instances:
  enabled: false                     # default: single-instance mode
  listen_port: 3928                  # VIIP WebSocket port
  heartbeat_interval_ms: 15000
  heartbeat_timeout_ms: 45000
  peers:
    - url: "wss://instance-b:3928/vinyan/ecp"
      trust_level: "untrusted"       # untrusted | semi-trusted | trusted
```

### Planned fields (specification-only — not yet in schema)

```yaml
# These fields are part of the VIIP specification but do NOT exist in
# Phase5InstancesConfigSchema yet. They will be added when VIIP runtime
# implementation begins.
instances:
  instance_id: ""                    # auto-generated UUIDv4 on first run
  discovery:
    mode: "static"                   # static | descriptor_poll
    poll_interval_ms: 60000          # for descriptor_poll mode
  knowledge_sharing:
    enabled: false
    export_on_sleep_cycle: true
    max_probation_queue: 100         # cap incoming probation items
  delegation:
    enabled: false
    timeout_ms: 60000
    max_concurrent: 5
```

---

## 9. Relationship to External A2A

Vinyan's inter-instance protocol (VIIP) is distinct from the external A2A protocol bridge (implementation-plan PH5.6):

| Aspect | VIIP (Inter-Instance) | A2A Bridge (External) |
|:-------|:---------------------|:---------------------|
| Purpose | Vinyan ↔ Vinyan coordination | Vinyan ↔ third-party agents |
| Protocol | ECP-native (§2.4) | Google A2A spec (JSON-RPC) |
| Trust | Instance identity + empirical | Probabilistic ceiling (0.5) |
| Semantics | Full epistemic (confidence, evidence, falsifiability) | Mapped to/from A2A artifacts |
| Knowledge sharing | Bidirectional with provenance | Not supported |
| Governance | Advisory coordination | Standard task delegation |

The A2A bridge translates between A2A's task/artifact model and Vinyan's ECP model. VIIP preserves ECP semantics natively.

> **Note on trust vocabulary:** This document and the config schema use `"untrusted" | "semi-trusted" | "trusted"` for trust levels. The MCP bridge code (`src/mcp/ecp-translation.ts`) uses a different vocabulary: `"local" | "network" | "remote"` as `TrustLevel`. The mapping is: `trusted` → `local` (cap 0.7), `semi-trusted` → `network` (cap 0.5), `untrusted` → `remote` (cap 0.3). These two vocabularies should be unified in a future cleanup.
