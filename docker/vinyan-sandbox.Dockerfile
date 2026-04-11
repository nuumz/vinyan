# vinyan-sandbox — isolated worker container for L2/L3 tasks.
#
# Two-layer mount strategy:
#   /workspace — read-only bind mount of real project
#   /overlay   — writable tmpdir for mutations
#   /ipc       — IPC channel (intent.json in, result.json + artifacts/ out)
#
# Security: distroless (no shell, no apt), non-root, no capabilities,
#           no network, PID/memory limits. Enforces Axiom A6 at container level.
# Source of truth: spec/tdd.md §11, design/implementation-plan.md §2.1

# ── Stage 1: Install production dependencies ────────────────────────────────
FROM oven/bun:1-slim AS builder

WORKDIR /app
COPY package.json bun.lockb* ./
RUN bun install --production --frozen-lockfile

# ── Stage 2: Distroless runtime ─────────────────────────────────────────────
FROM oven/bun:1-distroless

WORKDIR /app

# tsconfig.json needed for @vinyan/* path alias resolution at runtime
COPY tsconfig.json ./

# Production dependencies (zod)
COPY --from=builder /app/node_modules ./node_modules/

# Only the source directories worker-entry.ts actually imports:
#   core/types, guardrails/*, oracle/protocol, orchestrator/llm+protocol+worker
COPY src/core/ ./src/core/
COPY src/guardrails/ ./src/guardrails/
COPY src/oracle/protocol.ts ./src/oracle/protocol.ts
COPY src/orchestrator/ ./src/orchestrator/

# Run as distroless nonroot user (uid 65532)
USER 65532

# Worker reads WorkerInput from stdin, writes WorkerOutput to stdout.
# Does NOT execute tool calls — orchestrator handles tools (A6).
ENTRYPOINT ["bun", "run", "/app/src/orchestrator/worker/worker-entry.ts"]
