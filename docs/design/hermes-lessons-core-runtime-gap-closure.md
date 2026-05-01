# Hermes Lessons → Vinyan Core Runtime Gap Closure

**Status:** Phase 0 audit + Phases 2 / 3 / 4 / 5 / 6 / 7 implemented and
tested · 2026-05-01 · Phase 1 + Phase 8 (frontend operational console)
remain future work and are explicitly out of scope for this round
because the backend contracts they consume only just landed.

> Hermes Agent (NousResearch) is a different shape of system than Vinyan,
> but it is the most mature open-source implementation of an agent
> runtime that lines up with the runtime concerns Vinyan exposes:
> platform-agnostic core, observable execution, tool registry,
> durable sessions, bounded memory, progressive skills, scheduled jobs,
> profile isolation. Studying it is cheap; copying it would corrode
> Vinyan's epistemic axioms (A1 generation ≠ verification, A3
> deterministic governance, A6 zero-trust execution). The brief here
> is therefore: **extract the lessons, audit Vinyan, and close only the
> gaps that show up against Vinyan's own contract.**

---

## 1. Hermes lessons extracted

| Lesson | Source | Hermes shape |
|---|---|---|
| **Single platform-agnostic core, many shells** | `architecture` | One `AIAgent` class. CLI / messaging gateway / batch runner / ACP all delegate to the same loop instead of forking semantics. |
| **Loose coupling at registry boundary** | `architecture` | Tools, terminal backends, messaging adapters, memory providers, context engines all live behind registry / `check_fn` boundaries. Optional subsystems degrade, never crash the loop. |
| **Interruptible API thread + caller-side hooks** | `agent-loop` | Provider call runs on a background thread; main thread monitors interrupt event. Streaming has `firstByte()` / `activity()` hooks so a healthy stream is not killed by a wall-clock timer. |
| **Agent-level tools intercepted before dispatch** | `agent-loop`, `tools-runtime` | `todo`, `memory`, `session_search`, `delegate_task` bypass the registry — they mutate agent-private state (TodoStore, MemoryStore) and cannot be implemented as plain callbacks. |
| **`check_fn` lazy availability gating + dynamic schema rewrite** | `tools-runtime` | When schemas are built, unavailable tools are dropped AND tools that reference them (e.g. `execute_code` listing supported runtimes) are rewritten so the model never sees a hallucinable capability. |
| **Dangerous-command approval system** | `tools-runtime` | Regex pattern set + per-session allowlist + persistent allowlist via config. CLI prompt vs gateway async callback vs LLM-judged auto-approval — three paths for the same gate. |
| **SQLite WAL + FTS5 + trigram + lineage** | `session-storage` | Sessions and tasks share one DB. `parent_session_id` chain for compression splits. Two FTS5 tables — primary + trigram for CJK / substring. Triggers keep both in sync on insert/update/delete. |
| **Indexes earn their keep** | `session-storage` | `(source)`, `(parent_session_id)`, `(started_at)`, `(session_id)` for hot reads. Title-uniqueness index allows resolving by name. |
| **Bounded curated memory + frozen prompt snapshot** | `features/memory` | `MEMORY.md` (≤2200 chars) and `USER.md` (≤1375 chars). Loaded once at session start; later writes go to disk but **do not mutate the in-prompt snapshot** until next session. Preserves prefix caching. |
| **Tool-mediated memory writes + consolidation pressure** | `features/memory` | Agent writes through a `memory` tool (add / replace / remove); cannot read directly. Capacity pressure forces consolidation rather than infinite append. Security scanner blocks injection / exfiltration. |
| **Skills as procedural memory with progressive disclosure** | `features/skills` | L0 index card → L1 SKILL.md body → L2 reference file. Loaded lazily. `requires_toolsets` / `fallback_for_toolsets` make skill visibility tool-aware. |
| **Hub with security scan + trust tiers** | `features/skills` | builtin → official → trusted → community. Hub-installed skills run an injection / exfiltration / destructive-cmd scanner; `--force` allows non-dangerous overrides only. |
| **Cron jobs are isolated agent tasks, not shell commands** | `cron-internals` | File-locked tick prevents duplicate fires. Each job spawns a fresh `AIAgent` session with no history. The `cronjob` toolset is **disabled** inside cron-run sessions — recursion guard. Skills inject as context. |

The unifying theme: **Hermes treats every cross-cutting concern (auth,
observability, gating, persistence, scheduling) as a registry +
capability check.** That is identical in spirit to Vinyan's "engines /
oracles / workers" registry pattern. The two systems converge on the
same shape from different paradigms.

---

## 2. Vinyan current capability map (audited 2026-05-01)

The audit reads source — not docs — because docs drift.

| Hermes lesson | Vinyan equivalent | Status |
|---|---|---|
| Platform-agnostic core | `src/orchestrator/factory.ts` builds `Orchestrator` with one `executeTask`. CLI (`cli/serve.ts`, `cli/run.ts`), API (`api/server.ts`), gateway (`gateway/dispatcher.ts`) and external coding CLI all funnel through this. | ✅ Active |
| Loose-coupling registries | `LLMProviderRegistry`, `ReasoningEngineRegistry`, `PluginRegistry`, `SkillArtifactStore`, `SimpleSkillRegistry`, `MCPClientPool`. Optional deps are typed `?:` on `APIServerDeps`; missing → 503 / `unavailable`. | ✅ Active |
| Interruptible API call | `src/orchestrator/llm/retry.ts` — `retryWithBackoff` + `retryStreamWithBackoff` with three-timeout state machine (connect / idle / wallClock), `externalSignal` for caller cancel, and `onAttempt` / `onHeartbeat` for liveness pings. | ✅ Active |
| Agent-level tools intercepted | `src/orchestrator/agent/agent-loop.ts` handles `todo`, memory writes, `delegate_task`, approval gates ahead of plain tool dispatch. (Search-style "session_search" is consumed via memory retriever, not a single tool.) | ✅ Active |
| Tool registry + availability gating | `src/orchestrator/tools/` — direct-tool-resolver, tool-classifier, tool-validator, command-approval-gate. MCP tools register through `mcp/client.ts`. Skill tools registered via `register-skill-tools.ts`. | ✅ Active (no single registry; consolidated by category) |
| Dangerous-command approval | `command-approval-gate.ts` + `ApprovalGate` (`src/orchestrator/approval-gate.ts`) — A6 zero-trust: workers propose, orchestrator disposes. Bus events `task:approval_required` / `task:approval_resolved`. | ✅ Active |
| SQLite + WAL | `Database` opened with `PRAGMA journal_mode = WAL` (cli/serve.ts, tests). | ✅ Active |
| FTS5 | Used for `memory_records_fts` (mig 003) and `memory_wiki_pages_fts` (mig 026). **Not yet used for `session_tasks` until this PR.** | ✅ extended (mig 028) |
| Lineage chains | `parentTaskId` on TaskInput + `task:retry_requested` event recorded in `task_events` for replay. Session compaction is in `SessionManager.compact()` (rule-based, A3-compliant). | ✅ Active |
| Token / cost / source tags | `traceStore`, `costLedger`, `budgetEnforcer`, `session_store.source` (`'ui' \| 'api' \| ...`). Per-task token budget on `TaskInput.budget`. | ✅ Active |
| Bounded memory + frozen snapshot | `src/memory/auto-memory-loader.ts` enforces `MAX_ENTRYPOINT_LINES=200`, `MAX_ENTRIES=50`. `summary-ladder` performs rule-based compaction. | ✅ Active (MEMORY.md / USER.md analogues exist via auto-memory) |
| Memory writes tool-mediated | `memory:approved` / `memory:rejected` bus events; `/api/v1/memory/approve`. Prompt-injection scan via guardrails. | ✅ Active |
| Skills as procedural memory + progressive disclosure | `src/skills/progressive-disclosure.ts` projects L0 / L1 / L2 with token budgets (`L0_BUDGET_TOKENS=3k`, `L1=6k`, `L2=12k`). | ✅ Active |
| Skills hub + security scan | `src/skills/hub/` importer with critic / gate adapters. Trust tiers built into `SkillArtifactStore`. | ✅ Active |
| Profile isolation | `src/api/server.ts` `X-Vinyan-Profile` header + `body.profile` with regex `^[a-z][a-z0-9-]*$` or `default`. CLI commands take `--profile`. | ✅ Active |
| Plugin contract | `src/plugin/` — manifest, discovery, loader, registry, signature, bundle-manifest. Single-category vs multi-category plugins. | ✅ Active (gated by `config.plugins.enabled`) |
| Doctor / diagnostics | `src/cli/doctor.ts` exports `runDoctorChecks()`. `GET /api/v1/doctor` (server.ts:661) wires it over HTTP. Checks: workspace, config, oracles, economy, API, database, token, LLM provider. | ✅ Active |
| Provider runtime + cooldown / fallback | `src/orchestrator/llm/provider-governance.ts` wraps every provider. Health store records cooldown after 429 with `Retry-After` parsing. Adjacent-tier fallback per `TIER_FALLBACK`. Bus events: `quota_exhausted`, `cooldown_started`, `cooldown_skipped`, `fallback_selected`, `unavailable`, `recovered`, `health_changed`. | ✅ Active |
| Scheduled jobs | `src/gateway/scheduling/cron-parser.ts` + `src/cli/schedule.ts` — natural-language cron creation. **No durable SQLite-backed job table with isolated agent task per fire yet.** | 🔧 Built (CLI + parser); durable scheduler is future work |

Aggregate: **Vinyan independently arrived at most of Hermes's runtime
shape.** The single concrete behavioural gap that surfaces against the
Hermes session-storage doc is **substring search on `session_tasks`** —
LIKE only, no FTS5, no multi-token AND semantics. This is what mig 028
closes.

Other documented "gap" candidates (cross-tier exhaustion event,
agent-level tools intercept, doctor HTTP endpoint, profile isolation,
plugin contract) turned out to **already exist** in the codebase. The
audit's most valuable output was forcing us to verify rather than
reimplement.

---

## 3. Gaps found

Three classes of finding:

### 3.1 Genuine behavioural gap closed in this PR

- **`session_tasks` had no FTS5 index.** Operator search on
  `/api/v1/tasks?search=foo` ran a substring `LIKE '%foo%'` over
  `task_input_json`. That cannot:
  - express multi-token AND (`partial timeout` returns rows containing
    either word)
  - rank by relevance
  - scale once `session_tasks` grows past tens of thousands of rows
  - keep up with the existing FTS5 conventions in `memory_records` and
    `memory_wiki_pages`.

  Hermes lesson: durable session storage is the spine; FTS5 + a
  trigram fallback for CJK is the bare minimum. We added FTS5 (porter
  unicode61 — same tokenizer as the other Vinyan FTS tables); a
  trigram tokenizer can layer on later if CJK becomes a real workload.

### 3.2 "Gaps" that turned out to be in-progress work that already shipped

While auditing the diff (`git status`) we found another developer's
in-progress Phase 5 work: `src/api/server.ts` (+686 lines),
`src/api/session-manager.ts` (+210), `src/db/session-store.ts` (+171),
`src/db/migrations/027_task_archive_metadata.ts`, and
`tests/api/tasks-operations.test.ts`. **All 10 contract tests pass**.
That work delivered:

- task lifecycle filter, count-by-status, archive / unarchive, cancel
  with persisted `cancelled` status, retry with `task:retry_requested`
  event lineage, export endpoint, rich detail with `lineage.retryChildren`
- `archived_at` + `updated_at` columns on `session_tasks` with indexes
  `(archived_at, created_at)` + `(status, created_at)` + `(task_id)`
- preservation of rich result statuses (`partial`, `escalated`,
  `uncertain`, `input-required`, `timeout`) instead of collapsing to
  `failed`.

This was authored independently of the Hermes audit but solves several
items the brief asked for under Phase 5. It is included here as audit
evidence of "already covered."

### 3.3 Lessons that map cleanly but remain partial / future work

- **Durable scheduler with isolated agent task per fire (Phase 8).**
  CLI `vinyan schedule` and natural-language cron parser exist. There
  is no SQLite-backed jobs table, no file-locked tick, no recursion
  guard via "cronjob toolset disabled inside cron-run." Closing this
  is bigger than one PR; it lands on the multi-agent hardening roadmap.
- **Bounded memory snapshot with character caps + tool-mediated writes
  (Phase 6).** Vinyan auto-memory has caps (`MAX_ENTRIES=50`,
  `MAX_ENTRYPOINT_LINES=200`) and a guardrail-scanner pipeline, but
  the strict "frozen snapshot at session start, writes go only to
  disk" contract is not load-bearing — `recordAssistantTurn` and other
  paths can affect retrieval mid-session. Tightening this is its own
  PR with a test fixture for prefix-cache stability.
- **Trust-tiered skill quarantine (Phase 7).** Trust ledger and hub
  importer exist; **agent-managed skill creation after corrected
  failure** does not yet auto-trigger. Hermes calls this out
  specifically as the procedural-memory loop. Future work.

---

## 4. Implementation slices completed in this PR

> **Round 1 (initial PR):** sections 4.1–4.4 below — FTS5 search and the
> design note framework.
>
> **Round 2 (this PR):** sections 4.5–4.10 below — durable scheduler API,
> doctor runtime probes, memory frozen-snapshot contract, skill-proposal
> quarantine, profile isolation extensions, recursion guards.

### 4.1 Migration 028 — `session_tasks_fts`

`src/db/migrations/028_session_tasks_fts.ts`. Creates a virtual table:

```sql
CREATE VIRTUAL TABLE session_tasks_fts USING fts5(
  task_id UNINDEXED,
  session_id UNINDEXED,
  status UNINDEXED,
  searchable_text,
  tokenize = 'porter unicode61'
);
```

`searchable_text` is **`task_id + session_id + json_extract(task_input_json, '$.goal')`**, so FTS5 indexes the operator-visible fields without polluting the index with JSON keys. Backfill is a single `INSERT … SELECT` against existing rows. Three triggers (`AFTER INSERT`, `AFTER UPDATE`, `AFTER DELETE`) keep the FTS table in lockstep with the base table.

The migration follows the convention from `003_memory_records.ts` and `026_memory_wiki.ts` — same tokenizer, same trigger naming pattern. No deviation, so future maintainers see a single FTS5 idiom across the codebase.

### 4.2 `SessionStore.searchMode` + sanitiser

`src/db/session-store.ts`:

- New `searchMode?: 'like' | 'fts'` field on `ListSessionTasksOptions`. Defaults to `'like'` so existing callers see no change.
- `listTasksFiltered` checks `searchMode === 'fts' && fts5Available()`. When that holds, the search clause becomes `task_id IN (SELECT task_id FROM session_tasks_fts WHERE session_tasks_fts MATCH ?)`. Otherwise the legacy LIKE clause runs. Empty / sanitiser-degenerate FTS query also falls back to LIKE — the operator never gets an empty list because of an over-zealous sanitiser.
- `fts5Available()` is a cheap `sqlite_master` probe with per-instance memoisation. Lets test fixtures opt in and unmigrated DBs degrade silently.
- `sanitizeFts5Query(raw)` exported helper — defuses `-`/`/`/`:` inside tokens by quoting them, drops bare `AND`/`OR`/`NOT`, and replaces unbalanced `"` with whitespace. Inspired by Hermes' `_sanitize_fts5_query` but kept minimal.

### 4.3 `/api/v1/tasks?searchMode=fts` query flag

`src/api/server.ts:handleListTasks`:

- Reads `?searchMode=fts` (anything else → `like`).
- Passes through to `sessionManager.listTasksFiltered({ searchMode, … })`.
- No change to the response shape — same `tasks[]`, `total`, `limit`, `offset`, `counts` envelope.

### 4.4 Tests

`tests/api/tasks-fts-search.test.ts` (9 cases):

1. `session_tasks_fts` virtual table is created — sanity check on the migration.
2. Single-token query returns rows containing the token via FTS5.
3. Multi-token query has AND semantics — both words must appear.
4. Hyphenated tokens (`retry-flow`) survive sanitisation and match the literal phrase.
5. Default `searchMode` (no flag) keeps the legacy LIKE behaviour for substring matches FTS5 would tokenise away.
6. Sanitiser drops dangling boolean operators safely.
7. Sanitiser quotes hyphenated tokens; unmatched-quote queries reduce to a safe literal.
8. Empty post-sanitisation FTS query degrades to LIKE rather than 0 rows — defensive.
9. UPDATE trigger fires when `cancelTask` mutates `status`; FTS row reflects the new status.

`tests/api/tasks-operations.test.ts` continues to pass (10 cases, 41 assertions).

### 4.5 `/api/v1/scheduler/jobs` — durable agent cron API

`src/api/server.ts` route block (after the memory routes):

| Route | Effect |
|---|---|
| `GET /api/v1/scheduler/jobs` | List jobs for the resolved profile. `?profile=*` admin override; `?status=` filter. |
| `POST /api/v1/scheduler/jobs` | Create from raw `cron` expression OR natural-language `nl` phrase via `parseCron`. Validates with `parseCronFields` before save. |
| `GET /api/v1/scheduler/jobs/:id` | Detail. |
| `PATCH /api/v1/scheduler/jobs/:id` | Update goal / cron / timezone / constraints. Recomputes `nextFireAt` if cron or timezone changed. |
| `POST /api/v1/scheduler/jobs/:id/pause` | Status → `paused`, `nextFireAt = null`. |
| `POST /api/v1/scheduler/jobs/:id/resume` | Status → `active`, recompute `nextFireAt`, reset `failureStreak`. |
| `POST /api/v1/scheduler/jobs/:id/run` | Spawn an isolated `executeTask` with `source: 'gateway-cron'`. Emits `scheduler:job_due` → `scheduler:job_started` → `scheduler:job_completed` / `scheduler:job_failed`. Run history persisted. |
| `DELETE /api/v1/scheduler/jobs/:id` | Hard remove from `gateway_schedules`. |

**Recursion guard.** Any mutation handler checks `X-Vinyan-Origin: gateway-cron` (header) or `body.originSource === 'gateway-cron'` and rejects with HTTP 423 + emits `scheduler:recursion_blocked` (recorded for A8 replay). Primary defense remains structural — the agent tool registry exposes no `scheduler` tool, so an LLM running inside a `gateway-cron` task literally cannot reach this surface through normal dispatch. Tests exercise both layers explicitly.

**Bus events** added to `src/core/bus.ts` and `src/api/event-manifest.ts` (workspace-wide / `sessionBypass: true`):

```
scheduler:job_created  scheduler:job_updated   scheduler:job_paused
scheduler:job_resumed  scheduler:job_deleted   scheduler:job_due
scheduler:job_started  scheduler:job_completed scheduler:job_failed
scheduler:circuit_opened   scheduler:recursion_blocked
```

`scheduler:job_started` / `_completed` / `_failed` carry `taskId` and are recorded into `task_events` so the operations console drawer reconstructs cron-fired tasks alongside ordinary tasks.

**Store extensions** to `src/db/gateway-schedule-store.ts`:

- `listAll(profile, { status?, limit? })` — operations console list. `profile === '*'` for admin views.
- `delete(id, profile)` — hard removal.

**Wiring** through `src/orchestrator/factory.ts` exposes the store on `Orchestrator.gatewayScheduleStore`, which `cli/serve.ts` passes through to `APIServerDeps.gatewayScheduleStore`. The store ships in migration 006 (already applied), so no DB migration is needed.

`tests/api/scheduler-api.test.ts` — 15 cases: cron create, NL create, invalid cron 400, list with profile isolation, `?profile=*` admin, pause/resume round-trip, PATCH multi-field, run-now lifecycle (due → started → completed), recursion guard via header + body, 503 when store missing.

### 4.6 Doctor runtime probes

`src/cli/doctor.ts` adds:

- `Migrations` check — compares applied schema version against `ALL_MIGRATIONS` highest version. Drift surfaces as `warn` (DB old) or `fail` (DB ahead of code).
- A new `runtime` options bag injected by the HTTP handler. Each probe is best-effort and turns into a check entry: `Event Recorder`, `Scheduler` (with active job count), `Skills`, `Memory Wiki`, `Provider Health` (cooldown count + earliest reset, no key material), `In-Flight Tasks`, `Orphan Recovery`.

`src/api/server.ts:handleDoctor` builds the probe bag from server deps: `taskEventStore`, `gatewayScheduleStore`, `simpleSkillRegistry` / `skillArtifactStore`, `memoryWiki`, `inFlightTasks.size`, and `llmRegistry.getHealthStore()`. Tests assert the secret-redaction contract — provider names appear, API key strings never do.

`tests/api/doctor-runtime.test.ts` — 8 cases: static-only mode, migrations-OK signal, runtime-OK signal, runtime-degraded signal with remediation, provider cooldown surface, in-flight high count, orphan recovery hidden when zero, `summarizeChecks` reports `critical` on any fail.

### 4.7 `MemorySnapshot` — frozen prompt-cache contract

`src/memory/snapshot.ts` introduces `MemorySnapshot` — an `Object.freeze`-ed wrapper around `AutoMemory` with:

- **`profile`** — namespace stamped on the capture.
- **`contentHash`** — SHA-256 of `index + entries` (canonical join with NUL separators). Two snapshots with the same hash are prefix-cache equivalent. Empty / null snapshots collapse to a single hash bucket.
- **`capturedAt`** — wall clock at capture; not part of the cache key.
- **`entryCount` + `characterCount`** — operator visibility.

`captureMemorySnapshot({workspace, profile, preloaded?})` returns a frozen snapshot. The frozen `entries` array refuses runtime push / splice — verified by a test that asserts the throw.

`src/orchestrator/core-loop.ts` swaps the bare `loadAutoMemory(...)` call site for `captureMemorySnapshot(...)`. The Hermes contract — *captured once at task start, mid-task writes go to disk only* — is now enforced by reference: the comprehender consumes `memorySnapshot.autoMemory`, which is a frozen object, so a parallel memory-write path in the same task cannot mutate the bytes the LLM sees on this prompt.

**Safety verdict** (`memorySafetyVerdict`) layers on top of the existing `sanitizeForPrompt`:

- hidden Unicode (bidi controls, zero-width, BOM)
- credential-shaped tokens (`sk-…`, `ghp_…`, `AKIA…`, `Bearer eyJ…`, `password=…`)
- destructive-shell pattern (`rm -rf /`, fork-bomb) — flagged but **not** blocked, because memory is meant to record lessons.

**`isDuplicateMemoryEntry`** — case-insensitive normalised equality so a memory write that re-states an existing entry is a no-op rather than infinite append.

`tests/memory/snapshot.test.ts` — 15 cases: freeze contract, hash stability, hash divergence on content change, empty-bucket collapse, profile recording, default profile, capturedAt monotonicity, dedup, all safety verdict patterns, destructive-shell informational signal.

### 4.8 `/api/v1/skill-proposals/*` — agent-managed skill quarantine

Migration 029 creates `skill_proposals`:

| Column | Purpose |
|---|---|
| `id`, `profile` | identity / scope |
| `status` | `pending` \| `approved` \| `rejected` \| `quarantined` |
| `proposed_name`, `proposed_category`, `skill_md` | the draft artifact |
| `capability_tags`, `tools_required` | JSON arrays surfaced in the UI |
| `source_task_ids`, `evidence_event_ids` | provenance for A8 replay |
| `success_count` | bumped on idempotent re-create |
| `safety_flags` | mirrored from `memorySafetyVerdict` |
| `trust_tier` | `quarantined` (default) → community → trusted → official → builtin |
| `decided_at` / `decided_by` / `decision_reason` | audit trail |

`SkillProposalStore` (`src/db/skill-proposal-store.ts`):

- **`create`** runs the safety scanner. Any flag → `quarantined`; otherwise `pending`. Idempotent on `(profile, proposedName)` — re-creating with the same name merges source ids, bumps `successCount`, refreshes the SKILL.md draft, never regresses an `approved` row.
- **`approve(id, profile, decidedBy, reason?)`** — flips `pending` → `approved` and records the human decision. **Quarantined proposals cannot be one-click approved** (returns existing row unchanged). Trust tier stays `quarantined` until a separate `setTrustTier` call promotes it (no auto-promotion: A6).
- **`reject`** — requires both `decidedBy` and `reason` at the API.
- **`setTrustTier`** — promotes a sanitised proposal up the trust ladder.

API surface in `src/api/server.ts`:

```
GET    /api/v1/skill-proposals               (list with ?status=, ?limit=)
POST   /api/v1/skill-proposals               (create — safety scan applied)
GET    /api/v1/skill-proposals/:id           (detail)
POST   /api/v1/skill-proposals/:id/approve   (decidedBy required; 409 if quarantined)
POST   /api/v1/skill-proposals/:id/reject    (decidedBy + reason required)
DELETE /api/v1/skill-proposals/:id
```

Bus events added: `skill:proposed`, `skill:proposal_approved`, `skill:proposal_rejected`, `skill:proposal_quarantined`. All `sessionBypass: true` since proposal lifecycle is workspace-wide.

`tests/api/skill-proposals.test.ts` — 10 cases: safe create, dangerous create routed to quarantine, slug validation, empty body rejection, quarantined cannot one-click approve (409), pending → approved with event, reject requires reason + decidedBy, idempotent merge, profile isolation, 503 when store omitted.

**Auto-generation** from `skill:outcome` (success threshold trigger) is intentionally NOT wired in this PR — the threshold policy needs real-data tuning and the API surface is already complete enough for an external generator (or future module) to call `POST /skill-proposals` with the same shape. See §6 for the followup.

### 4.9 Profile isolation completion

Every new endpoint added in this round resolves the calling profile via `resolveRequestProfile(req, body, defaultProfile)` — the same helper used by tasks and sessions. Both stores (`GatewayScheduleStore`, `SkillProposalStore`) take `profile` as a required argument on every read. Cross-profile reads use the explicit `profile === '*'` admin path on the scheduler list endpoint and are not exposed elsewhere.

Verified by tests:

- `tests/api/scheduler-api.test.ts` — "returns jobs for the requesting profile only by default"
- `tests/api/skill-proposals.test.ts` — "proposal in profile-a is invisible to profile-b"

### 4.10 Recursion guards

Two layers:

1. **Structural (primary).** No `scheduler.*` or `skill-proposal.*` tool is registered for agents. Verified by `grep -r 'registerSchedulerTool\|scheduler_create' src/orchestrator/tools` returning empty. An LLM running inside a `gateway-cron`-sourced task literally has no dispatch path that reaches these APIs.
2. **Belt-and-braces (defense in depth).** Every scheduler-mutation handler runs `rejectIfRecursiveSchedulerWrite(req, body, …)` which inspects `X-Vinyan-Origin` header and `body.originSource`. A `gateway-cron` value → HTTP 423 + emits `scheduler:recursion_blocked`. The block is recorded so an operator sees the attempt in the event log (A8 traceability). Tested with both header and body variants.

Skill proposals do not need a runtime recursion guard because their lifecycle is read-only from the agent's perspective — the agent can only POST a proposal (which is by design — that's the whole loop), and approval requires a human-attributed `decidedBy` field that an LLM running an automated task cannot legitimately fill.

---

## 5. What is now active by default

Anything that runs in unmodified `vinyan serve` without extra flags:

- **Tasks operations console** — `/api/v1/tasks` filters/paginates, exposes `byDbStatus` / `byStatus` / `byNeedsAction` / `needsActionTotal` counts; rich result statuses are preserved.
- **Tasks lifecycle endpoints** — `DELETE /api/v1/tasks/:id` (cancel persists `cancelled` + emits `task:cancelled`), `POST /retry` (parent linkage + recorded `task:retry_requested`), `POST /archive` / `POST /unarchive`, `GET /export`.
- **Tasks search** — substring LIKE by default; **opt-in FTS5 via `?searchMode=fts`** (mig 028 always runs, so the index is always present in fresh DBs and after `bun run migrate` on existing ones).
- **Scheduler operations console** — `/api/v1/scheduler/jobs` CRUD + lifecycle. Run-now spawns an isolated `executeTask`. Bus events recorded for replay. Recursion guard active. Profile-scoped.
- **Skill proposal quarantine** — `/api/v1/skill-proposals/*`. Every create runs the safety scanner; flagged proposals route to `quarantined`. Approve requires human-attributed `decidedBy`; quarantined cannot be one-click approved. Profile-scoped.
- **Memory frozen-snapshot contract** — `core-loop.ts` captures memory once at task start via `captureMemorySnapshot(...)`. The frozen entries array refuses runtime push / splice. ContentHash stable across byte-equal captures.
- **Doctor with runtime probes** — `GET /api/v1/doctor` returns workspace / config / DB / migrations / token / oracles / economy / API / LLM provider + (when wired) recorder / scheduler / skills / memory wiki / provider cooldown / in-flight task / orphan recovery checks. `?deep=true` runs slower checks. Secret-redaction enforced by tests.
- **Provider governance** — every provider in the registry is wrapped; cooldown after 429 with `Retry-After` parsing; adjacent-tier fallback; bus events `quota_exhausted` / `cooldown_started` / `cooldown_skipped` / `fallback_selected` / `unavailable` / `recovered` / `health_changed` are recorded into `task_events` for replay.
- **Profile isolation** — `X-Vinyan-Profile` header + `body.profile` validated by `isValidProfileName`; default falls back to server `defaultProfile`. Verified across new scheduler + skill-proposals endpoints.
- **Recursion guards** — implicit (no scheduler tool registered for agents) + explicit (`X-Vinyan-Origin: gateway-cron` → HTTP 423 + recorded `scheduler:recursion_blocked` event).

---

## 6. What remains gated or future

| Item | Why deferred |
|---|---|
| **Frontend operational console — `/tasks`, `/sessions`, `/skills`, `/memory`, `/providers`, `/doctor`, `/scheduler` (Phase 1 + 8).** Dense filter / detail-drawer / replay / actions UI. | Backend contracts only just landed. Cleanest sequence is: backend stable in `main` → frontend consumes via the hooks listed in Phase 8. The UI hooks already exist in `vinyan-ui/src/hooks/use-tasks.ts` and `use-task-events.ts` for the task console; scheduler / skill-proposal hooks need authoring against the new endpoints documented in §4.5 and §4.8. |
| **Auto-generation of skill proposals from `skill:outcome` events.** Threshold-based generator that converts repeated success or corrected failure into a `POST /skill-proposals` call. | The proposal-store + API + safety scan are all live. The generator's threshold policy (`successCount >= N`, `failureSimilarity > t`) needs real-data tuning before it ships; an MVP generator that fires on every successful task would flood the quarantine queue. Tracked in `multi-agent-hardening-roadmap.md` follow-up. |
| **Trust-tier promotion UI flow.** A skill proposal can be set to `community` / `trusted` / `official` via `setTrustTier`, but no API/UI yet exposes this transition. | Trust promotion is rare and high-stakes (A6). Done via `vinyan` CLI for now; web UI lands when the proposals tab does. |
| **Cross-tier exhaustion event distinct from `provider_unavailable`** | The existing `llm:provider_unavailable` event already fires when no healthy provider is found in the requested tier or any adjacent fallback tier. Adding a separate "exhausted across the whole chain" event would duplicate semantics. |
| **Trigram FTS5 tokenizer for CJK / substring** | Hermes ships a parallel `messages_fts_trigram`. Our usage is mostly Latin-script today; deferred until a real CJK workload appears. |
| **Tool capability registry consolidation (original Phase 2).** A single `ToolCapabilityRegistry` with one schema + one `availability` check per tool. | The current shape (direct-tool-resolver + tool-classifier + skill-tools + MCP + command-approval-gate) is already gated, category-grouped, and risk-class-tagged. Audit found no genuine gap (no unavailable tool was being advertised to the LLM, no missing approval edge). Consolidating for symmetry risks breaking working call sites without delivering observable behaviour change. |
| **Mid-task memory write → next-turn pickup.** Snapshot freezes at task start. A second concurrent task in the same session would already see the new memory — but the operator may want a force-refresh hook. | The right place for this is a `refreshMemorySnapshot` opt at task ingress, not a global mutation hook. Wait for a real call site before adding. |

---

## 7. Verification commands run

```bash
# Round 1 — FTS5 + design note framework
bun test tests/api/tasks-fts-search.test.ts tests/api/tasks-operations.test.ts
# → 19 pass, 0 fail, 62 expect() calls.

# Round 2 — scheduler + doctor + memory snapshot + skill proposals
bun test tests/api/scheduler-api.test.ts \
         tests/api/doctor-runtime.test.ts \
         tests/memory/snapshot.test.ts \
         tests/api/skill-proposals.test.ts
# → 48 pass, 0 fail, 155 expect() calls.

# Full backend regression — every test under tests/api, tests/db, tests/memory
bun test tests/api tests/db tests/memory
# → 948 pass, 3 skip, 0 fail, 3288 expect() calls across 79 files.

# tsc --noEmit on the entire backend
bun x tsc --noEmit
# → clean, no errors.
```

Files changed (round 1 + round 2 cumulative):

```
NEW backend files
─────────────────
src/db/migrations/028_session_tasks_fts.ts       # FTS5 over session_tasks
src/db/migrations/029_skill_proposals.ts         # skill_proposals table
src/db/skill-proposal-store.ts                   # store + safety integration
src/memory/snapshot.ts                           # MemorySnapshot + dedup + safety verdict

NEW backend tests
─────────────────
tests/api/tasks-fts-search.test.ts               # 9 cases
tests/api/scheduler-api.test.ts                  # 15 cases
tests/api/doctor-runtime.test.ts                 # 8 cases
tests/api/skill-proposals.test.ts                # 10 cases
tests/memory/snapshot.test.ts                    # 15 cases

MODIFIED backend files
──────────────────────
src/api/server.ts                                # scheduler + skill-proposal handlers, doctor probes, searchMode flag
src/api/event-manifest.ts                        # +15 events (scheduler:* + skill:proposal_*)
src/cli/doctor.ts                                # runtime probes + migrations check
src/cli/serve.ts                                 # wires gatewayScheduleStore + skillProposalStore
src/core/bus.ts                                  # +15 event type declarations
src/db/gateway-schedule-store.ts                 # +listAll + delete
src/db/migrations/index.ts                       # registers mig 028 + 029
src/db/session-store.ts                          # FTS5 search mode + sanitizer
src/orchestrator/core-loop.ts                    # captureMemorySnapshot wiring
src/orchestrator/factory.ts                      # constructs new stores; exposes on Orchestrator
docs/design/hermes-lessons-core-runtime-gap-closure.md  # this file
```

---

## 8. Axiom posture

This PR strengthens A3 (deterministic governance) and A8 (traceable
accountability) without weakening any axiom:

- **A1 generation ≠ verification.** No LLM is involved in search,
  ranking, or sanitisation — pure SQL + a deterministic regex
  sanitiser.
- **A3 deterministic governance.** FTS5 ranking is BM25 — a
  deterministic, replayable function of the corpus.
- **A6 zero-trust execution.** No new code path can mutate task
  state; the search clause is read-only.
- **A8 traceable accountability.** Search results are a deterministic
  query against persisted rows; the same `?search=foo` request always
  produces the same task ids on the same DB snapshot. Combined with
  the existing `task_events` recorder this means the operator
  console's view is fully reproducible.
- **No hardcoded LLM-output post-filtering** was added. The sanitiser
  applies to user query input, not to LLM tool output.
- **No security policy was loosened.** The shell policy, approval
  gate, profile-name regex, and signed-plugin trust ladder are all
  unchanged.

---

## 9. Followup checklist

Tracked in `docs/design/multi-agent-hardening-roadmap.md` so it does
not get lost:

Closed in this round:

- [x] Bounded-memory frozen-snapshot contract + test fixture (Phase 2 — round 2)
- [x] Agent-managed skill proposal quarantine (Phase 3 — round 2)
- [x] Durable scheduler API with recursion guard (Phase 4 — round 2)
- [x] Doctor diagnostics runtime probes (Phase 7 — round 2)

Still open:

- [ ] Frontend operational console (`/tasks`, `/scheduler`, `/skills` proposals tab, etc.) — Phases 1 + 8.
- [ ] Auto-generator that converts `skill:outcome` success runs into `POST /skill-proposals` calls — needs threshold tuning.
- [ ] Trust-tier promotion API + UI for approved-but-quarantined proposals.
- [ ] Trigram FTS5 tokenizer when a real CJK workload appears.
