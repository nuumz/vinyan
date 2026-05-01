# Hermes Lessons → Vinyan Core Runtime Gap Closure

**Status:** All 9 phases delivered + 3 residual risks closed · 2026-05-01.

- Round 1: Phase 0 audit + Phase 5 (FTS5 task search).
- Round 2: Phases 2 (memory snapshot), 3 (skill proposals + safety scan),
  4 (scheduler API + recursion guard), 5 (tool registry audit — no gap),
  6 (profile isolation completion), 7 (doctor runtime probes), 9 (this
  doc).
- Round 3: skill autogenerator from `skill:outcome`, trust-tier API,
  `/scheduler` page, `/skill-proposals` page (Phases 1 + 8 frontend).
- **Round 4:** R1 adaptive autogenerator threshold with parameter-
  ledger provenance + cooldown/debounce + feature flag, R2 inline
  SKILL.md editor with debounced live safety-scan + revision history
  + tightened `decidedBy`+`reason` enforcement, R3 restart-safe
  tracker with TTL prune + schema validation + post-restart fresh-
  evidence gate.
- **Round 5 (this revision):** ultrathink hardening sweep — closes
  8 gaps surfaced by deep code review (G1–G8): regex-DOS body cap,
  optimistic locking on draft PATCH, frontend revisions invalidation,
  promotion-blocked event noise reduction, mig-032 backfill for pre-
  existing proposals, per-proposal revision retention cap, configurable
  fresh-evidence floor, transactional `recordSuccess`.

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

> **Round 1:** sections 4.1–4.4 — FTS5 search and the design note
> framework.
>
> **Round 2:** sections 4.5–4.10 — durable scheduler API, doctor
> runtime probes, memory frozen-snapshot contract, skill-proposal
> quarantine, profile isolation extensions, recursion guards.
>
> **Round 3:** sections 4.11–4.13 — skill auto-generator from
> `skill:outcome`, trust-tier API, `/scheduler` and `/skill-proposals`
> frontend pages.
>
> **Round 4:** sections 4.14–4.16 — R1 adaptive threshold + parameter
> ledger, R2 inline editor + live safety-scan + revisions, R3 restart-
> safe tracker with zero-trust gates.
>
> **Round 5:** section 4.17 — ultrathink hardening (G1–G8): payload
> size cap, optimistic locking, frontend cache invalidation, event
> noise reduction, migration backfill, revision retention cap,
> configurable fresh-evidence floor, transactional recordSuccess.

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

### 4.11 Skill proposal auto-generator

`src/skills/proposal-autogen.ts` subscribes to `skill:outcome` and
produces a proposal after `threshold` (default 3) consecutive
successes for the same `(agentId, taskSignature)` pair. Wired in
`cli/serve.ts` after the orchestrator is constructed.

Design constraints:

- **A3** — pure rule-based threshold. No LLM in the path.
- **A6** — every produced proposal goes through the same store +
  safety scanner as human-driven proposals; auto-generated rows land
  as `quarantined` (default trust tier) regardless of the SKILL.md
  content. Activation still requires a human-attributed `approve`
  call.
- **A8** — proposal carries `sourceTaskIds` (last 25) so the operator
  can replay the runs that triggered it.
- **Bounded memory** — tracker is capped at 1 000 distinct signatures;
  LRU eviction by `lastSeen`. Across server restarts the counter
  resets — intentional, so a half-counted signature doesn't prematurely
  promote.
- **Idempotent merge** — the store's `(profile, proposedName)` merge
  contract means re-creating with the same name bumps `successCount`
  by 1 instead of duplicating the row.

`tests/skills/proposal-autogen.test.ts` — 7 cases: below-threshold no-op,
exact-threshold creation + idempotent merge, failure outcomes ignored,
distinct signatures track independently, distinct agentIds (shared vs
per-agent) track independently, slug regex survival for messy task
signatures, unsubscribe stops further emissions.

### 4.12 Trust-tier API

`POST /api/v1/skill-proposals/:id/trust-tier` lets an operator promote
or demote a proposal's trust tier (`quarantined` → `community` →
`trusted` → `official` → `builtin`). Lifecycle status (pending /
approved / rejected / quarantined) is unaffected; the tier is a
separate axis. Every transition requires `decidedBy` (no LLM-driven
promotion path is possible — A6).

3 new tests in `tests/api/skill-proposals.test.ts`: round-trip
quarantined → community → trusted, invalid tier rejection (400),
missing decidedBy rejection (400).

### 4.13 Frontend operational pages

**`/scheduler`** (`vinyan-ui/src/pages/scheduler.tsx`) — durable agent
cron operations console:

- Status filter tabs (All / Active / Paused / Failed-circuit / Expired)
- Create form with mode toggle: natural-language phrase OR raw cron
  expression. Sends to `POST /api/v1/scheduler/jobs`.
- Job table with goal, cron + timezone, status badge + failure-streak
  counter, next-fire (relative time), last-run + run count, action
  cluster (pause / resume / run-now / delete).
- Last-run cell links to `/tasks?search=<taskId>` so the operator
  can drill into the actual fired task.
- ConfirmDialog gate on delete (matches the danger-action pattern
  used elsewhere).
- SSE-fallback polling at 60 s — bus events update the cache live.

**`/skill-proposals`** (`vinyan-ui/src/pages/skill-proposals.tsx`) —
agent-managed skill creation review queue:

- Status tabs with counts (Pending / Quarantined / Approved /
  Rejected / All) computed from a single `useSkillProposals()` query.
- Dense table: name + capability tags, status badge, trust-tier
  badge, success count, safety flags, created-relative-time, decided-by.
- Detail drawer with: status panel (status / trust / profile /
  success count / created / decided), safety-flags warning panel
  (with quarantine guidance text when applicable), provenance
  panel (capability tags, tools required, source task ids — each
  links to `/tasks?search=<taskId>`), full SKILL.md preview in a
  monospace block.
- Decision form requires `decidedBy` (audit trail). Quarantined
  proposals show no Approve button (server returns 409 anyway —
  client matches the contract).
- Trust-tier promotion buttons appear only on approved proposals.
- Delete behind ConfirmDialog with proposal-name confirmation.

**Wiring** — `vinyan-ui/src/lib/api-client.ts` adds 7 scheduler
methods + 7 skill-proposal methods (mirroring the backend surface
1:1). `vinyan-ui/src/hooks/use-scheduler.ts` and
`use-skill-proposals.ts` expose React Query mutations / queries.
`vinyan-ui/src/lib/query-keys.ts` adds `qk.scheduler*` /
`qk.skillProposals*`. `App.tsx` registers both routes;
`layouts/app-layout.tsx` adds nav entries (Scheduler under Runtime,
Proposals under Knowledge).

`/tasks` page was already a complete operational console (summary
strip / status tabs / toolbar / table / detail drawer / process
replay / actions) — round 3 verified it continues to work and added
no churn.

### 4.14 R1 — Adaptive autogenerator threshold + parameter ledger

`src/skills/autogen-policy.ts` introduces a deterministic adaptive
formula:

```
base = 3
base += clamp(pendingCount / 10, 0, 2)         // queue pressure
base += quarantineRate >= 0.4 ? 1 : 0           // safety pressure
base -= acceptanceRate >= 0.7 && pending < 3 ? 1 : 0
threshold = clamp(base, MIN_THRESHOLD=2, MAX_THRESHOLD=8)
```

Signals (pendingCount / acceptanceRate / quarantineRate / totals) are
read directly from `SkillProposalStore.list(...)`. The formula is
pure of side-effects; A3 (deterministic) holds.

**Persistence (provenance).** Every threshold change is appended to
`parameter_adaptations` (mig 030) via `ParameterLedger.append`. The
row carries `paramName='skill_autogen_threshold'`,
`ownerModule='skill-autogen-policy'`, and a reason that includes the
explanation string from the policy (`base + queueP + safetyP -
eagerOp → clamp[…] = N`). Replay is a single SQL query.

**Feature flag.** `policyEnabled = false` in deps reverts to the
static `staticThreshold` (also clamped to `[MIN, MAX]` so a config
typo can't drop the floor). The `cli/serve.ts` wiring leaves it
enabled by default; an operator can disable instantly by passing
`policyEnabled: false` to `wireSkillProposalAutogen` and restarting.

**Per-signature cooldown / debounce.** `SkillAutogenStateStore.recordEmit`
sets a `cooldown_until` window (default 6h) so a single signature
cannot flood the queue with back-to-back proposals on every
subsequent successful run. `canPromote(record, threshold)` returns
`{ ok: false, reason: 'cooldown' }` while the window is active.

**Diagnostics.** `GET /api/v1/skill-proposals/autogen-policy` returns
the live snapshot — current threshold, the signals that drove it, the
explanation string, the ledger tail, and the durable tracker
summary. Doctor probes (`autogenPolicy`, `autogenTrackerState`)
expose the same to `/api/v1/doctor` so the operator can read it
without writing a query.

`tests/skills/autogen-policy.test.ts` — 11 cases: empty store
baseline, disabled flag returns staticThreshold, floor/ceiling
clamps, queue pressure raises, quarantine pressure raises, eager
operator lowers, deterministic explanation, ledger append + read,
no-op no-row, missing-row null, persisted out-of-range clamped on
read.

### 4.15 R2 — Inline SKILL.md editor + live safety-scan + revisions

**Migration 032** — `skill_proposal_revisions` table. Audit-trail row
per `(profile, proposal_id)` keyed on a monotonic `revision` counter.
Stores `skill_md`, `safety_flags_json`, `actor`, `reason`, `created_at`.
On `SkillProposalStore.create` we seed revision 1 with `actor =
'auto-generator'` and `reason = 'initial create'` so the UI sees a
complete history without a special-case "before any edits" row.

**`SkillProposalStore.updateDraft`** — atomic update that:

- Refuses decided proposals (`approved` / `rejected` → `null`, API
  surfaces 409).
- Re-runs `memorySafetyVerdict` on the new bytes.
- Flips status to `quarantined` when flags fire; flips back to
  `pending` when flags clear from a previously quarantined row.
- Appends a revision row inside the same SQLite transaction so the
  audit trail survives even when the post-update read fails.

**Endpoints**:

| Route | Effect |
|---|---|
| `POST /api/v1/skill-proposals/scan` | Pure scanner; accepts `{ skillMd }`, returns `{ safe, flags, scannedAt }`. No DB writes. |
| `PATCH /api/v1/skill-proposals/:id/draft` | Body: `{ skillMd, actor, reason? }`. `actor` required; decided rows reject with 409. Emits `skill:proposal_quarantined` or `skill:proposed` based on the new verdict. |
| `GET /api/v1/skill-proposals/:id/revisions` | Newest-first list, bounded to `?limit=50`. |

**Tightened audit trail.** Approve and trust-tier mutations now
require `reason` in addition to `decidedBy` (was only required for
reject). The trust-tier handler also appends a parameter-ledger row
keyed on `skill_proposal_trust_tier:<profile>:<id>` so the transition
shows up in the same audit surface as threshold changes.

**Frontend**. `SkillDraftEditor` (in `vinyan-ui/src/pages/skill-proposals.tsx`):

- Local textarea state debounced 500ms before scan fires.
- Live findings panel above the textarea — green / clean or
  yellow / `Badge[]` of flags with the message "saving will keep
  the proposal quarantined until flags clear."
- Save Draft button gated by non-empty `actor` and a dirty buffer.
  Server-side re-scan is authoritative; the local verdict is
  advisory.
- Re-scan + Discard buttons.

`SkillProposalRevisions` — collapsible list newest-first with
`v<n> · actor · relative time · flag count · reason preview` row;
expanding a row shows the full SKILL.md bytes for that revision.

`AutogenPolicyBanner` — wired above the proposals tabs. Shows live
threshold, signals, ledger change count, tracker row count + boot id
prefix. Polls every 90s with React Query.

`tests/api/skill-proposal-editor.test.ts` — 11 cases: scan deterministic,
scan flags credentials, scan rejects empty body, draft patch updates +
seeds revision 2, status flips quarantined → pending and pending →
quarantined, actor required, decided immutable (409), revisions
newest-first with revision 1 == initial create, approve without
reason returns 400.

### 4.16 R3 — Restart-safe autogenerator tracker with zero-trust gates

**Migration 031** — `skill_autogen_state` table. PRIMARY KEY on
`(profile, signature_key)`. Carries `successes`, `successes_at_boot`,
`last_seen`, `boot_id`, `cooldown_until`, `task_ids_json`,
`state_version`, `last_emitted_at`. Indexes on `last_seen` (TTL
prune) and `boot_id` (per-boot diagnostic queries).

**`SkillAutogenStateStore.reconcile()`** runs on every server boot:

1. Mints a fresh `bootId` (`crypto.randomUUID()`).
2. Drops rows older than `MAX_TRACKER_AGE_MS = 14 days`.
3. Drops rows whose `state_version != 1` (schema mismatch — A9).
4. Validates `task_ids_json` parses as an array; corrupt rows
   dropped (A9 — corrupt state degrades, never poisons runtime).
5. Capacity cap (`maxRows = 1000`) — drops oldest by `last_seen`.
6. **Snapshots `successes_at_boot = successes` for every survivor.**
   This is the load-bearing R3 invariant: any row carrying
   `successes >= threshold` from a previous boot has its
   "evidence-since-boot" reset to zero, so promotion on the very
   first emit post-restart is impossible.

**`canPromote(record, threshold)`** — three-stage gate:

- `cooldownUntil > now` → `{ ok: false, reason: 'cooldown' }`.
- `successes - successes_at_boot < MIN_POST_RESTART_EVIDENCE = 1` →
  `{ ok: false, reason: 'fresh-evidence' }`. **The R3 zero-trust
  guard** — refuses to honour carryover counters until at least one
  fresh success post-boot.
- `successes < threshold` → `{ ok: false, reason: 'below-threshold' }`.
- Otherwise → `{ ok: true }`.

**Observability events** (manifest-registered, scope: 'global',
sessionBypass: true unless task-scoped):

```
skill:autogen_tracker_loaded     skill:autogen_tracker_pruned
skill:autogen_tracker_recovered  skill:autogen_tracker_invalidated
skill:autogen_threshold_changed  skill:autogen_promotion_blocked
```

`tracker_loaded` carries the boot id, loaded count, prune counts, and
schema-invalidation count. `promotion_blocked` carries the reason
('cooldown' | 'fresh-evidence' | 'below-threshold') so an operator
can confirm "the autogen is alive but my signal hasn't crossed the
gate yet."

**Listener integration** (`src/skills/proposal-autogen.ts`):

- `wireSkillProposalAutogen` accepts both `stateStore` and `ledger`
  optionally. Production wires both via `cli/serve.ts`; tests can
  pass neither for in-memory-only behaviour.
- The hot path: `recordSuccess` to the durable store, then promotion
  gate using durable state when present. In-memory map kept as a
  parallel structure so tests without `stateStore` still work.
- Threshold recompute is bounded by `recomputeIntervalSeconds = 5
  minutes` — a high-traffic emission storm doesn't pound SQLite
  with policy queries.
- A9: every persistent operation is wrapped — store failures degrade
  to in-memory-only, never crash the bus listener.

`tests/skills/autogen-state-store.test.ts` — 13 cases: reconcile
mints fresh boot id + snapshots, TTL prune, schema invalidation,
corrupt JSON drop, capacity cap, canPromote refuses cooldown / fresh-
evidence / below-threshold, allows when all gates pass, **R3
invariant: carryover row with successes=5 does NOT promote on first
post-restart emit — requires one additional success**, recordSuccess
increments durably, taskIds bounded at 25, recordEmit stamps
`cooldown_until` and `last_emitted_at`.

### 4.17 Round 5 — Ultrathink hardening sweep (G1–G8)

Deep code review surfaced eight production-grade gaps in the round-4
implementation. Each is closed with code + tests. Axiom posture
unchanged; no security policy loosened.

**G1 — Payload size cap (regex-DOS guard).** `memorySafetyVerdict`
runs five regex tests against the full SKILL.md content. A 10MB
malicious payload would pin CPU on the bus event loop (Bun is
single-threaded JS). `MAX_SKILL_MD_BYTES = 100 * 1024` exported from
`skill-proposal-store.ts`; `/scan` and `/draft` handlers reject
payloads larger than the cap with HTTP 413 + `{ error, maxBytes }`.
Frontend hook surfaces a clear toast.

**G2 — Optimistic locking on draft PATCH.** Two operators editing the
same proposal previously had last-write-wins semantics. The store's
`updateDraft` now accepts `expectedRevision?: number` and returns a
discriminated union:

```ts
| { kind: 'ok'; proposal; revision }
| { kind: 'not-found' }
| { kind: 'immutable'; status }
| { kind: 'precondition-failed'; latestRevision }
```

The API returns HTTP 412 with `{ code: 'precondition-failed',
latestRevision }` on stale tokens. Frontend reads
`useSkillProposalRevisions().data.revisions[0].revision` as the
`expectedRevision` baseline; on 412 the toast is a soft warning and
React Query invalidation re-fetches the latest state automatically.
The check sits inside the same SQLite transaction as the UPDATE +
INSERT so a race between two concurrent PATCHes is impossible.

**G3 — Frontend revisions cache invalidation.** The PATCH mutation now
invalidates `['skill-proposals', 'revisions', id]` alongside the
proposal queries so the history panel refreshes immediately instead
of waiting on the 10-second `staleTime`.

**G4 — Promotion-blocked event semantics.** Round 4 emitted
`skill:autogen_promotion_blocked` on EVERY successful skill outcome
that didn't reach threshold — that's normal accumulation, not a
block. The fix gates emission on `successes >= currentThreshold`:
the event now only fires when a row that **could have promoted** was
held back by a cooldown or fresh-evidence guard. Below-threshold
returns silently. Operator dashboards now see only signal, not noise.

**G5 — Mig-032 backfill for pre-existing proposals.** Before round 5
the migration created the `skill_proposal_revisions` table but
didn't seed revision-1 rows for proposals created before mig 032
landed. Those proposals showed "no history" in the UI. The migration
now ends with an `INSERT OR IGNORE ... SELECT ... WHERE NOT EXISTS`
that backfills revision 1 for every pre-existing proposal using its
current `skill_md` + `safety_flags` + `created_at`, with
`actor='auto-generator'` and `reason='initial create (backfilled by
migration 032)'`. Idempotent — re-runs are no-ops. Tested by
deleting the seeded revision row + re-running `migration032.up`.

**G6 — Revision retention cap.** A malicious or buggy operator who
spams edits would inflate `skill_proposal_revisions` indefinitely.
`MAX_REVISIONS_PER_PROPOSAL = 100`. When a PATCH would push the
count over the cap, mid-history rows are deleted inside the same
transaction, with two preserved anchors: revision 1 (original
provenance) and the most-recent (cap − 1) rows. Operator sees a
continuous history; storage stays bounded.

**G7 — Configurable fresh-evidence floor.** `MIN_POST_RESTART_EVIDENCE`
was a module-level constant. Operations may want a more conservative
floor in production (e.g. require 3 fresh successes post-restart
before honouring carryover counters). The store constructor now
accepts `minPostRestartEvidence`; clamped to a hard floor of 1 so
nobody can disable the zero-trust gate by passing 0 / negative.
`SkillAutogenStateStore.getMinFreshEvidence()` exposes the resolved
value to diagnostics.

**G8 — Transactional `recordSuccess`.** The previous read-then-write
sequence (`get` → `bumpStmt`) was non-atomic. Single-process Bun
serialises bus listeners on the JS event loop, so the race was
latent for the current architecture, but multi-process gateways or
a future async listener path would lose increments. `recordSuccess`
is now wrapped in a SQLite transaction (prepared once at construction);
SQLite serialises writers on a single DB so concurrent transactions
are safe.

`tests/api/skill-proposal-hardening.test.ts` — 12 cases covering
G1, G2, G6, G4, G5, G7. Existing 1315 backend tests still pass; full
sweep now reports **1327 pass / 0 fail across 115 files**.

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
- **Skill auto-generator** — `skill:outcome` listener in `cli/serve.ts` produces a quarantined proposal after 3 consecutive successes per `(agentId, taskSignature)`. Bounded memory + LRU eviction; resets on server restart.
- **Trust-tier API** — `POST /api/v1/skill-proposals/:id/trust-tier` promotes / demotes approved proposals along the quarantine → community → trusted → official → builtin axis.
- **Frontend `/scheduler`** — operational console for `gateway_schedules`. NL + cron create form, status tabs, pause / resume / run-now / delete actions, last-run drill-down to `/tasks`.
- **Frontend `/skill-proposals`** — review queue for the autogen + manual proposals. Detail drawer with **inline SKILL.md editor + live safety-scan + revision history**, safety flags, provenance, decision form (now requires reason), trust-tier promotion buttons (now requires reason).
- **Adaptive autogen threshold** — `cli/serve.ts` wires the autogenerator with `stateStore` + `ledger` so threshold tunes itself from queue health, every change is recorded, and the cooldown window prevents proposal floods.
- **Restart-safe tracker** — durable state + boot reconciliation + zero-trust fresh-evidence gate. A server restart picks up where it left off without ever promoting a carryover counter.
- **Doctor probes** for `Autogen Threshold` (live value + change count + pending depth) and `Autogen Tracker` (row count + cooldown count + oldest seen + boot id prefix).
- **`GET /api/v1/skill-proposals/autogen-policy`** — diagnostics endpoint for the operator UI banner.
- **`POST /api/v1/skill-proposals/scan`**, **`PATCH /api/v1/skill-proposals/:id/draft`**, **`GET /api/v1/skill-proposals/:id/revisions`** — R2 editor surface.
- **Tightened audit trail** — approve / reject / trust-tier all require both `decidedBy` AND `reason`. Trust-tier transitions also append a parameter-ledger row.
- **Hardened editor surface (round 5)** — `/scan` and `/draft` cap payloads at 100KB (regex-DOS guard); PATCH supports `expectedRevision` optimistic locking with HTTP 412 + automatic refresh; revision retention cap at 100 rows per proposal with anchor preservation (revision 1 + newest 99).
- **Configurable fresh-evidence floor** — deployments can set `minPostRestartEvidence` ≥ 1 on the autogen state store for stricter zero-trust gates; clamped so 0/negative cannot disable the guard.
- **Quieter promotion-blocked events** — only fires when a row that could have promoted was held back by a guard, not on every below-threshold accumulation.
- **Pre-existing proposals show full history** — mig 032 backfills revision-1 rows so the UI history panel works for proposals created before the table existed.

---

## 6. What remains gated or future

| Item | Why deferred |
|---|---|
| **Cross-tier exhaustion event distinct from `provider_unavailable`** | The existing `llm:provider_unavailable` event already fires when no healthy provider is found in the requested tier or any adjacent fallback tier. Adding a separate "exhausted across the whole chain" event would duplicate semantics. |
| **Trigram FTS5 tokenizer for CJK / substring** | Hermes ships a parallel `messages_fts_trigram`. Our usage is mostly Latin-script today; deferred until a real CJK workload appears. |
| **Tool capability registry consolidation (original Phase 2).** A single `ToolCapabilityRegistry` with one schema + one `availability` check per tool. | The current shape (direct-tool-resolver + tool-classifier + skill-tools + MCP + command-approval-gate) is already gated, category-grouped, and risk-class-tagged. Audit found no genuine gap (no unavailable tool was being advertised to the LLM, no missing approval edge). Consolidating for symmetry risks breaking working call sites without delivering observable behaviour change. |
| **Mid-task memory write → next-turn pickup.** Snapshot freezes at task start. A second concurrent task in the same session would already see the new memory — but the operator may want a force-refresh hook. | The right place for this is a `refreshMemorySnapshot` opt at task ingress, not a global mutation hook. Wait for a real call site before adding. |
| **Adaptive policy formula re-tuning.** R1 ships a sensible default (queue pressure / safety pressure / eager operator), but the coefficients were chosen by inspection. | Real-traffic data will tell us whether the slope is right. The formula is in one file, behind a feature flag, with full ledger provenance — re-tuning is a one-PR patch. |

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

# Round 3 — autogenerator + trust-tier
bun test tests/skills/proposal-autogen.test.ts tests/api/skill-proposals.test.ts
# → 20 pass, 0 fail, 54 expect() calls.

# Round 4 — adaptive policy + restart-safe tracker + editor
bun test ./tests/skills/autogen-policy.test.ts \
         ./tests/skills/autogen-state-store.test.ts \
         ./tests/api/skill-proposal-editor.test.ts \
         ./tests/api/doctor-runtime.test.ts
# → 43 pass, 0 fail, 134 expect() calls.

# Round 5 — ultrathink hardening (G1–G8)
bun test ./tests/api/skill-proposal-hardening.test.ts
# → 12 pass, 0 fail, 26 expect() calls.

# Full backend regression — every test under tests/api, tests/db,
# tests/memory, tests/skills
bun test tests/api tests/db tests/memory tests/skills
# → 1327 pass, 3 skip, 0 fail, 4433 expect() calls across 115 files.

# tsc --noEmit on the entire backend
bun x tsc --noEmit
# → clean, no errors.

# Frontend tsc --noEmit
cd ../vinyan-ui && bun run lint
# → clean, no errors.
```

### 7.1 Rollback plan (rounds 4–5)

Three feature flags / kill switches in priority order:

1. **Adaptive threshold off → static fallback.** Pass
   `policyEnabled: false` (and optional `threshold: <2..8>`) when
   wiring `wireSkillProposalAutogen` in `cli/serve.ts`. The store
   writes a parameter-ledger row on first decision so the rollback
   itself is auditable. Effect: threshold becomes a constant; ledger
   activity stops.
2. **Persistence off → in-memory tracker (legacy round-3 behaviour).**
   Omit `stateStore` / `ledger` from the `wireSkillProposalAutogen`
   deps. The listener falls back to its in-memory map and resets to
   zero on every restart. R3 zero-trust still holds (in-memory
   `successesAtBoot=0` means the gate becomes "successes >= 1",
   which the very first emission satisfies — equivalent to round-3
   semantics).
3. **Autogenerator off entirely.** Don't import / call
   `wireSkillProposalAutogen` in `cli/serve.ts`. Manual `POST
   /api/v1/skill-proposals` still works; the `/skill-proposals` UI
   still functions; the only thing that disappears is the automatic
   "successful pattern → proposal" loop. Migrations 029–032 stay in
   place — no schema rollback needed.

**Editor rollback (R2).** The inline editor + revision history can
be disabled by reverting the `vinyan-ui/src/pages/skill-proposals.tsx`
detail drawer to render the read-only `<pre>` block. Backend
endpoints (`/scan`, `/draft`, `/revisions`) stay live but unused;
existing tests still cover them. A cleaner rollback is to remove the
SkillDraftEditor + SkillProposalRevisions imports — single git revert
on `pages/skill-proposals.tsx`.

**Tightened audit-trail rollback (R2 secondary).** Loosening the
`reason` requirement on `approve` / trust-tier mutations is a
two-line change in `src/api/server.ts` — flip the validation check
from "reason required" back to optional. Tests that assert the 400
on missing reason will need updating in the same PR. Recommend
keeping the requirement; the audit trail benefit clearly outweighs
the friction.

### 7.2 Round 5 hardening — rollback plan

Each G-fix has its own kill switch:

- **G1 size cap.** Bump `MAX_SKILL_MD_BYTES` in `skill-proposal-store.ts`
  for a deployment that legitimately needs larger drafts. Don't drop
  the cap entirely; keep at minimum a safety ceiling (e.g. 1MB).
- **G2 optimistic lock.** The check fires only when the client sends
  `expectedRevision`. Server-side fallback already permits omission
  for backward compatibility. To disable client-side: remove the
  `expectedRevision` line from the editor's `handleSave` — server
  no longer rejects.
- **G3 cache invalidation.** Pure UX. Removing the
  `qc.invalidateQueries({ queryKey: [..., 'revisions', id] })` line
  reverts to the round-4 staleTime-driven refresh.
- **G4 event noise.** Re-emit on the below-threshold branch by
  un-gating the `meetsThreshold` check in `proposal-autogen.ts`.
  Don't recommend — the pre-fix dashboards were swamped.
- **G5 backfill.** Idempotent INSERT OR IGNORE — running the migration
  on a cleanly-migrated DB is a no-op. To reverse, run `DELETE FROM
  skill_proposal_revisions WHERE reason LIKE 'initial create
  (backfilled%';` (audit-removable but irreversible).
- **G6 revision cap.** Raise `MAX_REVISIONS_PER_PROPOSAL` in
  `skill-proposal-store.ts`. Don't disable — uncapped table will grow.
- **G7 fresh-evidence floor.** Pass `minPostRestartEvidence` to the
  store constructor. Clamped to ≥1; cannot be disabled (by design).
- **G8 transactional `recordSuccess`.** Single-process Bun already
  serialises listeners; the transaction is defense-in-depth. To
  revert: replace `this.recordSuccessTx(args)` with the inline read-
  then-write body. Don't recommend — it's the same number of SQLite
  operations either way.

Files changed (rounds 1–4 cumulative):

```
NEW backend files
─────────────────
src/db/migrations/028_session_tasks_fts.ts       # FTS5 over session_tasks
src/db/migrations/029_skill_proposals.ts         # skill_proposals table
src/db/migrations/031_skill_autogen_state.ts     # round 4: restart-safe tracker
src/db/migrations/032_skill_proposal_revisions.ts# round 4: edit audit trail (round 5: + backfill)
src/db/skill-proposal-store.ts                   # store + safety + R2 updateDraft + listRevisions (round 5: optimistic lock + retention cap + size cap constants)
src/memory/snapshot.ts                           # MemorySnapshot + dedup + safety verdict
src/skills/proposal-autogen.ts                   # skill:outcome → quarantined proposal (round 4 hardened, round 5 quieter events)
src/skills/autogen-policy.ts                     # round 4 R1: adaptive threshold formula
src/skills/autogen-state-store.ts                # round 4 R3: persistent tracker + zero-trust gate (round 5: configurable floor + transactional recordSuccess)

NEW backend tests
─────────────────
tests/api/tasks-fts-search.test.ts               # 9 cases
tests/api/scheduler-api.test.ts                  # 15 cases
tests/api/doctor-runtime.test.ts                 # 8 cases
tests/api/skill-proposals.test.ts                # 14 cases (R2: +1 missing-reason)
tests/api/skill-proposal-editor.test.ts          # round 4 R2: 11 cases
tests/api/skill-proposal-hardening.test.ts       # round 5 G1-G7: 12 cases
tests/memory/snapshot.test.ts                    # 15 cases
tests/skills/proposal-autogen.test.ts            # 7 cases
tests/skills/autogen-policy.test.ts              # round 4 R1: 11 cases
tests/skills/autogen-state-store.test.ts         # round 4 R3: 13 cases

MODIFIED backend files
──────────────────────
src/api/server.ts                                # scheduler + skill-proposal + trust-tier handlers, doctor probes, searchMode flag
src/api/event-manifest.ts                        # +15 events (scheduler:* + skill:proposal_*)
src/cli/doctor.ts                                # runtime probes + migrations check
src/cli/serve.ts                                 # wires gatewayScheduleStore + skillProposalStore + autogenerator
src/core/bus.ts                                  # +15 event type declarations
src/db/gateway-schedule-store.ts                 # +listAll + delete
src/db/migrations/index.ts                       # registers mig 028 + 029
src/db/session-store.ts                          # FTS5 search mode + sanitizer
src/orchestrator/core-loop.ts                    # captureMemorySnapshot wiring
src/orchestrator/factory.ts                      # constructs new stores; exposes on Orchestrator
docs/design/hermes-lessons-core-runtime-gap-closure.md  # this file

NEW frontend files (vinyan-ui/)
────────────────────────────────
src/pages/scheduler.tsx                          # /scheduler operational console
src/pages/skill-proposals.tsx                    # /skill-proposals review queue
src/hooks/use-scheduler.ts                       # 7 React Query hooks
src/hooks/use-skill-proposals.ts                 # 5 React Query hooks

MODIFIED frontend files (vinyan-ui/)
────────────────────────────────────
src/App.tsx                                      # registers /scheduler + /skill-proposals routes
src/layouts/app-layout.tsx                       # nav entries under Runtime + Knowledge
src/lib/api-client.ts                            # 14 new methods + scheduler/proposal types
src/lib/query-keys.ts                            # qk.scheduler* + qk.skillProposals*
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

Closed:

- [x] Bounded-memory frozen-snapshot contract + test fixture (Phase 2 — round 2)
- [x] Agent-managed skill proposal quarantine (Phase 3 — round 2)
- [x] Durable scheduler API with recursion guard (Phase 4 — round 2)
- [x] Doctor diagnostics runtime probes (Phase 7 — round 2)
- [x] Auto-generator from `skill:outcome` (round 3)
- [x] Trust-tier promotion API (round 3)
- [x] `/scheduler` and `/skill-proposals` frontend pages (Phases 1 + 8 — round 3)
- [x] Adaptive autogen threshold + parameter-ledger provenance + cooldown + feature flag (R1 — round 4)
- [x] SKILL.md inline editor with debounced live safety-scan + revision history (R2 — round 4)
- [x] Restart-safe tracker with TTL prune + schema validation + zero-trust fresh-evidence gate (R3 — round 4)
- [x] Tightened `decidedBy`+`reason` requirement on every approve / reject / trust-tier mutation (R2 secondary — round 4)
- [x] Regex-DOS body size cap on `/scan` and `/draft` (G1 — round 5)
- [x] Optimistic locking on draft PATCH via `expectedRevision` (G2 — round 5)
- [x] Frontend revisions cache invalidation (G3 — round 5)
- [x] Promotion-blocked event noise reduction (G4 — round 5)
- [x] Mig-032 backfill of revision-1 rows for pre-existing proposals (G5 — round 5)
- [x] Per-proposal revision retention cap with anchor preservation (G6 — round 5)
- [x] Configurable `minPostRestartEvidence` floor with hard ≥1 clamp (G7 — round 5)
- [x] Transactional `recordSuccess` (G8 — round 5)

Still open (tracked in `docs/design/multi-agent-hardening-roadmap.md`):

- [ ] Adaptive policy formula re-tuning once real `skill:outcome` traffic exists.
- [ ] Trigram FTS5 tokenizer when a real CJK workload appears.
