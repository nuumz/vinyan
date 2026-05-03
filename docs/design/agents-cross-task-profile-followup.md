# Follow-up: `/agents/:aid` cross-task agent profile

**Status:** Filed — NOT implemented in Phase 2 of the audit redesign. Tracked here as a deferred work item per user direction in Phase-2 approval message.

**Origin:** During Phase 2 of the six-level entity-hierarchy audit redesign (Session → Workflow → Task → Sub-Task → Agent → Sub-Agent), the user split the six audit URLs into "Phase 3: ship five" and "follow-up: ship the sixth". This document is the follow-up artifact for the sixth.

The five URLs that ship in Phase 3:
- `/sessions/:sid` — backed by `SessionProcessProjectionService` (landed in Phase 2.7)
- `/sessions/:sid/workflows/:wid` — workflowId === taskId alias; backed by `TaskProcessProjectionService` (existing)
- `/tasks/:tid` — backed by `TaskProcessProjectionService` (existing)
- `/tasks/:tid/subtasks/:stid` — sub-task is itself a TaskId; reuses task projection
- `/tasks/:tid/subagents/:said` — sub-agent === sub-task today; reuses task projection scoped via `byEntity.subAgentIds`

The deferred sixth URL: **`/agents/:aid`** — agent profile across all runs of one persona/worker/cli-delegate, spanning many tasks and sessions.

## Why this is a separate follow-up

`/agents/:aid` is the only URL that crosses the task boundary. Every other audit URL drills DOWN from a task; the agent profile aggregates UP across many tasks. The query pattern, projection shape, and indexing strategy are different enough that bundling them into Phase 3 would either bloat the PR or compromise the per-task work.

## Query pattern

Inputs:
- `agentId` — branded `PersonaId` (`developer`, `reviewer`, …) or `WorkerId` (`worker-claude-3-5-sonnet`, …) — uniquely names the agent
- Optional time window: `since`, `until` (epoch-ms)
- Optional session filter: restrict to one session or a small set
- Optional limit/cursor for pagination

Output:
- Profile metadata (persona id, vendor, capability tier, default trust)
- Recent runs — list of `{ taskId, sessionId, status, durationMs, completedAt }`, paginated, ordered by `completedAt DESC`
- Aggregated stats: total runs, success rate, avg duration, common failure classes, oracle pass rate, critic acceptance rate, tool call counts by tool, cap-token denial rate
- Last N audit-row samples per recent task (cap N at ~50 to keep payloads bounded)

Join graph:
1. `execution_traces.agent_id = ?` — primary index. Returns recent traces in time order.
2. For each trace, JOIN `task_events` to get the audit log scope (or read `TaskProcessProjection.byEntity` per task).
3. Aggregate stats across the trace set.

## Expected page surfaces

Vinyan-ui pages:

- `pages/agents.tsx` (existing) — currently a flat list of agent profiles with capability tier/trust badges. The follow-up adds:
  - "Recent runs" table per row: success / fail / escalated outcome chips, click-through to `/tasks/:tid` audit
  - Mini-aggregates: success rate sparkline, avg duration, top tools used
- `pages/agent-profile.tsx` (new) — dedicated detail page reachable from `/agents/:aid`:
  - Header: persona name, capability tier, trust tier, total runs, since-creation date
  - Tabs:
    - **Recent runs** — paginated trace list with status chips and audit drill-through
    - **Failure modes** — grouped by `failureReason` / `errorClass` from `execution_traces`
    - **Tool usage** — bar chart by tool name, success vs error split (consume `tools:executed` aggregates or per-task `byEntity.subAgentIds` rollups)
    - **Capability tokens** — recent denial events with rule id (consume `tool_call.capabilityTokenId` from the audit log)
    - **Provenance** — distinct policy versions / model ids the persona has run under

## Projection delta needed

A new `AgentProfileProjectionService`:

- **Inputs:** `agentId: PersonaId | WorkerId`, optional `since/until`, `limit`, `cursor`.
- **Stores read:** `TraceStore` (primary — time-ordered execution traces by `agent_id` index), `SessionStore` (resolve `sessionId` per trace), optional `TaskEventStore` (audit log samples).
- **Output type** (sketch):

  ```ts
  interface AgentProfileProjection {
    profile: { agentId: string; persona?: PersonaId; vendor?: string; capabilityTier: string; defaultTrust: AgentTrustTier };
    aggregates: {
      totalRuns: number;
      successRate: number;          // 0..1
      escalationRate: number;       // 0..1
      avgDurationMs: number;
      avgTokensConsumed: number;
      failureClasses: Record<string, number>;
      toolUsage: Record<string, { success: number; error: number; denied: number }>;
      capabilityTokenDenials: { ruleId: string; count: number }[];
      policyVersions: string[];
      modelIds: string[];
    };
    recentRuns: Array<{
      taskId: string;
      sessionId?: string;
      status: TaskLifecycleStatus;
      startedAt: number;
      completedAt?: number;
      durationMs?: number;
      // small audit-log preview to show in the row drawer (cap size)
      auditPreview?: AuditEntry[];
    }>;
    cursor?: string;
  }
  ```

- **Indexing:** `execution_traces` already has indexes on `agent_id`, `taskTypeSignature`, `outcome`, `timestamp`. The agent-profile path is `WHERE agent_id = ? ORDER BY timestamp DESC LIMIT ?`. Should be O(index).
- **Cost guard:** cap `recentRuns.length` at 50; aggregates roll up over the cap-bounded set so a chronic agent doesn't produce a megabyte response. Pagination via `cursor = <timestamp>:<traceId>`.
- **Audit log samples:** for each recent run, fetch the first 5 + last 5 audit rows from the task's projection (or skip when audit log absent). Bounded payload.

## Migration / index considerations

- `execution_traces.agent_id` already indexed (`idx_et_agent_id` per migration 001 squashed). No new index required for the recent-runs query.
- A potential follow-up index on `(agent_id, completedAt DESC)` would let the recent-runs query stop scanning earlier traces; defer until benchmarks show it matters.
- No new tables required. The audit-log samples ride on the existing `task_events` table.

## Out of scope for this follow-up

- Cross-agent comparison views (one-on-one matchups, pareto plots) — separate work, hooks into the same projection.
- Per-agent UI write paths (re-running with a different agent, archiving an agent's history) — out of scope here.
- Agent ranking or selection algorithms — that's the existing fleet-evaluator's job; this profile is read-only observability.

## Suggested PR sequence (when this is picked up)

1. Add `AgentProfileProjectionService` (new `src/api/projections/agent-profile-projection.ts`) + zod return-type guard.
2. Wire `GET /api/v1/agents/:aid/profile` route in `src/api/server.ts`.
3. Frontend: extend `pages/agents.tsx` with the recent-runs column; build `pages/agent-profile.tsx` for the detail page.
4. Cross-link from `<AuditView>` actor labels — clicking an actor named `worker-foo` jumps to `/agents/worker-foo`.

## Acceptance criteria for the follow-up

- A reviewer can land on `/agents/developer` and see: every recent run, the success/escalation rate, the top failure classes, the tools the persona uses most, and a list of capability-token denials with rule ids.
- Clicking a recent run takes the reviewer to `/tasks/:tid` (existing route).
- The route honours the same auth + rate-limiting middleware as `/api/v1/agents` today.
- One behaviour test: `agent-profile-projection.test.ts` against an in-memory SQLite seeded with two agents × five traces each.
- No regression on the existing `pages/agents.tsx` flat list.
