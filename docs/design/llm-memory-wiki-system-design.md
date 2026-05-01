# LLM Memory Wiki / Second Brain — System Design

> **Status:** active design (2026-04-30)
> **Owner:** Vinyan core
> **Scope:** new subsystem under `src/memory/wiki/`
> **Audiences:** core engineers, agent authors, API consumers

## 0. TL;DR

Vinyan's existing memory lanes (WorkingMemory, MemoryProvider, AutoMemory,
ContextRetriever, WorldGraph, trace/session stores) capture **operational
state**. They do not capture, in a queryable form, the **synthesized
knowledge** that emerges across sessions: prior decisions, reusable
concepts, failure patterns, agent profiles, open questions.

The Memory Wiki is a **compiled knowledge substrate** modeled after Andrej
Karpathy's "LLM Wiki" pattern and Obsidian's local-first vault model.
It sits *alongside* the existing lanes, not on top of them.

```
┌─────────────────────────────── Memory Wiki ─────────────────────────────┐
│                                                                         │
│  Source Vault (immutable)  →  Compiled Wiki (validated)  →  Retrieval  │
│        ↑                            ↑                          │        │
│  raw turns / traces /           [[wikilinks]] graph        ContextPack │
│  user notes / verdicts          + frontmatter trust            │        │
│                                                                │        │
└────────────────────────┬───────────────────────────────────────┴────────┘
                         │
              ┌──────────┴──────────────┐
              ↓                         ↓
    Existing MemoryProvider        Existing prompt assembly
    (FTS5, tier-ranked rows)       (bounded, trust-labeled)
```

Three layers:

1. **Source Vault** — append-only raw inputs (sessions, traces, user
   notes, verification verdicts, coding-cli runs). Never mutated.
2. **Compiled Wiki** — Obsidian-compatible Markdown pages that
   summarize/synthesize sources. Generation proposes; a deterministic
   validator disposes (A1, A3).
3. **Schema / policy** — page templates, citation rules, lifecycle
   rules. Versioned; auditable.

The wiki is **optional and additive**: when missing, every existing
pipeline still works. When present, it improves long-term continuity
without weakening epistemic guarantees.

---

## 1. Why this exists

### 1.1 The gap

| Lane                 | Captures                                | Misses                                  |
|----------------------|-----------------------------------------|-----------------------------------------|
| `WorkingMemory`      | per-task scratchpad, failed approaches  | survives only one task                  |
| `MemoryProvider`     | tier-ranked rows, FTS5                  | row-shaped only, no graph relationships |
| `AutoMemory`         | hand-curated user/feedback notes        | probabilistic only, no agent writes     |
| `ContextRetriever`   | session recency + semantic + pins       | session-scoped, not cross-session       |
| `WorldGraph`         | content-addressed verified facts        | code facts only, not concepts/decisions |
| trace/session stores | operational history                     | not summarized, not human-readable      |

What's missing is a **substrate that synthesizes these lanes** into
human- and agent-readable pages with explicit relationships, lifecycle,
and provenance — and that survives across sessions.

### 1.2 Why "wiki" specifically

Per Karpathy's LLM Wiki pattern, three operations dominate:

- **ingest** — read source, extract knowledge, update multiple wiki
  pages, log the operation;
- **query** — answer from compiled wiki first, with citations to sources;
- **lint** — find contradictions, orphans, missing backlinks, stale
  claims, broken links, research gaps.

This shape is a much better fit than vector-only RAG for long-lived
agents because:

- claims are *typed* (concept vs decision vs failure-pattern), not flat;
- relationships are *explicit* (via `[[wikilinks]]`), enabling graph
  expansion at retrieval time;
- staleness and contradiction are *first-class*, not silent corruption;
- humans can read and edit the same artifact the agent uses.

### 1.3 Anti-goals

- **Do NOT collapse existing lanes.** This is an additive layer.
- **Do NOT make AutoMemory load-bearing.** Wiki claims with
  `evidenceTier='deterministic'` come from oracles, not from prompts.
- **Do NOT require Obsidian.** Plugin-free Markdown only. Obsidian is a
  consumer, not a dependency.
- **Do NOT permit free LLM writes.** Every page write goes through the
  deterministic validator (A1, A3).

---

## 2. Lane ownership matrix (post-Wiki)

| Lane                 | Owns                                                      | Trust ceiling             |
|----------------------|-----------------------------------------------------------|---------------------------|
| `WorkingMemory`      | current task — failed approaches, hypotheses, scoped facts | task-local, ephemeral     |
| `MemoryProvider`     | structured long-term records (`fact`, `preference`, `user-section`, `episodic`) | per-record evidence tier  |
| `WorldGraph`         | verified content-addressed facts                          | `deterministic` only      |
| `MemoryWiki` (new)   | compiled human/agent-readable knowledge substrate          | per-page, per-claim       |
| `AutoMemory`         | prompt overlay (advisory)                                 | `probabilistic` always    |
| trace/session stores | durable operational history                               | raw, untiered             |

The Wiki **mirrors** important records into MemoryProvider when
appropriate (e.g., a canonical decision page produces a corresponding
`memory_records` row tagged `kind='fact'`, with `evidenceTier` matching
the page's `evidenceTier`). It does NOT replace MemoryProvider — it
*sources* MemoryProvider.

---

## 3. Architecture

### 3.1 Top-level layout

```
src/memory/wiki/
  types.ts                    # Contracts: WikiSource, WikiPage, WikiEdge, WikiClaim,
                              #   WikiOperation, WikiLintFinding, ContextPack
                              # zod schemas for boundary validation
  store.ts                    # SQLite-backed store (sources/pages/edges/claims/ops/lint)
  vault.ts                    # Filesystem layout, path safety, page (de)serialization
  schema.ts                   # MEMORY_SCHEMA constants — page types, frontmatter shape
  page-writer.ts              # Deterministic write gateway (A1)
  validator.ts                # Frontmatter, citation, wikilink, human-section validation
  wikilink-parser.ts          # [[wikilinks]] → typed edges
  ingest.ts                   # MemoryWikiIngestor — pipelines for sessions/traces/...
  extractor.ts                # Source → candidate pages/claims (rule-based + LLM-optional)
  retrieval.ts                # MemoryWikiRetriever — search + ContextPack assembly
  lint.ts                     # MemoryWikiLint — contradictions, orphans, stale, ...
  consolidation.ts            # Sleep-cycle hook: promote/demote
  events.ts                   # Bus event names + payloads
  index.ts                    # Public exports
.vinyan/wiki/                 # Vault root (gitignored or partially committed by user)
  raw/                        # Immutable raw source snapshots (one file per source)
  pages/<type>/<id>.md        # Compiled pages
  moc/                        # Maps of content
  tasks/<task-id>.md          # Task-memory pages
  agents/<agent-id>.md        # Agent-profile pages
  index.md                    # Top-level MOC
  log.md                      # Append-only operation log
  MEMORY_SCHEMA.md            # Schema reference (committed, versioned)
```

### 3.2 Source vault

A `WikiSource` is an immutable record of "an external thing the wiki
read once". Possible kinds:

- `session` — a (subset of) a session's turns
- `trace` — an `ExecutionTrace`
- `user-note` — a human-authored Markdown note
- `web-capture` — a fetched URL snapshot
- `coding-cli-run` — an external coding-cli session
- `verification` — an oracle verdict
- `approval` — a human approval/decision

Every source carries:

```ts
{
  id: string;           // sha256(kind|payload|createdAt)
  kind: WikiSourceKind;
  contentHash: string;  // sha256(payload)
  createdAt: number;
  provenance: {
    profile: string;
    sessionId?: string;
    taskId?: string;
    agentId?: string;
    user?: string;
  };
  body: string;         // serialized payload (JSON for structured, markdown for prose)
}
```

Stored both:
- in `memory_wiki_sources` table (canonical, queryable);
- as a flat file `.vinyan/wiki/raw/<id>.md` (human-readable, with frontmatter).

The flat file is a snapshot, not a symlink — so vault portability is
preserved without filesystem privileges.

### 3.3 Compiled wiki

A `WikiPage` is one Markdown file with strict frontmatter:

```yaml
---
id: concept-epistemic-orchestration
type: concept
title: Epistemic Orchestration
aliases: ["EO", "epistemic-orchestration"]
tags: [paradigm, axiom-bearing]
sourceHashes: [a1b2c3d4..., e5f6g7h8...]
evidenceTier: heuristic
confidence: 0.78
lifecycle: canonical
createdAt: 1714512000000
updatedAt: 1714598400000
validUntil: null
human:protected: ["history"]    # opt-in: sections the LLM cannot rewrite
profile: default
---

# Epistemic Orchestration

Generation and verification MUST be performed by different components
[Source: a1b2c3d4]. See [[axiom-A1-epistemic-separation]] and
[[concept-reasoning-engine-registry]].

## History
<!-- human:protected -->
... (preserved by writer; LLM proposals here are rejected)
<!-- /human:protected -->
```

Page types (extensible — vocabulary lives in `schema.ts`):

| type              | description                                                  |
|-------------------|--------------------------------------------------------------|
| `concept`         | abstract idea or pattern                                     |
| `entity`          | named thing (file, module, tool, person)                     |
| `project`         | active or historical project / initiative                    |
| `decision`        | one decision with rationale + alternatives + outcome         |
| `failure-pattern` | a failed approach worth not repeating                        |
| `workflow-pattern`| a successful repeatable workflow                             |
| `source-summary`  | a one-page summary of one external source                    |
| `task-memory`     | what we learned doing one task                               |
| `agent-profile`   | what we know about one agent (capabilities, prefs, history)  |
| `open-question`   | an unresolved question with evidence so far                  |

Lifecycle states:

- `draft` — proposed; not yet citable; readable but not load-bearing
- `canonical` — validated; citable; has at least one source citation
- `stale` — at least one cited source's hash changed; needs re-grounding
- `disputed` — contradicting claim found by lint or human flag
- `archived` — superseded; preserved for replay

### 3.4 Schema / policy

`MEMORY_SCHEMA.md` is a committed, versioned document that defines:

- the frontmatter shape (mirrored in `schema.ts`);
- the page-type vocabulary;
- citation rules (e.g., a `canonical` page must cite at least one
  `WikiSource`);
- lifecycle promotion rules (draft → canonical, etc.);
- lint rules (orphan, stale, contradiction-candidate, ...);
- the human-protected-section markers.

The schema is **rule-based** and **versioned** — A3 governance.

### 3.5 Index + log

- `index.md` — top-level MOC, generated from `memory_wiki_pages`;
- `log.md` — append-only operation timeline (one line per write);
- `memory_wiki_operations` table — same content, queryable.

The DB is the *source of truth*; the Markdown files are *generated
projections*. The vault can be deleted and re-generated from the DB,
which is what the `vault rebuild` operation does.

### 3.6 Graph + retrieval

- `[[wikilinks]]` parsed by `wikilink-parser.ts` produce typed edges:
  - `mentions` (default), `cites`, `supersedes`, `contradicts`,
    `derived-from`, `implements`, `belongs-to`.
- Edges live in `memory_wiki_edges` (from_id, to_id, edge_type,
  confidence, created_at).
- Retrieval composes:
  1. exact symbolic pins (page id, title, alias) — `getPage`, `getByAlias`;
  2. FTS5 keyword search over page bodies + frontmatter title/tags;
  3. graph-neighborhood expansion (1–2 hops), with type filters;
  4. tier × recency × confidence ranking;
  5. optional vector recall via existing `MemoryProvider` mirror.

Retrieval is the same plumbing as the existing `ContextRetriever` but
operates on pages rather than turns.

---

## 4. Operations

### 4.1 Ingest

Every ingestor follows the same five-step shape:

```
input (typed)
  → 1. extract candidate facts/decisions/failures/open-questions
  → 2. quality-gate: drop low-signal candidates
  → 3. propose page upserts (draft if new)
  → 4. write through validator (deterministic)
  → 5. emit memory-wiki:* events + log row + (optional) MemoryProvider mirror
```

Public surface:

```ts
class MemoryWikiIngestor {
  ingestSource(input: SourceIngestInput): Promise<IngestResult>;
  ingestSession(sessionSummary: SessionSummary): Promise<IngestResult>;
  ingestTrace(trace: ExecutionTrace): Promise<IngestResult>;
  ingestExternalCodingCliRun(events: readonly CodingCliEvent[]): Promise<IngestResult>;
  ingestFailurePattern(failure: FailureInput): Promise<IngestResult>;
  ingestUserNote(note: UserNoteInput): Promise<IngestResult>;
}
```

The LLM may *propose* updates (especially for `concept`/`decision` page
synthesis) but **may not** write directly — every write goes through
`PageWriter`. `extractor.ts` ships a rule-based default that produces
predictable pages from structured inputs (traces, coding-cli events,
verdicts) without an LLM in the loop. An optional
`LlmWikiSynthesizer` can be plugged in later for prose-heavy sources;
its output still passes through the validator.

### 4.2 Query

```ts
class MemoryWikiRetriever {
  search(q: SearchQuery): Promise<readonly WikiPageHit[]>;
  getContextPack(req: ContextPackRequest): Promise<ContextPack>;
  getPageGraph(pageId: string, depth?: number): Promise<PageGraph>;
  getOpenQuestions(scope?: ScopeFilter): Promise<readonly WikiPage[]>;
  getRelevantFailures(req: FailureLookupRequest): Promise<readonly WikiPage[]>;
  getRelevantDecisions(scope: ScopeFilter): Promise<readonly WikiPage[]>;
}
```

A `ContextPack` is the bounded, trust-labeled prompt fragment:

```ts
interface ContextPack {
  readonly pages: readonly ContextPackPage[];     // top hits + citations
  readonly citations: readonly WikiSourceRef[];   // raw source pointers
  readonly graph: PageGraph;                      // small neighborhood
  readonly decisions: readonly WikiPage[];
  readonly failures: readonly WikiPage[];
  readonly openQuestions: readonly WikiPage[];
  readonly omitted: readonly OmittedItem[];       // explainability
  readonly tokenEstimate: number;
  readonly generatedAt: number;
}
```

Prompt assembly renders a `[MEMORY WIKI CONTEXT]` block with explicit
trust labels (`[deterministic]`, `[heuristic]`, `[probabilistic]`,
`[stale!]`, `[disputed!]`). Stale or disputed pages are NEVER injected as
trusted facts — they are surfaced as advisory only, with an explicit
warning.

### 4.3 Lint

Findings are typed and scored:

| code                       | description                                      | severity |
|----------------------------|--------------------------------------------------|----------|
| `broken-wikilink`          | `[[target]]` resolves to nothing                 | error    |
| `orphan-page`              | no inbound edges                                 | warn     |
| `duplicate-page`           | two pages share title/alias hash                 | warn     |
| `contradiction-candidate`  | two pages assert opposite of same property       | error    |
| `stale-page`               | a cited source's hash changed                    | warn     |
| `uncited-canonical-claim`  | canonical page has 0 source citations            | error    |
| `missing-source-backlink`  | source claims to support a page that doesn't link back | warn |
| `low-confidence-canonical` | canonical confidence < 0.4                       | warn     |
| `open-question-no-owner`   | open-question with no `owner` frontmatter        | info     |
| `repeated-failure`         | failure-pattern observed ≥ N times → promote     | info     |

`MemoryWikiLint.run()` returns `WikiLintFinding[]`; the sleep-cycle uses
this to drive consolidation.

### 4.4 Consolidation (sleep-cycle integration)

Periodically (sleep-cycle tick):

- promote `failure-pattern` pages with ≥ N validated occurrences to
  procedural memory in MemoryProvider;
- promote `draft` pages with ≥ M canonical-supporting sources to
  `canonical`;
- demote pages whose all citations went stale to `stale`;
- demote canonical pages with 0 inbound edges and 0 reads in N days to
  `archived`;
- emit nudges back into the orchestrator (e.g., "open-question OQ-7 has
  been open for 21 days").

Promotion is **rule-based** (Wilson LB on observation count, like the
existing sleep-cycle promotion) — never LLM-driven (A3).

---

## 5. Storage layer

### 5.1 Migration `026_memory_wiki.ts`

Six tables:

```sql
CREATE TABLE memory_wiki_sources (
  id            TEXT PRIMARY KEY,
  profile       TEXT NOT NULL DEFAULT 'default',
  kind          TEXT NOT NULL,        -- session|trace|user-note|web-capture|coding-cli-run|verification|approval
  content_hash  TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  session_id    TEXT,
  task_id       TEXT,
  agent_id      TEXT,
  user_id       TEXT,
  body          TEXT NOT NULL,
  metadata_json TEXT
);

CREATE TABLE memory_wiki_pages (
  id             TEXT PRIMARY KEY,
  profile        TEXT NOT NULL DEFAULT 'default',
  type           TEXT NOT NULL,
  title          TEXT NOT NULL,
  aliases_json   TEXT NOT NULL,       -- JSON array
  tags_json      TEXT NOT NULL,       -- JSON array
  body           TEXT NOT NULL,
  evidence_tier  TEXT NOT NULL,
  confidence     REAL NOT NULL,
  lifecycle      TEXT NOT NULL,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL,
  valid_until    INTEGER,
  protected_json TEXT,                -- JSON array of human-protected section names
  body_hash      TEXT NOT NULL        -- sha256(body) for stale-detection
);

CREATE TABLE memory_wiki_edges (
  from_id    TEXT NOT NULL,
  to_id      TEXT NOT NULL,
  edge_type  TEXT NOT NULL DEFAULT 'mentions',
  confidence REAL NOT NULL DEFAULT 0.5,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (from_id, to_id, edge_type)
);

CREATE TABLE memory_wiki_claims (
  id            TEXT PRIMARY KEY,
  page_id       TEXT NOT NULL,
  text          TEXT NOT NULL,
  source_hashes TEXT NOT NULL,         -- JSON array of source ids
  evidence_tier TEXT NOT NULL,
  confidence    REAL NOT NULL,
  created_at    INTEGER NOT NULL,
  FOREIGN KEY (page_id) REFERENCES memory_wiki_pages(id) ON DELETE CASCADE
);

CREATE TABLE memory_wiki_operations (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  ts          INTEGER NOT NULL,
  op          TEXT NOT NULL,           -- ingest|propose|write|reject|stale|promote|demote|lint
  page_id     TEXT,
  source_id   TEXT,
  actor       TEXT NOT NULL,           -- agent id, "system", or "user:<id>"
  reason      TEXT,
  payload_json TEXT
);

CREATE TABLE memory_wiki_lint_findings (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  ts          INTEGER NOT NULL,
  code        TEXT NOT NULL,
  severity    TEXT NOT NULL,
  page_id     TEXT,
  detail      TEXT,
  resolved_at INTEGER
);

CREATE VIRTUAL TABLE memory_wiki_pages_fts USING fts5(
  id UNINDEXED, profile UNINDEXED, type UNINDEXED,
  title, body, tags, tokenize='porter unicode61'
);
```

Indexes on `(profile, type)`, `(profile, lifecycle)`,
`(content_hash)`, `(from_id)`, `(to_id)`, `(page_id)`, `(code)`.
FTS5 keeps the page index up to date via triggers.

### 5.2 Filesystem safety

`vault.ts` enforces:

- canonical absolute paths only; `..` rejected;
- writes only under the configured vault root;
- symlinks rejected (file mode check on create);
- max 64 KB per page file;
- max 1 MB per raw source snapshot;
- atomic write (temp file + rename) with `O_NOFOLLOW`.

---

## 6. Axiom alignment

| Axiom | How the wiki upholds it                                                |
|-------|-------------------------------------------------------------------------|
| A1    | Generators (extractor, optional LLM synthesizer) propose; PageWriter validates and disposes. |
| A2    | `lifecycle: 'open-question'` is first-class; `evidenceTier: 'speculative'` is allowed. |
| A3    | All promotion/demotion/validation is rule-based. The Wiki has no LLM in the governance path. |
| A4    | Pages cite source content hashes; when a hash changes the page is auto-marked `stale`. |
| A5    | Pages carry an evidenceTier; retrieval ranks accordingly; ceilings are clamped. |
| A6    | Wiki writes are zero-trust: even system actors go through validator. |
| A7    | Failure-pattern pages capture prediction error → procedural memory promotion. |
| A8 (proposed)  | Every wiki op is recorded in `memory_wiki_operations` with actor + reason. |
| A9 (proposed)  | Wiki absence ⇒ pipelines still run; degradation is graceful. |
| A10 (proposed) | Pages bind to root intent via `provenance.taskId`; stale detection re-grounds. |

---

## 7. Phasing

The 9-phase plan in the ticket is shipped end-to-end. This document is
the contract; implementations under `src/memory/wiki/` follow it.

Future work (out of scope for the initial slice):

- LLM-based extractor for prose-heavy user notes;
- Vector recall mirror via `sqlite-vec`;
- UI surface (Memory Wiki page, graph view, lint console);
- Cross-profile read endpoints with explicit audit;
- Federation: shared wikis across Vinyan instances (A2A).
