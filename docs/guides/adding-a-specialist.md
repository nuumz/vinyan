# Adding a specialist agent

Vinyan ships with four built-in specialists — `ts-coder`, `system-designer`,
`writer`, `secretary`. Any additional role (Java coder, CEO, CTO, accountant,
novelist, …) is added by editing `vinyan.json` and writing a soul file. No
code changes required.

## 1. Register the agent

Open `vinyan.json` in your workspace and add an entry to the `agents` array.
A full fragment with several examples is at
[`docs/examples/multi-agent-vinyan.json`](../examples/multi-agent-vinyan.json)
— copy the entries you want.

Required fields:

| Field | Purpose |
|:---|:---|
| `id` | Unique kebab-case identifier (e.g. `java-coder`, `ceo`). Used by the router and CLI. |
| `name` | Human-readable display name. |
| `description` | One-line role summary. The intent resolver uses this to pick a specialist when the rule-based router is ambiguous. |

Optional fields (recommended for distinct behaviour):

| Field | Purpose |
|:---|:---|
| `allowed_tools` | Tool allowlist. Intersected with the routing-level defaults — never widens. Omit to inherit defaults. |
| `capability_overrides` | Per-capability toggles: `read_any`, `write_any`, `network`, `shell`. Set to `false` to restrict. |
| `routing_hints.prefer_extensions` | File extensions that should route to this agent (`.java`, `.csv`, …). |
| `routing_hints.prefer_frameworks` | Framework markers (`spring`, `junit`, …) that boost this agent's score. |
| `routing_hints.prefer_domains` | Coarse domain: `code-mutation`, `code-reasoning`, `general-reasoning`, `conversational`. |
| `routing_hints.min_level` | Minimum routing level the specialist should handle. Use `1` for reasoning roles that should not be invoked on L0 reflex tasks. |

## 2. Scaffold the soul

Run:

```bash
vinyan agent create <id> --name "Display Name" --desc "Role summary"
```

This appends the agent to `vinyan.json` (idempotent when the id already
exists in config) AND writes a blank-form soul file at
`.vinyan/souls/<id>.soul.md`. Open the file and fill in the sections:

- **Identity** — 1-2 sentences on who this specialist is.
- **Philosophy** — what beliefs guide their decisions.
- **Domain expertise** — what they are known for.
- **Preferred strategies** — concrete, testable rules of thumb.
- **Anti-patterns** — things they refuse to do and why.
- **Self-knowledge** — their known weaknesses and when to consult a peer.

The soul is injected at the TOP of every prompt when the router picks this
specialist. Empty sections are tolerated but the agent will behave generically
until filled in.

## 3. Verify the agent is registered

```bash
vinyan agent list
vinyan agent inspect <id>
```

`inspect` prints the soul, allowed tools, capability overrides, and routing
hints — a full read of what the specialist looks like at runtime.

## 4. Dispatch a task

Either explicit:

```bash
vinyan run "refactor com.example.Foo to use records" --agent java-coder --file src/main/java/com/example/Foo.java
```

Or let the router auto-classify — with `prefer_extensions: [".java"]` set,
the `.java` file is enough for `AgentRouter` to select `java-coder` via
rule-match.

## 5. Confirm persona reached the LLM

After the task runs, inspect the session:

```bash
vinyan logs --limit 1
```

Or grep the `.vinyan/sessions/<session-id>/trace.json` — the specialist's
soul markers (distinctive phrases from your soul file) should appear in the
rendered system prompt. Traces are also tagged with `agent_id`, so
per-specialist queries like "what did the accountant do last week?" work out
of the box via the trace store.

## Example specialists shipped with this guide

See `docs/examples/multi-agent-vinyan.json` for ready-to-copy configs for:

- `java-coder` — JVM code mutation
- `ceo` — strategic reasoning, read-only
- `cto` — architectural reasoning, read-only
- `accountant` — numeric reconciliation over CSV/XLSX/JSON
- `novelist` — creative prose in `.md` / `.txt`

None of these are built-ins — they live entirely in config. The multi-agent
system is a thin substrate; the personalities are yours to write.
