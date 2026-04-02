# Epistemic Communication Protocol (ECP) Specification

> **Version:** 1.0-draft | **Date:** 2026-04-01 | **Status:** Draft
> **Source of truth:** [concept.md](../foundation/concept.md) §2, [tdd.md](tdd.md), [a2a-protocol.md](a2a-protocol.md)
> **Normative schemas:** `src/oracle/protocol.ts` (Zod — exports `HypothesisTupleSchema`, `EvidenceSchema`, `QualityScoreSchema`, `OracleVerdictSchema`; `DeliberationRequestSchema` and `TemporalContextSchema` are defined but not yet exported), `src/core/types.ts` (TypeScript interfaces)

---

## §1 Abstract & Motivation

### 1.1 Problem Statement

AI systems today lack a protocol for communicating **epistemic state** — the degree to which a claim is verified, what evidence supports it, under what conditions it would be invalidated, and whether the answering system genuinely does not know.

Existing protocols address adjacent concerns but miss the epistemic layer:

| Protocol | Purpose | Epistemic Gap |
|:---------|:--------|:-------------|
| **MCP** (Model Context Protocol) | LLM → Tool invocation | No confidence, evidence, uncertainty, or falsifiability. Results are opaque strings. |
| **A2A** (Agent-to-Agent) | Agent → Agent task delegation | Task-level only, no verification semantics. No "I don't know" at the task level. |
| **LSP** (Language Server Protocol) | Editor → Language server diagnostics | Diagnostic severity only (error/warning/info). No confidence model, no evidence chains, no falsifiability. |
| **JSON-RPC 2.0** | Generic RPC transport | Pure transport — no application-level semantics. |

### 1.2 ECP's Contribution

ECP is a **semantic extension of JSON-RPC 2.0** that adds epistemic state as first-class protocol data. The innovation is in the schema and the behaviors it enables, not the transport.

ECP allows heterogeneous **Reasoning Engines** — compilers, linters, LLMs, type checkers, security scanners, domain-specific verifiers — to communicate through a shared epistemic vocabulary:

- **Confidence** is a number, not a boolean.
- **Evidence** is a structured chain with content-addressed provenance.
- **"I don't know"** is a valid protocol state, not an error.
- **Falsifiability** declares what would invalidate a verdict.
- **Temporal validity** bounds when evidence expires.
- **Deliberation** lets an engine request more compute budget.

### 1.3 Relationship to Vinyan Axioms

Every ECP design decision traces to one or more of Vinyan's 7 axioms:

| Axiom | ECP Manifestation |
|:------|:-----------------|
| **A1** Epistemic Separation | Request-response contract: one engine generates a hypothesis, a different engine verifies it. |
| **A2** First-Class Uncertainty | `epistemic_type: "unknown"` is a valid response that triggers specific Orchestrator behaviors. |
| **A3** Deterministic Governance | Routing, trust, and verdict aggregation are computed from structured ECP fields — no LLM in the governance path. |
| **A4** Content-Addressed Truth | `evidence[].contentHash` and `fileHashes` bind verdicts to SHA-256 of verified content. |
| **A5** Tiered Trust | `confidence` range constrained by engine `tier`. Transport-based degradation for remote sources. |
| **A6** Zero-Trust Execution | Engines propose verdicts; the Orchestrator validates and commits. No engine can bypass verification. |
| **A7** Prediction Error as Learning | `temporal_context` + `falsifiable_by` enable systematic re-verification and prediction error computation. |

### 1.4 Design Principles

1. **JSON-RPC 2.0 compatible** — ECP messages are valid JSON-RPC 2.0 messages with additional fields. Existing JSON-RPC tooling works unchanged.
2. **Transport-agnostic** — The same message schema works over stdio (subprocess), WebSocket (network), or HTTP (stateless).
3. **Incrementally adoptable** — Conformance levels (§11) let engines implement only what they need.
4. **Schema-validated** — All messages validated by Zod schemas at runtime. Invalid messages are rejected, not silently degraded.

---

## §2 Terminology

| Term | Definition |
|:-----|:----------|
| **Reasoning Engine (RE)** | Any component that produces or verifies knowledge. Includes: oracles (type checker, linter, AST analyzer), LLM generators, security scanners, domain-specific verifiers. |
| **Orchestrator** | The governance layer that routes hypotheses to engines, aggregates verdicts, and commits facts. All routing/verification/commit decisions are rule-based (A3). |
| **Hypothesis** | A falsifiable claim about code, data, or system state. Encoded as `HypothesisTuple`. |
| **Verdict** | An engine's epistemic response to a hypothesis. Encoded as `OracleVerdict`. Contains confidence, evidence, and epistemic type. |
| **Fact** | A verified claim stored in the World Graph. A verdict that passed verification becomes a fact, bound to content hash (A4). |
| **Evidence** | A structured reference to the source material supporting a verdict: file path, line number, code snippet, content hash. |
| **Confidence** | A number in [0, 1] representing the engine's certainty. 1.0 = deterministic (compiler output). Lower values reflect heuristic or probabilistic evidence. |
| **Trust Tier** | Classification of evidence reliability: `deterministic` > `heuristic` > `probabilistic` > `speculative`. Determines confidence ceiling. |
| **Circuit Breaker** | Per-engine failure isolation: 3 consecutive failures → open (skip engine), 60s reset → half-open (probe), success → closed (normal). |
| **Content Hash** | SHA-256 hash of a file's content at verification time. Binds a verdict to a specific version of the verified artifact. |

---

## §3 Message Format

### 3.1 Base Transport

ECP defines two wire formats, selected by conformance level:

**Level 0 — Raw JSON over stdio:**
```
Request:  <HypothesisTuple JSON object>\n
Response: <OracleVerdict JSON object>\n
```

Level 0 engines are subprocesses: they read a single `HypothesisTuple` from stdin, write a single `OracleVerdict` to stdout, and exit. No JSON-RPC framing is required. This is the simplest possible integration point.

**Level 1+ — JSON-RPC 2.0:**
```
Request:  { "jsonrpc": "2.0", "id": <string|number>, "method": <string>, "params": <object> }
Response: { "jsonrpc": "2.0", "id": <string|number>, "result": <object> }
Error:    { "jsonrpc": "2.0", "id": <string|number>, "error": { "code": <int>, "message": <string> } }
```

Notifications (no response expected) omit the `id` field. JSON-RPC 2.0 framing is mandatory for Level 1+ engines that use network transports or persistent connections.

### 3.2 ECP Methods

> **Implementation status:** The current codebase (Phase 0-4) implements the stdio transport using direct JSON serialization (stdin → `HypothesisTuple` JSON, stdout → `OracleVerdict` JSON) without a JSON-RPC method router. The method names below are specified for Level 2+ (network transport, PH5.18). Level 0-1 engines communicate via raw JSON without method routing.

| Method | Direction | Purpose | Level |
|:-------|:----------|:--------|:------|
| `ecp/verify` | Orchestrator → Engine | Submit a hypothesis for verification | L2+ |
| `ecp/verdict` | Engine → Orchestrator | Return a verdict (response to `ecp/verify`) | L2+ |
| `ecp/register` | Engine → Orchestrator | Register engine capabilities | L2+ |
| `ecp/heartbeat` | Bidirectional | Keep-alive for network connections | L2+ |
| `ecp/deliberate` | Engine → Orchestrator | Request additional compute budget | L2+ |
| `ecp/invalidate` | Orchestrator → Engine | Notify that a fact has been invalidated | L2+ |
| `ecp/advertise` | Engine → Orchestrator | Publish capability advertisement | L2+ |

### 3.3 Hypothesis (Request)

The input to any Reasoning Engine — a structured claim to verify.

```typescript
// Normative schema: src/oracle/protocol.ts HypothesisTupleSchema
interface HypothesisTuple {
  /** File path or symbol identifier. e.g., "src/auth/login.ts" */
  target: string;
  /** Verification pattern. e.g., "type-check", "symbol-exists", "test-pass" */
  pattern: string;
  /** Pattern-specific context. e.g., { symbolName: "AuthService" } */
  context?: Record<string, unknown>;
  /** Absolute path to workspace root. */
  workspace: string;
}
```

**Built-in patterns:**

| Pattern | Engine | Meaning |
|:--------|:-------|:--------|
| `symbol-exists` | AST oracle | Does the named symbol exist in the target file? |
| `function-signature` | AST oracle | Does the function match the expected signature? |
| `import-exists` | AST oracle | Does the specified import exist? |
| `type-check` | Type oracle | Does the target file pass type checking? |
| `dependency-check` | Dep oracle | What is the blast radius of changes to this file? |
| `test-pass` | Test oracle | Do tests pass for the target file? |
| `lint-clean` | Lint oracle | Does the target file pass linting? |

Custom patterns follow the convention: `{domain}-{action}`, e.g., `security-audit`, `compliance-check`, `api-contract-valid`.

### 3.4 Verdict (Response)

The engine's epistemic response — the core of the ECP protocol.

```typescript
// Normative schema: src/oracle/protocol.ts OracleVerdictSchema
interface OracleVerdict {
  /** Did verification pass? */
  verified: boolean;

  // ── Epistemic Metadata (unique to ECP) ──────────────────────

  /** Epistemic state — A2 compliance. */
  type: "known" | "unknown" | "uncertain" | "contradictory";
  /** Confidence in [0, 1]. 1.0 for deterministic, <1.0 for heuristic. A5 compliance. */
  confidence: number;
  /** Structured evidence chain — A4 compliance. */
  evidence: Evidence[];
  /** Content hashes at verification time — A4 compliance. */
  fileHashes: Record<string, string>;
  /** Conditions that would invalidate this verdict — A7 compliance. */
  falsifiable_by?: string[];

  // ── Operational Metadata ────────────────────────────────────

  /** Human-readable explanation when !verified. */
  reason?: string;
  /** Programmatic error code. */
  errorCode?: "TIMEOUT" | "PARSE_ERROR" | "TYPE_MISMATCH" | "SYMBOL_NOT_FOUND" | "ORACLE_CRASH";
  /** Oracle name — attached by runner, not set by engine. */
  oracleName?: string;
  /** Execution duration in milliseconds. */
  duration_ms: number;

  // ── Phase 1+ Extensions ─────────────────────────────────────

  /** Multi-dimensional quality signal. */
  qualityScore?: QualityScore;
  /** Engine requests more compute budget. */
  deliberation_request?: DeliberationRequest;
  /** Evidence validity window with TTL. */
  temporal_context?: TemporalContext;
}
```

### 3.5 Evidence

A single piece of evidence with content-addressed provenance.

```typescript
// Normative schema: src/oracle/protocol.ts EvidenceSchema
interface Evidence {
  /** File path (relative to workspace). */
  file: string;
  /** Line number where evidence was found. */
  line: number;
  /** Code snippet demonstrating the evidence. */
  snippet: string;
  /** SHA-256 of the source file at verification time. Optional for Level 0. */
  contentHash?: string;
}
```

### 3.6 Temporal Context

Declares when evidence was gathered and when it expires.

```typescript
interface TemporalContext {
  /** Timestamp (ms since epoch) when evidence was gathered. */
  valid_from: number;
  /** Timestamp (ms since epoch) after which evidence is stale. */
  valid_until: number;
  /** How confidence decays over time. */
  decay_model: "linear" | "step" | "none";
}
```

**Decay models:**
- `"none"` — Confidence is constant until `valid_until`, then drops to 0.
- `"step"` — Confidence is constant until `valid_until`, then drops to 50%.
- `"linear"` — Confidence decreases linearly from `valid_from` to `valid_until`.

### 3.7 Deliberation Request

An engine signals that it could provide a better answer with more resources.

```typescript
interface DeliberationRequest {
  /** Why more compute would help. */
  reason: string;
  /** Suggested additional budget (tokens, time, or abstract units). */
  suggestedBudget: number;
}
```

The Orchestrator may grant, deny, or partially grant deliberation requests based on routing level budget constraints.

---

## §4 Epistemic Semantics

### 4.1 Epistemic Types

The `type` field classifies the engine's epistemic state. This is ECP's most fundamental innovation — making uncertainty a protocol citizen.

| Type | Meaning | Orchestrator Behavior |
|:-----|:--------|:---------------------|
| `"known"` | Verified with sufficient evidence. Engine is confident in the verdict. | Accept verdict. Store as fact if confidence ≥ threshold. |
| `"unknown"` | Engine cannot determine the answer. Not an error — a genuine epistemic limitation. | Trigger uncertainty reduction: escalate to higher-tier engine, try different approach, or delegate to human. |
| `"uncertain"` | Partial evidence exists but is insufficient for a definitive verdict. | May accept with reduced confidence. May request deliberation from same or different engine. |
| `"contradictory"` | Multiple evidence sources disagree. | Trigger contradiction resolution: tier ranking (A5), recency, specificity. May escalate to human. |

**Key principle:** `"unknown"` is NOT an error. An engine returning `type: "unknown"` is being epistemically honest. The Orchestrator treats this as actionable information (A2), not a failure to retry.

### 4.2 Confidence Model

Confidence is a number in [0, 1] representing the engine's certainty in its verdict.

| Range | Interpretation | Typical Source |
|:------|:---------------|:---------------|
| 1.0 | Deterministic — verified by formal analysis | Compiler, type checker (exit code 0 = verified) |
| 0.7–0.99 | Heuristic — strong evidence but not provable | Linter rules, pattern matching, dependency analysis |
| 0.3–0.69 | Probabilistic — statistical or model-based evidence | LLM judgment, fuzzy matching, ML classifier |
| 0.0–0.29 | Speculative — minimal evidence, exploratory | Untested hypothesis, creative suggestion |

**Confidence is constrained by trust tier** (§4.4). An engine declared as `tier: "heuristic"` cannot claim `confidence: 1.0`.

#### Belief Intervals (ECP v2 Extension)

Scalar confidence conflates "50% confident with strong evidence for both sides" and "no information at all" — both map to 0.5. ECP v2 introduces optional Dempster-Shafer belief/plausibility intervals:

```typescript
// Optional extension — present when engine provides richer epistemic information
interface BeliefInterval {
  /** Bel(H) — minimum confidence supported by direct evidence. */
  belief: number;
  /** Pl(H) — maximum confidence if all unknown factors resolve favorably. */
  plausibility: number;
}
// Uncertainty gap = plausibility - belief
// Gap = 0  → deterministic (full evidence)
// Gap = 1  → no evidence at all
// Gap > 0  → partial evidence → Orchestrator should consider escalation
```

When `belief_interval` is absent, consumers assume `belief = confidence, plausibility = confidence` (zero uncertainty gap). The scalar `confidence` field is ALWAYS present for backward compatibility.

**LLM Confidence Exclusion Policy:** LLM self-reported confidence is poorly calibrated (see Kadavath et al. 2022, Xiong et al. 2024 for ECE measurements) and MUST NOT be used for governance decisions (A3). If an oracle wraps an LLM, it MUST derive confidence from evidence structure (count, specificity, tool confirmation), NOT the LLM's self-assessed certainty. LLM self-confidence may be logged for A7 calibration research only.

### 4.3 Evidence Model

Every verdict SHOULD carry evidence. Evidence serves three purposes:

1. **Provenance** — Where did this conclusion come from? (file, line, snippet)
2. **Content addressing** — Is this verdict still valid? (contentHash, A4)
3. **Falsifiability** — What would change this verdict? (falsifiable_by, A7)

**Content hash contract (A4):**
- `evidence[].contentHash` is the SHA-256 of the file at the time of verification.
- `fileHashes` is a map of all files inspected during verification.
- If the file changes (hash mismatch), the verdict is **automatically stale** — the World Graph will not trust it.

**Invariant:** `verified: true` with `evidence.length === 0` is valid but SHOULD be avoided. Engines SHOULD provide at least one evidence item for positive verdicts.

### 4.4 Trust Tiers

Trust tiers classify the reliability of evidence sources. Higher tiers are preferred when verdicts conflict (A5).

| Tier | Quality Weight | Confidence Cap (Target) | Examples | Priority in Conflict |
|:-----|---------------:|------------------------:|:---------|:---------------------|
| `deterministic` | 1.0 | 1.0 | Compiler, type checker, test runner (pass/fail) | Highest |
| `heuristic` | 0.7 | 0.9 | Linter, AST pattern matcher, dependency analyzer | High |
| `probabilistic` | 0.4 | 0.7 | LLM judgment, ML classifier, external MCP tool | Medium |
| `speculative` | 0.2 | 0.4 | Creative exploration, untested approach | Lowest |

> **Implementation note:** The quality weights (1.0/0.7/0.4/0.2) are implemented in `src/gate/quality-score.ts` as `TIER_WEIGHTS` for weighted quality score aggregation. The confidence caps (1.0/0.9/0.7/0.4) are implemented in `src/oracle/tier-clamp.ts` as `TIER_CAPS`, applied at verdict intake via `clampByTier()` at two points: `src/oracle/runner.ts:112` (per-oracle run) and `src/gate/gate.ts:254` (gate pipeline). Transport-level caps (stdio=1.0, websocket=0.95, http=0.7) are also defined in `tier-clamp.ts` as `TRANSPORT_CAPS` via `clampByTransport()`. Tier priority is enforced in `src/gate/conflict-resolver.ts` for conflict resolution.

**Tier is declared at engine registration** and cannot be overridden per-verdict. An engine's `confidence` value is clamped to its tier's cap by the Orchestrator at verdict intake, before aggregation or storage. See `src/oracle/tier-clamp.ts`.

### 4.5 Falsifiability

The `falsifiable_by` field declares conditions that would invalidate a verdict. This enables:

- **Proactive re-verification** — When a falsifying condition changes, the Orchestrator can re-run the relevant engine.
- **Cascade invalidation** — A file change may invalidate multiple dependent verdicts.
- **Prediction error computation** — Track whether falsifying conditions actually occurred (A7).

**Formal grammar** (see Appendix D.3 for resolution history):

```
condition := scope ":" target ":" event
scope     := "file" | "dependency" | "env" | "config" | "time"
event     := "content-change" | "version-change" | "deletion" | "expiry"
target    := <any string, may contain colons (e.g., scoped npm packages)>
```

The target is extracted by splitting on the first colon (scope) and last colon (event); everything between is the target. This allows targets like `@scope/package` without escaping.

**Reference implementation:** `src/oracle/falsifiable-parser.ts` — `parseFalsifiableCondition()` returns a structured `FalsifiabilityCondition` object.

**Example:**
```json
{
  "verified": true,
  "falsifiable_by": [
    "file:src/auth/login.ts:content-change",
    "file:src/auth/types.ts:content-change",
    "dependency:@auth/jwt:version-change"
  ]
}
```

---

## §5 Transport Bindings

ECP is transport-agnostic. The same message schema works across all transports.

### 5.1 Stdio Transport (Level 0)

The default transport for local subprocess oracles. This is the current production implementation.

**Protocol:**
- One line of JSON per message, delimited by `\n`.
- Engine lifecycle: spawn → write hypothesis to stdin → read verdict from stdout → exit.
- Exit code 0 = normal completion (verdict may still be `verified: false`). Non-zero = engine crash.

**Flow:**
```
Orchestrator                         Engine (subprocess)
    │                                     │
    │── spawn(command) ──────────────────▶│
    │── stdin: HypothesisTuple JSON \n ──▶│
    │                                     │── process hypothesis
    │◀── stdout: OracleVerdict JSON \n ───│
    │◀── exit(0) ─────────────────────────│
```

**Timeout:** Configurable per oracle via `timeout_ms` (default: 30,000ms). On timeout, the process is killed (`SIGKILL`), and a verdict with `errorCode: "TIMEOUT"` is returned.

**Reference implementation:** `src/oracle/runner.ts`

### 5.2 WebSocket Transport (Level 2)

Persistent bidirectional connection for network-accessible engines. Enables remote oracles, cross-instance communication, and stateful engines.

**Connection setup:**
1. Engine connects to Orchestrator's WebSocket endpoint: `ws://<host>:<port>/ecp/v1`
2. Sub-protocol: `ecp-v1` (declared in `Sec-WebSocket-Protocol` header)
3. Engine sends `ecp/register` message with capability advertisement
4. Orchestrator acknowledges with `ecp/register` response containing assigned `engineId`

**Message framing:**
- JSON text frames (not binary). One JSON-RPC message per WebSocket frame.
- Maximum message size: 1 MB (configurable).

**Keep-alive:**
- WebSocket ping/pong every 30s (transport-level).
- Application-level `ecp/heartbeat` every 30s (carries engine health metrics).
- No heartbeat for 90s → connection considered dead → circuit breaker opens.

**Reconnection:**
- Engine-initiated with exponential backoff: 1s, 2s, 4s, 8s, max 60s.
- On reconnect, engine re-sends `ecp/register`. Orchestrator merges with existing registration.
- In-flight requests at disconnect time are treated as timeouts.

**Network Envelope:**

For cross-instance communication, messages are wrapped in a network envelope:

```typescript
interface ECPNetworkEnvelope {
  protocol_version: number;        // negotiated during handshake
  message_id: string;              // UUIDv7 — idempotency + time-sortable
  source_instance_id: string;      // sender identity (Ed25519 public key hash)
  target_instance_id?: string;     // null = broadcast
  timestamp: number;               // sender wall-clock (ms since epoch)
  ttl_ms: number;                  // message expires after this duration
  payload: object;                 // standard ECP message (HypothesisTuple or OracleVerdict)
  signature?: string;              // Ed25519 signature of payload
}
```

**Delivery guarantees:**

| Property | Guarantee | Mechanism |
|:---------|:----------|:----------|
| Ordering | Causal per-instance | UUIDv7 time-sortable. No global ordering (too expensive). |
| Delivery | At-least-once | `message_id` deduplication window (10,000 IDs). Retry with backoff (100ms → 5s, max 3 attempts). |
| Freshness | TTL-bounded | Receiver drops messages where `now - timestamp > ttl_ms`. |
| Partial failure | Fail-open | If network fails, Orchestrator continues with local oracles only. |

### 5.3 HTTP Transport (Level 2 — Stateless Fallback)

For environments where WebSocket is unavailable (firewalls, serverless, etc.).

**Endpoints:**

| Method | Path | Purpose |
|:-------|:-----|:--------|
| `POST` | `/ecp/v1/verify` | Single hypothesis → verdict exchange |
| `POST` | `/ecp/v1/register` | Register engine capabilities |
| `GET` | `/ecp/v1/stream` | SSE event stream for notifications (invalidations, circuit changes) |
| `GET` | `/ecp/v1/health` | Engine health check |

**Request format:** JSON body containing the ECP message (same schema as WebSocket/stdio).
**Response format:** JSON body containing the ECP response.
**Authentication:** Bearer token or mTLS (see §8).

### 5.4 Transport Negotiation

When an engine registers, it declares its preferred transport:

```json
{
  "method": "ecp/register",
  "params": {
    "name": "security-scanner",
    "capabilities": { "patterns": ["security-audit", "cve-check"], "languages": ["typescript", "python"] },
    "tier": "heuristic",
    "transport": {
      "preferred": "websocket",
      "fallback": "http",
      "endpoint": "ws://scanner.internal:8080/ecp"
    }
  }
}
```

The Orchestrator responds with the accepted transport and any transport-specific parameters.

---

## §6 Reasoning Engine Lifecycle

### 6.1 Registration

An engine joins the ECP network by registering its capabilities. Registration can occur through:

1. **Config file** — Static entry in `vinyan.json` under `oracles` key. For local subprocess oracles.
2. **CLI** — `vinyan oracle register <name> --command <cmd> --languages <langs> --tier <tier>`
3. **ECP message** — Send `ecp/register` over WebSocket or HTTP. For remote/dynamic engines.
4. **Programmatic** — Call `registerOracle(name, entry)` from `src/oracle/registry.ts`.

**Registry entry schema:**

```typescript
// Reference: src/oracle/registry.ts OracleRegistryEntry
interface OracleRegistryEntry {
  path?: string;           // TypeScript entry point (for built-in bun oracles)
  command?: string;         // External command (overrides path). Any language.
  languages?: string[];     // Languages this engine supports
  tier?: "deterministic" | "heuristic" | "probabilistic" | "speculative";
  timeout_ms?: number;      // Per-invocation timeout (default: 30,000ms)
  // Future (Level 2+):
  transport?: "stdio" | "websocket" | "http";
  endpoint?: string;        // For network engines
}
```

### 6.2 Capability Advertisement

Engines SHOULD advertise what hypothesis patterns they can verify, which languages they support, and their confidence ceiling:

```json
{
  "method": "ecp/advertise",
  "params": {
    "name": "python-type-oracle",
    "patterns": ["type-check", "symbol-exists", "import-exists"],
    "languages": ["python"],
    "tier": "deterministic",
    "confidence_ceiling": 1.0,
    "max_concurrent": 4,
    "avg_latency_ms": 1500
  }
}
```

The Orchestrator uses capability advertisements for hypothesis routing: matching the hypothesis pattern and target language to registered engines.

### 6.3 Health & Circuit Breaker

**Circuit breaker** (per engine):

```
closed ──(3 failures)──▶ open ──(60s timer)──▶ half-open ──(success)──▶ closed
                           ▲                                    │
                           └─────────(failure)──────────────────┘
```

- `closed` — Normal operation. Failures are counted.
- `open` — Engine is skipped. Orchestrator returns `type: "unknown"` for hypotheses routed to this engine.
- `half-open` — One probe request allowed. Success → closed. Failure → open.

Configuration: `failureThreshold` (default: 3), `resetTimeout_ms` (default: 60,000ms).

Reference: `src/oracle/circuit-breaker.ts`

**Health check protocol** (network engines):
- `ecp/heartbeat` carries: `{ status: "healthy" | "degraded" | "overloaded", queue_depth: number, error_rate: number }`
- Orchestrator adjusts routing weight based on health. Overloaded engines receive fewer hypotheses.

### 6.4 Trust Lifecycle

New engines start in **probation** — their verdicts are accepted but with reduced confidence.

```
probation ──(N successful verdicts, Wilson LB > threshold)──▶ active
    ▲                                                            │
    │                                    (systematic failures)───┘
    │                                            │
    └────────(cooldown period)──── demoted ◀─────┘
                                      │
                           (max demotions exceeded)
                                      │
                                      ▼
                                   retired
```

- **Probation**: Confidence multiplied by 0.7. Minimum N verdicts before promotion (configurable, default: 30).
- **Active**: Full confidence per tier ceiling.
- **Demoted**: Reverted to probation after systematic failures (e.g., false positive rate > threshold).
- **Retired**: Permanently removed from routing after max demotions exceeded.

Trust is earned empirically using Wilson score lower bound on verdict accuracy — the same statistical machinery used for patterns and rules (A3: deterministic governance, no LLM).

Reference: `src/orchestrator/worker-lifecycle.ts` implements this pattern for LLM workers.

---

## §7 Orchestrator Protocol

The Orchestrator is the governance layer. It uses ECP to route hypotheses, aggregate verdicts, and commit facts. All Orchestrator decisions are rule-based (A3).

### 7.1 Hypothesis Routing

The Orchestrator assigns a **routing level** to each verification request based on risk score:

| Level | Behavior | Latency Budget | Engines Invoked |
|:------|:---------|---------------:|:----------------|
| L0 Reflex | Hash-only verify, zero tokens | < 100ms | None (cached fact lookup) |
| L1 Heuristic | Structural verification | < 2,000ms | AST + Type + Dep + Lint |
| L2 Analytical | Full verification including tests | < 10,000ms | All oracles including test |
| L3 Deliberative | Full verification + shadow execution | < 60,000ms | All oracles + shadow container |

Risk score is computed from: file count, blast radius, file types, mutation complexity, dependency depth.

Reference: `src/gate/risk-router.ts` — `calculateRiskScore()`, `routeByRisk()`

### 7.2 Multi-Oracle Aggregation

When multiple engines verify the same hypothesis, the Orchestrator aggregates their verdicts using a two-phase approach:

**Phase 1: Tier-Based Filtering (A5)**

Group verdicts by trust tier. The current implementation in `src/gate/conflict-resolver.ts` uses a 5-step deterministic algorithm:
- **Step 1: Domain separation** — Cross-domain conflicts (e.g., structural vs functional) are both valid, not contradictory.
- **Step 2: Tier priority** — Deterministic verdict overrides heuristic overrides probabilistic (A5).
- **Step 3: Evidence count** — Verdict with more evidence items wins.
- **Step 4: Historical accuracy** — Oracle with better track record (correct/total ratio) wins.
- **Step 5: Escalate** — If resolution fails, set `hasContradiction: true` on the aggregate result and apply conservative default (failure wins). The downstream gate pipeline uses this flag to produce `type: "contradictory"` on the combined verdict.

**Phase 2: Dempster-Shafer Combination (within same tier)**

When multiple independent oracles within the same tier produce verdicts, combine using Dempster's rule:

```
// Dempster's rule for two independent mass functions m1, m2:
// Combined mass: m12(A) = Σ{B∩C=A} m1(B)·m2(C) / (1 - K)
// K = conflict factor = Σ{B∩C=∅} m1(B)·m2(C)
```

> **Implementation note:** The full DS combination rule requires converting scalar confidence to a mass function over `{verified, ¬verified, Θ}` where `Θ` represents uncertainty. The exact implementation should follow standard DS theory for the ternary frame of discernment — the simplified binary product formula `(c1 × c2) / (1 - K)` is an approximation and should not be used directly. See Shafer (1976) "A Mathematical Theory of Evidence" for the rigorous formulation. DS combination is a **target design for ECP v2** — the current `conflict-resolver.ts` uses the Phase 1 priority-based resolution only.

**Combination rules:**
- Oracles returning `type: "unknown"` are **excluded** from combination (no evidence to combine).
- `conflict_factor > 0.7` triggers `type: "contradictory"` on the combined verdict.
- Oracles that share the same underlying data source (e.g., two linters reading the same file) are **not independent** — only the higher-tier result is used.
- DS combination is applied only within the same tier group; cross-tier aggregation uses Phase 1 priority rules.

Reference: `src/gate/conflict-resolver.ts`

### 7.3 Deliberation Protocol

An engine may request more compute via `deliberation_request` in its verdict:

```json
{
  "verified": false,
  "type": "uncertain",
  "confidence": 0.3,
  "deliberation_request": {
    "reason": "Complex type intersection requires deeper analysis",
    "suggestedBudget": 5000
  }
}
```

Orchestrator behavior:
1. Check remaining budget for the current routing level.
2. If budget allows: re-invoke the same engine with increased timeout/token budget.
3. If budget exhausted: escalate to next routing level (L1 → L2 → L3).
4. Maximum 3 deliberation rounds per hypothesis (prevents infinite loops).

---

## §8 Security Model

### 8.1 Instance Identity

Each Vinyan instance has a unique Ed25519 keypair:

- **Public key**: Shared with peers for identity verification. Hash of public key serves as `instance_id`.
- **Private key**: Never transmitted. Stored at a caller-supplied path (convention: `~/.vinyan/instance-key.json`) with mode `0o600`. The path is a parameter to `loadOrCreateIdentity()`, not hardcoded.
- **Generated**: On first run via `crypto.subtle.generateKey("Ed25519")`.

Reference: `src/security/instance-identity.ts`

### 8.2 Message Signing

Cross-network ECP messages (§5.2 WebSocket, §5.3 HTTP) SHOULD be signed:

```
signature = Ed25519.sign(privateKey, SHA-256(JSON.stringify(payload)))
```

The receiver verifies:
1. Extract `source_instance_id` from envelope.
2. Look up public key in peer registry.
3. Verify `Ed25519.verify(publicKey, SHA-256(payload), signature)`.
4. Reject if verification fails — do not process the message.

### 8.3 Authentication

| Context | Method | Details |
|:--------|:-------|:--------|
| Local API | Bearer token | Auto-generated 256-bit token at `<workspace>/.vinyan/api-token` (workspace-relative, see `src/cli/serve.ts:26`). Constant-time comparison via `timingSafeEqual`. |
| Network (instance-to-instance) | Ed25519 signature + optional mTLS | Per-message signing. mTLS for transport-level encryption. |
| MCP (stdio) | Implicit trust | Local subprocess — no authentication needed. Trust controlled by spawn permissions. |

Reference: `src/security/auth.ts`

### 8.4 Authorization Scopes

| Scope | Allowed Operations |
|:------|:-------------------|
| `read` | Query facts, metrics, capabilities, health |
| `verify` | Submit hypotheses, receive verdicts |
| `register` | Register new engines, update capabilities |
| `admin` | Modify config, manage engine lifecycle, trigger sleep cycle |

Public endpoints (no auth required): `GET /ecp/v1/health`, `GET /api/v1/metrics`

---

## §9 Versioning

### 9.1 Protocol Version

Every ECP message envelope carries a `protocol_version` number. The current version is `1`.

```typescript
// Reference: src/orchestrator/types.ts (re-exported via src/orchestrator/index.ts)
const ECP_PROTOCOL_VERSION = 1;
```

### 9.2 Negotiation

On WebSocket connection, the engine and Orchestrator exchange supported versions:

```json
// Engine → Orchestrator
{ "method": "ecp/register", "params": { "protocol_version": 1, ... } }

// Orchestrator → Engine
{ "result": { "accepted_version": 1, "engine_id": "abc123" } }
```

If no common version exists, the connection is rejected with error code `-32001` (version mismatch).

### 9.3 Compatibility Rules

- **Minor additions** (new optional fields): Backward compatible. Receivers MUST ignore unknown fields.
- **New methods**: Backward compatible. Receivers return `METHOD_NOT_FOUND` for unknown methods.
- **Breaking changes** (required field changes, semantic changes): Major version bump. Old and new versions cannot interoperate without bridge.

---

## §10 Bridge Protocols

ECP is the native protocol. External protocols are bridged with trust degradation.

### 10.1 MCP Bridge

MCP (Model Context Protocol) is used when external LLM agents consume Vinyan as a tool.

**Outbound (Vinyan as MCP Server):**

| MCP Tool | ECP Operation |
|:---------|:-------------|
| `vinyan_ast_verify` | `ecp/verify` → ast oracle |
| `vinyan_type_check` | `ecp/verify` → type oracle |
| `vinyan_blast_radius` | `ecp/verify` → dep oracle |
| `vinyan_query_facts` | World Graph fact query |
| `vinyan_run_gate` | Full verification pipeline (risk route → multi-oracle → aggregate) |
| `vinyan_risk_assess` | Risk score computation |
| `vinyan_query_evidence` | Evidence chain retrieval for a fact |
| `vinyan_list_oracles` | Discover available engines + capabilities |

**Translation rules:**
- `OracleVerdict` → `MCPToolResult`:
  - `type: "unknown"` → `{ verified: null, reason: "insufficient evidence" }` (preserves A2 across bridge)
  - `verified: true` → text content with full JSON payload
  - `verified: false` → text content with reason, `isError: true`

**Inbound (Vinyan as MCP Client):**

All MCP tool results entering Vinyan are treated as **probabilistic-tier evidence**:
- `type` is forced to `"uncertain"` — external sources cannot claim `"known"` (A5)
- Confidence capped by trust level:

| Trust Level | Confidence Cap |
|:------------|---------------:|
| `trusted` / `local` | 0.7 |
| `semi-trusted` / `network` | 0.5 |
| `untrusted` / `remote` | 0.3 |

Reference: `src/mcp/ecp-translation.ts` — `ecpToMcp()`, `mcpToEcp()`

### 10.2 A2A Bridge

A2A (Agent-to-Agent) is used when external agents interact with Vinyan as a peer.

**Task-level:**
- A2A `tasks/send` → `TaskInput` with `source: "a2a"` → Orchestrator core loop → `TaskResult` → A2A artifact
- Confidence cap: 0.5 for all A2A-sourced results (I13)

**Verification-level (proposed):**
- A2A agents should be able to send hypotheses for verification without full task submission.
- `POST /a2a/verify` → A2A hypothesis → ECP `ecp/verify` → verdict → A2A response
- Same confidence cap and trust degradation as task-level.

Reference: `src/a2a/bridge.ts`, `src/a2a/confidence-injector.ts`

### 10.3 LSP Bridge (Future)

Language Server Protocol diagnostics can serve as evidence sources:
- LSP diagnostics → ECP evidence (file, line, snippet from diagnostic message)
- ECP verdicts → LSP diagnostics (push verification results to editors)
- Trust tier: `heuristic` (LSP diagnostics are rule-based, not provably correct)

---

## §11 Conformance Levels

Engines can implement ECP incrementally. Each level adds capabilities.

### Level 0 — Minimal

**Required:** Read `HypothesisTuple` from stdin, write `OracleVerdict` to stdout.

This is the simplest possible ECP engine — a subprocess that reads JSON and writes JSON. Any language can implement this.

**Transport:** Raw JSON over stdio (one JSON object per line, `\n`-delimited). No JSON-RPC 2.0 framing, no `method` routing, no `id` field. The engine reads exactly one `HypothesisTuple` JSON object from stdin and writes exactly one `OracleVerdict` JSON object to stdout.

**Required fields in verdict:** `verified`, `evidence`, `fileHashes`, `duration_ms`.
**Optional fields:** All others default via Zod schema (`type` defaults to `"known"`, `confidence` defaults to `1.0`).

**Example (20 lines, any language):**
```python
import json, sys, hashlib
hypothesis = json.loads(sys.stdin.readline())
file_hash = hashlib.sha256(open(hypothesis["target"], "rb").read()).hexdigest()
# ... your verification logic here ...
verdict = {
    "verified": True,
    "evidence": [{"file": hypothesis["target"], "line": 1, "snippet": "OK"}],
    "fileHashes": {hypothesis["target"]: file_hash},
    "duration_ms": 42
}
print(json.dumps(verdict))
```

### Level 1 — Standard

**Adds:** Capability advertisement, health/heartbeat, epistemic type variety, JSON-RPC 2.0 framing.

- **JSON-RPC 2.0 framing is mandatory** — all messages include `jsonrpc`, `method`, and `id` fields.
- Engine sends `ecp/advertise` with patterns, languages, tier.
- Engine responds to `ecp/heartbeat` with health status.
- Engine uses all 4 epistemic types: `known`, `unknown`, `uncertain`, `contradictory`.
- Engine populates `falsifiable_by` on verdicts (see §4.5 for structured format).
- Engine populates `evidence[].contentHash` (A4 compliance).

### Level 2 — Full

**Adds:** Network transport, temporal context, deliberation, version negotiation.

- Engine connects via WebSocket or HTTP (not just stdio).
- Engine populates `temporal_context` on verdicts.
- Engine may send `deliberation_request` to negotiate more compute.
- Engine supports concurrent hypotheses (multiple in-flight requests).
- Engine performs **version negotiation** on connection (see §11.1).

### Level 3 — Platform

**Adds:** Cross-instance coordination, knowledge sharing.

- Engine participates in multi-instance ECP network.
- Engine handles `ecp/invalidate` notifications.
- Engine can share knowledge (rules, patterns) via ECP messages.
- Engine supports the full network envelope (§5.2) including message signing.

### §11.1 Version Negotiation (Level 2+)

Network-connected engines (Level 2+) MUST perform version negotiation on connection establishment. The handshake uses the existing `ecp/register` method:

**Handshake flow:**
```
Engine → Orchestrator:
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "ecp/register",
  "params": {
    "ecp_version": 1,
    "supported_versions": [1],
    "engine_name": "my-oracle",
    "tier": "deterministic",
    "patterns": ["type-check", "import-exists"],
    "languages": ["typescript"]
  }
}

Orchestrator → Engine:
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "negotiated_version": 1,
    "instance_id": "<orchestrator-instance-id>",
    "features": ["deliberation", "temporal_context"]
  }
}
```

**Rules:**
1. The engine sends `ecp_version` (the preferred version) and `supported_versions` (all versions it can speak).
2. The Orchestrator selects the highest mutually supported version and returns `negotiated_version`.
3. If no mutually supported version exists, the Orchestrator returns a JSON-RPC error with code `-32600` (Invalid Request) and message `"no compatible ECP version"`.
4. All subsequent messages on this connection use the negotiated version's semantics.
5. Level 0-1 engines (stdio) do not perform version negotiation — they are implicitly ECP version 1.

**Current version:** ECP 1 (the only defined version). The `ecp_version` field in `VinyanECPExtension` (`src/a2a/types.ts`) is `z.literal(1)`. When ECP 2 is defined, the schema will accept `z.union([z.literal(1), z.literal(2)])`.

---

## §12 Differences from Related Protocols

| Feature | ECP | MCP | A2A | LSP | gRPC |
|:--------|:----|:----|:----|:----|:-----|
| Confidence as number | ✅ | ❌ | ❌ | ❌ | ❌ |
| "I don't know" state | ✅ `type:"unknown"` | ❌ | ❌ | ❌ | ❌ |
| Evidence chains | ✅ structured | ❌ opaque text | ❌ | ⚠️ diagnostics only | ❌ |
| Falsifiability | ✅ `falsifiable_by` | ❌ | ❌ | ❌ | ❌ |
| Content-addressed truth | ✅ SHA-256 hashes | ❌ | ❌ | ❌ | ❌ |
| Temporal validity | ✅ `temporal_context` | ❌ | ❌ | ❌ | ❌ |
| Trust tiers | ✅ 4 tiers | ❌ | ❌ | ⚠️ severity levels | ❌ |
| Contradiction handling | ✅ 5-step resolution | ❌ last-write-wins | ❌ | ❌ | ❌ |
| Deliberation negotiation | ✅ `deliberation_request` | ❌ fixed compute | ❌ | ❌ | ❌ |
| Transport | stdio, WS, HTTP | stdio, HTTP | HTTP | stdio, pipe | HTTP/2 |
| Wire format | JSON-RPC 2.0 | JSON-RPC 2.0 | JSON-RPC 2.0 | JSON-RPC 2.0 | Protobuf |

**Key insight:** ECP is not competing with these protocols — it addresses a different layer. MCP handles tool invocation. A2A handles agent delegation. LSP handles editor diagnostics. ECP handles **epistemic communication** — the layer where systems reason about what they know, what they don't know, and how confident they are.

---

## Appendix A: JSON-RPC Error Codes

Standard JSON-RPC 2.0 errors apply. ECP adds:

| Code | Name | Meaning |
|-----:|:-----|:--------|
| -32700 | Parse error | Invalid JSON |
| -32600 | Invalid request | Not a valid JSON-RPC 2.0 message |
| -32601 | Method not found | Unknown ECP method |
| -32602 | Invalid params | HypothesisTuple validation failed |
| -32603 | Internal error | Engine internal failure |
| -32001 | Version mismatch | No common ECP version (custom) |
| -32002 | Circuit open | Engine circuit breaker is open (custom) |
| -32003 | Auth failed | Signature verification or token validation failed (custom) |

## Appendix B: Normative Schema Reference

| Schema | File | Purpose |
|:-------|:-----|:--------|
| `HypothesisTupleSchema` | `src/oracle/protocol.ts` | Validates engine input |
| `OracleVerdictSchema` | `src/oracle/protocol.ts` | Validates engine output |
| `EvidenceSchema` | `src/oracle/protocol.ts` | Validates evidence items |
| `QualityScoreSchema` | `src/oracle/protocol.ts` | Validates quality dimensions |
| `OracleErrorCodeSchema` | `src/oracle/protocol.ts` | Validates error codes |
| `OracleRegistryEntry` | `src/oracle/registry.ts` | Engine registration entry |
| `OracleConfig` | `src/config/schema.ts` | Per-engine configuration |

## Appendix C: Example Message Flows

### C.1 Local Oracle Verification (stdio, Level 0)

```
Orchestrator                              AST Oracle (subprocess)
    │                                          │
    │── Bun.spawn(["bun","run","ast/index.ts"])─▶│
    │── stdin: {                                │
    │     "target": "src/auth/login.ts",        │
    │     "pattern": "symbol-exists",           │
    │     "context": {"symbolName":"AuthService"},│
    │     "workspace": "/project"               │
    │   }                                       │
    │                                           │── parse AST
    │                                           │── find symbol
    │◀── stdout: {                              │
    │     "verified": true,                     │
    │     "type": "known",                      │
    │     "confidence": 1.0,                    │
    │     "evidence": [{                        │
    │       "file": "src/auth/login.ts",        │
    │       "line": 15,                         │
    │       "snippet": "export class AuthService",│
    │       "contentHash": "sha256:abc123..."   │
    │     }],                                   │
    │     "fileHashes": {                       │
    │       "src/auth/login.ts": "sha256:abc..."│
    │     },                                    │
    │     "duration_ms": 45                     │
    │   }                                       │
    │◀── exit(0) ───────────────────────────────│
```

### C.2 Remote Oracle with Deliberation (WebSocket, Level 2)

```
Orchestrator                              Security Scanner (remote)
    │                                          │
    │◀── ecp/register: {patterns:["security-   │
    │     audit"],tier:"heuristic"} ───────────│
    │── ack: {engine_id:"sec-1"} ─────────────▶│
    │                                          │
    │── ecp/verify: {                          │
    │     target:"src/api/handler.ts",         │
    │     pattern:"security-audit"             │
    │   } ────────────────────────────────────▶│
    │                                          │── scan code
    │◀── verdict: {                            │── find potential issue
    │     verified:false, type:"uncertain",    │── need deeper analysis
    │     confidence:0.4,                      │
    │     deliberation_request: {              │
    │       reason:"Found potential SQL injection, need taint analysis",
    │       suggestedBudget:10000              │
    │     }                                    │
    │   } ─────────────────────────────────────│
    │                                          │
    │── ecp/verify: {same hypothesis,          │
    │     context:{budget:10000,               │
    │              depth:"taint-analysis"}} ──▶│
    │                                          │── deep taint analysis
    │◀── verdict: {                            │
    │     verified:false, type:"known",        │
    │     confidence:0.85,                     │
    │     evidence:[{file:"handler.ts",line:42,│
    │       snippet:"db.query(userInput)"}],   │
    │     falsifiable_by:["file:handler.ts:    │
    │       content-change"]                   │
    │   } ─────────────────────────────────────│
```

---

## Appendix D: Known Limitations (Expert Review, April 2026)

> Source: [expert-review.md](../analysis/expert-review.md) — protocol-specific findings from expert panel review.

### D.1 Spec-Implementation Gap

**Finding (PR-1, CRITICAL):** This specification states in §3.1 that "Every ECP message is a valid JSON-RPC 2.0 message" with `jsonrpc: "2.0"`, `method`, and `id` fields. However, the production oracle runner (`src/oracle/runner.ts`) uses raw JSON over stdio with none of these fields. Oracles receive a raw `HypothesisTuple` JSON object on stdin and emit a raw `OracleVerdict` JSON object on stdout.

**Impact:** A third party implementing "ECP Level 0" from this specification would produce messages incompatible with the actual Vinyan oracle runner.

**Resolution options:**
1. **(Recommended)** Amend Level 0 conformance (§11) to explicitly define raw-JSON-over-stdio as a valid Level 0 transport. JSON-RPC 2.0 framing becomes mandatory at Level 1+. This is honest and does not break backward compatibility with existing oracles.
2. Update the oracle runner to use JSON-RPC 2.0 framing, requiring all existing oracle implementations to add envelope fields.

**Status:** ✅ Resolved — Option 1 adopted. §3.1 now defines two wire formats (Level 0: raw JSON, Level 1+: JSON-RPC 2.0). §11 Level 0 explicitly states raw JSON transport. §11 Level 1 explicitly requires JSON-RPC 2.0 framing.

### D.2 Confidence Conflation

**Finding (PR-2, HIGH):** The `confidence: number` field in `OracleVerdict` (§4.2) encodes two orthogonal dimensions in a single value:

- **Tier reliability:** A deterministic oracle (AST parser) reports `confidence: 1.0` — this is a statement about the *evidence class*, not probabilistic certainty.
- **Engine certainty:** A heuristic oracle (LLM-as-judge) reports `confidence: 0.7` — this is a statement about the engine's *uncertainty about this specific verdict*.

The current mitigation (clamping confidence by tier ceiling, §4.4) is a workaround, not a solution. The contradiction resolver (§7.2) overloads "higher confidence wins" with "higher tier wins," which are not the same operation.

**Proposed resolution:** Split into two fields:
```typescript
tier_reliability: number;   // Set by Orchestrator from engine registration. Deterministic=1.0, heuristic=0.7-0.9, probabilistic=0.3-0.7
engine_certainty: number;   // Reported by engine. Its own assessment of this specific verdict.
```

**Migration path:** This is a breaking protocol change. The recommended migration is:

1. **ECP 1.x (current):** `confidence` remains the single field. The Orchestrator clamps `confidence` by tier ceiling (§4.4) as a workaround. Engines SHOULD document which dimension their confidence represents via the `evidence[].type` tier indicator.
2. **ECP 2.0 (future):** Introduce `tier_reliability` + `engine_certainty` as separate fields. For backward compatibility, if only `confidence` is present, the Orchestrator infers: `tier_reliability` from the engine's registered tier, `engine_certainty` from the `confidence` value.

**Status:** Documented with migration path. Breaking change deferred to ECP 2.0. See [TDD §15 Q16](tdd.md).

### D.3 `falsifiable_by` Lacks Formal Grammar

**Finding (PR-3, HIGH):** The `falsifiable_by` field (§4.5) is declared as `string[]` with examples like `"file:src/auth/login.ts:content-change"`. There is no formal grammar defining valid condition strings. Each consumer must implement its own parser, leading to ecosystem fragmentation.

**Proposed structured format:**
```typescript
interface FalsifiabilityCondition {
  scope: "file" | "dependency" | "env" | "config" | "time";
  target: string;        // e.g., "src/auth/login.ts", "@auth/jwt"
  event: "content-change" | "version-change" | "deletion" | "expiry";
}
```

This makes `falsifiable_by` machine-parseable and enables automated re-verification triggers and cross-instance cascade invalidation.

**Status:** ✅ Resolved — `FalsifiabilityCondition` interface implemented in `src/oracle/falsifiable-parser.ts` with formal grammar `scope:target:event`. Parser handles scoped npm packages (target may contain colons). Used by `src/world-graph/world-graph.ts` for cascade invalidation wiring. The `falsifiable_by` field remains `string[]` in the wire format for backward compatibility; consumers use `parseFalsifiableCondition()` to get structured access.

### D.4 Missing Deliberation Response

**Finding (PR-5, MEDIUM):** The `ecp/deliberate` method (§7.3) allows an engine to request additional compute budget via `suggestedBudget: number`. The Orchestrator may "grant, deny, or partially grant." However, no `deliberation_response` message type is defined. The engine learns its granted budget implicitly from the next `ecp/verify` call's context — this is not explicit in the specification.

**Proposed resolution:** Either:
1. Define an explicit `ecp/deliberation_response` message type with `granted_budget: number`.
2. Document in §7.3 that the response is embedded in the next `ecp/verify` call's `context.budget` field.

**Status:** Open.
