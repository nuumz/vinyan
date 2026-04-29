# obsidian-second-brain — Concept Analysis for Vinyan

> **Date**: 2026-04-30 | **Scope**: External-system research
> **Source**: https://github.com/eugeniughelbur/obsidian-second-brain (Claude Code skill, ~31 commands, 4 layers)
> **Purpose**: Identify knowledge-management patterns applicable to Vinyan's epistemic architecture
> **Cross-reference**: `docs/design/knowledge-loop-rfc.md` (proposal derived from this research)

---

## 1. What obsidian-second-brain (OSB) Is

A Claude Code skill that turns an Obsidian vault into a **self-rewriting AI-first knowledge base**. Two design theses set it apart from Karpathy-style "LLM Wiki":

1. **Notes are written for future-Claude retrieval, not human reading.** Cited verbatim in OSB's `SKILL.md`. Markdown is the storage format, but the audience is the next LLM session.
2. **Every input rewrites — never just appends.** OSB explicitly contrasts itself with append-only wikis: ingesting a new source updates 5–15 existing pages instead of accumulating duplicate claims.

The result is a vault that is "computed, not stored" — and a `_CLAUDE.md` operating manual that serves as the per-vault governance contract.

---

## 2. Vault Anatomy (concrete)

```
vault/
├── _CLAUDE.md          # Per-vault operating manual (precedence: vault > skill defaults)
├── index.md            # Page catalog — Claude reads this BEFORE searching
├── log.md              # Append-only chronological op log
├── SOUL.md             # Identity (persona, communication style)
├── CRITICAL_FACTS.md   # ≤120 tokens, always-loaded volatiles
├── PINNED.md           # Optional task-scoped working memory
├── raw/                # IMMUTABLE source material (articles, transcripts)
└── wiki/               # Claude's writable workspace
    ├── entities/       # People, companies, tools
    ├── concepts/       # Ideas, frameworks, synthesis pages
    ├── projects/
    ├── daily/
    └── decisions/      # ADRs + conflict notes
```

Key structural patterns:

- **`raw/` vs `wiki/` split** — read/write isolation. Wiki is derivable, raw is not.
- **`_CLAUDE.md` precedence rule** — "vault rules win against skill defaults" (per-instance config beats global config).
- **`index.md` read FIRST** — token-discipline trick: a hand-curated catalog read before any search.
- **`CRITICAL_FACTS.md` ≤120 tokens** — separated from identity (SOUL.md): "who I am" vs "what's true right now".
- **`PINNED.md`** — task-scoped scratchpad written DURING long sessions, cleared at task end.

---

## 3. The 31 Commands (4 Layers)

### Layer 1 — Operations (21 commands)

Save / ingest / synthesize / reconcile / export / daily / log / task / person / decide / capture / find / recap / review / board / project / health / adr / visualize / learn / init.

Most architecturally interesting:
- **`/obsidian-save`** — master extractor; spawns 5 parallel subagents (People, Projects, Tasks, Decisions, Ideas).
- **`/obsidian-ingest`** — source rewrites 5–15 existing pages (the anti-append-only pattern).
- **`/obsidian-synthesize`** — auto-finds patterns, writes synthesis pages (4 subagents: Cross-source, Entity convergence, Concept evolution, Orphan rescue).
- **`/obsidian-reconcile`** — finds and resolves contradictions vault-wide (4 subagents).
- **`/obsidian-health`** — vault audit (8 parallel subagents).

### Layer 2 — Thinking Tools (4 commands)

- **`/obsidian-challenge`** — vault red-teams the user's idea using their own history (3 subagents: Decisions, Failures, Contradictions). Prompt explicitly: *"Do not be agreeable. The entire point is to pressure-test."*
- **`/obsidian-emerge`** — surfaces unnamed patterns from last 30 days (4 subagents). Goal stated verbatim: *"insight the user cannot see themselves."*
- **`/obsidian-connect [A] [B]`** — bridges unrelated domains via shared backlinks/tags/people. Outputs: structural analogy, transfer opportunities, collision ideas.
- **`/obsidian-graduate`** — idea fragment → full project (preserves origin idea with `status: graduated`).

### Layer 3 — Context Engine (1 command)

- **`/obsidian-world`** — progressive L0–L3 context loader.
  - **L0** (~170 tokens): SOUL + CRITICAL_FACTS + CORE_VALUES
  - **L1** (~1–2K tokens): index.md + log.md (last 10 entries)
  - **L2** (~2–5K tokens): home/dashboard + today + last 3 daily notes + active boards
  - **L3** (on-demand, ~5–20K): active projects, knowledge articles, recent people

**Critical instruction**: *"Present a brief status after L0–L2 (do NOT load L3 unless needed)."* L3 is gated by need, not default.

### Layer 4 — Research Toolkit (5 commands)

X-read, x-pulse, research, research-deep (4-phase vault-first), youtube. The novel pattern: `<<<RESEARCH_DEEP_PROPAGATION_PAYLOAD>>>` JSON envelope embedded in markdown output that the calling Claude parses to fan out follow-up actions.

---

## 4. Two-Output Rule (Core Operating Principle)

Verbatim from `SKILL.md`:

> Every interaction that produces insight must generate two outputs:
> 1. **The answer** — what the user sees in the conversation
> 2. **A vault update** — the insight filed back into the relevant note(s)

Enforcement: every thinking-tool command has a "log this in today's daily note under [section]" step plus an explicit "offer to save the best insights to Ideas/" prompt. Conversational wrap-up phrases ("ok", "thanks", "done") trigger auto-save fallback.

---

## 5. Bi-Temporal Facts Schema

Lifted directly from `SKILL.md`:

```yaml
timeline:
  - fact: "CTO at Single Grain"
    from: 2024-01-01            # event time
    until: 2026-04-07
    learned: 2026-02-23         # transaction time — when vault learned it
    source: "[[2026-02-23]]"
  - fact: "Architect at Single Grain"
    from: 2026-04-07
    until: present
    learned: 2026-04-07
    source: "[[2026-04-07]]"
```

Rule: **never overwrite, always append**. Top-level fields reflect CURRENT state; `timeline:` array preserves history. Use cases:
- Historical queries ("who was my manager in February?")
- Reflective thinking ("you believed X on Tuesday, then ingested Y on Wednesday and shifted to Z")
- Smart reconciliation (different facts at different times = not a contradiction)
- Full audit trail (when did vault learn each fact, from what source?)

---

## 6. Reconciliation Algorithm (4 Steps)

From `commands/obsidian-reconcile.md`:

**Step 1 — Detect (4 parallel subagents):** Claims agent, Entity agent, Decisions agent, Source freshness agent (compares `raw/` dates to `wiki/` dates).

**Step 2 — Evaluate (3 questions):**
1. Which source is newer? (date comparison)
2. Which is more authoritative? (peer-reviewed > blog > transcript > opinion)
3. Is this a genuine contradiction or an evolution? (changing your mind ≠ contradiction)

**Step 3 — Resolve (3 outcomes):**
- **Clear winner** → rewrite the outdated page, add a `## History` section.
- **Genuinely ambiguous** → create `wiki/decisions/Conflict — Topic.md` with both sides, mark `status: open`.
- **Evolution** → update to current state, add historical context.

**Step 4 — Audit:** rebuild affected `index.md` sections, append to `log.md`, update daily note.

Invariant: *"The vault should never contain two pages that disagree without knowing they disagree."*

---

## 7. Recency Markers, Confidence, Provenance

```markdown
- Mem0 raised $24M Series A (as of 2026-04, mem0.ai/blog/series-a)
- Anthropic released native memory tool (as of 2026-02, anthropic.com/news/memory)
```

Format: `<claim> (as of YYYY-MM, <source-domain-or-path>)`. Full URL preserved verbatim.

**Confidence levels** — 4-value enum: `stated | high | medium | speculation`. Used in frontmatter or inline.

**Cross-link enforcement**: every person, project, idea, decision uses `[[wikilinks]]`. Stub notes auto-created for missing targets.

---

## 8. Scheduled Agents (Cron)

Four cron agents, each with a verbatim prompt designed to run autonomously:

- **`obsidian-morning` (8 AM daily)** — create today's daily note, pull due/overdue tasks, list stale active projects. *"Do not ask questions — infer everything from the vault."*

- **`obsidian-nightly` (10 PM daily)** — 5-phase pipeline:
  1. **Close the day** — append "End of Day" summary, move completed kanban tasks.
  2. **Reconcile** — scan entities/concepts for contradictions, auto-resolve clear winners.
  3. **Synthesize** — concepts in 2+ unrelated sources → create `Synthesis — Title.md`.
  4. **Heal** — orphan notes → add incoming links; close open timeline entries; rebuild index.
  5. **Log** — append to `log.md`.

  Constraint: *"Do not fix anything destructive — only add, update, link."*

- **`obsidian-weekly` (Fri 6 PM)** — generates weekly review note.

- **`obsidian-health-check` (Sun 9 PM)** — vault audit. *"Do not fix anything autonomously — only report."*

---

## 9. Synthesis Trigger Conditions

From `SKILL.md`:
- Same concept appearing in **3+ unrelated sources**
- A claim reinforced by multiple independent sources
- A trend emerging across time-sequenced notes
- Two entities sharing unexpected connections

Output file: `wiki/concepts/Synthesis — Title.md` with `auto_generated: true` frontmatter. **Critical rule**: link the synthesis page FROM all source notes — bidirectional, not appended.

---

## 10. Implicit Design Principles

1. Notes are written for future-Claude retrieval, not human reading.
2. Generation and verification are the same operation — every ingest both writes new facts AND triggers reconciliation/synthesis on existing facts.
3. No write is an island — propagation table makes fan-out deterministic.
4. Search before create — duplicates are vault rot.
5. Bi-temporal truth — event time AND transaction time are first-class.
6. Source-of-truth segregation — `raw/` immutable, wiki derivable.
7. Token-progressive context loading — pay for what you use.
8. Conservative autonomy — scheduled agents NEVER delete/archive/merge; only add/update.
9. The vault is computed, not stored.
10. Match the vault's voice — read 2–3 existing notes before writing.
11. `_CLAUDE.md` overrides skill defaults.
12. The vault thinks for itself on a schedule — synthesis is autonomous, not on-demand.

---

## 11. Mapping Table — OSB ↔ Vinyan

Status legend: ✅ have | ⚠️ partial / different layer | ❌ missing

| OSB Concept | Vinyan Equivalent | Status | Notes |
|---|---|---|---|
| `_CLAUDE.md` per-vault manual | `CLAUDE.md` + agent profiles | ✅ | Vinyan's is project-scoped; OSB's is vault-scoped |
| `SOUL.md` (~1.5K tokens) | `soul-schema.ts` (typed, 1500-token cap) | ✅ | Vinyan's is **typed and stronger** — Philosophy / Domain / Strategies / Anti-patterns / Self-knowledge / Experiments |
| `CRITICAL_FACTS.md` (always-loaded volatiles) | `hot-fact-index.ts` | ⚠️ | Hot index is for code facts, not session-volatile state |
| `PINNED.md` task scratchpad | `WorkingMemory` + `working_memory_json` | ✅ | Vinyan has it |
| `index.md` LLM-curated catalog (read FIRST) | skill catalog + grep/glob | ❌ | Vinyan agents go straight to grep |
| `log.md` activity timeline | `trace-store`, observability events | ✅ | Vinyan's is structured; OSB's is markdown |
| `raw/` vs `wiki/` (read/write isolation) | source vs world-graph (auto-invalidate by hash) | ✅ | Different mechanism, same principle |
| Bi-temporal `learned:` vs `from:`/`until:` | `verified_at` only | ❌ | Vinyan can't replay belief evolution |
| Recency markers `(as of YYYY-MM, src)` | `temporal_context` ECP, `decay_model` | ✅ | Vinyan's is structured + decay-aware |
| Confidence levels (4-value enum) | `confidence: number` + `tier_reliability` | ✅ | Vinyan's is numeric + tiered (stronger) |
| Reconciliation 4-step pipeline | L3 contradiction handling | ❌ | Vinyan handles ad-hoc, no dedicated module |
| `Conflict — Topic.md` (status: open) | `type: 'unknown'` (protocol-only) | ❌ | Vinyan does not materialize conflicts as records |
| Two-Output Rule (every answer updates KB) | facts stored only after oracle verify | ❌ | Agent decisions / critic verdicts not stored |
| `/obsidian-challenge` (history-based red-team) | `critic-engine`, debate-mode | ⚠️ | Critic doesn't systematically use trace history |
| `/obsidian-emerge` (concept patterns from N days) | `sleep-cycle` (Wilson CI on tasks) | ✅ | Vinyan's is task-level; OSB's is concept-level |
| `/obsidian-connect [A] [B]` analogical bridge | — | ❌ | No cross-domain transfer in Vinyan |
| `/obsidian-graduate` idea→project | — | ❌ | Vinyan task-driven, no idea→project pipeline |
| `/obsidian-world` L0–L3 progressive boot | `risk-routing` L0–L3 (verification), `skills` L0–L2 (catalog) | ⚠️ | Vinyan has L-tiers in 2 different domains, no unified boot loader |
| Scheduled cron agents (Morning/Nightly/Weekly) | sleep-cycle (every N sessions, not wall-clock) | ⚠️ | Session-driven, not time-driven |
| Synthesis trigger "concept in 3+ unrelated sources" | sleep-cycle pattern mining | ⚠️ | Different signal — Vinyan uses Wilson CI on outcomes |
| Orphan detection & healing | retention deletes orphans | ⚠️ | Vinyan deletes; OSB connects |
| Anti-sycophancy ("Do not be agreeable") | — | ❌ | Not in critic prompts |
| `auto_generated: true` flag | `origin: 'autonomous'` (skills only) | ⚠️ | Vinyan flags skills only, not facts/decisions |
| `<<<PAYLOAD>>>` JSON envelope in markdown | ECP messages | ✅ | Vinyan's ECP is stronger |
| `_CLAUDE.md` precedence rule | — | ⚠️ | Vinyan uses rule-based governance (A3) — should NOT adopt |

---

## 12. Liftable Patterns (ranked by value-to-Vinyan)

### Tier 1 — High value, axiom-aligned, low risk

1. **Bi-temporal split** (`learned_at` separate from event time) — A4 + A8
2. **First-class Conflict records** (materialized contradictions with `status: open`) — A2
3. **Reconciliation pipeline** (4-step detect/evaluate/resolve/audit module) — A1 + A3 + A8
4. **Adversarial-from-history critic** (use trace + failed-approaches as critic evidence) — A1 + A6 + A7

### Tier 2 — Medium value, requires adaptation

5. **LLM-curated `index.md` read-FIRST** (token-discipline catalog, sleep-cycle maintained)
6. **Two-Output Rule for agent decisions** (record router/escalation/fallback decisions to `decision-store`) — A7 + A8
7. **Synthesis trigger: cross-oracle corroboration** ("fact verified by 3+ independent oracles" → upgrade tier_reliability) — A5
8. **Anti-sycophancy line** in critic system prompt — almost-free

### Tier 3 — Conceptually interesting, lower priority

- Cron-style scheduled agents (Vinyan is session-driven; not urgent)
- `/obsidian-connect` analogical reasoning (needs embedding store)
- `/obsidian-graduate` idea→project (off-domain for code orchestration)
- `auto_generated: true` flag spread (origin metadata for facts)
- Subagent vocabulary as coordination protocol

---

## 13. What NOT to Copy

| OSB Pattern | Reason to reject |
|---|---|
| Vault metaphor + 31 commands | OSB is personal KM; Vinyan is code orchestration |
| `_CLAUDE.md` precedence rule "vault rules win" | Vinyan A3 mandates rule-based governance — document override violates axiom |
| Daily/Morning cron + calendar-driven loops | Vinyan is task-driven, not calendar-driven |
| Markdown vault as primary store | Vinyan uses SQLite + WAL — markdown regresses crash-safety invariant |
| LLM-curated reconciliation prompt | A3 mandates deterministic reconciliation — must be rule-based |
| User-facing vault artifacts (Daily.md, etc.) | Wrong audience — Vinyan's "user" is the developer running tasks |

**Selection rule**: if pattern requires LLM in a governance/resolution path, reject; use a rule-based equivalent.

---

## 14. Novel / Liftable Mechanism Patterns (architectural tricks)

These are portable design tricks regardless of domain:

a. **Progressive L0–L3 with explicit token budgets** — gate L3 on need. Numbers per level.

b. **Bi-temporal frontmatter** — `learned:` alongside `from:`/`until:`. Direct port to belief schemas.

c. **3-question reconciliation evaluator** — newer? more authoritative? evolution vs contradiction? — three discrete output channels.

d. **Embedded JSON envelope `<<<MARKER>>>`** — tool-call inside a document, parseable by orchestrator.

e. **Index-read-FIRST cost discipline** — hand-curated catalog before search.

f. **PostCompact hook + headless `claude -p` subprocess** — fire-and-forget background reaction to context boundaries.

g. **Anti-sycophancy + anti-laziness explicit instructions** — cheap, effective.

h. **Auto-graduation pipeline** — immutable origin + forward-linked successor. Pattern for any state-machine where you want auditable transitions without losing history.

i. **`auto_generated: true` flag** — distinguishes machine-authored from human-authored artifacts.

j. **Stereotyped subagent vocabulary** — same agent names reused across commands (Decisions agent, Failures agent, etc.) makes prompts composable.

k. **Rewrite-on-ingest** — central anti-pattern claim against append-only. Forces consolidation pressure.

l. **Conflict records with `status: open`** as first-class "we don't know yet" — protocol-honesty equivalent of Vinyan's A2 `type: 'unknown'`.

---

## 15. References (for follow-up)

- OSB repo: https://github.com/eugeniughelbur/obsidian-second-brain
- Key files inspected: `README.md`, `SKILL.md`, `architecture.md`, `references/ai-first-rules.md`, `references/claude-md-template.md`, `commands/obsidian-ingest.md`, `commands/obsidian-reconcile.md`, `commands/obsidian-synthesize.md`, `commands/obsidian-world.md`, `hooks/obsidian-bg-agent.sh`
- Related Vinyan code: `src/world-graph/`, `src/orchestrator/agent-context/`, `src/orchestrator/critic/`, `src/sleep-cycle/`, `src/orchestrator/goal-grounding.ts`
- RFC derived: `docs/design/knowledge-loop-rfc.md`
