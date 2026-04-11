# K2: Trust-Weighted Multi-Agent Dispatch — System Design + Implementation

## Mission

Design and implement K2 for Vinyan OS — trust-weighted multi-agent dispatch with concurrent task execution, market mechanism integration, and MCP client. All K2 Gate criteria (G8-G13) must pass.

## MANDATORY: Read These Files First

Before writing ANY code, read these files to understand the codebase:
1. `CLAUDE.md` — project conventions, tech stack, axioms
2. `docs/architecture/vinyan-os-architecture.md` §6 — K2 spec, gate criteria G8-G13
3. `src/orchestrator/core-loop.ts` — current dispatch lifecycle (focus on OrchestratorDeps interface ~L140-190, routing loop ~L479-520, LEARN phase ~L1600-1740)
4. `src/orchestrator/factory.ts` — how components are instantiated and injected
5. `src/db/provider-trust-store.ts` — existing trust store (provider-level, needs capability extension)
6. `src/orchestrator/priority-router.ts` — existing `selectProvider()` (Wilson LB, ORPHANED)
7. `src/orchestrator/task-queue.ts` — existing TaskQueue (semaphore-based, 66 LOC)
8. `src/orchestrator/worker-selector.ts` — current worker scoring (fleet module)
9. `src/economy/market/market-scheduler.ts` — existing market (Vickrey auction, ORPHANED)
10. `src/mcp/client-bridge.ts` — existing MCP bridge (stdio subprocess, ORPHANED)
11. `src/economy/cost-aware-scorer.ts` — already wired into worker-selector

## Current State (Verified)

### What EXISTS and is WIRED:
- K1 complete: guardrails, contracts, tool auth, contradiction escalation, ECP validation
- Economy E1-E4 complete: cost ledger, budget enforcer, cost predictor, market, federation
- `ProviderTrustStore` — instantiated in factory, records outcomes in LEARN phase
- `TaskQueue` — semaphore-based (5 concurrent), wired in serve.ts for API
- `selectProvider()` — Wilson LB trust ranking, tested, ZERO callers in kernel
- `MarketScheduler` — Vickrey auction, tested, ZERO callers in kernel
- `MCPClientBridge` — stdio subprocess bridge, tested, ZERO callers in kernel
- `costAwareScore()` — wired into worker-selector scoring

### What's MISSING:
1. **Engine selector** (`src/orchestrator/engine-selector.ts`) — orchestrates trust-weighted provider selection
2. **Concurrent dispatcher** — wraps TaskQueue for multi-task orchestration from core-loop
3. **Advisory file locks** (`src/orchestrator/worker/file-lock.ts`) — cross-task write conflict prevention
4. **MCP client lifecycle** (`src/mcp/client.ts`) — connection pool + tool discovery for orchestrator
5. **Capability-level trust** — ProviderTrustStore tracks per-provider only, needs per-(provider, capability)
6. **Market → dispatch wiring** — MarketScheduler.allocate() never called before worker selection
7. **A2A integration test** — functional but disabled by default; needs cross-instance test

## Implementation Plan — 5 Phases

### Phase A: Trust Store Extension (K2.1)
**Goal:** Per-capability trust tracking with Wilson LB

**Files:**
- EDIT `src/db/provider-trust-store.ts`:
  - Add `capability TEXT DEFAULT '*'` column to schema (backward compatible)
  - Change PRIMARY KEY from `(provider)` to `(provider, capability)`
  - Add `recordOutcome(provider, success, capability?)` — default capability='*'
  - Add `getProviderCapability(provider, capability): TrustRecord`
  - Add `evidence_hash TEXT` column for A4 compliance
  - Migration: add column if not exists (ALTER TABLE safe for SQLite)

- EDIT `src/orchestrator/priority-router.ts`:
  - Extend `selectProvider()` to accept optional `capability` filter
  - When capability provided, filter trust records by capability before Wilson LB ranking

- EDIT tests: update existing tests, add capability-keyed tests

**Gate:** G10 partially — trust tracks per-capability

### Phase B: Engine Selector (K2.2)
**Goal:** Trust-weighted engine selection wired into dispatch

**Create `src/orchestrator/engine-selector.ts`:**
```typescript
export interface EngineSelection {
  provider: string;
  trustScore: number;
  selectionReason: string;
}

export interface EngineSelector {
  select(routingLevel: RoutingLevel, taskType: string, requiredCapabilities?: string[]): EngineSelection;
}
```

**Logic:**
1. Get all providers from ProviderTrustStore
2. Filter by capability match (if requiredCapabilities provided)
3. Filter by minimum trust threshold for routing level: L0=0, L1=0.3, L2=0.5, L3=0.7
4. If MarketScheduler is active → delegate to market auction (solicit bids, run Vickrey)
5. Else → rank by `selectProvider()` (Wilson LB)
6. Fallback: use LEVEL_CONFIG default model
7. Emit `engine:selected` bus event

**Wiring (core-loop.ts):**
- After routing level determined, before dispatch:
  ```
  if (deps.engineSelector) {
    const selection = deps.engineSelector.select(routing.level, taskType, capabilities);
    routing = { ...routing, model: selection.provider };
    deps.bus?.emit('engine:selected', { taskId, provider, trustScore, reason });
  }
  ```
- Add `engineSelector?` to `OrchestratorDeps` interface
- Instantiate in `factory.ts`

**Gate:** G9 — higher-trust engine wins, G10 — trust-based selection operational

### Phase C: Concurrent Dispatch (K2.3)
**Goal:** ≥3 tasks execute in parallel, wall-clock < sum

**Create `src/orchestrator/worker/file-lock.ts`:**
```typescript
export class AdvisoryFileLock {
  tryAcquire(taskId: string, files: string[]): { acquired: boolean; conflicts: string[] };
  release(taskId: string): void;
}
```
Simple in-memory Map<filepath, taskId>. Advisory only — no OS-level locking.

**Create `src/orchestrator/concurrent-dispatcher.ts`:**
```typescript
export interface ConcurrentDispatcher {
  dispatch(tasks: TaskInput[]): Promise<TaskResult[]>;
  getActiveCount(): number;
}
```

**Logic:**
1. For each task: check file-lock conflicts → if conflict, queue behind conflicting task
2. Non-conflicting tasks dispatch in parallel via TaskQueue
3. Each task gets its own AgentContract (K1.2)
4. Collect results, release file locks
5. Return TaskResult[]

**Wiring:**
- Add `concurrentDispatcher?` to OrchestratorDeps
- Add `executeTaskBatch(tasks: TaskInput[]): Promise<TaskResult[]>` to core-loop exports
- Instantiate in factory.ts using existing TaskQueue + FileLock

**Gate:** G8 — 3 tasks concurrent, wall-clock < sum

### Phase D: MCP Client (K2.5)
**Goal:** Orchestrator can call external MCP tools, results verified by Oracle Gate

**Create `src/mcp/client.ts`:**
```typescript
export interface MCPClient {
  initialize(): Promise<void>;
  listTools(): Promise<MCPTool[]>;
  callTool(name: string, args: Record<string, unknown>): Promise<MCPToolResult>;
  shutdown(): Promise<void>;
}

export class MCPClientPool {
  constructor(configs: MCPServerConfig[], bus?: VinyanBus);
  getClient(serverName: string): MCPClient | undefined;
  callToolVerified(serverName: string, toolName: string, args: Record<string, unknown>, gate: OracleGate): Promise<VerifiedToolResult>;
}
```

**Logic:**
1. Wrap existing `MCPClientBridge` instances with lifecycle management
2. `callToolVerified()`: call tool → run result through Oracle Gate → return with verification status
3. Pool manages connect/disconnect lifecycle
4. Tool authorization: check AgentContract capabilities before allowing MCP tool call

**Wiring:**
- Add `mcpClientPool?` to OrchestratorDeps
- In agent-loop.ts tool execution: if tool matches MCP pattern → route to MCPClientPool
- Instantiate in factory.ts from config.mcp.client_servers[]

**Gate:** G12 — MCP tool call → oracle verification → verified result

### Phase E: A2A + Integration Tests
**Goal:** Cross-instance delegation works end-to-end

**Wiring:**
- In engine-selector: when all local engines at capacity → check A2A peers
- If peer available with sufficient trust → delegate via A2A transport
- Result returned through ECP → verified locally

**Integration test (`tests/integration/k2-gates.test.ts`):**
```typescript
describe('K2 Gate Criteria', () => {
  test('G8: 3 concurrent tasks, wall-clock < sum', async () => { ... });
  test('G9: higher-trust engine wins selection', () => { ... });
  test('G10: trust updates after success/failure', () => { ... });
  test('G11: A2A peer delegation round-trip', async () => { ... });
  test('G12: MCP tool call verified by oracle', async () => { ... });
  test('G13: all K1 gates still pass', async () => { ... });
});
```

## Constraints

- **Tech stack:** Bun, TypeScript strict, zod/v4 for validation, SQLite via bun:sqlite
- **A3 compliance:** ALL selection/routing/dispatch decisions are rule-based. ZERO LLM in governance path.
- **A5 compliance:** Trust tiers: deterministic > heuristic > probabilistic. Wilson LB uses verified outcomes only.
- **Backward compatible:** All new deps are optional (`?:`) in OrchestratorDeps. Existing single-task flow unchanged.
- **Naming:** camelCase functions, PascalCase types, kebab-case files
- **Testing:** `bun:test` framework, tests mirror src/ structure in tests/
- **Linting:** Biome (single quotes, 2-space indent, 120 char width, trailing commas)
- **DB:** SQLite self-initializing schemas, dual-write pattern (memory cache + SQLite best-effort)
- **EventBus:** Use `deps.bus?.emit()` for all cross-module events. Define event types in `src/core/bus.ts`.

## Verification Sequence

After ALL phases complete:
1. `bun run check` — zero type errors
2. `bun test tests/db/provider-trust-store.test.ts` — capability-level trust
3. `bun test tests/orchestrator/priority-router.test.ts` — capability-filtered selection
4. `bun test tests/orchestrator/engine-selector.test.ts` — trust-weighted selection
5. `bun test tests/orchestrator/concurrent-dispatcher.test.ts` — parallel dispatch
6. `bun test tests/mcp/client.test.ts` — MCP pool + verified calls
7. `bun test tests/integration/k2-gates.test.ts` — all G8-G13 gates
8. `bun run test` — full regression (all existing tests still pass)

## Output

For each phase: implement ALL files → get_errors → fix → run affected tests → move to next phase.
After all phases: run full test suite, report gate status.
