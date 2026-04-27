# Known Issues in Vinyan Agent

## Resolved (this session, 2026-04-27)

### 1. LLM Invocation Failure ✅
- **File**: `tests/orchestrator/core-loop-integration.test.ts` (test 4 ~line 122, test 9 ~line 190)
- **Symptom**: `traces[0].tokensConsumed === 0` despite an L1 task being dispatched.
- **Root cause**: The test asserted on `traces[0]`, but pre-routing comprehension phases (`core-loop.ts:692, 761`) record traces with `tokensConsumed:0` before the worker trace is appended. `traces[0]` was a comprehension trace, not the worker trace.
- **Fix**: Tests 4 and 9 now locate the worker trace via `traces.find((t) => t.taskId === 't-integration' && t.routingLevel >= 1)` (mirrors test 17's existing pattern).
- **Status**: ✅ Fixed.

### 2. Mutation Generation Failure ✅
- **File**: `tests/orchestrator/core-loop-integration.test.ts` (tests 2, 3 ~lines 95–113)
- **Symptom**: `result.mutations.length === 0` even though `result.status === 'completed'`.
- **Root cause**: The factory's `workerBootstrapPolicy` defaults to `'earn'` (Phase 4 governance — `factory.ts:447`), which registers freshly-discovered LLM providers as `probation`. The probation gate at `core-loop.ts:2773` then suppresses all mutations from probation workers (per I10). The test was registering mock providers that were instantly classified as probation. The previous note in this doc claiming the cause was `mock-provider.ts buildResponse` was incorrect — the actual diff in mock-provider.ts is purely cosmetic.
- **Fix**: The test file now wraps `createOrchestrator` to inject `workerBootstrapPolicy: 'grandfather'` — the documented test-fixture escape hatch (`factory.ts:224`). Same fix applied to `tests/orchestrator/core-loop-quality.test.ts`.
- **Status**: ✅ Fixed.

### 3. Trace Collection Failure ✅
- Same root cause and fix as #1. Resolved by the `.find()` pattern.
- **Status**: ✅ Fixed.

### 4. Model Invocation Tracking Failure ✅
- Same root cause and fix as #1. `modelUsed === 'none'` came from the comprehension trace at `traces[0]`, not the worker trace.
- **Status**: ✅ Fixed.

### 5. Routing Escalation Failure ✅
- **File**: `tests/orchestrator/core-loop-integration.test.ts` (test 14 ~line 277)
- **Symptom**: Only one routing level appeared in traces — escalation L1→L2→L3 wasn't happening.
- **Root cause**: The L0+oracle-rejection short-circuit in `phase-verify.ts:285` (added by the prior fix for #7) was overreaching: it returned `'escalated'` as soon as L0 verification failed, skipping the routing loop's natural escalation through L1/L2/L3.
- **Fix**: Narrowed the short-circuit to fire **only** when the caller pinned routing via `MIN_ROUTING_LEVEL:0`. Without that pin, control falls through to the routing loop which escalates levels properly. `phase0-compat.test.ts` (which uses `MIN_ROUTING_LEVEL:0`) still passes — the narrow case is preserved.
- **Status**: ✅ Fixed.

### 6. Working Memory Failure Tracking ✅
- **File**: `tests/orchestrator/core-loop-integration.test.ts` (test 13 ~line 248)
- **Symptom**: `result.escalationReason` was `'forced-oracle-rejection'` instead of including `'failed approaches'`.
- **Root cause**: Same as #5 — the L0 short-circuit returned the verifier's reason verbatim instead of letting execution reach the "all routing levels exhausted" exit at `core-loop.ts:2982`, which constructs the expected `"... N failed approaches recorded."` message.
- **Fix**: Same fix as #5 — the routing loop now reaches the exhaustion path, which builds the correct escalationReason.
- **Status**: ✅ Fixed.

### 7. Phase 0 Compatibility — Oracle Rejection Escalation ✅
- **File**: `tests/integration/phase0-compat.test.ts`
- **Status**: ✅ Fixed previously (5b7f541 base). Re-verified passing after the #5/#6 narrowing change.

### 8. SQLite I/O Errors (SQLITE_IOERR_VNODE) ✅
- **Files**: `src/db/trace-store.ts` (`updateShadowValidation`), `src/db/vinyan-db.ts`
- **Root cause**: Concurrent async `shadow:complete` handlers calling `UPDATE execution_traces` via bare auto-commit `.run()` collided with macOS WAL VFS locking.
- **Fix**:
  - `vinyan-db.ts`: added `PRAGMA busy_timeout = 5000` to the connection so transient `SQLITE_BUSY` waits for the lock instead of escalating to `SQLITE_IOERR_VNODE`.
  - `trace-store.ts`: wrapped `updateShadowValidation` in a `db.transaction(...).immediate(...)` so the writer claims the WAL lock up front; also added a best-effort `try/catch` so a transient I/O failure on best-effort metadata never aborts the active task.
- **Verified**: `tests/integration/oracle-gate.test.ts` (5/5 pass), `tests/integration/subprocess-persona-e2e.test.ts` (4/4 pass).
- **Status**: ✅ Fixed.

### 9. Smoke: mock-agent-loop timeout (98 s) ✅
- **File**: `tests/smoke/mock-agent-loop.test.ts`
- **Root cause**: Downstream of #10. The agent-loop spawned a subprocess without `VINYAN_PROXY_SOCKET`; the child exited at `agent-worker-entry.ts:1294`, but the parent waited indefinitely on its stdout.
- **Fix**: Same fix as #10 (synchronous precondition check). Test now completes in ~885 ms.
- **Status**: ✅ Fixed.

### 10. Subprocess Worker Bootstrap Issue ✅
- **File**: `src/orchestrator/agent/agent-loop.ts:990`
- **Root cause**: `runAgentLoop` always spawned `agent-worker-entry.ts`, but `agent-worker-entry.ts` hard-requires `VINYAN_PROXY_SOCKET`. When `deps.proxySocketPath` was absent (unit tests, mock setups), the child exited immediately while the parent hung on stdin — surfacing as a 98 s timeout instead of an actionable error.
- **Fix**: Added a synchronous precondition check at the top of `runAgentLoop`: if `deps.proxySocketPath` is missing, throw a clear error before `Bun.spawn`. The `phase-generate.ts` agent-loop catch then falls back to in-process single-shot dispatch (existing behavior). Also made `VINYAN_PROXY_SOCKET` env var unconditional now that the precondition guarantees presence.
- **Status**: ✅ Fixed.

### 11. Plugin Registration: tool map drift ✅
- **File**: `tests/orchestrator/plugin-init.test.ts` (test "enabled=true but no memory/skills flags")
- **Root cause**: The `session_search` tool was added later to `plugin-init.ts:194` and is auto-registered when `registerSessionSearch !== false` (default true). The test was authored before that and asserted `toolRegistry.size === 0` without disabling session_search.
- **Fix**: Test now passes `registerSessionSearch: false` explicitly when it wants an empty tool map.
- **Status**: ✅ Fixed.

### 12. A7 Gradient Signal — qualityScore not on traces[0] ✅
- **File**: `tests/orchestrator/core-loop-quality.test.ts` (4 tests)
- **Root cause**: Same dual issue as #2/#3 — mock providers gated by probation (no mutations → no qualityScore on output) AND `traces[0]` is the comprehension trace (no qualityScore on it; only the worker trace carries one).
- **Fix**: Wrapped `createOrchestrator` with `workerBootstrapPolicy: 'grandfather'` and changed every assertion to use `traces.find((t) => t.qualityScore !== undefined)` instead of `traces[0]`.
- **Status**: ✅ Fixed.

### 13. G6 soft-degrade routing cap (test 22) ✅
- **File**: `tests/orchestrator/core-loop-integration.test.ts` (test 22, ~line 601), `src/orchestrator/core-loop.ts`
- **Symptom**: `expect(result.trace.routingLevel).toBeLessThanOrEqual(2)` received `3` — soft-degrade fired and lowered routing to L2, but the routing loop's escalation walked it back up to L3.
- **Root cause**: Two issues:
  1. After soft-degrade lowered `routing.level` to L2, an oracle failure triggered the routing loop's escalation, which calls `riskRouter.assessInitialLevel({ ...input, constraints: [...input.constraints, MIN_ROUTING_LEVEL:nextLevel] })`. Since the original test set `MIN_ROUTING_LEVEL:3`, that constraint won the parser's first-match and re-routed to L3 — defeating the budget-saving purpose of soft-degrade.
  2. The terminal "all levels exhausted" trace at `core-loop.ts:2983` hardcoded `routingLevel: MAX_ROUTING_LEVEL` (always 3), masking the actual capped level.
- **Fix**:
  - `prepareExecution` now returns a `softDegradeCap?: RoutingLevel` whenever soft-degrade fires.
  - `executeTaskCore`'s `effectiveMaxLevel` is `Math.min(baseMaxLevel, prep.softDegradeCap)` so escalation breaks at the cap instead of walking back up.
  - Terminal escalation trace's `routingLevel` is now `routing.level` (the actual last-attempted level), not hardcoded `MAX_ROUTING_LEVEL`.
- **Status**: ✅ Fixed. Test 22 passes, no regressions in test 21 / 23 (G6 sister tests).

## Open / Out of scope

### Smoke: real-LLM tests (env-gated)
- **Files**: `tests/smoke/real-task.test.ts:83`, `:122`
- **Status**: Not broken — env-dependent. Require `ANTHROPIC_API_KEY` or `OPENROUTER_API_KEY`. Document as `test:smoke` requires a real provider key.

### E2E Benchmarks: timeouts on multi-file reasoning
- **Status**: Not reproduced this session. Requires real LLM API keys and the `test:benchmark` runner. Needs a separate triage pass with a concrete repro: which fixture, which model, what wall-clock budget. Without that, no actionable fix possible.

### W2 Plugin Integration Timeout
- **Status**: Not reproduced this session. The W2 PluginRegistry tests (`plugin-init.test.ts`, `plugin-init-gateway.test.ts`) all pass after fix #11. If a separate W2 integration test exists (not in this repo's test tree), the reporter should attach the failing test name + stack so it can be diagnosed.
