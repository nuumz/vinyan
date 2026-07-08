# Vinyan — Epistemic Orchestration

Vinyan is an autonomous task/workflow orchestrator built on the **Epistemic Orchestration** paradigm — the thesis that AGI-grade reliability emerges from correct epistemic architecture, not from larger LLMs. Its verification layer is an Epistemic Nervous System (ENS): a rule-based substrate that connects heterogeneous Reasoning Engines via the Epistemic Communication Protocol (ECP). LLMs are one component among many, not the brain: generation and verification are always performed by different components, and routing/verification/commit decisions are rule-based.

## Prerequisites

- [Bun](https://bun.com) 1.x (no npm/yarn/pnpm)

## Setup

```bash
bun install
```

Create a `.env` file (or export in your shell) with at least one LLM provider key:

```bash
# Recommended primary provider (raw fetch, model-flexible)
OPENROUTER_API_KEY=sk-or-...

# Or the Anthropic API directly
ANTHROPIC_API_KEY=sk-ant-...
```

Without a key, `vinyan run` fails fast with an actionable error.

## Usage

Run a task directly:

```bash
bun src/cli/index.ts run "Summarize what src/gate/risk-router.ts does" --workspace .
```

Or link the `vinyan` command once and use it anywhere:

```bash
bun link          # registers the `vinyan` binary from this repo
vinyan run "Fix the failing test" --file src/foo.ts --workspace /path/to/project
vinyan doctor     # diagnose config, database, and LLM provider setup
```

Useful `run` flags: `--summary` (human-friendly output), `--verbose` (oracle verdicts), `--dry-run` (routing decision only), `--tool` (enable shell/file tools).

## Development

```bash
bun run test                # Unit tests (~5s)
bun run test:integration    # Gate/oracle/orchestrator (~30s)
bun run test:all            # Unit + integration (~140s)
bun run check               # tsc + biome
bun run test:benchmark      # E2E with phase timing
bun run test:smoke          # Real LLM (needs API key)
```

## Learn more

- `docs/foundation/concept.md` — vision, axioms, ECP protocol, Reasoning Engine model
- `docs/architecture/vinyan-os-architecture.md` — authoritative architecture doc
- `CLAUDE.md` — contributor conventions and quality gates
