# W1 Shared Contracts — Frozen for Parallel Implementation

> Status: **FROZEN** at 2026-04-21. Consumers: Messaging Gateway, MemoryProvider,
> Skills Hub, Trajectory Export, Profile Resolver, Observable Routing UI,
> ACP Adapter, WorkerBackend abstraction.
>
> Changes require an RFC amendment and a bump of `W1_CONTRACT_VERSION`
> in `src/core/confidence-tier.ts` (TODO: add constant once first breaking
> change is proposed).

The four deep-design tracks (Skills · Deployment · Memory · Learning/Interop)
are implemented by multiple engineers in parallel. Without a frozen contract
surface they will drift: each track will invent its own tier enum, its own
migration numbering, its own profile convention. This document is that
surface. If a track needs a field not listed here, pause and amend this
document **before** adding the field.

---

## §1 ConfidenceTier — the one epistemic vocabulary

Canonical source: `src/core/confidence-tier.ts` (re-exported from
`src/core/index.ts`). **Do not redeclare** the literal union anywhere else.

```ts
type ConfidenceTier = 'deterministic' | 'heuristic' | 'probabilistic' | 'speculative';
```

### Tier meanings (A5)

| Tier | Meaning | Examples |
|------|---------|----------|
| `deterministic` | Bound to a content hash or a rule-verified artifact. Survives unchanged until the underlying file changes. | Oracle Gate verdicts with passing AST+Type+Test; `file_hashes` row; signed skill manifest. |
| `heuristic` | Verified by a rule, test, or cross-engine agreement but not reducible to content-hash equality. | User-confirmed preference; skill promoted after backtest; USER.md section with passing prediction error. |
| `probabilistic` | LLM-extracted or single-engine inference; no cross-check yet. | Auto-memory extracted from a turn; autonomous skill draft; MCP tool result before Oracle verification. |
| `speculative` | External peer report, unsigned import, exploratory. Always up for revocation. | Unsigned hub-imported skill during quarantine; inbound ACP message before verification; A2A peer evidence before trust accrual. |

### Required fields on any tier-bearing record

```ts
{
  confidence: number;          // [0, TIER_CONFIDENCE_CEILING[tier]]
  evidenceTier: ConfidenceTier;
  evidenceChain: Array<{ kind: string; hash: string; elapsedMs?: number }>;
  contentHash?: string;        // required for `deterministic` tier
  temporalContext: { createdAt: number; validFrom?: number; validUntil?: number };
}
```

### Clamps (inviolable)

Intake from external sources (ACP inbound, A2A peer, MCP tool return, hub
import) **must** pass through `clampConfidenceToTier(confidence, tier)`
before the record enters any store. Raw values from untrusted transports
never reach a store.

### Unknown

`'unknown'` is NOT a tier. It is a verdict `type` on `HypothesisTuple` /
`OracleVerdict` per A2. A record with `type: 'unknown'` does not carry a
tier — it skips tier-based ranking and surfaces in the observable routing
explainer.

---

## §2 Migration numbering reservation

Current state (2026-04-21): `ALL_MIGRATIONS = [migration001]` at
`src/db/migrations/index.ts`. The 2026-04-20 squash collapsed 41 historical
migrations into `001_initial_schema.ts`.

**Reserved version numbers for W1** (do not collide):

| Version | Owner | Scope |
|---------|-------|-------|
| `002_profile_scope.ts` | PR #1 Profile Resolver | Optional — only if a per-profile table is needed. Most profile scoping is filesystem, not DB. |
| `003_memory_records.ts` | PR #2 MemoryProvider | `memory_records` table + FTS5 virtual table `memory_records_fts`. Columns include `profile TEXT NOT NULL DEFAULT 'default'`. |
| `004_skill_artifact.ts` | PR #3 Skills SKILL.md | Add columns to `cached_skills`: `confidence_tier`, `skill_md_path`, `content_hash`, `expected_error_reduction`, `backtest_id`, `quarantined_at`. |
| `005_trajectory_export.ts` | PR #4 Trajectory Exporter | `trajectory_exports` table (manifest pointer only; artifacts live on disk). |
| `006_gateway_tables.ts` | W2 Messaging Gateway | `gateway_schedules`, `gateway_identity`, `gateway_pairing_tokens`. |
| `007_plugin_audit.ts` | W2 Plugin Registry | `plugin_audit` (load/verify/activate/deactivate events). |
| `008_skill_trust_ledger.ts` | W3 SK3 Skills Hub import | `skill_trust_ledger` (discover/scan/quarantine/dry-run/critic/promote/demote/reject events per imported skill). |
| `009_user_md_dialectic.ts` | W3 P3 USER.md dialectic | `user_md_sections` (slug, content, predicted_response, evidence_tier) + `user_md_prediction_errors` (per-section observed vs predicted delta history). |

Agents adding migrations beyond this range must amend this table first.

### Migration file conventions

- Filename: `NNN_snake_case_name.ts` in `src/db/migrations/`.
- Export name: `migrationNNN` (pads to three digits).
- Append to `ALL_MIGRATIONS` in `src/db/migrations/index.ts` **in version order**.
- Idempotent: every `CREATE` uses `IF NOT EXISTS`; every `ALTER TABLE ADD COLUMN` wrapped in `PRAGMA table_info` guard.
- No destructive changes (`DROP`, `RENAME`, `DELETE`) without an explicit RFC.

---

## §3 Profile column convention

Every new table created in W1 and later **must** include a `profile` column:

```sql
profile TEXT NOT NULL DEFAULT 'default'
```

With a multi-column index that leads with `profile` when the table has any
other index: `CREATE INDEX idx_<table>_profile_<col> ON <table>(profile, <col>);`.

Cross-profile reads are prohibited at the store layer. If a store method
returns rows without a `WHERE profile = ?` clause, it must accept
`{ profile: 'ALL' }` explicitly and log a `profile:cross-read` audit event.

Rationale: H2 (profile isolation) ships in W1 so downstream tracks never
have to retrofit the column. Retrofitting a profile column onto dozens of
tables later is a 10× cost vs. adding it on table birth.

---

## §4 `executeTask` signature — frozen entry point

Lives at `src/orchestrator/core-loop.ts` (or wherever the public
`executeTask` is exported; consumers must import from that single path).
This is the **only** way a task enters the governance pipeline. Do not
create alternate entry points.

```ts
interface TaskInput {
  id: string;                        // caller-supplied or generated
  goal: string;
  constraints?: Record<string, unknown>;
  targetFiles?: string[];
  source: 'cli' | 'api' | 'gateway-telegram' | 'gateway-slack'
        | 'gateway-discord' | 'gateway-whatsapp' | 'gateway-signal'
        | 'gateway-email' | 'gateway-cron' | 'acp' | 'a2a' | 'internal';
  profile?: string;                  // INTERMEDIATE-OPTIONAL — see §9.A1;
                                     // defaults to 'default' at core-loop entry
  sessionId?: string;
  parentTaskId?: string;             // for interrupt-and-redirect chains
  priority?: 'normal' | 'high' | 'background';
  originEnvelope?: unknown;          // preserved for reply-routing by gateway
}

function executeTask(input: TaskInput): Promise<TaskResult>;
```

### Invariants

- Gateway adapters, NL cron, ACP server inbound, MCP bridge, CLI, and HTTP
  API all call this one function. Any "shortcut" that skips it is a bug.
- `source` is required; used by observability and trust weighting.
- `profile` is intermediate-optional during W1 rollout (see §9.A1). The
  long-term intent is to require it; the current PR coerces an absent
  value to `'default'` at `executeTask` entry and validates any present
  value against `/^[a-z][a-z0-9-]*$/` or the literal `'default'`.
- The function runs the full Core Loop (Budget → Perceive → Comprehend →
  Predict → Plan → Generate → Verify → Learn). Callers cannot request a
  subset; they can influence risk routing via `constraints`.

### Crash-safety invariant (restated)

Before `executeTask` returns any `TaskResult`, any spawned `ShadowJob`
must be persisted. Interrupt-and-redirect logic (H5) must honor this fence
— the interrupt is queued until the current turn checkpoints.

---

## §5 Plugin category cardinality

Pinned here so sibling tracks don't disagree on whether a category is
single-select or multi-select.

| Category | Cardinality | Owner track |
|----------|-------------|-------------|
| `memory` | single (active) + fallback chain | Track 3 |
| `context` | single | Track 4 |
| `oracle` | multi | existing |
| `backend` | multi | Track 4 |
| `messaging-adapter` | multi | Track 2 |
| `skill-registry` | single (active) | Track 1 |

`single` means exactly one is active at a time; writes may shadow to
`default` during a transition window (Track 3 P2).

---

## §6 Trajectory export row identity

Canonical row id for `ECP-enriched` format: `trace_id` from
`execution_traces.id`. The exporter joins:

```
execution_traces   (per-task row)
  ⋈ prediction_ledger + prediction_outcomes   (per-turn Brier/CRPS)
  ⋈ oracle_accuracy_store                     (per-turn oracle verdicts)
  ⋈ session_turns                             (per-turn content)
```

No new join keys invented. Exporter is read-only — it is the MVP
canary for whether the join graph already answers the learning-loop
question.

---

## §7 Turn-ordering rule for parallel work

1. ConfidenceTier enum landed ✅ (this PR).
2. PR #1 Profile Resolver, PR #2 MemoryProvider types, PR #3 Skills artifact,
   PR #4 Trajectory exporter — all may run in parallel from this point.
3. Plugin Registry (W2) is the next critical hinge; start once any two of
   PR #1..#4 have merged.
4. Observable routing explainer (W4) depends on finishing at least one
   trajectory export run end-to-end so the rendering contract can be
   checked against real data.

---

## §8 Escape hatch

If a track genuinely cannot fit a field into the current contract (e.g.
ACP exposes a temporal field with no ECP analog), the track owner:

1. Opens a subsection here under `§9 Amendments` with: proposed field,
   call site, axiom impact, expiration date.
2. Lands the amendment as its own small PR (doc-only) before the code PR.
3. Other tracks are notified via `docs/design/implementation-plan.md`
   changelog line.

No silent drift.

---

## §9 Amendments

### A1 (2026-04-21) — `profile` optional during rollout
- Originally §4 specified `profile: string` as required.
- Intermediate state: `profile?: string` with coerce-to-`'default'` at core-loop
  entry, to preserve backwards compatibility with every existing caller.
- Final state (W3 PR): all call sites pass explicit profile; required field
  restored; amendment expires.
- Rationale: making it required in one PR would fail `tsc` across ~20 call
  sites (`src/cli/run.ts`, `src/cli/chat.ts`, `src/api/server.ts`,
  `src/a2a/bridge.ts`, `src/orchestrator/prediction/self-model.ts`,
  `src/orchestrator/agent-memory/agent-memory-impl.ts`, `src/tui/app.ts`,
  …) and produce no net capability gain. Stores continue to be single-profile
  in this PR; wiring profile into store call sites is deferred to W2/W3.

### A2 (2026-04-21) — `PluginRegistry.ingestInternal` for bundled providers
- Need: bundled in-proc providers (e.g. `DefaultMemoryProvider`) have no
  on-disk `entry` file to SHA-256, so the external-plugin `ingest()` path
  refuses them. Until this is addressed, `registerDefaultMemory` is a
  no-op returning `{ registered: false, pending: 'ingestInternal missing' }`.
- Proposed addition to `src/plugin/registry.ts`:
  ```ts
  ingestInternal(manifest: PluginManifest, handle: unknown, tier?: ConfidenceTier): PluginSlot;
  ```
  - Skips integrity + signature paths (host-rooted trust).
  - Defaults `tier` to `'deterministic'` (bundled, verified at compile time).
  - Writes a `loaded` audit row with `detail_json: { internal: true }`.
  - Still subject to category cardinality — activation rules unchanged.
- Final state: this becomes a first-class registry method in a follow-up PR;
  `registerDefaultMemory` and any future bundled provider use it in place of
  `discoverPlugins → ingest`.
- Rationale: keeping internal providers on the external code path would
  force either synthetic sha256 values (misleading) or weakening the
  integrity check for legitimate external plugins (A6 violation).

### A3 (2026-04-21) — `MarketScheduler.registerTickHook(fn)` for gateway cron
- Need: H3 NL cron's `ScheduleRunner` needs a tick source to fire due schedules.
  The intended piggyback surface is the existing `MarketScheduler` tick loop, but
  that class does not currently expose a public hook API. W3 MVP ships a local-
  timer fallback (`setInterval`, default 30 s) so the track is usable without
  blocking on the extension.
- Proposed addition to `src/economy/market/market-scheduler.ts`:
  ```ts
  registerTickHook(fn: () => void | Promise<void>): () => void;
  ```
  - Returns an unsubscribe function.
  - Hook invoked on every tick after the scheduler's own work; exceptions in a
    hook are logged but don't crash the loop (A6 — hooks can't DoS the market).
- Final state: `ScheduleRunner` detects the hook via structural typing on its
  injected `marketScheduler` dep and auto-prefers it over the local timer.
  Already shaped for it — the upgrade is zero-source-change on the cron side.
- Rationale: two timer loops racing is wasteful and makes "next fire" ordering
  non-deterministic across startups; one tick source is A3-aligned.

### A4 (2026-04-21) — Importer gate/critic structural stubs
- Need: SK3 Skills Hub `SkillImporter` needs to call Oracle Gate + Critic in
  dry-run mode. The real `runGate(request)` in `src/gate/gate.ts` and
  `CriticEngine.review(...)` in `src/orchestrator/critic/` expect richer input
  shapes (`WorkerProposal`, full verdict rollups) than a static SKILL.md body
  trivially provides.
- MVP: importer accepts two structural function types (`ImporterGateFn`,
  `ImporterCriticFn`) as deps. Tests inject fakes; production consumers will
  need small adapter functions that synthesize a `WorkerProposal` from the
  skill's Procedure body and map the returned `GateVerdict` / `CriticResult`
  to the narrower `ImporterGateVerdict` / `ImporterCriticResult` shapes the
  importer expects.
- Final state: the adapter functions live next to the factory wiring that
  connects the importer to the real gate/critic engines (follow-up).
- Rationale: pinning importer directly against the full gate/critic surface
  would couple SK3 to two large modules and block parallel work. Structural
  deps preserve the axiomatic guarantees (A1 — gate still verifies; A3 — rule
  is still deterministic) while keeping the coupling narrow.
